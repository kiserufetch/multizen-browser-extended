import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import type { BrowserDriver } from "@multizen/types";
import { deviceMemoryApiValue, type ProfileManager } from "@multizen/profile-manager";
import type {
  CapturedFrame,
  ChromiumStatus,
  ClientHints,
  DialogPolicy,
  DialogResponse,
  DownloadFile,
  DownloadRecord,
  DisplayMode,
  DriverAction,
  FingerprintConfig,
  LaunchedProfile,
  LaunchOptions,
  OpenDialog,
  ProfileId,
} from "@multizen/types";
import {
  MultizenError,
  PROFILE_DOWNLOADS_DIR,
  resolveEngine,
  type BrowserEngine,
} from "@multizen/types";
import { CdpSession } from "@multizen/cdp-driver";
import { EngineRegistry } from "./engineRegistry.ts";
import type { EgressPolicy } from "./egressPolicy.ts";
import { asEgressBlocked, startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { resolveProxyLaunchGeo } from "./launchGeo";
import { companionDir } from "./extensions/companion";
import { resolveLoadDir } from "./extensions/extensionStore.ts";
import { killProcessTree, gracefulShutdown } from "./processTree";
import { assertSpawnedBrowser, waitForCdpSessionReady } from "./cdpReadiness";
import { sharedDownloadTracker, type DownloadTracker } from "./downloads.ts";
import { sanitizeStartUrl } from "./startPage";
import { firstFreePort } from "./portProbe.ts";
import { displayEnv, HEADLESS_CHROMIUM_ARGS } from "./displayMode.ts";
import { SINGLETON_FILES, type ProcessJournal } from "./runState.ts";
import { startXvfb, type XvfbHandle } from "./xvfb.ts";
import { sandboxInstructions } from "./linuxSandbox.ts";
import type { RuntimeHost } from "./host.ts";

function readSysctl(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null; // file absent (kernel doesn't expose this knob)
  }
}

/** Chromium stderr signatures that mean the user-namespace sandbox could not
 *  start (so a relaunch with --no-sandbox is warranted). Kept to failure-only
 *  phrases — a generic token like CLONE_NEWUSER could appear on a healthy
 *  launch and must NOT trigger the backstop. The backstop also requires the
 *  child to have actually exited, so a stray match alone can't disable the
 *  sandbox. */
const SANDBOX_FAILURE_RE = /No usable sandbox|Failed to move to new (?:user )?namespace/i;

/** Thrown by the spawn attempt when the sandbox failed to start, so the caller
 *  can relaunch once with --no-sandbox (never re-prompting). */
class SandboxStartupError extends Error {}

const STDERR_TAIL_CHARS = 2_048;

/**
 * Chromium takes one pixel off each side of a window the exact size of its screen,
 * to keep window managers from maximizing it: 1919x1079 on a 1920x1080 persona. A real
 * screen a pixel larger gives the window the persona's size. Pages can't see this: the
 * persona's flags decide `screen.*` and the CSS device size (measured on CloakBrowser 146).
 */
const XVFB_SCREEN_MARGIN_PX = 1;

/**
 * A window opening on about:blank puts the focus in its address bar, for a person to
 * type in, and it stays there through a navigation: `document.hasFocus()` reads false
 * until someone clicks the page, with or without a window manager (measured under Xvfb,
 * and in headless on Linux and Windows). With no window to raise and nobody to click,
 * this does what the click would. Headed stays as it was, since it would take the
 * desktop's focus from whoever is using it.
 */
export async function focusFirstPage(
  session: Pick<CdpSession, "bringToFront">,
  displayMode: DisplayMode,
): Promise<void> {
  if (displayMode === "headed") return;
  await session.bringToFront().catch((e: unknown) => {
    console.warn("[multizen] could not focus the first page:", (e as Error).message);
  });
}

/**
 * What the browser last said is often the only clue why it never answered: a missing
 * library, a rejected flag. The two typed cases already say what happened.
 */
function withStderrTail(e: unknown, tail: string): Error {
  const error = e instanceof Error ? e : new Error(String(e));
  if (!tail.trim() || error instanceof SandboxStartupError || error instanceof MultizenError) {
    return error;
  }
  error.message = `${error.message}\nThe browser's stderr ended with:\n${tail.trimEnd()}`;
  return error;
}

/**
 * Sync fallback used ONLY when the async sandbox resolver is absent or throws:
 * whether the spawned Chromium child must run with `--no-sandbox` on Linux.
 *
 * Chromium's sandbox needs unprivileged user namespaces, which modern distros
 * restrict by default (Ubuntu 24.04+ via `apparmor_restrict_unprivileged_userns`,
 * older Debian via `unprivileged_userns_clone`). When restricted, the child dies
 * with "No usable sandbox!" and never exposes its CDP port. The richer path that
 * keeps the sandbox ON via a per-binary AppArmor profile lives in
 * `linuxSandbox.ts`; this is just the degrade-to-today's-behavior safety net.
 */
function fallbackNeedsNoSandbox(): boolean {
  if (process.platform !== "linux") return false;
  // A --no-sandbox on the HOST process (e.g. the AppImage boot flag on Ubuntu
  // 24.04) is deliberately NOT forwarded here: the engine decision is driven by
  // the actual kernel restriction below, and the crash backstop is the net.
  return (
    readSysctl("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1" ||
    readSysctl("/proc/sys/kernel/unprivileged_userns_clone") === "0"
  );
}

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
  /** The engine's `--user-data-dir`. Used to sweep any lingering browser
   *  process that still holds this profile's data dir on shutdown. */
  browserDataDir: string;
  /** Polls /json/list and kills the child when no page targets remain. */
  windowWatcher: NodeJS.Timeout;
  /** Set once this browser's downloads go to the profile's downloads directory. */
  downloadsArmed?: Promise<void>;
  displayMode: DisplayMode;
  /** Its private display, in xvfb mode. Ends when the browser does. */
  xvfb?: XvfbHandle;
}

/** A launch under way, which everyone asking for this profile meanwhile shares. */
interface LaunchInProgress {
  promise: Promise<LaunchedProfile>;
  /** Shutting down: nobody wants this browser any more. */
  aborted: boolean;
  /** Set while a browser is coming up: stops waiting for it, and so kills it. */
  killStarting?: () => void;
}

function sandboxUnavailable(): MultizenError {
  return new MultizenError(
    "SANDBOX_UNAVAILABLE",
    "Chromium's sandbox could not start, and this server never runs a browser without it.",
    { hint: sandboxInstructions() },
  );
}

function launchAborted(): MultizenError {
  return new MultizenError("LAUNCH_FAILED", "The launch was abandoned: the server is shutting down.");
}

