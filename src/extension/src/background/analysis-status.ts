import type { AnalysisIssue } from "../shared/types";
import type { CalloutWindowStrategyResult, PumpFunPortfolioPnl, PumpFunUsernameUpdate } from "../strategies/types";

export function analysisIssues(
  results: CalloutWindowStrategyResult,
  usernames: ReadonlyMap<string, PumpFunUsernameUpdate>,
  portfolios: ReadonlyMap<string, PumpFunPortfolioPnl>,
): AnalysisIssue[] {
  const issues = new Map<string, AnalysisIssue>();
  const add = (stage: AnalysisIssue["stage"], message: string) => {
    const key = JSON.stringify([stage, message]);
    const issue = issues.get(key) ?? { stage, message, count: 0 };
    issue.count++;
    issues.set(key, issue);
  };
  for (const token of results) {
    let foundIssue = false;
    const collection = (message: string) => { foundIssue = true; add("collection", message); };
    if (token.metadataStatus !== "available") collection(token.metadataError ?? "Pump.fun token metadata is unavailable");
    for (const window of token.windows) {
      if (window.coverage !== "complete") collection(window.error ?? `Callout window coverage is ${window.coverage}`);
    }
    for (const wallet of token.wallets) {
      if (wallet.status !== "available") collection(wallet.error ?? "Pump.fun token PnL is unavailable");
      if (wallet.profileStatus === "error" || wallet.profileStatus === "partial") {
        collection(wallet.profileError ?? "Pump.fun profile lookup is incomplete");
      }
    }
    if (token.status === "partial" && !foundIssue) collection("Callout collection is incomplete");
  }
  for (const username of usernames.values()) {
    if (username.status === "error") add("username", username.error ?? "Pump.fun username lookup failed");
  }
  for (const portfolio of portfolios.values()) {
    if (portfolio.status !== "available") add("portfolio", portfolio.error ?? "Pump.fun portfolio PnL is unavailable");
  }
  return [...issues.values()];
}
