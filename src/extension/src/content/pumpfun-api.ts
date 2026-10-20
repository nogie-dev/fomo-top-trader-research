import { PumpFunSourceError, validatePumpFunApiRequest } from "../shared/pumpfun-api";
import type { PumpFunApiCancel, PumpFunApiMessage, PumpFunApiResponse, PumpFunProfilePing } from "../shared/pumpfun-api";

export function installPumpFunApiRelay(): () => void {
  const pending = new Map<string, { wallet: string; controller: AbortController }>();
  const controllers = new Set<AbortController>();
  const listener = (message: PumpFunApiMessage | PumpFunProfilePing | PumpFunApiCancel, sender: chrome.runtime.MessageSender, sendResponse: (value: PumpFunApiResponse | { ok: boolean }) => void) => {
    if (message?.type === "PUMP_FUN_API_CANCEL") {
      const request = pending.get(message.requestId);
      const allowed = sender.id === chrome.runtime.id && location.origin === "https://pump.fun" && request?.wallet === message.profileWallet;
      if (allowed) request.controller.abort(new Error("Pump.fun request cancelled"));
      sendResponse({ ok: allowed });
      return;
    }
    if (message?.type === "PUMP_FUN_PROFILE_PING") {
      sendResponse({ ok: sender.id === chrome.runtime.id && location.origin === "https://pump.fun"
        && [ `/profile/${message.profileWallet}`, `/profile/${message.profileWallet}/` ].includes(location.pathname) });
      return;
    }
    if (message?.type !== "PUMP_FUN_API_REQUEST") return;
    const run = async (): Promise<PumpFunApiResponse> => {
      const controller = new AbortController();
      const deadline = AbortSignal.timeout(30_000);
      const abort = () => controller.abort(deadline.reason);
      deadline.addEventListener("abort", abort, { once: true });
      try {
        if (sender.id !== chrome.runtime.id || location.origin !== "https://pump.fun"
          || location.pathname !== `/profile/${message.profileWallet}` && location.pathname !== `/profile/${message.profileWallet}/`) {
          throw new PumpFunSourceError("Pump.fun analysis tab changed or is unavailable. Open the profile and retry.");
        }
        const request = validatePumpFunApiRequest(message.request);
        if (message.requestId && (typeof message.requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.requestId) || pending.has(message.requestId))) throw new Error("Invalid Pump.fun request ID");
        controllers.add(controller);
        if (message.requestId) pending.set(message.requestId, { wallet: message.profileWallet, controller });
        const response = await fetch(request.url, {
          method: request.method, credentials: "include", redirect: "error",
          headers: { accept: "application/json", ...(request.body ? { "content-type": "application/json" } : {}) },
          ...(request.body ? { body: request.body } : {}), signal: controller.signal,
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "retry-after"]) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        return { ok: true, status: response.status, body, headers };
      } catch (error) {
        const detail = error && typeof error === "object" ? error as { message?: unknown; name?: unknown } : undefined;
        return { ok: false, error: typeof detail?.message === "string" ? detail.message : String(error),
          ...(typeof detail?.name === "string" ? { errorName: detail.name } : {}), ...(error instanceof PumpFunSourceError ? { sourceUnavailable: true } : {}) };
      } finally {
        deadline.removeEventListener("abort", abort);
        controllers.delete(controller);
        if (message.requestId && pending.get(message.requestId)?.controller === controller) pending.delete(message.requestId);
      }
    };
    void run().then(sendResponse);
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => { chrome.runtime.onMessage.removeListener(listener); controllers.forEach((controller) => controller.abort(new Error("Pump.fun relay stopped"))); pending.clear(); controllers.clear(); };
}
