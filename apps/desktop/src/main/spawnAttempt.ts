/**
 * One engine spawn + CDP readiness attempt, and the startup-window exit guard,
 * extracted from `ChromiumBrowserDriver.launch()`. Spawning, readiness, the CDP
 * session and the tree-kill are injected so the failure paths (spawn errors,
 * sandbox crash, a probe abandoned mid-connect, a child dying mid-bootstrap)
 * can be exercised without a real Chromium.
 */

/** Chromium stderr signatures that mean the user-namespace sandbox could not
 *  start (so a relaunch with --no-sandbox is warranted). Kept to failure-only
 *  phrases — a generic token like CLONE_NEWUSER could appear on a healthy
 *  launch and must NOT trigger the backstop. The backstop also requires the
 *  child to have actually exited, so a stray match alone can't disable the
 *  sandbox. */
export const SANDBOX_FAILURE_RE = /No usable sandbox|Failed to move to new (?:user )?namespace/i;

/** Thrown by the spawn attempt when the sandbox failed to start, so the caller
 *  can relaunch once with --no-sandbox (never re-prompting). */
export class SandboxStartupError extends Error {}

/** The engine binary could not be started at all: missing, not executable, or
 *  blocked (e.g. quarantined by antivirus). Shown to the user as the launch
 *  error, so it names the binary and the OS error code. */
export class EngineSpawnError extends Error {
  constructor(binaryPath: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? String(cause);
    super(
      `Failed to start Chromium (${code}): ${binaryPath} — the binary may be missing, ` +
        "not executable, or blocked by antivirus.",
      { cause },
    );
  }
}

/** Minimal structural shape of the spawned engine child used during launch. */
export interface LaunchChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

/** Minimal structural shape of the CDP session needed to abandon an attempt. */
export interface LaunchSession {
  close(): Promise<void>;
}

export interface AttemptSpawnDeps<C extends LaunchChild, S extends LaunchSession> {
  /** Spawn the engine. May throw synchronously: Node throws EPERM / UNKNOWN
   *  (e.g. an antivirus block on Windows) instead of emitting `error`. */
  spawn: () => C;
  createSession: () => S;
  /** Readiness probe for `session`. Must stop, and never connect `session`,
   *  once `signal` aborts (see waitForCdpSessionReady). */
  waitForReady: (session: S, signal: AbortSignal) => Promise<void>;
  killProcessTree: (pid: number | undefined) => Promise<void>;
  /** Sink for forwarded stderr lines and exit breadcrumbs. */
  log: (line: string) => void;
}

/** Whether `child` has exited. Node records the exit status before emitting
 *  `exit`, so this is also true for an exit whose event already fired. */
export function hasExited(child: Pick<LaunchChild, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Spawn the engine and wait for CDP readiness, racing a confirmed sandbox
 * crash and spawn errors so either aborts at once instead of waiting out the
 * readiness budget. On failure the half-launched browser is torn down here;
 * the caller stops the socks5 bridge (same order as close()).
 */
export async function attemptSpawn<C extends LaunchChild, S extends LaunchSession>(
  binaryPath: string,
  deps: AttemptSpawnDeps<C, S>,
): Promise<{ child: C; session: S }> {
  let child: C;
  try {
    child = deps.spawn();
  } catch (e) {
    throw new EngineSpawnError(binaryPath, e);
  }
  // Everything that fails the attempt before readiness — a spawn error or a
  // confirmed sandbox crash — rejects this; it is raced against readiness below.
  let failAttempt: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    failAttempt = reject;
  });
  // Registered first and kept for the child's lifetime: an `error` event with
  // no listener is an uncaught exception in the Electron main process. Node
  // emits it — with no pid and no `exit` — on the next tick when the binary is
  // missing or not executable, and later if a kill() is refused.
  child.on("error", (err) => {
    deps.log(`[multizen] Chromium process error: ${err.message}`);
    failAttempt(new EngineSpawnError(binaryPath, err));
  });
  const pid = child.pid;
  // No pid means the spawn failed and the `error` above is already queued;
  // wait for it so the rejection carries the OS error code.
  if (pid === undefined) return failed;

  // Treat as a sandbox crash ONLY when the FATAL signature appeared on
  // stderr AND the child actually exited (either event may land first). A
  // bare early exit, or a stray signature on a healthy child, is NOT a
  // sandbox crash.
  let sawSandboxCrash = false;
  const signalCrashIfConfirmed = (): void => {
    if (sawSandboxCrash && hasExited(child)) failAttempt(new SandboxStartupError());
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8").trim();
    if (!line) return;
    if (SANDBOX_FAILURE_RE.test(line)) {
      sawSandboxCrash = true;
      signalCrashIfConfirmed();
    }
    deps.log(`[chromium ${pid}] ${line}`);
  });
  child.on("exit", (code, signal) => {
    // First-line breadcrumb — the driver's record also handles running-changed
    // teardown once the launch completes.
    if (code !== 0 && code !== null) {
      deps.log(`[multizen] Chromium pid ${pid} exited code=${code} signal=${signal ?? "-"}`);
    }
    signalCrashIfConfirmed();
  });

  const session = deps.createSession();
  const probe = new AbortController();
  const ready = deps.waitForReady(session, probe.signal);
  try {
    await Promise.race([ready, failed]);
  } catch (e) {
    // Tear down the half-launched browser — it isn't tracked by the driver
    // yet, so kill the spawned tree directly. Then stop the probe and let it
    // settle BEFORE closing the session: left running, it keeps polling this
    // port and, once the caller relaunches on the same port, connects this
    // closed session to the new browser — an extra CDP client (with its own
    // dialog handler) that nothing ever closes.
    probe.abort();
    await deps.killProcessTree(pid);
    await ready.catch(() => {});
    await session.close().catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }
  return { child, session };
}

/**
 * Await `work` (the post-readiness startup, e.g. the CDP target bootstrap)
 * unless `child` exits first. Resolves true when `work` settled with the child
 * still running, false when the child exited — including an exit that already
 * happened, whose `exit` event no listener registered now would ever see. A
 * rejection from `work` propagates.
 */
export async function awaitWhileAlive(child: LaunchChild, work: Promise<unknown>): Promise<boolean> {
  if (hasExited(child)) return false;
  let onExit = (): void => {};
  const exited = new Promise<false>((resolve) => {
    onExit = () => resolve(false);
  });
  child.once("exit", onExit);
  try {
    return await Promise.race([work.then(() => true as const), exited]);
  } finally {
    child.off("exit", onExit);
  }
}
