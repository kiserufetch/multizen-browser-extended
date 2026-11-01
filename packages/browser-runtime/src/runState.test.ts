import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessTreeDeps } from "./processTree.ts";
import {
  findPidsByDataDir,
  parseLinuxProc,
  parsePsOutput,
  parseWindowsProcesses,
  provesOwnership,
  readRunState,
  reapPreviousRun,
  RunState,
  splitWindowsCommandLine,
  type ProcInfo,
  type ProcReader,
  type ReapLog,
  type RunEntry,
} from "./runState.ts";

const ROOT = "/data/profiles";
const DIR = `${ROOT}/a/engines/cloakbrowser`;
const FOX = `${ROOT}/b/engines/camoufox`;
const AUTH = "/data/run/xvfb/mz-xvfb-x/Xauthority";

const browser = (pid: number, dir = DIR): RunEntry => ({
  kind: "browser",
  engine: "cloakbrowser",
  profileId: "a",
  pid,
  userDataDir: dir,
  startedAt: "t",
});
const firefox = (pid: number, dir = FOX): RunEntry => ({
  kind: "browser",
  engine: "camoufox",
  profileId: "b",
  pid,
  userDataDir: dir,
  startedAt: "t",
});
const xvfb = (pid: number, authFile = AUTH): RunEntry => ({
  kind: "xvfb",
  profileId: "a",
  pid,
  authFile,
  startedAt: "t",
});

const proc = (pid: number, argv: string[], extra: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid: 1,
  uid: 1000,
  argv,
  ...extra,
});
const chrome = (pid: number, dir = DIR, extra?: Partial<ProcInfo>): ProcInfo =>
  proc(pid, ["/x/chrome", `--user-data-dir=${dir}`, "--remote-debugging-port=9"], extra);
const camoufox = (pid: number, dir = FOX, extra?: Partial<ProcInfo>): ProcInfo =>
  proc(pid, ["/x/camoufox-bin", "-no-remote", "-profile", dir, "-juggler-pipe"], extra);
const xserver = (pid: number, auth = AUTH): ProcInfo =>
  proc(pid, ["Xvfb", "-displayfd", "3", "-auth", auth, "-noreset"]);

/** A machine of fake processes. A kill takes what it names off the list, unless told not to. */
function machine(initial: ProcInfo[], opts: { platform?: NodeJS.Platform; unkillable?: number[] } = {}) {
  const processes = new Map(initial.map((p) => [p.pid, p]));
  const signals: Array<[number, unknown]> = [];
  const unkillable = new Set(opts.unkillable ?? []);
  const reader: ProcReader = {
    platform: opts.platform ?? "linux",
    uid: 1000,
    read: async (pids) => pids.flatMap((pid) => processes.get(pid) ?? []),
    list: async () => [...processes.values()],
  };
  const treeDeps: ProcessTreeDeps = {
    platform: "linux",
    execFileP: (async () => ({ stdout: "", stderr: "" })) as unknown as ProcessTreeDeps["execFileP"],
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      const target = Math.abs(pid);
      if (!unkillable.has(target)) processes.delete(target);
    },
    sleep: async () => {},
  };
  return { reader, treeDeps, signals, processes, killed: () => [...new Set(signals.map(([pid]) => Math.abs(pid)))] };
}

function logs(): ReapLog & { lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> } {
  const lines: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void lines.push({ level, message, ...(fields ? { fields } : {}) });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

function dataDir(t: TestContext): { dir: string; stateFile: string; profilesRoot: string; xvfbRunDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mz-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return {
    dir,
    stateFile: join(dir, "run", "state.json"),
    profilesRoot: join(dir, "profiles"),
    xvfbRunDir: join(dir, "run", "xvfb"),
  };
}

function writeJournal(stateFile: string, entries: RunEntry[], serverPid = 4242): void {
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ serverPid, serverStartedAt: "before", entries }));
}

async function reap(
  t: TestContext,
  entries: RunEntry[],
  m: ReturnType<typeof machine>,
  overrides: { profilesRoot?: string; xvfbRunDir?: string } = {},
) {
  const paths = dataDir(t);
  writeJournal(paths.stateFile, entries);
  const log = logs();
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: overrides.profilesRoot ?? ROOT,
    xvfbRunDir: overrides.xvfbRunDir ?? "/data/run/xvfb",
    proc: m.reader,
    treeDeps: m.treeDeps,
    selfPid: 7,
    log,
    exitWaitMs: 30,
    pollMs: 5,
  });
  return { result, log, stateFile: paths.stateFile };
}

