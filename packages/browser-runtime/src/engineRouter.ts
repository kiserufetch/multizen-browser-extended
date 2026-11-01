import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MultizenError,
  PROFILE_DOWNLOADS_DIR,
  PROFILE_UPLOADS_DIR,
  resolveEngine,
  UPLOAD_INBOX_DIR,
} from "@multizen/types";
import type {
  BrowserEngine,
  CapturedFrame,
  ChromiumStatus,
  DialogPolicy,
  DialogResponse,
  DisplayMode,
  DisplayModeSetting,
  DownloadFile,
  DownloadRecord,
  DriverAction,
  HumanInputEvent,
  LaunchedProfile,
  LaunchOptions,
  OpenDialog,
  ProfileId,
  RunningInfo,
} from "@multizen/types";
import type { BrowserDriver } from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import { BROWSER_QUEUE_TIMEOUT_MS, BrowserLimiter, launchCalledOff } from "./browserLimiter.ts";
import type { EngineRegistry } from "./engineRegistry.ts";
import { isChromiumEngine } from "./engineRegistry.ts";
import {
  browserDataDirForEngine,
  type ChromiumBrowserDriver,
  type RunningStateChange,
} from "./ChromiumBrowserDriver.ts";
import { resolveDisplayMode } from "./displayMode.ts";
import { sharedDownloadTracker, type DownloadTracker } from "./downloads.ts";
import { camoufoxConfigForProfile } from "./firefoxFingerprint.ts";
import { hasXvfbBinary } from "./xvfb.ts";
import { StrictGeoCoherenceError } from "./launchTimezone";
// Type-only: the concrete module (which statically imports camoufox-js +
// playwright-core) is loaded lazily, so Chromium-only sessions never pull it in.
import type { FirefoxBrowserDriver, FirefoxBrowserDriverOptions } from "./FirefoxBrowserDriver.ts";

/** The steps of an install: long enough that an MCP client would give up waiting. */
const INSTALLING: ReadonlySet<ChromiumStatus["kind"]> = new Set<ChromiumStatus["kind"]>([
  "fetching-manifest",
  "downloading",
  "verifying",
  "extracting",
]);
const ENGINE_STATUS_POLL_MS = 25;
const ENGINE_RETRY_AFTER_MS = 5_000;

interface EngineRouterEvents {
  "running-changed": (change: RunningStateChange) => void;
}

export interface EngineRouterOptions {
  profileManager: ProfileManager;
  engineRegistry: EngineRegistry;
  /** The app-wide default engine for profiles that haven't pinned one. */
  getDefaultEngine: () => BrowserEngine;
  /** The already-constructed Chromium driver (owns companion-install wiring). */
  chromiumDriver: ChromiumBrowserDriver;
  /** Passed to the Firefox driver, which the router itself constructs lazily. */
  firefoxOptions?: Pick<FirefoxBrowserDriverOptions, "launchExtras" | "extraPrefs" | "egress">;
  /**
   * A launch while the engine is still installing. `wait` (the default, the desktop
   * with its progress UI) blocks until it is ready. `reject` (the server) answers at
   * once with a retryable ENGINE_NOT_READY, since a first download runs far past an
   * MCP client's timeout, and the install carries on in the background.
   */
  engineNotReady?: "wait" | "reject";
  /** Browsers at once, over both engines. Default: no limit, as on the desktop. */
  maxBrowsers?: number;
  /** How long a launch waits for a free slot. Then BROWSER_LIMIT_REACHED. */
  browserQueueTimeoutMs?: number;
  /** The last word on a mode: a server's --display-mode. Default: headed, as on the desktop. */
  displayModeDefault?: DisplayModeSetting;
  /** A server's --headless: the first word on a mode. */
  forcedDisplayMode?: DisplayMode;
  /** The global setting, read at each launch so a change applies without a restart. */
  getDefaultDisplayMode?: () => DisplayMode | undefined;
  /** What the machine offers. Default: this process's. */
  displayEnvironment?: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    hasXvfb: () => boolean;
  };
}

/** A launch under way. Everyone asking for this profile meanwhile shares it. */
interface InFlightLaunch {
  promise: Promise<LaunchedProfile>;
  /** Calls off the waits before a browser starts. One already starting finishes starting. */
  callOff: AbortController;
  displayMode: DisplayMode;
}

