/**
 * All the runs and comparisons docs/detection-baselines/README.md reports, in one go: a Windows
 * host runs its own and starts a container for each Linux one. It takes about half an hour, and the
 * display has to stay on. Ten headed runs of under a minute each put a window on top of the
 * screen, and four of them cover it completely for a few seconds: keep away from the mouse then,
 * as a real pointer over the window lands in the input log.
 *
 *   docker build -f docker/Dockerfile --target baseline -t multizen-baseline:local .
 *   corepack yarn workspace @multizen/detection-baseline matrix \
 *     [--only <regex over labels>] [--list] [--compare-only] \
 *     [--engine-version-dir <dir> --camoufox-install <dir>] \
 *     [--docker-engine-version-dir <dir> --docker-engine-version <version>] \
 *     [--docker-camoufox-install <dir>] [--docker-arg <arg>]... [--docker-data-dir <dir>]
 *
 * Without the engine flags each engine downloads, once, into the data directory it runs on:
 * a temp one here, which goes with each run, and in Docker the volume multizen-baseline-data.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const BASELINES_DIR = join(REPO_ROOT, "docs", "detection-baselines");
const IMAGE = "multizen-baseline:local";

const WINDOWS_PERSONA = ["--device", "windows-desktop-nvidia"];
const PRODUCTION_EGRESS = ["--egress", "block-private", "--egress-allow", "localhost,127.0.0.1"];

interface Run {
  label: string;
  host: "windows" | "docker";
  args: string[];
  /** Set inside the container, over the image's own. */
  env?: Record<string, string>;
}

function runsFor(short: "cb" | "cf", engine: "cloakbrowser" | "camoufox"): Run[] {
  const on = (host: Run["host"], name: string, ...args: string[]): Run => ({
    label: `${name}-${short}`,
    host,
    args: ["--engine", engine, ...args],
  });
  const windowsHeaded = (name: string, ...args: string[]): Run =>
    on("windows", `win-headed${name}`, "--mode", "headed", ...WINDOWS_PERSONA, ...args);
  const windowsHeadless = (name: string, ...args: string[]): Run =>
    on("windows", `win-headless${name}`, "--mode", "headless", ...WINDOWS_PERSONA, ...args);
  const linux = (mode: "xvfb" | "headless", name: string, ...args: string[]): Run =>
    on("docker", `linux-${mode}${name}`, "--mode", mode, ...args);
  const both = (make: (mode: "xvfb" | "headless") => Run[]): Run[] => [...make("xvfb"), ...make("headless")];
  return [
    // The desktop itself, and again to see what varies on its own.
    windowsHeaded("-desktop", "--reference", "desktop", "--raise", "--cover-test"),
    windowsHeaded("-desktop-2", "--reference", "desktop", "--raise"),
    // The one difference that's the server's on Windows.
    windowsHeaded("-occlusion", "--reference", "desktop", "--occlusion", "server", "--raise", "--cover-test"),
    // A server on Windows with a window.
    windowsHeaded("-server", ...PRODUCTION_EGRESS, "--raise"),
    windowsHeaded("-server-2", ...PRODUCTION_EGRESS, "--raise"),
    windowsHeadless(""),
    windowsHeadless("-2"),
    windowsHeadless("-server", ...PRODUCTION_EGRESS),
    windowsHeadless("-server-2", ...PRODUCTION_EGRESS),
    ...both((mode) => [
      linux(mode, "", ...WINDOWS_PERSONA),
      linux(mode, "-2", ...WINDOWS_PERSONA),
      linux(mode, "-server", ...WINDOWS_PERSONA, ...PRODUCTION_EGRESS),
      linux(mode, "-server-2", ...WINDOWS_PERSONA, ...PRODUCTION_EGRESS),
      // What a server gets with no --device: a persona of its own OS, as create_profile picks.
      linux(mode, "-linuxpersona", ...PRODUCTION_EGRESS),
      linux(mode, "-linuxpersona-2", ...PRODUCTION_EGRESS),
    ]),
    // The image's LANG against what the driver falls back to without one.
    {
      ...linux("xvfb", "-lang", ...WINDOWS_PERSONA),
      env: { LANG: "en_US.UTF-8" },
    },
  ];
}

