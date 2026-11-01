import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { hashOfCmdline, holderIsAlive, processIdentity, type ServerLockDeps } from "./serverLock.ts";

const DESKTOP_LOCK_FILE = "desktop.lock";
/** Where a desktop keeps its database and profiles, under its user data directory. */
const DESKTOP_DATA_SUBDIR = "data";

export interface DesktopLockRecord {
  hostname: string;
  pid: number;
  /** Platform-native process start time. Opaque, only compared for equality. */
  startTime: string;
  /** Only compared too, so only its hash is kept, as in `server.lock`. */
  cmdlineSha256: string | null;
  /** The clear form an earlier version wrote: such a file can outlive that version's crash. */
  cmdline?: string | null;
  acquiredAt: string;
}

/** A live desktop app holds this directory, and a server here would kill its browsers. */
export class DesktopLockHeldError extends Error {
  readonly holder: DesktopLockRecord;

  constructor(dataDir: string, holder: DesktopLockRecord) {
    super(
      `Data directory ${dataDir} is in use by the MultiZen desktop app (pid ${holder.pid}). ` +
        "A server here would take its browsers for leftovers and kill them. " +
        "Quit the app, or point this server at another --data-dir.",
    );
    this.name = "DesktopLockHeldError";
    this.holder = holder;
  }
}

const defaultDeps: ServerLockDeps = { hostname, pid: process.pid, processIdentity };

/**
 * Says a desktop app is using this directory. Advisory: only `multizen-server` reads it, and a
 * desktop that dies without removing it leaves a file that reads as stale. The desktop keeps
 * no lock of its own, as it has its own single-instance handling.
 */
export async function writeDesktopLock(
  dataDir: string,
  deps: ServerLockDeps = defaultDeps,
): Promise<{ path: string; release(): void }> {
  const own = await deps.processIdentity(deps.pid);
  if (!own) throw new Error(`Cannot read the identity of this process (pid ${deps.pid})`);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, DESKTOP_LOCK_FILE);
  const record: DesktopLockRecord = {
    hostname: deps.hostname(),
    pid: deps.pid,
    startTime: own.startTime,
    cmdlineSha256: own.cmdline === null ? null : hashOfCmdline(own.cmdline),
    acquiredAt: new Date().toISOString(),
  };
  // Over a file left by an earlier run, whose mode a plain write would keep.
  rmSync(path, { force: true });
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  return {
    path,
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // Already gone. Left behind, it reads as stale once we are.
      }
    },
  };
}

function readRecord(path: string): DesktopLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DesktopLockRecord> | null;
    if (
      parsed &&
      typeof parsed.hostname === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startTime === "string"
    ) {
      return { cmdlineSha256: null, acquiredAt: "", ...parsed } as DesktopLockRecord;
    }
  } catch {
    // Missing, or nothing a desktop wrote.
  }
  return null;
}

/** The live desktop holding this exact directory, or null. A stale file is ignored. */
export async function liveDesktopLockHolder(
  dataDir: string,
  deps: ServerLockDeps = defaultDeps,
): Promise<DesktopLockRecord | null> {
  const record = readRecord(join(dataDir, DESKTOP_LOCK_FILE));
  return record && (await holderIsAlive(record, deps)) ? record : null;
}

/**
 * For a server about to treat `dataDir` as its own, holding `server.lock`, before any reaping.
 * A desktop's profiles and lock live in `<user data>/data`, and a server keeps them directly
 * under its data dir: it collides pointed at either of those two.
 */
export async function assertNoLiveDesktop(
  dataDir: string,
  deps: ServerLockDeps = defaultDeps,
): Promise<void> {
  const holder =
    (await liveDesktopLockHolder(dataDir, deps)) ??
    (await liveDesktopLockHolder(join(dataDir, DESKTOP_DATA_SUBDIR), deps));
  if (holder) throw new DesktopLockHeldError(dataDir, holder);
}
