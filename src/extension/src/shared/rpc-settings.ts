export const QUICKNODE_RPC_KEY = "walletResearch:quickNodeRpc:v1";
export const RPC_REQUIRED_MESSAGE = "팝업에서 QuickNode RPC 주소를 저장한 뒤 분석을 시작해 주세요.";

export function normalizeQuickNodeRpc(value: string): string {
  const address = value.trim();
  if (!address) return "";
  const invalid = () => new Error("https://로 시작하는 QuickNode RPC 주소(.quiknode.pro)를 입력해 주세요.");
  if (address.length > 8192) throw invalid();
  let url: URL;
  try { url = new URL(address); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || url.hostname !== "quiknode.pro" && !url.hostname.endsWith(".quiknode.pro")) throw invalid();
  return url.href;
}

export async function getQuickNodeRpcUrl(): Promise<string> {
  if (typeof chrome !== "undefined") {
    const value: unknown = (await chrome.storage.local.get(QUICKNODE_RPC_KEY))[QUICKNODE_RPC_KEY];
    if (value === undefined) return "";
    if (typeof value !== "string") throw new Error("저장된 QuickNode RPC 설정을 읽을 수 없습니다. 팝업에서 다시 저장해 주세요.");
    return normalizeQuickNodeRpc(value);
  }
  // CLI helpers and live tests use an environment variable, never a bundled key.
  const runtime = globalThis as { process?: { env?: { QUICKNODE_RPC?: string } } };
  return normalizeQuickNodeRpc(runtime.process?.env?.QUICKNODE_RPC ?? "");
}

export async function saveQuickNodeRpcUrl(value: string): Promise<string> {
  const address = normalizeQuickNodeRpc(value);
  if (address) await chrome.storage.local.set({ [QUICKNODE_RPC_KEY]: address });
  else await chrome.storage.local.remove(QUICKNODE_RPC_KEY);
  return address;
}