/**
 * The BrowserDriver the app and MCP server talk to. It resolves each profile's
 * engine and delegates to that engine's driver — Chromium (CloakBrowser) or
 * Firefox (Camoufox). A profile is BOUND to the driver it launched on, so every
 * later verb (and close) goes to that same driver even if the profile's stored
 * engine field later changes — a running profile is never orphaned. Because the
 * Firefox driver isn't constructed until a Camoufox profile first launches,
 * camoufox-js + playwright-core stay out of the Chromium-only startup path.
 */
export class EngineRouter extends EventEmitter implements BrowserDriver {
  private readonly profileManager: ProfileManager;
  private readonly engineRegistry: EngineRegistry;
  private readonly getDefaultEngine: () => BrowserEngine;
  private readonly chromiumDriver: ChromiumBrowserDriver;
  private readonly firefoxOptions: EngineRouterOptions["firefoxOptions"];
  private readonly engineNotReady: NonNullable<EngineRouterOptions["engineNotReady"]>;
  private firefoxDriver: FirefoxBrowserDriver | null = null;
  private firefoxLoading: Promise<FirefoxBrowserDriver> | null = null;
  /** profileId → the driver it launched on (bound at launch, cleared on close). */
  private readonly bindings = new Map<ProfileId, BrowserDriver>();
  private readonly inFlight = new Map<ProfileId, InFlightLaunch>();
  private readonly closing = new Map<ProfileId, Promise<void>>();
  private readonly limiter: BrowserLimiter;
  private readonly browserQueueTimeoutMs: number;
  private readonly displayModeDefault: DisplayModeSetting;
  private readonly forcedDisplayMode: DisplayMode | undefined;
  private readonly getDefaultDisplayMode: () => DisplayMode | undefined;
  private readonly displayEnvironment: NonNullable<EngineRouterOptions["displayEnvironment"]>;
  /** closeAll has begun: whatever a launch brings up from now on is closed at once. */
  private shuttingDown = false;

  constructor(opts: EngineRouterOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.engineRegistry = opts.engineRegistry;
    this.getDefaultEngine = opts.getDefaultEngine;
    this.chromiumDriver = opts.chromiumDriver;
    this.firefoxOptions = opts.firefoxOptions;
    this.engineNotReady = opts.engineNotReady ?? "wait";
    this.limiter = new BrowserLimiter(opts.maxBrowsers ?? Infinity);
    this.browserQueueTimeoutMs = opts.browserQueueTimeoutMs ?? BROWSER_QUEUE_TIMEOUT_MS;
    this.displayModeDefault = opts.displayModeDefault ?? "headed";
    this.forcedDisplayMode = opts.forcedDisplayMode;
    this.getDefaultDisplayMode = opts.getDefaultDisplayMode ?? (() => undefined);
    this.displayEnvironment = opts.displayEnvironment ?? {
      platform: process.platform,
      env: process.env,
      hasXvfb: () => hasXvfbBinary(),
    };
    this.chromiumDriver.on("running-changed", (c) => this.onSubEvent(c));
  }

