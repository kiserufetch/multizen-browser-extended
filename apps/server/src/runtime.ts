import { ActivityLog, createSharedMcpState, type SharedMcpState } from "@multizen/mcp-server";
import { ProfileManager } from "@multizen/profile-manager";
import { defaultSettingsPath, SettingsStore } from "@multizen/settings-store";
import type { BrowserEngine, ChromiumStatus, ProfileId } from "@multizen/types";
import {
  ChromiumBrowserDriver,
  EngineRegistry,
  EngineRouter,
  randomFreePort,
  stopAllBridges,
  sweepOrphans,
} from "@multizen/browser-runtime";
import pkg from "../package.json" with { type: "json" };
import { dataPaths, type ServerConfig } from "./config.ts";
import { errorFields, log } from "./log.ts";
import { createNodeHost } from "./nodeHost.ts";
import { withinBudget } from "./shutdown.ts";

export const SERVER_VERSION: string = pkg.version;

/** Software GL in a container makes the first page slower than on a desktop. */
const READINESS_BUDGET_MS = 30_000;
/** Longer than a graceful close plus taskkill and the orphan post-check. */
const CLOSE_ALL_BUDGET_MS = 11_000;
const ENGINE_PROGRESS_INTERVAL_MS = 5_000;
const BROWSER_STDERR_MAX_CHARS = 4_000;

/**
 * Playwright's default handlers call process.exit(130) on SIGINT, cutting the
 * graceful shutdown short; only this process decides when to exit.
 */
export const SERVER_FIREFOX_OPTIONS = {
  launchExtras: { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false },
} as const;

/**
 * On Windows, Chromium reports a window as hidden when it is fully covered or the
 * display is off, and a page that loads hidden never paints and drops all input.
 * Measured on the bare engine: ["hidden", 0 paints] without this, ["visible", 2]
 * with it, and Page.bringToFront doesn't help (docs/input-delivery-hidden-page.md).
 * A desktop user can raise the window. A server has nobody watching its windows, so
 * its pages must not depend on them.
 */
export function serverDisabledFeatures(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["CalculateNativeWinOcclusion"] : [];
}

/**
 * The same for Camoufox on Windows. A covered window still reads as visible there, but
 * takes no input. Measured on the bare engine: a click hangs at "performing click
 * action" without this, and takes 100 ms with it.
 */
export function serverFirefoxPrefs(platform: NodeJS.Platform): Record<string, boolean> {
  return platform === "win32" ? { "widget.windows.window_occlusion_tracking.enabled": false } : {};
}

/** A row points at a directory the server can't find under its own data dir. */
export class DataDirMismatchError extends Error {}

/** Deleting a profile can orphan shared extension store entries. Overriding here
 *  covers every caller, the MCP tool included, with no seam in `server.ts`. */
class ServerProfileManager extends ProfileManager {
  private readonly extensionStoreRoot: string;

  constructor(opts: { dbPath: string; profilesRoot: string; extensionStoreRoot: string }) {
    super(opts);
    this.extensionStoreRoot = opts.extensionStoreRoot;
  }

  override delete(id: ProfileId): void {
    super.delete(id);
    sweepExtensionStore(this, this.extensionStoreRoot);
  }
}

function sweepExtensionStore(profileManager: ProfileManager, extensionStoreRoot: string): void {
  sweepOrphans(
    extensionStoreRoot,
    profileManager.allExtensionRefs().map((r) => r.ext),
  )
    .then((res) => {
      if (res.removed > 0) log.info("extension store swept", { removed: res.removed });
    })
    .catch((e: unknown) => log.warn("extension store sweep failed", errorFields(e)));
}

/**
 * Opens the database and rebases rows left outside this data dir (a moved data
 * dir, a copied database). A row that can't be rebased refuses the start: launching
 * it would open an empty directory, logged out, with no error.
 */
export function openProfiles(dataDir: string): ProfileManager {
  const { dbPath, profilesRoot, extensionStoreRoot } = dataPaths(dataDir);
  const profileManager = new ServerProfileManager({ dbPath, profilesRoot, extensionStoreRoot });
  const { rebased, unresolved } = profileManager.reconcileDataDirs();
  if (unresolved.length > 0) {
    profileManager.close();
    const rows = unresolved
      .map((r) => `  ${r.id} ("${r.name}"): stored ${r.dataDir}, not found at ${r.expected}`)
      .join("\n");
    throw new DataDirMismatchError(
      `${unresolved.length} profile(s) in ${dbPath} point outside ${profilesRoot}, ` +
        `with no directory for them there:\n${rows}\n` +
        "Move each profile's directory to the path shown, or run with the data directory they were created in.",
    );
  }
  if (rebased.length > 0) log.info("profile data dirs rebased", { profiles: rebased, profilesRoot });
  return profileManager;
}