export interface ChromiumBrowserDriverOptions {
  host: RuntimeHost;
  profileManager: ProfileManager;
  /** Registry that owns the per-engine bootstraps. The driver resolves each
   *  profile's engine at launch and pulls that engine's binary from here. */
  engineRegistry: EngineRegistry;
  /** The app-wide default engine (settings.browserEngine) for profiles that
   *  haven't pinned one. Read live so a settings change takes effect. */
  getDefaultEngine: () => BrowserEngine;
  /**
   * Called when the companion extension's "Add to MultiZen" button is clicked
   * inside a running profile. `profileId` is the profile that made the call
   * (the CDP session is profile-scoped). The host installs the extension.
   */
  onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  /** Root of the shared extension store, e.g. `<userData>/data/extension-store`.
   *  Used to resolve shared extension references to their on-disk load dir. */
  extensionStoreRoot: string;
  /**
   * Decide, per launch, whether to pass `--no-sandbox` to the engine child
   * (the Linux AppArmor flow — detect restriction, verify/offer the secure
   * setup, else fall back). Injected from the host so the driver stays UI-free.
   * Omitted or throwing → the sync `fallbackNeedsNoSandbox()` is used instead.
   */
  resolveSandboxDecision?: (ctx: {
    engine: BrowserEngine;
    binaryPath: string;
  }) => Promise<{ noSandbox: boolean }>;
  /**
   * Called with the engine binary path when the crash-detection backstop had to
   * relaunch with `--no-sandbox` because the sandbox failed despite us expecting
   * it to work, so the host can mark that binary's AppArmor profile inactive for
   * the session and re-offer setup (instead of optimistically retrying it every
   * launch).
   */
  onSandboxInactive?: (binaryPath: string) => void;
  /**
   * Never run a browser with `--no-sandbox`, whatever the kernel says: for a server,
   * whose pages come from agents and whose windows nobody watches. This bypasses the
   * resolver, the fallback and the crash backstop, and a sandbox that fails to start
   * fails the launch with SANDBOX_UNAVAILABLE. Default: the desktop's flow above.
   */
  requireSandbox?: boolean;
  /**
   * The caller holds the data dir's `server.lock`, so nothing else of ours can be using
   * a profile here and this driver only spawns for one it isn't running. Then any
   * `Singleton*` is left over and goes before the spawn, unjudged: judging one by its
   * PID is what a restarted container gets wrong, with PIDs reused under a fixed hostname.
   */
  ownsDataDir?: boolean;
  /** Told about each process as it starts and ends, for the next start's reaper. Default: none. */
  processJournal?: ProcessJournal;
  /** Where Xvfb's auth files go. Default: the system's temp directory. */
  xvfbRunDir?: string;
  /** Receives the browser's stderr. Default: raw lines on this process's stderr. */
  onBrowserStderr?: (pid: number, text: string) => void;
  /** Budget for the CDP readiness ladder after spawn. Default 15 s. */
  readinessBudgetMs?: number;
  /** Picks the --remote-debugging-port. Default: the next free port from 9222. */
  allocatePort?: () => Promise<number>;
  /** Added to the launch's one `--disable-features=` switch. Default: none. */
  extraDisabledFeatures?: readonly string[];
  /**
   * Send a browser's downloads to the profile's downloads directory from launch, for
   * a server, whose browsers nobody clicks in. Default: from the first list_downloads
   * or get_download, so a person's downloads in a desktop profile stay as they were
   * until an agent asks.
   */
  armDownloadsAtLaunch?: boolean;
  /**
   * Where a browser may connect. Not given, or `allow-all`, every launch has the flags it
   * always had. Enforcing, every profile runs through the bridge, which checks each
   * connection, and loopback no longer skips it.
   */
  egress?: EgressPolicy;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
  // Shutdown has begun (window closed / Stop pressed) but the process hasn't
  // fully exited yet — the GUI shows a "Terminating…" transitional state.
  | { kind: "closing"; profileId: ProfileId }
  | { kind: "closed"; profileId: ProfileId; reason: "user-close" | "external-exit" };

interface DriverEvents {
  "running-changed": (change: RunningStateChange) => void;
}

/**
 * Real driver: spawns Chromium per profile with --user-data-dir + --remote-debugging-port,
 * connects to its CDP endpoint, and routes navigate / click / type / extract / screenshot
 * through the CdpSession.
 *
 * `click` and `type` accept CSS selectors only. Natural-language target resolution is
 * intentionally not built in — the MCP client (Claude in Cursor / Claude Desktop / etc.)
 * is responsible for parsing the page snapshot and producing selectors. MultiZen never
 * calls any external API.
 */
export class ChromiumBrowserDriver extends EventEmitter implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningProcess>();
  private readonly launching = new Map<ProfileId, LaunchInProgress>();
  private nextPort = 9222;
  private readonly host: RuntimeHost;
  private readonly profileManager: ProfileManager;
  private readonly engineRegistry: EngineRegistry;
  private readonly getDefaultEngine: () => BrowserEngine;
  private readonly onCompanionInstall?: (profileId: ProfileId, extensionId: string) => void;
  private readonly extensionStoreRoot: string;
  private readonly resolveSandboxDecision?: (ctx: {
    engine: BrowserEngine;
    binaryPath: string;
  }) => Promise<{ noSandbox: boolean }>;
  private readonly onSandboxInactive?: (binaryPath: string) => void;
  private readonly requireSandbox: boolean;
  private readonly ownsDataDir: boolean;
  private readonly processJournal?: ProcessJournal;
  private readonly xvfbRunDir?: string;
  private readonly onBrowserStderr?: (pid: number, text: string) => void;
  private readonly readinessBudgetMs: number;
  private readonly customAllocatePort?: () => Promise<number>;
  private readonly extraDisabledFeatures: readonly string[];
  private readonly armDownloadsAtLaunch: boolean;
  private readonly egress?: EgressPolicy;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.host = opts.host;
    this.profileManager = opts.profileManager;
    this.engineRegistry = opts.engineRegistry;
    this.getDefaultEngine = opts.getDefaultEngine;
    this.onCompanionInstall = opts.onCompanionInstall;
    this.extensionStoreRoot = opts.extensionStoreRoot;
    this.resolveSandboxDecision = opts.resolveSandboxDecision;
    this.onSandboxInactive = opts.onSandboxInactive;
    this.requireSandbox = opts.requireSandbox ?? false;
    this.ownsDataDir = opts.ownsDataDir ?? false;
    this.processJournal = opts.processJournal;
    this.xvfbRunDir = opts.xvfbRunDir;
    this.onBrowserStderr = opts.onBrowserStderr;
    this.readinessBudgetMs = opts.readinessBudgetMs ?? 15000;
    this.customAllocatePort = opts.allocatePort;
    this.extraDisabledFeatures = opts.extraDisabledFeatures ?? [];
    this.armDownloadsAtLaunch = opts.armDownloadsAtLaunch ?? false;
    this.egress = opts.egress;
  }

  override on<K extends keyof DriverEvents>(event: K, listener: DriverEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof DriverEvents>(
    event: K,
    ...args: Parameters<DriverEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /** Idempotent: a running profile answers as it is, and parallel calls share one launch. */
  async launch(profileId: ProfileId, opts: LaunchOptions = {}): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: existing.cdpEndpoint,
        pid: existing.pid,
        startedAt: existing.startedAt,
        displayMode: existing.displayMode,
      };
    }
    const underway = this.launching.get(profileId);
    if (underway) return underway.promise;

    const launch = { aborted: false } as LaunchInProgress;
    launch.promise = this.doLaunch(profileId, launch, opts.displayMode ?? "headed")
      .then(async (launched) => {
        if (!launch.aborted) return launched;
        await this.shutdownProfile(profileId, "user-close");
        throw launchAborted();
      })
      .finally(() => this.launching.delete(profileId));
    this.launching.set(profileId, launch);
    return launch.promise;
  }

  private async doLaunch(
    profileId: ProfileId,
    launch: LaunchInProgress,
    displayMode: DisplayMode,
  ): Promise<LaunchedProfile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new MultizenError("PROFILE_NOT_FOUND", `Profile ${profileId} not found`);

    // First of all: the geo probe below connects to this proxy from this process.
    if (profile.proxy) await this.egress?.assertProxyAllowed(profile.proxy);

    // Update `last_opened_at` for every launch, regardless of trigger
    // (UI button, MCP tool, command palette). Done early so even a
    // failed-to-spawn launch counts — the user pressed Launch.
    this.profileManager.markOpened(profileId);

    // Resolve the profile's engine (its own pin, else the app default, else
    // CloakBrowser) and drive it from that engine's bootstrap binary.
    const engine = resolveEngine(profile.engine, this.getDefaultEngine());
    const bootstrap = this.engineRegistry.get(engine);
    // Binary-gate the launch on THIS profile's engine: download/verify it if it
    // isn't cached yet. Idempotent and fast once installed. A not-ready engine
    // therefore blocks only its own profiles — a different engine's profiles
    // (and the rest of the app) are unaffected.
    const engineStatus = await bootstrap.ensure();
    if (engineStatus.kind !== "ready" && engineStatus.kind !== "dev-system") {
      throw new MultizenError(
        "ENGINE_NOT_READY",
        `Engine "${engine}" is not ready to launch (status: ${engineStatus.kind}).`,
      );
    }
    const chromiumPath = bootstrap.resolveBinaryPath();
    const browserDataDir = browserDataDirForEngine(profile.dataDir, engine);
    // Read the actual Chromium binary's version and reconcile the
    // profile's spoofed UA against it. Detection vendors fingerprint the
    // JS engine and compare against the claimed UA — claiming Chrome
    // 148 while running 147 is an instant flag.
    //
    // Prefer the version the bootstrap already resolved (from current.json
    // at download time) — it's free and avoids spawning the binary. On
    // Windows `chrome.exe --version` does NOT print the version; it just
    // opens a normal browser window, which we then kill after 2s. That
    // produced the "browser opens, closes, opens again" flicker on every
    // launch on Windows. The EXE-metadata fallback never spawns the
    // browser, so it closes that gap.
    const actualVersion = await resolveChromiumVersion(engineStatus, chromiumPath);
    // Reconcile the claimed Chrome version to the actual binary version on
    // every launch, so legacy profiles auto-fix after an engine update.
    // CloakBrowser is built for cross-platform spoofing — claiming Windows
    // on a Mac binary is exactly its job (--fingerprint-platform=windows
    // patches V8/CSS/Blink at C++ level), so we respect the persona's
    // platform choice as-is.
    let fp = profile.fingerprint;
    if (actualVersion) fp = reconcileVersionInFingerprint(fp, actualVersion);

    // Resolved BEFORE we build CLI args: CloakBrowser's --fingerprint-timezone=
    // is set at spawn time and reads fp.timezone at that moment.
    const launchGeo = await resolveProxyLaunchGeo(profile, fp, {
      setProxyCountry: (id, country) => this.profileManager.setProxyCountry(id, country),
    });
    fp = launchGeo.fingerprint;
    const geoCoords = launchGeo.coords;

    // Clean up stale SingletonLock left behind by a Chromium that
    // crashed without unlinking its own lock. Without this, the next
    // launch sees `SingletonLock -> hostname-PID` pointing to a dead
    // PID and silently exits (the "socket hang up" the user sees: CDP
    // briefly opens, profile-in-use check fires, process bails).
    if (!this.ownsDataDir) {
      await cleanStaleSingletonLocks(browserDataDir).catch((e: unknown) => {
        console.warn("[multizen] failed to clean Singleton locks:", (e as Error).message);
      });
    }

    // macOS records app crashes and on next launch shows
    // "Reopen windows from previous crash?" modal via NSPersistentUIRestorer.
    // CloakBrowser's stealth patches DCHECK on unexpected modal dialogs
    // and the binary crashes mid-dialog (EXC_BREAKPOINT). Both layers
    // need to be defused: delete the saved-state bundle for the binary's
    // bundle id, and turn off persistence in user defaults.
    if (process.platform === "darwin") {
      await disableMacOsPersistentStateRestore().catch((e: unknown) => {
        console.warn("[multizen] persistent-state cleanup skipped:", (e as Error).message);
      });
    }

    // Reopen last-session tabs on every launch — what Multilogin / AdsPower /
    // GoLogin do by default. Restore itself is forced by the
    // --restore-last-session CLI flag below; here we only mark the previous exit
    // as clean in the Default profile's Preferences (exit_type=Normal) so
    // Chromium doesn't skip restore or show a crash infobar. Mutated before
    // spawn (Chrome must be off to avoid corrupting the pref file).
    await ensureSessionRestore(browserDataDir).catch((e: unknown) => {
      console.warn("[multizen] failed to write session restore preference:", (e as Error).message);
    });

    // Chromium's --accept-lang flag expects a PLAIN comma-separated list
    // of language tags ("en-US,en"). It then computes q-values itself for
    // the HTTP Accept-Language header AND for `navigator.languages`. If
    // we pass a pre-formatted string with q-values ("en-US,en;q=0.9"),
    // Chromium parses it as ["en-US", "en;q=0.9"] and then re-adds q's,
    // producing the malformed "en-US,en;q=0.9;q=0.9" we saw on browserscan.
    // Linux sandbox decision. Prefer the injected resolver (AppArmor flow:
    // detect restriction, verify/offer the one-time secure setup, else fall
    // back). If it's absent or throws, degrade to the sync fallback so a
    // resolver failure can never dead-launch. `--no-sandbox` is NOT added to the
    // args literal below; it's applied at spawn time so the crash backstop can
    // relaunch with it without rebuilding the args.
    let noSandbox = false;
    if (!this.requireSandbox) {
      try {
        noSandbox = this.resolveSandboxDecision
          ? (await this.resolveSandboxDecision({ engine, binaryPath: chromiumPath })).noSandbox
          : fallbackNeedsNoSandbox();
      } catch (e) {
        console.warn("[multizen] sandbox resolver failed; using fallback:", (e as Error).message);
        noSandbox = fallbackNeedsNoSandbox();
      }
    }

    // Probed here, after the engine download and geo lookup: this close to the
    // spawn, a free port is still likely to be free.
    const port = await this.allocatePort();
    const acceptLangPlain = fp.languages.join(",");
    // Collect every Chromium feature we disable into ONE list, emitted as a
    // single `--disable-features=` switch at the end. Chromium keeps only the
    // LAST occurrence of a repeated switch, so passing the base set here and a
    // proxy-only set later silently dropped the base set for proxied profiles —
    // Translate/MediaRouter ended up disabled on direct profiles but enabled on
    // proxied ones, splitting the fleet into two detectable populations.
    // MediaRouter is intentionally NOT disabled (stock Chrome ships it; turning
    // it off is itself a tell). The DNS/TLS entries are proxy-only and left
    // as-is pending the network-fingerprint golden harness.
    const disableFeatures = ["Translate", ...this.extraDisabledFeatures];
    const args = [
      `--user-data-dir=${browserDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Force-restore the previous session's tabs at startup. This flag is what
      // actually drives restore (writing the protected restore_on_startup pref
      // just gets reset by Chromium); combined with ensureSessionRestore marking
      // a clean exit and our CDP graceful shutdown, tabs come back reliably
      // across stop/launch even after a crash.
      "--restore-last-session",
      // Don't back Chromium's "Safe Storage" key with the OS keychain/keyring.
      // Two reasons: (1) our engine bundle is ad-hoc signed, so on macOS the
      // keychain ACL never matches and every launch pops a "Chromium wants to
      // use your keychain" password prompt (TouchID doesn't apply). (2) A
      // keychain-derived key is MACHINE-BOUND, which breaks profile portability
      // — the whole point of .mzar export/import — because cookies/passwords
      // encrypted on one Mac can't be decrypted after moving. Instead Chromium
      // uses a profile-local key (the Puppeteer/Playwright default: a fixed
      // "mock_password"). Trade-off, stated honestly: at-rest cookie/password
      // encryption becomes obfuscation (a public constant key), not keychain-
      // protected. This DOES lower the bar for a passive file-read attacker
      // (an infostealer that can read the profile dir now decrypts without the
      // keychain-ACL prompt or a memory dump). Accepted here because portability
      // is the product (.mzar export is useless with a machine-bound key), the
      // whole anti-detect category does this, and the real threats are covered
      // elsewhere: FileVault for offline disk theft, .mzar's AES-256-GCM +
      // passphrase for exports. Rely on disk encryption for at-rest safety.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ...(process.platform === "linux" ? ["--password-store=basic"] : []),
      // UI language for the Chromium chrome itself
      `--lang=${fp.locale}`,
      // Accept-Language: plain list, Chromium adds q-values.
      `--accept-lang=${acceptLangPlain}`,
      // Initial window size
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];
    // CloakBrowser implements fingerprint patches in C++. Feed it native
    // flags and avoid CDP/JS overrides later; those are exactly the
    // automation surfaces it hardens against.
    args.push(...buildCloakBrowserFingerprintArgs(profileId, fp));
    // NOTE: we deliberately do NOT pass --fingerprint-webrtc-ip. The shipped
    // CloakBrowser binary does not resolve the "auto" sentinel (only CloakHQ's
    // Python/JS wrapper does), so it ends up as the literal string "auto" in
    // ICE candidates / SDP / getStats — a cohort marker unique to MultiZen —
    // and setting the flag at all bypasses the browser's non-proxied-UDP
    // policy, letting STUN leave on the real interface. WebRTC leak protection
    // is handled by --webrtc-ip-handling-policy below.
    if (geoCoords) {
      // Make navigator.geolocation report coordinates that match the
      // proxy IP — without this, fingerprint-scan.com fires the "Check
      // Geo API" warning when the location grant is exercised.
      args.push(`--fingerprint-location=${geoCoords.latitude},${geoCoords.longitude}`);
    }
    if (profile.proxy) {
      // Chromium's --proxy-server= does NOT accept embedded credentials,
      // and an HTTP-CONNECT relay leaks DNS (Chromium prefetch / DoH /
      // background networking all hit the OS resolver before any proxy
      // negotiation). The fix: spin up a localhost SOCKS5 bridge that
      // forwards to the user's upstream proxy (HTTP CONNECT or SOCKS5
      // chained). Chromium with --proxy-server=socks5://… does *remote*
      // DNS by spec, so the egress IP becomes the only resolver test
      // sites observe.
      const localProxyUrl = await startBridgeForProfile(profileId, profile.proxy, this.egress, {
        refuseByClosing: true,
      });
      args.push(`--proxy-server=${localProxyUrl}`);
      // WebRTC leaks the *real* public IP via STUN even when HTTP traffic
      // is proxied — STUN uses UDP and bypasses HTTP proxies by default.
      // `disable_non_proxied_udp` keeps WebRTC working but only over UDP
      // that goes through the configured proxy; host candidates stay mDNS
      // (`.local`) and no srflx candidate exposes the real public IP.
      // Without this, browserscan / browserleaks / ipleak.net show the
      // user's real IP next to the proxy IP. Only set when a proxy is
      // configured — direct profiles intentionally expose their real IP.
      //
      // Use the Chrome-level switch `--webrtc-ip-handling-policy` (defined
      // in chrome/common/chrome_switches.cc), NOT the content-layer
      // `--force-webrtc-ip-handling-policy`: in full Chrome / CFT /
      // CloakBrowser the effective policy is read from the
      // kWebRTCIPHandlingPolicy *pref* in renderer_preferences_util.cc,
      // and the Chrome switch is the one that feeds that pref. The old
      // force-* switch (plus the removed --enforce-webrtc-ip-permission-
      // check, which no longer exists) was silently ignored on the browser
      // path, so proxied profiles had no working UDP policy at all.
      args.push("--webrtc-ip-handling-policy=disable_non_proxied_udp");
      // ── DNS leak prevention ─────────────────────────────────────────
      // Chromium does *remote* DNS for socks5:// proxies natively — our
      // local SOCKS5 bridge gets the hostname (not an IP) and forwards
      // it to the upstream proxy, which resolves remotely. So URL-load
      // DNS is already covered.
      //
      // What still leaks bypassing --proxy-server (per Chromium net/docs):
      //   • DoH (DNS-over-HTTPS) — talks straight to Cloudflare/Google
      //   • DNS prefetcher / predictor
      //   • Background networking (component updater, GCM, safe-browsing)
      //   • Domain Reliability beacons
      //
      // Disabling these via features+switches plugs every leak we can
      // close without source-patching Chromium. We deliberately do NOT
      // use --host-resolver-rules: it triggers the "unsupported flag"
      // infobar (visible to the user, even though JS can't probe it),
      // and a SOCKS5 upstream makes it redundant anyway. Real anti-
      // detect products (Multilogin Mimic) solve the residual leak
      // with a custom DNS-resolver source patch — a Phase-1 item for
      // multizen-pro, not the open-source build.
      disableFeatures.push(
        "DnsOverHttps",
        "DnsOverHttpsUpgrade",
        "EncryptedClientHello",
        "AsyncDns",
        "DnsHttpsSvcb",
        "DnsHttpsSvcbAlpn",
        "NetworkPrediction",
      );
      args.push("--dns-over-https-mode=off");
      args.push("--dns-prefetch-disable");
      args.push("--disable-async-dns");
      args.push("--no-prerender");
      args.push("--disable-background-networking");
      args.push("--disable-component-update");
      args.push("--disable-domain-reliability");
      args.push("--disable-client-side-phishing-detection");
    } else if (this.egress?.enforced) {
      // A direct profile only needs the bridge in its path, and WebRTC kept out of what
      // the bridge can't see. Nothing else from the block above: that set changes the
      // TLS fingerprint, and would split direct profiles from a desktop's.
      const localProxyUrl = await startBridgeForProfile(profileId, null, this.egress, {
        refuseByClosing: true,
      });
      args.push(`--proxy-server=${localProxyUrl}`);
      args.push("--webrtc-ip-handling-policy=disable_non_proxied_udp");
    }
    // Chromium sends loopback straight past any proxy unless told not to, which would
    // leave a page this machine's own ports: this server's, the CDP port, the bridges'.
    if (this.egress?.enforced) args.push("--proxy-bypass-list=<-loopback>");

    // Single `--disable-features=` for the whole launch (see disableFeatures).
    args.push(`--disable-features=${disableFeatures.join(",")}`);

    // Browser extensions: load this profile's enabled extensions plus the
    // bundled companion (the "Add to MultiZen" injector). Same flag pair
    // CloakBrowser's own `extension_paths` emits; requires the persistent
    // user-data-dir we already use. Extensions live under the profile dir
    // (shared across engines), so we pass absolute paths.
    const extensionDirs: string[] = [];
    const companion = companionDir(this.host);
    if (companion) extensionDirs.push(companion);
    for (const ext of profile.extensions ?? []) {
      if (!ext.enabled) continue;
      // Resolve both shared store entries and legacy per-profile copies.
      const dir = resolveLoadDir(ext, profile.dataDir, this.extensionStoreRoot);
      // Skip a missing dir: a single bad path makes Chromium drop the ENTIRE
      // --load-extension list (the companion too), silently disabling all
      // extensions for the launch.
      if (existsSync(dir)) extensionDirs.push(dir);
    }
    if (extensionDirs.length > 0) {
      const joined = extensionDirs.join(",");
      args.push(`--load-extension=${joined}`);
      args.push(`--disable-extensions-except=${joined}`);
    }

    if (displayMode === "headless") args.push(...HEADLESS_CHROMIUM_ARGS);

    // NOTE on Sec-CH-UA: The Client Hints headers (`Sec-CH-UA`,
    // `Sec-CH-UA-Platform`, `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch`,
    // `Sec-CH-UA-Bitness`, etc.) and `navigator.userAgentData` are NOT
    // overridable via CLI flags. They are baked into the compiled Chromium
    // binary at build time. To make them coherent with our chosen `userAgent`
    // we need our patched Chromium build (multizen-pro) which applies native
    // overrides. Until that ships, system Chrome will emit its real Client
    // Hints and detection vendors will see a UA-vs-CH mismatch.
    //
    // The full ClientHints object is stored in `profile.fingerprint.clientHints`
    // and will be picked up by the patched binary's launch wrapper when present.

    // Build a minimal env for the child — Electron's main process
    // accumulates a pile of ELECTRON_*, CHROME_*, V8_*, DYLD_* env vars
    // that some stealth Chromium forks (CloakBrowser) interpret as
    // "I'm running inside an Electron host" and SIGTRAP early to prevent
    // automation. Pass only the strict minimum a desktop browser needs.
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
      SHELL: process.env.SHELL ?? "/bin/sh",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      // macOS app bundles need this to find their frameworks.
      DYLD_FALLBACK_FRAMEWORK_PATH: process.env.DYLD_FALLBACK_FRAMEWORK_PATH ?? "",
    };

    // Linux GUI clients must inherit the active desktop session. Without
    // these values a headful Chromium process cannot connect to X11/Wayland
    // even though the Electron host window is already running successfully.
    if (process.platform === "linux") {
      for (const key of [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "DESKTOP_SESSION",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        const value = process.env[key];
        if (value !== undefined) cleanEnv[key] = value;
      }
    }
    // Start page (positional URL) — only on first run, i.e. when there is no
    // restorable session. With `--restore-last-session` a returning profile
    // reopens its real tabs, so we must NOT stack an extra tab; on first launch
    // there's nothing to restore, so the command-line URL becomes the initial
    // tab (verified on CloakBrowser 145 — pref `startup_urls` is ignored there,
    // a positional URL works). Defaults to DuckDuckGo when the profile has no
    // explicit start page. Must be the LAST argv entry (positional).
    if (!(await hasRestorableSession(browserDataDir))) {
      // sanitizeStartUrl rejects non-http(s)/about (incl. `-`-prefixed tokens
      // Chromium would treat as switches) → falls back to the default.
      args.push(sanitizeStartUrl(profile.startUrl));
    }

    // Headed keeps the session's display, set above. The others replace it just before
    // the spawn, once a private display exists to replace it with.
    let childEnv = cleanEnv;

    // Spawn + readiness, with a one-shot crash backstop: if the child dies from
    // a user-namespace sandbox failure while we launched WITHOUT --no-sandbox
    // (the AppArmor profile turned out not to be active), relaunch once WITH
    // --no-sandbox so the profile still launches (AC16/B1). `--no-sandbox` is
    // applied here, not in the args literal, so no arg rebuild is needed.
    const attemptSpawn = async (
      useNoSandbox: boolean,
    ): Promise<{ child: ChildProcess; session: CdpSession }> => {
      if (launch.aborted) throw launchAborted();
      if (this.ownsDataDir) await removeSingletonFiles(browserDataDir);
      const spawnArgs = useNoSandbox ? ["--no-sandbox", ...args] : args;
      const child = spawn(chromiumPath, spawnArgs, {
        // Unix: make the child a process-group leader so we can group-kill the
        // whole Chromium tree (renderers/GPU/utility) with process.kill(-pid),
        // which survives the leader's death. Windows uses taskkill /T instead,
        // so leave it attached there.
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
        env: childEnv,
      });
      let crashReject: ((e: Error) => void) | undefined;
      // A failed spawn (missing or non-executable binary) arrives as "error". With
      // no listener that is an uncaught exception, which Electron survives and
      // plain Node does not.
      child.on("error", (e) => {
        process.stderr.write(`[multizen] Chromium spawn error: ${e.message}\n`);
        crashReject?.(e);
      });
      const pid = child.pid;
      if (!pid) throw new Error("Failed to spawn Chromium");
      // Before anything can go wrong: a crash during readiness leaves this one too.
      this.processJournal?.add({
        kind: "browser",
        engine,
        profileId,
        pid,
        userDataDir: browserDataDir,
        startedAt: new Date().toISOString(),
      });
      // Treat as a sandbox crash ONLY when the FATAL signature appeared on
      // stderr AND the child actually exited (either event may land first). A
      // bare early exit, or a stray signature on a healthy child, is NOT a
      // sandbox crash.
      let sawSandboxCrash = false;
      let stderrTail = "";
      const signalCrashIfConfirmed = (): void => {
        if (sawSandboxCrash && (child.exitCode !== null || child.signalCode !== null)) {
          crashReject?.(new SandboxStartupError());
        }
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (!line) return;
        stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
        if (SANDBOX_FAILURE_RE.test(line)) {
          sawSandboxCrash = true;
          signalCrashIfConfirmed();
        }
        if (this.onBrowserStderr) this.onBrowserStderr(pid, line);
        else process.stderr.write(`[chromium ${pid}] ${line}\n`);
      });
      child.on("exit", (code, signal) => {
        this.processJournal?.remove(pid);
        // First-line breadcrumb — the record's child.on("exit") below also
        // handles running-changed teardown.
        if (code !== 0 && code !== null) {
          process.stderr.write(
            `[multizen] Chromium pid ${pid} exited code=${code} signal=${signal ?? "-"}\n`,
          );
        }
        signalCrashIfConfirmed();
      });

      const session = new CdpSession({
        port,
        host: "127.0.0.1",
        engine,
        platform: cloakBrowserPlatform(fp),
      });
      // Readiness ladder within a fixed budget, reusing this one session
      // (connect() is idempotent): (1) /json/version answers, (2) /json/list has
      // a page target, (3) connect()+attach succeeds. Raced against a confirmed
      // sandbox-crash signal so a failed sandbox aborts at once instead of
      // waiting out the full budget.
      const crashSignal = new Promise<never>((_, reject) => {
        crashReject = reject;
      });
      // The catch below is what kills it.
      launch.killStarting = () => crashReject?.(launchAborted());
      try {
        await Promise.race([
          waitForCdpSessionReady(port, session, this.readinessBudgetMs),
          crashSignal,
        ]);
        await assertSpawnedBrowser(session, pid, port);
      } catch (e) {
        // Tear down the half-launched browser — this record isn't in
        // `this.running` yet, so kill the spawned child directly. The caller
        // stops the socks5 bridge (same order as close()).
        await session.close().catch(() => {});
        await killProcessTree(pid);
        throw withStderrTail(e, stderrTail);
      }
      return { child, session };
    };

    let child: ChildProcess;
    let session: CdpSession;
    let xvfb: XvfbHandle | undefined;
    try {
      if (displayMode === "xvfb") {
        xvfb = await startXvfb({
          width: fp.screen.width + XVFB_SCREEN_MARGIN_PX,
          height: fp.screen.height + XVFB_SCREEN_MARGIN_PX,
          runDir: this.xvfbRunDir ?? tmpdir(),
          ...(this.processJournal ? { journal: { processJournal: this.processJournal, profileId } } : {}),
        });
      }
      childEnv = displayEnv(cleanEnv, displayMode, xvfb);
      try {
        ({ child, session } = await attemptSpawn(noSandbox));
      } catch (e) {
        if (e instanceof SandboxStartupError && this.requireSandbox) throw sandboxUnavailable();
        if (e instanceof SandboxStartupError && !noSandbox) {
          console.warn("[multizen] sandbox failed to start; relaunching with --no-sandbox");
          // Profile was expected active but isn't — let the host re-offer setup.
          this.onSandboxInactive?.(chromiumPath);
          // The crashed child is dead (attemptSpawn awaited it); clear its stale
          // SingletonLock before reusing the data dir, or the retry silently
          // exits on the dead lock.
          await cleanStaleSingletonLocks(browserDataDir).catch(() => {});
          ({ child, session } = await attemptSpawn(true));
        } else {
          throw e;
        }
      }
    } catch (e) {
      // Spawn/readiness failed for good — don't leak this profile's socks5
      // bridge (only the record's exit/close paths stop it, and no record
      // exists yet). The same goes for its display.
      await xvfb?.stop().catch(() => {});
      await stopBridgeForProfile(profileId).catch(() => {});
      throw e;
    }

    // attemptSpawn guarantees a live pid (it throws otherwise); capture it so
    // the record/return don't re-widen to number | undefined.
    const pid = child.pid;
    if (pid === undefined) throw new Error("Chromium exited before readiness");

    const startedAt = new Date().toISOString();
    const cdpEndpoint = `http://127.0.0.1:${port}`;

    // Per-target CDP bootstrap. CloakBrowser applies fingerprint / timezone
    // / UA / UA-CH / screen patches natively in C++ via its --fingerprint-*
    // flags, and WebRTC leak protection lives at the browser level
    // (--webrtc-ip-handling-policy, see launch args), so we deliberately do NOT
    // layer CDP Emulation or JS preloads on top — double-patching produces
    // cross-layer disagreements (e.g. a CDP UA string vs the native UA-CH brand
    // list) that composite scorers flag as "Masking detected".
    //
    // LOCALE is the one exception: CloakBrowser ships no native locale switch
    // (its --fingerprint-* set has timezone but no locale/language, verified
    // against the binary) and macOS ignores --lang, so without this nothing
    // sets the renderer's ICU default locale and Intl.*.resolvedOptions()
    // .locale leaks the host locale (a th-TH persona reports en-US). This
    // fills a gap rather than shadowing a patch. navigator.language(s) come
    // from --accept-lang and stay untouched.
    await session
      .bootstrapTargets(async (send) => {
        try {
          await send("Emulation.setLocaleOverride", { locale: fp.locale });
        } catch (e) {
          const msg = (e as Error).message;
          if (!/already in effect/i.test(msg)) {
            console.error("[multizen] setLocaleOverride (cloakbrowser) failed:", e);
          }
        }
        // Diagnostic: capture what the page actually sees AFTER overrides.
        // The ENTIRE probe is gated behind MULTIZEN_DEBUG, not just the log:
        // it is a main-world read of navigator / Intl / RTCPeerConnection, and
        // running it on every target attach is an observable burst of probing
        // the page could notice. In production we inject nothing here.
        if (process.env.MULTIZEN_DEBUG) {
          try {
            const probe = await send<{
              result?: { value?: string };
            }>("Runtime.evaluate", {
              expression: `JSON.stringify({
                ua: navigator.userAgent,
                brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
                platform: navigator.platform,
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                icuLocale: Intl.DateTimeFormat().resolvedOptions().locale,
                calendar: Intl.DateTimeFormat().resolvedOptions().calendar,
                lang: navigator.language,
                langs: navigator.languages,
                deviceMemory: navigator.deviceMemory,
                hardwareConcurrency: navigator.hardwareConcurrency,
                hasRTCPC: typeof window.RTCPeerConnection !== "undefined",
              })`,
              returnByValue: true,
            });
            const value = probe?.result?.value;
            if (value) console.log("[multizen] post-bootstrap probe:", value);
          } catch (e) {
            // Non-fatal — diagnostic only.
            void e;
          }
        }
      })
      .catch((e: unknown) => {
        console.error("[multizen] CDP bootstrap failed:", e);
      });
    await focusFirstPage(session, displayMode);

    // Wire the companion's "Add to MultiZen" channel for this profile — scoped
    // to Web Store pages only (the host polls a DOM attribute there, never on
    // the user's normal browsing). The CDP session is profile-scoped, so any
    // signal belongs to this profileId — no cross-profile ambiguity.
    if (this.onCompanionInstall) {
      void session.watchUrlForBinding({
        urlIncludes: "chromewebstore.google.com",
        onPayload: (payload) => {
          try {
            const parsed = JSON.parse(payload) as { id?: string };
            if (parsed.id) this.onCompanionInstall?.(profileId, parsed.id);
          } catch {
            // ignore malformed payloads
          }
        },
      });
    }

    // Watch for "no more page targets" via CDP. On macOS Chrome stays alive
    // after the last window closes (standard Mac app lifecycle) — the spawned
    // process keeps running with zero windows. We poll /json/list and force-
    // kill the child when that happens, which then fires child.on('exit') and
    // emits the running-changed event.
    // Latch so the 1s watcher signals termination + shuts down exactly once,
    // not on every tick while pages stay at zero during the ~1.5–4s wind-down.
    let signalledClose = false;
    const windowWatcher = createWindowWatcher(port, startedAt, () => {
      if (signalledClose) return;
      signalledClose = true;
      // Window closed but the process lingers (mac app lifecycle) — tell the GUI
      // we're terminating so the card stops showing "Stop" while it winds down.
      this.emit("running-changed", { kind: "closing", profileId });
      // Graceful CDP shutdown — preserves session-restore.
      void gracefulShutdown(r);
    });

    const record: RunningProcess = {
      child,
      cdpEndpoint,
      port,
      pid,
      startedAt,
      session,
      browserDataDir,
      windowWatcher,
      displayMode,
      ...(xvfb ? { xvfb } : {}),
    };
    const r = record;
    this.running.set(profileId, record);

    const onExit = (): void => {
      const wasTracked = this.running.has(profileId);
      clearInterval(record.windowWatcher);
      void session.close().catch(() => {});
      void stopBridgeForProfile(profileId).catch(() => {});
      void xvfb?.stop().catch(() => {});
      this.running.delete(profileId);
      if (wasTracked) {
        // close() removes from the map first so wasTracked is false there;
        // this path covers (a) user quit Chrome directly with ⌘Q, and (b)
        // our own kill() from the windowWatcher when the last window closed.
        this.emit("running-changed", { kind: "closed", profileId, reason: "external-exit" });
      }
    };
    child.on("exit", onExit);
    // It may have died during the bootstrap above, with nothing here listening yet.
    if (child.exitCode !== null || child.signalCode !== null) onExit();

    if (this.armDownloadsAtLaunch) {
      await this.armDownloads(profileId, record).catch((e: unknown) => {
        console.warn("[multizen] arming downloads failed:", (e as Error).message);
      });
    }

    if (this.running.get(profileId) !== record) {
      throw new Error("Chromium exited right after it started");
    }
    this.emit("running-changed", { kind: "launched", profileId });
    return { id: profileId, cdpEndpoint, pid, startedAt, displayMode };
  }

  /** During a launch this means the browser that launch brings up, so it waits for it. */
  async close(profileId: ProfileId): Promise<void> {
    await this.launching.get(profileId)?.promise.catch(() => {});
    await this.shutdownProfile(profileId, "user-close");
  }

  /**
   * Single close path used by `close()`, `closeAll()`, and (via the same
   * `gracefulShutdown`) the window watcher. Removing from the map first makes
   * the `child.on("exit")` handler treat this as a planned close. `opts`
   * lets the quit path shorten the graceful budget and skip the (slower)
   * orphan post-check so the tree-kill lands before `app.exit(0)`.
   */
  private async shutdownProfile(
    profileId: ProfileId,
    reason: "user-close",
    opts: { gracefulMs?: number; reap?: boolean } = {},
  ): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    this.running.delete(profileId);
    clearInterval(r.windowWatcher);
    // A call stuck on this browser ends now, not when its deadline comes.
    r.session.abortOperations();
    // Shut Chromium down BEFORE the socks5 bridge. The bridge's server.close()
    // waits for its accepted sockets to end; a still-running Chromium holds
    // those proxied connections open, so closing the bridge first can deadlock
    // the shutdown (and, via before-quit, hang the whole app on exit).
    await gracefulShutdown(r, opts);
    await stopBridgeForProfile(profileId).catch(() => {});
    await r.xvfb?.stop().catch(() => {});
    this.emit("running-changed", { kind: "closed", profileId, reason });
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  runningDisplayMode(profileId: ProfileId): DisplayMode | null {
    return this.running.get(profileId)?.displayMode ?? null;
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const session = this.requireSession(profileId);
    const result = await session.navigate(url).catch((e: unknown) => {
      throw asEgressBlocked(profileId, e);
    });
    return { url: result.url };
  }

  async click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.click(selector);
    return { ok: true };
  }

  async type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.type(selector, text);
    return { ok: true };
  }

  async clickRef(profileId: ProfileId, ref: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.clickRef(ref);
    return { ok: true };
  }

  async typeRef(profileId: ProfileId, ref: string, text: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.typeRef(ref, text);
    return { ok: true };
  }

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const session = this.requireSession(profileId);
    return session.extract();
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const session = this.requireSession(profileId);
    return session.screenshot();
  }

  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    const session = this.requireSession(profileId);
    return session.cdpSend(method, params, sessionId, opts);
  }

  // ── Engine-neutral curated verbs. These CDP compositions were moved down
  //    from the MCP dispatch layer (server.ts) so the same tools can run on a
  //    non-CDP engine. Each needs no domain enable, preserving the stealth
  //    baseline. ────────────────────────────────────────────────────────────
  async evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.requireSession(profileId).evaluateJs(expression, sessionId);
  }

  async getCookies(profileId: ProfileId, urls?: string[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.getCookies", urls ? { urls } : {}, sessionId, {
      safe: true,
    });
  }

  async setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.setCookies", { cookies }, sessionId, { safe: true });
  }

  async listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.requireSession(profileId).listTabs(sessionId);
  }

  async newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.requireSession(profileId).newTab(url, sessionId);
  }

  async activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.requireSession(profileId).activateTab(targetId, sessionId);
  }

  async closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.requireSession(profileId).closeTab(targetId, sessionId);
  }

  async performAction(profileId: ProfileId, action: DriverAction): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    switch (action.type) {
      case "press_key":
        await session.pressKey(action.key, action.target);
        break;
      case "hover":
        await session.hover(action.target);
        break;
      case "select_option":
        await session.selectOption(action.target, {
          ...(action.value !== undefined ? { value: action.value } : {}),
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.index !== undefined ? { index: action.index } : {}),
        });
        break;
      case "scroll":
        await session.scroll(action);
        break;
      case "upload_file":
        await session.uploadFile(action.target, action.paths);
        break;
      case "bring_to_front":
        await session.bringToFront();
        break;
    }
    return { ok: true };
  }

  private downloadTracker(profileId: ProfileId): Promise<DownloadTracker> {
    const profile = this.profileManager.get(profileId);
    if (!profile) {
      throw new MultizenError("PROFILE_NOT_FOUND", `Profile ${profileId} not found`);
    }
    return sharedDownloadTracker(join(profile.dataDir, PROFILE_DOWNLOADS_DIR));
  }

  private armDownloads(profileId: ProfileId, r: RunningProcess): Promise<void> {
    r.downloadsArmed ??= (async () => {
      const tracker = await this.downloadTracker(profileId);
      await r.session.enableDownloads(tracker.dir, tracker);
    })().catch((e: unknown) => {
      r.downloadsArmed = undefined; // The next call tries again.
      throw e;
    });
    return r.downloadsArmed;
  }

  /** On a running browser this is also what starts catching its downloads (C11). */
  private async downloadsOf(profileId: ProfileId): Promise<DownloadTracker> {
    const r = this.running.get(profileId);
    if (r) await this.armDownloads(profileId, r);
    return this.downloadTracker(profileId);
  }

  async listDownloads(profileId: ProfileId): Promise<DownloadRecord[]> {
    return (await this.downloadsOf(profileId)).list();
  }

  async getDownload(profileId: ProfileId, downloadId: string): Promise<DownloadFile | null> {
    return (await this.downloadsOf(profileId)).get(downloadId);
  }

  async setDialogPolicy(profileId: ProfileId, policy: DialogPolicy): Promise<{ ok: true }> {
    await this.requireSession(profileId).setDialogPolicy(policy);
    return { ok: true };
  }

  async listDialogs(profileId: ProfileId): Promise<OpenDialog[]> {
    return this.requireSession(profileId).listDialogs();
  }

  async handleDialog(profileId: ProfileId, response: DialogResponse): Promise<{ ok: true }> {
    await this.requireSession(profileId).handleDialog(response);
    return { ok: true };
  }

  hasOpenDialog(profileId: ProfileId): boolean {
    return this.running.get(profileId)?.session.hasOpenDialog() ?? false;
  }

  // The handoff panel's view and input, which a later change fills in. Until then
  // each refuses by code, so a client sees a typed error rather than a missing method.
  async captureFrame(): Promise<CapturedFrame> {
    throw notAvailableYet("captureFrame");
  }

  async dispatchInput(): Promise<void> {
    throw notAvailableYet("dispatchInput");
  }

  /** A launch under way is abandoned, or its browser would outlive this process. */
  async closeAll(opts: { gracefulMs?: number; reap?: boolean } = {}): Promise<void> {
    const launches = [...this.launching.values()];
    for (const launch of launches) {
      launch.aborted = true;
      launch.killStarting?.();
    }
    const ids = [...this.running.keys()];
    await Promise.all([
      ...ids.map((id) => this.shutdownProfile(id, "user-close", opts)),
      ...launches.map((launch) => launch.promise.catch(() => {})),
    ]);
  }

  private requireSession(profileId: ProfileId): CdpSession {
    const r = this.running.get(profileId);
    if (!r) throw new MultizenError("PROFILE_NOT_RUNNING", `Profile ${profileId} is not running`);
    return r.session;
  }

  private allocatePort(): Promise<number> {
    return this.customAllocatePort
      ? this.customAllocatePort()
      : firstFreePort(() => this.nextPort++);
  }
}

