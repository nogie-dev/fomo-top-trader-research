import { getSavedAnalysis, listSavedAnalyses } from "../shared/analysis-store";
import type { SavedAnalysis } from "../shared/saved-analysis";
import type { WalletPnl } from "../strategies/wallet-pnl";
import { amount, badge, dateText, element, externalLink, numberText, phaseText, shortAddress, statusText, syncAnalysisState } from "./common";
import { createWalletCsv } from "./wallet-csv";

type SortValue = string | number | null;
type Column = { id: string; title: string; numeric?: boolean; hidden?: boolean; value: (wallet: WalletPnl) => SortValue; text?: (wallet: WalletPnl) => string; };
const renamed = (wallet: WalletPnl): number | null => wallet.usernameUpdate.status === "available" ? Number((wallet.usernameUpdate.lastUsernameUpdateTimestamp ?? 0) > 0) : null;
const columns: Column[] = [
  { id: "wallet", title: "Wallet", value: (w) => w.wallet },
  { id: "handle", title: "Handle", value: (w) => w.username ?? null },
  { id: "realized", title: "선택 토큰 실현손익", numeric: true, value: (w) => w.totalRealizedPnlUsd, text: (w) => amount(w.totalRealizedPnlUsd) },
  { id: "tokens", title: "매도 확인 토큰", numeric: true, value: (w) => w.tokenCount },
  { id: "portfolio", title: "전체 PnL · 참고", numeric: true, value: (w) => w.portfolioPnl.status === "available" ? w.portfolioPnl.totalPnlUsd : null, text: (w) => w.portfolioPnl.status === "available" ? amount(w.portfolioPnl.totalPnlUsd) : "—" },
  { id: "followers", title: "팔로워", numeric: true, value: (w) => w.followers },
  { id: "following", title: "팔로잉", numeric: true, hidden: true, value: (w) => w.following },
  { id: "renamed", title: "닉네임 변경", value: renamed, text: (w) => renamed(w) === null ? "미확인" : renamed(w) ? "변경 이력 있음" : "없음" },
  { id: "pumpUser", title: "Pump 사용자", value: (w) => w.isPumpUser == null ? null : Number(w.isPumpUser), text: (w) => w.isPumpUser == null ? "미확인" : w.isPumpUser ? "예" : "아니오" },
  { id: "profileStatus", title: "프로필 상태", value: (w) => w.profileStatus },
  { id: "portfolioRealized", title: "포트폴리오 실현손익", numeric: true, hidden: true, value: (w) => w.portfolioPnl.status === "available" ? w.portfolioPnl.realizedPnlUsd : null, text: (w) => w.portfolioPnl.status === "available" ? amount(w.portfolioPnl.realizedPnlUsd) : "—" },
  { id: "portfolioUnrealized", title: "포트폴리오 미실현손익", numeric: true, hidden: true, value: (w) => w.portfolioPnl.status === "available" ? w.portfolioPnl.unrealizedPnlUsd : null, text: (w) => w.portfolioPnl.status === "available" ? amount(w.portfolioPnl.unrealizedPnlUsd) : "—" },
  { id: "portfolioStatus", title: "포트폴리오 상태", hidden: true, value: (w) => w.portfolioPnl.status },
];

export function sortWallets(wallets: WalletPnl[], columnId: string, direction: "asc" | "desc"): WalletPnl[] {
  const column = columns.find(({ id }) => id === columnId) ?? columns[2];
  return [...wallets].sort((a, b) => {
    const av = column.value(a), bv = column.value(b);
    if (av === null) return bv === null ? a.wallet.localeCompare(b.wallet) : 1;
    if (bv === null) return -1;
    const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "ko");
    return (direction === "asc" ? order : -order) || a.wallet.localeCompare(b.wallet);
  });
}

