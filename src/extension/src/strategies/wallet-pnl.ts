import { emptyPortfolioPnl } from "../background/pumpfun-portfolio";
import { emptyUsernameUpdate } from "../background/pumpfun-username";
import type { CalloutTokenResult, CalloutWallet, CalloutWindowStrategyResult, PumpFunPortfolioPnl, PumpFunUsernameUpdate, PumpFunWalletProfile } from "./types";

export type WalletPnlOptions = {
  excludeFollowersAtLeast?: number;
  // API에 유효한 양수의 닉네임 변경 시각이 확인된 지갑만 제외한다.
  excludeRenamedWallets?: boolean;
  minTokenCount?: number;
  positiveRealizedPnlOnly?: boolean;
  positivePortfolioPnlOnly?: boolean;
};

export type WalletTokenPnl = Pick<CalloutWallet,
  "status" | "realizedPnlUsd" | "pnlFetchedAt" | "hasTransfers" | "hasUntrustedUsdBasis" | "error"
> & {
  mint: string;
  tokenName?: string;
  symbol?: string;
};

export type WalletPnl = PumpFunWalletProfile & {
  wallet: string;
  displayName: string;
  tokens: WalletTokenPnl[];
  tokenCount: number;
  totalRealizedPnlUsd: number | null;
  realizedPnlStatus: "complete" | "partial" | "unavailable";
  portfolioPnl: PumpFunPortfolioPnl;
  usernameUpdate: PumpFunUsernameUpdate;
};

export type WalletPnlStrategyResult = {
  id: "wallet-pnl";
  pnlScope: "selected-tokens-lifetime";
  filters: {
    excludeFollowersAtLeast: number | null;
    excludeRenamedWallets: boolean;
    minTokenCount: number;
    positiveRealizedPnlOnly: boolean;
    positivePortfolioPnlOnly: boolean;
  };
  walletCountBefore: number;
  walletCountAfter: number;
  excludedWallets: { wallet: string; reasons: ("followers" | "username-change" | "token-count" | "realized-pnl" | "portfolio-pnl")[] }[];
  wallets: WalletPnl[];
};

function newer(candidate: string, current: string): boolean {
  const candidateAt = Date.parse(candidate);
  const currentAt = Date.parse(current);
  return Number.isFinite(candidateAt) && (!Number.isFinite(currentAt) || candidateAt > currentAt);
}

function tokenPnl(token: CalloutTokenResult, wallet: CalloutWallet): WalletTokenPnl {
  const realized = wallet.realizedPnlUsd;
  return {
    mint: token.mint,
    tokenName: token.callouts.find((callout) => callout.tokenName)?.tokenName,
    symbol: token.callouts.find((callout) => callout.symbol)?.symbol,
    status: wallet.status,
    realizedPnlUsd: wallet.status === "available" && typeof realized === "number" && Number.isFinite(realized) ? realized : null,
    pnlFetchedAt: wallet.pnlFetchedAt,
    hasTransfers: wallet.hasTransfers,
    hasUntrustedUsdBasis: wallet.hasUntrustedUsdBasis,
    ...(wallet.error ? { error: wallet.error } : {}),
  };
}

