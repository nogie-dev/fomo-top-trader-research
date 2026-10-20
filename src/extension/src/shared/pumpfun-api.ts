import { isSolanaAddress } from "./solana";

export type PumpFunRequestInit = RequestInit & { timeoutMs?: number };
export type PumpFunFetch = ((url: string | URL, init?: PumpFunRequestInit) => Promise<Response>) & { managesPacing?: boolean; managesTimeouts?: boolean };
export function requestPumpFun(request: PumpFunFetch, url: string | URL, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  return request.managesTimeouts ? request(url, { ...init, timeoutMs })
    : request(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
}
export type PumpFunApiRequest = { url: string; method: "GET" | "POST"; body?: string };
export type PumpFunApiMessage = { type: "PUMP_FUN_API_REQUEST"; profileWallet: string; request: PumpFunApiRequest; requestId?: string };
export type PumpFunProfilePing = { type: "PUMP_FUN_PROFILE_PING"; profileWallet: string };
export type PumpFunApiCancel = { type: "PUMP_FUN_API_CANCEL"; profileWallet: string; requestId: string };
export type PumpFunApiResponse =
  | { ok: true; status: number; body: string; headers: Record<string, string> }
  | { ok: false; error: string; errorName?: string; sourceUnavailable?: boolean };
export class PumpFunSourceError extends Error { readonly sourceUnavailable = true; }
export function isPumpFunSourceError(error: unknown): boolean { return Boolean(error && typeof error === "object" && "sourceUnavailable" in error && error.sourceUnavailable === true); }

// Only existing read endpoints may run in the tab. Do not expose arbitrary
// URLs, caller-supplied headers, account changes or transaction endpoints.
export function validatePumpFunApiRequest(value: unknown): PumpFunApiRequest {
  const invalid = (): never => { throw new Error("Unsupported Pump.fun API request"); };
  if (!value || typeof value !== "object") return invalid();
  const request = value as Partial<PumpFunApiRequest>;
  if (typeof request.url !== "string" || request.url.length > 8192 || !["GET", "POST"].includes(request.method ?? "")) return invalid();
  const url = new URL(request.url);
  if (url.username || url.password || url.hash || url.port) return invalid();
  const frontend = url.origin === "https://frontend-api-v3.pump.fun";
  const profile = url.origin === "https://profile-api.pump.fun";
  if (!frontend && !profile) return invalid();
  const segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const queryKeys: string[] = [];
  url.searchParams.forEach((_value, key) => queryKeys.push(key));
  const onlyQuery = (...keys: string[]) => queryKeys.every((key) => keys.includes(key))
    && keys.every((key) => url.searchParams.getAll(key).length <= 1);
  let allowed = false;
  if (request.method === "GET") {
    if (request.body !== undefined) return invalid();
    allowed = !url.search && (frontend && segments.length === 2 && ["coins-v2", "users"].includes(segments[0]) && isSolanaAddress(segments[1])
      || profile && segments.length === 5 && segments.slice(0, 3).join("/") === "v2/pnl/token" && segments.slice(3).every(isSolanaAddress));
    if (frontend && url.pathname === "/portfolio-summary") {
      allowed = onlyQuery("user", "period") && isSolanaAddress(url.searchParams.get("user") ?? "") && url.searchParams.get("period") === "all";
    }
    if (frontend && segments.length === 3 && segments[0] === "trades"
      && segments[1] === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && isSolanaAddress(segments[2])) {
      allowed = onlyQuery("limit", "cursor", "before") && url.searchParams.get("limit") === "100"
        && !(url.searchParams.has("cursor") && url.searchParams.has("before"));
    }
  } else {
    if (url.search || typeof request.body !== "string" || request.body.length > 16384) return invalid();
    const body: unknown = JSON.parse(request.body);
    const key = frontend && url.pathname === "/users/batch" ? "addresses"
      : profile && url.pathname === "/wallet-overview" ? "wallets"
      : profile && segments.length === 4 && segments[0] === "pnl" && segments[1] === "coin"
        && isSolanaAddress(segments[2]) && segments[3] === "holders" ? "holders" : null;
    if (!key || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) return invalid();
    const wallets = (body as Record<string, unknown>)[key];
    allowed = Array.isArray(wallets) && wallets.length > 0 && wallets.length <= (key === "addresses" ? 100 : 20)
      && wallets.every((wallet) => typeof wallet === "string" && isSolanaAddress(wallet));
  }
  if (!allowed) return invalid();
  return { url: url.href, method: request.method as "GET" | "POST", ...(request.body !== undefined ? { body: request.body } : {}) };
}
