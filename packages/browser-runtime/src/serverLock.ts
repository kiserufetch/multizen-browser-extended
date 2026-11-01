import { execFile } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const LOCK_FILE = "server.lock";
const ACQUIRE_ATTEMPTS = 3;

export type ServerLockMode = "serve" | "stdio" | "cli";

/** What `<data-dir>/server.lock` holds. */
export interface ServerLockRecord {
  hostname: string;
  pid: number;
  /** Platform-native process start time. Opaque, only compared for equality. */
  startTime: string;
  /** The holder's command line as the OS reports it; null if it was unreadable. */
  cmdline: string | null;
  mode: ServerLockMode;
  /** `serve` only: where a `stdio --connect` proxy can reach the holder. */
  url?: string;
  /** `serve` only: the owner token's path, so the hint can name it. */
  tokenFile?: string;
  acquiredAt: string;
}

export interface ProcessIdentity {
  startTime: string;
  /** Null when the OS hides another user's command line. */
  cmdline: string | null;
}

export interface ServerLockDeps {
  hostname: () => string;
  pid: number;
  /** Null when no such process exists; throws when it cannot tell. */
  processIdentity: (pid: number) => Promise<ProcessIdentity | null>;
}

/** A live process holds the data dir. */
export class ServerLockHeldError extends Error {
  readonly holder: ServerLockRecord;

  constructor(dataDir: string, holder: ServerLockRecord) {
    super(
      `Data directory ${dataDir} is in use by another MultiZen server ` +
        `(pid ${holder.pid}, mode ${holder.mode}, since ${holder.acquiredAt}).`,
    );
    this.name = "ServerLockHeldError";
    this.holder = holder;
  }
}

export interface ServerLock {
  readonly path: string;
  readonly record: ServerLockRecord;
  /** Removes the file if it is still ours. Safe to call repeatedly. */
  release(): void;
}

function parseLinuxIdentity(stat: string, cmdline: Buffer): ProcessIdentity | null {
  // comm may contain spaces and parens, so fields are counted from the last ")":
  // state is field 3 and starttime field 22 of proc_pid_stat(5).
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const startTime = fields[19];
  // A zombie has exited: it only waits for its parent to reap it.
  if (!startTime || state === "Z") return null;
  return { startTime, cmdline: cmdline.toString("utf8").split("\0").join(" ").trim() };
}

async function windowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    "if ($p) { @{ start = $p.CreationDate.ToUniversalTime().ToString('o'); cmd = $p.CommandLine } | ConvertTo-Json -Compress }";
  const { stdout } = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
  const text = stdout.trim();
  if (!text) return null;
  const parsed = JSON.parse(text) as { start: string; cmd: string | null };
  return { startTime: parsed.start, cmdline: parsed.cmd };
}

async function psProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const { stdout } = await execFileP("ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)]);
    const line = stdout.trim();
    if (!line) return null;
    // lstart is a fixed 24 characters ("Sat Oct 31 12:00:00 2026").
    return { startTime: line.slice(0, 24), cmdline: line.slice(24).trim() };
  } catch (e) {
    // ps exits 1 when the pid does not exist; anything else means it cannot tell.
    if ((e as { code?: unknown }).code === 1) return null;
    throw e;
  }
}

/** Start time and command line of a process, from the OS. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  if (process.platform === "linux") {
    try {
      return parseLinuxIdentity(
        readFileSync(`/proc/${pid}/stat`, "utf8"),
        readFileSync(`/proc/${pid}/cmdline`),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  return psProcessIdentity(pid);
}

const defaultDeps: ServerLockDeps = {
  hostname,
  pid: process.pid,
  processIdentity,
};

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function parseRecord(raw: string): ServerLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerLockRecord> | null;
    if (
      parsed &&
      typeof parsed.hostname === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startTime === "string"
    ) {
      return parsed as ServerLockRecord;
    }
  } catch {
    // Not JSON: nobody can have written this as a live lock.
  }
  return null;
}

/**
 * Whether the recorded process still holds the lock. Stale means: another host,
 * our own pid (a container restart hands the same low pid back), no such process,
 * or a pid since reused by a different program or a later start. The hostname is
 * no proof on its own, since compose fixes it. When the OS cannot answer, the lock
 * counts as held: refusing is recoverable, two servers on one dir are not.
 */
