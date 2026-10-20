import { PumpFunSourceError, validatePumpFunApiRequest } from "../shared/pumpfun-api";
import type { PumpFunApiCancel, PumpFunApiMessage, PumpFunApiResponse, PumpFunFetch } from "../shared/pumpfun-api";

export function createPumpFunTabFetch(tabId: number, profileWallet: string, documentId?: string): PumpFunFetch {
  return async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const requestId = init.signal ? crypto.randomUUID() : undefined;
    const target = documentId ? { documentId } : { frameId: 0 };
    const request = validatePumpFunApiRequest({ url: String(url), method: init.method ?? "GET", ...(init.body !== undefined ? { body: init.body } : {}) });
    const pending = chrome.tabs.sendMessage<PumpFunApiMessage, PumpFunApiResponse>(tabId, {
      type: "PUMP_FUN_API_REQUEST", profileWallet, request, ...(requestId ? { requestId } : {}),
    }, target);
    const response = await new Promise<PumpFunApiResponse>((resolve, reject) => {
      const signal = init.signal;
      const abort = () => {
        if (requestId) void chrome.tabs.sendMessage<PumpFunApiCancel>(tabId, { type: "PUMP_FUN_API_CANCEL", profileWallet, requestId }, target).catch(() => {});
        reject(signal?.reason ?? new Error("Pump.fun request aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      pending.then(resolve, (error: unknown) => reject(new PumpFunSourceError(error instanceof Error ? error.message : "Pump.fun profile tab is unavailable")))
        .finally(() => signal?.removeEventListener("abort", abort));
    });
    if (!response?.ok) {
      const message = response?.error ?? "Pump.fun page request failed. Reload the profile and retry.";
      throw !response || response.sourceUnavailable ? new PumpFunSourceError(message) : Object.assign(new Error(message), { name: response.errorName ?? "Error" });
    }
    return new Response(response.body || null, { status: response.status, headers: response.headers });
  };
}
