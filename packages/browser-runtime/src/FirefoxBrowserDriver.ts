import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  firefox,
  type BrowserContext,
  type Dialog,
  type Download,
  type Locator,
  type Page,
} from "playwright-core";
import { launchOptions } from "camoufox-js";
import { parseChord, randomRefBase, TargetRegistry, type KeyPlatform } from "@multizen/cdp-driver";
import type { BrowserDriver } from "@multizen/types";
import type {
  CapturedFrame,
  DialogPolicy,
  DialogResponse,
  DialogType,
  DisplayMode,
  DownloadFile,
  DownloadRecord,
  DriverAction,
  ElementTarget,
  LaunchedProfile,
  LaunchOptions,
  OpenDialog,
  Profile,
  ProfileId,
} from "@multizen/types";
import { DEFAULT_DIALOG_ANSWERS, MultizenError, PROFILE_DOWNLOADS_DIR } from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import { displayEnv } from "./displayMode.ts";
import { sharedDownloadTracker, type DownloadTracker } from "./downloads.ts";
import { osForDevice } from "./firefoxFingerprint.ts";
import {
  capLines,
  frameOfRef,
  playwrightChord,
  snapshotRefs,
  TabRefs,
  tabOfRef,
} from "./firefoxRefs.ts";
import { resolveProxyLaunchGeo } from "./launchGeo";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge";
import { sanitizeStartUrl } from "./startPage";
import type { RunningStateChange } from "./ChromiumBrowserDriver.ts";
import { startXvfb, type XvfbHandle } from "./xvfb.ts";

/**
 * BrowserDriver for the Firefox-family engine (Camoufox). Drives the browser
 * through playwright-core's Firefox and configures its anti-detect fingerprint
 * via camoufox-js. There is NO CDP here, so `cdpSend` is rejected — the curated
 * tools work because T16 promoted them to first-class BrowserDriver verbs, which
 * this driver implements natively via Playwright. Page verbs act on the active
 * tab, as on the CDP path. Input goes through Playwright's own actions, which wait
 * for the element to take it, so there is no separate delivery check.
 *
 * Security hardening baked in (from the Camoufox review):
 *   - The binary is app-vendored: CamoufoxBootstrap downloads it into
 *     CAMOUFOX_INSTALL_DIR before launch, and camoufox-js resolves it from there
 *     (launchPath), so it never lazy-downloads a ~600MB browser at launch. (We
 *     do NOT pass executable_path — that would break camoufox-js's
 *     properties.json lookup; see the launch() comment.)
 *   - `exclude_addons: ["UBO"]` disables camoufox-js's runtime uBlock XPI fetch.
 *   - the child gets an explicit MINIMAL env (allowlist), never the whole
 *     process.env — so the main process's secrets can't leak into the browser.
 *   - proxies go through the same local SOCKS5 bridge as the Chromium engine
 *     (upstream auth + remote DNS), not raw credentials on the command line.
 */

/** Long enough for a page to settle: the wait Playwright's own actions default to. */
const ACTION_TIMEOUT_MS = 30_000;
/** A <select> has its options or it doesn't: the CDP path doesn't wait for them at all. */
const SELECT_OPTION_TIMEOUT_MS = 3_000;
const FILE_CHOOSER_TIMEOUT_MS = 5_000;
const DOCUMENT_READ_TIMEOUT_MS = 5_000;
const WHEEL_AFTER_MOVE_MS = 150;
const START_PAGE_COMMIT_MS = 3_000;
/**
 * Ceiling for one verb, first call to last. Playwright's actions have their own timeouts,
 * but evaluate, title, keyboard and the like have none, and whoever holds the profile
 * while one hangs holds up everyone behind.
 */
const OPERATION_DEADLINE_MS = 60_000;
/** Typing is paced like a person's, so a verb that types gets this much more per key. */
const OPERATION_MS_PER_KEY = 100;
/** After this a close gives up on Firefox answering: the slot must not stay taken forever. */
const CLOSE_DEADLINE_MS = 15_000;
/** How long closing waits for a finished download to be copied out. */
const DOWNLOAD_DRAIN_MS = 3_000;
/** Under the downloads dir: Playwright's working copies, which it deletes on close. A
 *  kept file can't collide with this: its sanitized name never starts with a dot. */
const PLAYWRIGHT_DOWNLOADS_DIR = ".playwright";
/**
 * Differs between two documents in a frame, and stays through pushState and hash
 * changes. Read in the main world, as `extract` reads the text: a page that tampers
 * with it can only confuse refs into its own elements.
 */
const DOCUMENT_ID = "performance.timeOrigin";

/** The verbs that run as an operation, and how long each may take. */
const typing = (textArg: number) => (args: unknown[], deadlineMs: number) =>
  deadlineMs + [...String(args[textArg])].length * OPERATION_MS_PER_KEY;
const flat = (_args: unknown[], deadlineMs: number): number => deadlineMs;
const OPERATION_BUDGETS: Readonly<Record<string, (args: unknown[], deadlineMs: number) => number>> = {
  navigate: flat,
  click: flat,
  type: flat,
  clickRef: flat,
  typeRef: typing(2),
  extract: flat,
  screenshot: flat,
  evaluateJs: flat,
  getCookies: flat,
  setCookies: flat,
  newTab: flat,
  activateTab: flat,
  closeTab: flat,
  performAction: flat,
  setDialogPolicy: flat,
  handleDialog: flat,
};

/** Set once a verb was given up on: its next input stays unsent. */
const currentOperation = new AsyncLocalStorage<{ failure: unknown }>();

function assertNotGivenUp(): void {
  const op = currentOperation.getStore();
  if (op?.failure) throw op.failure;
}

interface OpenFirefoxDialog extends OpenDialog {
  pageId: string;
  dialog: Dialog;
}

interface ResolvedElement {
  page: Page;
  pageId: string;
  locator: Locator;
  /** How error messages call it. */
  label: string;
  ref?: string;
}

interface RunningFirefox {
  context: BrowserContext;
  startedAt: string;
  pid: number;
  hasProxyBridge: boolean;
  /** True once close() was called, so the close event reports user-close. */
  closingByRequest: boolean;
  /** Stable per-tab ids (Firefox has no CDP targetId). */
  pageIds: Map<Page, string>;
  nextPageId: number;
  /** Which tab page verbs act on, and which one takes over when it closes. */
  targets: TargetRegistry;
  /** The active tab changed without the browser showing it: the next page verb raises it. */
  activeNeedsRaise: boolean;
  /** The persona's platform, which decides what `ControlOrMeta` means. */
  platform: KeyPlatform;
  tabRefs: Map<string, TabRefs>;
  dialogPolicy: DialogPolicy;
  openDialogs: Map<string, OpenFirefoxDialog>;
  dialogSeq: number;
  dialogWatchers: Set<{ pageId: string; fire: () => void }>;
  /** Downloads on their way out of Playwright's directory, which closing empties. */
  savingDownloads: Set<Promise<void>>;
  /** Ends each verb in flight, so nothing waits out a deadline on a gone browser. */
  operations: Set<(e: unknown) => void>;
  /** This run's refs are numbered from here. */
  refBase: number;
  /** Polls for zero open windows and closes the context when the user shuts the
   *  last window (macOS keeps the browser alive otherwise). Set after launch. */
  windowWatcher?: NodeJS.Timeout;
  displayMode: DisplayMode;
  /** Its private display, in xvfb mode. Ends when the browser does. */
  xvfb?: XvfbHandle;
}

