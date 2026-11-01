import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { MultizenError } from "@multizen/types";
import { BROWSER_QUEUE_TIMEOUT_MS, BrowserLimiter } from "./browserLimiter.ts";

// Deadlines here are unref'd, as they are in the code they test. Node 22's runner takes an
// event loop with nothing else in it to mean a test will never finish, and cancels it.
let holdLoop: NodeJS.Timeout;
beforeEach(() => {
  holdLoop = setInterval(() => {}, 1_000);
});
afterEach(() => clearInterval(holdLoop));

const WAIT = { timeoutMs: 60_000 };

function hasCode(code: string) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof MultizenError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  };
}

test("the slot wait is 30 s, under the SDK client's timeout", () => {
  assert.equal(BROWSER_QUEUE_TIMEOUT_MS, 30_000);
});

test("no limit lets everything through at once", async () => {
  const limiter = new BrowserLimiter(Infinity);
  for (let i = 0; i < 100; i++) await limiter.acquire(`p${i}`, WAIT);
  assert.equal(limiter.inUse, 100);
});

test("at the limit a launch waits, and a released slot goes to the first in line", async () => {
  const limiter = new BrowserLimiter(2);
  await limiter.acquire("a", WAIT);
  await limiter.acquire("b", WAIT);
  const order: string[] = [];
  const waiting = ["c", "d"].map((id) =>
    limiter.acquire(id, WAIT).then(() => void order.push(id)),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  assert.equal(limiter.waiting, 2);

  limiter.release("a");
  await waiting[0];
  assert.deepEqual(order, ["c"]);
  assert.equal(limiter.inUse, 2);

  limiter.release("b");
  await waiting[1];
  assert.deepEqual(order, ["c", "d"]);
});

test("nobody at the limit for the whole wait: BROWSER_LIMIT_REACHED, retryable, with details", async () => {
  const limiter = new BrowserLimiter(1);
  await limiter.acquire("a", WAIT);
  const startedAt = Date.now();
  await assert.rejects(limiter.acquire("b", { timeoutMs: 30 }), (e: MultizenError) => {
    assert.equal(e.code, "BROWSER_LIMIT_REACHED");
    assert.equal(e.retryable, true);
    assert.equal(e.details?.max_browsers, 1);
    assert.equal(e.details?.running, 1);
    assert.equal(e.details?.retry_after_ms, 30);
    return true;
  });
  assert.ok(Date.now() - startedAt >= 25);
  assert.equal(limiter.waiting, 0);
});

test("a slot frees exactly once, however many paths report the same end", async () => {
  const limiter = new BrowserLimiter(2);
  await limiter.acquire("a", WAIT);
  await limiter.acquire("b", WAIT);
  let admitted = 0;
  const c = limiter.acquire("c", WAIT).then(() => void admitted++);
  const d = limiter.acquire("d", { timeoutMs: 30 }).then(
    () => void admitted++,
    () => "timed out",
  );
  limiter.release("a");
  limiter.release("a");
  limiter.release("never-held");
  await c;
  assert.equal(await d, "timed out");
  assert.equal(admitted, 1);
  assert.equal(limiter.inUse, 2);
});

test("a profile that holds a slot already just has it", async () => {
  const limiter = new BrowserLimiter(1);
  await limiter.acquire("a", WAIT);
  await limiter.acquire("a", WAIT);
  assert.equal(limiter.inUse, 1);
});

test("giving up the wait leaves the line, and the next one gets the slot", async () => {
  const limiter = new BrowserLimiter(1);
  await limiter.acquire("a", WAIT);
  const client = new AbortController();
  const leaving = limiter.acquire("b", { ...WAIT, signal: client.signal });
  const staying = limiter.acquire("c", WAIT);
  client.abort();
  await assert.rejects(leaving, hasCode("LAUNCH_FAILED"));
  limiter.release("a");
  await staying;
  assert.equal(limiter.inUse, 1);
});

test("a wait already given up on doesn't start one; with a slot free there is no wait", async () => {
  const limiter = new BrowserLimiter(1);
  const client = new AbortController();
  client.abort();
  await limiter.acquire("a", { ...WAIT, signal: client.signal });
  assert.equal(limiter.inUse, 1);
  await assert.rejects(
    limiter.acquire("b", { ...WAIT, signal: client.signal }),
    hasCode("LAUNCH_FAILED"),
  );
  assert.equal(limiter.waiting, 0);
});
