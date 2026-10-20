import { getAccountOwners, getTransactionsForAddress } from "../background/rpc";
import type { Callout } from "../shared/types";
import type { StrategyContext } from "./types";
import { AnalysisStopped } from "../shared/analysis-control";
import type { AnalysisExecution } from "../shared/analysis-control";

const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_POOL_PROGRAMS = new Set([PUMP_CURVE, PUMP_AMM]);
const PUMP_POOL_OWNERS = new Set<string>();
const MINT_INITIAL_ADDRESSES = new Map<string, MintInitialInfo>();
const RUN_POOL_OWNERS = new WeakMap<AnalysisExecution, Set<string>>();
async function poolOwners(ctx: StrategyContext): Promise<Set<string>> {
  if (!ctx.execution) return PUMP_POOL_OWNERS;
  let owners = RUN_POOL_OWNERS.get(ctx.execution);
  if (!owners) { owners = await ctx.execution.load<Set<string>>("scan:pool-owners") ?? new Set<string>(); RUN_POOL_OWNERS.set(ctx.execution, owners); }
  return owners;
}

export type MintInitialInfo = {
  signature?: string;
  addresses: Set<string>;
  creatorCandidates: Set<string>;
  mintRecipients: Set<string>;
  poolAddresses: Set<string>;
  initialBuyers: Set<string>;
};
type ParsedMint = { initialInfo: MintInitialInfo; createdAccountPrograms: Map<string, string>; hasTransaction: boolean; hasBuy: boolean; transfers: [string | undefined, string | undefined][] };

export type ScannedTransaction = {
  signature: string;
  slot: number;
  blockTime: number | null;
  owners: string[];
};

export type TransactionReference = Omit<ScannedTransaction, "owners">;

export type TransactionWindowScan = {
  transactions: ScannedTransaction[];
  transactionReferences: TransactionReference[];
  signatures: number;
  pages: number;
  complete: boolean;
};

export type WindowScan = TransactionWindowScan & {
  mintInitialInfo: MintInitialInfo;
  poolAddresses: Set<string>;
};

