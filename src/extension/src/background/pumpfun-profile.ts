import { rethrowAnalysisStop } from "../shared/analysis-control";
import type { PumpFunWalletProfile } from "../strategies/types";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import { requestPumpFun } from "../shared/pumpfun-api";

const FRONTEND_API = "https://frontend-api-v3.pump.fun";
const PROFILE_API = "https://profile-api.pump.fun";
type ProfileRateLimit = { retryAt: number; message: string };
const PROFILE_RATE_LIMITS = new Map<string, ProfileRateLimit>();

export async function getPumpFunWalletProfiles(
  wallets: string[],
  rateLimits: Map<string, ProfileRateLimit> = PROFILE_RATE_LIMITS,
  fetchApi: PumpFunFetch = fetch,
): Promise<Map<string, PumpFunWalletProfile>> {
  const unique = [...new Set(wallets)];
  const states = new Map(unique.map((wallet) => [wallet, {
    profile: {
      username: null, isPumpUser: null, followers: null, following: null, joined: null,
      profileStatus: "not-found", profileFetchedAt: "",
    } as PumpFunWalletProfile,
    found: false, successes: 0, errors: [] as string[],
  }]));
  let nextRequestAt = 0;
  const request = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const origin = new URL(url).origin;
    const checkRateLimit = () => {
      const limit = rateLimits.get(origin);
      if (limit && limit.retryAt > Date.now()) throw new Error(limit.message);
      if (limit) rateLimits.delete(origin);
    };
    checkRateLimit();
    const scheduledAt = Math.max(Date.now(), nextRequestAt);
    nextRequestAt = scheduledAt + 200;
    if (scheduledAt > Date.now() && !fetchApi.managesPacing) await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now()));
    checkRateLimit();
    // The live five-callout recheck included valid overview responses taking
    // 15–24 seconds; other profile reads retain their existing deadline.
    const timeoutMs = new URL(url).pathname === "/wallet-overview" ? 30_000 : 15_000;
    const response = await requestPumpFun(fetchApi, url, init, timeoutMs);
    if (response.status === 429) {
      const retryAfter = response.headers?.get("retry-after");
      const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
      const date = retryAfter ? Date.parse(retryAfter) : NaN;
      const retryAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000
        : Number.isFinite(date) ? date : Date.now() + 60_000;
      const message = `Pump.fun profile requests paused after HTTP 429${retryAfter ? `; Retry-After: ${retryAfter}` : ""}`;
      rateLimits.set(origin, { retryAt: Math.max(Date.now() + 1000, retryAt), message });
      throw new Error(message);
    }
    return response;
  };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const count = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Pump.fun follow count");
    return value;
  };

  const loadUsers = async () => {
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      try {
        const response = await request(`${FRONTEND_API}/users/batch`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: batch }),
        });
        if (!response.ok) throw new Error(`Pump.fun users HTTP ${response.status}`);
        const body = await response.json() as unknown;
        const rows = Array.isArray(body) ? body : (body as { users?: unknown } | null)?.users;
        if (!Array.isArray(rows)) throw new Error("Unexpected Pump.fun users response");
        for (const wallet of batch) {
          const state = states.get(wallet)!;
          const row = rows.find((value) => value?.address === wallet);
          try {
            if (row) {
              state.profile.followers = count(row.followers);
              state.profile.following = count(row.following);
              if (row.username != null && typeof row.username !== "string") throw new Error("Invalid Pump.fun username");
              state.profile.username = row.username?.trim() || null;
              if (row.is_pump_user != null && typeof row.is_pump_user !== "boolean") throw new Error("Invalid Pump.fun user flag");
              state.profile.isPumpUser = row.is_pump_user ?? null;
              state.found = true;
            }
            state.successes++;
          } catch (error) { rethrowAnalysisStop(error); state.errors.push(message(error)); }
        }
      } catch (error) { rethrowAnalysisStop(error);
        for (const wallet of batch) states.get(wallet)!.errors.push(message(error));
      }
    }
  };

  const loadJoined = async () => {
    for (let offset = 0; offset < unique.length; offset += 20) {
      const batch = unique.slice(offset, offset + 20);
      try {
        const response = await request(`${PROFILE_API}/wallet-overview`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallets: batch }),
        });
        if (!response.ok) throw new Error(`Pump.fun wallet-overview HTTP ${response.status}`);
        const body = await response.json() as { wallets?: Record<string, { first_tx_timestamp?: number | null } | null> } | null;
        if (!body?.wallets || typeof body.wallets !== "object" || Array.isArray(body.wallets)) throw new Error("Unexpected Pump.fun wallet-overview response");
        for (const wallet of batch) {
          const state = states.get(wallet)!;
          try {
            if (!Object.hasOwn(body.wallets, wallet)) throw new Error("Pump.fun wallet-overview did not return the wallet");
            const seconds = body.wallets[wallet]?.first_tx_timestamp;
            if (seconds != null && seconds !== 0) {
              if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid Pump.fun first transaction timestamp");
              const date = new Date(seconds * 1000);
              if (!Number.isFinite(date.getTime())) throw new Error("Invalid Pump.fun first transaction timestamp");
              state.profile.joined = date.toISOString();
            }
            state.successes++;
          } catch (error) { rethrowAnalysisStop(error); state.errors.push(message(error)); }
        }
      } catch (error) { rethrowAnalysisStop(error);
        for (const wallet of batch) states.get(wallet)!.errors.push(message(error));
      }
    }
  };

  await Promise.all([loadUsers(), loadJoined()]);

  return new Map(unique.map((wallet) => {
    const state = states.get(wallet)!;
    state.profile.profileStatus = state.errors.length ? (state.successes ? "partial" : "error") : state.found ? "available" : "not-found";
    state.profile.profileFetchedAt = new Date().toISOString();
    if (state.errors.length) state.profile.profileError = [...new Set(state.errors)].join("; ");
    return [wallet, state.profile];
  }));
}
