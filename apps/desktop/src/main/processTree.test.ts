import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  parsePidList,
  listChildPids,
  killProcessTree,
  reapOrphans,
  gracefulShutdown,
  type ProcessTreeDeps,
  type GracefulShutdownDeps,
  type ShutdownTarget,
} from "./processTree.ts";

/**
 * Pure-logic + branch-selection coverage for the process-tree termination
 * helpers. All OS interaction (execFile, process.kill, platform, sleep) is
 * injected, so we can assert the Windows vs Unix kill branches, idempotent
 * error-swallowing, recursion, and graceful→force fallback ordering without
 * touching real processes.
 */

interface ExecCall {
  file: string;
  args: readonly string[];
}

function makeProcDeps(opts: {
  platform: NodeJS.Platform;
  exec?: (file: string, args: readonly string[], index: number) => { stdout: string; stderr: string };
  killThrows?: (pid: number) => boolean;
}): {
  deps: ProcessTreeDeps;
  execCalls: ExecCall[];
  killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }>;
  sleeps: number[];
} {
  const execCalls: ExecCall[] = [];
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  const sleeps: number[] = [];
  let index = 0;
  const deps: ProcessTreeDeps = {
    platform: opts.platform,
    execFileP: (async (file: string, args: readonly string[]) => {
      const i = index++;
      execCalls.push({ file, args });
      if (!opts.exec) throw new Error("no exec fake configured");
      return opts.exec(file, args, i);
    }) as unknown as ProcessTreeDeps["execFileP"],
    kill: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      if (opts.killThrows?.(pid)) throw new Error("ESRCH");
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, execCalls, killCalls, sleeps };
}

// ── parsePidList (pure) ──────────────────────────────────────────────────────

test("parsePidList parses PowerShell CIM output (one pid per line) and drops the parent pid", () => {
  // PowerShell `-ExpandProperty ProcessId` prints bare numbers, one per line.
  assert.deepEqual(parsePidList("1234\r\n5678\r\n", 9999), [1234, 5678]);
  assert.deepEqual(parsePidList("100 200 300", 200), [100, 300]);
});

test("parsePidList parses pgrep output (newline separated)", () => {
  assert.deepEqual(parsePidList("111\n222\n", 0), [111, 222]);
});

test("parsePidList filters non-positive, non-numeric, and empty tokens", () => {
  assert.deepEqual(parsePidList("  \n -5 0 abc 42 \n", 1), [42]);
  assert.deepEqual(parsePidList("", 1), []);
  assert.deepEqual(parsePidList("   \n  ", 1), []);
});

// ── killProcessTree branch selection + idempotency ───────────────────────────

test("killProcessTree on Windows uses taskkill /T /F and never process.kill", async () => {
  const { deps, execCalls, killCalls } = makeProcDeps({
    platform: "win32",
    exec: () => ({ stdout: "", stderr: "" }),
  });
  await killProcessTree(1234, deps);
  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0], { file: "taskkill", args: ["/PID", "1234", "/T", "/F"] });
  assert.equal(killCalls.length, 0, "Windows must not send POSIX signals");
});

test("killProcessTree swallows a non-zero/throwing taskkill (dead pid, missing tool)", async () => {
  const { deps, execCalls } = makeProcDeps({
    platform: "win32",
    exec: () => {
      throw new Error("taskkill: process not found (128)");
    },
  });
  await assert.doesNotReject(killProcessTree(4321, deps));
  assert.equal(execCalls.length, 1);
});