// ── the journal ──────────────────────────────────────────────────────────────

test("the journal holds who started what, rewritten whole on each change", (t) => {
  const { stateFile } = dataDir(t);
  const journal = new RunState(stateFile, { serverPid: 99, serverStartedAt: "now" });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {
    serverPid: 99,
    serverStartedAt: "now",
    entries: [],
  });
  journal.add(browser(11));
  journal.add(xvfb(12));
  assert.deepEqual(readRunState(stateFile).state?.entries.map((e) => e.pid), [11, 12]);
  journal.remove(11);
  journal.remove(11);
  assert.deepEqual(readRunState(stateFile).state?.entries, [xvfb(12)]);
  assert.deepEqual(readdirSync(join(stateFile, "..")), ["state.json"], "nothing staged stays");
});

test("a crash in the middle of a write leaves the last journal whole", (t) => {
  const { stateFile } = dataDir(t);
  const journal = new RunState(stateFile, { serverPid: 99 });
  journal.add(browser(11));
  const before = readFileSync(stateFile, "utf8");

  // The moment of the crash: the new content is staged, half of it, and never renamed.
  writeFileSync(`${stateFile}.1234.tmp`, '{"serverPid":99,"entries":[{"kind":"brow');
  assert.equal(readFileSync(stateFile, "utf8"), before);
  assert.deepEqual(readRunState(stateFile).state?.entries, [browser(11)]);
});

test("a process killed while it writes leaves a journal that reads", async (t) => {
  const { stateFile } = dataDir(t);
  const moduleUrl = new URL("./runState.ts", import.meta.url).href;
  const writer = `
    import(${JSON.stringify(moduleUrl)}).then(({ RunState }) => {
      const journal = new RunState(${JSON.stringify(stateFile)});
      process.stdout.write("writing\\n");
      const authFile = "a".repeat(4000);
      for (let pid = 2; ; pid++) {
        journal.add({ kind: "xvfb", profileId: "p", pid, authFile, startedAt: "t" });
      }
    });`;
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, [...process.execArgv, "-e", writer], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    t.after(() => child.kill("SIGKILL"));
    await new Promise((resolve) => child.stdout.once("data", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const { state, problem } = readRunState(stateFile);
    assert.equal(problem, undefined);
    assert.ok(state && state.entries.length > 0, "it had time to write something");
  }
});

test("a write that can't finish leaves the old file and never reaches the launch", (t) => {
  const { stateFile } = dataDir(t);
  let failing = false;
  const warnings: string[] = [];
  const journal = new RunState(stateFile, {
    rename: (from, to) => {
      if (failing) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      writeFileSync(to, readFileSync(from));
      rmSync(from);
    },
    warn: (message) => warnings.push(message),
  });
  journal.add(browser(11));
  const before = readFileSync(stateFile, "utf8");
  failing = true;
  journal.add(browser(22));
  assert.equal(readFileSync(stateFile, "utf8"), before);
  assert.equal(warnings.length, 1);
  assert.deepEqual(readdirSync(join(stateFile, "..")), ["state.json"]);
  // What the failed write held comes with the next one.
  failing = false;
  journal.add(browser(33));
  assert.deepEqual(readRunState(stateFile).state?.entries.map((e) => e.pid), [11, 22, 33]);
});

test("Windows refusing a rename for a moment costs a retry, nothing more", (t) => {
  const { stateFile } = dataDir(t);
  let refusals = 2;
  const journal = new RunState(stateFile, {
    rename: (from, to) => {
      if (refusals-- > 0) throw Object.assign(new Error("in use"), { code: "EPERM" });
      writeFileSync(to, readFileSync(from));
      rmSync(from);
    },
  });
  journal.add(browser(11));
  assert.deepEqual(readRunState(stateFile).state?.entries, [browser(11)]);
});

test("reading: none, torn, and an entry that makes no sense", (t) => {
  const { stateFile } = dataDir(t);
  assert.deepEqual(readRunState(stateFile), { state: null });
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, '{"serverPid":1,"entr');
  assert.equal(readRunState(stateFile).state, null);
  assert.ok(readRunState(stateFile).problem);
  writeFileSync(
    stateFile,
    JSON.stringify({
      serverPid: 1,
      serverStartedAt: "x",
      entries: [browser(11), { kind: "browser", pid: "12" }, { kind: "xvfb", pid: 1, authFile: "a" }, { kind: "z", pid: 5 }],
    }),
  );
  assert.deepEqual(readRunState(stateFile).state?.entries, [browser(11)]);
});