  override on<K extends keyof EngineRouterEvents>(event: K, listener: EngineRouterEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof EngineRouterEvents>(
    event: K,
    ...args: Parameters<EngineRouterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  private onSubEvent(change: RunningStateChange): void {
    if (change.kind === "closed") {
      this.bindings.delete(change.profileId);
      this.limiter.release(change.profileId);
      this.clearUploadInbox(change.profileId);
    }
    this.emit("running-changed", change);
  }

  /**
   * A browser reads an uploaded file when the page submits it, so base64 uploads
   * stay on disk until the browser is gone. Here, because every way of closing a
   * profile ends up here, including a browser that was killed.
   */
  private clearUploadInbox(profileId: ProfileId): void {
    let dataDir: string | undefined;
    try {
      dataDir = this.profileManager.get(profileId)?.dataDir;
    } catch {
      return; // The database closes during shutdown; the next close of this profile clears it.
    }
    if (!dataDir) return;
    void rm(join(dataDir, PROFILE_UPLOADS_DIR, UPLOAD_INBOX_DIR), {
      recursive: true,
      force: true,
      maxRetries: 3,
    }).catch(() => {});
  }

  /** The engine a not-yet-running profile would launch on. */
  private engineFor(profileId: ProfileId): BrowserEngine {
    const profile = this.profileManager.get(profileId);
    return resolveEngine(profile?.engine, this.getDefaultEngine());
  }

  /** Lazily construct the Firefox driver on first Camoufox launch. */
  private firefox(): Promise<BrowserDriver> {
    // The promise, not its result: two launches can both arrive during the import.
    this.firefoxLoading ??= (async () => {
      const { FirefoxBrowserDriver } = await import("./FirefoxBrowserDriver.ts");
      // The camoufox binary is downloaded + located by CamoufoxBootstrap
      // (via CAMOUFOX_INSTALL_DIR); the driver lets camoufox-js resolve it, so
      // no executable path is threaded here.
      this.firefoxDriver = new FirefoxBrowserDriver({
        ...this.firefoxOptions,
        profileManager: this.profileManager,
        browserDataDir: (profile) => browserDataDirForEngine(profile.dataDir, "camoufox"),
        buildFingerprintConfig: (profile) => camoufoxConfigForProfile(profile),
      });
      this.firefoxDriver.on("running-changed", (c) => this.onSubEvent(c));
      return this.firefoxDriver;
    })().catch((e: unknown) => {
      this.firefoxLoading = null;
      throw e;
    });
    return this.firefoxLoading;
  }

  private async driverForEngine(engine: BrowserEngine): Promise<BrowserDriver> {
    if (isChromiumEngine(engine)) return this.chromiumDriver;
    if (engine === "camoufox") return this.firefox();
    throw new Error(`No driver for engine "${engine}"`);
  }

  /** The driver a RUNNING profile is bound to; throws if it isn't running. */
  private require(profileId: ProfileId): BrowserDriver {
    const driver = this.bindings.get(profileId);
    if (!driver) {
      throw new MultizenError("PROFILE_NOT_RUNNING", `Profile ${profileId} is not running`);
    }
    return driver;
  }

  /** Binary-gate a launch on this engine, by the `engineNotReady` rule. */
  private async ensureEngine(engine: BrowserEngine): Promise<void> {
    const bootstrap = this.engineRegistry.get(engine);
    if (this.engineNotReady === "wait") {
      await bootstrap.ensure();
      return;
    }
    const before = bootstrap.getStatus();
    let settled = false;
    const ensuring = bootstrap.ensure().finally(() => {
      settled = true;
    });
    // May outlive this call. A failure then shows in the status and in the next launch.
    ensuring.catch(() => {});
    // An installed engine settles at once and never reports one of these steps.
    while (!settled) {
      const status = bootstrap.getStatus();
      if (INSTALLING.has(status.kind)) throw engineNotReadyError(engine, status, before);
      await new Promise((resolve) => setTimeout(resolve, ENGINE_STATUS_POLL_MS));
    }
    await ensuring;
  }

  async launch(profileId: ProfileId, opts: LaunchOptions = {}): Promise<LaunchedProfile> {
    // Its browser still holds the data dir, which a new one would fail on.
    await this.closing.get(profileId)?.catch(() => {});
    if (this.shuttingDown) {
      throw new MultizenError("LAUNCH_FAILED", "The server is shutting down.");
    }
    // What this machine can't do is refused whatever is running.
    if (opts.displayMode) this.resolveMode(profileId, opts.displayMode);
    const bound = this.bindings.get(profileId);
    if (bound) {
      this.assertSameMode(profileId, opts.displayMode, this.runningDisplayMode(profileId));
      return bound.launch(profileId); // idempotent — already running
    }
    const underway = this.inFlight.get(profileId);
    if (underway) {
      this.assertSameMode(profileId, opts.displayMode, underway.displayMode);
      return underway.promise;
    }

    const displayMode = this.resolveMode(profileId, opts.displayMode);
    const callOff = new AbortController();
    const promise = this.startLaunch(profileId, displayMode, callOff.signal, opts.signal).finally(() => {
      this.inFlight.delete(profileId);
    });
    this.inFlight.set(profileId, { promise, callOff, displayMode });
    return promise;
  }

  private resolveMode(profileId: ProfileId, explicit: DisplayMode | undefined): DisplayMode {
    return resolveDisplayMode({
      ...this.displayEnvironment,
      explicit,
      profile: this.profileManager.get(profileId)?.displayMode,
      setting: this.getDefaultDisplayMode(),
      flag: this.displayModeDefault,
      forced: this.forcedDisplayMode,
    });
  }

  /** Only a mode named by the caller can conflict: a plain launch means "make sure it runs". */
  private assertSameMode(
    profileId: ProfileId,
    explicit: DisplayMode | undefined,
    running: DisplayMode | null,
  ): void {
    if (!explicit || !running || explicit === running) return;
    throw new MultizenError(
      "PROFILE_ALREADY_RUNNING",
      `Profile ${profileId} is already running in display mode "${running}", not "${explicit}".`,
      { hint: `Call close_profile, then launch_profile with display_mode "${explicit}".` },
    );
  }

  private async startLaunch(
    profileId: ProfileId,
    displayMode: DisplayMode,
    callOff: AbortSignal,
    client: AbortSignal | undefined,
  ): Promise<LaunchedProfile> {
    const engine = this.engineFor(profileId);
    // Binary-gate the launch on this engine (idempotent; the Chromium driver
    // also self-gates, the Firefox driver relies on this). A close doesn't sit through
    // a download. A client that stops waiting does let it finish, as it always could.
    const calledOff = new Promise<never>((_, reject) => {
      callOff.addEventListener("abort", () => reject(launchCalledOff(profileId)), { once: true });
    });
    await Promise.race([this.ensureEngine(engine), calledOff]);

    await this.limiter.acquire(profileId, {
      timeoutMs: this.browserQueueTimeoutMs,
      signal: client ? AbortSignal.any([client, callOff]) : callOff,
    });
    try {
      const driver = await this.driverForEngine(engine);
      const result = await driver.launch(profileId, { displayMode }).catch((e: unknown) => {
        throw typedLaunchError(e);
      });
      // A browser that died this early reported its end before this binding could exist.
      if (!driver.isRunning(profileId)) {
        throw new MultizenError("LAUNCH_FAILED", "The browser exited right after it started.");
      }
      this.bindings.set(profileId, driver);
      if (this.shuttingDown) {
        await this.closeBound(profileId, driver);
        throw new MultizenError("LAUNCH_FAILED", "The server is shutting down.");
      }
      return result;
    } catch (e) {
      this.limiter.release(profileId);
      throw e;
    }
  }

  /** During a launch this means the browser that launch brings up, so it waits for it. */
  async close(profileId: ProfileId): Promise<void> {
    const underway = this.inFlight.get(profileId);
    if (underway) {
      underway.callOff.abort();
      await underway.promise.catch(() => {});
    }
    await this.closing.get(profileId)?.catch(() => {});
    const driver = this.bindings.get(profileId);
    if (!driver) return;
    await this.closeBound(profileId, driver);
  }

  /** The browser's slot frees here even if the driver had no event to report. */
  private async closeBound(profileId: ProfileId, driver: BrowserDriver): Promise<void> {
    const closing = driver.close(profileId).finally(() => {
      this.closing.delete(profileId);
      this.bindings.delete(profileId);
      this.limiter.release(profileId);
    });
    this.closing.set(profileId, closing);
    await closing;
  }

  isRunning(profileId: ProfileId): boolean {
    const driver = this.bindings.get(profileId);
    return driver ? driver.isRunning(profileId) : false;
  }

  navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    return this.require(profileId).navigate(profileId, url);
  }
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    return this.require(profileId).click(profileId, selector);
  }
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    return this.require(profileId).type(profileId, selector, text);
  }
  clickRef(profileId: ProfileId, ref: string): Promise<{ ok: true }> {
    return this.require(profileId).clickRef(profileId, ref);
  }
  typeRef(profileId: ProfileId, ref: string, text: string): Promise<{ ok: true }> {
    return this.require(profileId).typeRef(profileId, ref, text);
  }
  extract(profileId: ProfileId): Promise<{ result: unknown }> {
    return this.require(profileId).extract(profileId);
  }
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    return this.require(profileId).screenshot(profileId);
  }
  cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    // Delegates to the bound driver: on a Camoufox profile that's the Firefox
    // driver, whose cdpSend throws "unsupported on this engine" (AC6).
    return this.require(profileId).cdpSend(profileId, method, params, sessionId, opts);
  }
  evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).evaluateJs(profileId, expression, sessionId);
  }
  getCookies(profileId: ProfileId, urls?: string[], sessionId?: string): Promise<unknown> {
    return this.require(profileId).getCookies(profileId, urls, sessionId);
  }
  setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.require(profileId).setCookies(profileId, cookies, sessionId);
  }
  listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.require(profileId).listTabs(profileId, sessionId);
  }
  newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).newTab(profileId, url, sessionId);
  }
  activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).activateTab(profileId, targetId, sessionId);
  }
  closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.require(profileId).closeTab(profileId, targetId, sessionId);
  }
  performAction(profileId: ProfileId, action: DriverAction): Promise<{ ok: true }> {
    return this.require(profileId).performAction(profileId, action);
  }
  /** Downloads outlive the browser. A stopped profile asks the driver of its engine. */
  private downloadsDriver(profileId: ProfileId): BrowserDriver | null {
    const bound = this.bindings.get(profileId);
    if (bound) return bound;
    return isChromiumEngine(this.engineFor(profileId)) ? this.chromiumDriver : this.firefoxDriver;
  }
  /**
   * A stopped Camoufox profile after a restart, its driver not loaded yet. The tracker
   * doesn't need it, and loading it now would freeze camoufox-js's install dir too early.
   */
  private async unloadedDriverDownloads(profileId: ProfileId): Promise<DownloadTracker | null> {
    const dataDir = this.profileManager.get(profileId)?.dataDir;
    return dataDir ? sharedDownloadTracker(join(dataDir, PROFILE_DOWNLOADS_DIR)) : null;
  }
  async listDownloads(profileId: ProfileId): Promise<DownloadRecord[]> {
    const driver = this.downloadsDriver(profileId);
    if (driver) return driver.listDownloads(profileId);
    return (await this.unloadedDriverDownloads(profileId))?.list() ?? [];
  }
  async getDownload(profileId: ProfileId, downloadId: string): Promise<DownloadFile | null> {
    const driver = this.downloadsDriver(profileId);
    if (driver) return driver.getDownload(profileId, downloadId);
    return (await this.unloadedDriverDownloads(profileId))?.get(downloadId) ?? null;
  }
  setDialogPolicy(profileId: ProfileId, policy: DialogPolicy): Promise<{ ok: true }> {
    return this.require(profileId).setDialogPolicy(profileId, policy);
  }
  listDialogs(profileId: ProfileId): Promise<OpenDialog[]> {
    return this.require(profileId).listDialogs(profileId);
  }
  handleDialog(profileId: ProfileId, response: DialogResponse): Promise<{ ok: true }> {
    return this.require(profileId).handleDialog(profileId, response);
  }
  captureFrame(profileId: ProfileId, opts?: { quality?: number }): Promise<CapturedFrame> {
    return this.require(profileId).captureFrame(profileId, opts);
  }
  dispatchInput(profileId: ProfileId, event: HumanInputEvent): Promise<void> {
    return this.require(profileId).dispatchInput(profileId, event);
  }
  hasOpenDialog(profileId: ProfileId): boolean {
    return this.bindings.get(profileId)?.hasOpenDialog?.(profileId) ?? false;
  }
  runningInfo(profileId: ProfileId): RunningInfo | null {
    return this.bindings.get(profileId)?.runningInfo?.(profileId) ?? null;
  }
  runningDisplayMode(profileId: ProfileId): DisplayMode | null {
    return this.bindings.get(profileId)?.runningDisplayMode?.(profileId) ?? null;
  }

  /** `opts` shortens the Chromium shutdown on the quit path (see before-quit). */
  async closeAll(opts: { gracefulMs?: number; reap?: boolean } = {}): Promise<void> {
    this.shuttingDown = true;
    const launches = [...this.inFlight.values()];
    for (const launch of launches) launch.callOff.abort();
    // Together, not in sequence: the before-quit watchdog bounds the whole call,
    // so a slow engine must not starve the other one of its shutdown.
    await Promise.all([
      this.chromiumDriver.closeAll(opts),
      this.firefoxDriver ? this.firefoxDriver.closeAll() : undefined,
      ...launches.map((launch) => launch.promise.catch(() => {})),
    ]);
    this.bindings.clear();
  }
}

function engineNotReadyError(
  engine: BrowserEngine,
  status: ChromiumStatus,
  before: ChromiumStatus,
): MultizenError {
  return new MultizenError(
    "ENGINE_NOT_READY",
    `The ${engine} engine is still being installed (${status.kind}); no browser was started.`,
    {
      hint: "Call launch_profile again after details.retry_after_ms.",
      details: {
        retry_after_ms: ENGINE_RETRY_AFTER_MS,
        engine,
        status: status.kind,
        ...(status.kind === "downloading"
          ? { bytes_received: status.bytesReceived, bytes_total: status.bytesTotal }
          : {}),
        // Otherwise a failing install looks like an endless "try again".
        ...(before.kind === "error" ? { last_error: before.message } : {}),
      },
    },
  );
}

/** The two engines fail a launch in their own words; clients get one code for it. */
function typedLaunchError(e: unknown): unknown {
  if (e instanceof MultizenError) return e;
  if (e instanceof StrictGeoCoherenceError) return new MultizenError("GEO_MISMATCH", e.message);
  return new MultizenError("LAUNCH_FAILED", e instanceof Error ? e.message : String(e));
}