/** Logs engine download progress at most every few seconds, other changes at once. */
export function engineProgressLogger(
  sink: Pick<typeof log, "info" | "error"> = log,
  now: () => number = Date.now,
  intervalMs = ENGINE_PROGRESS_INTERVAL_MS,
): (engine: BrowserEngine, status: ChromiumStatus) => void {
  const lastLogged = new Map<BrowserEngine, number>();
  return (engine, status) => {
    if (status.kind === "error") {
      sink.error("engine status", { engine, status: status.kind, error: status.message });
      return;
    }
    if (status.kind !== "downloading") {
      lastLogged.delete(engine);
      sink.info("engine status", {
        engine,
        status: status.kind,
        ...("version" in status ? { version: status.version } : {}),
      });
      return;
    }
    const last = lastLogged.get(engine);
    if (last !== undefined && now() - last < intervalMs) return;
    lastLogged.set(engine, now());
    sink.info("engine status", {
      engine,
      status: status.kind,
      version: status.version,
      bytesReceived: status.bytesReceived,
      bytesTotal: status.bytesTotal,
    });
  };
}

export interface ServerRuntime {
  profileManager: ProfileManager;
  settings: SettingsStore;
  engineRegistry: EngineRegistry;
  driver: EngineRouter;
  activityLog: ActivityLog;
  /** State every MCP session shares. */
  shared: SharedMcpState;
  getDefaultEngine: () => BrowserEngine;
  /**
   * Starts fetching the default engine in the background, so a first run's
   * download shows progress before anyone asks. Launches wait on their own
   * ensure(), which joins this one.
   */
  startEngineBootstrap(): void;
  /** Closes browsers, bridges and the database. Idempotent. */
  close(opts?: { gracefulMs?: number; reap?: boolean }): Promise<void>;
}

/**
 * The browser runtime as the server runs it. Compared with the desktop's startup
 * this leaves out, on purpose: EngineUpdateService (the version stays pinned, so a
 * UA can't change mid-work), UpdaterService, UsageReporting, backfillProxyCountries
 * and the companion extension. The caller must already hold the data dir's lock.
 */
export async function buildRuntime(
  cfg: Pick<ServerConfig, "dataDir" | "defaultEngine" | "maxBrowsers" | "browserQueueTimeoutMs">,
): Promise<ServerRuntime> {
  const { extensionStoreRoot } = dataPaths(cfg.dataDir);
  const settings = new SettingsStore(defaultSettingsPath(cfg.dataDir));
  const initialSettings = await settings.load();
  const getDefaultEngine = (): BrowserEngine => cfg.defaultEngine ?? initialSettings.browserEngine;

  const profileManager = openProfiles(cfg.dataDir);
  sweepExtensionStore(profileManager, extensionStoreRoot);

  const host = createNodeHost(cfg.dataDir);
  const engineRegistry = new EngineRegistry(host);
  engineRegistry.on("status", engineProgressLogger());

  const chromiumDriver = new ChromiumBrowserDriver({
    host,
    profileManager,
    engineRegistry,
    getDefaultEngine,
    extensionStoreRoot,
    readinessBudgetMs: READINESS_BUDGET_MS,
    allocatePort: () => randomFreePort(),
    extraDisabledFeatures: serverDisabledFeatures(process.platform),
    armDownloadsAtLaunch: true,
    onBrowserStderr: (pid, text) =>
      log.debug("browser stderr", { pid, text: text.slice(0, BROWSER_STDERR_MAX_CHARS) }),
  });
  const driver = new EngineRouter({
    profileManager,
    engineRegistry,
    getDefaultEngine,
    chromiumDriver,
    firefoxOptions: { ...SERVER_FIREFOX_OPTIONS, extraPrefs: serverFirefoxPrefs(process.platform) },
    engineNotReady: "reject",
    maxBrowsers: cfg.maxBrowsers,
    browserQueueTimeoutMs: cfg.browserQueueTimeoutMs,
  });
  driver.on("running-changed", (change) => log.info("profile state", { ...change }));

  const activityLog = new ActivityLog();
  // Never the arguments or a successful result: those can hold cookies or page text.
  activityLog.on("event", (e) => {
    if (e.status === "pending") return;
    log.info("tool call", {
      tool: e.tool,
      status: e.status,
      durationMs: e.durationMs,
      profileId: e.profileId,
      ...(e.status === "error" ? { error: e.summary } : {}),
    });
  });

  const startEngineBootstrap = (): void => {
    const engine = getDefaultEngine();
    void engineRegistry
      .ensure(engine)
      .catch((e: unknown) => log.error("engine bootstrap failed", { engine, ...errorFields(e) }));
  };

  let closing: Promise<void> | null = null;
  const close = (opts: { gracefulMs?: number; reap?: boolean } = {}): Promise<void> => {
    closing ??= (async () => {
      try {
        if (!(await withinBudget(driver.closeAll(opts), CLOSE_ALL_BUDGET_MS))) {
          log.warn("closing browsers overran its budget", { budgetMs: CLOSE_ALL_BUDGET_MS });
        }
      } finally {
        await stopAllBridges();
        profileManager.close();
      }
    })();
    return closing;
  };

  return {
    profileManager,
    settings,
    engineRegistry,
    driver,
    activityLog,
    shared: createSharedMcpState(),
    getDefaultEngine,
    startEngineBootstrap,
    close,
  };
}