// ── what the OS says ─────────────────────────────────────────────────────────

test("Linux /proc: argv by NUL, parents and uid read past a comm with spaces and parens", () => {
  const stat = "123 (Web (Content) x) S 45 123 123 0 -1 4194560 2 0 0 0";
  const parsed = parseLinuxProc(123, stat, "/x/chrome\0--user-data-dir=/d e\0", "Name:\tchrome\nUid:\t1000\t1000\t1000\t1000\n");
  assert.deepEqual(parsed, { pid: 123, ppid: 45, uid: 1000, argv: ["/x/chrome", "--user-data-dir=/d e"] });
  assert.equal(parseLinuxProc(123, "123 (chrome) Z 45 0", "", ""), null, "a zombie has exited");
  assert.deepEqual(parseLinuxProc(2, "2 (kthreadd) S 0 0", "", "Uid:\t0\t0\t0\t0\n")?.argv, []);
});

test("Windows command lines split as Windows splits them", () => {
  const dir = String.raw`C:\Users\A B\mzs\profiles\p\engines\cloakbrowser`;
  assert.deepEqual(
    splitWindowsCommandLine(String.raw`"C:\Program Files\c\chrome.exe" --type=renderer --user-data-dir="${dir}" --x=1`),
    [String.raw`C:\Program Files\c\chrome.exe`, "--type=renderer", `--user-data-dir=${dir}`, "--x=1"],
  );
  assert.deepEqual(splitWindowsCommandLine(String.raw`c.exe "--user-data-dir=${dir}" -profile "${dir}"`), [
    "c.exe",
    `--user-data-dir=${dir}`,
    "-profile",
    dir,
  ]);
  assert.deepEqual(splitWindowsCommandLine(String.raw`C:\a\b.exe "x\\" y\z "q\"r" \\"s t"`), [
    String.raw`C:\a\b.exe`,
    "x\\",
    String.raw`y\z`,
    'q"r',
    "\\s t",
  ]);
  assert.deepEqual(splitWindowsCommandLine("   "), []);
});

test("Windows CIM output: one object, an array, nothing, and no command line", () => {
  assert.deepEqual(parseWindowsProcesses(""), []);
  assert.deepEqual(
    parseWindowsProcesses('{"ProcessId":5,"ParentProcessId":4,"CommandLine":"a.exe -b"}'),
    [{ pid: 5, ppid: 4, uid: null, argv: ["a.exe", "-b"] }],
  );
  assert.deepEqual(
    parseWindowsProcesses('[{"ProcessId":5,"ParentProcessId":4,"CommandLine":null},{"ProcessId":6,"ParentProcessId":5,"CommandLine":"x"}]'),
    [
      { pid: 5, ppid: 4, uid: null, argv: [] },
      { pid: 6, ppid: 5, uid: null, argv: ["x"] },
    ],
  );
});

test("macOS ps: pid, parent, uid, and a line that can't be split", () => {
  assert.deepEqual(parsePsOutput("  501     1   502 /x/chrome --user-data-dir=/d e --y\n"), [
    { pid: 501, ppid: 1, uid: 502, argv: ["/x/chrome --user-data-dir=/d e --y"] },
  ]);
});

// ── proof ────────────────────────────────────────────────────────────────────

