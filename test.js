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

// ---- review additions ----

test("an abort ends an attempt that is still running, with or without a per-attempt timeout", async () => {
  for (const options of [{}, { timeoutPerAttemptMs: 60_000 }]) {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const started = Date.now();
    let received;
    const promise = retry((attempt, signal) => { received = signal; return new Promise(() => {}); }, { ...fast, signal: controller.signal, ...options });
    setTimeout(() => controller.abort(reason), 30);
    await assert.rejects(promise, (e) => e === reason);
    assert.ok(Date.now() - started < 1000);
    assert.ok(received instanceof AbortSignal, "the attempt gets a signal to stop on");
    assert.equal(received.aborted, true);
  }
});

test("a long-lived signal does not collect a listener per attempt", async () => {
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...a) => { listeners++; return add(...a); };
  controller.signal.removeEventListener = (...a) => { listeners--; return remove(...a); };
  await retry((attempt) => { if (attempt < 4) throw new Error("x"); }, { ...fast, retries: 5, signal: controller.signal, timeoutPerAttemptMs: 1000 });
  assert.equal(listeners, 0);
});

test("StopRetrying thrown from shouldRetry stops at once with the wrapped error", async () => {
  const fatal = new Error("fatal");
  await assert.rejects(retry(() => { throw new Error("x"); }, { ...fast, shouldRetry: () => { throw new StopRetrying(fatal); } }), (e) => e === fatal);
});

test("waits that Node cannot time are not turned into 1 ms", async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  await retry((attempt) => { if (attempt === 1) throw Object.assign(new Error("429"), { retryAfterMs: 1e12 }); }, { ...fast, sleep });
  assert.ok(delays[0] > 0 && delays[0] <= 2 ** 31 - 1, `delay ${delays[0]}`);
  // the real sleep: a delay above 2^31-1 would fire after 1 ms
  const started = Date.now();
  const controller = new AbortController();
  const waiting = retry((attempt) => { if (attempt === 1) throw Object.assign(new Error("429"), { retryAfterMs: 1e12 }); }, { ...fast, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stop")), 150);
  await assert.rejects(waiting, /stop/);
  assert.ok(Date.now() - started >= 140, "it waited until the abort");
});

test("timeoutPerAttemptMs: Infinity means no timeout, nonsense is refused", async () => {
  assert.equal(await retry(async () => { await new Promise((r) => setTimeout(r, 20)); return "ok"; }, { ...fast, retries: 0, timeoutPerAttemptMs: Infinity }), "ok");
  for (const bad of [0, -1, NaN, "5"]) await assert.rejects(retry(() => 1, { timeoutPerAttemptMs: bad }), RangeError, String(bad));
});

test("backoff checks its numbers and never returns NaN", () => {
  assert.equal(backoff(5000, { minMs: 100, maxMs: 1000, jitter: "none" }), 1000);
  assert.equal(backoff(5000, { minMs: 0, jitter: "none" }), 0);
  assert.equal(backoff(1, { minMs: 100, maxMs: 1000, jitter: "none", factor: 1e308 }), 100);
  assert.equal(backoff(3, { minMs: 100, maxMs: 1000, jitter: "none", factor: 1e308 }), 1000);
  for (const bad of [{ minMs: NaN }, { minMs: -1 }, { maxMs: NaN }, { maxMs: -5 }, { factor: 0 }, { factor: NaN }, { factor: Infinity }, { jitter: "fulll" }]) {
    assert.throws(() => backoff(1, bad), RangeError, JSON.stringify(bad));
  }
  for (const attempt of [0, -1, 1.5, NaN, "2"]) assert.throws(() => backoff(attempt), RangeError, String(attempt));
});

test("bad options are refused by retry as well", async () => {
  await assert.rejects(retry(() => 1, { minMs: NaN }), RangeError);
  await assert.rejects(retry(() => 1, { jitter: "fulll" }), RangeError);
});

test("Retry-After: only whole seconds and HTTP dates count, junk is ignored", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(retryAfterMs("5", now), 5000);
  assert.equal(retryAfterMs(5, now), 5000);
  assert.equal(retryAfterMs(" 7 ", now), 7000);
  assert.equal(retryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", now), 10_000);
  assert.equal(retryAfterMs("2026-10-21T07:28:10Z", now), 10_000);
  for (const junk of ["-5", "1.5", "soon 5", "Foo 5", "1e3", "0x10", "5 seconds", NaN, -5, 1.5, {}, "2026-10-21 07:28:10"]) assert.equal(retryAfterMs(junk, now), undefined, JSON.stringify(junk));
});
