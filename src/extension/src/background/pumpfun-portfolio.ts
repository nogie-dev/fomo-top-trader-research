import { rethrowAnalysisStop } from "../shared/analysis-control";
import type { PumpFunPortfolioPnl } from "../strategies/types";
import type { WalletPnlStrategyResult } from "../strategies/wallet-pnl";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import { requestPumpFun } from "../shared/pumpfun-api";

const FRONTEND_API = "https://frontend-api-v3.pump.fun";

export function emptyPortfolioPnl(
  status: PumpFunPortfolioPnl["status"] = "not-requested",
  fetchedAt: string | null = null,
  error?: string,
): PumpFunPortfolioPnl {
  return {
    status, scope: "pumpfun-portfolio", period: "all",
    from: null, to: null, realizedPnlUsd: null, unrealizedPnlUsd: null, totalPnlUsd: null,
    totalValueUsd: null, tokenCount: null, missingPriceMints: null, evmAddress: null,
    computedAt: null, fetchedAt, ...(error ? { error } : {}),
  };
}

export function parsePumpFunPortfolioPnl(wallet: string, body: unknown, fetchedAt: string): PumpFunPortfolioPnl {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Unexpected Pump.fun portfolio response");
  const data = body as Record<string, unknown>;
  if (data.wallet !== wallet) throw new Error("Unexpected Pump.fun portfolio wallet");
  const number = (value: unknown): number | null => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid Pump.fun portfolio number");
    return value;
  };
  const usd = (key: string) => {
    const pair = data[key];
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) throw new Error(`Missing Pump.fun portfolio ${key}`);
    return number((pair as { usd?: unknown }).usd);
  };
  const timestamp = (value: unknown, multiplier: number): string => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid Pump.fun portfolio timestamp");
    const date = new Date(value * multiplier);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid Pump.fun portfolio timestamp");
    return date.toISOString();
  };
  const from = timestamp(data.from, 1000);
  const to = timestamp(data.to, 1000);
  if (from > to) throw new Error("Invalid Pump.fun portfolio range");
  const tokenCount = number(data.tokenCount ?? null);
  if (tokenCount !== null && (!Number.isSafeInteger(tokenCount) || tokenCount < 0)) throw new Error("Invalid Pump.fun portfolio token count");
  const missingPriceMints = data.missingPriceMints;
  if (missingPriceMints != null && (!Array.isArray(missingPriceMints) || missingPriceMints.some((mint) => typeof mint !== "string"))) {
    throw new Error("Invalid Pump.fun portfolio missing-price mints");
  }
  if (data.evmAddress != null && typeof data.evmAddress !== "string") throw new Error("Invalid Pump.fun portfolio EVM address");
  return {
    status: "available", scope: "pumpfun-portfolio", period: "all", from, to,
    realizedPnlUsd: usd("realizedPnl"), unrealizedPnlUsd: usd("unrealizedPnl"), totalPnlUsd: usd("pnl"),
    totalValueUsd: number(data.totalValueUsd ?? null), tokenCount,
    missingPriceMints: missingPriceMints == null ? null : [...missingPriceMints as string[]],
    evmAddress: data.evmAddress == null ? null : data.evmAddress as string,
    computedAt: data.computedAt == null ? null : timestamp(data.computedAt, 1), fetchedAt,
  };
}

// 후보 선별 후 호출한다. 기존 토큰/프로필 배치 조회에 지갑별 요청을 추가하지 않는다.
export async function getPumpFunWalletPortfolioPnls(wallets: string[], request: PumpFunFetch = fetch): Promise<Map<string, PumpFunPortfolioPnl>> {
  const results = new Map<string, PumpFunPortfolioPnl>();
  let blocked: string | undefined;
  let requested = false;
  for (const wallet of new Set(wallets)) {
    if (blocked) {
      results.set(wallet, emptyPortfolioPnl("error", null, blocked));
      continue;
    }
    if (requested && !request.managesPacing) await new Promise((resolve) => setTimeout(resolve, 200));
    requested = true;
    const url = new URL(`${FRONTEND_API}/portfolio-summary`);
    url.search = new URLSearchParams({ user: wallet, period: "all" }).toString();
    try {
      const response = await requestPumpFun(request, url, { headers: { accept: "application/json" } });
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers?.get("retry-after");
        blocked = `Pump.fun portfolio lookups paused after HTTP ${response.status}${retryAfter ? `; Retry-After: ${retryAfter}` : ""}`;
        throw new Error(blocked);
      }
      if (response.status === 404) results.set(wallet, emptyPortfolioPnl("not-found", new Date().toISOString()));
      else {
        if (!response.ok) throw new Error(`Pump.fun portfolio HTTP ${response.status}`);
        results.set(wallet, parsePumpFunPortfolioPnl(wallet, await response.json(), new Date().toISOString()));
      }
    } catch (error) { rethrowAnalysisStop(error);
      results.set(wallet, emptyPortfolioPnl("error", new Date().toISOString(), error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}

export async function enrichWalletPortfolioPnl(result: WalletPnlStrategyResult): Promise<WalletPnlStrategyResult> {
  const portfolios = await getPumpFunWalletPortfolioPnls(result.wallets.map(({ wallet }) => wallet));
  return {
    ...result,
    wallets: result.wallets.map((wallet) => ({ ...wallet, portfolioPnl: portfolios.get(wallet.wallet)! })),
  };
}
