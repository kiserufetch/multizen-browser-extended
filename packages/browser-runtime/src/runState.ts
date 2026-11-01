import { execFile } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { PROFILE_UPLOADS_DIR, UPLOAD_INBOX_DIR, type BrowserEngine, type ProfileId } from "@multizen/types";
import { killProcessTree, type ProcessTreeDeps } from "./processTree.ts";

const execFileP = promisify(execFile);

/** Long command lines times every process on a machine. */
const LISTING_MAX_BUFFER = 64 * 1024 * 1024;
const LISTING_TIMEOUT_MS = 30_000;
const EXIT_WAIT_MS = 5_000;
const EXIT_POLL_MS = 150;
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;

export const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;
/** A symlink and a flock on Linux, a file on Windows. */
const FIREFOX_LOCK_FILES = ["lock", ".parentlock", "parent.lock"] as const;

export interface BrowserRunEntry {
  kind: "browser";
  engine: BrowserEngine;
  profileId: ProfileId;
  pid: number;
  userDataDir: string;
  startedAt: string;
}

export interface XvfbRunEntry {
  kind: "xvfb";
  profileId: ProfileId;
  pid: number;
  authFile: string;
  startedAt: string;
}

export type RunEntry = BrowserRunEntry | XvfbRunEntry;

/** What the drivers tell about the processes they start. */
export interface ProcessJournal {
  add(entry: RunEntry): void;
  remove(pid: number): void;
}

/** What `<data-dir>/run/state.json` holds. */
export interface RunStateFile {
  serverPid: number;
  serverStartedAt: string;
  entries: RunEntry[];
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The journal of a running server: a whole new file on each change, renamed over the old
 * one, so a crash at any moment leaves one complete journal. A write that fails costs at
 * most what the next one puts right, and the scan at the next start covers it until then,
 * so it never fails the launch that caused it.
 */
export class RunState implements ProcessJournal {
  private entries: RunEntry[];
  private readonly state: Omit<RunStateFile, "entries">;
  private readonly rename: (from: string, to: string) => void;
  private readonly warn: (message: string, fields?: Record<string, unknown>) => void;