test("killProcessTree on Unix group-kills the leader then recurses children", async () => {
  // pgrep -P 1234 -> [1235, 1236]; both leaves have no children.
  const { deps, killCalls } = makeProcDeps({
    platform: "linux",
    exec: (_file, args) => {
      const parent = args[args.length - 1];
      if (parent === "1234") return { stdout: "1235\n1236\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  await killProcessTree(1234, deps);
  assert.deepEqual(
    killCalls,
    [
      { pid: -1234, signal: "SIGKILL" },
      { pid: 1235, signal: "SIGKILL" },
      { pid: 1236, signal: "SIGKILL" },
    ],
    "group kill of the leader, then each descendant individually",
  );
});

test("killProcessTree on Unix swallows ESRCH from a dead group leader", async () => {
  const { deps, killCalls } = makeProcDeps({
    platform: "linux",
    exec: () => ({ stdout: "", stderr: "" }),
    killThrows: (pid) => pid === -777,
  });
  await assert.doesNotReject(killProcessTree(777, deps));
  assert.deepEqual(killCalls, [{ pid: -777, signal: "SIGKILL" }]);
});

test("killProcessTree is a no-op for a missing/invalid pid", async () => {
  const { deps, execCalls, killCalls } = makeProcDeps({
    platform: "win32",
    exec: () => ({ stdout: "", stderr: "" }),
  });
  await killProcessTree(undefined, deps);
  await killProcessTree(0, deps);
  await killProcessTree(-3, deps);
  assert.equal(execCalls.length, 0);
  assert.equal(killCalls.length, 0);
});

// ── listChildPids ────────────────────────────────────────────────────────────

test("listChildPids issues the PowerShell CIM query on Windows and parses the result", async () => {
  const { deps, execCalls } = makeProcDeps({
    platform: "win32",
    exec: () => ({ stdout: "10\r\n20\r\n", stderr: "" }),
  });
  const pids = await listChildPids(99, deps);
  assert.deepEqual(pids, [10, 20]);
  assert.equal(execCalls[0]!.file, "powershell.exe");
  assert.deepEqual(execCalls[0]!.args, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process -Filter 'ParentProcessId=99' | Select-Object -ExpandProperty ProcessId",
  ]);
});

test("listChildPids returns [] when PowerShell is unavailable (wmic removed on 24H2+)", async () => {
  const { deps, execCalls } = makeProcDeps({
    platform: "win32",
    exec: () => {
      throw new Error("'powershell.exe' is not recognized as a command");
    },
  });
  assert.deepEqual(await listChildPids(99, deps), []);
  assert.equal(execCalls[0]!.file, "powershell.exe", "the PowerShell child query was attempted");
});

test("listChildPids issues pgrep -P on Unix and returns [] when none / on error", async () => {
  const ok = makeProcDeps({
    platform: "linux",
    exec: () => ({ stdout: "30\n40\n", stderr: "" }),
  });
  assert.deepEqual(await listChildPids(7, ok.deps), [30, 40]);
  assert.deepEqual(ok.execCalls[0], { file: "pgrep", args: ["-P", "7"] });

  const err = makeProcDeps({
    platform: "linux",
    exec: () => {
      throw new Error("pgrep: no matches (exit 1)");
    },
  });
  assert.deepEqual(await listChildPids(7, err.deps), []);
});

// ── reapOrphans retry semantics ──────────────────────────────────────────────

test("reapOrphans kills surviving children, then stops once none remain", async () => {
  // First sweep finds child 50; second sweep finds none -> stop after one kill.
  const { deps, execCalls, sleeps } = makeProcDeps({
    platform: "win32",
    exec: (file, _args, i) => {
      if (file === "powershell.exe") return { stdout: i === 0 ? "50\r\n" : "", stderr: "" };
      return { stdout: "", stderr: "" }; // taskkill
    },
  });
  await reapOrphans(123, deps);
  const taskkills = execCalls.filter((c) => c.file === "taskkill");
  assert.equal(taskkills.length, 1, "child 50 killed exactly once");
  assert.deepEqual(taskkills[0]!.args, ["/PID", "50", "/T", "/F"]);
  assert.equal(sleeps.length, 1, "one backoff between the two sweeps");
});

test("reapOrphans gives up after 2 attempts when children persist", async () => {
  const { deps, execCalls, sleeps } = makeProcDeps({
    platform: "win32",
    exec: (file) => {
      if (file === "powershell.exe") return { stdout: "50\r\n", stderr: "" }; // always one child
      return { stdout: "", stderr: "" };
    },
  });
  await reapOrphans(123, deps);
  const taskkills = execCalls.filter((c) => c.file === "taskkill");
  assert.equal(taskkills.length, 2, "two attempts, one kill each");
  assert.equal(sleeps.length, 2);
});

test("reapOrphans stays a safe no-op when child enumeration fails (powershell removed)", async () => {
  // wmic-removed / 24H2: powershell throws -> listChildPids -> [] -> reapOrphans
  // finds nothing to kill and does not reject (idempotency preserved).
  const { deps, execCalls, sleeps } = makeProcDeps({
    platform: "win32",
    exec: (file) => {
      if (file === "powershell.exe") throw new Error("powershell.exe unavailable");
      return { stdout: "", stderr: "" };
    },
  });
  await assert.doesNotReject(reapOrphans(123, deps));
  assert.equal(execCalls.filter((c) => c.file === "taskkill").length, 0, "nothing to reap");
  assert.equal(sleeps.length, 0, "returns on the first empty sweep");
});

test("reapOrphans is a no-op for a missing/invalid pid", async () => {
  const { deps, execCalls } = makeProcDeps({ platform: "linux", exec: () => ({ stdout: "", stderr: "" }) });
  await reapOrphans(undefined, deps);
  await reapOrphans(0, deps);
  assert.equal(execCalls.length, 0);
});

// ── gracefulShutdown orchestration ───────────────────────────────────────────

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly killCalls: Array<NodeJS.Signals | undefined> = [];
  override once(event: "exit", listener: () => void): this {
    return super.once(event, listener);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return true;
  }
  simulateExit(code = 0): void {
    this.exitCode = code;
    this.emit("exit");
  }
}

function makeSession(onCloseBrowser?: () => void) {
  const calls: string[] = [];
  return {
    calls,
    closeBrowser: async (): Promise<void> => {
      calls.push("closeBrowser");
      onCloseBrowser?.();
    },
    close: async (): Promise<void> => {
      calls.push("close");
    },
  };
}

function makeGsDeps(
  platform: NodeJS.Platform,
  sleepImpl?: (ms: number) => Promise<void>,
): { deps: GracefulShutdownDeps; kt: Array<number | undefined>; ro: Array<number | undefined> } {
  const kt: Array<number | undefined> = [];
  const ro: Array<number | undefined> = [];
  const deps: GracefulShutdownDeps = {
    platform,
    sleep: sleepImpl ?? (async () => {}),
    killProcessTree: async (pid) => {
      kt.push(pid);
    },
    reapOrphans: async (pid) => {
      ro.push(pid);
    },
  };
  return { deps, kt, ro };
}

test("gracefulShutdown early-returns for an already-exited child but still tree-kills in finally", async () => {
  const child = new FakeChild();
  child.exitCode = 0; // already dead
  const session = makeSession();
  const { deps, kt, ro } = makeGsDeps("win32");
  const target = { child, session, pid: 555 } as unknown as ShutdownTarget;

  await gracefulShutdown(target, {}, deps);

  assert.ok(session.calls.includes("close"));
  assert.ok(!session.calls.includes("closeBrowser"), "no Browser.close on an already-dead child");
  assert.equal(child.killCalls.length, 0);
  assert.deepEqual(kt, [555], "finally tree-kill must run despite the early return");
  assert.deepEqual(ro, [555]);
});

test("gracefulShutdown on Windows force-kills via taskkill (no SIGTERM/SIGKILL on root)", async () => {
  const child = new FakeChild(); // never exits
  const session = makeSession();
  const { deps, kt, ro } = makeGsDeps("win32"); // instant sleep -> grace times out at once
  const target = { child, session, pid: 4242 } as unknown as ShutdownTarget;

  await gracefulShutdown(target, { gracefulMs: 10 }, deps);

  assert.ok(session.calls.includes("closeBrowser"), "Browser.close attempted first");
  assert.equal(child.killCalls.length, 0, "Windows must not POSIX-signal the root");
  assert.ok(kt.length >= 1 && kt.every((p) => p === 4242), "killProcessTree(root) is the force path");
});

test("gracefulShutdown on Unix escalates SIGTERM -> SIGKILL, then group-kills in finally", async () => {
  const child = new FakeChild(); // never exits
  const session = makeSession();
  const { deps, kt, ro } = makeGsDeps("linux"); // instant sleeps
  const target = { child, session, pid: 909 } as unknown as ShutdownTarget;

  await gracefulShutdown(target, { gracefulMs: 10 }, deps);

  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(kt, [909], "the group-kill runs unconditionally in finally");
  assert.deepEqual(ro, [909]);
});

test("gracefulShutdown skips the force path when the child exits during grace", async () => {
  const child = new FakeChild();
  // Browser.close makes Chromium exit gracefully.
  const session = makeSession(() => child.simulateExit(0));
  // Slow sleep so the (already-resolved) exit wins the race deterministically.
  const { deps, kt, ro } = makeGsDeps("linux", () => new Promise((r) => setTimeout(r, 1000)));
  const target = { child, session, pid: 31 } as unknown as ShutdownTarget;

  await gracefulShutdown(target, { gracefulMs: 4000 }, deps);

  assert.equal(child.killCalls.length, 0, "no SIGTERM/SIGKILL when it exited on its own");
  assert.deepEqual(kt, [31], "finally still does an idempotent mop-up tree-kill");
  assert.deepEqual(ro, [31]);
});

test("gracefulShutdown quit path (reap:false) tree-kills but skips the orphan post-check", async () => {
  const child = new FakeChild();
  child.exitCode = 0;
  const session = makeSession();
  const { deps, kt, ro } = makeGsDeps("win32");
  const target = { child, session, pid: 77 } as unknown as ShutdownTarget;

  await gracefulShutdown(target, { gracefulMs: 1500, reap: false }, deps);

  assert.deepEqual(kt, [77]);
  assert.deepEqual(ro, [], "reap:false must not run reapOrphans (stays under the quit watchdog)");
});
