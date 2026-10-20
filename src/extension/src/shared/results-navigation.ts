import { isAnalysisId } from "./analysis-store";

export function resultsUrl(id?: string): string {
  const url = new URL(chrome.runtime.getURL("results.html"));
  if (id) {
    if (!isAnalysisId(id)) throw new Error("올바르지 않은 분석 ID입니다.");
    url.searchParams.set("analysisId", id);
  }
  return url.href;
}

export async function openResults(id?: string): Promise<void> {
  await chrome.tabs.create({ url: resultsUrl(id) });
}
