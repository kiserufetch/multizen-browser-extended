/**
 * One detection baseline: launches a profile through the server's own runtime, with no MCP in
 * between, and records what pages and servers can see of it. Everything is self-hosted on
 * loopback, the detector pages included, at the commits and hashes in assets.lock.json.
 *
 *   corepack yarn workspace @multizen/detection-baseline baseline \
 *     --engine cloakbrowser --mode headless --label win-headless --data-dir %TEMP%\mzb \
 *     [--egress block-private --egress-allow localhost,127.0.0.1] [--device windows-desktop-nvidia] \
 *     [--seed <text>] [--reference desktop] [--occlusion none|server] [--raise] [--cover-test] [--netlog] \
 *     [--engine-version-dir <dir with chrome.exe> [--engine-version <version>]] [--camoufox-install <dir>] \
 *     [--out-root <dir>] [--cache-dir <dir>] [--clean]
 *
 * Writes docs/detection-baselines/<yyyy-mm-dd>-<label>/{result.json,*.png,...}. A section that
 * can't be taken says why in place of its data, and the run goes on. A run with no local section
 * at all exits 1, with the file still written.
 *
 * --device picks the persona; left out, a persona of this OS, as create_profile would. The same
 * --seed and --device give the same persona on any OS. Camoufox draws its own fingerprint on top
 * at every launch, so only that persona's OS, screen, locale and timezone hold across its runs.
 *
 * --reference desktop is the desktop's own launch: no egress bridge, no occlusion handling, and
 * the companion extension. --occlusion says which occlusion handling a run has, whatever else it
 * is: `server` by default, `none` with --reference desktop.
 * --raise keeps a headed window on top for the run, Windows only, with the keyboard focus left
 * where it was: a window started from a background process otherwise opens behind whatever is in
 * front, and on Windows a fully covered window's page reads as hidden and takes no input. A run of
 * the desktop's window in front has to be that.
 * --cover-test puts a window over the whole desktop for a few seconds, Windows only, to see what
 * a page reads when its window is covered and whether a click still arrives.
 * --netlog writes the browser's NetLog (CloakBrowser only), has a page ask for a name that exists
 * nowhere, and reports how that went: DNS or the proxy, DoH or not, HTTPS records or not.
 *
 * Certificates: the TLS site is self-signed. CloakBrowser takes it through one CDP call around
 * that one page load, Camoufox through a Playwright launch option in this process only.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  acquireServerLock,
  browserDataDirForEngine,
  isEgressMode,
  systemProcReader,
  type EgressMode,
  pinnedCloakBrowserManifest,
} from "@multizen/browser-runtime";
import { generateFingerprint, reconcileFingerprint } from "@multizen/profile-manager";
import { buildRuntime, takeOverFromPreviousRun, type MeasurementOverrides } from "@multizen/server/runtime";
import type { BrowserEngine, DeviceFamily, DisplayModeSetting, FingerprintConfig, Profile } from "@multizen/types";
import { isBrowserEngine, isDisplayMode } from "@multizen/types";
import { readAssetLock } from "./lib/assets.ts";
import { allUnavailable, askForAName, collectSections, runExitCode } from "./lib/baseline.ts";
import type { RunResult, SectionResult } from "./lib/compare.ts";
import { startLocalSite } from "./lib/localServer.ts";
import { analyzeNetLog } from "./lib/netlog.ts";
import { startStunResponder } from "./lib/stun.ts";
import { startTlsSite } from "./lib/tlsSite.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
/** With windows-desktop-nvidia: 1920x1080, en-IE, Europe/Dublin, 8 threads. Nothing unusual to read past. */
const DEFAULT_SEED = "mz-baseline-70";
/** Which of this machine's addresses WebRTC's STUN goes to, if the first isn't right. */
const LAN_ADDRESS_ENV = "MULTIZEN_BASELINE_LAN_ADDRESS";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "cloakbrowser" },
    mode: { type: "string", default: "auto" },
    label: { type: "string" },
    "data-dir": { type: "string" },
    egress: { type: "string", default: "allow-all" },
    "egress-allow": { type: "string", default: "" },
    device: { type: "string" },
    seed: { type: "string", default: DEFAULT_SEED },
    reference: { type: "string" },
    occlusion: { type: "string" },
    raise: { type: "boolean" },
    "cover-test": { type: "boolean" },
    netlog: { type: "boolean" },
    "engine-version-dir": { type: "string" },
    "engine-version": { type: "string" },
    "camoufox-install": { type: "string" },
    "out-root": { type: "string" },
    "cache-dir": { type: "string" },
    clean: { type: "boolean" },
  },
});

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseEngine(value: string): BrowserEngine {
  return isBrowserEngine(value) ? value : usage(`--engine: unknown engine "${value}"`);
}

