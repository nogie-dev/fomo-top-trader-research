import type { SavedAnalysis, SavedAnalysisListItem } from "./saved-analysis";

export const ANALYSIS_INDEX_KEY = "walletResearch:analyses:v1";
const recordKey = (id: string) => `walletResearch:analysis:${id}`;
export const isAnalysisId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
let writes: Promise<unknown> = Promise.resolve();

function queued<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation);
  writes = next.then(() => undefined, () => undefined);
  return next;
}

export async function listSavedAnalyses(): Promise<SavedAnalysisListItem[]> {
  const stored = (await chrome.storage.local.get(ANALYSIS_INDEX_KEY))[ANALYSIS_INDEX_KEY] as Record<string, SavedAnalysisListItem> | undefined;
  return Object.values(stored ?? {}).filter((item) => item && isAnalysisId(item.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export async function getSavedAnalysis(id: string): Promise<SavedAnalysis | null> {
  if (!isAnalysisId(id)) throw new Error("올바르지 않은 분석 ID입니다.");
  const record = (await chrome.storage.local.get(recordKey(id)))[recordKey(id)] as SavedAnalysis | undefined;
  if (!record) return null;
  if (record.schemaVersion !== 1 || record.id !== id || !record.profile || !Array.isArray(record.profile.callouts)) {
    throw new Error("저장된 분석을 읽을 수 없습니다.");
  }
  return record;
}

export function saveAnalysis(record: SavedAnalysis): Promise<void> {
  if (!isAnalysisId(record.id)) return Promise.reject(new Error("올바르지 않은 분석 ID입니다."));
  // Chrome storage accepts JSON data. Capture the state before another phase
  // mutates the in-memory job, and never store raw RPC pages or excluded rows.
  const snapshot = JSON.parse(JSON.stringify(record)) as SavedAnalysis;
  return queued(async () => {
    const stored = await chrome.storage.local.get(ANALYSIS_INDEX_KEY);
    const index = { ...(stored[ANALYSIS_INDEX_KEY] ?? {}) } as Record<string, SavedAnalysisListItem>;
    index[snapshot.id] = {
      id: snapshot.id, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, status: snapshot.status, phase: snapshot.phase,
      wallet: snapshot.profile.wallet, ...(snapshot.profile.handle ? { handle: snapshot.profile.handle } : {}),
      calloutCount: snapshot.profile.callouts?.length ?? 0, walletCount: snapshot.snapshot?.walletPnl.walletCountAfter ?? null,
    };
    await chrome.storage.local.set({ [recordKey(snapshot.id)]: snapshot, [ANALYSIS_INDEX_KEY]: index });
  });
}

// Run in the background worker so deletion shares the job-save queue.
export function deleteSavedAnalysis(id: string, cleanup?: () => Promise<void>): Promise<void> {
  if (!isAnalysisId(id)) return Promise.reject(new Error("올바르지 않은 분석 ID입니다."));
  return queued(async () => {
    const key = recordKey(id);
    const stored = await chrome.storage.local.get([ANALYSIS_INDEX_KEY, key]);
    const record = stored[key] as Pick<SavedAnalysis, "status" | "execution"> | undefined;
    const previous = (stored[ANALYSIS_INDEX_KEY] ?? {}) as Record<string, SavedAnalysisListItem>;
    if (record?.status === "running" || previous[id]?.status === "running") {
      throw new Error("진행 중인 분석은 완료 후 삭제할 수 있습니다.");
    }
    if (record?.execution) await cleanup?.();
    const index = { ...previous };
    delete index[id];
    await chrome.storage.local.set({ [ANALYSIS_INDEX_KEY]: index });
    try { await chrome.storage.local.remove(key); }
    catch (error) {
      // Keep the result discoverable if deleting its stored data fails.
      await chrome.storage.local.set({ [ANALYSIS_INDEX_KEY]: previous });
      throw error;
    }
  });
}

export async function recoverInterruptedAnalyses(): Promise<void> {
  for (const item of await listSavedAnalyses()) {
    if (item.status !== "running") continue;
    const record = await getSavedAnalysis(item.id);
    if (!record) continue;
    const resumable = Boolean(record.execution?.resumable);
    record.status = resumable ? "paused" : "interrupted";
    if (!resumable) record.phase = "finished";
    record.updatedAt = new Date().toISOString();
    if (resumable) { delete record.finishedAt; record.execution!.pauseReason = "interrupted"; }
    else record.finishedAt = record.updatedAt;
    record.response = {
      ok: false, status: resumable ? "paused" : "failed", wallet: record.profile.wallet, callouts: record.profile.callouts?.length ?? 0,
      rpcRequests: 0, signatures: 0, analysisId: record.id, message: resumable ? "분석 실행이 중단되어 일시정지했습니다. 저장된 지점부터 이어갈 수 있습니다." : "분석이 중단됐습니다. 원본 Pump.fun 프로필에서 다시 실행해 주세요.",
    };
    await saveAnalysis(record);
  }
}
