import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  attemptSpawn,
  awaitWhileAlive,
  EngineSpawnError,
  SandboxStartupError,
  type AttemptSpawnDeps,
} from "./spawnAttempt.ts";
import {
  waitForCdpSessionReady,
  type ReadinessDeps,
  type ReadinessResponseLike,
} from "./cdpReadiness.ts";

/**
 * Coverage for one engine spawn + readiness attempt and the startup exit
 * guard. The child is a fake EventEmitter and spawn / readiness / the
 * tree-kill are injected, so spawn errors, the sandbox-crash race, and an
 * abandoned readiness probe can be driven deterministically without Chromium.
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new EventEmitter();
  constructor(readonly pid: number | undefined) {
    super();
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  writeStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }
}

class FakeSession {
  connects = 0;
  closed = false;
  constructor(private readonly events: string[]) {}
  async connect(): Promise<void> {
    this.connects += 1;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.events.push("session closed");
  }
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function makeAttempt(opts: {
  child?: FakeChild;
  spawnThrows?: Error;
  waitForReady?: (session: FakeSession, signal: AbortSignal) => Promise<void>;
  events?: string[];
}) {
  const events = opts.events ?? [];
  const sessions: FakeSession[] = [];
  const logs: string[] = [];
  const deps: AttemptSpawnDeps<FakeChild, FakeSession> = {
    spawn: () => {
      if (opts.spawnThrows) throw opts.spawnThrows;
      events.push("spawn");
      return opts.child!;
    },
    createSession: () => {
      const s = new FakeSession(events);
      sessions.push(s);
      return s;
    },
    waitForReady: opts.waitForReady ?? (async () => {}),
    killProcessTree: async (pid) => {
      events.push(`kill ${pid}`);
    },
    log: (line) => {
      logs.push(line);
    },
  };
  return { deps, events, sessions, logs };
}

/** A readiness probe that only settles once aborted, a little later — like a
 *  connect() that was in flight when the attempt failed. */
function probeSettlingAfterAbort(events: string[]) {
  return (_session: FakeSession, signal: AbortSignal): Promise<void> =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        setTimeout(() => {
          events.push("probe settled");
          reject(signal.reason);
        }, 5);
      });
    });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── spawn failures ───────────────────────────────────────────────────────────

test("a spawn error event (missing binary) rejects the attempt instead of going uncaught", async () => {
  const child = new FakeChild(undefined); // Node gives a failed spawn no pid
  const { deps, sessions, events } = makeAttempt({ child });
  const attempt = attemptSpawn("/opt/engine/chrome", deps);
  assert.ok(child.listenerCount("error") > 0, "an 'error' listener is registered at spawn");
  // Node emits the error on the next tick, with no 'exit'. Without a listener
  // this emit would throw: an uncaught exception in the Electron main process.
  process.nextTick(() => child.emit("error", errno("ENOENT", "spawn /opt/engine/chrome ENOENT")));
  await assert.rejects(attempt, (e: unknown) => {
    assert.ok(e instanceof EngineSpawnError);
    assert.match((e as Error).message, /ENOENT/);
    assert.match((e as Error).message, /\/opt\/engine\/chrome/);
    return true;
  });
  assert.equal(sessions.length, 0, "no CDP session for a browser that never started");
  assert.deepEqual(events, ["spawn"], "nothing to kill");
});

test("a synchronous spawn throw (EPERM, e.g. antivirus) rejects with the same clear error", async () => {
  const { deps, sessions } = makeAttempt({
    spawnThrows: errno("EPERM", "spawn EPERM"),
  });
  await assert.rejects(attemptSpawn("C:\\engine\\chrome.exe", deps), (e: unknown) => {
    assert.ok(e instanceof EngineSpawnError);
    assert.match((e as Error).message, /EPERM/);
    assert.match((e as Error).message, /antivirus/);
    return true;
  });
  assert.equal(sessions.length, 0);
});

test("an 'error' after the browser is up (e.g. a refused kill) is logged, not thrown", async () => {
  const child = new FakeChild(321);
  const { deps, logs } = makeAttempt({ child });
  const { session } = await attemptSpawn("/opt/engine/chrome", deps);
  assert.doesNotThrow(() => child.emit("error", errno("EPERM", "kill EPERM")));
  await tick();
  assert.ok(logs.some((l) => l.includes("kill EPERM")));
  assert.equal(session.closed, false);
});

// ── sandbox crash / readiness failure ────────────────────────────────────────

test("a sandbox crash stops the readiness probe and waits for it before closing the session", async () => {
  const child = new FakeChild(4242);
  const events: string[] = [];
  let probeSignal: AbortSignal | undefined;
  const settle = probeSettlingAfterAbort(events);
  const { deps } = makeAttempt({
    child,
    events,
    waitForReady: (s, signal) => {
      probeSignal = signal;
      return settle(s, signal);
    },
  });
  const attempt = attemptSpawn("/opt/engine/chrome", deps);
  child.writeStderr("FATAL: No usable sandbox! Update your kernel");
  child.exit(1);
  await assert.rejects(attempt, SandboxStartupError);
  assert.equal(probeSignal?.aborted, true, "the probe was told to stop");
  assert.deepEqual(events, ["spawn", "kill 4242", "probe settled", "session closed"]);
});

