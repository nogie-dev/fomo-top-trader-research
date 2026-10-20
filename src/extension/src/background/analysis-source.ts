import type { PumpFunProfilePing } from "../shared/pumpfun-api";

async function matches(tabId: number, profileWallet: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage<PumpFunProfilePing, { ok: boolean }>(tabId, { type: "PUMP_FUN_PROFILE_PING", profileWallet }, { frameId: 0 }).then((result) => result?.ok === true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function findAnalysisSource(profileWallet: string, preferredTabId?: number): Promise<{ tabId: number }> {
  if (preferredTabId !== undefined && await matches(preferredTabId, profileWallet)) return { tabId: preferredTabId };
  // Tab IDs can be queried without reading URLs or requesting the tabs permission.
  // Only this extension's content script can acknowledge the profile ping.
  const tabs = (await chrome.tabs.query({})).filter(({ id }) => id !== undefined && id !== preferredTabId);
  for (let offset = 0; offset < tabs.length; offset += 5) {
    const batch = tabs.slice(offset, offset + 5);
    const found = await Promise.all(batch.map(async ({ id }) => await matches(id!, profileWallet) ? id : undefined));
    const tabId = found.find((id) => id !== undefined);
    if (tabId !== undefined) return { tabId };
  }
  throw new Error("해당 Pump.fun 프로필을 탭에서 열고 새로고침한 뒤 이어가기를 눌러 주세요.");
}
