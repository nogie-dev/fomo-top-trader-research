import { rethrowAnalysisStop } from "../shared/analysis-control";
import type { ScannedTransaction, TransactionReference } from "../strategies/scan";
import type { PumpFunWalletPnl } from "../strategies/types";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import type { AnalysisExecution } from "../shared/analysis-control";
import { AnalysisStopped } from "../shared/analysis-control";
import { requestPumpFun } from "../shared/pumpfun-api";
import { isTransientRequestError } from "../shared/request-errors";

const FRONTEND_API = "https://frontend-api-v3.pump.fun";
const PROFILE_API = "https://profile-api.pump.fun";
const SOLANA_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export type PumpFunCoinInfo = {
  creatorAddress: string | null;
  curveAddress: string | null;
  ammAddress: string | null;
  poolAddresses: string[];
};

export async function getPumpFunCoinInfo(mint: string, request: PumpFunFetch = fetch): Promise<PumpFunCoinInfo | null> {
  const response = await requestPumpFun(request, `${FRONTEND_API}/coins-v2/${encodeURIComponent(mint)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Pump.fun coin HTTP ${response.status}`);
  const data = await response.json() as Record<string, unknown> | null;
  if (!data || data.mint !== mint) throw new Error("Unexpected Pump.fun coin response");
  const address = (key: string): string | null => {
    const value = data[key];
    if (value == null || value === "") return null;
    if (typeof value !== "string") throw new Error(`Unexpected Pump.fun coin ${key}`);
    return value === "11111111111111111111111111111111" ? null : value;
  };
  const curveAddress = address("bonding_curve");
  const pumpPool = address("pump_swap_pool");
  const raydiumPool = address("raydium_pool");
  const canonicalPool = address("pool_address");
  return {
    creatorAddress: address("creator"), curveAddress,
    // pool_address는 일반적인 canonical pool이므로 AMM 전용 필드와 구분한다.
    ammAddress: pumpPool ?? raydiumPool,
    poolAddresses: [...new Set([curveAddress, address("associated_bonding_curve"), pumpPool, raydiumPool, canonicalPool]
      .filter((value): value is string => value !== null))],
  };
}

type PumpFunTokenPnl = {
  mint: string;
  realized_pnl_usd: number | null;
  unrealized_pnl_usd: number | null;
  amount_held: number | null;
  fee_usd?: number | null;
  has_transfers?: boolean;
  has_untrusted_usd_basis?: boolean;
};

function parseWalletPnl(data: PumpFunTokenPnl): PumpFunWalletPnl {
  const feeUsd = data.fee_usd ?? null;
  const numbers = [data.realized_pnl_usd, data.unrealized_pnl_usd, data.amount_held, feeUsd];
  const flags = [data.has_transfers, data.has_untrusted_usd_basis];
  if (numbers.some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value)))
    || flags.some((value) => value !== undefined && typeof value !== "boolean")
    || (data.amount_held !== null && data.amount_held < 0)) {
    throw new Error("Unexpected Pump.fun token PnL fields");
  }
  return {
    realizedPnlUsd: data.realized_pnl_usd, unrealizedPnlUsd: data.unrealized_pnl_usd,
    amountHeld: data.amount_held, feeUsd,
    hasTransfers: data.has_transfers ?? null, hasUntrustedUsdBasis: data.has_untrusted_usd_basis ?? null,
  };
}

