// setTimeout fires after 1 ms (with a warning) for anything above this, so longer waits are cut to it (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(ms, MAX_TIMER_MS));
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

function checkBackoff({ minMs = 200, maxMs = 30_000, factor = 2, jitter = "full" } = {}) {
  if (typeof minMs !== "number" || !Number.isFinite(minMs) || minMs < 0) throw new RangeError("retry: minMs must be a finite number of milliseconds, 0 or more");
  if (typeof maxMs !== "number" || Number.isNaN(maxMs) || maxMs < 0) throw new RangeError("retry: maxMs must be a number of milliseconds, 0 or more");
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) throw new RangeError("retry: factor must be a finite number above 0");
  if (jitter !== "full" && jitter !== "equal" && jitter !== "none") throw new RangeError('retry: jitter must be "full", "equal" or "none"');
}

/**
 * The wait before attempt number `attempt` (1 = before the second try): exponential growth from `minMs`, capped at `maxMs` (and at
 * about 24.8 days, the longest wait Node can time), with jitter. Throws a RangeError for numbers that make no sense.
 */
export function backoff(attempt, options = {}) {
  checkBackoff(options);
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("backoff: attempt must be a whole number of at least 1");
  const { minMs = 200, maxMs = 30_000, factor = 2, jitter = "full", random = Math.random } = options;
  const grown = minMs === 0 ? 0 : minMs * factor ** (attempt - 1); // 0 * Infinity would be NaN
  const base = Math.min(maxMs, grown, MAX_TIMER_MS);
  if (jitter === "none") return Math.round(base);
  if (jitter === "equal") return Math.round(base / 2 + random() * (base / 2));
  return Math.round(random() * base); // "full": the best spread when many clients retry at once
}

/**
 * Reads a Retry-After header value into milliseconds, or undefined. Only what the standard allows counts: whole seconds
 * ("120") or an HTTP date ("Wed, 21 Oct 2026 07:28:00 GMT", also ISO 8601 with a time zone). Anything else is undefined, so
 * you fall back to the normal backoff instead of getting a 0.
 */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const httpDate = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text);
  const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text);
  if (!httpDate && !isoDate) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Runs `fn(attempt)` until it succeeds. Options: `retries` (extra tries after the first, default 3), `minMs`, `maxMs`, `factor`,
 * `jitter` ("full" | "equal" | "none"), `shouldRetry(error, attempt)` (return false to give up), `onRetry({ error, attempt, delayMs })`,
 * `signal` (an AbortSignal that stops waiting, and an attempt that is running, and rejects with its reason; `fn` gets a signal as its second argument whenever you pass `signal` or `timeoutPerAttemptMs`), `timeoutPerAttemptMs` (Infinity = none).
 * An error with a numeric `retryAfterMs` property waits at least that long (useful for HTTP 429).
 */
export async function retry(fn, options = {}) {
  const { retries = 3, shouldRetry = () => true, onRetry, signal, timeoutPerAttemptMs, sleep: wait = sleep } = options;
  if (typeof fn !== "function") throw new TypeError("retry: fn must be a function");
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError("retry: retries must be a whole number, 0 or more");
  checkBackoff(options);
  if (timeoutPerAttemptMs !== undefined && (typeof timeoutPerAttemptMs !== "number" || Number.isNaN(timeoutPerAttemptMs) || timeoutPerAttemptMs <= 0)) {
    throw new RangeError("retry: timeoutPerAttemptMs must be a number of milliseconds above 0 (Infinity = no timeout)");
  }
  const timeoutMs = timeoutPerAttemptMs === Infinity ? undefined : timeoutPerAttemptMs;
  const errors = [];
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw signal.reason;
    try {
      if (timeoutMs === undefined && !signal) return await fn(attempt);
      return await runAttempt(fn, attempt, timeoutMs, signal);
    } catch (error) {
      if (error instanceof StopRetrying) throw error.cause ?? error;
      if (signal?.aborted) throw signal.reason;
      errors.push(error);
      let again = attempt <= retries;
      if (again) {
        try {
          again = await shouldRetry(error, attempt);
        } catch (thrown) {
          throw thrown instanceof StopRetrying ? thrown.cause ?? thrown : thrown;
        }
      }
      if (!again) throw errors.length === 1 && retries === 0 ? error : new RetryError(attempt, errors);
      const delayMs = Math.min(MAX_TIMER_MS, Math.max(backoff(attempt, options), Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0));
      onRetry?.({ error, attempt, delayMs });
      await wait(delayMs, signal);
    }
  }
}

// One attempt with its own AbortSignal. It ends at once when the outer signal aborts or the time is up, also when `fn` ignores the signal.
function runAttempt(fn, attempt, ms, outer) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      controller.abort(outer.reason);
      reject(outer.reason);
    };
    if (outer?.aborted) return onAbort();
    outer?.addEventListener("abort", onAbort, { once: true });
    if (ms !== undefined) {
      timer = setTimeout(() => {
        const error = new Error(`attempt ${attempt} timed out after ${ms} ms`);
        error.name = "TimeoutError";
        cleanup();
        controller.abort(error);
        reject(error);
      }, Math.min(ms, MAX_TIMER_MS));
    }
    Promise.resolve()
      .then(() => fn(attempt, controller.signal))
      .then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