function notAvailableYet(what: string): MultizenError {
  return new MultizenError(
    "UNSUPPORTED_ON_ENGINE",
    `${what} is not available on CloakBrowser in this build.`,
  );
}

function buildCloakBrowserFingerprintArgs(profileId: ProfileId, fp: FingerprintConfig): string[] {
  const args = [
    `--fingerprint=${fingerprintSeed(profileId, fp)}`,
    `--fingerprint-platform=${cloakBrowserPlatform(fp)}`,
    // NOTE: CloakBrowser has NO --fingerprint-locale switch (verified against
    // the binary — its --fingerprint-* set covers timezone/platform/screen/etc
    // but not locale/language). Locale is applied via CDP
    // Emulation.setLocaleOverride in the bootstrap step instead; passing a
    // --fingerprint-locale here would be silently ignored.
    `--fingerprint-timezone=${fp.timezone}`,
    `--fingerprint-screen-width=${fp.screen.width}`,
    `--fingerprint-screen-height=${fp.screen.height}`,
    `--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`,
    `--fingerprint-device-memory=${deviceMemoryApiValue(fp.deviceMemory)}`,
  ];
  // Explicitly set WebGL vendor/renderer instead of relying on seed-derived
  // auto-generation. Browserscan flags "WebGL exception" when CloakBrowser's
  // seed-derived GPU pool produces inconsistent values for the current
  // platform — pinning them to fp.webgl forces coherence with the persona.
  if (fp.webgl?.vendor) args.push(`--fingerprint-gpu-vendor=${fp.webgl.vendor}`);
  if (fp.webgl?.renderer) args.push(`--fingerprint-gpu-renderer=${fp.webgl.renderer}`);
  // Brand + version from Client Hints — keeps Sec-CH-UA + UA-string + UA-CH
  // brand list coherent. CloakBrowser's --fingerprint-brand-version drives
  // both UA and Sec-CH-UA-Full-Version simultaneously.
  const brandVersion = primaryBrandVersion(fp.clientHints);
  if (brandVersion) args.push(`--fingerprint-brand-version=${brandVersion}`);
  if (fp.clientHints?.secChUaPlatformVersion) {
    args.push(`--fingerprint-platform-version=${fp.clientHints.secChUaPlatformVersion}`);
  }
  return args;
}

