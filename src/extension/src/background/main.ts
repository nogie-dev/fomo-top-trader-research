import type { ExtensionMessage } from "../shared/types";
import { createPumpFunTabFetch } from "./pumpfun-tab";
import { cancelSavedAnalysis, deleteAnalysis, getAnalysisStatus, initializeAnalysisJobs, resumeSavedAnalysis, startSavedAnalysis } from "./analysis-jobs";
import { openResults } from "../shared/results-navigation";
import { getSavedAnalysis } from "../shared/analysis-store";
import { findAnalysisSource } from "./analysis-source";

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "DELETE_SAVED_ANALYSIS") {
    const page = sender.url?.split(/[?#]/u)[0];
    if (page !== chrome.runtime.getURL("results.html") && page !== chrome.runtime.getURL("popup.html")) {
      sendResponse({ ok: false, message: "확장프로그램의 결과 페이지에서 기록을 삭제해 주세요." });
      return;
    }
    deleteAnalysis(message.analysisId)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "저장된 분석을 삭제하지 못했습니다." }));
    return true;
  }
  if (message?.type === "RESUME_ANALYSIS" || message?.type === "CANCEL_ANALYSIS") {
    const page = sender.url?.split(/[?#]/u)[0];
    const extensionPage = page === chrome.runtime.getURL("results.html") || page === chrome.runtime.getURL("popup.html");
    void (async () => {
      const record = await getSavedAnalysis(message.analysisId);
      if (!record) throw new Error("저장된 분석을 찾을 수 없습니다.");
      if (!extensionPage && (sender.frameId !== 0 || sender.tab?.id === undefined
        || ![`https://pump.fun/profile/${record.profile.wallet}`, `https://pump.fun/profile/${record.profile.wallet}/`].includes(page ?? ""))) {
        throw new Error("결과 페이지나 해당 Pump.fun 프로필에서 분석을 제어해 주세요.");
      }
      if (message.type === "CANCEL_ANALYSIS") { const result = await cancelSavedAnalysis(message.analysisId); return { ok: true, status: "cancelled", ...(result.message ? { message: result.message } : {}) }; }
      const source = await findAnalysisSource(record.profile.wallet, extensionPage ? record.source?.tabId : sender.tab?.id);
      return resumeSavedAnalysis(message.analysisId, createPumpFunTabFetch(source.tabId, record.profile.wallet), { source });
    })().then(sendResponse).catch((error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "분석 상태를 변경하지 못했습니다." }));
    return true;
  }
  if (message?.type === "SYNC_ANALYSIS_STATE") {
    initializeAnalysisJobs().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false, message: "저장된 분석 상태를 읽지 못했습니다." }));
    return true;
  }
  if (message?.type === "OPEN_ANALYSIS_RESULTS") {
    openResults(message.analysisId).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "결과 페이지를 열지 못했습니다." }));
    return true;
  }
  if (message?.type === "GET_ANALYSIS_STATUS") {
    getAnalysisStatus(message.analysisId).then(({ profileWallet, result }) => {
      if (sender.frameId !== 0 || sender.tab?.id === undefined
        || ![`https://pump.fun/profile/${profileWallet}`, `https://pump.fun/profile/${profileWallet}/`].includes(sender.url?.split(/[?#]/u)[0] ?? "")) {
        sendResponse({ ok: false, message: "분석을 시작한 Pump.fun 프로필에서 상태를 확인해 주세요." });
        return;
      }
      sendResponse(result);
    }).catch((error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "분석 상태를 읽지 못했습니다." }));
    return true;
  }
  if (message?.type !== "ANALYZE_PROFILE") return;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId !== 0
    || !sender.url || new URL(sender.url).origin !== "https://pump.fun") {
    sendResponse({ ok: false, status: "failed", message: "Start analysis from a Pump.fun profile tab." });
    return;
  }
  startSavedAnalysis(message.profile, createPumpFunTabFetch(sender.tab.id, message.profile.wallet, sender.documentId), { source: { tabId: sender.tab.id, ...(sender.documentId ? { documentId: sender.documentId } : {}) } })
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, status: "failed", message: error instanceof Error ? error.message : "Analysis failed." }));
  return true;
});
