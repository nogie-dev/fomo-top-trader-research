import type { AnalysisExecutionInfo } from "./analysis-control";

export type CalloutSource = "pumpfun" | "x" | "telegram" | "unknown";

export type Callout = {
  sourceId?: string;
  mint: string;
  tokenName?: string;
  symbol?: string;
  tokenCreatedAt?: string;
  calloutPrice?: number;
  calloutPriceUsd?: number;
  at?: string;
  source: CalloutSource;
  url?: string;
};

export type ProfileInput = {
  wallet: string;
  handle?: string;
  callouts?: Callout[];
};

export type Signature = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string;
};

export type AnalyzeMessage = {
  type: "ANALYZE_PROFILE";
  profile: ProfileInput;
};

export type ExtensionMessage = AnalyzeMessage
  | { type: "GET_ANALYSIS_STATUS"; analysisId: string }
  | { type: "RESUME_ANALYSIS"; analysisId: string }
  | { type: "CANCEL_ANALYSIS"; analysisId: string }
  | { type: "OPEN_ANALYSIS_RESULTS"; analysisId?: string }
  | { type: "DELETE_SAVED_ANALYSIS"; analysisId: string }
  | { type: "SYNC_ANALYSIS_STATE" };

export type AnalyzeResult = {
  ok: boolean;
  status: "rpc-disabled" | "analyzed" | "partial" | "failed" | "paused" | "cancelled";
  wallet: string;
  callouts: number;
  rpcRequests: number;
  signatures: number;
  message?: string;
  issues?: AnalysisIssue[];
  analysisId?: string;
};

export type AnalysisStarted = {
  ok: true;
  status: "running";
  analysisId: string;
  wallet: string;
  callouts: number;
};
export type AnalysisStatus = {
  ok: true;
  analysisId: string;
  status: "running" | "interrupted" | AnalyzeResult["status"];
  phase: "collecting" | "username" | "portfolio" | "finished";
  response?: AnalyzeResult;
  execution?: AnalysisExecutionInfo;
};

export type AnalysisIssue = { stage: "collection" | "username" | "portfolio"; message: string; count: number };