function primaryBrandVersion(ch: ClientHints | undefined): string | null {
  if (!ch?.secChUaFullVersionList) return null;
  // Format: '"Chromium";v="148.0.7202.93", "Google Chrome";v="148.0.7202.93", "Not.A/Brand";v="99.0.0.0"'
  // Pick the first non-Chromium, non-"Not.A/Brand" entry — that's the
  // user-facing brand version (Chrome, Edge, etc.).
  const matches = ch.secChUaFullVersionList.matchAll(/"([^"]+)";v="([^"]+)"/g);
  for (const m of matches) {
    const brand = m[1];
    const version = m[2];
    if (!brand || !version) continue;
    if (!/Chromium|Not[.\s/]?A[.\s/]?Brand/i.test(brand)) return version;
  }
  return null;
}

function fingerprintSeed(profileId: ProfileId, fp: FingerprintConfig): string {
  // CloakBrowser accepts a stable seed. Prefer an explicit fingerprint.seed
  // (P0-3 / P1-7) so canvas/audio noise can be rotated without changing
  // profileId; otherwise key by profileId for launch-stable noise.
  const material = fp.seed ?? profileId;
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return String(10000 + (Number.parseInt(hex, 16) % 90000));
}

function cloakBrowserPlatform(fp: FingerprintConfig): "macos" | "windows" | "linux" {
  // Derive from the user's chosen device family — CloakBrowser's native
  // C++ patches handle the rest of the cross-platform spoof. Falls back
  // to the host OS if device is somehow unset.
  if (fp.device.startsWith("mac") || fp.device.startsWith("imac")) return "macos";
  if (fp.device.startsWith("windows")) return "windows";
  if (fp.device.startsWith("linux")) return "linux";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function browserDataDirForEngine(profileDataDir: string, engine: BrowserEngine): string {
  // Chrome profile data is not safely reusable across different browser
  // engines / major versions, so every engine keeps its browser state in its
  // own named user-data-dir under the logical MultiZen profile
  // (engines/cloakbrowser, engines/camoufox, ...).
  return join(profileDataDir, "engines", engine);
}

function createWindowWatcher(
  port: number,
  startedAt: string,
  onZeroWindows: () => void,
): NodeJS.Timeout {
  let zeroSinceMs: number | null = null;
  return setInterval(async () => {
    // Don't start counting "zero windows" until Chromium has had a chance
    // to open its initial window (some 1-2s after spawn).
    const ageMs = Date.now() - new Date(startedAt).getTime();
    if (ageMs < 2000) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) return;
      const targets = (await res.json()) as Array<{ type?: string }>;
      const pages = targets.filter((t) => t.type === "page").length;
      if (pages === 0) {
        if (zeroSinceMs === null) {
          zeroSinceMs = Date.now();
        } else if (Date.now() - zeroSinceMs > 1500) {
          // Confirmed: zero pages for >1.5s. Treat as user closing the browser.
          onZeroWindows();
        }
      } else {
        zeroSinceMs = null;
      }
    } catch {
      // CDP unreachable — process likely already dying. exit handler will
      // clean up.
    }
  }, 1000);
}