export async function getPumpFunWalletPnl(mint: string, wallet: string, request: PumpFunFetch = fetch): Promise<PumpFunWalletPnl | null> {
  const url = `${PROFILE_API}/v2/pnl/token/${encodeURIComponent(wallet)}/${encodeURIComponent(mint)}`;
  const response = await requestPumpFun(request, url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Pump.fun token PnL HTTP ${response.status}`);
  const result = await response.json() as { success?: boolean; data?: PumpFunTokenPnl } | null;
  const data = result?.data;
  if (result?.success !== true || !data || data.mint !== mint) throw new Error("Unexpected Pump.fun token PnL response");
  return parseWalletPnl(data);
}

export type WalletPnlLookup =
  | { status: "available"; pnl: PumpFunWalletPnl }
  | { status: "not-found" }
  | { status: "error"; error: string };

type HolderPnl = {
  wallet: string;
  mint: string;
  realized?: { pnl?: { usd?: number | null } } | null;
  unrealized?: { pnl?: { usd?: number | null }; amount_held?: number | null } | null;
  fee?: { usd?: number | null } | null;
  has_transfers?: boolean;
  has_untrusted_usd_basis?: boolean;
};

export async function getPumpFunWalletPnls(mint: string, wallets: string[], request: PumpFunFetch = fetch): Promise<Map<string, WalletPnlLookup>> {
  const unique = [...new Set(wallets)];
  const results = new Map<string, WalletPnlLookup>();
  for (let offset = 0; offset < unique.length; offset += 20) {
    const batch = unique.slice(offset, offset + 20);
    try {
      const response = await requestPumpFun(request, `${PROFILE_API}/pnl/coin/${encodeURIComponent(mint)}/holders`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ holders: batch }),
      });
      if (!response.ok) throw new Error(`Pump.fun holder PnL HTTP ${response.status}`);
      const result = await response.json() as { success?: boolean; data?: HolderPnl[] } | null;
      if (result?.success !== true || !Array.isArray(result.data)) throw new Error("Unexpected Pump.fun holder PnL response");
      for (const row of result.data) {
        if (!row || row.mint !== mint || !batch.includes(row.wallet)) continue;
        try {
          const pnl = parseWalletPnl({
            mint,
            realized_pnl_usd: row.realized?.pnl?.usd ?? null,
            unrealized_pnl_usd: row.unrealized?.pnl?.usd ?? null,
            amount_held: row.unrealized?.amount_held ?? null,
            fee_usd: row.fee?.usd ?? null,
            has_transfers: row.has_transfers, has_untrusted_usd_basis: row.has_untrusted_usd_basis,
          });
          results.set(row.wallet, { status: "available", pnl });
        } catch (error) { rethrowAnalysisStop(error);
          results.set(row.wallet, { status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const wallet of batch) {
        if (results.has(wallet)) continue;
        try {
          const pnl = await getPumpFunWalletPnl(mint, wallet, request);
          results.set(wallet, pnl ? { status: "available", pnl } : { status: "not-found" });
        } catch (error) { rethrowAnalysisStop(error);
          results.set(wallet, { status: "error", error: error instanceof Error ? error.message : String(error) });
        }
        if (!request.managesPacing) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (error) { rethrowAnalysisStop(error);
      for (const wallet of batch) {
        if (!results.has(wallet)) results.set(wallet, { status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    console.log("callout pnl progress", { mint, checked: Math.min(offset + 20, unique.length), total: unique.length });
    if (offset + 20 < unique.length && !request.managesPacing) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return results;
}

type PumpFunTrade = {
  blockId: string;
  blockTimeMs: number;
  txId: string;
  kind: string;
  side: string;
  trader: { address: string } | null;
  pool?: { address: string } | null;
  baseAmount: { raw: string };
};

export type ConfirmedWindowSales = {
  transactions: ScannedTransaction[];
  poolAddresses: string[];
  complete: boolean;
  error?: string;
};

export async function confirmPumpFunWindowSales(
  mint: string,
  transactions: TransactionReference[],
  start: number,
  end: number,
  request: PumpFunFetch = fetch,
  execution?: AnalysisExecution,
): Promise<ConfirmedWindowSales> {
  if (!transactions.length) return { transactions: [], poolAddresses: [], complete: true };
  const candidates = new Set<string>();
  let firstSlot = Infinity;
  let lastSlot = 0;
  for (const tx of transactions) {
    firstSlot = Math.min(firstSlot, tx.slot);
    lastSlot = Math.max(lastSlot, tx.slot);
    candidates.add(tx.signature);
  }
  const matches = new Map<string, Set<string>>();
  const poolAddresses = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let complete = true;
  let error: string | undefined;
  let pages = 0, done = false;
  const key = `sales:${mint}:${start}:${end}`;
  type Head = { cursor?: string; pages: number; complete: boolean; error?: string; done: boolean };
  type Chunk = { matches: [string, string[]][]; pools: string[]; next?: string };
  const previous = await execution?.load<Head>(key);
  // Older versions marked a transient failure as a finished tape. Recheck
  // that tape rather than treating its unverified remainder as complete.
  const saved = previous?.error && isTransientRequestError(previous.error) ? undefined : previous;
  if (saved) {
    ({ cursor, pages, complete, error, done } = saved);
    for (let page = 1; page <= pages; page++) {
      const chunk = await execution!.load<Chunk>(`${key}:${page}`);
      if (!chunk) throw new AnalysisStopped("paused", "storage", "중간 저장된 매도 확인 페이지가 없습니다. 새 분석을 실행해 주세요.");
      for (const [signature, owners] of chunk.matches) {
        const combined = matches.get(signature) ?? new Set<string>();
        owners.forEach((owner) => combined.add(owner));
        matches.set(signature, combined);
      }
      chunk.pools.forEach((pool) => poolAddresses.add(pool));
      if (chunk.next) seenCursors.add(chunk.next);
    }
  }
  try {
    // Dense windows can exceed 100 pages. Stop at the scanned slot boundary
    // or the end of the tape; repeated cursors and request failures stay partial.
    while (!done) {
      const url = new URL(`${FRONTEND_API}/trades/${encodeURIComponent(SOLANA_CHAIN)}/${encodeURIComponent(mint)}`);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      else url.searchParams.set("before", `${lastSlot + 1}-0-0-${end * 1000}`);
      const response = await requestPumpFun(request, url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Pump.fun trades HTTP ${response.status}`);
      const data = await response.json() as { trades?: PumpFunTrade[]; cursor?: string | null } | null;
      if (!data || !Array.isArray(data.trades) || (data.cursor !== null && typeof data.cursor !== "string")) {
        throw new Error("Unexpected Pump.fun trades response");
      }
      let reachedStart = false;
      const chunkMatches = new Map<string, Set<string>>(), chunkPools = new Set<string>();
      for (const trade of data.trades) {
        if (!trade || typeof trade.blockId !== "string" || !/^\d+$/.test(trade.blockId)
          || !Number.isFinite(trade.blockTimeMs)) {
          complete = false;
          error = "Pump.fun returned a trade without a valid block or timestamp";
          continue;
        }
        if (BigInt(trade.blockId) < BigInt(firstSlot)) reachedStart = true;
        if (trade.blockTimeMs < start * 1000 || trade.blockTimeMs >= end * 1000) continue;
        if (typeof trade.pool?.address === "string") { poolAddresses.add(trade.pool.address); chunkPools.add(trade.pool.address); }
        if (trade.kind !== "swap" || trade.side !== "sell") continue;
        if (typeof trade.trader?.address !== "string" || !trade.trader.address
          || typeof trade.txId !== "string" || !trade.txId
          || typeof trade.baseAmount?.raw !== "string" || !/^\d+$/.test(trade.baseAmount.raw)) {
          complete = false;
          error = "Pump.fun returned a sale without valid trader, signature or quantity";
          continue;
        }
        if (BigInt(trade.baseAmount.raw) === 0n || !candidates.has(trade.txId)) continue;
        const owners = matches.get(trade.txId) ?? new Set<string>();
        owners.add(trade.trader.address);
        matches.set(trade.txId, owners);
        const pageOwners = chunkMatches.get(trade.txId) ?? new Set<string>();
        pageOwners.add(trade.trader.address);
        chunkMatches.set(trade.txId, pageOwners);
      }
      pages++;
      done = reachedStart || !data.cursor;
      if (!done && seenCursors.has(data.cursor!)) { complete = false; error = "Pump.fun trades pagination repeated"; done = true; }
      if (pages % 25 === 0) console.log("callout sales progress", { mint, page: pages, confirmedTransactions: matches.size, hasMore: Boolean(data.cursor), reachedStart });
      const next = data.cursor ?? undefined;
      await execution?.commit([
        { key: `${key}:${pages}`, value: { matches: [...chunkMatches].map(([signature, owners]) => [signature, [...owners]]), pools: [...chunkPools], ...(next ? { next } : {}) } satisfies Chunk },
        { key, value: { ...(next ? { cursor: next } : {}), pages, complete, ...(error ? { error } : {}), done } satisfies Head },
      ], { kind: "sales", mint, pages, confirmedTransactions: matches.size });
      if (done) break;
      seenCursors.add(next!);
      cursor = next;
      if (!request.managesPacing) await (execution ? execution.wait(200) : new Promise((resolve) => setTimeout(resolve, 200)));
    }
  } catch (cause) { rethrowAnalysisStop(cause);
    complete = false;
    error = cause instanceof Error ? cause.message : String(cause);
    await execution?.commit([{ key, value: { ...(cursor ? { cursor } : {}), pages, complete, error, done: true } satisfies Head }]);
  }
  return {
    transactions: transactions.map((tx) => ({ ...tx, owners: [...(matches.get(tx.signature) ?? [])] }))
      .filter((tx) => tx.owners.length > 0),
    poolAddresses: [...poolAddresses], complete, ...(error ? { error } : {}),
  };
}