const NETLOG_RUNS: Run[] = [
  ["windows", "win-headless", "direct", []],
  ["windows", "win-headless", "bridged", PRODUCTION_EGRESS],
  ["docker", "linux-headless", "direct", []],
  ["docker", "linux-headless", "bridged", PRODUCTION_EGRESS],
].map(([host, name, kind, egress]) => ({
  label: `${name}-netlog-${kind}-cb`,
  host: host as Run["host"],
  args: [
    "--engine",
    "cloakbrowser",
    "--mode",
    "headless",
    "--netlog",
    ...WINDOWS_PERSONA,
    ...(egress as string[]),
  ],
}));

const RUNS: Run[] = [...runsFor("cb", "cloakbrowser"), ...runsFor("cf", "camoufox"), ...NETLOG_RUNS];

/** What gets compared with what, each with the repeat of either side where there is one. */
function comparisonsFor(e: "cb" | "cf"): Array<{ a: string; b: string; repeat?: string; repeatB?: string }> {
  const desktop = `win-headed-desktop-${e}`;
  const desktop2 = `win-headed-desktop-2-${e}`;
  const headless = `win-headless-${e}`;
  const headless2 = `win-headless-2-${e}`;
  const xvfb = `linux-xvfb-${e}`;
  const xvfb2 = `linux-xvfb-2-${e}`;
  const lheadless = `linux-headless-${e}`;
  const lheadless2 = `linux-headless-2-${e}`;
  return [
    // The three the owner asked for.
    { a: desktop, b: headless, repeat: desktop2, repeatB: headless2 },
    { a: xvfb, b: lheadless, repeat: xvfb2, repeatB: lheadless2 },
    { a: desktop, b: xvfb, repeat: desktop2, repeatB: xvfb2 },
    // "No worse than the desktop", in production: a server with its egress policy on.
    { a: desktop, b: `win-headed-server-${e}`, repeat: desktop2, repeatB: `win-headed-server-2-${e}` },
    { a: desktop, b: `win-headless-server-${e}`, repeat: desktop2, repeatB: `win-headless-server-2-${e}` },
    { a: desktop, b: `linux-xvfb-server-${e}`, repeat: desktop2, repeatB: `linux-xvfb-server-2-${e}` },
    { a: desktop, b: `linux-headless-server-${e}`, repeat: desktop2, repeatB: `linux-headless-server-2-${e}` },
    { a: desktop, b: `linux-xvfb-linuxpersona-${e}`, repeat: desktop2, repeatB: `linux-xvfb-linuxpersona-2-${e}` },
    {
      a: `linux-xvfb-linuxpersona-${e}`,
      b: `linux-headless-linuxpersona-${e}`,
      repeat: `linux-xvfb-linuxpersona-2-${e}`,
      repeatB: `linux-headless-linuxpersona-2-${e}`,
    },
    // The open questions.
    { a: desktop, b: `win-headed-occlusion-${e}`, repeat: desktop2 },
    { a: headless, b: `win-headless-server-${e}`, repeat: headless2, repeatB: `win-headless-server-2-${e}` },
    { a: xvfb, b: `linux-xvfb-server-${e}`, repeat: xvfb2, repeatB: `linux-xvfb-server-2-${e}` },
    { a: lheadless, b: `linux-headless-server-${e}`, repeat: lheadless2, repeatB: `linux-headless-server-2-${e}` },
    { a: xvfb, b: `linux-xvfb-lang-${e}`, repeat: xvfb2 },
    // Does a run match itself: what the comparisons above leave out, and nothing else.
    { a: desktop, b: desktop2 },
    { a: headless, b: headless2 },
    { a: xvfb, b: xvfb2 },
    { a: lheadless, b: lheadless2 },
  ];
}