const engine = parseEngine(values.engine!);
const isCamoufox = engine === "camoufox";
const mode = values.mode! as DisplayModeSetting;
if (mode !== "auto" && !isDisplayMode(mode)) usage(`--mode takes headed, xvfb, headless or auto, got "${mode}"`);
const label = values.label ?? usage("--label is required");
if (!/^[\w.-]+$/.test(label)) usage("--label takes letters, digits, dots, dashes and underscores");
const dataDirFlag = values["data-dir"] ?? usage("--data-dir is required");
const dataDir = resolve(dataDirFlag);
const reference = values.reference;
if (reference !== undefined && reference !== "desktop") usage(`--reference only takes desktop, got "${reference}"`);
const desktopReference = reference === "desktop";
const occlusion = values.occlusion ?? (desktopReference ? "none" : "server");
if (occlusion !== "none" && occlusion !== "server") usage(`--occlusion takes none or server, got "${occlusion}"`);
const egressFlag = desktopReference ? "allow-all" : values.egress!;
if (!isEgressMode(egressFlag)) usage(`--egress takes allow-all or block-private, got "${egressFlag}"`);
const egress: EgressMode = egressFlag;
const egressAllow = values["egress-allow"]!.split(",").map((s) => s.trim()).filter(Boolean);
const netlog = values.netlog === true;
if (netlog && isCamoufox) usage("--netlog is CloakBrowser only");
const coverTest = values["cover-test"] === true;
if (coverTest && (process.platform !== "win32" || mode !== "headed")) usage("--cover-test needs a real window on Windows");
const raise = values.raise === true;
if (raise && (process.platform !== "win32" || mode !== "headed")) usage("--raise needs a real window on Windows");

/** Local, as that's the day whoever runs this means. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const date = today();
const outRoot = values["out-root"] ? resolve(values["out-root"]) : join(REPO_ROOT, "docs", "detection-baselines");
const outDir = join(outRoot, `${date}-${label}`);
mkdirSync(outDir, { recursive: true });
const log = (message: string): void => {
  process.stderr.write(`[baseline ${label}] ${message}\n`);
};

// ── the engine, linked in rather than downloaded ────────────────────────────

const links: string[] = [];

function link(at: string, target: string): void {
  if (existsSync(at)) return;
  links.push(at);
  if (process.platform === "win32") {
    const made = spawnSync("cmd", ["/c", "mklink", "/J", at, target], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`mklink failed: ${made.stdout}${made.stderr}`);
    return;
  }
  symlinkSync(target, at);
}

function prepareDataDir(): void {
  mkdirSync(dataDir, { recursive: true });
  const camoufox = values["camoufox-install"];
  if (camoufox) link(join(dataDir, "camoufox"), resolve(camoufox));
  const versionDir = values["engine-version-dir"];
  if (!versionDir) return;
  const version = values["engine-version"] ?? basename(resolve(versionDir));
  const cache = join(dataDir, "chromium", "cloakbrowser");
  mkdirSync(cache, { recursive: true });
  link(join(cache, version), resolve(versionDir));
  // Says it is the pinned build: only the operator of this script knows. A server takes nothing else.
  const pin = pinnedCloakBrowserManifest();
  if (version !== pin.version) throw new Error(`The engine is ${version}, and the server only runs ${pin.version}`);
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({
      version,
      binaryRelative: process.platform === "win32" ? "chrome.exe" : "chrome",
      sha256: pin.sha256,
    }),
  );
}

/** Links go first, so nothing deleted after this can follow one. */
function removeLinks(): void {
  for (const at of links) {
    if (!existsSync(at)) continue;
    if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", at], { encoding: "utf8" });
    else if (lstatSync(at).isSymbolicLink()) unlinkSync(at);
  }
}

// ── what the run is ─────────────────────────────────────────────────────────