/**
 * Mark the profile's last exit as clean in `Default/Preferences`
 * (exit_type=Normal / exited_cleanly=true) so a relaunch reopens the previous
 * tabs (via --restore-last-session) without the "Restore tabs?" crash infobar,
 * even after we killed Chromium ungracefully. Called before each spawn —
 * Chromium must NOT be running, or we'll corrupt its pref file (it writes
 * Preferences atomically with no flock). Deliberately does NOT touch the
 * protected `restore_on_startup` pref — see the note in the body.
 */
/** Parse a `major.minor.build.patch` version triple out of arbitrary text. */
function parseVersionTriple(s: string): { major: number; full: string } | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}` };
}

/**
 * Resolve the running Chromium version without ever opening a browser
 * window. Order of preference:
 *   1. The version the bootstrap already cached (current.json) — free.
 *   2. Platform-specific probe that does NOT spawn the GUI:
 *        • Windows: read the EXE's file VersionInfo via PowerShell.
 *        • macOS / Linux: `chrome --version` prints and exits cleanly.
 *
 * Why not `chrome.exe --version` on Windows: it does not print the
 * version — it just launches the browser normally. The old code spawned
 * it on every launch and killed the window after 2s, so the user saw the
 * browser open, close, and open again. We avoid spawning the binary
 * entirely on the happy path, and use EXE metadata as the fallback.
 */
async function resolveChromiumVersion(
  status: ChromiumStatus,
  binaryPath: string,
): Promise<{ major: number; full: string } | null> {
  if (status.kind === "ready" && status.version) {
    const fromCache = parseVersionTriple(status.version);
    if (fromCache) return fromCache;
  }
  return detectChromiumVersion(binaryPath);
}

async function detectChromiumVersion(
  binaryPath: string,
): Promise<{ major: number; full: string } | null> {
  // Windows: chrome.exe --version opens a browser window instead of
  // printing. Read the binary's file VersionInfo (ProductVersion) — no
  // process window, no GUI.
  if (process.platform === "win32") {
    try {
      const escaped = binaryPath.replace(/'/g, "''");
      const { stdout } = await execFileP("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
      ]);
      return parseVersionTriple(stdout.trim());
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v: { major: number; full: string } | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const p = spawn(binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      p.on("close", () => {
        done(parseVersionTriple(out));
      });
      p.on("error", () => done(null));
      setTimeout(() => {
        p.kill();
        done(null);
      }, 2000);
    } catch {
      done(null);
    }
  });
}

/**
 * Rewrite the version-bearing fields of a fingerprint to match the
 * actual Chromium binary. Returns a new object — does NOT persist; if
 * the user wants the persisted profile updated they should hit Regen.
 *
 * Touches: userAgent, clientHints.secChUa, clientHints.secChUaFullVersionList.
 * Leaves device, locale, screen, etc. untouched.
 */
function reconcileVersionInFingerprint(
  fp: FingerprintConfig,
  actual: { major: number; full: string },
): FingerprintConfig {
  // Rewrite Chrome version in UA: "Chrome/148.0.7390.42" → "Chrome/147.0.7727.138"
  const newUA = fp.userAgent.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${actual.full}`);
  if (!fp.clientHints) {
    return { ...fp, userAgent: newUA };
  }
  const ch = fp.clientHints;
  // "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
  // Rewrite v="<num>" only on Chromium / Google Chrome / Microsoft Edge
  // brand entries; leave the GREASE brand alone.
  const newSecChUa = ch.secChUa.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")(\d+)(")/g,
    `$1${actual.major}$3`,
  );
  const newFullList = ch.secChUaFullVersionList.replace(
    /("(?:Chromium|Google Chrome|Microsoft Edge)";v=")[\d.]+(")/g,
    `$1${actual.full}$2`,
  );
  return {
    ...fp,
    userAgent: newUA,
    clientHints: {
      ...ch,
      secChUa: newSecChUa,
      secChUaFullVersionList: newFullList,
    },
  };
}

