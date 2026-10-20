import { analyzeProfile } from "./analyze";
import { deleteSavedAnalysis, getSavedAnalysis, recoverInterruptedAnalyses, saveAnalysis } from "../shared/analysis-store";
import { savedSnapshot } from "../shared/saved-analysis";
import type { SavedAnalysis } from "../shared/saved-analysis";
import type { AnalysisStarted, AnalysisStatus, AnalyzeResult, ProfileInput } from "../shared/types";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import { DEFAULT_ANALYSIS_BUDGET, isAnalysisStopped } from "../shared/analysis-control";
import type { AnalysisBudget, CheckpointStore } from "../shared/analysis-control";
import { AnalysisRun } from "./analysis-run";
import { checkpointStore } from "./checkpoints";
import { getQuickNodeRpcUrl, RPC_REQUIRED_MESSAGE } from "../shared/rpc-settings";

export type AnalysisOptions = { store?: CheckpointStore; budget?: AnalysisBudget; source?: SavedAnalysis["source"] };
type ActiveJob = { record: SavedAnalysis; run: AnalysisRun; completion: Promise<AnalyzeResult>; cancelRequested: boolean };
let initialization: Promise<void> | undefined;
const activeJobs = new Map<string, ActiveJob>();
const locks = new Map<string, Promise<unknown>>();
export function initializeAnalysisJobs(): Promise<void> {
  return initialization ??= recoverInterruptedAnalyses().catch((error) => { initialization = undefined; throw error; });
}
function locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const pending = (locks.get(id) ?? Promise.resolve()).then(operation);
  const settled = pending.then(() => undefined, () => undefined);
  locks.set(id, settled);
  void settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
  return pending;
}
function started(record: SavedAnalysis): AnalysisStarted {
  return { ok: true, status: "running", analysisId: record.id, wallet: record.profile.wallet, callouts: record.profile.callouts?.length ?? 0 };
}
function response(record: SavedAnalysis, run: AnalysisRun, status: AnalyzeResult["status"], message: string): AnalyzeResult {
  return { ok: false, status, wallet: record.profile.wallet, callouts: record.profile.callouts?.length ?? 0,
    rpcRequests: run.stats.rpcRequests, signatures: run.stats.signatures, analysisId: record.id, message };
}
async function clearCheckpoint(store: CheckpointStore, id: string): Promise<boolean> {
  try { await store.clear(id); return true; }
  catch (error) { console.warn("analysis checkpoint cleanup failed", { analysisId: id, error: error instanceof Error ? error.message : String(error) }); return false; }
}
async function cleanCancelled(record: SavedAnalysis, store: CheckpointStore): Promise<void> {
  if (await clearCheckpoint(store, record.id)) return;
  record.response!.message = "분석은 취소됐지만 중간 데이터를 정리하지 못했습니다. 저장소 상태를 확인한 뒤 기록을 삭제해 주세요.";
  try { await saveAnalysis(record); } catch {}
}
async function executeAnalysis(job: ActiveJob, request: PumpFunFetch, store: CheckpointStore): Promise<AnalyzeResult> {
  const { record, run } = job;
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch((error: unknown) => console.warn("analysis keep-alive failed", { analysisId: record.id, error: error instanceof Error ? error.message : String(error) }));
  }, 20_000);
  let lastSavedAt = Date.now();
  run.onCheckpoint = async () => {
    if (Date.now() - lastSavedAt < 1000) return;
    record.execution = run.info();
    record.updatedAt = new Date().toISOString();
    await saveAnalysis(record);
    lastSavedAt = Date.now();
  };
  try {
    const result = await analyzeProfile(record.profile, run.wrapPumpFunFetch(request), {
      execution: run,
      onProgress: async (phase) => {
        run.check();
        record.phase = phase;
        record.execution = run.info();
        record.updatedAt = new Date().toISOString();
        await saveAnalysis(record);
      },
      onComplete: (capture) => { run.check(); record.snapshot = savedSnapshot(capture); },
    });
    run.check();
    record.status = result.status;
    record.phase = "finished";
    record.execution = run.info(false);
    record.response = { ...result, analysisId: record.id };
    record.finishedAt = record.updatedAt = new Date().toISOString();
    await saveAnalysis(record);
    await clearCheckpoint(store, record.id);
    return record.response;
  } catch (error) {
    if (isAnalysisStopped(error) || job.cancelRequested) {
      record.snapshot = undefined;
      const status = job.cancelRequested ? "cancelled" : isAnalysisStopped(error) ? error.status : "cancelled";
      if (status === "paused") {
        try { await run.flushStopped(); }
        catch { console.warn("analysis stop checkpoint could not be flushed", { analysisId: record.id }); }
      }
      record.status = status;
      if (status === "cancelled") record.phase = "finished";
      record.execution = run.info(status === "paused");
      record.response = response(record, run, status, status === "cancelled" ? "분석을 취소했습니다." : error instanceof Error ? error.message : "분석을 일시정지했습니다.");
      record.updatedAt = new Date().toISOString();
      if (status === "cancelled") record.finishedAt = record.updatedAt;
      else delete record.finishedAt;
      let persisted = true;
      try { await saveAnalysis(record); }
      catch { persisted = false; record.response.message = "중간 상태를 저장하지 못했습니다. 저장 공간을 확인하고 결과 페이지를 다시 열어 주세요."; }
      if (status === "cancelled" && persisted) await cleanCancelled(record, store);
      return record.response;
    }
    const saveFailed = Boolean(record.snapshot);
    if (saveFailed) record.snapshot = undefined;
    record.status = "failed";
    record.phase = "finished";
    record.execution = run.info(false);
    record.response = response(record, run, "failed", saveFailed ? "분석 결과를 로컬에 저장하지 못했습니다. 저장 공간과 확장프로그램 상태를 확인해 주세요."
      : error instanceof Error ? error.message : "분석에 실패했습니다.");
    record.finishedAt = record.updatedAt = new Date().toISOString();
    try { await saveAnalysis(record); await clearCheckpoint(store, record.id); }
    catch { record.response.message = "분석 결과를 로컬에 저장하지 못했습니다. 저장 공간과 확장프로그램 상태를 확인해 주세요."; }
    return record.response;
  } finally {
    activeJobs.delete(record.id);
    run.dispose();
    clearInterval(keepAlive);
  }
}
function launch(record: SavedAnalysis, run: AnalysisRun, request: PumpFunFetch, store: CheckpointStore): Promise<AnalyzeResult> {
  const job: ActiveJob = { record, run, cancelRequested: false, completion: Promise.resolve({} as AnalyzeResult) };
  activeJobs.set(record.id, job);
  job.completion = executeAnalysis(job, request, store);
  void job.completion.catch((error: unknown) => console.error("analysis job failed", { analysisId: record.id, error: error instanceof Error ? error.message : String(error) }));
  return job.completion;
}
async function createAnalysis(profile: ProfileInput, options: AnalysisOptions) {
  await initializeAnalysisJobs();
  const rpcUrl = await getQuickNodeRpcUrl();
  if (!rpcUrl) throw new Error(RPC_REQUIRED_MESSAGE);
  const store = options.store ?? checkpointStore;
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const run = await AnalysisRun.create(id, store, options.budget ?? DEFAULT_ANALYSIS_BUDGET, false, rpcUrl);
  const record: SavedAnalysis = {
    schemaVersion: 1, id, profile: JSON.parse(JSON.stringify({ ...profile, callouts: profile.callouts ?? [] })),
    createdAt: now, updatedAt: now, status: "running", phase: "collecting", execution: run.info(), ...(options.source ? { source: options.source } : {}),
  };
  try { await saveAnalysis(record); }
  catch { run.dispose(); await clearCheckpoint(store, id); throw new Error("분석 기록을 로컬에 저장하지 못했습니다. 저장 공간과 확장프로그램 상태를 확인해 주세요."); }
  return { record, run, store };
}
export async function runSavedAnalysis(profile: ProfileInput, request: PumpFunFetch, options: AnalysisOptions = {}): Promise<AnalyzeResult> {
  const { record, run, store } = await createAnalysis(profile, options);
  return launch(record, run, request, store);
}
export async function startSavedAnalysis(profile: ProfileInput, request: PumpFunFetch, options: AnalysisOptions = {}): Promise<AnalysisStarted> {
  const { record, run, store } = await createAnalysis(profile, options);
  void launch(record, run, request, store);
  return started(record);
}
export async function resumeSavedAnalysis(id: string, request: PumpFunFetch, options: AnalysisOptions = {}): Promise<AnalysisStarted> {
  await initializeAnalysisJobs();
  return locked(id, async () => {
    if (activeJobs.has(id)) throw new Error("이미 진행 중인 분석입니다.");
    const record = await getSavedAnalysis(id);
    if (!record || record.status !== "paused" || !record.execution?.resumable) throw new Error("이어갈 수 있는 일시정지 기록이 아닙니다.");
    const rpcUrl = await getQuickNodeRpcUrl();
    if (!rpcUrl) throw new Error(RPC_REQUIRED_MESSAGE);
    const store = options.store ?? checkpointStore;
    const run = await AnalysisRun.create(id, store, options.budget ?? DEFAULT_ANALYSIS_BUDGET, true, rpcUrl);
    record.status = "running";
    record.snapshot = undefined;
    record.execution = run.info();
    record.response = undefined;
    record.updatedAt = new Date().toISOString();
    delete record.finishedAt;
    if (options.source) record.source = options.source;
    try { await saveAnalysis(record); }
    catch (error) { run.dispose(); throw error; }
    void launch(record, run, request, store);
    return started(record);
  });
}
export async function cancelSavedAnalysis(id: string, options: AnalysisOptions = {}): Promise<AnalyzeResult> {
  await initializeAnalysisJobs();
  return locked(id, async () => {
    const active = activeJobs.get(id);
    if (active) {
      if (active.record.status === "running") {
        active.cancelRequested = true;
        active.run.cancel();
        return active.completion;
      }
      if (active.record.status === "paused" || active.record.status === "cancelled") await active.completion;
      else throw new Error("이미 종료된 분석입니다.");
    }
    const record = await getSavedAnalysis(id);
    if (record?.status === "cancelled" && record.response) return record.response;
    if (!record || record.status !== "paused") throw new Error("취소할 수 있는 분석이 아닙니다.");
    record.status = "cancelled";
    record.phase = "finished";
    if (record.execution) record.execution.resumable = false;
    record.finishedAt = record.updatedAt = new Date().toISOString();
    record.response = { ok: false, status: "cancelled", analysisId: id, wallet: record.profile.wallet, callouts: record.profile.callouts?.length ?? 0,
      rpcRequests: record.response?.rpcRequests ?? 0, signatures: record.response?.signatures ?? 0, message: "분석을 취소했습니다." };
    await saveAnalysis(record);
    await cleanCancelled(record, options.store ?? checkpointStore);
    return record.response;
  });
}
export async function deleteAnalysis(id: string, options: AnalysisOptions = {}): Promise<void> {
  await initializeAnalysisJobs();
  return locked(id, async () => {
    if (activeJobs.has(id)) throw new Error("진행 중인 분석은 취소하거나 완료한 후 삭제해 주세요.");
    await deleteSavedAnalysis(id, () => (options.store ?? checkpointStore).clear(id));
  });
}
export async function getAnalysisStatus(id: string): Promise<{ profileWallet: string; result: AnalysisStatus }> {
  await initializeAnalysisJobs();
  let record = await getSavedAnalysis(id);
  if (!record) throw new Error("저장된 분석을 찾을 수 없습니다.");
  if (record.status === "running" && !activeJobs.has(id)) {
    record = await getSavedAnalysis(id);
    if (!record) throw new Error("저장된 분석을 찾을 수 없습니다.");
    if (record.status === "running") return {
      profileWallet: record.profile.wallet,
      result: { ok: true, analysisId: id, status: "interrupted", phase: "finished", response: {
        ok: false, status: "failed", analysisId: id, wallet: record.profile.wallet, callouts: record.profile.callouts?.length ?? 0,
        rpcRequests: 0, signatures: 0, message: "분석 실행이 종료되었지만 완료 상태를 저장하지 못했습니다. 저장 공간을 확인하고 다시 실행해 주세요.",
      } },
    };
  }
  return { profileWallet: record.profile.wallet, result: { ok: true, analysisId: record.id, status: record.status, phase: record.phase,
    ...(record.response ? { response: record.response } : {}), ...(record.execution ? { execution: record.execution } : {}) } };
}
