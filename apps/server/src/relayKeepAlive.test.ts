import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { RelayKeepAlive, whySessionGone, type RelayKeepAliveOptions } from "./relayKeepAlive.ts";

// The timers here are unref'd, as a relay's must be. Node 22's runner takes an event loop
// with nothing else in it to mean a test will never finish, and cancels it.
let holdLoop: NodeJS.Timeout;
beforeEach(() => {
  holdLoop = setInterval(() => {}, 1_000);
});
afterEach(() => clearInterval(holdLoop));

const httpError = (code: number): Error => Object.assign(new Error(`HTTP ${code}`), { code });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function rig(overrides: Partial<RelayKeepAliveOptions> = {}) {
  let answer: () => Promise<void> = async () => {};
  const pings: number[] = [];
  const gone: string[] = [];
  const keepAlive = new RelayKeepAlive({
    intervalMs: 10,
    retryMs: 5,
    attempts: 3,
    ping: () => {
      pings.push(Date.now());
      return answer();
    },
    onGone: (why) => gone.push(why),
    ...overrides,
  });
  return {
    keepAlive,
    pings,
    gone,
    answerWith: (next: () => Promise<void>): void => {
      answer = next;
    },
  };
}

test("it pings on its interval, and not before it starts or after it stops", async () => {
  const { keepAlive, pings } = rig();
  await wait(30);
  assert.equal(pings.length, 0);
  keepAlive.start();
  keepAlive.start();
  await wait(60);
  const seen = pings.length;
  assert.ok(seen >= 2, `${seen} pings`);
  keepAlive.stop();
  await wait(30);
  assert.equal(pings.length, seen);
});

for (const status of [404, 401, 403]) {
  test(`HTTP ${status} on a ping: the session won't come back, so it ends at once, once`, async () => {
    const { keepAlive, pings, gone, answerWith } = rig();
    answerWith(() => Promise.reject(httpError(status)));
    keepAlive.start();
    await wait(50);
    assert.equal(gone.length, 1);
    assert.equal(pings.length, 1);
    assert.match(gone[0]!, /Restart this relay/);
  });
}

test("what it says names the cause", () => {
  assert.match(whySessionGone(httpError(404))!, /restarted, or closed the session for idling/);
  assert.match(whySessionGone(httpError(401))!, /revoked or has expired/);
  assert.equal(whySessionGone(httpError(502)), null);
  assert.equal(whySessionGone(httpError(429)), null);
  assert.equal(whySessionGone(new TypeError("fetch failed")), null);
  assert.equal(whySessionGone(null), null);
});

test("a server that doesn't answer gets its tries, then it ends", async () => {
  const { keepAlive, pings, gone, answerWith } = rig();
  answerWith(() => Promise.reject(new TypeError("fetch failed")));
  keepAlive.start();
  await wait(80);
  assert.equal(pings.length, 3);
  assert.equal(gone.length, 1);
  assert.match(gone[0]!, /does not answer \(3 tries, last: fetch failed\)/);
});

test("a blip costs nothing: an answer starts the count over", async () => {
  const { keepAlive, gone, pings, answerWith } = rig();
  let calls = 0;
  answerWith(() => (++calls % 3 === 0 ? Promise.resolve() : Promise.reject(new TypeError("fetch failed"))));
  keepAlive.start();
  await wait(120);
  keepAlive.stop();
  assert.deepEqual(gone, []);
  assert.ok(pings.length > 3, `${pings.length} pings`);
});

test("a 5xx from a proxy is a blip too, not the end of a session", async () => {
  const { keepAlive, gone, answerWith } = rig({ attempts: 100 });
  answerWith(() => Promise.reject(httpError(502)));
  keepAlive.start();
  await wait(40);
  keepAlive.stop();
  assert.deepEqual(gone, []);
});

test("a ping that never answers counts as no answer", async () => {
  const { keepAlive, gone, answerWith } = rig({ timeoutMs: 5, attempts: 2 });
  answerWith(() => new Promise(() => {}));
  keepAlive.start();
  await wait(60);
  assert.equal(gone.length, 1);
  assert.match(gone[0]!, /no answer within 5 ms/);
});

test("checkNow doesn't wait for the interval, and doesn't hurry the retries", async () => {
  const { keepAlive, pings, gone, answerWith } = rig({ intervalMs: 60_000, retryMs: 40, attempts: 3 });
  answerWith(() => Promise.reject(new TypeError("fetch failed")));
  keepAlive.start();
  keepAlive.checkNow();
  await wait(5);
  assert.equal(pings.length, 1, "no wait for the minute");
  keepAlive.checkNow();
  keepAlive.checkNow();
  await wait(5);
  assert.equal(pings.length, 1, "the SDK's reconnects fire this quickly: that's not three tries");
  await wait(120);
  assert.equal(gone.length, 1);
  keepAlive.stop();
});

test("stopped, nothing more happens: a late answer, a checkNow", async () => {
  const { keepAlive, pings, gone, answerWith } = rig();
  let fail = (_e: Error): void => {};
  answerWith(() => new Promise((_resolve, reject) => (fail = reject)));
  keepAlive.start();
  await wait(25);
  keepAlive.stop();
  fail(httpError(404));
  await wait(5);
  keepAlive.checkNow();
  await wait(20);
  assert.deepEqual(gone, []);
  assert.equal(pings.length, 1);
});
