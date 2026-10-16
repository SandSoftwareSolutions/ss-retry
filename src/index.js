const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Thrown from the function (or `shouldRetry`) to stop retrying at once. The original error is `cause`. */
export class StopRetrying extends Error {
  constructor(cause) {
    super(cause?.message ?? "stop retrying", { cause });
    this.name = "StopRetrying";
  }
}

/** Thrown after the last attempt failed. `cause` is the last error, `attempts` how many times it ran, `errors` all of them. */
export class RetryError extends Error {
  constructor(attempts, errors) {
    const last = errors[errors.length - 1];
    super(`Failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${last?.message ?? last}`, { cause: last });
    this.name = "RetryError";
    this.attempts = attempts;
    this.errors = errors;
  }
}

/** The wait before attempt number `attempt` (1 = before the second try): exponential growth from `minMs`, capped at `maxMs`, with jitter. */
export function backoff(attempt, { minMs = 200, maxMs = 30_000, factor = 2, jitter = "full", random = Math.random } = {}) {
  const base = Math.min(maxMs, minMs * factor ** (attempt - 1));
  if (jitter === "none") return Math.round(base);
  if (jitter === "equal") return Math.round(base / 2 + random() * (base / 2));
  return Math.round(random() * base); // "full": the best spread when many clients retry at once
}

/** Reads a Retry-After header value (seconds or a date) into milliseconds, or undefined. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Runs `fn(attempt)` until it succeeds. Options: `retries` (extra tries after the first, default 3), `minMs`, `maxMs`, `factor`,
 * `jitter` ("full" | "equal" | "none"), `shouldRetry(error, attempt)` (return false to give up), `onRetry({ error, attempt, delayMs })`,
 * `signal` (an AbortSignal that stops waiting and rejects with its reason), `timeoutPerAttemptMs`.
 * An error with a numeric `retryAfterMs` property waits at least that long (useful for HTTP 429).
 */
export async function retry(fn, options = {}) {
  const { retries = 3, shouldRetry = () => true, onRetry, signal, timeoutPerAttemptMs, sleep: wait = sleep } = options;
  if (typeof fn !== "function") throw new TypeError("retry: fn must be a function");
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retry: retries must be a whole number, 0 or more");
  const errors = [];
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try {
      if (timeoutPerAttemptMs === undefined) return await fn(attempt);
      return await withTimeout(fn, attempt, timeoutPerAttemptMs, signal);
    } catch (error) {
      if (error instanceof StopRetrying) throw error.cause ?? error;
      if (signal?.aborted) throw signal.reason;
      errors.push(error);
      if (attempt > retries || !(await shouldRetry(error, attempt))) throw errors.length === 1 && retries === 0 ? error : new RetryError(attempt, errors);
      const delayMs = Math.max(backoff(attempt, options), Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0);
      onRetry?.({ error, attempt, delayMs });
      await wait(delayMs, signal);
    }
  }
}

function withTimeout(fn, attempt, ms, outer) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const error = new Error(`attempt ${attempt} timed out after ${ms} ms`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, ms);
    outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    Promise.resolve()
      .then(() => fn(attempt, controller.signal))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
