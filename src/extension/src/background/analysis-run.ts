import { AnalysisStopped, DEFAULT_ANALYSIS_BUDGET } from "../shared/analysis-control";
import type { AnalysisBudget, AnalysisExecution, AnalysisExecutionInfo, AnalysisPosition, AnalysisStats, CheckpointEntry, CheckpointStore } from "../shared/analysis-control";
import type { PumpFunFetch } from "../shared/pumpfun-api";
import { isPumpFunSourceError } from "../shared/pumpfun-api";
import { isTransientHttpStatus, isTransientRequestError, retryDelayMs, withRequestTimeout } from "../shared/request-errors";

type RunCheckpoint = { version: 1; stats: AnalysisStats; totalRequests: number; position?: AnalysisPosition };
const RUN_KEY = "$run";

export class AnalysisRun implements AnalysisExecution {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly stats: AnalysisStats;
  readonly startedAt = Date.now();
  private timer?: ReturnType<typeof setTimeout>;
  private requests = 0;
  private totalRequests: number;
  private position?: AnalysisPosition;
  private nextPumpRequestAt = 0;
  private pumpQueue: Promise<unknown> = Promise.resolve();
  onCheckpoint?: () => Promise<void>;

  private constructor(readonly id: string, private store: CheckpointStore, readonly budget: AnalysisBudget, state?: RunCheckpoint, readonly rpcUrl?: string) {
    this.stats = state?.stats ?? { rpcRequests: 0, signatures: 0, transactions: 0 };
    this.totalRequests = state?.totalRequests ?? 0;
    this.position = state?.position;
    if (budget.maxDurationMs !== null) this.timer = setTimeout(() => this.stop("time"), budget.maxDurationMs);
  }
  static async create(id: string, store: CheckpointStore, budget: AnalysisBudget = DEFAULT_ANALYSIS_BUDGET, resume = false, rpcUrl?: string): Promise<AnalysisRun> {
    if ([budget.maxRequests, budget.maxDurationMs].some((limit) => limit !== null && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error("올바르지 않은 분석 예산입니다.");
    const state = await store.read<RunCheckpoint>(id, RUN_KEY);
    if (resume && state?.version !== 1) throw new Error("중간 저장 데이터를 찾을 수 없습니다. 새 분석을 실행해 주세요.");
    const run = new AnalysisRun(id, store, { ...budget }, state, rpcUrl);
    try { if (!state) await run.commit([]); return run; }
    catch (error) { run.dispose(); throw error; }
  }
  private stop(reason: "requests" | "time" | "storage" | "source" | "network", detail?: string): void {
    if (this.signal.aborted) return;
    const message = reason === "requests" ? `실행당 요청 ${this.budget.maxRequests}회 예산에 도달해 일시정지했습니다. 이어가기를 눌러 계속할 수 있습니다.`
      : reason === "time" ? `실행 시간 예산(${Math.round(this.budget.maxDurationMs! / 1000)}초)에 도달해 일시정지했습니다. 이어가기를 눌러 계속할 수 있습니다.`
      : reason === "source" ? "Pump.fun 프로필 탭 연결이 끊겨 일시정지했습니다. 해당 프로필을 열고 새로고침한 뒤 이어가기를 눌러 주세요."
      : reason === "network" ? `네트워크 요청이 반복해서 실패해 일시정지했습니다.${detail ? ` ${detail}` : ""} 잠시 후 이어가기를 누르면 실패한 요청부터 다시 시도합니다.`
      : `중간 데이터를 저장하거나 읽지 못해 일시정지했습니다.${detail ? ` ${detail}` : ""}`;
    this.controller.abort(new AnalysisStopped("paused", reason, message));
  }
  cancel(): void { if (!this.signal.aborted) this.controller.abort(new AnalysisStopped("cancelled", undefined, "분석을 취소했습니다.")); }
  pause(message: string): never { this.stop("network", message); throw this.signal.reason; }
  check(): void {
    if (!this.signal.aborted && this.budget.maxDurationMs !== null && Date.now() - this.startedAt >= this.budget.maxDurationMs) this.stop("time");
    if (this.signal.aborted) throw this.signal.reason;
  }
  info(resumable = true): AnalysisExecutionInfo {
    return { resumable, budget: this.budget, runRequests: this.requests, totalRequests: this.totalRequests, elapsedMs: Date.now() - this.startedAt,
      ...(this.position ? { position: this.position } : {}), ...(this.signal.reason?.reason ? { pauseReason: this.signal.reason.reason } : {}) };
  }
  async load<T>(key: string): Promise<T | undefined> {
    this.check();
    try { return await this.store.read<T>(this.id, key); }
    catch (error) { this.stop("storage", error instanceof Error ? error.message : undefined); this.check(); throw error; }
  }
  async commit(entries: readonly CheckpointEntry[], position?: AnalysisPosition): Promise<void> {
    this.check();
    const nextPosition = position ?? this.position;
    try {
      await this.store.write(this.id, [...entries, { key: RUN_KEY, value: { version: 1, stats: this.stats, totalRequests: this.totalRequests, ...(nextPosition ? { position: nextPosition } : {}) } satisfies RunCheckpoint }]);
      this.position = nextPosition;
      await this.onCheckpoint?.();
    } catch (error) { this.stop("storage", error instanceof Error ? error.message : undefined); this.check(); throw error; }
    this.check();
  }
  async request<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.check();
    signal?.throwIfAborted();
    if (this.budget.maxRequests !== null && this.requests >= this.budget.maxRequests) { this.stop("requests"); this.check(); }
    this.requests++; this.totalRequests++;
    const controller = new AbortController();
    const abort = () => controller.abort(this.signal.aborted ? this.signal.reason : signal?.reason);
    this.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted || signal?.aborted) abort();
    try { const result = await operation(controller.signal); this.check(); return result; }
    catch (error) { this.check(); throw error; }
    finally { this.signal.removeEventListener("abort", abort); signal?.removeEventListener("abort", abort); }
  }
  async wait(milliseconds: number): Promise<void> {
    this.check();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(this.signal.reason); };
      const timer = setTimeout(() => { this.signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    this.check();
  }
  wrapPumpFunFetch(request: PumpFunFetch): PumpFunFetch {
    const perform: PumpFunFetch = async (url, init = {}) => {
      this.check();
      init.signal?.throwIfAborted();
      // Trade pages are checkpointed as confirmed matches, never as raw tapes.
      const cacheable = !new URL(url).pathname.startsWith("/trades/");
      const digest = cacheable ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([String(url), init.method ?? "GET", init.body ?? ""]))) : null;
      const key = digest ? `api:${Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("")}` : "";
      type Cached = { status: number; body: string; headers: Record<string, string> } | { error: string };
      const cached = cacheable ? await this.load<Cached>(key) : undefined;
      if (cached && !("error" in cached ? isTransientRequestError(cached.error) : isTransientHttpStatus(cached.status))) {
        if ("error" in cached) throw new Error(cached.error);
        return new Response(cached.body || null, { status: cached.status, headers: cached.headers });
      }
      const { timeoutMs = 15_000, ...requestInit } = init;
      for (let attempt = 0; ; attempt++) {
        this.check();
        requestInit.signal?.throwIfAborted();
        const scheduledAt = Math.max(Date.now(), this.nextPumpRequestAt);
        if (scheduledAt > Date.now()) await this.wait(scheduledAt - Date.now());
        let failure: unknown, retryAfter: string | null = null;
        try {
          const result = await withRequestTimeout(timeoutMs, (timeout) => this.request(async (signal) => {
            const response = await request(url, { ...requestInit, signal });
            const body = await response.text();
            const headers: Record<string, string> = {};
            response.headers.forEach((value, name) => { headers[name] = value; });
            return { status: response.status, body: response.ok || response.status === 404 ? body : "", headers };
          }, requestInit.signal ? AbortSignal.any([requestInit.signal, timeout]) : timeout));
          if (!isTransientHttpStatus(result.status)) {
            if (cacheable) await this.commit([{ key, value: result }]);
            return new Response(result.body || null, { status: result.status, headers: result.headers });
          }
          failure = new Error(`Pump.fun ${new URL(url).pathname} HTTP ${result.status}`);
          retryAfter = result.headers["retry-after"] ?? null;
        } catch (error) {
          this.check();
          if (isPumpFunSourceError(error)) { this.stop("source"); this.check(); }
          requestInit.signal?.throwIfAborted();
          if (!isTransientRequestError(error)) {
            if (cacheable) await this.commit([{ key, value: { error: error instanceof Error ? error.message : String(error) } }]);
            throw error;
          }
          failure = error;
        } finally { this.nextPumpRequestAt = Date.now() + 200; }
        if (attempt >= 2) this.pause(`Pump.fun 조회: ${failure instanceof Error ? failure.message : String(failure)}`);
        await this.wait(retryDelayMs(retryAfter, attempt));
      }
    };
    const wrapped: PumpFunFetch = (url, init) => {
      const pending = this.pumpQueue.then(() => perform(url, init));
      this.pumpQueue = pending.then(() => undefined, () => undefined);
      return pending;
    };
    wrapped.managesPacing = true;
    wrapped.managesTimeouts = true;
    return wrapped;
  }
  dispose(): void { clearTimeout(this.timer); }
  async flushStopped(): Promise<void> {
    const saved = await this.store.read<RunCheckpoint>(this.id, RUN_KEY);
    if (!saved) return;
    await this.store.write(this.id, [{ key: RUN_KEY, value: { ...saved, totalRequests: this.totalRequests } }]);
    Object.assign(this.stats, saved.stats);
    this.position = saved.position;
  }
}
