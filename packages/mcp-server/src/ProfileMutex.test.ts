import { test } from "node:test";
import assert from "node:assert/strict";
import { MultizenError } from "@multizen/types";
import { MUTEX_QUEUE_DEPTH, MUTEX_WAIT_MS, ProfileMutex } from "./ProfileMutex.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function hasCode(code: string, retryable?: boolean) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof MultizenError, String(e));
    assert.equal(e.code, code, e.message);
    if (retryable !== undefined) assert.equal(e.retryable, retryable);
    return true;
  };
}

/** Holds the profile until `release` is called. */
function hold(mutex: ProfileMutex, id = "p"): { done: Promise<void>; release: () => void } {
  const gate = deferred();
  return { done: mutex.run(id, () => gate.promise), release: gate.resolve };
}

test("the guardrails are the agreed ones", () => {
  assert.equal(MUTEX_QUEUE_DEPTH, 16);
  assert.equal(MUTEX_WAIT_MS, 30_000);
});

test("calls on a profile run one at a time, in arrival order", async () => {
  const mutex = new ProfileMutex();
  const order: string[] = [];
  const first = hold(mutex);
  const rest = ["a", "b", "c"].map((name) =>
    mutex.run("p", async () => {
      order.push(`${name} start`);
      await tick();
      order.push(`${name} end`);
    }),
  );
  await tick();
  assert.deepEqual(order, []);
  assert.equal(mutex.queued("p"), 3);
  first.release();
  await Promise.all([first.done, ...rest]);
  assert.deepEqual(order, ["a start", "a end", "b start", "b end", "c start", "c end"]);
  assert.equal(mutex.isHeld("p"), false);
});

test("profiles don't wait for each other", async () => {
  const mutex = new ProfileMutex();
  const p = hold(mutex, "p");
  let ran = false;
  await mutex.run("q", async () => {
    ran = true;
  });
  assert.equal(ran, true);
  p.release();
  await p.done;
});

test("a failing call hands the profile on and keeps its own error", async () => {
  const mutex = new ProfileMutex();
  await assert.rejects(mutex.run("p", () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await mutex.run("p", async () => "next"), "next");
});

test("a wait past its time is a retryable TIMEOUT and takes the waiter out of line", async () => {
  const mutex = new ProfileMutex({ waitMs: 20 });
  const first = hold(mutex);
  let ran = false;
  await assert.rejects(
    mutex.run("p", async () => {
      ran = true;
    }),
    hasCode("TIMEOUT", true),
  );
  assert.equal(mutex.queued("p"), 0);
  first.release();
  await first.done;
  assert.equal(ran, false);
});

test("a call's own timeout wins over the default", async () => {
  const mutex = new ProfileMutex({ waitMs: 60_000 });
  const first = hold(mutex);
  await assert.rejects(mutex.run("p", async () => {}, { timeoutMs: 10 }), hasCode("TIMEOUT"));
  first.release();
  await first.done;
});

test("past the queue depth a call is refused at once", async () => {
  const mutex = new ProfileMutex({ queueDepth: 2 });
  const first = hold(mutex);
  const waiting = [mutex.run("p", async () => {}), mutex.run("p", async () => {})];
  const startedAt = Date.now();
  await assert.rejects(mutex.run("p", async () => {}), hasCode("TIMEOUT", true));
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(mutex.queued("p"), 2);
  first.release();
  await Promise.all([first.done, ...waiting]);
});

test("a cancelled waiter leaves the line and never runs, and the rest move up", async () => {
  const mutex = new ProfileMutex();
  const first = hold(mutex);
  const client = new AbortController();
  const ran: string[] = [];
  const cancelled = mutex.run("p", async () => void ran.push("cancelled"), {
    signal: client.signal,
  });
  const after = mutex.run("p", async () => void ran.push("after"));
  await tick();
  client.abort();
  await assert.rejects(cancelled, hasCode("TIMEOUT", false));
  first.release();
  await Promise.all([first.done, after]);
  assert.deepEqual(ran, ["after"]);
});

test("a call that was already cancelled never takes the profile", async () => {
  const mutex = new ProfileMutex();
  const client = new AbortController();
  client.abort();
  await assert.rejects(mutex.run("p", async () => {}, { signal: client.signal }), hasCode("TIMEOUT"));
  assert.equal(mutex.isHeld("p"), false);
});

test("cancelled in the moment its turn came: it doesn't run", async () => {
  const mutex = new ProfileMutex();
  const first = hold(mutex);
  const client = new AbortController();
  // Admitting a waiter takes its abort listener off: that is the moment in question.
  const { signal } = client;
  const removeListener = signal.removeEventListener.bind(signal);
  signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removeListener(...args);
    client.abort();
  };
  let ran = false;
  const waiting = mutex.run(
    "p",
    async () => {
      ran = true;
    },
    { signal },
  );
  first.release();
  await first.done;
  await assert.rejects(waiting, hasCode("TIMEOUT"));
  assert.equal(ran, false);
  assert.equal(mutex.isHeld("p"), false);
});

test("dropSession takes only that session's waiters", async () => {
  const mutex = new ProfileMutex();
  const first = hold(mutex);
  const ran: string[] = [];
  const gone = mutex.run("p", async () => void ran.push("gone"), { sessionId: "s1" });
  const stays = mutex.run("p", async () => void ran.push("stays"), { sessionId: "s2" });
  await tick();
  mutex.dropSession("s1");
  await assert.rejects(gone, hasCode("TIMEOUT"));
  first.release();
  await Promise.all([first.done, stays]);
  assert.deepEqual(ran, ["stays"]);
});

test("rejectWaiters fails the line with the given error and leaves the holder running", async () => {
  const mutex = new ProfileMutex();
  const first = hold(mutex);
  const error = new MultizenError("PROFILE_NOT_RUNNING", "closed");
  const waiting = [mutex.run("p", async () => {}), mutex.run("p", async () => {})];
  await tick();
  mutex.rejectWaiters("p", error);
  for (const w of waiting) await assert.rejects(w, (e) => e === error);
  assert.equal(mutex.isHeld("p"), true);
  first.release();
  await first.done;
  assert.equal(mutex.isHeld("p"), false);
});
