import type { PumpFunFetch } from "./pumpfun-api";

export type AnalysisBudget = { maxRequests: number | null; maxDurationMs: number | null };
export const DEFAULT_ANALYSIS_BUDGET: AnalysisBudget = { maxRequests: null, maxDurationMs: null };
export type AnalysisPosition = { kind: "scan" | "sales"; mint: string; pages: number; confirmedTransactions?: number };
export type AnalysisExecutionInfo = {
  resumable: boolean;
  budget: AnalysisBudget;
  runRequests: number;
  totalRequests: number;
  elapsedMs: number;
  position?: AnalysisPosition;
  pauseReason?: "requests" | "time" | "storage" | "source" | "network" | "interrupted";
};
export type AnalysisStats = { rpcRequests: number; signatures: number; transactions: number };
export type CheckpointEntry = { key: string; value: unknown };
export interface CheckpointStore {
  read<T>(analysisId: string, key: string): Promise<T | undefined>;
  write(analysisId: string, entries: readonly CheckpointEntry[]): Promise<void>;
  clear(analysisId: string): Promise<void>;
}
export interface AnalysisExecution {
  readonly stats: AnalysisStats;
  readonly signal: AbortSignal;
  readonly rpcUrl?: string;
  check(): void;
  pause(message: string): never;
  request<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  load<T>(key: string): Promise<T | undefined>;
  commit(entries: readonly CheckpointEntry[], position?: AnalysisPosition): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  wrapPumpFunFetch(request: PumpFunFetch): PumpFunFetch;
}

export class AnalysisStopped extends Error {
  readonly analysisStopped = true;
  readonly status: "paused" | "cancelled";
  readonly reason: AnalysisExecutionInfo["pauseReason"];
  constructor(status: "paused" | "cancelled", reason: AnalysisExecutionInfo["pauseReason"], message: string) { super(message); this.status = status; this.reason = reason; }
}
export function isAnalysisStopped(error: unknown): error is AnalysisStopped {
  return Boolean(error && typeof error === "object" && "analysisStopped" in error && error.analysisStopped === true);
}
export function rethrowAnalysisStop(error: unknown): void { if (isAnalysisStopped(error)) throw error; }
