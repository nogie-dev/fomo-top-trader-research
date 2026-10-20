import type { Callout, ProfileInput, Signature } from "../shared/types";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import type { AnalysisExecution } from "../shared/analysis-control";

export type AccountKey = string | { pubkey: string; signer?: boolean };
export type TokenBalance = {
  accountIndex?: number;
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};
export type ParsedInstruction = {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
  instructions?: ParsedInstruction[];
};
export type TransactionDetails = {
  slot?: number;
  blockTime: number | null;
  transaction?: {
    signatures?: string[];
    message?: { accountKeys?: AccountKey[]; instructions?: ParsedInstruction[] };
  };
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    logMessages?: string[] | null;
    innerInstructions?: { instructions?: ParsedInstruction[] }[];
  };
};
export type Activity = {
  callout: Callout;
  signature: Signature;
  transaction: TransactionDetails;
};
export type StrategyContext = {
  profile: ProfileInput;
  callouts: Callout[];
  stats: { rpcRequests: number; signatures: number; transactions: number };
  pumpFunFetch?: PumpFunFetch;
  execution?: AnalysisExecution;
};

export type PumpFunWalletPnl = {
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  amountHeld: number | null;
  feeUsd: number | null;
  hasTransfers: boolean | null;
  hasUntrustedUsdBasis: boolean | null;
};

export type PumpFunWalletProfile = {
  // 이전 snapshot에는 이 필드를 수집하지 않았으므로 없을 수 있다.
  username?: string | null;
  isPumpUser?: boolean | null;
  followers: number | null;
  following: number | null;
  // Pump.fun 화면의 Joined: 지갑 첫 거래 시각(first_tx_timestamp), ISO 8601.
  joined: string | null;
  profileStatus: "available" | "not-found" | "partial" | "error";
  profileFetchedAt: string;
  profileError?: string;
};

export type PumpFunUsernameUpdate = {
  status: "available" | "not-found" | "not-requested" | "error";
  // Unix milliseconds. null/0 has no recorded rename; unavailable statuses are unknown.
  lastUsernameUpdateTimestamp: number | null;
  fetchedAt: string | null;
  error?: string;
};

export type PumpFunPortfolioPnl = {
  status: "available" | "not-found" | "not-requested" | "error";
  scope: "pumpfun-portfolio";
  period: "all";
  from: string | null;
  to: string | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  totalValueUsd: number | null;
  tokenCount: number | null;
  missingPriceMints: string[] | null;
  evmAddress: string | null;
  computedAt: string | null;
  fetchedAt: string | null;
  error?: string;
};

export type CalloutWallet = PumpFunWalletPnl & PumpFunWalletProfile & {
  wallet: string;
  transactions: string[];
  lastSaleAt: string | null;
  status: "available" | "not-found" | "error";
  pnlFetchedAt: string;
  portfolioPnl?: PumpFunPortfolioPnl;
  error?: string;
};

export type CalloutWindowCoverage = {
  calloutId: string;
  at?: string;
  start: string | null;
  end: string | null;
  coverage: "complete" | "partial" | "open" | "invalid";
  signaturesScanned: number;
  confirmedSales: number;
  error?: string;
};

export type CalloutTokenResult = {
  mint: string;
  callouts: Callout[];
  creatorAddress: string | null;
  curveAddress: string | null;
  ammAddress: string | null;
  creatorCandidates: string[];
  poolAddresses: string[];
  wallets: CalloutWallet[];
  windows: CalloutWindowCoverage[];
  status: "complete" | "partial";
  metadataStatus: "available" | "not-found" | "error";
  metadataError?: string;
  pnlScope: "token-lifetime";
};

export type CalloutWindowStrategyResult = CalloutTokenResult[];