test("ownership: the whole argument, exactly, for each kind of process", () => {
  assert.ok(provesOwnership(browser(1), chrome(1), "linux"));
  assert.ok(!provesOwnership(browser(1), chrome(1, `${DIR}2`), "linux"), "a longer path");
  assert.ok(!provesOwnership(browser(1), chrome(1, "/data/profiles/a/engines"), "linux"), "a parent dir");
  assert.ok(!provesOwnership(browser(1), proc(1, ["node", DIR]), "linux"), "only mentions it");
  assert.ok(!provesOwnership(browser(1), proc(1, ["vim", `x--user-data-dir=${DIR}`]), "linux"), "inside a word");
  assert.ok(!provesOwnership(browser(1), camoufox(1, DIR), "linux"), "the other engine's flag");

  assert.ok(provesOwnership(firefox(1), camoufox(1), "linux"));
  assert.ok(!provesOwnership(firefox(1), proc(1, ["x", "-profile"]), "linux"), "no value");
  assert.ok(!provesOwnership(firefox(1), proc(1, ["x", "-profile", "/other", FOX]), "linux"), "another value");
  assert.ok(!provesOwnership(firefox(1), chrome(1, FOX), "linux"));

  assert.ok(provesOwnership(xvfb(1), xserver(1), "linux"));
  assert.ok(provesOwnership(xvfb(1), proc(1, ["/usr/bin/Xvfb", "-auth", AUTH]), "linux"));
  assert.ok(!provesOwnership(xvfb(1), xserver(1, `${AUTH}2`), "linux"));
  assert.ok(!provesOwnership(xvfb(1), proc(1, ["sleep", "-auth", AUTH]), "linux"), "not Xvfb");
});

test("ownership on Windows: any case, either slash", () => {
  const dir = String.raw`C:\Users\A\mzs\profiles\p\engines\cloakbrowser`;
  const entry = browser(1, dir);
  assert.ok(provesOwnership(entry, proc(1, ["c.exe", `--user-data-dir=${dir.toUpperCase()}`]), "win32"));
  assert.ok(provesOwnership(entry, proc(1, ["c.exe", `--user-data-dir=${dir.replaceAll("\\", "/")}`]), "win32"));
  assert.ok(!provesOwnership(entry, proc(1, ["c.exe", `--user-data-dir=${dir}2`]), "win32"));
  assert.ok(!provesOwnership(entry, proc(1, ["c.exe", `--user-data-dir=${dir.toUpperCase()}`]), "linux"), "Linux is exact");
  assert.ok(provesOwnership(firefox(1, dir), proc(1, ["c.exe", "-profile", dir.toLowerCase()]), "win32"));
});

test("ownership in a line that can't be split: whole words only", () => {
  const line = (text: string): ProcInfo => proc(1, [text]);
  assert.ok(provesOwnership(browser(1), line(`/x/chrome --type=zygote --user-data-dir=${DIR} --y`), "linux"));
  assert.ok(provesOwnership(browser(1), line(`/x/chrome --user-data-dir=${DIR}`), "darwin"));
  assert.ok(!provesOwnership(browser(1), line(`/x/chrome --user-data-dir=${DIR}2 --y`), "linux"));
  assert.ok(!provesOwnership(browser(1), line(`/x/chrome x--user-data-dir=${DIR} --y`), "linux"));
  assert.ok(provesOwnership(firefox(1), line(`/x/fox -profile ${FOX} -juggler-pipe`), "darwin"));
  assert.ok(provesOwnership(xvfb(1), line(`/usr/bin/Xvfb -auth ${AUTH} -noreset`), "darwin"));
  assert.ok(!provesOwnership(xvfb(1), line(`/usr/bin/other -auth ${AUTH} -noreset`), "darwin"));
});

// ── the reaper ───────────────────────────────────────────────────────────────

test("owned: killed, waited for, and off the journal", async (t) => {
  const m = machine([chrome(50), camoufox(51), xserver(52)]);
  const { result, stateFile } = await reap(t, [browser(50), firefox(51), xvfb(52)], m);
  assert.deepEqual(result.killed, [50, 51, 52]);
  assert.equal(m.processes.size, 0);
  const state = readRunState(stateFile).state;
  assert.deepEqual(state?.entries, []);
  assert.equal(state?.serverPid, 7, "the journal is this run's now");
  assert.notEqual(state?.serverStartedAt, "before");
});

