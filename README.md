# @sandsoftwaresolutions/retry

[![CI](https://github.com/SandSoftwareSolutions/ss-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-retry/actions/workflows/ci.yml)

Try again, the right way: waits that grow, random spread so many clients do not retry at the same moment, a way to give up, and a way to cancel. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/retry
```

## Usage

```js
import { retry, StopRetrying } from "@sandsoftwaresolutions/retry";

const data = await retry(async (attempt, signal) => {
  const res = await fetch(url, { signal });
  if (res.status === 404) throw new StopRetrying(new Error("not found")); // do not try again
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, {
  retries: 4,                 // extra tries after the first (default 3)
  minMs: 200, maxMs: 10_000,  // waits: 200, 400, 800... capped, with jitter
  timeoutPerAttemptMs: 5000,  // each try gets 5 seconds and an AbortSignal
  shouldRetry: (error) => !(error.status >= 400 && error.status < 500),
  onRetry: ({ attempt, delayMs, error }) => console.warn(`attempt ${attempt} failed, waiting ${delayMs} ms`, error.message)
});
```

## What you get

- **Success returns the value.** After the last attempt a `RetryError` is thrown with `attempts`, `errors` (all of them) and `cause` (the last). With `retries: 0` the original error is thrown as it is.
- **`StopRetrying`** inside your function stops at once and throws the error you wrapped. `shouldRetry(error, attempt)` can do the same from outside.
- **Cancel** with `signal`: the wait ends immediately and the promise rejects with the signal's reason.
- **Jitter** is "full" by default (anywhere between 0 and the wait), which spreads clients best. Use `"equal"` or `"none"` if you must.
- **429 and Retry-After.** Give your error a numeric `retryAfterMs` and the wait is at least that long. `retryAfterMs(header)` turns a `Retry-After` value (seconds or a date) into milliseconds.
- `backoff(attempt, options)` is available on its own.

Only retry what is safe to repeat. A POST that may have succeeded before the connection dropped needs an idempotency key first.
