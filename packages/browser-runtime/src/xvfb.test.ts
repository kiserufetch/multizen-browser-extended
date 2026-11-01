import { afterEach, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { MultizenError } from "@multizen/types";
import { hasXvfbBinary, startXvfb, xauthorityRecord } from "./xvfb.ts";

// Deadlines here are unref'd, as they are in the code they test. Node 22's runner takes an
// event loop with nothing else in it to mean a test will never finish, and cancels it.
let holdLoop: NodeJS.Timeout;
beforeEach(() => {
  holdLoop = setInterval(() => {}, 1_000);
});
afterEach(() => clearInterval(holdLoop));

/** Speaks as Xvfb does: the display on fd 3, diagnostics on stderr, exit on a signal. */
class FakeXvfb extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly stdio = [null, null, this.stderr, this.fd3];
  readonly signals: string[] = [];
  /** A stuck server ignores SIGTERM. */
  ignoresTerm = false;

  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoresTerm) return true;
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

interface Spawned {
  file: string;
  args: string[];
  opts: { env?: Record<string, string>; detached?: boolean; stdio?: unknown };
  child: FakeXvfb;
}

function rig(t: TestContext): { spawned: Spawned[]; child: FakeXvfb; spawnFn: typeof spawn; runDir: string } {
  const runDir = mkdtempSync(join(tmpdir(), "mz-xvfb-test-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const child = new FakeXvfb();
  const spawned: Spawned[] = [];
  const spawnFn = ((file: string, args: string[], opts: Spawned["opts"]) => {
    spawned.push({ file, args, opts, child });
    return child;
  }) as unknown as typeof spawn;
  return { spawned, child, spawnFn, runDir };
}

function refusal(e: unknown, pattern: RegExp): boolean {
  assert.ok(e instanceof MultizenError, `not a MultizenError: ${String(e)}`);
  assert.equal(e.code, "DISPLAY_UNAVAILABLE");
  assert.match(e.message, pattern);
  return true;
}

function start(r: ReturnType<typeof rig>, overrides: { timeoutMs?: number } = {}) {
  return startXvfb({ width: 1920, height: 1080, runDir: r.runDir, spawnFn: r.spawnFn, ...overrides });
}

test("the Xauthority record is the exact bytes of a wildcard MIT cookie", () => {
  const cookie = Buffer.alloc(16, 0xab);
  const record = xauthorityRecord(cookie);
  assert.deepEqual(
    record,
    Buffer.concat([
      Buffer.from([0xff, 0xff]), // FamilyWild
      Buffer.from([0x00, 0x00]), // no address
      Buffer.from([0x00, 0x00]), // no display number
      Buffer.from([0x00, 0x12]),
      Buffer.from("MIT-MAGIC-COOKIE-1", "latin1"),
      Buffer.from([0x00, 0x10]),
      cookie,
    ]),
  );
  assert.equal(record.length, 44);
});

test("the journal hears of the server as soon as it exists, before its display, and of its exit", async (t) => {
  const r = rig(t);
  const journal: Array<[string, unknown]> = [];
  const starting = startXvfb({
    width: 100,
    height: 100,
    runDir: r.runDir,
    spawnFn: r.spawnFn,
    journal: {
      profileId: "p",
      processJournal: {
        add: (entry) => journal.push(["add", entry]),
        remove: (pid) => journal.push(["remove", pid]),
      },
    },
  });
  await new Promise((resolve) => {
    const poll = (): void => void (r.spawned.length > 0 ? resolve(null) : setTimeout(poll, 1));
    poll();
  });
  const authFile = r.spawned[0]!.args[r.spawned[0]!.args.indexOf("-auth") + 1];
  assert.equal(journal.length, 1);
  const [verb, entry] = journal[0] as [string, Record<string, unknown>];
  assert.equal(verb, "add");
  assert.equal(entry.kind, "xvfb");
  assert.equal(entry.profileId, "p");
  assert.equal(entry.pid, 4242);
  assert.equal(entry.authFile, authFile);
  r.child.fd3.write("7\n");
  const handle = await starting;
  assert.equal(journal.length, 1);
  await handle.stop();
  assert.deepEqual(journal.at(-1), ["remove", 4242]);
});

test("the auth file's directory is made if it isn't there: a server's lives under its data dir", async (t) => {
  const r = rig(t);
  const runDir = join(r.runDir, "run", "xvfb");
  const starting = startXvfb({ width: 100, height: 100, runDir, spawnFn: r.spawnFn });
  await new Promise((resolve) => {
    const poll = (): void => void (r.spawned.length > 0 ? resolve(null) : setTimeout(poll, 1));
    poll();
  });
  r.child.fd3.write("7\n");
  const handle = await starting;
  assert.ok(handle.authFile.startsWith(join(runDir, "mz-xvfb-")), handle.authFile);
  await handle.stop();
  assert.deepEqual(readdirSync(runDir), []);
});

test("the server runs with the agreed flags: no TCP, its own auth, the fingerprint's screen", async (t) => {
  const r = rig(t);
  const starting = start(r);
  await new Promise((resolve) => setImmediate(resolve));
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const [{ file, args, opts }] = r.spawned as [Spawned];
  assert.equal(file, "Xvfb");
  const authFile = args[args.indexOf("-auth") + 1]!;
  assert.deepEqual(args, [
    "-displayfd",
    "3",
    "-screen",
    "0",
    "1920x1080x24",
    "-nolisten",
    "tcp",
    "-auth",
    authFile,
    "-noreset",
  ]);
  assert.equal(args.includes("-ac"), false, "never open to anyone");
  assert.equal(opts.detached, true);
  assert.deepEqual(Object.keys(opts.env ?? {}), ["PATH"], "only what it needs to find itself");
  assert.deepEqual(opts.stdio, ["ignore", "ignore", "pipe", "pipe"]);

  r.child.fd3.write("7\n");
  const handle = await starting;
  assert.equal(handle.display, ":7");
  assert.equal(handle.pid, 4242);
  assert.equal(handle.authFile, authFile);
  await handle.stop();
});

test("each server has a private auth file holding a fresh 16-byte cookie", async (t) => {
  const r = rig(t);
  const first = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("1\n");
  const a = await first;
  const bytes = readFileSync(a.authFile);
  assert.equal(bytes.length, 44);
  assert.deepEqual(bytes.subarray(0, 28), xauthorityRecord(Buffer.alloc(16)).subarray(0, 28));
  assert.notDeepEqual(bytes.subarray(28), Buffer.alloc(16), "a real cookie");
  if (process.platform !== "win32") {
    assert.equal(statSync(a.authFile).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(a.authFile)).mode & 0o777, 0o700);
  }

  const r2 = rig(t);
  const second = start(r2);
  while (r2.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r2.child.fd3.write("2\n");
  const b = await second;
  assert.notEqual(a.authFile, b.authFile);
  assert.notDeepEqual(readFileSync(b.authFile), bytes);
  await Promise.all([a.stop(), b.stop()]);
});

test("displayfd: a number split across chunks, waiting for its newline", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("1");
  await new Promise((resolve) => setImmediate(resolve));
  r.child.fd3.write("0");
  await new Promise((resolve) => setImmediate(resolve));
  r.child.fd3.write("3\n");
  const handle = await starting;
  assert.equal(handle.display, ":103");
  await handle.stop();
});

test("displayfd: anything but a number is a refusal, and the server goes", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("not-a-display\n");
  await assert.rejects(starting, (e) => refusal(e, /reported "not-a-display"/));
  assert.deepEqual(r.child.signals, ["SIGTERM"]);
  assert.deepEqual(readdirSync(r.runDir), [], "the auth file went too");
});