// API 요청 없이 callout-window 결과에 포함된 토큰의 lifetime 실현손익만 합산한다.
export function verify(
  results: CalloutWindowStrategyResult,
  options: WalletPnlOptions = {},
  portfolioPnls: ReadonlyMap<string, PumpFunPortfolioPnl> = new Map(),
  usernameUpdates: ReadonlyMap<string, PumpFunUsernameUpdate> = new Map(),
): WalletPnlStrategyResult {
  const cutoff = options.excludeFollowersAtLeast;
  if (cutoff !== undefined && (!Number.isSafeInteger(cutoff) || cutoff < 0)) {
    throw new Error("excludeFollowersAtLeast must be a non-negative integer");
  }
  const minTokenCount = options.minTokenCount ?? 1;
  if (!Number.isSafeInteger(minTokenCount) || minTokenCount < 1) {
    throw new Error("minTokenCount must be a positive integer");
  }
  const grouped = new Map<string, { profile: CalloutWallet; tokens: Map<string, WalletTokenPnl> }>();
  for (const token of results) {
    for (const wallet of token.wallets) {
      const group = grouped.get(wallet.wallet) ?? { profile: wallet, tokens: new Map<string, WalletTokenPnl>() };
      if (newer(wallet.profileFetchedAt, group.profile.profileFetchedAt)) group.profile = wallet;
      const previous = group.tokens.get(token.mint);
      // 같은 mint가 여러 번 입력되어도 lifetime PnL을 중복 합산하지 않는다.
      if (!previous || newer(wallet.pnlFetchedAt, previous.pnlFetchedAt)) group.tokens.set(token.mint, tokenPnl(token, wallet));
      grouped.set(wallet.wallet, group);
    }
  }

  const wallets: WalletPnl[] = [];
  const excludedWallets: WalletPnlStrategyResult["excludedWallets"] = [];
  for (const [wallet, group] of grouped) {
    const profile = group.profile;
    const username = profile.username?.trim();
    const named = Boolean(username && username !== wallet);
    const tokens = [...group.tokens.values()];
    const known = tokens.filter((token) => token.realizedPnlUsd !== null);
    const totalRealizedPnlUsd = known.length ? known.reduce((sum, token) => sum + token.realizedPnlUsd!, 0) : null;
    const realizedPnlStatus = known.length === tokens.length ? "complete" : known.length ? "partial" : "unavailable";
    const portfolioPnl = portfolioPnls.get(wallet) ?? profile.portfolioPnl ?? emptyPortfolioPnl();
    const usernameUpdate = usernameUpdates.get(wallet) ?? emptyUsernameUpdate();
    const renamedAt = usernameUpdate.lastUsernameUpdateTimestamp;
    const reasons: WalletPnlStrategyResult["excludedWallets"][number]["reasons"] = [];
    if (cutoff !== undefined && profile.followers !== null && profile.followers >= cutoff) reasons.push("followers");
    if (options.excludeRenamedWallets && usernameUpdate.status === "available" && typeof renamedAt === "number"
      && Number.isSafeInteger(renamedAt) && renamedAt > 0 && Number.isFinite(new Date(renamedAt).getTime())) reasons.push("username-change");
    if (tokens.length < minTokenCount) reasons.push("token-count");
    // 일부 토큰의 실현손익이 없으면 합산 양수 여부를 확정하지 않는다.
    if (options.positiveRealizedPnlOnly && (realizedPnlStatus !== "complete" || totalRealizedPnlUsd === null || totalRealizedPnlUsd <= 0)) reasons.push("realized-pnl");
    if (options.positivePortfolioPnlOnly && (portfolioPnl.status !== "available"
      || portfolioPnl.totalPnlUsd === null || !Number.isFinite(portfolioPnl.totalPnlUsd) || portfolioPnl.totalPnlUsd <= 0)) reasons.push("portfolio-pnl");
    if (reasons.length) {
      excludedWallets.push({ wallet, reasons });
      continue;
    }

    wallets.push({
      wallet, displayName: named ? username! : wallet,
      ...(profile.username !== undefined ? { username: username || null } : {}),
      isPumpUser: profile.isPumpUser ?? null,
      followers: profile.followers, following: profile.following, joined: profile.joined,
      profileStatus: profile.profileStatus, profileFetchedAt: profile.profileFetchedAt,
      ...(profile.profileError ? { profileError: profile.profileError } : {}),
      tokens, tokenCount: tokens.length,
      totalRealizedPnlUsd, realizedPnlStatus,
      portfolioPnl, usernameUpdate,
    });
  }
  wallets.sort((a, b) => {
    if (a.totalRealizedPnlUsd === null) return b.totalRealizedPnlUsd === null ? a.wallet.localeCompare(b.wallet) : 1;
    if (b.totalRealizedPnlUsd === null) return -1;
    return b.totalRealizedPnlUsd - a.totalRealizedPnlUsd || a.wallet.localeCompare(b.wallet);
  });

  return {
    id: "wallet-pnl", pnlScope: "selected-tokens-lifetime",
    filters: {
      excludeFollowersAtLeast: cutoff ?? null, excludeRenamedWallets: options.excludeRenamedWallets ?? false,
      minTokenCount, positiveRealizedPnlOnly: options.positiveRealizedPnlOnly ?? false,
      positivePortfolioPnlOnly: options.positivePortfolioPnlOnly ?? false,
    },
    walletCountBefore: grouped.size, walletCountAfter: wallets.length, wallets, excludedWallets,
  };
}
