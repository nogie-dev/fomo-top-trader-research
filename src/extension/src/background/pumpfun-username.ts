import { rethrowAnalysisStop } from "../shared/analysis-control";
import type { PumpFunUsernameUpdate } from "../strategies/types";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import { requestPumpFun } from "../shared/pumpfun-api";

const FRONTEND_API = "https://frontend-api-v3.pump.fun";

export function emptyUsernameUpdate(
  status: PumpFunUsernameUpdate["status"] = "not-requested",
  fetchedAt: string | null = null,
  error?: string,
): PumpFunUsernameUpdate {
  return { status, lastUsernameUpdateTimestamp: null, fetchedAt, ...(error ? { error } : {}) };
}

export function parsePumpFunUsernameUpdate(wallet: string, body: unknown, fetchedAt: string): PumpFunUsernameUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Unexpected Pump.fun username response");
  const row = body as Record<string, unknown>;
  if (row.address !== wallet) throw new Error("Unexpected Pump.fun username wallet");
  // Batch reads omit this field: missing must not be mistaken for an explicit null.
  if (!Object.hasOwn(row, "last_username_update_timestamp")) throw new Error("Pump.fun username change timestamp is missing");
  const value = row.last_username_update_timestamp;
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
    || !Number.isFinite(new Date(value).getTime()))) throw new Error("Invalid Pump.fun username change timestamp");
  return { status: "available", lastUsernameUpdateTimestamp: value as number | null, fetchedAt };
}

// Only request candidates surviving the follower, token-count and realized-PnL filters.
// GET /users/{wallet} carries the rename timestamp that POST /users/batch omits.
export async function getPumpFunWalletUsernameUpdates(wallets: string[], request: PumpFunFetch = fetch): Promise<Map<string, PumpFunUsernameUpdate>> {
  const results = new Map<string, PumpFunUsernameUpdate>();
  let blocked: string | undefined;
  let requested = false;
  for (const wallet of new Set(wallets)) {
    if (blocked) {
      results.set(wallet, emptyUsernameUpdate("error", null, blocked));
      continue;
    }
    if (requested && !request.managesPacing) await new Promise((resolve) => setTimeout(resolve, 200));
    requested = true;
    try {
      const url = `${FRONTEND_API}/users/${encodeURIComponent(wallet)}`;
      const response = await requestPumpFun(request, url, { headers: { accept: "application/json" } });
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers?.get("retry-after");
        blocked = `Pump.fun username lookups paused after HTTP ${response.status}${retryAfter ? `; Retry-After: ${retryAfter}` : ""}`;
        throw new Error(blocked);
      }
      if (response.status === 404) results.set(wallet, emptyUsernameUpdate("not-found", new Date().toISOString()));
      else {
        if (!response.ok) throw new Error(`Pump.fun username HTTP ${response.status}`);
        results.set(wallet, parsePumpFunUsernameUpdate(wallet, await response.json(), new Date().toISOString()));
      }
    } catch (error) { rethrowAnalysisStop(error);
      results.set(wallet, emptyUsernameUpdate("error", new Date().toISOString(), error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}