test("a PID reused by another process is not touched, and says so", async (t) => {
  const other = proc(50, ["/usr/bin/node", "worker.js"]);
  const m = machine([other]);
  const { result, log, stateFile } = await reap(t, [browser(50)], m);
  assert.deepEqual(result.notOwned, [50]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(m.signals, [], "not one signal");
  assert.ok(m.processes.has(50));
  const line = log.lines.find((l) => l.message.includes("not ours"));
  assert.equal(line?.level, "warn");
  assert.equal(line?.fields?.pid, 50);
  assert.deepEqual(readRunState(stateFile).state?.entries, []);
});

test("a PID that is this process: a restarted container hands low numbers back", async (t) => {
  const m = machine([chrome(7)]);
  const { result } = await reap(t, [browser(7)], m);
  assert.deepEqual(result.notOwned, [7]);
  assert.deepEqual(m.signals, []);
});

test("another user's process with the right arguments is not ours", async (t) => {
  const m = machine([chrome(50, DIR, { uid: 0 }), chrome(60, `${ROOT}/z/engines/cloakbrowser`, { uid: 0 })]);
  const { result } = await reap(t, [browser(50)], m);
  assert.deepEqual(result.notOwned, [50]);
  assert.deepEqual(result.strays, []);
  assert.deepEqual(m.signals, []);
});

test("a missing PID is dropped", async (t) => {
  const m = machine([]);
  const { result, stateFile } = await reap(t, [browser(50), xvfb(51)], m);
  assert.deepEqual(result.gone, [50, 51]);
  assert.deepEqual(m.signals, []);
  assert.deepEqual(readRunState(stateFile).state?.entries, []);
});

test("the safety net: a browser no journal knows of, of either engine, and its Xvfb", async (t) => {
  const m = machine([
    chrome(60, `${ROOT}/x/engines/cloakbrowser`),
    camoufox(61, `${ROOT}/y/engines/camoufox`),
    xserver(62, "/data/run/xvfb/mz-xvfb-q/Xauthority"),
    // A renderer rewrites its command line, and outlived its parent.
    proc(63, [`/x/chrome --type=renderer --user-data-dir=${ROOT}/x/engines/cloakbrowser --y`]),
  ]);
  const { result } = await reap(t, [], m);
  assert.deepEqual(result.strays.sort(), [60, 61, 62, 63]);
  assert.equal(m.processes.size, 0);
});

test("the safety net takes the top of a tree first", async (t) => {
  const child = chrome(60, DIR, { ppid: 61 });
  const parent = chrome(61, DIR);
  const m = machine([child, parent]);
  const { result } = await reap(t, [], m);
  assert.deepEqual(result.strays, [61, 60]);
});

test("the safety net leaves alone anything that only looks like it", async (t) => {
  const lookalikes = [
    // The next directory along.
    chrome(70, "/data/profiles2/x/engines/cloakbrowser"),
    camoufox(71, "/data/profiles2/y/engines/camoufox"),
    proc(72, [`/x/chrome --type=renderer --user-data-dir=/data/profiles2/x --y`]),
    // The root itself isn't inside it.
    chrome(73, ROOT),
    // Out of it by ..
    chrome(74, `${ROOT}/../other`),
    // Merely mentions it.
    proc(75, ["vim", `${ROOT}/x/engines/cloakbrowser/Preferences`]),
    proc(76, ["node", "tool.js", "--data-dir", "/data"]),
    proc(77, ["grep", "-r", `user-data-dir=${ROOT}/x`]),
    // Another engine's flag on some other program's path.
    proc(78, ["/x/other", "--profile-directory=Default", `--user-data-dir=/home/me/.config/chrome`]),
    // An -auth that isn't Xvfb's, and an Xvfb that isn't ours.
    proc(79, ["sleep", "-auth", "/data/run/xvfb/mz-xvfb-q/Xauthority"]),
    xserver(80, "/tmp/mz-xvfb-other/Xauthority"),
  ];
  const m = machine(lookalikes);
  const { result } = await reap(t, [], m);
  assert.deepEqual(result.strays, []);
  assert.deepEqual(m.signals, []);
  assert.equal(m.processes.size, lookalikes.length);
});

test("the safety net never takes this process, whatever its arguments", async (t) => {
  const m = machine([chrome(7, `${ROOT}/x/engines/cloakbrowser`)]);
  const { result } = await reap(t, [], m);
  assert.deepEqual(result.strays, []);
  assert.deepEqual(m.signals, []);
});

test("Windows paths in the safety net: any case and slash, and the same prefix trap", async (t) => {
  const root = String.raw`C:\Data\profiles`;
  const m = machine(
    [
      proc(60, ["c.exe", String.raw`--user-data-dir=c:/data/PROFILES/x/engines/cloakbrowser`], { uid: null }),
      proc(61, ["c.exe", "-profile", String.raw`C:\DATA\profiles\y\engines\camoufox`], { uid: null }),
      proc(62, ["c.exe", String.raw`--user-data-dir=C:\Data\profiles2\x`], { uid: null }),
    ],
    { platform: "win32" },
  );
  const { result } = await reap(t, [], m, { profilesRoot: root });
  assert.deepEqual(result.strays.sort(), [60, 61]);
  assert.ok(m.processes.has(62));
});

test("one that won't die stays on the journal, and its locks stay too", async (t) => {
  const paths = dataDir(t);
  const engineDir = join(paths.profilesRoot, "a", "engines", "cloakbrowser");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(join(engineDir, "SingletonCookie"), "");
  const entry = browser(50, engineDir);
  writeJournal(paths.stateFile, [entry]);
  const m = machine([chrome(50, engineDir)], { unkillable: [50] });
  const log = logs();
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: paths.profilesRoot,
    proc: m.reader,
    treeDeps: m.treeDeps,
    selfPid: 7,
    log,
    exitWaitMs: 20,
    pollMs: 5,
  });
  assert.deepEqual(result.unresolved, [50]);
  assert.deepEqual(result.killed, []);
  assert.ok(log.lines.some((l) => l.level === "error" && l.message.includes("did not exit")));
  assert.deepEqual(readRunState(paths.stateFile).state?.entries, [entry]);
  assert.ok(existsSync(join(engineDir, "SingletonCookie")));
});

