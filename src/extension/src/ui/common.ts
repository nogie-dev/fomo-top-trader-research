import type { AnalysisPhase, SavedAnalysisStatus } from "../shared/saved-analysis";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export const shortAddress = (value: string) => value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
export const amount = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—"
  : `${value > 0 ? "+" : value < 0 ? "−" : ""}${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(value))}`;
export const numberText = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("ko-KR").format(value);
export function dateText(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function statusText(status: string): string {
  return ({ running: "분석 중", paused: "일시정지", cancelled: "취소됨", analyzed: "완료", partial: "일부 조회 미완료", failed: "실패", interrupted: "중단됨", "rpc-disabled": "RPC 미설정",
    available: "정상", "not-found": "정보 없음", "not-requested": "미조회", error: "조회 실패" } as Record<string, string>)[status] ?? status;
}
export function badge(status: SavedAnalysisStatus | string): HTMLElement {
  const tone = ["analyzed", "available"].includes(status) ? "good" : status === "running" ? "working"
    : ["failed", "error"].includes(status) ? "bad" : ["partial", "interrupted", "paused"].includes(status) ? "warning" : "neutral";
  return element("span", `badge ${tone}`, statusText(status));
}
export const phaseText = (phase: AnalysisPhase) => ({ collecting: "매도 지갑과 토큰 손익을 수집하고 있습니다.", username: "닉네임 변경 이력을 확인하고 있습니다.", portfolio: "포트폴리오 참고 정보를 조회하고 있습니다.", finished: "분석이 종료됐습니다." })[phase];
export function externalLink(url: string, text: string): HTMLAnchorElement {
  const link = element("a", "external-link", text);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["pump.fun", "solscan.io"].includes(parsed.hostname)) throw new Error("지원하지 않는 링크입니다.");
  link.href = parsed.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
export async function syncAnalysisState(): Promise<string | null> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "SYNC_ANALYSIS_STATE" });
    return response?.ok ? null : response?.message ?? "분석 상태를 동기화하지 못했습니다. 저장된 결과를 표시합니다.";
  } catch { return "분석 상태를 동기화하지 못했습니다. 저장된 결과를 표시합니다."; }
}