const COMPARISONS = [
  ...comparisonsFor("cb"),
  ...comparisonsFor("cf"),
  { a: "win-headless-netlog-direct-cb", b: "win-headless-netlog-bridged-cb" },
  { a: "linux-headless-netlog-direct-cb", b: "linux-headless-netlog-bridged-cb" },
];

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    list: { type: "boolean" },
    "compare-only": { type: "boolean" },
    "engine-version-dir": { type: "string" },
    "camoufox-install": { type: "string" },
    "docker-engine-version-dir": { type: "string" },
    "docker-engine-version": { type: "string" },
    "docker-camoufox-install": { type: "string" },
    "docker-arg": { type: "string", multiple: true },
    "docker-data-dir": { type: "string", default: "/data" },
  },
});

const only = values.only ? new RegExp(values.only) : null;
const selected = RUNS.filter((run) => !only || only.test(run.label));

function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const SHORT_DIR_LIMIT = 16;

function windowsRun(run: Run, index: number): number {
  // Short: Chromium fails silently on a long user-data-dir here.
  const dataDir = join(process.env.TEMP ?? tmpdir(), `mzb${index}`.slice(0, SHORT_DIR_LIMIT));
  const engine = [
    ...(values["engine-version-dir"] ? ["--engine-version-dir", values["engine-version-dir"]] : []),
    ...(values["camoufox-install"] ? ["--camoufox-install", values["camoufox-install"]] : []),
  ];
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "run.ts", "--label", run.label, "--data-dir", dataDir, "--clean", ...engine, ...run.args],
    { cwd: SCRIPT_DIR, stdio: ["ignore", "ignore", "inherit"], env: process.env },
  );
  return result.status ?? 1;
}

function dockerRun(run: Run): number {
  const engine = [
    ...(values["docker-engine-version-dir"] ? ["--engine-version-dir", values["docker-engine-version-dir"]] : []),
    ...(values["docker-engine-version"] ? ["--engine-version", values["docker-engine-version"]] : []),
    ...(values["docker-camoufox-install"] ? ["--camoufox-install", values["docker-camoufox-install"]] : []),
  ];
  mkdirSync(BASELINES_DIR, { recursive: true });
  const envArgs = Object.entries(run.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `mz-baseline-${run.label}`,
      "--hostname",
      "multizen",
      "--shm-size",
      "1g",
      "--security-opt",
      `seccomp=${join(REPO_ROOT, "docker", "seccomp-chromium.json")}`,
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
      "-v",
      `${BASELINES_DIR}:/repo/docs/detection-baselines`,
      "-v",
      "multizen-baseline-data:/data",
      ...(values["docker-arg"] ?? []),
      ...envArgs,
      IMAGE,
      "--label",
      run.label,
      "--data-dir",
      values["docker-data-dir"]!,
      "--cache-dir",
      "/data/baseline-assets",
      ...engine,
      ...run.args,
    ],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  return result.status ?? 1;
}

function compare(c: { a: string; b: string; repeat?: string; repeatB?: string }): number {
  const date = today();
  const dated = (label: string): string => join(BASELINES_DIR, `${date}-${label}`);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "compare.ts",
      dated(c.a),
      dated(c.b),
      ...(c.repeat ? ["--repeat", dated(c.repeat)] : []),
      ...(c.repeatB ? ["--repeat-b", dated(c.repeatB)] : []),
    ],
    { cwd: SCRIPT_DIR, stdio: ["ignore", "ignore", "inherit"] },
  );
  return result.status ?? 1;
}

if (values.list) {
  for (const run of selected) process.stdout.write(`${run.host.padEnd(8)} ${run.label}  ${run.args.join(" ")}\n`);
  process.exit(0);
}

const failed: string[] = [];
if (!values["compare-only"]) {
  for (const [i, run] of selected.entries()) {
    process.stdout.write(`[${i + 1}/${selected.length}] ${run.host} ${run.label}\n`);
    const status = run.host === "windows" ? windowsRun(run, i) : dockerRun(run);
    if (status !== 0) failed.push(`${run.label} exited ${status}`);
  }
}
for (const c of COMPARISONS) {
  const status = compare(c);
  process.stdout.write(`compare ${c.a} vs ${c.b}: exit ${status}\n`);
  if (status !== 0) failed.push(`compare ${c.a} vs ${c.b} exited ${status}`);
}
if (failed.length > 0) {
  process.stdout.write(`Not everything passed:\n${failed.join("\n")}\n`);
  process.exitCode = 1;
}