test("when the OS can't be asked, nothing is killed and nothing is lost", async (t) => {
  const paths = dataDir(t);
  const engineDir = join(paths.profilesRoot, "a", "engines", "cloakbrowser");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(join(engineDir, "SingletonCookie"), "");
  writeJournal(paths.stateFile, [browser(50, engineDir)]);
  const m = machine([chrome(50, engineDir)]);
  const refusing: ProcReader = {
    ...m.reader,
    read: async () => {
      throw new Error("powershell is gone");
    },
    list: async () => {
      throw new Error("powershell is gone");
    },
  };
  const log = logs();
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: paths.profilesRoot,
    proc: refusing,
    treeDeps: m.treeDeps,
    selfPid: 7,
    log,
  });
  assert.deepEqual(m.signals, []);
  assert.deepEqual(result.unresolved, [50]);
  assert.deepEqual(readRunState(paths.stateFile).state?.entries.map((e) => e.pid), [50]);
  assert.ok(existsSync(join(engineDir, "SingletonCookie")), "its lock may still be in use");
  assert.ok(log.lines.some((l) => l.level === "error"));
});

test("a listing that fails still leaves the recorded ones dealt with, and no sweep", async (t) => {
  const paths = dataDir(t);
  const engineDir = join(paths.profilesRoot, "a", "engines", "cloakbrowser");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(join(engineDir, "SingletonCookie"), "");
  writeJournal(paths.stateFile, [browser(50, engineDir)]);
  const m = machine([chrome(50, engineDir)]);
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: paths.profilesRoot,
    proc: {
      ...m.reader,
      list: async () => {
        throw new Error("no listing");
      },
    },
    treeDeps: m.treeDeps,
    selfPid: 7,
    exitWaitMs: 20,
    pollMs: 5,
  });
  assert.deepEqual(result.killed, [50]);
  assert.ok(existsSync(join(engineDir, "SingletonCookie")), "something unseen may be using it");
});

