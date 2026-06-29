import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Injectable system dependencies for the process-tree helpers. Production code
 * uses {@link defaultProcessTreeDeps} (the real platform / execFile / kill);
 * tests pass fakes so the kill-branch selection and idempotency can be checked
 * deterministically without touching real processes.
 */
export interface ProcessTreeDeps {
  platform: NodeJS.Platform;
  execFileP: typeof execFileP;
  kill: (pid: number, signal?: NodeJS.Signals | number) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultProcessTreeDeps: ProcessTreeDeps = {
  platform: process.platform,
  execFileP,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Parse a whitespace/newline-separated PID list (PowerShell CIM `ProcessId`
 *  output on Windows, `pgrep -P` on Unix), dropping the parent PID itself and
 *  any non-positive / non-numeric token (e.g. a stray header line). */
export function parsePidList(stdout: string, exclude: number): number[] {
  return stdout
    .split(/\s+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== exclude);
}

/** Direct children of `pid`: Windows via PowerShell CIM (Win32_Process), Unix
 *  via pgrep -P. */
export async function listChildPids(
  pid: number,
  deps: ProcessTreeDeps = defaultProcessTreeDeps,
): Promise<number[]> {
  if (deps.platform === "win32") {
    try {
      // wmic was removed in Windows 11 24H2+, so enumerate children via the CIM
      // repository instead. -ExpandProperty ProcessId prints one bare PID per
      // line (no header), which parsePidList consumes directly.
      const { stdout } = await deps.execFileP("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId`,
      ]);
      return parsePidList(stdout, pid);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await deps.execFileP("pgrep", ["-P", String(pid)]);
    return parsePidList(stdout, pid);
  } catch {
    return [];
  }
}

/**
 * Idempotent best-effort kill of an entire process tree rooted at `pid`.
 * Swallows every error (dead PID, missing tool, ESRCH) so it is always safe
 * to call, including repeatedly.
 *   - Windows: `taskkill /PID <pid> /T /F` (non-zero exit on a dead PID — e.g.
 *     code 128 — is expected and swallowed).
 *   - Unix: `process.kill(-pid, "SIGKILL")` to take out the whole group, plus
 *     a recursive `pgrep -P` fallback for any process outside the group.
 */
export async function killProcessTree(
  pid: number | undefined,
  deps: ProcessTreeDeps = defaultProcessTreeDeps,
): Promise<void> {
  if (!pid || pid <= 0) return;
  if (deps.platform === "win32") {
    try {
      await deps.execFileP("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // Already gone / partial tree — taskkill returns non-zero; ignore.
    }
    return;
  }
  try {
    deps.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH (group already gone) or EPERM — ignore.
  }
  await killUnixChildrenRecursive(pid, deps).catch(() => {});
}

/** Unix fallback: walk `pgrep -P` recursively and SIGKILL each descendant. */
export async function killUnixChildrenRecursive(
  pid: number,
  deps: ProcessTreeDeps = defaultProcessTreeDeps,
): Promise<void> {
  const children = await listChildPids(pid, deps).catch(() => [] as number[]);
  for (const c of children) {
    await killUnixChildrenRecursive(c, deps).catch(() => {});
    try {
      deps.kill(c, "SIGKILL");
    } catch {
      // Child already gone — ignore.
    }
  }
}

/**
 * Post-shutdown safety net: find children still parented to `pid` and kill
 * them directly. After a root dies ungracefully its renderers can outlive it
 * (Windows does not reparent), and a tree/group kill keyed on the dead root no
 * longer reaches them. Retried a couple of times; entirely best-effort.
 */
export async function reapOrphans(
  pid: number | undefined,
  deps: ProcessTreeDeps = defaultProcessTreeDeps,
): Promise<void> {
  if (!pid || pid <= 0) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const children = await listChildPids(pid, deps).catch(() => [] as number[]);
    if (children.length === 0) return;
    for (const c of children) {
      await killProcessTree(c, deps).catch(() => {});
    }
    await deps.sleep(150);
  }
}

// ── graceful shutdown orchestration ──────────────────────────────────────────

/** Minimal structural shape of a spawned Chromium child needed for shutdown. */
export interface ShutdownChild {
  exitCode: number | null;
  killed: boolean;
  once(event: "exit", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Minimal structural shape of the CDP session needed for shutdown. */
export interface ShutdownSession {
  closeBrowser(): Promise<void>;
  close(): Promise<void>;
}

export interface ShutdownTarget {
  child: ShutdownChild;
  session: ShutdownSession;
  pid: number;
}

export interface GracefulShutdownDeps {
  platform: NodeJS.Platform;
  sleep: (ms: number) => Promise<void>;
  killProcessTree: (pid: number | undefined) => Promise<void>;
  reapOrphans: (pid: number | undefined) => Promise<void>;
}

const defaultGracefulShutdownDeps: GracefulShutdownDeps = {
  platform: process.platform,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  killProcessTree: (pid) => killProcessTree(pid),
  reapOrphans: (pid) => reapOrphans(pid),
};

/**
 * Shut down a running Chromium child the canonical way: send `Browser.close`
 * over CDP (macOS ⌘Q equivalent — flushes session-restore data), then wait up
 * to `gracefulMs` for the process to exit on its own. If it doesn't, force a
 * tree-kill so no renderer/GPU/utility process is left orphaned:
 *   - Windows: `taskkill /T /F` IS the force mechanism, and it must run while
 *     the named root is still alive (it enumerates children from that root).
 *   - Unix: SIGTERM → SIGKILL the leader, then group-kill in the finally.
 *
 * A `finally` group/tree-kill always runs (idempotent, cheap on a dead tree)
 * so the early-exit and graceful-success paths still reap any stragglers.
 *
 * Idempotent — safe to call from `close()`, `closeAll()`, and the window
 * watcher; repeated calls no-op because the child is already exiting/gone.
 */
export async function gracefulShutdown(
  r: ShutdownTarget,
  opts: { gracefulMs?: number; reap?: boolean } = {},
  deps: GracefulShutdownDeps = defaultGracefulShutdownDeps,
): Promise<void> {
  const isWin = deps.platform === "win32";
  const gracefulMs = opts.gracefulMs ?? 4000;
  const reap = opts.reap ?? true;

  try {
    if (r.child.exitCode !== null || r.child.killed) {
      await r.session.close().catch(() => {});
      return;
    }

    const exited = new Promise<void>((resolve) => {
      if (r.child.exitCode !== null) {
        resolve();
        return;
      }
      r.child.once("exit", () => resolve());
    });

    // Fire Browser.close — websocket disconnects mid-call, that's expected.
    await r.session.closeBrowser().catch(() => {});

    // Wait for graceful exit. Chromium needs ~500ms-2s to flush session-restore;
    // the default 4s gives margin, the quit path passes a shorter budget.
    const exitedInTime = await Promise.race([
      exited.then(() => true),
      deps.sleep(gracefulMs).then(() => false),
    ]);

    await r.session.close().catch(() => {});

    if (!exitedInTime && r.child.exitCode === null && !r.child.killed) {
      if (isWin) {
        // taskkill /T enumerates children starting from the NAMED process, so
        // it has to run while the root is still alive — it is itself the force
        // mechanism (do NOT SIGKILL the root first, that orphans renderers).
        await deps.killProcessTree(r.pid);
      } else {
        r.child.kill("SIGTERM");
        const termExited = await Promise.race([
          exited.then(() => true),
          deps.sleep(Math.min(2000, gracefulMs)).then(() => false),
        ]);
        if (!termExited && r.child.exitCode === null && !r.child.killed) {
          r.child.kill("SIGKILL");
        }
      }
    }
  } finally {
    // Unconditional mop-up. Unix: the process-group kill outlives the leader.
    // Windows: a no-op if the force path already taskkilled, best-effort
    // otherwise. Both are idempotent and cheap on an already-dead tree.
    await deps.killProcessTree(r.pid).catch(() => {});
    if (reap) {
      // Post-check: re-kill any surviving children directly (their PIDs differ
      // from the root, so a taskkill/group-kill on a dead root won't catch
      // them). Skipped on the quit path to stay under the before-quit watchdog.
      await deps.reapOrphans(r.pid).catch(() => {});
    }
  }
}