test("the crash is confirmed whichever of exit and the stderr signature lands first", async () => {
  const child = new FakeChild(77);
  const { deps } = makeAttempt({ child, waitForReady: probeSettlingAfterAbort([]) });
  const attempt = attemptSpawn("/opt/engine/chrome", deps);
  child.exit(1);
  child.writeStderr("Failed to move to new namespace: PID namespaces supported");
  await assert.rejects(attempt, SandboxStartupError);
});

test("the sandbox signature on a still-running child is not a crash", async () => {
  const child = new FakeChild(78);
  let release = (): void => {};
  const { deps } = makeAttempt({
    child,
    waitForReady: () => new Promise<void>((r) => (release = r)),
  });
  const attempt = attemptSpawn("/opt/engine/chrome", deps);
  child.writeStderr("No usable sandbox!");
  await tick();
  release();
  const { session } = await attempt;
  assert.equal(session.closed, false);
});

test("a readiness failure kills the tree and closes the session", async () => {
  const child = new FakeChild(55);
  const { deps, events } = makeAttempt({
    child,
    waitForReady: async () => {
      throw new Error("No CDP page target on port 9222 within 15000ms");
    },
  });
  await assert.rejects(attemptSpawn("/opt/engine/chrome", deps), /No CDP page target/);
  assert.ok(events.includes("kill 55"));
  assert.ok(events.includes("session closed"));
});

// ── the relaunch scenario, with the real readiness probe ─────────────────────

test("a crashed first attempt never connects its session to the browser relaunched on the same port", async () => {
  const port = 9400;
  // The port answers only once the relaunched browser is up.
  let relaunchedUp = false;
  const refused = (): ReadinessResponseLike => {
    throw new Error("ECONNREFUSED");
  };
  const readinessDeps: ReadinessDeps = {
    fetch: async (url) => {
      if (!relaunchedUp) return refused();
      const body = url.includes("/json/list") ? [{ type: "page" }] : {};
      return { ok: true, json: async () => body };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
  };
  const waitForReady = (s: FakeSession, signal: AbortSignal) =>
    waitForCdpSessionReady(port, s, 15000, readinessDeps, signal);

  // Attempt 1: the sandbox fails to start.
  const first = new FakeChild(100);
  const a1 = makeAttempt({ child: first, waitForReady });
  const attempt1 = attemptSpawn("/opt/engine/chrome", a1.deps);
  await new Promise((r) => setTimeout(r, 10)); // let the probe poll a few times
  first.writeStderr("No usable sandbox!");
  first.exit(1);
  await assert.rejects(attempt1, SandboxStartupError);
  const [firstSession] = a1.sessions;

  // Attempt 2: relaunch with --no-sandbox on the same port; it comes up.
  const second = new FakeChild(200);
  const a2 = makeAttempt({ child: second, waitForReady });
  relaunchedUp = true;
  const { session: secondSession } = await attemptSpawn("/opt/engine/chrome", a2.deps);

  // Give an abandoned first probe ample time to find the new browser.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(firstSession!.connects, 0, "no extra CDP client from the first attempt");
  assert.equal(firstSession!.closed, true);
  assert.equal(secondSession.connects, 1);
});

// ── awaitWhileAlive (the post-readiness bootstrap window) ────────────────────

test("awaitWhileAlive returns false as soon as the child exits, without waiting for the work", async () => {
  const child = new FakeChild(10);
  const never = new Promise<void>(() => {});
  setTimeout(() => child.exit(null, "SIGSEGV"), 5);
  assert.equal(await awaitWhileAlive(child, never), false);
  assert.equal(child.listenerCount("exit"), 0, "its exit listener is removed");
});

test("awaitWhileAlive returns false for a child whose exit already fired", async () => {
  const child = new FakeChild(11);
  child.exit(1); // e.g. died during the final connect(), before anyone listened
  assert.equal(await awaitWhileAlive(child, Promise.resolve()), false);
});

test("awaitWhileAlive returns true when the work finishes with the child running", async () => {
  const child = new FakeChild(12);
  assert.equal(await awaitWhileAlive(child, new Promise((r) => setTimeout(r, 5))), true);
  assert.equal(child.listenerCount("exit"), 0);
});

test("awaitWhileAlive returns false when the child exits in the same turn the work finishes", async () => {
  const child = new FakeChild(13);
  let finish = (): void => {};
  const work = new Promise<void>((r) => (finish = r));
  const result = awaitWhileAlive(child, work);
  finish();
  child.exit(0);
  assert.equal(await result, false);
});