/**
 * Tell macOS to skip the "reopen windows from previous crash?" alert
 * that NSPersistentUIRestorer shows when a previous launch died. The
 * alert is modal AppKit; CloakBrowser's stealth patches DCHECK on it
 * and crash with EXC_BREAKPOINT, creating a permanent boot loop.
 *
 * The Chromium-derived bundle uses `org.chromium.Chromium` as its bundle
 * identifier on macOS, so a single defaults block covers it.
 */
async function disableMacOsPersistentStateRestore(): Promise<void> {
  // Wipe the saved-state bundle entirely so the dialog has nothing to
  // restore from. Chromium will start fresh.
  const home = process.env.HOME ?? "";
  if (home) {
    const savedState = join(
      home,
      "Library",
      "Saved Application State",
      "org.chromium.Chromium.savedState",
    );
    await fsp.rm(savedState, { recursive: true, force: true }).catch(() => {});
  }
  // Defense in depth: turn off Apple's per-app persistence flags so
  // future crashes don't trigger the dialog either. These writes are
  // idempotent and silent if they already match.
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "NSQuitAlwaysKeepsWindows",
    "-bool",
    "false",
  ]).catch(() => {});
  await execFileP("defaults", [
    "write",
    "org.chromium.Chromium",
    "ApplePersistenceIgnoreState",
    "-bool",
    "true",
  ]).catch(() => {});
}