test("no display in time: a refusal with what it said on stderr, and nothing left behind", async (t) => {
  const r = rig(t);
  const starting = start(r, { timeoutMs: 40 });
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.stderr.write("Fatal server error: cannot open log\n");
  await assert.rejects(starting, (e) => refusal(e, /within 40 ms: Fatal server error/));
  assert.deepEqual(r.child.signals, ["SIGTERM"]);
  assert.deepEqual(readdirSync(r.runDir), []);
});

test("a failed spawn arrives as an error event: a refusal, not an uncaught exception", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  // Node's own order for a missing binary: no pid, then "error", and no "exit" to wait for.
  r.child.exitCode = -2;
  r.child.emit("error", Object.assign(new Error("spawn Xvfb ENOENT"), { code: "ENOENT" }));
  await assert.rejects(starting, (e) => refusal(e, /failed to start: spawn Xvfb ENOENT/));
  assert.deepEqual(readdirSync(r.runDir), []);
});

test("spawn itself throwing is the same refusal", async (t) => {
  const r = rig(t);
  const throwing = (() => {
    throw new Error("EPERM");
  }) as unknown as typeof spawn;
  await assert.rejects(
    startXvfb({ width: 1, height: 1, runDir: r.runDir, spawnFn: throwing }),
    (e) => refusal(e, /failed to start: EPERM/),
  );
  assert.deepEqual(readdirSync(r.runDir), []);
});