interface FirefoxDriverEvents {
  "running-changed": (change: RunningStateChange) => void;
}

export interface FirefoxBrowserDriverOptions {
  profileManager: ProfileManager;
  /** The persistent user-data-dir for a profile on this engine
   *  (e.g. `<profile.dataDir>/engines/camoufox`). */
  browserDataDir: (profile: Profile) => string;
  /** T20 seam: map the profile's fingerprint to a Camoufox `launchOptions`
   *  config. When absent, Camoufox generates its own coherent fingerprint. */
  buildFingerprintConfig?: (profile: Profile) => Record<string, unknown>;
  /** Merged last into Playwright's launch options, over what camoufox produced.
   *  The server sets `handleSIG*: false` here: Playwright's own SIGINT handler
   *  calls process.exit(130), cutting a graceful shutdown short. */
  launchExtras?: Partial<NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>>;
  /** Firefox prefs on top of camoufox's own, which `launchExtras` would replace whole. */
  extraPrefs?: Readonly<Record<string, string | number | boolean>>;
  /** Refs are numbered from here. Default: random per browser run. */
  refBase?: number;
  /** Replaces {@link OPERATION_DEADLINE_MS}. */
  operationDeadlineMs?: number;
  /** Replaces {@link CLOSE_DEADLINE_MS}. */
  closeDeadlineMs?: number;
}

type PersistentContextOptions = NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;

/** What Playwright launches with: camoufox's options, then ours, then the caller's extras. */
export function persistentContextOptions(
  camoufox: PersistentContextOptions,
  ours: Pick<FirefoxBrowserDriverOptions, "launchExtras" | "extraPrefs"> & {
    downloadsPath: string;
    proxy?: { server: string };
  },
): PersistentContextOptions {
  return {
    ...camoufox,
    // Hand the credential-free bridge URL straight to Playwright, overriding
    // whatever camoufox produced. Keeps the socks5 scheme intact end-to-end.
    ...(ours.proxy ? { proxy: ours.proxy } : {}),
    downloadsPath: ours.downloadsPath,
    firefoxUserPrefs: { ...camoufox.firefoxUserPrefs, ...ours.extraPrefs },
    ...ours.launchExtras,
  };
}

/** Only these env vars are forwarded to the browser child — deliberately NOT
 *  the whole process.env, which would leak the main process's secrets/tokens.
 *  The list mirrors what the Chromium driver forwards (plus Firefox/Playwright
 *  specifics): without the Windows HOME-equivalents Playwright's Firefox
 *  amendEnvironment throws (it requires an absolute os.homedir()), and without
 *  the Wayland/DBus vars Firefox can't reach the display on Linux. */
const ENV_ALLOWLIST = [
  // POSIX + locale
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Linux display / session (parity with ChromiumBrowserDriver)
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
  // macOS app-bundle framework lookup
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  // Windows: paths Firefox needs + the HOME-equivalents Playwright requires
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PATHEXT",
];

function minimalChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * Starts the first tab on its way to the start page, and waits for that to commit. A commit
 * arriving after a client's own navigate aborts it with "interrupted by another navigation",
 * which is what a client calling navigate right after launch_profile would otherwise get.
 * Only the commit, and only for so long: a slow start page loads on in the background.
 */
export async function openStartPage(
  page: Pick<Page, "goto">,
  url: string,
  budgetMs = START_PAGE_COMMIT_MS,
): Promise<void> {
  const committed = page.goto(url, { waitUntil: "commit" }).catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    committed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    }),
  ]);
  clearTimeout(timer);
}

/** What a display mode decides among camoufox's options. Its binary can't start in a test. */
export function camoufoxDisplayOptions(
  displayMode: DisplayMode,
  xvfb?: XvfbHandle,
): { headless: boolean; env: Record<string, string> } {
  return {
    headless: displayMode === "headless",
    env: displayEnv(minimalChildEnv(), displayMode, xvfb),
  };
}

