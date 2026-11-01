import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxInstructions } from "@multizen/browser-runtime";
import type { BrowserEngine } from "@multizen/types";
import { log } from "./log.ts";

/** This machine can't serve from this data dir at all: reported at start, not at each launch. */
export class SandboxPreflightError extends Error {}

export interface PreflightDeps {
  platform: NodeJS.Platform;
  getuid: () => number;
  pid: number;
  /** Just the two calls this file makes, with what it reads of their results. */
  spawnSync: (
    command: string,
    args: readonly string[],
  ) => { status: number | null; error?: Error; stderr?: unknown };
  warn: (message: string, fields?: Record<string, unknown>) => void;
  instructions: () => string;
  /** The directory's permission bits. */
  modeOf: (path: string) => number;
}

const defaultDeps: PreflightDeps = {
  platform: process.platform,
  getuid: () => process.getuid?.() ?? -1,
  pid: process.pid,
  spawnSync: (command, args) => spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }),
  warn: (message, fields) => log.warn(message, fields),
  instructions: () => sandboxInstructions(),
  modeOf: (path) => statSync(path).mode & 0o777,
};

/** The same steps Chromium's namespace sandbox takes when it starts. */
const USERNS_PROBE = ["--user", "--map-root-user", "--pid", "--net", "--fork", "true"];
const EXEC_PROBE_SCRIPT = "#!/bin/sh\nexit 0\n";

/**
 * The engines live in the data dir, and each profile keeps its state there, so a volume
 * that is read-only, someone else's or mounted `noexec` would otherwise show up later as
 * a download that can't finish or a launch failing with EACCES.
 */
function checkDataVolume(dataDir: string, deps: PreflightDeps): void {
  const probe = join(dataDir, `.mz-preflight-${deps.pid}`);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // Left as it is: a directory someone made open on purpose may have a reason. It gets said.
    const mode = deps.modeOf(dataDir);
    if ((mode & 0o077) !== 0) {
      deps.warn(
        `The data directory ${dataDir} can be read by other users (mode ${mode.toString(8)}), and it ` +
          "holds tokens, keys and browser sessions. Run chmod 700 on it, or keep this host to one tenant.",
        { dataDir },
      );
    }
    writeFileSync(probe, EXEC_PROBE_SCRIPT);
    chmodSync(probe, 0o755);
  } catch (e) {
    throw new SandboxPreflightError(
      `The data directory ${dataDir} is not writable by this user (uid ${deps.getuid()}): ` +
        `${(e as Error).message}. Fix the volume's ownership, or point --data-dir at one that is.`,
    );
  }
  try {
    const run = deps.spawnSync(probe, []);
    if (run.error || run.status !== 0) {
      const why = run.error ? run.error.message : `it exited ${run.status}`;
      throw new SandboxPreflightError(
        `The data directory ${dataDir} can't run programs (${why}), and the browser engines live there. ` +
          "Remount its volume without noexec, or point --data-dir at one that allows it.",
      );
    }
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * What must hold before this process touches anything else, the lock included: not
 * root, and a data dir it can write to and run from. Linux only.
 */
export function preflightProcess(dataDir: string, deps: PreflightDeps = defaultDeps): void {
  if (deps.platform !== "linux") return;
  if (deps.getuid() === 0) {
    throw new SandboxPreflightError(
      "This server does not run as root: Chromium refuses to start its sandbox as root, and it is " +
        "never turned off here. Run as a non-root user, as the Docker image does.",
    );
  }
  checkDataVolume(dataDir, deps);
}

/** Camoufox needs no user namespaces: its spike ran under Docker's default seccomp. */
function needsUserNamespaces(engine: BrowserEngine): boolean {
  return engine !== "camoufox";
}

/**
 * Warns, rather than refuses, when user namespaces look unavailable to an engine in use.
 * A per-binary AppArmor profile lets the engine through while this probe stays denied, so
 * a failure here proves nothing: a launch that really can't start its sandbox still fails,
 * with SANDBOX_UNAVAILABLE and these same instructions.
 */
export function preflightUserNamespaces(
  engines: Iterable<BrowserEngine>,
  deps: PreflightDeps = defaultDeps,
): void {
  if (deps.platform !== "linux") return;
  if (![...engines].some(needsUserNamespaces)) return;
  const probe = deps.spawnSync("unshare", USERNS_PROBE);
  if (!probe.error && probe.status === 0) return;
  const detail = probe.error ? probe.error.message : String(probe.stderr ?? "").trim();
  deps.warn(
    `User namespaces look unavailable, so Chromium's sandbox may not start and its launches would ` +
      `fail with SANDBOX_UNAVAILABLE. ${deps.instructions()}`,
    { probe: `unshare ${USERNS_PROBE.join(" ")}`, detail },
  );
}