async function getMintInitialAddresses(ctx: StrategyContext, mint: string): Promise<MintInitialInfo> {
  const knownPools = await poolOwners(ctx);
  const key = `mint-initial:${mint}`;
  const saved = await ctx.execution?.load<MintInitialInfo>(key);
  if (saved) {
    saved.poolAddresses.forEach((address) => knownPools.add(address));
    return saved;
  }
  const cached = MINT_INITIAL_ADDRESSES.get(mint);
  if (cached) { cached.poolAddresses.forEach((address) => knownPools.add(address)); await ctx.execution?.commit([{ key, value: cached }]); return cached; }
  const parsed = await ctx.execution?.load<ParsedMint>(`mint-parsed:${mint}`);
  if (parsed) return finishMintInitialAddresses(ctx, mint, parsed);

  const end = Math.floor(Date.now() / 1000) + 1;
  const page = ctx.execution ? await getTransactionsForAddress(mint, 0, end, 1, undefined, "asc", ctx.execution) : await getTransactionsForAddress(mint, 0, end, 1, undefined, "asc");
  if (!ctx.execution) ctx.stats.rpcRequests++;
  ctx.stats.signatures += page.data.length;
  ctx.stats.transactions += page.data.length;

  const row = page.data[0];
  const addresses = new Set<string>();
  const transaction = row?.transaction;
  const creatorCandidates = new Set<string>();
  const mintRecipients = new Set<string>();
  const poolAddresses = new Set<string>();
  const initialBuyers = new Set<string>();
  const keys = (transaction?.message?.accountKeys ?? []).map((key) => typeof key === "string" ? key : key.pubkey);
  const tokenAccountOwners = new Map<string, string>();
  const createdAccountPrograms = new Map<string, string>();
  const instructions = [
    ...(transaction?.message?.instructions ?? []),
    ...(row?.meta?.innerInstructions ?? []).flatMap((group) => group.instructions ?? []),
  ];

  for (const key of transaction?.message?.accountKeys ?? []) {
    if (typeof key !== "string" && key.signer && key.pubkey !== mint) {
      addresses.add(key.pubkey);
      creatorCandidates.add(key.pubkey);
    }
  }

  for (const balance of [...(row?.meta?.preTokenBalances ?? []), ...(row?.meta?.postTokenBalances ?? [])]) {
    if (balance.mint !== mint || !balance.owner || balance.accountIndex === undefined) continue;
    const account = keys[balance.accountIndex];
    if (account) tokenAccountOwners.set(account, balance.owner);
  }
  for (const instruction of instructions) {
    const info = instruction.parsed?.info;
    if (!info) continue;
    if (instruction.program === "system" && instruction.parsed?.type === "createAccount"
      && typeof info.newAccount === "string" && typeof info.owner === "string") {
      createdAccountPrograms.set(info.newAccount, info.owner);
    }
    if (info.mint !== mint || typeof info.account !== "string") continue;
    const owner = info.owner ?? info.wallet;
    if (typeof owner === "string") tokenAccountOwners.set(info.account, owner);
  }
  for (const instruction of instructions) {
    const info = instruction.parsed?.info;
    const type = instruction.parsed?.type;
    if (!info || info.mint !== mint || typeof info.account !== "string" || (type !== "mintTo" && type !== "mintToChecked")) continue;
    const amount = info.amount ?? (info.tokenAmount as { amount?: string } | undefined)?.amount;
    if (typeof amount !== "string" || BigInt(amount) <= 0n) continue;
    const owner = tokenAccountOwners.get(info.account);
    if (owner) {
      mintRecipients.add(owner);
      addresses.add(owner);
    }
  }

  if (transaction) {
    const deltas = new Map<string, bigint>();
    for (const balance of row.meta?.preTokenBalances ?? []) {
      if (balance.mint !== mint || !balance.owner) continue;
      const amount = BigInt(balance.uiTokenAmount?.amount ?? "0");
      deltas.set(balance.owner, (deltas.get(balance.owner) ?? 0n) - amount);
    }
    for (const balance of row.meta?.postTokenBalances ?? []) {
      if (balance.mint !== mint || !balance.owner) continue;
      const amount = BigInt(balance.uiTokenAmount?.amount ?? "0");
      deltas.set(balance.owner, (deltas.get(balance.owner) ?? 0n) + amount);
    }
    for (const [owner, delta] of deltas) {
      if (delta > 0n) addresses.add(owner);
    }
  }

  const initialInfo: MintInitialInfo = { signature: transaction?.signatures?.[0], addresses, creatorCandidates, mintRecipients, poolAddresses, initialBuyers };
  const state: ParsedMint = {
    initialInfo, createdAccountPrograms, hasTransaction: Boolean(transaction),
    hasBuy: (row?.meta?.logMessages ?? []).some((line) => /instruction:\s*(buy|swap)/i.test(line)),
    transfers: instructions.flatMap((instruction): ParsedMint["transfers"] => {
      const info = instruction.parsed?.info, type = instruction.parsed?.type;
      return info && (type === "transfer" || type === "transferChecked") && typeof info.source === "string" && typeof info.destination === "string"
        ? [[tokenAccountOwners.get(info.source), tokenAccountOwners.get(info.destination)]] : [];
    }),
  };
  await ctx.execution?.commit([{ key: `mint-parsed:${mint}`, value: state }]);
  return finishMintInitialAddresses(ctx, mint, state);
}