test("a torn journal: the scan still runs, and the next one is whole", async (t) => {
  const paths = dataDir(t);
  mkdirSync(join(paths.stateFile, ".."), { recursive: true });
  writeFileSync(paths.stateFile, '{"serverPid":9,"entries":[{"kind":"bro');
  writeFileSync(`${paths.stateFile}.9.tmp`, '{"half');
  const m = machine([chrome(60, `${ROOT}/x/engines/cloakbrowser`)]);
  const log = logs();
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: ROOT,
    proc: m.reader,
    treeDeps: m.treeDeps,
    selfPid: 7,
    log,
    exitWaitMs: 20,
    pollMs: 5,
  });
  assert.deepEqual(result.strays, [60]);
  assert.ok(log.lines.some((l) => l.level === "warn" && l.message.includes("can't be read")));
  assert.deepEqual(readRunState(paths.stateFile).state?.entries, []);
  assert.deepEqual(readdirSync(join(paths.stateFile, "..")), ["state.json"]);
  result.journal.add(browser(70));
  assert.deepEqual(readRunState(paths.stateFile).state?.entries.map((e) => e.pid), [70]);
});

test("once nothing runs: every engine's locks go, and Xvfb's auth files, and nothing else", async (t) => {
  const paths = dataDir(t);
  const chromium = join(paths.profilesRoot, "a", "engines", "cloakbrowser");
  const fox = join(paths.profilesRoot, "b", "engines", "camoufox");
  mkdirSync(chromium, { recursive: true });
  mkdirSync(fox, { recursive: true });
  for (const name of ["SingletonCookie", "Cookies"]) writeFileSync(join(chromium, name), "");
  for (const name of [".parentlock", "parent.lock", "prefs.js"]) writeFileSync(join(fox, name), "");
  if (process.platform !== "win32") {
    // Dangling links, as a crash leaves them.
    symlinkSync("multizen-77", join(chromium, "SingletonLock"));
    symlinkSync("127.0.0.1:+77", join(fox, "lock"));
  }
  const auth = join(paths.xvfbRunDir, "mz-xvfb-old");
  mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, "Xauthority"), "");

  const m = machine([]);
  const log = logs();
  await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: paths.profilesRoot,
    xvfbRunDir: paths.xvfbRunDir,
    proc: m.reader,
    treeDeps: m.treeDeps,
    log,
  });
  assert.deepEqual(readdirSync(chromium), ["Cookies"]);
  assert.deepEqual(readdirSync(fox), ["prefs.js"]);
  assert.deepEqual(readdirSync(paths.xvfbRunDir), []);
  assert.deepEqual(m.signals, []);
  assert.ok(readRunState(paths.stateFile).state);
  assert.ok(log.lines.some((l) => l.message.includes("locks removed")));
});

test("a first run: no journal, nothing running, nothing to say", async (t) => {
  const paths = dataDir(t);
  const m = machine([]);
  const log = logs();
  const result = await reapPreviousRun({
    stateFile: paths.stateFile,
    profilesRoot: paths.profilesRoot,
    proc: m.reader,
    treeDeps: m.treeDeps,
    log,
  });
  assert.deepEqual(log.lines, []);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(readRunState(paths.stateFile).state?.entries, []);
});

// ── finding a browser ────────────────────────────────────────────────────────

test("a browser's PID from its data dir: the top of its tree, not its children", async () => {
  const m = machine([
    camoufox(90, FOX, { ppid: 5 }),
    // Firefox's content processes name the profile on Windows and macOS.
    camoufox(91, FOX, { ppid: 90 }),
    camoufox(92, FOX, { ppid: 91 }),
    camoufox(93, `${FOX}2`, { ppid: 5 }),
    proc(94, ["node", FOX]),
  ]);
  assert.deepEqual(await findPidsByDataDir(FOX, m.reader), [90]);
  assert.deepEqual(await findPidsByDataDir("/nothing", m.reader), []);
});

test("a browser's PID: another user's browser on the same path doesn't count", async () => {
  const m = machine([camoufox(90, FOX, { uid: 0 })]);
  assert.deepEqual(await findPidsByDataDir(FOX, m.reader), []);
});

test("the real listing finds a real process by its arguments", async (t) => {
  // This platform's reader, against a process that is really there: a node with the flag.
  const { dir } = dataDir(t);
  const profile = join(dir, "profiles", "real", "engines", "camoufox");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "-profile", profile], {
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 10_000;
  let found: number[] = [];
  while (Date.now() < deadline && !found.includes(child.pid!)) {
    found = await findPidsByDataDir(profile);
  }
  assert.deepEqual(found, [child.pid]);
});