  constructor(
    private readonly stateFile: string,
    opts: {
      entries?: readonly RunEntry[];
      serverPid?: number;
      serverStartedAt?: string;
      rename?: (from: string, to: string) => void;
      warn?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.entries = [...(opts.entries ?? [])];
    this.state = {
      serverPid: opts.serverPid ?? process.pid,
      serverStartedAt: opts.serverStartedAt ?? new Date().toISOString(),
    };
    this.rename = opts.rename ?? renameSync;
    this.warn = opts.warn ?? (() => {});
    this.write();
  }

  add(entry: RunEntry): void {
    this.entries = [...this.entries.filter((e) => e.pid !== entry.pid), entry];
    this.write();
  }

  remove(pid: number): void {
    if (!this.entries.some((e) => e.pid === pid)) return;
    this.entries = this.entries.filter((e) => e.pid !== pid);
    this.write();
  }

  private write(): void {
    const staged = `${this.stateFile}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const content = JSON.stringify({ ...this.state, entries: this.entries }, null, 2);
      writeFileSync(staged, content, { flush: true });
      this.renameOver(staged);
    } catch (e) {
      this.warn("could not write the process journal", {
        path: this.stateFile,
        error: (e as Error).message,
      });
      try {
        unlinkSync(staged);
      } catch {
        // Never got that far.
      }
    }
  }

  /** On Windows something reading the old file, a virus scanner say, refuses a rename for a moment. */
  private renameOver(staged: string): void {
    for (let attempt = 1; ; attempt++) {
      try {
        this.rename(staged, this.stateFile);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const passing = code === "EPERM" || code === "EACCES" || code === "EBUSY";
        if (!passing || attempt >= RENAME_ATTEMPTS) throw e;
        sleepSync(RENAME_RETRY_MS);
      }
    }
  }
}

function isRunEntry(value: unknown): value is RunEntry {
  const e = value as { kind?: unknown; pid?: unknown; userDataDir?: unknown; engine?: unknown; authFile?: unknown } | null;
  if (!e || typeof e.pid !== "number" || !Number.isInteger(e.pid) || e.pid <= 1) return false;
  if (e.kind === "browser") return typeof e.userDataDir === "string" && typeof e.engine === "string";
  return e.kind === "xvfb" && typeof e.authFile === "string";
}

/** The journal on disk. Null with a reason if it can't be used, null alone if there is none. */
export function readRunState(stateFile: string): { state: RunStateFile | null; problem?: string } {
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: null };
    return { state: null, problem: (e as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunStateFile> | null;
    if (!parsed || !Array.isArray(parsed.entries)) return { state: null, problem: "it has no entries" };
    return {
      state: {
        serverPid: Number(parsed.serverPid),
        serverStartedAt: String(parsed.serverStartedAt),
        entries: parsed.entries.filter(isRunEntry),
      },
    };
  } catch (e) {
    return { state: null, problem: (e as Error).message };
  }
}

// ── what the OS says about a process ─────────────────────────────────────────

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Null where there is no comparable number: Windows. */
  uid: number | null;
  /**
   * As far as the OS keeps it apart. One element holding spaces is a line that can no longer
   * be split: macOS's `ps`, and Chromium's child processes on Linux, which rewrite theirs.
   */
  argv: string[];
}

export interface ProcReader {
  platform: NodeJS.Platform;
  /** This process's, for comparing. Null on Windows. */
  uid: number | null;
  /** Those of these PIDs that exist, read at once. Throws when the OS can't be asked. */
  read(pids: readonly number[]): Promise<ProcInfo[]>;
  /** Every process in sight. Throws when the OS can't be asked. */
  list(): Promise<ProcInfo[]>;
}

/** From /proc/<pid>/{stat,cmdline,status}. A zombie has exited: it reads as gone. */
export function parseLinuxProc(pid: number, stat: string, cmdline: string, status: string): ProcInfo | null {
  // comm may hold spaces and parens, so fields count from the last ")": state, then ppid.
  const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (!state || state === "Z" || state === "X") return null;
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  const argv = cmdline.split("\0");
  while (argv.length > 0 && argv.at(-1) === "") argv.pop();
  return { pid, ppid: Number(ppid), uid: uid === undefined ? null : Number(uid), argv };
}

function readLinuxProc(pid: number): ProcInfo | null {
  try {
    return parseLinuxProc(
      pid,
      readFileSync(`/proc/${pid}/stat`, "utf8"),
      readFileSync(`/proc/${pid}/cmdline`, "utf8"),
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
  } catch {
    // Gone between the listing and the read, or not ours to read.
    return null;
  }
}

/** Splits a Windows command line the way CommandLineToArgvW does. */
export function splitWindowsCommandLine(line: string): string[] {
  const argv: string[] = [];
  let i = 0;
  const atEnd = (): boolean => i >= line.length;
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t";
  while (!atEnd()) {
    while (isSpace(line[i])) i++;
    if (atEnd()) break;
    let arg = "";
    let quoted = false;
    // The program's name has no escapes: a backslash there is always a path's.
    const first = argv.length === 0;
    while (!atEnd() && (quoted || !isSpace(line[i]))) {
      const c = line[i]!;
      if (c === '"') {
        quoted = !quoted;
        i++;
      } else if (c === "\\" && !first) {
        let slashes = 0;
        while (line[i] === "\\") {
          slashes++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) {
            arg += '"';
            i++;
          }
        } else {
          arg += "\\".repeat(slashes);
        }
      } else {
        arg += c;
        i++;
      }
    }
    argv.push(arg);
  }
  return argv;
}

/** From ConvertTo-Json of Win32_Process: one object or an array, nothing when none matched. */
export function parseWindowsProcesses(stdout: string): ProcInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as
    | { ProcessId: number; ParentProcessId: number; CommandLine: string | null }
    | Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    uid: null,
    argv: p.CommandLine ? splitWindowsCommandLine(p.CommandLine) : [],
  }));
}

async function windowsProcesses(filter: string): Promise<ProcInfo[]> {
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `Get-CimInstance Win32_Process ${filter}| ` +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: LISTING_MAX_BUFFER, timeout: LISTING_TIMEOUT_MS },
  );
  return parseWindowsProcesses(stdout);
}

/** From `ps -ww -o pid=,ppid=,uid=,command=`, which keeps no argument boundaries. */
export function parsePsOutput(stdout: string): ProcInfo[] {
  const found: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (m) found.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), argv: [m[4]!] });
  }
  return found;
}

async function psProcesses(select: string[]): Promise<ProcInfo[]> {
  try {
    const { stdout } = await execFileP("ps", ["-ww", "-o", "pid=,ppid=,uid=,command=", ...select], {
      maxBuffer: LISTING_MAX_BUFFER,
      timeout: LISTING_TIMEOUT_MS,
    });
    return parsePsOutput(stdout);
  } catch (e) {
    // ps exits 1 when none of the pids exists; anything else means it cannot tell.
    if ((e as { code?: unknown }).code === 1) return [];
    throw e;
  }
}

/** The running OS's way of answering. */
export function systemProcReader(platform: NodeJS.Platform = process.platform): ProcReader {
  const uid = process.getuid?.() ?? null;
  if (platform === "win32") {
    return {
      platform,
      uid: null,
      read: async (pids) =>
        pids.length === 0
          ? []
          : windowsProcesses(`-Filter '${pids.map((pid) => `ProcessId=${pid}`).join(" OR ")}' `),
      list: () => windowsProcesses(""),
    };
  }
  if (platform === "linux") {
    return {
      platform,
      uid,
      read: async (pids) => pids.map(readLinuxProc).filter((p) => p !== null),
      list: async () =>
        readdirSync("/proc")
          .filter((name) => /^\d+$/.test(name))
          .map((name) => readLinuxProc(Number(name)))
          .filter((p) => p !== null),
    };
  }
  return {
    platform,
    uid,
    read: async (pids) => (pids.length === 0 ? [] : psProcesses(["-p", pids.join(",")])),
    list: () => psProcesses(["-A"]),
  };
}

// ── proof of ownership ───────────────────────────────────────────────────────

/** Comparable form of a path. Windows: any slash, any case. No trailing separator. */
function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const lib = platform === "win32" ? win32 : posix;
  let normal = lib.normalize(path);
  const rootLength = lib.parse(normal).root.length;
  while (normal.length > rootLength && normal.endsWith(lib.sep)) normal = normal.slice(0, -1);
  return platform === "win32" ? normal.toLowerCase() : normal;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return canonicalPath(a, platform) === canonicalPath(b, platform);
}

/** Strictly inside `root`: `profiles2/x` is not inside `profiles`, nor is `profiles` itself. */
function isInside(path: string, root: string, platform: NodeJS.Platform): boolean {
  const sep = platform === "win32" ? win32.sep : posix.sep;
  return canonicalPath(path, platform).startsWith(canonicalPath(root, platform) + sep);
}

function isOneLine(argv: readonly string[]): boolean {
  return argv.length === 1 && /\s/.test(argv[0]!);
}

/** Whether `text` stands as whole words in a line nothing can split any more. */
function hasWords(line: string, text: string): boolean {
  for (let i = line.indexOf(text); i !== -1; i = line.indexOf(text, i + 1)) {
    const end = i + text.length;
    if ((i === 0 || /\s/.test(line[i - 1]!)) && (end === line.length || /\s/.test(line[end]!))) return true;
  }
  return false;
}

/** The same, for text that must start at a word and may run on: a path inside a root. */
function startsAWord(line: string, text: string): boolean {
  for (let i = line.indexOf(text); i !== -1; i = line.indexOf(text, i + 1)) {
    if (i === 0 || /\s/.test(line[i - 1]!)) return true;
  }
  return false;
}

function hasEqualsFlag(proc: ProcInfo, flag: string, value: string, platform: NodeJS.Platform): boolean {
  if (isOneLine(proc.argv)) return hasWords(proc.argv[0]!, `${flag}=${value}`);
  const prefix = `${flag}=`;
  return proc.argv.some((a) => a.startsWith(prefix) && samePath(a.slice(prefix.length), value, platform));
}

function hasFlagPair(proc: ProcInfo, flag: string, value: string, platform: NodeJS.Platform): boolean {
  if (isOneLine(proc.argv)) return hasWords(proc.argv[0]!, `${flag} ${value}`);
  return proc.argv.some((a, i) => {
    const next = proc.argv[i + 1];
    return a === flag && next !== undefined && samePath(next, value, platform);
  });
}

function runsProgram(proc: ProcInfo, name: string, platform: NodeJS.Platform): boolean {
  const program = isOneLine(proc.argv) ? proc.argv[0]!.split(/\s/)[0]! : (proc.argv[0] ?? "");
  const lib = platform === "win32" ? win32 : posix;
  return lib.basename(program) === name;
}

/** What a recorded path has to lie inside, for the journal to be believed at all. */
export interface OwnedRoots {
  profilesRoot: string;
  xvfbRunDir?: string;
}

/**
 * Proof that a process is the one this entry recorded: its own arguments name the directory
 * or auth file, whole. A PID is no proof: a restarted container hands the same low numbers out.
 * Nor is the journal, which is a file: an entry naming a path outside this data dir proves nothing,
 * or anyone able to write it could have any browser on the machine killed.
 */
export function provesOwnership(
  entry: RunEntry,
  proc: ProcInfo,
  platform: NodeJS.Platform,
  roots: OwnedRoots,
): boolean {
  if (entry.kind === "xvfb") {
    return (
      roots.xvfbRunDir !== undefined &&
      isInside(entry.authFile, roots.xvfbRunDir, platform) &&
      runsProgram(proc, "Xvfb", platform) &&
      hasFlagPair(proc, "-auth", entry.authFile, platform)
    );
  }
  if (!isInside(entry.userDataDir, roots.profilesRoot, platform)) return false;
  return entry.engine === "camoufox"
    ? hasFlagPair(proc, "-profile", entry.userDataDir, platform)
    : hasEqualsFlag(proc, "--user-data-dir", entry.userDataDir, platform);
}

/** A browser on a directory inside `profilesRoot`, or an Xvfb on an auth file inside `xvfbRunDir`. */
function isOurStray(proc: ProcInfo, profilesRoot: string, xvfbRunDir: string | undefined, platform: NodeJS.Platform): boolean {
  const { argv } = proc;
  const sep = platform === "win32" ? win32.sep : posix.sep;
  if (isOneLine(argv)) {
    const line = argv[0]!;
    const root = `${profilesRoot}${sep}`;
    if (startsAWord(line, `--user-data-dir=${root}`) || startsAWord(line, `-profile ${root}`)) return true;
    return (
      xvfbRunDir !== undefined &&
      runsProgram(proc, "Xvfb", platform) &&
      startsAWord(line, `-auth ${xvfbRunDir}${sep}`)
    );
  }
  const userDataDir = "--user-data-dir=";
  return argv.some((arg, i) => {
    if (arg.startsWith(userDataDir)) return isInside(arg.slice(userDataDir.length), profilesRoot, platform);
    const next = argv[i + 1];
    if (next === undefined) return false;
    if (arg === "-profile") return isInside(next, profilesRoot, platform);
    return (
      arg === "-auth" &&
      xvfbRunDir !== undefined &&
      runsProgram(proc, "Xvfb", platform) &&
      isInside(next, xvfbRunDir, platform)
    );
  });
}

/**
 * The browsers running on this data dir: the top of each tree only, as Firefox's own children
 * name the profile too on some platforms. Playwright won't say what it spawned, so this is how
 * a Camoufox browser's PID is known at all. Same user only.
 */
export async function findPidsByDataDir(
  userDataDir: string,
  reader: ProcReader = systemProcReader(),
): Promise<number[]> {
  const found = (await reader.list()).filter(
    (proc) =>
      proc.pid !== process.pid &&
      sameUser(proc, reader) &&
      (hasFlagPair(proc, "-profile", userDataDir, reader.platform) ||
        hasEqualsFlag(proc, "--user-data-dir", userDataDir, reader.platform)),
  );
  const pids = new Set(found.map((proc) => proc.pid));
  return found.filter((proc) => !pids.has(proc.ppid)).map((proc) => proc.pid);
}

function sameUser(proc: ProcInfo, reader: ProcReader): boolean {
  return proc.uid === null || reader.uid === null || proc.uid === reader.uid;
}

// ── the reaper ───────────────────────────────────────────────────────────────

export interface ReapLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface ReapPreviousRunOptions {
  stateFile: string;
  profilesRoot: string;
  /** Under the data dir, holding Xvfb's auth files. Nothing else may be in it. */
  xvfbRunDir?: string;
  log?: ReapLog;
  proc?: ProcReader;
  treeDeps?: ProcessTreeDeps;
  /** Default: this process, which is never a candidate whatever its arguments say. */
  selfPid?: number;
  exitWaitMs?: number;
  pollMs?: number;
}

export interface ReapResult {
  /** This run's journal, already on disk with this process as its server. */
  journal: RunState;
  /** Recorded and proven ours: killed. */
  killed: number[];
  /** Found by the scan, recorded or not: killed. */
  strays: number[];
  /** Recorded, but the PID is someone else's now: left alone. */
  notOwned: number[];
  /** Recorded, no such process any more. */
  gone: number[];
  /** Ours and still there after the kill, or no way to tell: their entries stay in the journal. */
  unresolved: number[];
}

const SILENT_LOG: ReapLog = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Clears what a previous server on this data dir left behind, for a process that holds its
 * `server.lock` and hasn't opened its port yet. Nothing here kills without proof from the
 * process's own arguments, and when the OS can't be asked nothing is killed at all.
 * Named apart from {@link reapOrphans} in processTree.ts, which deals in one live parent's children.
 */
export async function reapPreviousRun(opts: ReapPreviousRunOptions): Promise<ReapResult> {
  const log = opts.log ?? SILENT_LOG;
  const reader = opts.proc ?? systemProcReader();
  const { platform } = reader;
  const selfPid = opts.selfPid ?? process.pid;
  const exitWaitMs = opts.exitWaitMs ?? EXIT_WAIT_MS;
  const pollMs = opts.pollMs ?? EXIT_POLL_MS;
  const roots: OwnedRoots = {
    profilesRoot: opts.profilesRoot,
    ...(opts.xvfbRunDir !== undefined ? { xvfbRunDir: opts.xvfbRunDir } : {}),
  };
  const kill = opts.treeDeps?.kill ?? ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));

  const { state, problem } = readRunState(opts.stateFile);
  if (problem) {
    log.warn("the previous run's journal can't be read; the scan below still runs", {
      path: opts.stateFile,
      problem,
    });
  }
  const entries = state?.entries ?? [];
  const result: Omit<ReapResult, "journal"> = { killed: [], strays: [], notOwned: [], gone: [], unresolved: [] };
  const keep: RunEntry[] = [];
  /** What each killed process must stop proving for it to count as gone. */
  const targets = new Map<number, (proc: ProcInfo) => boolean>();

  let recorded: Map<number, ProcInfo> | null = null;
  try {
    recorded = new Map((await reader.read(entries.map((e) => e.pid))).map((p) => [p.pid, p]));
  } catch (e) {
    log.error("can't read the recorded processes; none of them is touched", {
      pids: entries.map((entry) => entry.pid),
      error: (e as Error).message,
    });
    keep.push(...entries);
    result.unresolved.push(...entries.map((entry) => entry.pid));
  }

  if (recorded) {
    for (const entry of entries) {
      const proc = recorded.get(entry.pid);
      if (!proc) {
        result.gone.push(entry.pid);
        continue;
      }
      if (entry.pid === selfPid || !sameUser(proc, reader) || !provesOwnership(entry, proc, platform, roots)) {
        result.notOwned.push(entry.pid);
        log.warn("a recorded PID is not ours any more, left alone", {
          pid: entry.pid,
          recordedAs: entry.kind,
          profileId: entry.profileId,
        });
        continue;
      }
      targets.set(entry.pid, (p) => provesOwnership(entry, p, platform, roots));
      result.killed.push(entry.pid);
    }
  }

  /** Kills each, then waits. Whatever is still there proving what it did stays unresolved. */
  const killAndWait = async (pids: number[]): Promise<number[]> => {
    if (pids.length === 0) return [];
    for (const pid of pids) {
      await killProcessTree(pid, opts.treeDeps);
      // The tree kill reaches a Unix process through its group, which only a leader has.
      try {
        kill(pid, "SIGKILL");
      } catch {
        // Already gone with its tree.
      }
    }
    const deadline = Date.now() + exitWaitMs;
    for (;;) {
      let left: number[];
      try {
        left = (await reader.read(pids)).filter((p) => targets.get(p.pid)?.(p)).map((p) => p.pid);
      } catch {
        return pids;
      }
      if (left.length === 0 || Date.now() >= deadline) return left;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
  const settle = (list: "killed" | "strays", survivors: readonly number[]): void => {
    if (survivors.length === 0) return;
    log.error("processes of the previous run did not exit", { pids: survivors });
    result[list] = result[list].filter((pid) => !survivors.includes(pid));
    result.unresolved.push(...survivors);
    keep.push(...entries.filter((e) => survivors.includes(e.pid)));
  };

  settle("killed", await killAndWait(result.killed));

  // Safety net: a crash before journaling, Firefox's gap until its PID is known, a journal
  // lost altogether, and children that outlived a recorded parent.
  let scanned = false;
  try {
    const found = (await reader.list()).filter(
      (proc) =>
        proc.pid !== selfPid &&
        !targets.has(proc.pid) &&
        sameUser(proc, reader) &&
        isOurStray(proc, opts.profilesRoot, opts.xvfbRunDir, platform),
    );
    for (const proc of found) {
      targets.set(proc.pid, (p) => isOurStray(p, opts.profilesRoot, opts.xvfbRunDir, platform));
    }
    // The top of each tree first: its kill takes the children along.
    const pids = new Set(found.map((proc) => proc.pid));
    result.strays = [
      ...found.filter((proc) => !pids.has(proc.ppid)),
      ...found.filter((proc) => pids.has(proc.ppid)),
    ].map((proc) => proc.pid);
    scanned = true;
  } catch (e) {
    log.error("can't list processes; nothing beyond the recorded ones is touched", {
      error: (e as Error).message,
    });
  }
  settle("strays", await killAndWait(result.strays));

  // Locks and auth files, only once nothing can still be using them.
  if (scanned && result.unresolved.length === 0) {
    const cleaned = await clearProfileLocks(opts.profilesRoot, log);
    if (cleaned > 0) log.info("stale profile locks removed", { files: cleaned });
    if (opts.xvfbRunDir) clearDirectory(opts.xvfbRunDir, log);
    clearUploadInboxes(opts.profilesRoot, log);
  }
  clearStagedJournals(opts.stateFile);

  const { killed, strays, notOwned, gone, unresolved } = result;
  if (killed.length + strays.length + notOwned.length + gone.length + unresolved.length > 0) {
    log.info("previous run reaped", { killed, strays, notOwned, gone, unresolved });
  }
  const journal = new RunState(opts.stateFile, {
    entries: keep,
    serverPid: selfPid,
    warn: (message, fields) => log.warn(message, fields),
  });
  return { ...result, journal };
}

/** A crash in the middle of a write leaves its staged file. The journal itself is whole. */
function clearStagedJournals(stateFile: string): void {
  const stem = `${basename(stateFile)}.`;
  try {
    for (const name of readdirSync(dirname(stateFile))) {
      if (name.startsWith(stem) && name.endsWith(".tmp")) rmSync(join(dirname(stateFile), name), { force: true });
    }
  } catch {
    // No directory yet, or a file in use: nothing reads these, and the next start tries again.
  }
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/** `<profilesRoot>/<id>/engines/<engine>` of every profile: Chromium's and Firefox's lock files. */
async function clearProfileLocks(profilesRoot: string, log: ReapLog): Promise<number> {
  let removed = 0;
  for (const profile of subdirectories(profilesRoot)) {
    for (const dir of subdirectories(join(profile, "engines"))) {
      for (const name of [...SINGLETON_FILES, ...FIREFOX_LOCK_FILES]) {
        try {
          unlinkSync(join(dir, name));
          removed++;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          log.warn("could not remove a stale profile lock", { dir, name, error: (e as Error).message });
        }
      }
    }
  }
  return removed;
}

/** A crash skips the clearing a close does, and what an inbox holds lasts as long as a browser. */
function clearUploadInboxes(profilesRoot: string, log: ReapLog): void {
  for (const profile of subdirectories(profilesRoot)) {
    try {
      rmSync(join(profile, PROFILE_UPLOADS_DIR, UPLOAD_INBOX_DIR), { recursive: true, force: true });
    } catch (e) {
      log.warn("could not clear an upload inbox", { profile, error: (e as Error).message });
    }
  }
}

function clearDirectory(dir: string, log: ReapLog): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (e) {
      log.warn("could not remove a stale Xvfb auth directory", { name, error: (e as Error).message });
    }
  }
}