async function holderIsAlive(record: ServerLockRecord, deps: ServerLockDeps): Promise<boolean> {
  if (record.hostname !== deps.hostname()) return false;
  if (record.pid === deps.pid) return false;
  let identity: ProcessIdentity | null;
  try {
    identity = await deps.processIdentity(record.pid);
  } catch {
    return true;
  }
  if (!identity || identity.startTime !== record.startTime) return false;
  return identity.cmdline === null || record.cmdline === null || identity.cmdline === record.cmdline;
}

/**
 * The record of a live server holding this data dir, or null. Touches no process
 * and spawns nothing when the file is absent, so a desktop whose user data dir
 * never served pays one failed read. An unreadable file is no holder: this guards
 * a startup that must otherwise stay as it was, so it must not become its failure.
 */
export async function liveServerLockHolder(
  dataDir: string,
  deps: ServerLockDeps = defaultDeps,
): Promise<ServerLockRecord | null> {
  let raw: string | null;
  try {
    raw = readRaw(lockPath(dataDir));
  } catch {
    return null;
  }
  if (raw === null) return null;
  const record = parseRecord(raw);
  if (!record) return null;
  return (await holderIsAlive(record, deps)) ? record : null;
}

/** Atomically creates the lock, whole: a reader never sees a half-written file. */
function tryCreate(path: string, content: string, pid: number): boolean {
  const staged = `${path}.${pid}.new`;
  writeFileSync(staged, content);
  try {
    linkSync(staged, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // A filesystem without hard links: exclusive create still excludes others.
    try {
      writeFileSync(path, content, { flag: "wx" });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e2;
    }
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Removes a lock judged stale, but only the file that was judged. Two processes
 * can both find the same stale lock: the rename is atomic, so the loser ends up
 * holding the winner's fresh lock, notices the content changed and puts it back.
 */
function removeIfUnchanged(path: string, judged: string, pid: number): boolean {
  const claim = `${path}.${pid}.stale`;
  try {
    renameSync(path, claim);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  const seen = readFileSync(claim, "utf8");
  if (seen === judged) {
    unlinkSync(claim);
    return true;
  }
  try {
    linkSync(claim, path);
  } catch {
    // A third process got in first; that one holds the lock now.
  }
  unlinkSync(claim);
  return false;
}

/**
 * Takes `<data-dir>/server.lock`. Must come before anything that assumes the
 * directory is ours: reaping, a stale-lock sweep, the database. Throws
 * {@link ServerLockHeldError} if a live process holds it.
 */
export async function acquireServerLock(
  dataDir: string,
  opts: { mode: ServerLockMode; url?: string; tokenFile?: string },
  deps: ServerLockDeps = defaultDeps,
): Promise<ServerLock> {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);

  const own = await deps.processIdentity(deps.pid);
  if (!own) throw new Error(`Cannot read the identity of this process (pid ${deps.pid})`);
  const record: ServerLockRecord = {
    hostname: deps.hostname(),
    pid: deps.pid,
    startTime: own.startTime,
    cmdline: own.cmdline,
    mode: opts.mode,
    url: opts.url,
    tokenFile: opts.tokenFile,
    acquiredAt: new Date().toISOString(),
  };
  const content = JSON.stringify(record, null, 2);

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (tryCreate(path, content, deps.pid)) {
      return {
        path,
        record,
        release: () => {
          try {
            if (readRaw(path) === content) unlinkSync(path);
          } catch {
            // Best effort: a lock left behind reads as stale once we are gone.
          }
        },
      };
    }
    const raw = readRaw(path);
    if (raw === null) continue;
    const existing = parseRecord(raw);
    if (existing && (await holderIsAlive(existing, deps))) {
      throw new ServerLockHeldError(dataDir, existing);
    }
    if (!removeIfUnchanged(path, raw, deps.pid)) {
      const winner = parseRecord(readRaw(path) ?? "");
      if (winner) throw new ServerLockHeldError(dataDir, winner);
    }
  }
  throw new Error(`Could not acquire ${path} after ${ACQUIRE_ATTEMPTS} attempts`);
}
