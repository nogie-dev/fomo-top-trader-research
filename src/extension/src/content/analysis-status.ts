import type { AnalysisStatus, AnalyzeResult } from "../shared/types";

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Analysis status check cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function waitForAnalysis(
  analysisId: string, signal: AbortSignal, progress: (phase: AnalysisStatus["phase"]) => void,
): Promise<AnalyzeResult> {
  while (true) {
    if (signal.aborted) throw signal.reason ?? new Error("Analysis status check cancelled");
    const result = await chrome.runtime.sendMessage({ type: "GET_ANALYSIS_STATUS", analysisId }) as AnalysisStatus | { ok: false; message?: string } | undefined;
    if (signal.aborted) throw signal.reason ?? new Error("Analysis status check cancelled");
    if (!result?.ok) throw new Error(result?.message ?? "분석 상태를 읽지 못했습니다. 결과 페이지에서 저장 기록을 확인해 주세요.");
    if (result.analysisId !== analysisId) throw new Error("분석 상태의 ID가 일치하지 않습니다.");
    if (result.status === "interrupted") throw new Error(result.response?.message ?? "분석이 중단됐습니다. 원본 프로필에서 다시 실행해 주세요.");
    if (result.status !== "running") {
      if (!result.response) throw new Error("저장된 분석에 완료 응답이 없습니다.");
      return result.response;
    }
    progress(result.phase);
    await delay(signal);
  }
}