/** See {@link ChromiumBrowserDriverOptions.ownsDataDir}. */
async function removeSingletonFiles(dataDir: string): Promise<void> {
  for (const name of SINGLETON_FILES) {
    await fsp.unlink(join(dataDir, name)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}

/**
 * Delete `SingletonLock` / `SingletonSocket` / `SingletonCookie` symlinks
 * if their target PID is no longer alive. Chromium refuses to launch
 * with these present (it interprets them as "another instance is using
 * this profile") and the failure manifests as a silent CDP "socket hang
 * up" — process exits seconds after spawn without any error to stderr.
 *
 * Safe to call before every launch: if the PID IS alive, we leave the
 * lock alone (real concurrent instance, let the second launch fail
 * loudly).
 */
async function cleanStaleSingletonLocks(dataDir: string): Promise<void> {
  const candidates = [...SINGLETON_FILES];
  const { readlink } = await import("node:fs/promises");

  const lockPath = join(dataDir, "SingletonLock");
  let staleLockTarget: string | null = null;
  try {
    const lockTarget = await readlink(lockPath);
    const pid = pidFromSingletonTarget(lockTarget);
    if (pid !== null && !isPidAlive(pid)) {
      staleLockTarget = lockTarget;
    }
  } catch {
    // No lock to inspect.
  }

  if (staleLockTarget) {
    await unlinkSingletonFiles(dataDir, candidates, `dead lock ${staleLockTarget}`);
    return;
  }

  for (const name of candidates) {
    const path = join(dataDir, name);
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      continue; // Not a symlink or doesn't exist — skip.
    }

    const pid = pidFromSingletonTarget(target);
    if (pid !== null && !isPidAlive(pid)) {
      try {
        await fsp.unlink(path);
        console.log(`[multizen] cleaned stale ${name} (was → ${target}, pid ${pid} not running)`);
      } catch {
        // ignore
      }
      continue;
    }

    // SingletonSocket points at a temp socket path. If the socket target
    // no longer exists, remove the symlink even when no PID is encoded.
    if (name === "SingletonSocket" && !existsSync(target)) {
      await fsp.unlink(path).catch(() => {});
      console.log(`[multizen] cleaned stale ${name} (missing target ${target})`);
    }
  }
}

function pidFromSingletonTarget(target: string): number | null {
  // Lock format is usually "<hostname>-<pid>". Socket paths sometimes
  // include the same suffix in an intermediate dir.
  const m = target.match(/-(\d+)(?:[/]|$)/);
  if (!m?.[1]) return null;
  const pid = Number(m[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 = "is process alive" probe, doesn't actually signal it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unlinkSingletonFiles(
  dataDir: string,
  names: string[],
  reason: string,
): Promise<void> {
  for (const name of names) {
    const path = join(dataDir, name);
    await fsp.unlink(path).catch(() => {});
  }
  console.log(`[multizen] cleaned stale Singleton files (${reason})`);
}

/**
 * Whether the profile has a session Chromium can restore on launch. Used to
 * decide if we should open the start page (only on a genuine first run).
 * Chromium writes tab/session state under `Default/Sessions/`; older builds
 * also keep `Default/Current Session`. Any of these present → restorable.
 */
async function hasRestorableSession(dataDir: string): Promise<boolean> {
  const sessionsDir = join(dataDir, "Default", "Sessions");
  try {
    const entries = await fsp.readdir(sessionsDir);
    if (entries.length > 0) return true;
  } catch {
    // no Sessions dir yet
  }
  return existsSync(join(dataDir, "Default", "Current Session"));
}

async function ensureSessionRestore(dataDir: string): Promise<void> {
  const prefsPath = join(dataDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(prefsPath, "utf8");
    prefs = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Profile hasn't been launched yet — create minimal prefs and let
    // Chromium fill in the rest on first run.
  }
  const profileSection = (prefs.profile as Record<string, unknown>) ?? {};

  // Mark the previous run as a clean exit. If Chromium crashed or we killed it
  // ungracefully, exit_type gets stuck on "Crashed" and the next launch shows
  // the "Restore tabs?" infobar (or silently skips restore on some builds,
  // including CloakBrowser). exit_type / exited_cleanly are NOT protected prefs,
  // so editing them on disk is safe.
  profileSection.exit_type = "Normal";
  profileSection.exited_cleanly = true;

  // NOTE: we deliberately do NOT write session.restore_on_startup here. It IS a
  // protected/tracked pref (Secure Preferences stores a MAC + super_mac for it),
  // so editing it outside Chromium trips the "Your settings were changed by an
  // unknown app" reset of the WHOLE protected set — including the default search
  // engine — and Chromium resets our value to None anyway. Tab restore is driven
  // by the --restore-last-session CLI flag (passed in launch()), which forces
  // restore regardless of this pref, so the write was both harmful and useless.
  prefs.profile = profileSection;

  await fsp.mkdir(join(dataDir, "Default"), { recursive: true });
  // Atomic-ish write: write to .tmp then rename.
  const tmpPath = `${prefsPath}.multizen.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(prefs));
  await fsp.rename(tmpPath, prefsPath);
}
