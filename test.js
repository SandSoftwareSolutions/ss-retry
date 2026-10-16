import assert from "node:assert/strict";
import { test } from "node:test";

import { backoff, retry, retryAfterMs, RetryError, StopRetrying } from "./src/index.js";

const fast = { minMs: 1, maxMs: 2, jitter: "none" };

test("returns at once on success", async () => {
  let calls = 0;
  assert.equal(await retry(() => (calls++, "ok"), fast), "ok");
  assert.equal(calls, 1);
});

test("retries until it works", async () => {
  const seen = [];
  const value = await retry((attempt) => {
    seen.push(attempt);
    if (attempt < 3) throw new Error("nope");
    return attempt;
  }, { ...fast, retries: 5 });
  assert.equal(value, 3);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("gives a RetryError with every error after the last attempt", async () => {
  let calls = 0;
  await assert.rejects(
    retry(() => { throw new Error(`fail ${++calls}`); }, { ...fast, retries: 2 }),
    (error) => error instanceof RetryError && error.attempts === 3 && error.errors.length === 3 && error.cause.message === "fail 3" && /Failed after 3 attempts: fail 3/.test(error.message)
  );
});

test("retries: 0 throws the original error", async () => {
  const original = new Error("once");
  await assert.rejects(retry(() => { throw original; }, { retries: 0 }), (e) => e === original);
});

test("shouldRetry and StopRetrying end it early", async () => {
  let calls = 0;
  await assert.rejects(retry(() => { calls++; throw Object.assign(new Error("bad request"), { status: 400 }); }, { ...fast, shouldRetry: (e) => e.status >= 500 }), RetryError);
  assert.equal(calls, 1);
  const fatal = new Error("fatal");
  calls = 0;
  await assert.rejects(retry(() => { calls++; throw new StopRetrying(fatal); }, fast), (e) => e === fatal);
  assert.equal(calls, 1);
});

test("onRetry is told about the delay, and retryAfterMs on the error wins when longer", async () => {
  const infos = [];
  const delays = [];
  await retry((attempt) => {
    if (attempt === 1) throw Object.assign(new Error("429"), { retryAfterMs: 7000 });
    return "done";
  }, { ...fast, onRetry: (i) => infos.push(i), sleep: async (ms) => delays.push(ms) });
  assert.equal(infos[0].attempt, 1);
  assert.equal(infos[0].delayMs, 7000);
  assert.deepEqual(delays, [7000]);
});

test("an abort stops the waiting and rejects with the reason", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const started = Date.now();
  const promise = retry(() => { throw new Error("x"); }, { minMs: 5000, maxMs: 5000, jitter: "none", signal: controller.signal });
  setTimeout(() => controller.abort(reason), 30);
  await assert.rejects(promise, (e) => e === reason);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(retry(() => 1, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
});

test("a per-attempt timeout aborts a hanging attempt and gives it a signal", async () => {
  let signals = 0;
  const value = await retry((attempt, signal) => {
    if (attempt === 1) {
      signals += signal ? 1 : 0;
      return new Promise(() => {});
    }
    return "second";
  }, { ...fast, timeoutPerAttemptMs: 30 });
  assert.equal(value, "second");
  assert.equal(signals, 1);
});

test("backoff grows, is capped, and jitter stays inside the bounds", () => {
  const plain = { minMs: 100, maxMs: 1000, jitter: "none" };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoff(n, plain)), [100, 200, 400, 800, 1000, 1000]);
  assert.equal(backoff(3, { minMs: 100, maxMs: 1000, random: () => 0.5 }), 200);
  assert.equal(backoff(3, { minMs: 100, maxMs: 1000, jitter: "equal", random: () => 0 }), 200);
  assert.equal(backoff(3, { minMs: 100, maxMs: 1000, jitter: "equal", random: () => 1 }), 400);
  for (let i = 0; i < 100; i++) assert.ok(backoff(4, { minMs: 100, maxMs: 1000 }) <= 800);
});

test("Retry-After header", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 10_000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2020 07:28:00 GMT", Date.now()), 0);
  for (const bad of [undefined, null, "", "soon"]) assert.equal(retryAfterMs(bad), undefined);
});

test("bad arguments", async () => {
  await assert.rejects(retry("x"), TypeError);
  await assert.rejects(retry(() => 1, { retries: -1 }), RangeError);
  await assert.rejects(retry(() => 1, { retries: 1.5 }), RangeError);
});
