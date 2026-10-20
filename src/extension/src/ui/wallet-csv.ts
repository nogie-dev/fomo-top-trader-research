import type { Callout } from "../shared/types";
import type { WalletPnl } from "../strategies/wallet-pnl";

const headers = [
  "wallet", "Handle", "handle_change", "is_pump_user", "follower", "following", "프로필 조회상태", "합산 pnl",
  "전체포트폴리오 pnl", "포트폴리오 실현손익", "미실현 손익", "포트폴리오 조회상태", "선택된 callouts 토큰들을 거래한 퍼센트",
];

function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null || typeof value === "number" && !Number.isFinite(value)) return "";
  // Nicknames are untrusted text; keep spreadsheet apps from interpreting them as formulas.
  const text = typeof value === "string" && /^\s*[=+\-@\t\r\n]/u.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createWalletCsv(wallets: readonly WalletPnl[], callouts: readonly Pick<Callout, "mint">[]): string {
  const mintCount = new Set(callouts.map(({ mint }) => mint)).size;
  const rows = wallets.map((wallet) => {
    const portfolio = wallet.portfolioPnl;
    return [
      wallet.wallet, wallet.username,
      wallet.usernameUpdate.status === "available" ? (wallet.usernameUpdate.lastUsernameUpdateTimestamp ?? 0) > 0 : null,
      wallet.isPumpUser, wallet.followers, wallet.following, wallet.profileStatus, wallet.totalRealizedPnlUsd,
      portfolio.status === "available" ? portfolio.totalPnlUsd : null,
      portfolio.status === "available" ? portfolio.realizedPnlUsd : null,
      portfolio.status === "available" ? portfolio.unrealizedPnlUsd : null,
      portfolio.status, mintCount ? wallet.tokenCount / mintCount * 100 : null,
    ];
  });
  // BOM preserves Korean headers in Excel; CRLF and quoting keep the file valid CSV.
  return "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
