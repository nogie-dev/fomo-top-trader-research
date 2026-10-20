import { rethrowAnalysisStop } from "../shared/analysis-control";
import { isTransientRequestError } from "../shared/request-errors";
import { confirmPumpFunWindowSales, getPumpFunCoinInfo, getPumpFunWalletPnls } from "../background/pumpfun";
import { getPumpFunWalletProfiles } from "../background/pumpfun-profile";
import type { Callout } from "../shared/types";
import { scanAddressWindow } from "./scan";
import type { WindowScan } from "./scan";
import type { CalloutTokenResult, CalloutWindowStrategyResult, PumpFunWalletPnl, PumpFunWalletProfile, StrategyContext } from "./types";

const WINDOW = 60 * 60;
const PRE_WINDOW = 5 * 60;
const MAX_TRANSACTIONS = 1000;
const EMPTY_PNL: PumpFunWalletPnl = {
  realizedPnlUsd: null, unrealizedPnlUsd: null, amountHeld: null,
  feeUsd: null, hasTransfers: null, hasUntrustedUsdBasis: null,
};

function calloutId(callout: Callout): string {
  return callout.sourceId ?? `${callout.mint}:${callout.at ?? "unknown"}`;
}

export async function verify(ctx: StrategyContext): Promise<CalloutWindowStrategyResult> {
  const byMint = new Map<string, Callout[]>();
  for (const callout of ctx.callouts) {
    const callouts = byMint.get(callout.mint) ?? [];
    callouts.push(callout);
    byMint.set(callout.mint, callouts);
  }

  const results: CalloutWindowStrategyResult = [];
  const profiles = await ctx.execution?.load<Map<string, PumpFunWalletProfile>>("collector:profiles") ?? new Map<string, PumpFunWalletProfile>();
  for (const [wallet, profile] of profiles) if (isTransientRequestError(profile.profileError)) profiles.delete(wallet);
  for (const [mint, callouts] of byMint) {
    const cached = await ctx.execution?.load<CalloutTokenResult>(`token-result:${mint}`);
    const transient = cached && [cached.metadataError, ...cached.windows.map(({ error }) => error),
      ...cached.wallets.flatMap(({ error, profileError }) => [error, profileError])].some(isTransientRequestError);
    if (cached && !transient) { results.push(cached); continue; }
    const result: CalloutTokenResult = {
      mint, callouts, creatorAddress: null, curveAddress: null, ammAddress: null,
      creatorCandidates: [], poolAddresses: [], wallets: [], windows: [],
      status: "complete", metadataStatus: "not-found", pnlScope: "token-lifetime",
    };
    const pools = new Set<string>();
    const creators = new Set<string>();
    const wallets = new Map<string, { transactions: Set<string>; lastSaleAt: number | null }>();
    try {
      const coin = await getPumpFunCoinInfo(mint, ctx.pumpFunFetch);
      if (coin) {
        result.metadataStatus = "available";
        result.creatorAddress = coin.creatorAddress;
        result.curveAddress = coin.curveAddress;
        result.ammAddress = coin.ammAddress;
        coin.poolAddresses.forEach((address) => pools.add(address));
        if (coin.creatorAddress) creators.add(coin.creatorAddress);
      } else result.status = "partial";
    } catch (error) { rethrowAnalysisStop(error);
      result.status = "partial";
      result.metadataStatus = "error";
      result.metadataError = error instanceof Error ? error.message : String(error);
    }

    const scans = new Map<string, Promise<WindowScan>>();
    const confirmations = new Map<string, ReturnType<typeof confirmPumpFunWindowSales>>();
    for (const callout of callouts) {
      const at = callout.at ? Date.parse(callout.at) : NaN;
      const window: CalloutTokenResult["windows"][number] = {
        calloutId: calloutId(callout), at: callout.at, start: null, end: null,
        coverage: "invalid", signaturesScanned: 0, confirmedSales: 0,
      };
      result.windows.push(window);
      if (!Number.isFinite(at)) {
        result.status = "partial";
        window.error = "Callout timestamp is missing or invalid";
        continue;
      }
      const start = Math.floor(at / 1000) - PRE_WINDOW;
      const end = Math.floor(at / 1000) + WINDOW;
      const key = `${start}:${end}`;
      window.start = new Date(start * 1000).toISOString();
      window.end = new Date(end * 1000).toISOString();
      try {
        let pending = scans.get(key);
        if (!pending) {
          pending = scanAddressWindow(ctx, mint, callout, start, end, MAX_TRANSACTIONS);
          scans.set(key, pending);
        }
        const scan = await pending;
        window.signaturesScanned = scan.signatures;
        scan.mintInitialInfo.creatorCandidates.forEach((address) => creators.add(address));
        scan.mintInitialInfo.poolAddresses.forEach((address) => pools.add(address));
        scan.poolAddresses.forEach((address) => pools.add(address));
        let confirmation = confirmations.get(key);
        if (!confirmation) {
          confirmation = ctx.execution ? confirmPumpFunWindowSales(mint, scan.transactionReferences, start, end, ctx.pumpFunFetch, ctx.execution)
            : confirmPumpFunWindowSales(mint, scan.transactionReferences, start, end, ctx.pumpFunFetch);
          confirmations.set(key, confirmation);
        }
        const sales = await confirmation;
        sales.poolAddresses.forEach((address) => pools.add(address));
        window.coverage = !scan.complete || !sales.complete ? "partial" : Date.now() < end * 1000 ? "open" : "complete";
        if (sales.error) window.error = sales.error;
        if (window.coverage !== "complete") result.status = "partial";
        const signatures = new Set<string>();
        for (const tx of sales.transactions) {
          for (const owner of tx.owners) {
            if (owner === ctx.profile.wallet || owner === result.creatorAddress || pools.has(owner)) continue;
            const wallet = wallets.get(owner) ?? { transactions: new Set<string>(), lastSaleAt: null };
            wallet.transactions.add(tx.signature);
            if (tx.blockTime !== null) wallet.lastSaleAt = Math.max(wallet.lastSaleAt ?? tx.blockTime, tx.blockTime);
            wallets.set(owner, wallet);
            signatures.add(tx.signature);
          }
        }
        window.confirmedSales = signatures.size;
        console.log("callout sales confirmed", { mint, calloutId: window.calloutId, signaturesScanned: scan.signatures, confirmedSales: signatures.size, wallets: wallets.size });
      } catch (error) { rethrowAnalysisStop(error);
        result.status = "partial";
        window.coverage = "partial";
        window.error = error instanceof Error ? error.message : String(error);
      }
    }

    const addresses = [...wallets.keys()].filter((address) => !pools.has(address) && address !== result.creatorAddress && address !== ctx.profile.wallet);
    const pnls = await getPumpFunWalletPnls(mint, addresses, ctx.pumpFunFetch);
    const pnlFetchedAt = new Date().toISOString();
    const missingProfiles = addresses.filter((address) => !profiles.has(address));
    if (missingProfiles.length) {
      const fetchedProfiles = await getPumpFunWalletProfiles(missingProfiles, undefined, ctx.pumpFunFetch);
      fetchedProfiles.forEach((profile, address) => profiles.set(address, profile));
      await ctx.execution?.commit([{ key: "collector:profiles", value: profiles }]);
    }
    for (const address of addresses) {
      const wallet = wallets.get(address)!;
      const entry: CalloutTokenResult["wallets"][number] = {
        wallet: address,
        transactions: [...wallet.transactions],
        lastSaleAt: wallet.lastSaleAt === null ? null : new Date(wallet.lastSaleAt * 1000).toISOString(),
        status: "not-found", ...EMPTY_PNL, pnlFetchedAt,
        ...profiles.get(address)!,
      };
      const lookup = pnls.get(address);
      if (lookup?.status === "available") Object.assign(entry, lookup.pnl, { status: "available" });
      else if (lookup?.status === "not-found") result.status = "partial";
      else {
        entry.status = "error";
        entry.error = lookup?.error ?? "Pump.fun PnL lookup did not return a wallet result";
        result.status = "partial";
      }
      if (entry.profileStatus === "error" || entry.profileStatus === "partial") result.status = "partial";
      result.wallets.push(entry);
    }
    result.creatorCandidates = [...creators];
    result.poolAddresses = [...pools];
    results.push(result);
    await ctx.execution?.commit([{ key: `token-result:${mint}`, value: result }]);
    console.log("callout window result", {
      mint, callouts: callouts.length, wallets: result.wallets.length, status: result.status,
    });
  }
  return results;
}
