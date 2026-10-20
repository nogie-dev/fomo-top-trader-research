const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function isTransientHttpStatus(status: number): boolean { return TRANSIENT_STATUSES.has(status); }

export function isTransientRequestError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return name === "TimeoutError" || /\b(?:timed out|timeout)\b/i.test(message)
    || /\bHTTP (?:408|429|500|502|503|504)\b/.test(message)
    || /^(?:Failed to fetch|fetch failed|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(message);
}

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  return 500 * 2 ** attempt;
}

// Start and clear the deadline around an actual attempt, after queueing/pacing.
export async function withRequestTimeout<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Request timed out after ${milliseconds / 1000} seconds`, "TimeoutError")), milliseconds);
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); }
}
