import type { AnalyzeResult, Callout, ProfileInput } from "./types";
import type { CalloutWindowStrategyResult } from "../strategies/types";
import type { WalletPnlStrategyResult } from "../strategies/wallet-pnl";
import type { AnalysisExecution, AnalysisExecutionInfo } from "./analysis-control";

export type AnalysisPhase = "collecting" | "username" | "portfolio" | "finished";
export type AnalysisSummary = {
  callouts: Pick<Callout, "sourceId" | "mint" | "at">[];
  collectedWallets: number;
  candidates: number;
  afterUsernameFilter: number;
  finalWallets: number;
  issues: NonNullable<AnalyzeResult["issues"]>;
};
export type AnalysisCapture = {
  walletPnl: WalletPnlStrategyResult;
  summary: AnalysisSummary;
  tokenResults: CalloutWindowStrategyResult;
};
export type AnalysisHooks = {
  execution?: AnalysisExecution;
  onProgress?: (phase: AnalysisPhase) => Promise<void> | void;
  onComplete?: (capture: AnalysisCapture) => Promise<void> | void;
};
export type SavedAnalysisSnapshot = {
  walletPnl: Omit<WalletPnlStrategyResult, "excludedWallets">;
  summary: AnalysisSummary;
  details: Record<string, { mint: string; transactions: string[]; lastSaleAt: string | null }[]>;
};
export type SavedAnalysisStatus = "running" | "interrupted" | AnalyzeResult["status"];
export type SavedAnalysis = {
  schemaVersion: 1;
  id: string;
  profile: ProfileInput;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: SavedAnalysisStatus;
  phase: AnalysisPhase;
  response?: AnalyzeResult;
  snapshot?: SavedAnalysisSnapshot;
  execution?: AnalysisExecutionInfo;
  source?: { tabId: number; documentId?: string };
};
export type SavedAnalysisListItem = Pick<SavedAnalysis, "id" | "createdAt" | "updatedAt" | "status" | "phase"> & {
  wallet: string;
  handle?: string;
  calloutCount: number;
  walletCount: number | null;
};

export function savedSnapshot(capture: AnalysisCapture): SavedAnalysisSnapshot {
  const { excludedWallets: _excluded, ...walletPnl } = capture.walletPnl;
  const retained = new Set(walletPnl.wallets.map(({ wallet }) => wallet));
  const details: SavedAnalysisSnapshot["details"] = {};
  for (const token of capture.tokenResults) for (const wallet of token.wallets) {
    if (!retained.has(wallet.wallet)) continue;
    (details[wallet.wallet] ??= []).push({ mint: token.mint, transactions: [...wallet.transactions], lastSaleAt: wallet.lastSaleAt });
  }
  return { walletPnl, summary: capture.summary, details };
}