async function finishMintInitialAddresses(ctx: StrategyContext, mint: string, state: ParsedMint): Promise<MintInitialInfo> {
  const knownPools = await poolOwners(ctx);
  const { initialInfo, createdAccountPrograms, hasBuy, transfers } = state;
  const { addresses, creatorCandidates, mintRecipients, poolAddresses, initialBuyers } = initialInfo;
  const ownerPrograms = ctx.execution ? await getAccountOwners([...addresses], ctx.execution) : await getAccountOwners([...addresses]);
  if (!ctx.execution) ctx.stats.rpcRequests += Math.ceil(addresses.size / 5);
  for (const address of addresses) {
    const programOwner = createdAccountPrograms.get(address) ?? ownerPrograms.get(address);
    if (PUMP_POOL_PROGRAMS.has(programOwner ?? "")) {
      poolAddresses.add(address);
      knownPools.add(address);
      creatorCandidates.delete(address);
    } else if (programOwner != null) {
      creatorCandidates.add(address);
    }
  }

  if (hasBuy) {
    for (const [source, destination] of transfers) {
      if (source && poolAddresses.has(source) && destination && creatorCandidates.has(destination)) initialBuyers.add(destination);
    }
  }

  if (state.hasTransaction) MINT_INITIAL_ADDRESSES.set(mint, initialInfo);
  await ctx.execution?.commit([{ key: `mint-initial:${mint}`, value: initialInfo }, { key: "scan:pool-owners", value: knownPools }]);

  console.log("mint initial addresses", {
    mint,
    signature: initialInfo.signature,
    addresses: [...addresses],
    creatorCandidates: [...creatorCandidates],
    mintRecipients: [...mintRecipients],
    poolAddresses: [...poolAddresses],
    initialBuyers: [...initialBuyers],
  });
  return initialInfo;
}

export async function scanTransactionWindow(
  ctx: StrategyContext,
  address: string,
  callout: Callout,
  start: number,
  end: number,
  pageSize: number,
): Promise<TransactionWindowScan> {
  const transactions: ScannedTransaction[] = [];
  const transactionReferences: TransactionReference[] = [];
  const seenTokens = new Set<string>();
  let paginationToken: string | undefined;
  let signatures = 0;
  let pages = 0;
  let complete = true;
  let done = false;
  const key = `scan:${address}:${callout.mint}:${start}:${end}`;
  type Head = { pages: number; signatures: number; complete: boolean; done: boolean; cursor?: string };
  type Chunk = { references: TransactionReference[]; transactions: ScannedTransaction[]; next?: string };
  const saved = await ctx.execution?.load<Head>(key);
  if (saved) {
    ({ pages, signatures, complete, done, cursor: paginationToken } = saved);
    for (let page = 1; page <= pages; page++) {
      const chunk = await ctx.execution!.load<Chunk>(`${key}:${page}`);
      if (!chunk) throw new AnalysisStopped("paused", "storage", "중간 저장된 RPC 페이지가 없습니다. 새 분석을 실행해 주세요.");
      transactionReferences.push(...chunk.references);
      transactions.push(...chunk.transactions);
      if (chunk.next) seenTokens.add(chunk.next);
    }
  }

  // The raw page belongs only to this function invocation. Once it returns,
  // the next request retains signatures/owners instead of transaction/meta.
  async function appendNextPage(): Promise<string | undefined> {
    const page = ctx.execution ? await getTransactionsForAddress(address, start, end, pageSize, paginationToken, "desc", ctx.execution) : await getTransactionsForAddress(address, start, end, pageSize, paginationToken);
    if (!ctx.execution) ctx.stats.rpcRequests++;
    ctx.stats.signatures += page.data.length;
    ctx.stats.transactions += page.data.length;
    signatures += page.data.length;
    pages++;
    console.log("scan progress", {
      address,
      start: new Date(start * 1000).toISOString(),
      end: new Date(end * 1000).toISOString(),
      page: pages,
      pageTransactions: page.data.length,
      totalTransactions: signatures,
      hasMore: Boolean(page.paginationToken),
    });

    const chunk: Chunk = { references: [], transactions: [], ...(page.paginationToken ? { next: page.paginationToken } : {}) };
    for (const row of page.data) {
      const signature = row.transaction?.signatures?.[0];
      if (!signature || !row.transaction || !row.meta) {
        complete = false;
        continue;
      }

      const reference = { signature, slot: row.slot, blockTime: row.blockTime };
      transactionReferences.push(reference);
      chunk.references.push(reference);
      const deltas = new Map<string, bigint>();
      for (const balance of row.meta.preTokenBalances ?? []) {
        if (balance.mint !== callout.mint || !balance.owner) continue;
        const amount = BigInt(balance.uiTokenAmount?.amount ?? "0");
        deltas.set(balance.owner, (deltas.get(balance.owner) ?? 0n) - amount);
      }
      for (const balance of row.meta.postTokenBalances ?? []) {
        if (balance.mint !== callout.mint || !balance.owner) continue;
        const amount = BigInt(balance.uiTokenAmount?.amount ?? "0");
        deltas.set(balance.owner, (deltas.get(balance.owner) ?? 0n) + amount);
      }
      const owners = [...deltas].filter(([, delta]) => delta < 0n).map(([owner]) => owner);
      if (owners.length) { const match = { ...reference, owners }; transactions.push(match); chunk.transactions.push(match); }
    }

    const next = page.paginationToken ?? undefined;
    done = !next || seenTokens.has(next);
    if (next && seenTokens.has(next)) complete = false;
    await ctx.execution?.commit([
      { key: `${key}:${pages}`, value: chunk },
      { key, value: { pages, signatures, complete, done, ...(next ? { cursor: next } : {}) } satisfies Head },
    ], { kind: "scan", mint: callout.mint, pages });
    return next;
  }

  while (!done) {
    const next = await appendNextPage();
    if (!next) break;
    if (seenTokens.has(next)) {
      complete = false;
      break;
    }
    seenTokens.add(next);
    paginationToken = next;
  }

  return { transactions, transactionReferences, signatures, pages, complete };
}

