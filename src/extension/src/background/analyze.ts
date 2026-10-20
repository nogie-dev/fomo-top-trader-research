import { getQuickNodeRpcUrl, RPC_REQUIRED_MESSAGE } from "../shared/rpc-settings";
import type { AnalyzeResult, Callout, ProfileInput } from "../shared/types";
import { isSolanaAddress } from "../shared/solana";
import { verify as verifyCalloutWindow } from "../strategies/callout-window";
import { verify as verifyWalletPnl } from "../strategies/wallet-pnl";
import type { StrategyContext } from "../strategies/types";
import { getPumpFunWalletPortfolioPnls } from "./pumpfun-portfolio";
import { getPumpFunWalletUsernameUpdates } from "./pumpfun-username";
import { analysisIssues } from "./analysis-status";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import type { AnalysisHooks, AnalysisSummary } from "../shared/saved-analysis";

function validateCallouts(callouts: Callout[] = []): Callout[] {
  return callouts.filter((item) => isSolanaAddress(item.mint));
}

export async function analyzeProfile(profile: ProfileInput, pumpFunFetch?: PumpFunFetch, hooks: AnalysisHooks = {}): Promise<AnalyzeResult> {
  if (!isSolanaAddress(profile.wallet)) throw new Error("Enter a valid Solana wallet address.");
  const callouts = validateCallouts(profile.callouts);

  const rpcUrl = hooks.execution?.rpcUrl ?? await getQuickNodeRpcUrl();
  if (!rpcUrl) {
    return {
      ok: true,
      status: "rpc-disabled",
      wallet: profile.wallet,
      callouts: callouts.length,
      rpcRequests: 0,
      signatures: 0,
      message: RPC_REQUIRED_MESSAGE,
    };
  }

  const ctx: StrategyContext = {
    profile,
    callouts,
    stats: hooks.execution?.stats ?? { rpcRequests: 0, signatures: 0, transactions: 0 },
    ...(hooks.execution ? { execution: hooks.execution } : {}),
    ...(pumpFunFetch ? { pumpFunFetch } : {}),
  };
  await hooks.onProgress?.("collecting");
  const result1 = await verifyCalloutWindow(ctx);
  console.log("result1", result1);
  const walletPnlOptions = {
    excludeFollowersAtLeast: 100,
    minTokenCount: 3,
    positiveRealizedPnlOnly: true,
  };
  const candidates = verifyWalletPnl(result1, walletPnlOptions);
  await hooks.onProgress?.("username");
  const usernameUpdates = await getPumpFunWalletUsernameUpdates(candidates.wallets.map(({ wallet }) => wallet), pumpFunFetch);
  const renamedOptions = { ...walletPnlOptions, excludeRenamedWallets: true };
  const retained = verifyWalletPnl(result1, renamedOptions, undefined, usernameUpdates);
  await hooks.onProgress?.("portfolio");
  const portfolioPnls = await getPumpFunWalletPortfolioPnls(retained.wallets.map(({ wallet }) => wallet), pumpFunFetch);
  // Portfolio PnL is reference data; its sign or availability does not exclude wallets.
  const walletPnl = verifyWalletPnl(result1, renamedOptions, portfolioPnls, usernameUpdates);
  console.log("wallet pnl", walletPnl);
  const issues = analysisIssues(result1, usernameUpdates, portfolioPnls);
  const summary: AnalysisSummary = {
    callouts: callouts.map(({ sourceId, mint, at }) => ({ sourceId, mint, at })),
    collectedWallets: candidates.walletCountBefore, candidates: candidates.walletCountAfter,
    afterUsernameFilter: retained.walletCountAfter, finalWallets: walletPnl.walletCountAfter, issues,
  };
  console.log("analysis summary", summary);
  if (issues.length) console.warn("analysis incomplete", issues);
  await hooks.onComplete?.({ walletPnl, summary, tokenResults: result1 });

  return {
    ok: issues.length === 0,
    status: issues.length ? "partial" : "analyzed",
    wallet: profile.wallet,
    callouts: callouts.length,
    rpcRequests: ctx.stats.rpcRequests,
    signatures: ctx.stats.signatures,
    message: issues.length ? `Analysis incomplete: ${issues[0].message}. See the background console for details.`
      : "Completed callout window collection and wallet PnL aggregation.",
    ...(issues.length ? { issues } : {}),
  };
}