export function mountResults(root: HTMLElement) {
  root.innerHTML = `<header class="app-header"><a class="brand" href="results.html"><span class="brand-mark" aria-hidden="true">W</span>Wallet Research</a><span class="app-label">CALLOUT ANALYSIS</span><span class="local-indicator"><span class="local-dot"></span>이 기기에 저장됨</span></header>
    <div class="workspace"><aside class="sidebar"><div class="section-label">분석 기록 <button class="text-button" data-refresh aria-label="저장 기록 새로고침">↻</button></div><div data-history></div><p class="sidebar-note">Pump.fun 프로필에서 callout을 선택해 새 분석을 시작하세요.</p></aside>
    <main class="results-main"><p class="page-message" data-page-message role="status" aria-live="polite"></p>
      <section class="result-heading"><div><p class="eyebrow">선택한 CALLOUT의 매도 지갑</p><h1>후보 지갑 <span class="count-pill" data-total>—</span></h1><div class="run-meta" data-run-meta></div></div><div class="result-actions"><div data-run-status></div><div class="analysis-controls"><button type="button" class="button primary" data-resume-analysis hidden disabled>이어가기</button><button type="button" class="delete-record" data-cancel-analysis hidden disabled>분석 취소</button><button type="button" class="delete-record" data-delete-analysis hidden disabled>기록 삭제</button></div></div></section>
      <div class="callout-chips" data-callouts></div><section class="summary-grid" data-summary aria-label="후보 수집 단계"></section>
      <div class="analysis-notice" data-notice hidden></div>
      <section class="data-card"><div class="table-toolbar"><label class="search-field"><span aria-hidden="true">⌕</span><input type="search" data-search aria-label="지갑 주소 또는 닉네임 검색" placeholder="지갑 주소 또는 닉네임 검색"><kbd>/</kbd></label>
        <div class="table-tools"><span class="table-count" data-count></span><details class="column-menu"><summary>표시할 열 <span aria-hidden="true">⌄</span></summary><div class="column-options" data-columns></div></details><button type="button" class="csv-download" data-download-csv title="현재 검색·정렬된 지갑의 전체 13개 데이터 열을 CSV로 저장합니다." disabled>CSV 다운로드 <span aria-hidden="true">↓</span></button></div></div>
        <div class="table-scroll" tabindex="0" aria-label="후보 지갑 표, 가로로 스크롤할 수 있습니다"><table class="wallet-table"><caption class="sr-only">선택한 callout의 후보 지갑. 열 제목으로 정렬할 수 있습니다.</caption><thead></thead><tbody></tbody></table></div>
        <div class="empty-state" data-empty hidden><span class="empty-symbol" aria-hidden="true">▦</span><strong data-empty-title></strong><p data-empty-message></p></div>
        <footer class="table-footer"><span data-sort-note></span><span>손익은 토큰 전체 기간의 누적값 · 전체 포트폴리오 PnL은 참고용</span></footer></section>
      <p class="scope-note">매도 확인 구간: 각 callout −5분 ~ +1시간. 검색과 표 정렬은 저장된 후보 목록의 표시만 바꿉니다.</p>
    </main></div><dialog class="wallet-detail" aria-labelledby="wallet-detail-title"><div class="detail-header"><div><p class="eyebrow">WALLET DETAIL</p><h2 id="wallet-detail-title">지갑 상세</h2></div><button class="icon-button" data-close-detail aria-label="지갑 상세 닫기">×</button></div><div data-detail-body></div></dialog>
    <dialog class="delete-dialog" aria-labelledby="delete-analysis-title"><h2 id="delete-analysis-title">분석 기록 삭제</h2><p data-delete-description></p><p data-delete-scope>이 기록의 후보 지갑과 상세 결과를 로컬 저장소에서 삭제합니다.</p><p class="inline-warning" data-delete-error role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button" data-cancel-delete>취소</button><button type="button" class="button danger" data-confirm-delete>삭제</button></div></dialog>`;
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const historyList = get("[data-history]"), message = get("[data-page-message]"), head = get("thead"), body = get("tbody");
  const search = get<HTMLInputElement>("[data-search]"), dialog = get<HTMLDialogElement>("dialog");
  const download = get<HTMLButtonElement>("[data-download-csv]");
  const deleteButton = get<HTMLButtonElement>("[data-delete-analysis]"), deleteDialog = get<HTMLDialogElement>(".delete-dialog");
  const confirmDelete = get<HTMLButtonElement>("[data-confirm-delete]"), cancelDelete = get<HTMLButtonElement>("[data-cancel-delete]");
  const resumeButton = get<HTMLButtonElement>("[data-resume-analysis]"), cancelButton = get<HTMLButtonElement>("[data-cancel-analysis]");
  let selectedId = new URL(location.href).searchParams.get("analysisId");
  let record: SavedAnalysis | null = null, query = "", sortId = "realized", direction: "asc" | "desc" = "desc";
  let disposed = false, revision = 0, loading = true;
  let deleteTarget: string | null = null, deleting = false;
  let deleteMode: "delete" | "cancel" = "delete", controlling = false;
  const visible = new Set(columns.filter((column) => !column.hidden).map(({ id }) => id));
  const finishedSnapshot = () => record && !["running", "paused", "cancelled"].includes(record.status) ? record.snapshot : undefined;

  function displayedWallets(): WalletPnl[] {
    const wallets = finishedSnapshot()?.walletPnl.wallets ?? [];
    const filtered = wallets.filter((wallet) => [wallet.wallet, wallet.username ?? "", wallet.displayName].some((text) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    return sortWallets(filtered, sortId, direction);
  }

  function detail(wallet: WalletPnl) {
    if (!record?.snapshot) return;
    const container = get("[data-detail-body]");
    container.replaceChildren();
    get("#wallet-detail-title").textContent = wallet.username || shortAddress(wallet.wallet);
    const address = externalLink(`https://pump.fun/profile/${encodeURIComponent(wallet.wallet)}`, wallet.wallet);
    address.classList.add("full-address");
    container.append(address);
    const stats = element("div", "detail-stats");
    stats.append(element("div", "", `선택 토큰 실현손익 ${amount(wallet.totalRealizedPnlUsd)}`), element("div", "", `전체 PnL · 참고 ${wallet.portfolioPnl.status === "available" ? amount(wallet.portfolioPnl.totalPnlUsd) : "—"}`), element("div", "", `Joined ${dateText(wallet.joined)} KST`));
    container.append(stats);
    if (wallet.profileError || wallet.portfolioPnl.error || wallet.usernameUpdate.error) container.append(element("p", "inline-warning", [wallet.profileError, wallet.portfolioPnl.error, wallet.usernameUpdate.error].filter(Boolean).join(" · ")));
    const selected = new Map((record.profile.callouts ?? []).map((callout) => [callout.mint, callout]));
    for (const [mint, callout] of selected) {
      const token = wallet.tokens.find((item) => item.mint === mint);
      const saved = record.snapshot.details[wallet.wallet]?.find((item) => item.mint === mint);
      const section = element("section", "token-detail");
      const title = element("div", "token-detail-title");
      const tokenPnl = token?.realizedPnlUsd;
      title.append(element("h3", "", callout.symbol || callout.tokenName || shortAddress(mint)), element("strong", tokenPnl == null ? "muted" : tokenPnl < 0 ? "loss" : tokenPnl > 0 ? "gain" : "", token ? amount(token.realizedPnlUsd) : "—"));
      section.append(title, element("p", "muted", token ? `실현손익 · ${statusText(token.status)} · 마지막 매도 ${dateText(saved?.lastSaleAt)}` : "이 분석 구간에서 매도가 확인되지 않았습니다."));
      for (const item of record.profile.callouts?.filter((item) => item.mint === mint) ?? []) {
        section.append(externalLink(item.sourceId ? `https://pump.fun/callouts/${encodeURIComponent(mint)}/${encodeURIComponent(item.sourceId)}` : `https://pump.fun/coin/${encodeURIComponent(mint)}`, `Callout · ${dateText(item.at)} KST ↗`));
      }
      if (token?.hasTransfers || token?.hasUntrustedUsdBasis) section.append(element("p", "inline-warning", [token.hasTransfers ? "토큰 전송 이력 있음" : "", token.hasUntrustedUsdBasis ? "USD 원가 기준 주의" : ""].filter(Boolean).join(" · ")));
      if (saved?.transactions.length) {
        const transactions = element("details", "transaction-list");
        transactions.append(element("summary", "", `확인된 매도 거래 ${numberText(saved.transactions.length)}건`));
        const list = element("ul"), more = element("button", "text-button", "거래 더 보기");
        more.type = "button";
        let count = 0;
        const append = () => {
          const end = Math.min(count + 20, saved.transactions.length);
          for (; count < end; count++) {
            const signature = saved.transactions[count], item = element("li");
            item.append(externalLink(`https://solscan.io/tx/${encodeURIComponent(signature)}`, `${signature.slice(0, 14)}…${signature.slice(-8)} ↗`));
            list.append(item);
          }
          more.hidden = count >= saved.transactions.length;
        };
        more.addEventListener("click", append);
        append();
        transactions.append(list, more);
        section.append(transactions);
      }
      container.append(section);
    }
    if (!dialog.open) dialog.showModal();
  }

  function renderTable() {
    get(".table-scroll").style.setProperty("--pinned-width", visible.has("handle") ? "calc(var(--wallet-width) + var(--handle-width))" : "var(--wallet-width)");
    const wallets = finishedSnapshot()?.walletPnl.wallets ?? [];
    const sorted = displayedWallets();
    download.disabled = loading || record?.id !== selectedId || sorted.length === 0 || record?.status === "running" || record?.status === "paused";
    deleteButton.hidden = !record;
    deleteButton.disabled = loading || deleting || controlling || !record || record.id !== selectedId || record.status === "running";
    deleteButton.title = record?.status === "running" ? "진행 중인 분석은 완료 후 삭제할 수 있습니다." : "선택한 분석 기록을 이 기기에서 삭제합니다.";
    resumeButton.hidden = record?.status !== "paused" || !record.execution?.resumable;
    cancelButton.hidden = record?.status !== "running" && record?.status !== "paused";
    resumeButton.disabled = cancelButton.disabled = loading || deleting || controlling || record?.id !== selectedId;
    head.replaceChildren();
    const heading = element("tr");
    for (const column of columns.filter(({ id }) => visible.has(id))) {
      const cell = element("th", `column-${column.id}${column.numeric ? " numeric" : ""}`);
      cell.scope = "col";
      cell.setAttribute("aria-sort", sortId === column.id ? direction === "desc" ? "descending" : "ascending" : "none");
      const button = element("button", "sort-button", `${column.title} ${sortId === column.id ? direction === "desc" ? "↓" : "↑" : "↕"}`);
      button.type = "button";
      button.dataset.sort = column.id;
      button.addEventListener("click", () => {
        direction = sortId === column.id ? direction === "desc" ? "asc" : "desc" : column.numeric ? "desc" : "asc";
        sortId = column.id;
        renderTable();
      });
      cell.append(button);
      heading.append(cell);
    }
    heading.append(element("th", "action-column", "상세"));
    head.append(heading);
    body.replaceChildren();
    const mintCount = new Set(record?.profile.callouts?.map(({ mint }) => mint)).size;
    for (const wallet of sorted) {
      const row = element("tr");
      row.dataset.wallet = wallet.wallet;
      for (const column of columns.filter(({ id }) => visible.has(id))) {
        const value = column.value(wallet);
        const cell = element("td", `column-${column.id}${column.numeric ? " numeric" : ""}`);
        if (column.id === "wallet") {
          const address = element("button", "wallet-address", shortAddress(wallet.wallet));
          address.type = "button";
          address.title = wallet.wallet;
          address.setAttribute("aria-label", `지갑 ${wallet.wallet} 상세 보기`);
          address.addEventListener("click", () => detail(wallet));
          const copy = element("button", "copy-button", "⧉");
          copy.type = "button";
          copy.setAttribute("aria-label", `지갑 주소 복사 ${wallet.wallet}`);
          copy.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(wallet.wallet); message.textContent = "지갑 주소를 복사했습니다."; }
            catch { message.textContent = "복사하지 못했습니다. 상세 화면에서 주소를 선택해 복사해 주세요."; }
          });
          cell.append(address, copy);
        } else if (column.id === "profileStatus" || column.id === "portfolioStatus") {
          cell.append(badge(String(value)));
          cell.title = column.id === "profileStatus" ? wallet.profileError ?? "" : wallet.portfolioPnl.error ?? "";
        } else {
          cell.textContent = column.id === "tokens" ? `${wallet.tokenCount} / ${mintCount}` : column.text ? column.text(wallet) : typeof value === "number" ? numberText(value) : value ?? "—";
          if (column.id === "realized" || column.id.startsWith("portfolio") && column.numeric) {
            const tone = value === null ? "muted" : Number(value) < 0 ? "loss" : Number(value) > 0 ? "gain" : "";
            if (tone) cell.classList.add(tone);
          }
          if (column.id === "portfolio") cell.title = wallet.portfolioPnl.error ?? "참고 정보이며 후보 제외 조건에 사용하지 않습니다.";
        }
        row.append(cell);
      }
      const action = element("td", "action-column"), button = element("button", "text-button", "보기 ↗");
      button.type = "button";
      button.setAttribute("aria-label", `${wallet.username || shortAddress(wallet.wallet)} 토큰별 상세`);
      button.addEventListener("click", () => detail(wallet));
      action.append(button);
      row.append(action);
      body.append(row);
    }
    get("[data-count]").textContent = record?.status === "paused" || record?.status === "running" ? "최종 후보 미확정" : `${numberText(sorted.length)} / ${numberText(wallets.length)}개 지갑`;
    get("[data-sort-note]").textContent = `${columns.find(({ id }) => id === sortId)!.title} ${direction === "desc" ? "내림차순" : "오름차순"}`;
    get(".table-scroll").hidden = sorted.length === 0;
    get("[data-empty]").hidden = sorted.length !== 0;
    get("[data-empty-title]").textContent = !record ? "저장된 분석이 없습니다" : record.status === "paused" ? "분석이 일시정지됐습니다" : record.status === "cancelled" ? "분석을 취소했습니다" : record.status === "running" ? "분석을 진행하고 있습니다" : !record.snapshot ? "표시할 후보 결과가 없습니다" : query ? "검색 결과가 없습니다" : "조건을 통과한 지갑이 없습니다";
    get("[data-empty-message]").textContent = !record ? "Pump.fun 프로필의 verify에서 분석을 시작하면 이곳에 기록됩니다." : record.status === "paused" ? "해당 Pump.fun 프로필 탭을 열고 이어가기를 누르세요. 전체 구간 확인 전에는 최종 후보를 표시하지 않습니다." : record.status === "running" ? "분석이 끝날 때까지 원본 Pump.fun 프로필 탭을 열어 두세요." : !record.snapshot ? record.response?.message ?? "원본 프로필에서 분석을 다시 실행해 주세요." : query ? "다른 주소나 닉네임으로 검색해 보세요." : "선택한 callout과 적용된 조건을 확인해 주세요.";
  }

  function renderRecord() {
    get("[data-total]").textContent = numberText(finishedSnapshot()?.walletPnl.walletCountAfter);
    get("[data-run-meta]").replaceChildren();
    get("[data-run-status]").replaceChildren();
    get("[data-callouts]").replaceChildren();
    get("[data-summary]").replaceChildren();
    const notice = get("[data-notice]");
    notice.replaceChildren();
    notice.hidden = true;
    if (record) {
      get("[data-run-meta]").append(externalLink(`https://pump.fun/profile/${encodeURIComponent(record.profile.wallet)}`, record.profile.handle || shortAddress(record.profile.wallet)), element("span", "", `${dateText(record.createdAt)} KST · ${record.profile.callouts?.length ?? 0}개 callout`));
      get("[data-run-status]").append(badge(record.status), element("p", "updated-time", `저장 ${dateText(record.updatedAt)} KST`));
      for (const callout of new Map(record.profile.callouts?.map((item) => [item.mint, item])).values()) get("[data-callouts]").append(element("span", "token-chip", callout.symbol || callout.tokenName || shortAddress(callout.mint)));
      const summary = finishedSnapshot()?.summary;
      for (const [label, value] of [["수집된 지갑", summary?.collectedWallets], ["초기 후보", summary?.candidates], ["닉네임 조건 통과", summary?.afterUsernameFilter], ["최종 후보", summary?.finalWallets]] as const) {
        const metric = element("div", "metric");
        metric.append(element("span", "", label), element("strong", "", numberText(value)));
        get("[data-summary]").append(metric);
      }
      const issues = record.response?.issues ?? record.snapshot?.summary.issues ?? [];
      if (record.status === "running" || record.status !== "analyzed" || issues.length) {
        notice.hidden = false;
        notice.append(element("strong", "", record.status === "running" ? phaseText(record.phase) : statusText(record.status)));
        if (record.status === "running") notice.append(element("p", "", "원본 Pump.fun 프로필 탭을 유지해 주세요. 결과는 이 화면에 자동으로 반영됩니다."));
        else if (issues.length) {
          notice.append(element("span", "", "일부 정보를 조회하지 못해 현재 확인된 결과를 표시합니다."));
          const errors = element("details", "notice-details");
          errors.append(element("summary", "", `조회 오류 ${numberText(issues.reduce((sum, issue) => sum + issue.count, 0))}개 항목 ⌄`));
          for (const issue of issues) errors.append(element("p", "issue-row", `${issue.message} · ${numberText(issue.count)}개 항목`));
          notice.append(errors);
        } else if (record.response?.message) notice.append(element("p", "", record.response.message));
        const execution = record.execution;
        if (execution) {
          const requestLimit = execution.budget.maxRequests === null ? "" : ` / ${numberText(execution.budget.maxRequests)}`;
          const timeLimit = execution.budget.maxDurationMs === null ? "" : ` / ${Math.round(execution.budget.maxDurationMs / 1000)}`;
          notice.append(element("p", "execution-progress", `이번 실행 요청 ${numberText(execution.runRequests)}${requestLimit}회 · 누적 ${numberText(execution.totalRequests)}회 · 실행 ${Math.floor(execution.elapsedMs / 1000)}${timeLimit}초`));
          if (execution.position) {
            const { kind, mint, pages, confirmedTransactions } = execution.position;
            const token = record.profile.callouts?.find((callout) => callout.mint === mint);
            notice.append(element("p", "execution-progress", `${token?.symbol || token?.tokenName || shortAddress(mint)} · ${kind === "sales" ? "매도 확인" : "RPC 스캔"} ${numberText(pages)}페이지 저장${confirmedTransactions === undefined ? "" : ` · 매도 거래 ${numberText(confirmedTransactions)}건 확인`}`));
          }
        }
      }
    }
    renderTable();
  }

  async function refresh(sync = false) {
    const current = ++revision;
    loading = true;
    download.disabled = true;
    deleteButton.disabled = true;
    resumeButton.disabled = cancelButton.disabled = true;
    try {
      const warning = sync ? await syncAnalysisState() : null;
      const records = await listSavedAnalyses();
      if (disposed || current !== revision) return;
      if (!records.some(({ id }) => id === selectedId)) {
        selectedId = records[0]?.id ?? null;
        query = search.value = "";
        if (dialog.open) dialog.close();
        const url = new URL(location.href);
        selectedId ? url.searchParams.set("analysisId", selectedId) : url.searchParams.delete("analysisId");
        history.replaceState({}, "", url);
      }
      if (deleteTarget && !deleting && !records.some(({ id }) => id === deleteTarget)) {
        if (deleteDialog.open) deleteDialog.close();
        deleteTarget = null;
      }
      const loaded = selectedId ? await getSavedAnalysis(selectedId) : null;
      if (disposed || current !== revision) return;
      record = loaded;
      loading = false;
      message.textContent = selectedId && !record ? "이 분석은 저장소에 없습니다. 왼쪽에서 다른 기록을 선택하세요." : warning ?? "";
      historyList.replaceChildren();
      if (!records.length) historyList.append(element("p", "history-empty", "저장된 기록이 없습니다."));
      for (const item of records) {
        const button = element("button", `history-card${item.id === selectedId ? " selected" : ""}`);
        button.type = "button";
        button.dataset.analysisId = item.id;
        button.setAttribute("aria-current", item.id === selectedId ? "true" : "false");
        const top = element("span", "history-card-top");
        top.append(element("strong", "", item.handle || shortAddress(item.wallet)), badge(item.status));
        button.append(top, element("span", "history-meta", `${item.calloutCount}개 callout · ${item.walletCount === null ? "최종 후보 미확정" : `후보 ${item.walletCount}개`}`), element("time", "history-time", `${dateText(item.createdAt)} KST`));
        button.addEventListener("click", () => {
          selectedId = item.id;
          query = search.value = "";
          if (dialog.open) dialog.close();
          const url = new URL(location.href);
          url.searchParams.set("analysisId", item.id);
          history.replaceState({}, "", url);
          void refresh();
        });
        historyList.append(button);
      }
      renderRecord();
    } catch (error) {
      if (!disposed && current === revision) {
        record = null;
        loading = false;
        message.textContent = error instanceof Error ? error.message : "저장된 분석을 읽지 못했습니다.";
        renderRecord();
      }
    }
  }
  for (const column of columns) {
    const label = element("label"), checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = visible.has(column.id);
    checkbox.disabled = column.id === "wallet";
    checkbox.addEventListener("change", () => { checkbox.checked ? visible.add(column.id) : visible.delete(column.id); renderTable(); });
    label.append(checkbox, document.createTextNode(column.title));
    get("[data-columns]").append(label);
  }
  search.addEventListener("input", () => { query = search.value.trim(); renderTable(); });
  function openConfirmation(mode: "delete" | "cancel") {
    if (loading || deleting || controlling || !record || record.id !== selectedId) return;
    if (mode === "delete" ? record.status === "running" : !["running", "paused"].includes(record.status)) return;
    deleteMode = mode;
    deleteTarget = record.id;
    get("#delete-analysis-title").textContent = mode === "delete" ? "분석 기록 삭제" : "분석 취소";
    get("[data-delete-scope]").textContent = mode === "delete" ? "이 기록의 후보 지갑과 상세 결과를 로컬 저장소에서 삭제합니다." : "진행 중인 조회를 멈추고 중간 데이터를 삭제합니다. 취소한 분석은 이어갈 수 없습니다.";
    confirmDelete.textContent = mode === "delete" ? "삭제" : "취소 확정";
    cancelDelete.textContent = mode === "delete" ? "취소" : "돌아가기";
    get("[data-delete-description]").textContent = `${record.profile.handle || shortAddress(record.profile.wallet)} · ${dateText(record.createdAt)} KST · ${record.profile.callouts?.length ?? 0}개 callout`;
    get("[data-delete-error]").hidden = true;
    deleteDialog.showModal();
    cancelDelete.focus();
  }
  deleteButton.addEventListener("click", () => openConfirmation("delete"));
  cancelButton.addEventListener("click", () => openConfirmation("cancel"));
  resumeButton.addEventListener("click", async () => {
    if (loading || deleting || controlling || record?.status !== "paused" || !record.execution?.resumable || record.id !== selectedId) return;
    const id = record.id;
    controlling = true;
    renderTable();
    try {
      const response = await chrome.runtime.sendMessage({ type: "RESUME_ANALYSIS", analysisId: id });
      if (!response?.ok) throw new Error(response?.message || "분석을 이어가지 못했습니다.");
      if (!disposed) { await refresh(); message.textContent = "저장된 지점부터 분석을 이어갑니다. Pump.fun 프로필 탭을 유지해 주세요."; }
    } catch (error) { if (!disposed) message.textContent = error instanceof Error ? error.message : "분석을 이어가지 못했습니다."; }
    finally { controlling = false; if (!disposed) renderTable(); }
  });
  cancelDelete.addEventListener("click", () => { if (!deleting) { deleteTarget = null; deleteDialog.close(); } });
  deleteDialog.addEventListener("cancel", (event) => { if (deleting) event.preventDefault(); else deleteTarget = null; });
  confirmDelete.addEventListener("click", async () => {
    if (!deleteTarget || deleting) return;
    const id = deleteTarget;
    const mode = deleteMode;
    deleting = confirmDelete.disabled = cancelDelete.disabled = true;
    deleteButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: mode === "delete" ? "DELETE_SAVED_ANALYSIS" : "CANCEL_ANALYSIS", analysisId: id });
      if (!response?.ok) throw new Error(response?.message || (mode === "delete" ? "저장된 분석을 삭제하지 못했습니다." : "분석을 취소하지 못했습니다."));
      if (disposed) return;
      deleteTarget = null;
      deleteDialog.close();
      await refresh();
      if (!disposed) message.textContent = mode === "delete" ? "분석 기록을 로컬 저장소에서 삭제했습니다." : response.message || "분석을 취소하고 중간 데이터를 정리했습니다.";
    } catch (error) {
      if (disposed) return;
      get("[data-delete-error]").textContent = error instanceof Error ? error.message : "저장된 분석을 삭제하지 못했습니다.";
      get("[data-delete-error]").hidden = false;
    } finally {
      deleting = confirmDelete.disabled = cancelDelete.disabled = false;
      if (!disposed) renderTable();
    }
  });
  download.addEventListener("click", () => {
    if (loading || !record?.snapshot || record.id !== selectedId) return;
    const wallets = displayedWallets();
    if (!wallets.length) return;
    try {
      const csv = createWalletCsv(wallets, record.profile.callouts ?? []);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const link = element("a");
      link.href = url;
      link.download = `wallet-pnl-${record.profile.wallet}-${record.id}.csv`;
      document.body.append(link);
      try {
        link.click();
        message.textContent = `${numberText(wallets.length)}개 지갑의 CSV 다운로드를 시작했습니다.`;
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      message.textContent = "CSV를 다운로드하지 못했습니다. 다시 시도해 주세요.";
    }
  });
  get("[data-refresh]").addEventListener("click", () => void refresh(true));
  get("[data-close-detail]").addEventListener("click", () => dialog.close());
  const changed = (_changes: object, area: string) => { if (area === "local") void refresh(); };
  const visibility = () => { if (document.visibilityState === "visible") void refresh(true); };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "/" && !dialog.open && !deleteDialog.open && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault(); search.focus();
    }
  };
  chrome.storage.onChanged.addListener(changed);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("keydown", keyboard);
  const ready = refresh(true);
  return { ready, refresh, dispose() { disposed = true; revision++; chrome.storage.onChanged.removeListener(changed); document.removeEventListener("visibilitychange", visibility); document.removeEventListener("keydown", keyboard); if (dialog.open) dialog.close(); if (deleteDialog.open) deleteDialog.close(); root.replaceChildren(); } };
}