export async function scanAddressWindow(
  ctx: StrategyContext,
  address: string,
  callout: Callout,
  start: number,
  end: number,
  pageSize: number,
): Promise<WindowScan> {
  const mintInitialInfo = await getMintInitialAddresses(ctx, callout.mint);
  const scan = await scanTransactionWindow(ctx, address, callout, start, end, pageSize);
  const knownPools = await poolOwners(ctx);
  const poolAddresses = new Set(mintInitialInfo.poolAddresses);
  const sellers = new Set<string>();
  for (const transaction of scan.transactions) for (const owner of transaction.owners) sellers.add(owner);

  const ownersKey = `scan-owners:${address}:${callout.mint}:${start}:${end}`;
  const cachedOwners = await ctx.execution?.load<Map<string, string | null>>(ownersKey);
  const ownersToCheck = [...sellers].filter((owner) => !knownPools.has(owner));
  const ownerPrograms = cachedOwners ?? (ctx.execution ? await getAccountOwners(ownersToCheck, ctx.execution) : await getAccountOwners(ownersToCheck));
  if (!ctx.execution) ctx.stats.rpcRequests += Math.ceil(ownersToCheck.length / 5);
  for (const [owner, programOwner] of ownerPrograms) {
    if (PUMP_POOL_PROGRAMS.has(programOwner ?? "")) knownPools.add(owner);
  }
  if (!cachedOwners) await ctx.execution?.commit([{ key: ownersKey, value: ownerPrograms }, { key: "scan:pool-owners", value: knownPools }]);
  for (const owner of sellers) {
    if (knownPools.has(owner)) poolAddresses.add(owner);
  }
  const verifiedOwners = new Set(
    [...sellers].filter((address) => {
      if (knownPools.has(address)) return false;
      const programOwner = ownerPrograms.get(address);
      return programOwner !== null && programOwner !== undefined && !PUMP_POOL_PROGRAMS.has(programOwner);
    }),
  );
  const transactions = scan.transactions
    .map((transaction) => ({ ...transaction, owners: transaction.owners.filter((owner) => verifiedOwners.has(owner)) }))
    .filter(({ owners }) => owners.length > 0);
  console.log("scan matches", {
    mint: callout.mint,
    transactions: transactions.length,
    owners: [...new Set(transactions.flatMap(({ owners }) => owners))].length,
  });

  return { ...scan, transactions, mintInitialInfo, poolAddresses };
}