export class FirefoxBrowserDriver extends EventEmitter implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningFirefox>();
  private readonly launching = new Map<ProfileId, Promise<LaunchedProfile>>();
  private readonly profileManager: ProfileManager;
  private readonly browserDataDir: (profile: Profile) => string;
  private readonly buildFingerprintConfig?: (profile: Profile) => Record<string, unknown>;
  private readonly launchExtras: FirefoxBrowserDriverOptions["launchExtras"];
  private readonly extraPrefs: FirefoxBrowserDriverOptions["extraPrefs"];
  private readonly refBase: number | undefined;
  private readonly operationDeadlineMs: number;
  private readonly closeDeadlineMs: number;

  /**
   * Bounds every verb in one place, rather than in each body, so nothing an agent
   * reaches runs without a deadline.
   */
  static {
    const proto = FirefoxBrowserDriver.prototype as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const [verb, budget] of Object.entries(OPERATION_BUDGETS)) {
      const run = proto[verb]!;
      proto[verb] = function (this: FirefoxBrowserDriver, ...args: unknown[]): Promise<unknown> {
        return this.operation(args[0] as ProfileId, verb, budget(args, this.operationDeadlineMs), () =>
          run.apply(this, args),
        );
      };
    }
  }

  constructor(opts: FirefoxBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.browserDataDir = opts.browserDataDir;
    this.buildFingerprintConfig = opts.buildFingerprintConfig;
    this.launchExtras = opts.launchExtras;
    this.extraPrefs = opts.extraPrefs;
    this.refBase = opts.refBase;
    this.operationDeadlineMs = opts.operationDeadlineMs ?? OPERATION_DEADLINE_MS;
    this.closeDeadlineMs = opts.closeDeadlineMs ?? CLOSE_DEADLINE_MS;
  }

  override on<K extends keyof FirefoxDriverEvents>(event: K, listener: FirefoxDriverEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof FirefoxDriverEvents>(
    event: K,
    ...args: Parameters<FirefoxDriverEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * One verb's whole run. It rejects at its deadline or when the browser goes, whatever
   * call is outstanding. Playwright can't take a call back, but the verb's later input
   * stays unsent: the caller is about to let another verb start on this page.
   */
  private operation<T>(
    profileId: ProfileId,
    name: string,
    budgetMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const r = this.running.get(profileId);
    if (!r) return work();
    const op: { failure: unknown } = { failure: null };
    return new Promise<T>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        r.operations.delete(fail);
      };
      const fail = (e: unknown): void => {
        op.failure = e;
        finish();
        reject(e);
      };
      const timer = setTimeout(
        () =>
          fail(
            new MultizenError("TIMEOUT", `${name} did not finish within ${budgetMs} ms.`, {
              hint: "The page or browser may be stuck. close_profile ends it at once.",
            }),
          ),
        budgetMs,
      );
      timer.unref?.();
      r.operations.add(fail);
      currentOperation.run(op, async () => work()).then(
        (value) => {
          finish();
          resolve(value);
        },
        (e: unknown) => {
          finish();
          reject(e);
        },
      );
    });
  }

  private failOperations(r: RunningFirefox): void {
    const closed = new MultizenError("PROFILE_NOT_RUNNING", "The browser was closed during this call.");
    for (const fail of [...r.operations]) fail(closed);
  }

  /** Idempotent: a running profile answers as it is, and parallel calls share one launch. */
  async launch(profileId: ProfileId, opts: LaunchOptions = {}): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: "",
        pid: existing.pid,
        startedAt: existing.startedAt,
        displayMode: existing.displayMode,
      };
    }
    const underway = this.launching.get(profileId);
    if (underway) return underway;
    const launch = this.doLaunch(profileId, opts.displayMode ?? "headed").finally(() =>
      this.launching.delete(profileId),
    );
    this.launching.set(profileId, launch);
    return launch;
  }

  private async doLaunch(profileId: ProfileId, displayMode: DisplayMode): Promise<LaunchedProfile> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new MultizenError("PROFILE_NOT_FOUND", `Profile ${profileId} not found`);
    this.profileManager.markOpened(profileId);

    const userDataDir = this.browserDataDir(profile);

    // Same launch geo policy as the Chromium engine (strict-pin timezone, opt-in
    // alignTimezoneToProxy / strictGeoCoherence). Before the bridge starts, so a
    // strict rejection leaves nothing to clean up.
    const { fingerprint } = await resolveProxyLaunchGeo(profile, profile.fingerprint, {
      setProxyCountry: (id, country) => this.profileManager.setProxyCountry(id, country),
    });

    // Route a configured proxy through the local SOCKS5 bridge (handles upstream
    // auth + keeps DNS remote), exactly like the Chromium engine. The browser
    // then talks to a credential-free localhost endpoint.
    let proxy: { server: string } | undefined;
    let hasProxyBridge = false;
    if (profile.proxy) {
      const localProxyUrl = await startBridgeForProfile(profileId, profile.proxy);
      proxy = { server: localProxyUrl };
      hasProxyBridge = true;
    }

    let xvfb: XvfbHandle | undefined;
    if (displayMode === "xvfb") {
      xvfb = await startXvfb({
        width: fingerprint.screen.width,
        height: fingerprint.screen.height,
        runDir: tmpdir(),
      }).catch((e: unknown) => {
        if (hasProxyBridge) stopBridgeForProfile(profileId);
        throw e;
      });
    }

    // We deliberately do NOT pass executable_path. camoufox-js's launchOptions
    // resolves the binary via launchPath() — which respects our
    // CAMOUFOX_INSTALL_DIR (set in CamoufoxBootstrap, and the binary is already
    // downloaded there before we get here) — and, crucially, only then finds
    // properties.json via getPath() in Contents/Resources/. Passing
    // executable_path makes camoufox-js look for properties.json next to the
    // executable (Contents/MacOS/), where Camoufox 152+ no longer ships it → ENOENT.
    // exclude_addons (no runtime uBO fetch) + the explicit minimal env stay
    // app-controlled; the fingerprint config is the T20 seam.
    //
    // We deliberately do NOT hand the proxy to camoufox-js. Its getProxyUrl runs
    // the server URL through `new URL(...).origin`, and `socks5://` is a
    // non-special scheme whose origin is the literal string "null" — Firefox
    // then proxies through a host named "null": the socks5 scheme is lost
    // (defeating the bridge's remote-DNS, no-leak guarantee) and the proxy no
    // longer points at the bridge. Instead we set the proxy directly on the
    // Playwright launch options below, which handles socks5 natively.
    //
    // When a proxy IS active we also block WebRTC (media.peerconnection.enabled
    // = false). camoufox only spoofs the WebRTC IP when `geoip` is set, and
    // geoip auto-detection would run from the HOST (not through the proxy) and
    // pin the real IP — so the safe move is to disable WebRTC on proxied
    // profiles, matching the Chromium engine's non-proxied-UDP hardening. A page
    // otherwise leaks the operator's real address via STUN outside the proxy.
    const config: Record<string, unknown> = {
      ...camoufoxDisplayOptions(displayMode, xvfb),
      exclude_addons: ["UBO"],
      ...(proxy ? { block_webrtc: true } : {}),
      ...(this.buildFingerprintConfig
        ? this.buildFingerprintConfig({ ...profile, fingerprint })
        : {}),
    };

    let context: BrowserContext;
    try {
      const opts = (await launchOptions(
        config as Parameters<typeof launchOptions>[0],
      )) as PersistentContextOptions;
      // Playwright deletes these when the context closes, so each is copied out when
      // it completes. What a crash left in there belongs to nothing.
      const downloadsPath = join(profile.dataDir, PROFILE_DOWNLOADS_DIR, PLAYWRIGHT_DOWNLOADS_DIR);
      await rm(downloadsPath, { recursive: true, force: true }).catch(() => {});
      context = await firefox.launchPersistentContext(
        userDataDir,
        persistentContextOptions(opts, {
          downloadsPath,
          ...(proxy ? { proxy } : {}),
          ...(this.launchExtras ? { launchExtras: this.launchExtras } : {}),
          ...(this.extraPrefs ? { extraPrefs: this.extraPrefs } : {}),
        }),
      );
    } catch (e) {
      await xvfb?.stop().catch(() => {});
      if (hasProxyBridge) stopBridgeForProfile(profileId);
      throw e;
    }

    if (context.pages().length === 0) await context.newPage();
    const record = this.adopt(
      profileId,
      context,
      hasProxyBridge,
      osForDevice(profile.fingerprint.device),
      displayMode,
      xvfb,
    );

    // Open the profile's start page on EVERY launch. Unlike Chromium (which
    // restores the previous tabs via --restore-last-session), Playwright-driven
    // Firefox doesn't restore the session, so a relaunch would otherwise come up
    // on a blank page. Navigating to the start page each time gives a consistent
    // landing instead. sanitizeStartUrl rejects non-http(s)/about URLs and falls
    // back to the app default, like the Chromium path. A nav failure (bad
    // proxy/network) must not throw out of launch().
    const startUrl = sanitizeStartUrl(profile.startUrl);
    const startPage = context.pages()[0];
    if (startPage) await openStartPage(startPage, startUrl);

    this.emit("running-changed", { kind: "launched", profileId });
    return {
      id: profileId,
      cdpEndpoint: "",
      pid: record.pid,
      startedAt: record.startedAt,
      displayMode,
    };
  }

  /** Takes over a started browser: its tabs, and every event that outlives launch(). */
  private adopt(
    profileId: ProfileId,
    context: BrowserContext,
    hasProxyBridge: boolean,
    platform: KeyPlatform,
    displayMode: DisplayMode = "headed",
    xvfb?: XvfbHandle,
  ): RunningFirefox {
    const record: RunningFirefox = {
      context,
      startedAt: new Date().toISOString(),
      // Firefox/Playwright exposes no stable child pid for a persistent context;
      // pid is informational only, so 0 = unknown.
      pid: 0,
      hasProxyBridge,
      closingByRequest: false,
      pageIds: new Map(),
      nextPageId: 1,
      targets: new TargetRegistry(),
      activeNeedsRaise: false,
      platform,
      tabRefs: new Map(),
      dialogPolicy: { mode: "auto" },
      openDialogs: new Map(),
      dialogSeq: 0,
      dialogWatchers: new Set(),
      savingDownloads: new Set(),
      operations: new Set(),
      refBase: this.refBase ?? randomRefBase(),
      displayMode,
      ...(xvfb ? { xvfb } : {}),
    };
    for (const p of context.pages()) {
      record.targets.upsert({ targetId: this.trackPage(record, profileId, p), type: "page" });
    }
    this.running.set(profileId, record);

    // Track tabs opened later so list/activate/close_tab can address them. A popup or
    // a tab the operator opened doesn't take the active tab away.
    context.on("page", (p: Page) => {
      record.targets.addIdle({ targetId: this.trackPage(record, profileId, p), type: "page" });
    });
    context.on("close", () => this.onContextClosed(profileId, record));

    // macOS keeps Firefox alive after its last window closes (standard app
    // lifecycle), so closing the window never closes the persistent context —
    // the profile would look stuck "running" and linger in the Dock. Mirror the
    // Chromium windowWatcher: once there are no open pages for >1.5s, close the
    // context ourselves, which quits Firefox and fires the "close" handler above
    // as an external-exit. The 2s launch grace + 1.5s debounce avoid firing
    // during startup or a quick close-then-open.
    let zeroSinceMs: number | null = null;
    record.windowWatcher = setInterval(() => {
      const r = this.running.get(profileId);
      if (!r || r.closingByRequest) return;
      if (Date.now() - new Date(r.startedAt).getTime() < 2000) return;
      if (r.context.pages().length === 0) {
        if (zeroSinceMs === null) zeroSinceMs = Date.now();
        else if (Date.now() - zeroSinceMs > 1500) {
          if (r.windowWatcher) clearInterval(r.windowWatcher);
          // Show the "terminating" phase while Firefox winds down, like Chromium.
          this.emit("running-changed", { kind: "closing", profileId });
          void r.context.close().catch(() => {});
        }
      } else {
        zeroSinceMs = null;
      }
    }, 1000);
    return record;
  }

  /** Once per browser: a close that gave up on Firefox can still hear from it later. */
  private onContextClosed(profileId: ProfileId, r: RunningFirefox): void {
    if (this.running.get(profileId) !== r) return;
    if (r.windowWatcher) clearInterval(r.windowWatcher);
    if (r.hasProxyBridge) stopBridgeForProfile(profileId);
    void r.xvfb?.stop().catch(() => {});
    this.running.delete(profileId);
    this.failOperations(r);
    this.emit("running-changed", {
      kind: "closed",
      profileId,
      reason: r.closingByRequest ? "user-close" : "external-exit",
    });
  }

  /** Every tab gets its id and its listeners once. Returns the id. */
  private trackPage(r: RunningFirefox, profileId: ProfileId, page: Page): string {
    const known = r.pageIds.get(page);
    if (known) return known;
    const pageId = String(r.nextPageId++);
    r.pageIds.set(page, pageId);
    r.tabRefs.set(pageId, new TabRefs(pageId, r.refBase));
    page.on("dialog", (dialog: Dialog) => this.onDialog(r, pageId, dialog));
    page.on("download", (download: Download) => this.onDownload(r, profileId, download));
    page.on("close", () => this.onPageClosed(r, pageId, page));
    return pageId;
  }

  /**
   * Closing the active tab makes the most recently used remaining tab active. The
   * browser picks its own neighbour to show, so the one chosen here gets raised.
   */
  private onPageClosed(r: RunningFirefox, pageId: string, page: Page): void {
    r.pageIds.delete(page);
    r.tabRefs.delete(pageId);
    for (const dialog of [...r.openDialogs.values()]) {
      if (dialog.pageId === pageId) r.openDialogs.delete(dialog.id);
    }
    const wasActive = r.targets.active() === pageId;
    r.targets.remove(pageId);
    if (wasActive && r.targets.active()) r.activeNeedsRaise = true;
  }

  /** During a launch this means the browser that launch brings up, so it waits for it. */
  async close(profileId: ProfileId): Promise<void> {
    await this.launching.get(profileId)?.catch(() => {});
    const r = this.running.get(profileId);
    if (!r) return;
    r.closingByRequest = true;
    // A call stuck on this browser ends now, not when its deadline comes.
    this.failOperations(r);
    // A finished download may still be being copied out; one still running is
    // canceled by the close.
    if (r.savingDownloads.size > 0) {
      await Promise.race([Promise.allSettled(r.savingDownloads), delay(DOWNLOAD_DRAIN_MS)]);
    }
    // The "close" handler clears the map entry, stops the bridge, and emits the
    // running-changed "closed" event.
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.closeDeadlineMs);
    });
    const closed = r.context.close().catch(() => {}).then(() => false as const);
    const stuck = await Promise.race([closed, gaveUp]);
    clearTimeout(timer);
    if (stuck) {
      console.warn(`[multizen] Camoufox did not close within ${this.closeDeadlineMs} ms; giving up on it`);
      this.onContextClosed(profileId, r);
      return;
    }
    await Promise.allSettled(r.savingDownloads);
    await r.xvfb?.stop().catch(() => {});
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  runningDisplayMode(profileId: ProfileId): DisplayMode | null {
    return this.running.get(profileId)?.displayMode ?? null;
  }

  private require(profileId: ProfileId): RunningFirefox {
    const r = this.running.get(profileId);
    if (!r) throw new MultizenError("PROFILE_NOT_RUNNING", `Profile ${profileId} is not running`);
    return r;
  }

  /** The tab page verbs act on, or TAB_NOT_FOUND when none is open. */
  private activeTab(r: RunningFirefox): { page: Page; pageId: string } {
    const pageId = r.targets.active();
    const page = pageId ? this.pageOfId(r, pageId) : undefined;
    if (!pageId || !page) {
      throw new MultizenError("TAB_NOT_FOUND", "This browser has no open tab.", {
        hint: "Call new_tab, or list_tabs for the open tabs.",
      });
    }
    return { page, pageId };
  }

  /** The active tab, raised if closing another one left it unseen. */
  private async foregroundTab(r: RunningFirefox): Promise<{ page: Page; pageId: string }> {
    const tab = this.activeTab(r);
    if (r.activeNeedsRaise) {
      r.activeNeedsRaise = false;
      await tab.page.bringToFront().catch(() => {});
    }
    return tab;
  }

  private pageOfId(r: RunningFirefox, pageId: string): Page | undefined {
    for (const [page, id] of r.pageIds) {
      if (id === pageId && !page.isClosed()) return page;
    }
    return undefined;
  }

  /** Makes a tab the target of page verbs, and brings it to the foreground. */
  private async activate(r: RunningFirefox, pageId: string, page: Page): Promise<void> {
    await page.bringToFront();
    // Moves it to most recent, which is what re-selection goes by.
    r.targets.upsert({ targetId: pageId, type: "page" });
    r.targets.setActive(pageId);
    r.activeNeedsRaise = false;
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────────

  /**
   * A dialog blocks its page, and with it every command that needs the page, until
   * someone answers. In auto mode that is us, at once. In manual mode the dialog waits
   * for handleDialog, and operations on its tab report DIALOG_OPEN instead of hanging.
   */
  private onDialog(r: RunningFirefox, pageId: string, dialog: Dialog): void {
    const type = dialog.type() as DialogType;
    if (r.dialogPolicy.mode === "auto") {
      void answerDialog(dialog, type, r.dialogPolicy);
      return;
    }
    const id = `d${++r.dialogSeq}`;
    const url = dialog.page()?.url();
    r.openDialogs.set(id, {
      id,
      type,
      message: dialog.message(),
      ...(type === "prompt" ? { defaultPrompt: dialog.defaultValue() } : {}),
      ...(url !== undefined ? { url } : {}),
      openedAt: new Date().toISOString(),
      pageId,
      dialog,
    });
    for (const watcher of [...r.dialogWatchers]) {
      if (watcher.pageId === pageId) watcher.fire();
    }
  }

  private assertNoDialog(r: RunningFirefox, pageId: string): void {
    for (const dialog of r.openDialogs.values()) {
      if (dialog.pageId === pageId) {
        throw new MultizenError(
          "DIALOG_OPEN",
          `A ${dialog.type} dialog is open on this tab: "${dialog.message.slice(0, 200)}"`,
          {
            hint: "Answer it with handle_dialog, then retry.",
            details: { dialog_id: dialog.id, type: dialog.type, message: dialog.message },
          },
        );
      }
    }
  }

  /**
   * Settles with `work`, or as soon as a dialog is left open on this tab: `work` may
   * then not finish until someone answers it, so it is left to run on its own.
   */
  private async untilDialog<T>(
    r: RunningFirefox,
    pageId: string,
    work: Promise<T>,
  ): Promise<{ dialog: false; value: T } | { dialog: true }> {
    let watcher: { pageId: string; fire: () => void } | undefined;
    const opened = new Promise<{ dialog: true }>((resolve) => {
      watcher = { pageId, fire: () => resolve({ dialog: true }) };
      r.dialogWatchers.add(watcher);
      // It may have opened during whatever came just before this.
      for (const dialog of r.openDialogs.values()) {
        if (dialog.pageId === pageId) watcher.fire();
      }
    });
    work.catch(() => {});
    try {
      return await Promise.race([work.then((value) => ({ dialog: false as const, value })), opened]);
    } finally {
      r.dialogWatchers.delete(watcher!);
    }
  }

  /** An operation on a tab's page. Refuses, or stops waiting, when a dialog is in the way. */
  private async pageOp<T>(r: RunningFirefox, pageId: string, work: () => Promise<T>): Promise<T> {
    this.assertNoDialog(r, pageId);
    const outcome = await this.untilDialog(
      r,
      pageId,
      work().catch((e: unknown) => {
        throw pageError(e);
      }),
    );
    if (outcome.dialog) {
      this.assertNoDialog(r, pageId);
      throw new MultizenError("DIALOG_OPEN", "A dialog opened on this tab.");
    }
    return outcome.value;
  }

  /**
   * An input action on an element. A dialog it leaves open counts as delivered: only
   * the action could have opened it, and it blocks the page that would have to confirm.
   */
  private async deliver(
    r: RunningFirefox,
    el: ResolvedElement,
    work: () => Promise<unknown>,
  ): Promise<void> {
    assertNotGivenUp();
    this.assertNoDialog(r, el.pageId);
    await this.untilDialog(
      r,
      el.pageId,
      work().catch(async (e: unknown) => {
        throw await elementError(e, el);
      }),
    );
  }

  async setDialogPolicy(profileId: ProfileId, policy: DialogPolicy): Promise<{ ok: true }> {
    const r = this.require(profileId);
    r.dialogPolicy = policy;
    // Dialogs left open under manual mode are answered by the new policy if it is auto.
    if (policy.mode === "auto") {
      const open = [...r.openDialogs.values()];
      r.openDialogs.clear();
      await Promise.all(open.map((d) => answerDialog(d.dialog, d.type, policy)));
    }
    return { ok: true };
  }

  async listDialogs(profileId: ProfileId): Promise<OpenDialog[]> {
    return [...this.require(profileId).openDialogs.values()].map(
      ({ pageId: _pageId, dialog: _dialog, ...open }) => open,
    );
  }

  async handleDialog(profileId: ProfileId, response: DialogResponse): Promise<{ ok: true }> {
    const r = this.require(profileId);
    const open = response.dialogId
      ? r.openDialogs.get(response.dialogId)
      : r.openDialogs.values().next().value;
    if (!open) {
      throw new MultizenError(
        "INVALID_INPUT",
        response.dialogId ? `No open dialog ${response.dialogId}` : "No dialog is open",
        { hint: "Call list_dialogs for the open dialogs." },
      );
    }
    r.openDialogs.delete(open.id);
    if (response.action === "accept") await open.dialog.accept(response.promptText);
    else await open.dialog.dismiss();
    return { ok: true };
  }

  hasOpenDialog(profileId: ProfileId): boolean {
    return (this.running.get(profileId)?.openDialogs.size ?? 0) > 0;
  }

  // ── Downloads ───────────────────────────────────────────────────────────────

  /**
   * Caught from launch, desktop included: unlike the CDP path there is nothing to arm,
   * since Playwright takes every download anyway and deletes it with the context.
   */
  private onDownload(r: RunningFirefox, profileId: ProfileId, download: Download): void {
    const saving: Promise<void> = this.saveDownload(profileId, download)
      .catch((e: unknown) => {
        console.warn("[multizen] saving a download failed:", (e as Error).message);
      })
      .finally(() => r.savingDownloads.delete(saving));
    r.savingDownloads.add(saving);
  }

  private async saveDownload(profileId: ProfileId, download: Download): Promise<void> {
    const tracker = await this.downloadTracker(profileId);
    const guid = randomUUID();
    tracker.began({ guid, url: download.url(), suggestedFilename: download.suggestedFilename() });
    const path = join(tracker.dir, guid);
    try {
      // Waits for the download to finish, and fails if it fails.
      await download.saveAs(path);
      const { size } = await stat(path);
      tracker.progress({ guid, totalBytes: size, receivedBytes: size, state: "completed" });
    } catch {
      tracker.progress({ guid, totalBytes: 0, receivedBytes: 0, state: "canceled" });
    }
    await tracker.settled();
  }

  private async downloadTracker(profileId: ProfileId): Promise<DownloadTracker> {
    const profile = this.profileManager.get(profileId);
    if (!profile) throw new MultizenError("PROFILE_NOT_FOUND", `Profile ${profileId} not found`);
    return sharedDownloadTracker(join(profile.dataDir, PROFILE_DOWNLOADS_DIR));
  }

  async listDownloads(profileId: ProfileId): Promise<DownloadRecord[]> {
    return (await this.downloadTracker(profileId)).list();
  }

  async getDownload(profileId: ProfileId, downloadId: string): Promise<DownloadFile | null> {
    return (await this.downloadTracker(profileId)).get(downloadId);
  }

  // ── Elements ────────────────────────────────────────────────────────────────

  /**
   * The element a public ref names, on its tab, which becomes the active one first.
   * Reaches it only in the document the ref came from: by now Playwright's name for it
   * may mean something else.
   */
  private async resolveRef(r: RunningFirefox, ref: string): Promise<ResolvedElement> {
    const pageId = tabOfRef(ref);
    if (pageId === null) throw unknownRef(ref);
    const page = this.pageOfId(r, pageId);
    if (!page) {
      if (Number(pageId) >= 1 && Number(pageId) < r.nextPageId) throw staleRef(ref);
      throw tabNotFound(pageId);
    }
    const entry = r.tabRefs.get(pageId)?.lookup(ref);
    if (!entry || entry === "unknown") throw unknownRef(ref);
    if (entry === "stale") throw staleRef(ref);
    this.assertNoDialog(r, pageId);
    if (r.targets.active() !== pageId) await this.activate(r, pageId, page);
    else await this.foregroundTab(r);
    const locator = page.locator(`aria-ref=${entry.inner}`);
    await this.pageOp(r, pageId, async () => {
      if ((await resolvedCount(locator)) === 0) throw staleRef(ref);
      const document = await readDocument(locator).catch(() => null);
      if (document !== entry.document) throw staleRef(ref);
    });
    return { page, pageId, locator, label: `ref "${ref}"`, ref };
  }

  private async resolveTarget(r: RunningFirefox, target: ElementTarget): Promise<ResolvedElement> {
    if ("ref" in target) return this.resolveRef(r, target.ref);
    const { page, pageId } = await this.foregroundTab(r);
    return {
      page,
      pageId,
      // The first match, as querySelector gives on the other engine.
      locator: page.locator(target.selector).first(),
      label: `selector ${target.selector}`,
    };
  }

  // ── Page verbs ──────────────────────────────────────────────────────────────

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const r = this.require(profileId);
    const { page, pageId } = await this.foregroundTab(r);
    return this.pageOp(r, pageId, async () => {
      await page.goto(url).catch((e: unknown) => {
        throw navigationError(url, e);
      });
      return { url: page.url() };
    });
  }

  async click(profileId: ProfileId, selector: string): Promise<{ ok: true }> {
    const r = this.require(profileId);
    const el = await this.resolveTarget(r, { selector });
    await this.deliver(r, el, () => el.locator.click({ timeout: ACTION_TIMEOUT_MS }));
    return { ok: true };
  }

  async type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }> {
    const r = this.require(profileId);
    const el = await this.resolveTarget(r, { selector });
    await this.deliver(r, el, () => el.locator.fill(text, { timeout: ACTION_TIMEOUT_MS }));
    return { ok: true };
  }

  async clickRef(profileId: ProfileId, ref: string): Promise<{ ok: true }> {
    const r = this.require(profileId);
    const el = await this.resolveRef(r, ref);
    await this.deliver(r, el, () => el.locator.click({ timeout: ACTION_TIMEOUT_MS }));
    return { ok: true };
  }

  /** Real keys after a real click. A dialog opened before the last key stops the typing. */
  async typeRef(profileId: ProfileId, ref: string, text: string): Promise<{ ok: true }> {
    const r = this.require(profileId);
    const el = await this.resolveRef(r, ref);
    await this.deliver(r, el, () => el.locator.click({ timeout: ACTION_TIMEOUT_MS }));
    this.assertNoDialog(r, el.pageId);
    const chars = [...text];
    const progress = { sent: 0, stopped: false };
    const outcome = await this.untilDialog(
      r,
      el.pageId,
      (async () => {
        for (const ch of chars) {
          if (progress.stopped) return;
          assertNotGivenUp();
          progress.sent++;
          await el.page.keyboard.type(ch, { delay: randIn(12, 45) });
          await delay(randIn(8, 30));
        }
      })().catch((e: unknown) => {
        throw pageError(e);
      }),
    );
    if (outcome.dialog) {
      progress.stopped = true;
      if (progress.sent < chars.length) this.assertNoDialog(r, el.pageId);
    }
    return { ok: true };
  }

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const r = this.require(profileId);
    const { page, pageId } = await this.foregroundTab(r);
    return this.pageOp(r, pageId, async () => {
      const raw = await page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS });
      // Refs past the cut are never issued, so there's nothing to resolve them against.
      const snapshot = capLines(raw);
      const documents = await documentsOf(page, snapshotRefs(snapshot.text));
      const refs = r.tabRefs.get(pageId);
      if (!refs) throw tabNotFound(pageId);
      const text = capLines(String(await page.evaluate("document.body ? document.body.innerText : ''")));
      const result = {
        url: page.url(),
        title: await page.title(),
        text: text.text,
        ariaSnapshot: refs.publish(snapshot.text, documents),
        ...(snapshot.truncated || text.truncated ? { truncated: true } : {}),
      };
      return { result };
    });
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const r = this.require(profileId);
    const { page, pageId } = await this.foregroundTab(r);
    return this.pageOp(r, pageId, async () => {
      // Playwright's default hides the caret with a style injected into the page's DOM.
      const buf = await page.screenshot({ type: "png", caret: "initial" });
      return { pngBase64: Buffer.from(buf).toString("base64") };
    });
  }

  // ── Engine-neutral curated verbs, implemented natively (no CDP). ────────────
  async evaluateJs(profileId: ProfileId, expression: string): Promise<unknown> {
    const r = this.require(profileId);
    const { page, pageId } = await this.foregroundTab(r);
    return this.pageOp(r, pageId, async () => {
      const value = await page.evaluate(expression);
      // Mirror the Chromium shape so shared consumers (e.g. the wait_for_* polls
      // that read `result.value`) work identically across engines.
      return { result: { value } };
    });
  }

  async getCookies(profileId: ProfileId, urls?: string[]): Promise<unknown> {
    const cookies = await this.require(profileId).context.cookies(urls);
    return { cookies };
  }

  async setCookies(profileId: ProfileId, cookies: unknown[]): Promise<unknown> {
    await this.require(profileId).context.addCookies(
      cookies as Parameters<BrowserContext["addCookies"]>[0],
    );
    return { ok: true };
  }

  async listTabs(profileId: ProfileId): Promise<unknown> {
    const r = this.require(profileId);
    const targetInfos = r.context.pages().map((p) => ({
      targetId: r.pageIds.get(p) ?? "",
      type: "page",
      url: p.url(),
    }));
    return { targetInfos, activeTargetId: r.targets.active() };
  }

  /**
   * Opens a tab and makes it the active one. A url here may still be loading when this
   * returns, as on the other engine; a navigate that follows simply takes over.
   */
  async newTab(profileId: ProfileId, url?: string): Promise<unknown> {
    const r = this.require(profileId);
    const page = await r.context.newPage();
    const targetId = this.trackPage(r, profileId, page);
    await this.activate(r, targetId, page);
    if (url) void page.goto(url).catch(() => {});
    return { targetId };
  }

  async activateTab(profileId: ProfileId, targetId: string): Promise<unknown> {
    const r = this.require(profileId);
    await this.activate(r, targetId, this.pageById(r, targetId));
    return { ok: true };
  }

  async closeTab(profileId: ProfileId, targetId: string): Promise<unknown> {
    const r = this.require(profileId);
    await this.pageById(r, targetId).close();
    if (r.targets.active()) await this.foregroundTab(r);
    return { ok: true };
  }

  private pageById(r: RunningFirefox, targetId: string): Page {
    const page = this.pageOfId(r, targetId);
    if (!page) throw tabNotFound(targetId);
    return page;
  }

  /** Raw CDP is Chromium-only; Camoufox speaks the Firefox protocol (AC6). */
  async cdpSend(): Promise<unknown> {
    throw new MultizenError(
      "UNSUPPORTED_ON_ENGINE",
      "cdp_send is unsupported on the Firefox (Camoufox) engine",
      { hint: "Use the page tools, or evaluate_js for what they don't cover." },
    );
  }

  async performAction(profileId: ProfileId, action: DriverAction): Promise<{ ok: true }> {
    const r = this.require(profileId);
    switch (action.type) {
      case "press_key":
        await this.pressKey(r, action.key, action.target);
        break;
      case "hover": {
        const el = await this.resolveTarget(r, action.target);
        await this.deliver(r, el, () => el.locator.hover({ timeout: ACTION_TIMEOUT_MS }));
        break;
      }
      case "select_option":
        await this.selectOption(r, action.target, {
          ...(action.value !== undefined ? { value: action.value } : {}),
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.index !== undefined ? { index: action.index } : {}),
        });
        break;
      case "scroll":
        await this.scroll(r, action);
        break;
      case "upload_file":
        await this.uploadFile(r, action.target, action.paths);
        break;
      case "bring_to_front":
        await this.activeTab(r).page.bringToFront();
        break;
    }
    return { ok: true };
  }

  /** With a target, a click focuses it first. Without one the key goes wherever focus is. */
  private async pressKey(r: RunningFirefox, key: string, target?: ElementTarget): Promise<void> {
    const chord = parseChord(key, r.platform);
    let tab: { page: Page; pageId: string };
    if (target) {
      const el = await this.resolveTarget(r, target);
      await this.deliver(r, el, () => el.locator.click({ timeout: ACTION_TIMEOUT_MS }));
      tab = el;
    } else {
      tab = await this.foregroundTab(r);
    }
    assertNotGivenUp();
    this.assertNoDialog(r, tab.pageId);
    // A glyph off the US layout has no physical key, on either engine: it is inserted.
    const press =
      chord.key.code || chord.modifiers.length > 0
        ? tab.page.keyboard.press(playwrightChord(chord), { delay: randIn(12, 45) })
        : tab.page.keyboard.insertText(chord.key.key);
    await this.untilDialog(
      r,
      tab.pageId,
      press.catch((e: unknown) => {
        throw keyError(key, e);
      }),
    );
  }

  /**
   * Playwright's own way: the selection is set directly, the events are untrusted.
   * Measured: when the mouse was in use before, Firefox itself fires input and change
   * once more at the next mouse move, with the same value.
   */
  private async selectOption(
    r: RunningFirefox,
    target: ElementTarget,
    choice: { value?: string; label?: string; index?: number },
  ): Promise<void> {
    const el = await this.resolveTarget(r, target);
    await this.pageOp(r, el.pageId, () =>
      el.locator
        .selectOption(choice, { timeout: SELECT_OPTION_TIMEOUT_MS })
        .catch(async (e: unknown) => {
          if (/did not find some options/.test(errorText(e))) {
            throw new MultizenError(
              "ELEMENT_NOT_FOUND",
              `${el.label} has no option matching ${JSON.stringify(choice)}`,
            );
          }
          throw await elementError(e, el);
        }),
    );
  }

  /**
   * Wheel over the element or, with none, the middle of the viewport. An element with
   * no deltas is scrolled into view instead.
   */
  private async scroll(
    r: RunningFirefox,
    opts: { target?: ElementTarget; deltaX?: number; deltaY?: number },
  ): Promise<void> {
    const { target, deltaX, deltaY } = opts;
    let tab: { page: Page; pageId: string };
    let point: { x: number; y: number };
    if (target) {
      const el = await this.resolveTarget(r, target);
      tab = el;
      const intoView = (): Promise<void> =>
        el.locator
          .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
          .catch(async (e: unknown) => {
            throw await elementError(e, el);
          });
      if (deltaX === undefined && deltaY === undefined) {
        await this.pageOp(r, el.pageId, intoView);
        return;
      }
      point = await this.pageOp(r, el.pageId, async () => {
        await intoView();
        const box = await el.locator.boundingBox({ timeout: ACTION_TIMEOUT_MS });
        if (!box) throw notVisible(el);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
    } else {
      tab = await this.foregroundTab(r);
      const { page } = tab;
      point = await this.pageOp(r, tab.pageId, () =>
        page.evaluate<{ x: number; y: number }>("({ x: innerWidth / 2, y: innerHeight / 2 })"),
      );
    }
    const { page } = tab;
    await this.untilDialog(
      r,
      tab.pageId,
      (async () => {
        await page.mouse.move(point.x, point.y);
        // Firefox keeps scrolling the frame it last wheeled until the mouse has been
        // moved for 100 ms. Measured: at once, a wheel over an iframe scrolled the page.
        await delay(WHEEL_AFTER_MOVE_MS);
        await page.mouse.wheel(deltaX ?? 0, deltaY ?? 0);
      })().catch((e: unknown) => {
        throw pageError(e);
      }),
    );
  }

  /** Files for a file input, or for the chooser an element opens when clicked. */
  private async uploadFile(
    r: RunningFirefox,
    target: ElementTarget,
    paths: readonly string[],
  ): Promise<void> {
    const el = await this.resolveTarget(r, target);
    const isFileInput = await this.pageOp(r, el.pageId, () =>
      el.locator
        .setInputFiles([...paths], { timeout: ACTION_TIMEOUT_MS })
        .then(() => true)
        .catch(async (e: unknown) => {
          if (/Node is not an HTMLInputElement|Not an input\[type=file\]/.test(errorText(e))) {
            return false;
          }
          if (/Non-multiple file input/.test(errorText(e))) {
            throw new MultizenError("INVALID_INPUT", `${el.label} takes a single file`);
          }
          throw await elementError(e, el);
        }),
    );
    if (isFileInput) return;
    const chooser = el.page.waitForEvent("filechooser", { timeout: FILE_CHOOSER_TIMEOUT_MS });
    chooser.catch(() => {});
    await this.deliver(r, el, () => el.locator.click({ timeout: ACTION_TIMEOUT_MS }));
    const opened = await chooser.catch((e: unknown) => {
      throw (e as Error).name === "TimeoutError"
        ? new MultizenError(
            "TIMEOUT",
            `${el.label} did not open a file chooser within ${FILE_CHOOSER_TIMEOUT_MS}ms`,
          )
        : pageError(e);
    });
    await opened.setFiles([...paths]);
  }

  // The handoff panel's view and input, which a later change fills in. Until then
  // each refuses by code, so a client sees a typed error rather than a missing method.
  async captureFrame(): Promise<CapturedFrame> {
    throw notAvailableYet("captureFrame");
  }

  async dispatchInput(): Promise<void> {
    throw notAvailableYet("dispatchInput");
  }

  /** Closing waits for a launch under way, whose browser would outlive this process. */
  async closeAll(): Promise<void> {
    const ids = new Set([...this.running.keys(), ...this.launching.keys()]);
    await Promise.all([...ids].map((id) => this.close(id)));
  }
}

function notAvailableYet(what: string): MultizenError {
  return new MultizenError(
    "UNSUPPORTED_ON_ENGINE",
    `${what} is not available on Camoufox in this build.`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randIn(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

function answerDialog(dialog: Dialog, type: DialogType, policy: DialogPolicy): Promise<void> {
  const accept = (policy[type] ?? DEFAULT_DIALOG_ANSWERS[type]) === "accept";
  const answered = accept
    ? dialog.accept(type === "prompt" ? policy.promptText : undefined)
    : dialog.dismiss();
  return answered.catch(() => {
    // The dialog may already be gone (navigated away / page closed).
  });
}

function readDocument(locator: Locator): Promise<string> {
  return locator
    .evaluate(DOCUMENT_ID, undefined, { timeout: DOCUMENT_READ_TIMEOUT_MS })
    .then(String);
}

/**
 * The document in each frame a snapshot covers, read through one element of that frame.
 * A frame that can't answer gets a value nothing will ever match: its refs are then
 * stale from the start, which is right for a frame navigating away under the snapshot.
 */
async function documentsOf(page: Page, refs: readonly string[]): Promise<Map<string, string>> {
  const firstOfFrame = new Map<string, string>();
  for (const ref of refs) {
    if (!firstOfFrame.has(frameOfRef(ref))) firstOfFrame.set(frameOfRef(ref), ref);
  }
  const documents = new Map<string, string>();
  await Promise.all(
    [...firstOfFrame].map(async ([frame, ref]) => {
      const document = await readDocument(page.locator(`aria-ref=${ref}`)).catch(() => randomUUID());
      documents.set(frame, document);
    }),
  );
  return documents;
}

/** A frame that went away fails the query itself instead of matching nothing. */
async function resolvedCount(locator: Locator): Promise<number> {
  return locator.count().catch((e: unknown) => {
    if (/Invalid frame in aria-ref selector/.test(errorText(e))) return 0;
    throw e;
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Playwright's message without its call log, and without the name of the method. */
function briefly(e: unknown): string {
  const first = errorText(e).split("\n")[0] ?? "";
  return first.replace(/^[A-Za-z]+\.[A-Za-z]+: /, "");
}

function staleRef(ref: string): MultizenError {
  return new MultizenError(
    "STALE_REF",
    `Element ref "${ref}" is stale: its element or document is gone since extract.`,
    { hint: "Call extract and use the refs it gives." },
  );
}

function unknownRef(ref: string): MultizenError {
  return new MultizenError("ELEMENT_NOT_FOUND", `Unknown element ref "${ref}".`, {
    hint: "Call extract and use the refs it gives.",
  });
}

function tabNotFound(targetId: string): MultizenError {
  return new MultizenError("TAB_NOT_FOUND", `No tab with target id ${targetId}`, {
    hint: "Call list_tabs for the open tabs.",
  });
}

function notVisible(el: ResolvedElement): MultizenError {
  return new MultizenError("ELEMENT_NOT_VISIBLE", `The element for ${el.label} is not visible.`, {
    hint: "Take a screenshot to see the page, then scroll or open what hides it.",
  });
}

/** What a failing page operation means to a client. Anything else passes through as it is. */
function pageError(e: unknown): unknown {
  if (e instanceof MultizenError) return e;
  const name = (e as Error | undefined)?.name;
  if (name === "TargetClosedError") {
    return new MultizenError("TAB_NOT_FOUND", "The tab closed during this call.", {
      hint: "Call list_tabs for the open tabs.",
    });
  }
  if (name === "TimeoutError") return new MultizenError("TIMEOUT", briefly(e));
  return e;
}

/** As {@link pageError}, knowing the element: a timeout can say why it never acted. */
async function elementError(e: unknown, el: ResolvedElement): Promise<unknown> {
  if (/while parsing|Unknown engine/.test(errorText(e))) {
    return new MultizenError("INVALID_INPUT", `Invalid selector: ${el.label}`);
  }
  if (/Element is not a <select> element/.test(errorText(e))) {
    return new MultizenError("INVALID_INPUT", `${el.label} is not a <select> element`);
  }
  if ((e as Error | undefined)?.name === "TimeoutError") {
    if ((await resolvedCount(el.locator).catch(() => 1)) === 0) {
      if (el.ref) return staleRef(el.ref);
      return new MultizenError("ELEMENT_NOT_FOUND", `Element not found for ${el.label}`);
    }
    if (!(await el.locator.isVisible().catch(() => true))) return notVisible(el);
    const last = lastLogLine(e);
    return new MultizenError("TIMEOUT", `${el.label} did not take the action: ${last}`, {
      // Found ready and still not acting is what a fully covered window does on Windows.
      ...(/performing .* action/.test(last)
        ? { hint: "If the browser window is covered, raise it, then retry." }
        : {}),
    });
  }
  return pageError(e);
}

/** The last thing Playwright saw while waiting, usually what covers the element. */
function lastLogLine(e: unknown): string {
  const lines = errorText(e)
    // The call log comes with terminal colors.
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1)?.replace(/^- /, "") ?? "";
}

/** A load that fails. A URL that serves a file ends this way too, having started a download. */
function navigationError(url: string, e: unknown): unknown {
  if ((e as Error | undefined)?.name === "TimeoutError") {
    return new MultizenError("TIMEOUT", `Navigation to ${url} timed out: ${briefly(e)}`);
  }
  const text = briefly(e);
  return new MultizenError("NAVIGATION_FAILED", `Navigation to ${url} failed: ${text}`, {
    details: { error_text: text },
    ...(/Download is starting/.test(text)
      ? { hint: "If this URL serves a file, list_downloads shows it." }
      : {}),
  });
}

function keyError(key: string, e: unknown): unknown {
  if (/Unknown key/.test(errorText(e))) {
    return new MultizenError("INVALID_INPUT", `Can't press "${key}": ${briefly(e)}`);
  }
  return pageError(e);
}