test("an exit before announcing is a refusal, carrying the stderr tail, capped at 2 KB", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.stderr.write("x".repeat(5_000));
  r.child.stderr.write("_server already active for display 0\n");
  await new Promise((resolve) => setImmediate(resolve));
  r.child.exitCode = 1;
  r.child.emit("exit", 1, null);
  await assert.rejects(starting, (e) => {
    refusal(e, /exited at once \(1\): x+_server already active/);
    assert.ok((e as Error).message.length < 2_200);
    return true;
  });
  assert.deepEqual(r.child.signals, [], "nothing to signal: it already left");
});

test("stop: SIGTERM, the auth file goes, and a second stop is the same stop", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("9\n");
  const handle = await starting;
  assert.equal(existsSync(handle.authFile), true);

  await Promise.all([handle.stop(), handle.stop()]);
  await handle.stop();
  assert.deepEqual(r.child.signals, ["SIGTERM"]);
  assert.equal(existsSync(handle.authFile), false);
  assert.deepEqual(readdirSync(r.runDir), []);
});

test("stop: a server ignoring SIGTERM gets SIGKILL, and a close can't hang on it", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("9\n");
  const handle = await starting;
  r.child.ignoresTerm = true;
  await handle.stop();
  assert.deepEqual(r.child.signals, ["SIGTERM", "SIGKILL"]);
});

test("stop: a server that already died costs nothing, and its file still goes", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("9\n");
  const handle = await starting;
  r.child.exitCode = 1;
  r.child.emit("exit", 1, null);
  await handle.stop();
  assert.deepEqual(r.child.signals, []);
  assert.equal(existsSync(handle.authFile), false);
});

test("a late error on a running server is swallowed: only the browser's exit path acts on it", async (t) => {
  const r = rig(t);
  const starting = start(r);
  while (r.spawned.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  r.child.fd3.write("9\n");
  const handle = await starting;
  r.child.emit("error", new Error("kill EPERM"));
  await handle.stop();
});

test("hasXvfbBinary: scans the PATH for it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mz-xvfb-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  assert.equal(hasXvfbBinary({ PATH: `${dir}${delimiter}${bin}` }), false);
  writeFileSync(join(bin, "Xvfb"), "#!/bin/sh\n");
  chmodSync(join(bin, "Xvfb"), 0o755);
  assert.equal(hasXvfbBinary({ PATH: `${dir}${delimiter}${bin}` }), true);
  assert.equal(hasXvfbBinary({ PATH: dir }), false);
  assert.equal(hasXvfbBinary({}), false);
});
