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
  signal?: AbortSignal;
  /** Gives `fn` a signal as its second argument that aborts on timeout. */
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

export function backoff(attempt: number, options?: BackoffOptions): number;
export function retryAfterMs(value: string | number | null | undefined, now?: number): number | undefined;
export function retry<T>(fn: (attempt: number, signal?: AbortSignal) => T | Promise<T>, options?: RetryOptions): Promise<T>;
