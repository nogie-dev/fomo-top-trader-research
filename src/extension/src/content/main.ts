import type { AnalysisStarted, AnalyzeMessage, AnalyzeResult, Callout } from "../shared/types";
import { isSolanaAddress } from "../shared/solana";
import { readCalloutPage } from "./callouts";
import { installPumpFunApiRelay } from "./pumpfun-api";
import { waitForAnalysis } from "./analysis-status";

installPumpFunApiRelay();

const marker = "data-wallet-research-verify";
const dialogId = "wallet-research-callouts";
const achievementsSelector = '[data-testid="profile-header-achievements"], button[aria-label="Achievements"]';

function profileWallet(): string | null {
  const wallet = new URL(location.href).pathname.match(/^\/profile\/([^/]+)\/?$/)?.[1];
  return wallet && isSolanaAddress(wallet) ? wallet : null;
}

function mount(wallet: string, achievements: HTMLElement) {
  const controller = new AbortController();
  const history = new Map<string, Callout>();
  const selected = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken = "";
  let loaded = false;
  let loading = false;
  let sending = false;
  let loadError = false;
  let disposed = false;
  let analysisId: string | undefined;

  const button = document.createElement("button");
  button.type = "button";
  button.className = achievements.className;
  button.textContent = "verify";
  button.setAttribute(marker, "");
  button.setAttribute("aria-controls", dialogId);
  button.setAttribute("aria-expanded", "false");
  button.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:64px;height:36px;margin-right:8px;padding:0 12px;border:0;border-radius:6px;background:#2563eb;color:white;font-size:14px;font-weight:500;line-height:20px;cursor:pointer";
  achievements.insertAdjacentElement("beforebegin", button);

  const dialog = document.createElement("dialog");
  dialog.id = dialogId;
  dialog.setAttribute("aria-labelledby", `${dialogId}-title`);
  dialog.innerHTML = `
    <style>
      #${dialogId} { box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:85vh;padding:20px;border:1px solid #334155;border-radius:12px;background:#111827;color:#f8fafc;font:14px/1.5 system-ui;color-scheme:dark; }
      #${dialogId}::backdrop { background:#0009; }
      #${dialogId} h2 { margin:0;font-size:19px;font-weight:600; }
      #${dialogId} p { margin:10px 0;color:#cbd5e1; }
      #${dialogId} button { padding:7px 12px;border:1px solid #475569;border-radius:6px;background:#1e293b;color:#f8fafc;font:inherit;cursor:pointer; }
      #${dialogId} button:disabled { opacity:.45;cursor:default; }
      #${dialogId} [data-action="send"] { background:#2563eb;border-color:#2563eb; }
      #${dialogId} .research-toolbar { display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap; }
      #${dialogId} [data-wallet] { overflow-wrap:anywhere;font-size:12px; }
      #${dialogId} [data-callouts] { max-height:45vh;overflow:auto;margin:12px 0; }
      #${dialogId} .research-callout { display:flex;align-items:flex-start;gap:12px;padding:12px 4px;border-bottom:1px solid #334155;cursor:pointer; }
      #${dialogId} input { flex:none;width:17px;height:17px;margin-top:4px;accent-color:#3b82f6; }
      #${dialogId} .research-details { min-width:0; }
      #${dialogId} .research-details span, #${dialogId} time { display:block; }
      #${dialogId} .research-mint { font-size:11px;color:#94a3b8;overflow-wrap:anywhere; }
      #${dialogId} time { font-size:12px;color:#cbd5e1; }
      #${dialogId} [role="status"] { min-height:21px;margin:10px 0; }
    </style>
    <div class="research-toolbar"><h2 id="${dialogId}-title">Select callouts</h2><button type="button" data-action="close">Close</button></div>
    <p data-wallet></p>
    <p>Newest first. Check the callouts to analyze. Load more to select older callouts.</p>
    <p data-unsupported hidden></p>
    <div class="research-toolbar"><button type="button" data-action="select-all">Select all loaded</button><span data-selected-count></span></div>
    <div data-callouts></div>
    <button type="button" data-action="load-more" hidden>Load more</button>
    <p role="status" aria-live="polite"></p>
    <div class="research-toolbar"><button type="button" data-action="send" disabled>Send</button><button type="button" data-action="results" hidden>View results ↗</button></div>`;
  document.body.append(dialog);
  const list = dialog.querySelector<HTMLElement>("[data-callouts]")!;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const count = dialog.querySelector<HTMLElement>("[data-selected-count]")!;
  const unsupported = dialog.querySelector<HTMLElement>("[data-unsupported]")!;
  const selectAll = dialog.querySelector<HTMLButtonElement>('[data-action="select-all"]')!;
  const loadMore = dialog.querySelector<HTMLButtonElement>('[data-action="load-more"]')!;
  const send = dialog.querySelector<HTMLButtonElement>('[data-action="send"]')!;
  const results = dialog.querySelector<HTMLButtonElement>('[data-action="results"]')!;
  dialog.querySelector<HTMLElement>("[data-wallet]")!.textContent = wallet;
  const current = () => !disposed && profileWallet() === wallet;
  const sorted = () => [...history.values()].sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));

  function updateControls() {
    const selectable = [...history.values()].filter(({ mint }) => isSolanaAddress(mint));
    const unsupportedCount = history.size - selectable.length;
    unsupported.hidden = unsupportedCount === 0;
    unsupported.textContent = unsupportedCount ? `${unsupportedCount} EVM callouts are shown but cannot be analyzed. Only Solana tokens are supported.` : "";
    selectAll.disabled = !loaded || loading || sending || selectable.length === 0;
    selectAll.textContent = selectable.length > 0 && selected.size === selectable.length ? "Clear selection" : "Select all loaded";
    loadMore.disabled = loading || sending;
    loadMore.hidden = loaded ? !pageToken : !loadError;
    loadMore.textContent = loadError ? "Retry loading" : "Load more";
    send.disabled = !loaded || loading || sending || selected.size === 0;
    send.textContent = sending ? "Analyzing…" : "Send";
    results.disabled = !analysisId;
    count.textContent = `${selected.size} selected / ${history.size} loaded`;
    list.setAttribute("aria-busy", String(loading));
    list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
      input.checked = selected.has(input.value);
      input.disabled = !loaded || loading || sending || !isSolanaAddress(history.get(input.value)!.mint);
    });
  }

  function renderCallouts() {
    list.replaceChildren();
    for (const callout of sorted()) {
      const label = document.createElement("label");
      label.className = "research-callout";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = callout.sourceId!;
      checkbox.addEventListener("change", () => {
        if (!isSolanaAddress(callout.mint)) return;
        if (checkbox.checked) selected.add(checkbox.value);
        else selected.delete(checkbox.value);
        status.textContent = "";
        updateControls();
      });
      const details = document.createElement("span");
      details.className = "research-details";
      const token = document.createElement("span");
      token.textContent = [callout.tokenName, callout.symbol ? `(${callout.symbol})` : ""].filter(Boolean).join(" ") || callout.mint;
      const time = document.createElement("time");
      time.dateTime = callout.at!;
      time.textContent = `${new Date(callout.at!).toLocaleString()} (${callout.at})`;
      const mint = document.createElement("span");
      mint.className = "research-mint";
      mint.textContent = callout.mint;
      details.append(token, time, mint);
      if (!isSolanaAddress(callout.mint)) {
        const notice = document.createElement("span");
        notice.textContent = "EVM · analysis unavailable";
        details.append(notice);
      }
      label.append(checkbox, details);
      list.append(label);
    }
  }

  async function loadNextPage() {
    if (!current() || loading || sending || (loaded && !pageToken)) return;
    loading = true;
    loadError = false;
    status.textContent = "Loading callouts…";
    updateControls();
    try {
      const page = await readCalloutPage(wallet, pageToken, controller.signal);
      if (!current()) return;
      if (page.nextPageToken && seenPageTokens.has(page.nextPageToken)) throw new Error("Pump.fun returned a repeated page token.");
      if (page.nextPageToken) seenPageTokens.add(page.nextPageToken);
      for (const callout of page.callouts) {
        if (!history.has(callout.sourceId!)) history.set(callout.sourceId!, callout);
      }
      pageToken = page.nextPageToken;
      loaded = true;
      renderCallouts();
      status.textContent = history.size === 0 ? (pageToken ? "No callouts on this page. Load more to continue." : "No callouts found.") : `${history.size} callouts loaded.`;
    } catch (error) {
      if (!current()) return;
      loadError = true;
      status.textContent = error instanceof Error ? error.message : "Could not load callouts.";
    } finally {
      if (current()) {
        loading = false;
        updateControls();
      }
    }
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dialog.open) dialog.showModal();
    button.setAttribute("aria-expanded", "true");
    if (!loaded) void loadNextPage();
  });
  dialog.querySelector('[data-action="close"]')!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => button.setAttribute("aria-expanded", "false"));
  loadMore.addEventListener("click", () => void loadNextPage());
  selectAll.addEventListener("click", () => {
    const selectable = [...history.values()].filter(({ mint }) => isSolanaAddress(mint));
    if (selected.size === selectable.length) selected.clear();
    else selectable.forEach(({ sourceId }) => selected.add(sourceId!));
    status.textContent = "";
    updateControls();
  });
  results.addEventListener("click", async () => {
    if (!analysisId || !current()) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "OPEN_ANALYSIS_RESULTS", analysisId });
      if (!response?.ok) throw new Error(response?.message ?? "Could not open results.");
    } catch (error) { if (current()) status.textContent = error instanceof Error ? error.message : "Could not open results."; }
  });
  send.addEventListener("click", async () => {
    if (!current() || !loaded || loading || sending || selected.size === 0) return;
    const callouts = sorted().filter(({ sourceId, mint }) => selected.has(sourceId!) && isSolanaAddress(mint));
    sending = true;
    analysisId = undefined;
    results.hidden = true;
    status.textContent = `Analyzing ${callouts.length} callouts…`;
    updateControls();
    try {
      const request: AnalyzeMessage = { type: "ANALYZE_PROFILE", profile: { wallet, callouts } };
      let result = await chrome.runtime.sendMessage<AnalyzeMessage, AnalyzeResult | AnalysisStarted>(request);
      if (!current()) return;
      analysisId = result?.analysisId;
      results.hidden = !analysisId;
      if (result?.status === "running") {
        results.disabled = false;
        status.textContent = `Analyzing ${callouts.length} callouts… Keep this profile tab open. View results to check progress.`;
        result = await waitForAnalysis(result.analysisId, controller.signal, (phase) => {
          if (current()) status.textContent = ({ collecting: "Collecting sales and token PnL…", username: "Checking username history…", portfolio: "Loading portfolio reference data…", finished: "Finishing analysis…" })[phase];
        });
        if (!current()) return;
      }
      if (!result?.ok || result.status === "partial" || result.status === "failed") throw new Error(result?.message ?? "Analysis incomplete. Please retry.");
      status.textContent = result.status === "analyzed" ? `Complete. ${result.callouts} callouts analyzed.` : result.message ?? "RPC is not configured.";
    } catch (error) {
      if (current()) status.textContent = error instanceof Error ? error.message : "Background request failed.";
    } finally {
      if (current()) {
        sending = false;
        updateControls();
      }
    }
  });
  updateControls();
  return {
    wallet, achievements, button,
    dispose() {
      disposed = true;
      controller.abort();
      dialog.remove();
      button.remove();
    },
  };
}

let controls: ReturnType<typeof mount> | undefined;
let active = false;
let routeTimer: ReturnType<typeof setInterval> | undefined;
function syncProfile() {
  if (!active) return;
  const wallet = profileWallet();
  const achievements = wallet ? document.querySelector<HTMLElement>(achievementsSelector) : null;
  if (controls && (controls.wallet !== wallet || controls.achievements !== achievements || !controls.button.isConnected)) {
    controls.dispose();
    controls = undefined;
  }
  if (wallet && achievements && !controls) controls = mount(wallet, achievements);
}
const pageObserver = new MutationObserver(syncProfile);
function start() {
  if (active) return;
  active = true;
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  routeTimer = setInterval(syncProfile, 1000);
  syncProfile();
}
window.addEventListener("popstate", syncProfile);
window.addEventListener("pageshow", start);
window.addEventListener("pagehide", () => {
  active = false;
  pageObserver.disconnect();
  clearInterval(routeTimer);
  controls?.dispose();
  controls = undefined;
});
start();
