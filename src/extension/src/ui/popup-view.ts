import { listSavedAnalyses } from "../shared/analysis-store";
import { openResults } from "../shared/results-navigation";
import { badge, dateText, element, shortAddress, syncAnalysisState } from "./common";
import { getQuickNodeRpcUrl, normalizeQuickNodeRpc, QUICKNODE_RPC_KEY, saveQuickNodeRpcUrl } from "../shared/rpc-settings";

export function mountPopup(root: HTMLElement) {
  root.innerHTML = `<header class="popup-header"><span class="brand-mark" aria-hidden="true">W</span><div><strong>Wallet Research</strong><span class="eyebrow">콜아웃 지갑 분석</span></div></header>
    <form class="popup-rpc" data-rpc-form novalidate>
      <label for="quicknode-rpc">QuickNode RPC</label>
      <div class="popup-rpc-fields"><input id="quicknode-rpc" type="password" autocomplete="off" spellcheck="false" placeholder="https://…quiknode.pro/…" aria-describedby="rpc-hint rpc-status" disabled><button class="button primary" type="submit" data-save-rpc disabled>저장</button></div>
      <p id="rpc-hint" class="popup-rpc-hint">이 기기에 저장 · 다음 분석·이어가기부터 적용</p>
      <p id="rpc-status" class="popup-rpc-status" data-rpc-status role="status" aria-live="polite"></p>
    </form>
    <div class="popup-intro"><h1>분석 결과</h1><p>이 기기에 저장된 결과를 다시 열어보세요.</p></div>
    <button class="button primary popup-open" data-open-all>결과 페이지 열기 <span aria-hidden="true">↗</span></button>
    <div class="section-label">최근 분석 <button class="text-button" data-refresh>새로고침</button></div>
    <p class="page-message" role="status" aria-live="polite"></p><div class="popup-history"></div>
    <footer class="popup-footer"><span class="local-dot"></span>로컬 저장 · 결과 열람 시 API 재조회 없음</footer>`;
  const list = root.querySelector<HTMLElement>(".popup-history")!;
  const status = root.querySelector<HTMLElement>(".page-message")!;
  const rpcForm = root.querySelector<HTMLFormElement>("[data-rpc-form]")!;
  const rpcInput = root.querySelector<HTMLInputElement>("#quicknode-rpc")!;
  const rpcSave = root.querySelector<HTMLButtonElement>("[data-save-rpc]")!;
  const rpcStatus = root.querySelector<HTMLElement>("[data-rpc-status]")!;
  let disposed = false, revision = 0;
  let rpcRevision = 0, rpcLoading = true, rpcSaving = false, rpcDirty = false;
  async function loadRpc() {
    const current = ++rpcRevision;
    rpcLoading = true; rpcInput.disabled = rpcSave.disabled = true;
    try {
      const address = await getQuickNodeRpcUrl();
      if (disposed || current !== rpcRevision) return;
      rpcInput.value = address;
      rpcInput.removeAttribute("aria-invalid");
      rpcStatus.textContent = address ? "저장된 RPC 주소입니다." : "RPC 주소를 저장하면 분석을 시작할 수 있습니다.";
    } catch {
      if (!disposed && current === rpcRevision) rpcStatus.textContent = "RPC 설정을 읽지 못했습니다. 주소를 입력해 다시 저장해 주세요.";
    } finally {
      if (!disposed && current === rpcRevision) { rpcLoading = false; rpcInput.disabled = rpcSave.disabled = false; }
    }
  }
  rpcInput.addEventListener("input", () => { rpcDirty = true; rpcInput.removeAttribute("aria-invalid"); rpcStatus.textContent = ""; });
  rpcForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (disposed || rpcLoading || rpcSaving) return;
    let address: string;
    try { address = normalizeQuickNodeRpc(rpcInput.value); }
    catch (error) {
      rpcInput.setAttribute("aria-invalid", "true");
      rpcStatus.textContent = error instanceof Error ? error.message : "QuickNode RPC 주소를 확인해 주세요.";
      rpcInput.focus(); return;
    }
    rpcSaving = true; rpcInput.disabled = rpcSave.disabled = true;
    void saveQuickNodeRpcUrl(address).then(() => {
      if (disposed) return;
      rpcInput.value = address; rpcDirty = false;
      rpcStatus.textContent = address ? "RPC 주소를 저장했습니다." : "RPC 설정을 삭제했습니다.";
    }).catch(() => {
      if (!disposed) rpcStatus.textContent = "RPC 설정을 저장하지 못했습니다. 다시 시도해 주세요.";
    }).finally(() => {
      rpcSaving = false;
      if (!disposed) rpcInput.disabled = rpcSave.disabled = false;
    });
  });
  const open = async (id?: string) => {
    try { await openResults(id); }
    catch { status.textContent = "결과 탭을 열지 못했습니다. 다시 시도해 주세요."; }
  };
  async function refresh(sync = false) {
    const current = ++revision;
    try {
      const warning = sync ? await syncAnalysisState() : null;
      const records = await listSavedAnalyses();
      if (disposed || current !== revision) return;
      list.replaceChildren();
      status.textContent = warning ?? "";
      if (!records.length) {
        const empty = element("div", "empty-state compact");
        empty.append(element("strong", "", "아직 저장된 분석이 없습니다"), element("p", "", "Pump.fun 프로필의 verify에서 callout을 선택하고 분석을 시작하세요."));
        list.append(empty);
      }
      for (const record of records) {
        const button = element("button", "history-card");
        button.type = "button";
        button.dataset.analysisId = record.id;
        const top = element("span", "history-card-top");
        top.append(element("strong", "", record.handle ?? shortAddress(record.wallet)), badge(record.status));
        button.append(top, element("span", "history-meta", `${record.calloutCount}개 callout · ${record.walletCount === null ? "최종 후보 미확정" : `후보 ${record.walletCount}개`}`), element("time", "history-time", `${dateText(record.createdAt)} KST`));
        button.addEventListener("click", () => void open(record.id));
        list.append(button);
      }
    } catch { if (!disposed && current === revision) status.textContent = "저장된 분석을 읽지 못했습니다. 확장프로그램을 다시 열어 주세요."; }
  }
  root.querySelector("[data-open-all]")!.addEventListener("click", () => void open());
  root.querySelector("[data-refresh]")!.addEventListener("click", () => void refresh(true));
  const changed = (changes: Record<string, unknown>, area: string) => {
    if (area !== "local") return;
    if (changes[QUICKNODE_RPC_KEY] && !rpcDirty && !rpcSaving) void loadRpc();
    if (Object.keys(changes).some((key) => key !== QUICKNODE_RPC_KEY)) void refresh();
  };
  chrome.storage.onChanged.addListener(changed);
  const ready = Promise.all([refresh(true), loadRpc()]).then(() => {});
  return { ready, refresh, dispose() { disposed = true; revision++; rpcRevision++; chrome.storage.onChanged.removeListener(changed); root.replaceChildren(); } };
}