/** Same seed and device on any host: only a persona left to default follows the host's OS. */
function personaFor(seed: string, device: string | undefined): FingerprintConfig {
  const generated = generateFingerprint(seed, device ? { hostFilter: false } : {});
  const fingerprint = device
    ? reconcileFingerprint(generated, { device: device as DeviceFamily })
    : generated;
  return { ...fingerprint, seed };
}

function lanAddress(): string {
  const fromEnv = process.env[LAN_ADDRESS_ENV];
  if (fromEnv) return fromEnv;
  for (const addresses of Object.values(networkInterfaces())) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  return "127.0.0.1";
}

const COVER_SCRIPT = (ms: number): string => `
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = 'Manual'
$form.BackColor = 'Black'
$form.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = ${ms}
$timer.add_Tick({ $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

/** An opaque window over every screen, for this long. Closes itself. */
function coverWindow(ms: number): Promise<void> {
  return new Promise((done) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", COVER_SCRIPT(ms)], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => done());
    child.on("exit", () => done());
  });
}

const RAISE_SCRIPT = (pids: readonly number[]): string => `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Mz {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$raised = 0
$pids = @(${pids.join(",")})
$proc = [Mz+EnumProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [void][Mz]::GetWindowThreadProcessId($hWnd, [ref]$owner)
  if ($pids -contains $owner -and [Mz]::IsWindowVisible($hWnd)) {
    # HWND_TOPMOST, and SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE.
    [void][Mz]::SetWindowPos($hWnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0013)
    $script:raised++
  }
  $true
}
[void][Mz]::EnumWindows($proc, [IntPtr]::Zero)
$raised
`;

/**
 * On top of everything without taking the keyboard from whoever is at this machine. Any
 * process under this one counts: Firefox's first process only starts the one with the window.
 */
async function raiseWindow(pid: number): Promise<number> {
  const processes = await systemProcReader().list();
  const family = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const proc of processes) {
      if (family.has(proc.ppid) && !family.has(proc.pid)) {
        family.add(proc.pid);
        grew = true;
      }
    }
  }
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", RAISE_SCRIPT([...family])], {
    encoding: "utf8",
    windowsHide: true,
  });
  return Number(result.stdout.trim()) || 0;
}

/** What the browser was really started with, this run's paths and ports taken out. */
async function browserArgv(pid: number, profile: Profile): Promise<string[] | null> {
  const engineDir = browserDataDirForEngine(profile.dataDir, engine);
  const [proc] = await systemProcReader().read([pid]);
  if (!proc) return null;
  return proc.argv
    .slice(1)
    .map((arg) =>
      arg
        .split(engineDir)
        .join("<profile>")
        .split(dataDir)
        .join("<data-dir>")
        .replace(/(--remote-debugging-port=)\d+/, "$1<port>")
        .replace(/(--proxy-server=socks5:\/\/[^:]+:)\d+/, "$1<port>")
        .replace(/(--log-net-log=).*/, "$1<file>"),
    );
}

const FIREFOX_PREF_REPORTED = /occlusion|network\.proxy\.|network\.trr|network\.dns\.|http3|webtransport|prefetch|speculative|peerconnection/;

/** The prefs that decide what this run is about, as Firefox saved them on its way out. */
function firefoxPrefs(profile: Profile): string[] {
  const path = join(browserDataDirForEngine(profile.dataDir, engine), "prefs.js");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("user_pref(") && FIREFOX_PREF_REPORTED.test(line))
    .map((line) => line.replace(/\s+/g, " "))
    .sort();
}

function writeResult(result: RunResult): void {
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 1));
}

async function main(): Promise<number> {
  const started = Date.now();
  const fingerprint = personaFor(values.seed!, values.device);
  const meta: Record<string, unknown> = {
    label,
    date,
    engine,
    mode,
    egress,
    egressAllow,
    seed: values.seed,
    reference: reference ?? null,
    occlusion,
    platform: process.platform,
    nodeVersion: process.version,
    lang: process.env.LANG ?? null,
    persona: {
      device: fingerprint.device,
      screen: fingerprint.screen,
      locale: fingerprint.locale,
      timezone: fingerprint.timezone,
      hardwareConcurrency: fingerprint.hardwareConcurrency,
      deviceMemory: fingerprint.deviceMemory,
      webgl: fingerprint.webgl,
      userAgent: fingerprint.userAgent,
    },
  };

  prepareDataDir();
  const lock = await acquireServerLock(dataDir, { mode: "cli" });
  let sections: Record<string, SectionResult> = allUnavailable("the run never got that far");

  // Measurement only. Every path into this is this script's flags.
  const netLogPath = join(tmpdir(), `mz-netlog-${process.pid}.json`);
  const measurement: MeasurementOverrides = {
    ...(occlusion === "none" ? { disabledFeatures: [], firefoxPrefs: {} } : {}),
    ...(isCamoufox ? { firefoxLaunchExtras: { ignoreHTTPSErrors: true } } : {}),
    ...(netlog ? { chromiumArgs: [`--log-net-log=${netLogPath}`] } : {}),
    ...(desktopReference && !isCamoufox
      ? { companionDir: join(REPO_ROOT, "apps", "desktop", "resources", "companion") }
      : {}),
  };

  const site = await startLocalSite();
  const tls = await startTlsSite();
  const stun = await startStunResponder();
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
  try {
    const journal = await takeOverFromPreviousRun(dataDir);
    runtime = await buildRuntime(
      {
        dataDir,
        defaultEngine: engine,
        maxBrowsers: 2,
        displayMode: mode,
        headless: false,
        egressPolicy: egress,
        egressAllow,
        measurement,
      },
      journal,
    );
    const status = await runtime.engineRegistry.ensure(engine);
    meta.engineVersion = "version" in status ? status.version : null;
    const profile = runtime.profileManager.create({
      name: `baseline-${label}`,
      engine,
      fingerprint,
    });
    try {
      log(`launching ${engine}, mode ${mode}, egress ${egress}, persona ${fingerprint.device}`);
      const launched = await runtime.driver.launch(profile.id);
      meta.displayMode = launched.displayMode ?? null;
      meta.browserArgv = launched.pid ? await browserArgv(launched.pid, profile) : null;
      if (raise) {
        const raised = launched.pid ? await raiseWindow(launched.pid) : 0;
        if (raised === 0) log("no window found to raise: its page may read as hidden");
        meta.raisedWindows = raised;
        // A window a person opened has the focus, which this gives its page and no more.
        await runtime.driver.performAction(profile.id, { type: "bring_to_front" });
      }
      sections = await collectSections({
        driver: runtime.driver,
        profileId: profile.id,
        usesCdp: !isCamoufox,
        outDir,
        site,
        tls,
        stun,
        stunHost: lanAddress(),
        assetLock: readAssetLock(join(SCRIPT_DIR, "assets.lock.json")),
        cacheRoot: values["cache-dir"] ? resolve(values["cache-dir"]) : join(SCRIPT_DIR, ".cache"),
        log,
        ...(coverTest ? { coverWindow } : {}),
      });
      if (netlog) await askForAName(runtime.driver, profile.id, site.url("/p/visibility.html"));
    } catch (e) {
      sections = allUnavailable(`The browser did not come up: ${(e as Error).message}`);
      log(`launch failed: ${(e as Error).message}`);
    }
    await runtime.driver.close(profile.id).catch(() => {});
    if (isCamoufox) meta.firefoxPrefs = firefoxPrefs(profile);
    if (netlog) {
      try {
        sections.netlog = { status: "ok", data: analyzeNetLog(readFileSync(netLogPath, "utf8")) };
      } catch (e) {
        sections.netlog = { status: "unavailable", reason: (e as Error).message };
      }
      rmSync(netLogPath, { force: true });
    }
    runtime.profileManager.delete(profile.id);
  } catch (e) {
    sections = allUnavailable(`The runtime did not start: ${(e as Error).message}`);
    log(`runtime failed: ${(e as Error).stack ?? (e as Error).message}`);
  } finally {
    await runtime?.close().catch((e: unknown) => log(`closing: ${(e as Error).message}`));
    await site.close();
    await tls.close();
    await stun.close();
    lock.release();
    removeLinks();
    if (values.clean) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  meta.durationMs = Date.now() - started;
  writeResult({ meta, sections });
  for (const [name, section] of Object.entries(sections)) {
    log(`${name}: ${section.status === "ok" ? "ok" : `unavailable: ${section.reason}`}`);
  }
  log(`written to ${outDir}`);
  return runExitCode(sections);
}

process.exitCode = await main();
