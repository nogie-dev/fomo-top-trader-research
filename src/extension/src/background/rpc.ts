import { getQuickNodeRpcUrl, RPC_REQUIRED_MESSAGE } from "../shared/rpc-settings";
import type { TransactionDetails } from "../strategies/types";
import type { AnalysisExecution } from "../shared/analysis-control";
import { isTransientHttpStatus, isTransientRequestError, retryDelayMs } from "../shared/request-errors";

export type AddressTransaction = {
  slot: number;
  blockTime: number | null;
  transaction?: NonNullable<TransactionDetails["transaction"]>;
  meta?: NonNullable<TransactionDetails["meta"]> | null;
};

export type AddressTransactionPage = {
  data: AddressTransaction[];
  paginationToken?: string | null;
};

let nextRequestAt = 0;

export async function getAccountOwners(addresses: string[], execution?: AnalysisExecution): Promise<Map<string, string | null>> {
  const unique = [...new Set(addresses)];
  const owners = new Map<string, string | null>();

  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const key = `owners:${batch.join(":")}`;
    const cached = await execution?.load<{ value: ({ owner: string } | null)[] }>(key);
    const result = cached ?? await request<{ value: ({ owner: string } | null)[] }>({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [batch, { commitment: "finalized", encoding: "base64" }],
    }, execution);
    if (execution && !cached) await execution.commit([{ key, value: result }]);
    batch.forEach((address, index) => owners.set(address, result.value[index]?.owner ?? null));
  }

  return owners;
}

async function request<T>(body: Record<string, unknown>, execution?: AnalysisExecution): Promise<T> {
  const rpcUrl = execution?.rpcUrl ?? await getQuickNodeRpcUrl();
  if (!rpcUrl) throw new Error(RPC_REQUIRED_MESSAGE);
  const redact = (message: string) => message.replaceAll(rpcUrl, "[QuickNode RPC]");

  const method = typeof body.method === "string" ? body.method : "RPC";
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextRequestAt);
    nextRequestAt = scheduledAt + 100;
    if (scheduledAt > now) await (execution ? execution.wait(scheduledAt - now) : new Promise((resolve) => setTimeout(resolve, scheduledAt - now)));

    const timeout = AbortSignal.timeout(25_000);
    const perform = async (signal: AbortSignal) => {
      try {
        const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
        if (!response.ok && isTransientHttpStatus(response.status)) {
          const retryAfter = response.headers.get("retry-after");
          await response.body?.cancel();
          return { retryAfter, error: `QuickNode ${method} HTTP ${response.status}` };
        }
        if (!response.ok) {
          const detail = redact((await response.text()).trim()).slice(0, 300);
          throw new Error(`QuickNode ${method} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
        }
        const result = await response.json() as { result?: T; error?: { code?: number | string; message?: string } };
        if (result.error) throw new Error(`QuickNode ${method}${result.error.code ? ` (${result.error.code})` : ""}: ${result.error.message ?? "RPC failed"}`);
        if (result.result === undefined) throw new Error("Unexpected QuickNode response");
        return { result: result.result };
      } catch (error) {
        execution?.check();
        const message = redact(timeout.aborted ? `QuickNode ${method} timed out after 25 seconds. Retry the analysis.` : error instanceof Error ? error.message : String(error));
        if (execution && (timeout.aborted || isTransientRequestError(error))) return { retryAfter: null, error: message };
        if (timeout.aborted) throw new Error(message);
        throw new Error(message);
      }
    };
    const outcome = execution ? await execution.request(perform, timeout) : await perform(timeout);
    if ("result" in outcome) { if (execution) execution.stats.rpcRequests++; return outcome.result as T; }
    if (attempt >= 4) {
      if (execution) execution.pause(outcome.error!);
      throw new Error(outcome.error);
    }
    const wait = retryDelayMs(outcome.retryAfter ?? null, attempt);
    await (execution ? execution.wait(wait) : new Promise((resolve) => setTimeout(resolve, wait)));
  }
}

export function getTransactionsForAddress(
  address: string,
  start: number,
  end: number,
  limit: number,
  paginationToken?: string,
  sortOrder: "asc" | "desc" = "desc",
  execution?: AnalysisExecution,
): Promise<AddressTransactionPage> {
  const filters: Record<string, unknown> = {
    blockTime: { gte: start, lt: end },
    status: "succeeded",
  };

  return request({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransactionsForAddress",
    params: [address, {
      transactionDetails: "full",
      sortOrder,
      limit,
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 1,
      ...(paginationToken ? { paginationToken } : {}),
      filters,
    }],
  }, execution);
}
