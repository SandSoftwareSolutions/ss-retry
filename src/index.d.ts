export interface BackoffOptions {
  /** First wait. Default 200. */
  minMs?: number;
  /** Longest wait. Default 30000. */
  maxMs?: number;
  /** Growth per attempt. Default 2. */
  factor?: number;
  /** "full" (default): anywhere between 0 and the wait. "equal": half fixed, half random. "none". */
  jitter?: "full" | "equal" | "none";
  random?: () => number;
}

export interface RetryOptions extends BackoffOptions {
  /** Extra tries after the first. Default 3. */
  retries?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  onRetry?: (info: { error: unknown; attempt: number; delayMs: number }) => void;
  /** Stops the waiting and a running attempt too; `fn` gets it (as its own signal) as second argument. */
  signal?: AbortSignal;
  /** Gives `fn` a signal as its second argument that aborts on timeout. Infinity = no timeout; 0, negative or NaN throw a RangeError. */
  timeoutPerAttemptMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class StopRetrying extends Error {
  constructor(cause?: unknown);
}

export class RetryError extends Error {
  constructor(attempts: number, errors: unknown[]);
  readonly attempts: number;
  readonly errors: unknown[];
  readonly cause: unknown;
}

/** Throws a RangeError for attempt below 1 or non-integer, and for NaN, negative or out-of-range options. */
export function backoff(attempt: number, options?: BackoffOptions): number;
/** Whole seconds or an HTTP date (IMF-fixdate, or ISO 8601 with a time zone); anything else gives undefined. */
export function retryAfterMs(value: string | number | null | undefined, now?: number): number | undefined;
export function retry<T>(fn: (attempt: number, signal?: AbortSignal) => T | Promise<T>, options?: RetryOptions): Promise<T>;
