import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoLiveDesktop,
  DesktopLockHeldError,
  liveDesktopLockHolder,
  writeDesktopLock,
} from "./desktopLock.ts";
import { processIdentity, type ProcessIdentity, type ServerLockDeps } from "./serverLock.ts";

const SELF_PID = 1000;
const DESKTOP_PID = 2000;
const DESKTOP: ProcessIdentity = { startTime: "desk-start", cmdline: "electron app" };

function deps(table: Record<number, ProcessIdentity | null | Error> = {}): ServerLockDeps {
  const processes: Record<number, ProcessIdentity | null | Error> = {
    [SELF_PID]: { startTime: "self-start", cmdline: "node cli.js serve" },
    [DESKTOP_PID]: DESKTOP,
    ...table,
  };
  return {
    hostname: () => "box",
    pid: SELF_PID,
    processIdentity: async (pid) => {
      const found = processes[pid] ?? null;
      if (found instanceof Error) throw found;
      return found;
    },
  };
}

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-dlock-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeRecord(dir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "desktop.lock"),
    JSON.stringify({
      hostname: "box",
      pid: DESKTOP_PID,
      startTime: DESKTOP.startTime,
      cmdline: DESKTOP.cmdline,
      acquiredAt: "2026-10-31T00:00:00.000Z",
      ...overrides,
    }),
  );
}

test("the desktop writes its pid, start time and host, and takes them away at quit", async () => {
  await withDir(async (dir) => {
    const lock = await writeDesktopLock(join(dir, "data"), {
      ...deps(),
      pid: DESKTOP_PID,
    });
    const stored = JSON.parse(readFileSync(lock.path, "utf8")) as Record<string, unknown>;
    assert.equal(stored.pid, DESKTOP_PID);
    assert.equal(stored.startTime, DESKTOP.startTime);
    assert.equal(stored.cmdline, DESKTOP.cmdline);
    assert.equal(stored.hostname, "box");
    lock.release();
    assert.equal(existsSync(lock.path), false);
    assert.doesNotThrow(() => lock.release());
  });
});

test("a live desktop on this directory refuses the start, and says what to do", async () => {
  await withDir(async (dir) => {
    writeRecord(dir);
    await assert.rejects(assertNoLiveDesktop(dir, deps()), (e: DesktopLockHeldError) => {
      assert.ok(e instanceof DesktopLockHeldError);
      assert.equal(e.holder.pid, DESKTOP_PID);
      assert.match(e.message, /desktop app/);
      assert.match(e.message, /--data-dir/);
      return true;
    });
  });
});

test("a server pointed at the user data dir or at its data dir both find the desktop", async () => {
  await withDir(async (userData) => {
    const dataRoot = join(userData, "data");
    writeRecord(dataRoot);
    await assert.rejects(assertNoLiveDesktop(userData, deps()), DesktopLockHeldError);
    await assert.rejects(assertNoLiveDesktop(dataRoot, deps()), DesktopLockHeldError);
  });
});

test("a stale file is ignored: gone process, reused pid, another program, another host", async () => {
  await withDir(async (dir) => {
    assert.equal(await liveDesktopLockHolder(dir, deps()), null, "no file at all");

    writeRecord(dir);
    assert.equal(await liveDesktopLockHolder(dir, deps({ [DESKTOP_PID]: null })), null, "exited");

    assert.equal(
      await liveDesktopLockHolder(dir, deps({ [DESKTOP_PID]: { ...DESKTOP, startTime: "later" } })),
      null,
      "pid reused by a later process",
    );
    assert.equal(
      await liveDesktopLockHolder(dir, deps({ [DESKTOP_PID]: { ...DESKTOP, cmdline: "notepad" } })),
      null,
      "another program",
    );

    writeRecord(dir, { hostname: "other-box" });
    assert.equal(await liveDesktopLockHolder(dir, deps()), null, "written on another machine");

    writeRecord(dir, { pid: SELF_PID });
    assert.equal(await liveDesktopLockHolder(dir, deps()), null, "our own pid: the holder is gone");

    writeFileSync(join(dir, "desktop.lock"), "not json");
    assert.equal(await liveDesktopLockHolder(dir, deps()), null, "nothing a desktop wrote");
    await assert.doesNotReject(assertNoLiveDesktop(dir, deps()));
  });
});

test("when the OS can't say, it counts as held: refusing is the recoverable mistake", async () => {
  await withDir(async (dir) => {
    writeRecord(dir);
    const unsure = deps({ [DESKTOP_PID]: new Error("no ps here") });
    assert.equal((await liveDesktopLockHolder(dir, unsure))?.pid, DESKTOP_PID);
  });
});

test("against a real process: held while it runs, stale once it has gone", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await withDir(async (dir) => {
    const identity = await processIdentity(child.pid!);
    assert.ok(identity);
    writeFileSync(
      join(dir, "desktop.lock"),
      JSON.stringify({
        hostname: (await import("node:os")).hostname(),
        pid: child.pid,
        startTime: identity.startTime,
        cmdline: identity.cmdline,
        acquiredAt: new Date().toISOString(),
      }),
    );
    await assert.rejects(assertNoLiveDesktop(dir), DesktopLockHeldError);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
    await assert.doesNotReject(assertNoLiveDesktop(dir));
  }).finally(() => child.kill());
});
