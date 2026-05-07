import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  ProfileManager,
  exportProfile,
  importProfile,
  generateFingerprint,
  reconcileFingerprint,
  deviceCatalog,
  localeCatalog,
} from "@multizen/profile-manager";
import {
  HttpTransport,
  createMultizenMcpServer,
  type ActivityEvent,
  type ActivityLog,
} from "@multizen/mcp-server";
import { SettingsStore, defaultSettingsPath, type AppSettings } from "@multizen/settings-store";
import type { ChromiumStatus, ProxyConfig } from "@multizen/types";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import { ChromiumBootstrap } from "./ChromiumBootstrap.ts";
import { probeProxyGeo, type ProxyGeoResult } from "./proxyGeo.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Resolve the master 1024×1024 brand icon. In packaged builds Electron picks
 * the bundled icon based on platform (.icns on Mac, the .ico/.png on Win/Linux).
 * In dev we fall back to the source PNG so the dock / taskbar / window icons
 * are not the default Electron logo.
 */
function resolveAppIcon(): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "icon.png"),
        join(process.resourcesPath, "..", "icon.png"),
      ]
    : [
        join(__dirname, "../../../../build/icon.png"),
        join(__dirname, "../../../build/icon.png"),
        join(__dirname, "../../build/icon.png"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

let mainWindow: BrowserWindow | null = null;
let profileManager: ProfileManager;
let browserDriver: ChromiumBrowserDriver;
let chromiumBootstrap: ChromiumBootstrap;
let activityLog: ActivityLog;
let settingsStore: SettingsStore;
let httpTransport: HttpTransport | null = null;
let cachedSettings: AppSettings | null = null;

function createWindow(): void {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0b0f",
    icon: iconPath ?? undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
    process.stderr.write(`Renderer failed to load (${code} ${description}): ${url}\n`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`Renderer process gone: ${JSON.stringify(details)}\n`);
  });
}

// Name must be set BEFORE app.whenReady() so the dock and menu bar pick
// it up — otherwise macOS shows "Electron" until app fully loads.
app.setName("MultiZen");
app.setAboutPanelOptions({
  applicationName: "MultiZen",
  applicationVersion: app.getVersion(),
});

app.whenReady().then(async () => {
  // macOS: explicitly set the dock icon. In packaged .app bundles macOS
  // picks the .icns automatically, but in dev (running ./node_modules/.bin/electron)
  // the dock shows the generic Electron icon unless we override it here.
  if (process.platform === "darwin" && !app.isPackaged) {
    const iconPath = resolveAppIcon();
    if (iconPath) {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock?.setIcon(img);
    }
  }

  const userData = app.getPath("userData");
  const dataRoot = join(userData, "data");

  settingsStore = new SettingsStore(defaultSettingsPath(userData));
  cachedSettings = await settingsStore.load();

  profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  // Chromium bootstrap — checks for the patched Chromium binary, downloads
  // it from our CDN on first run, and reports progress to the renderer.
  // In dev (not packaged) it short-circuits to system Chrome.
  chromiumBootstrap = new ChromiumBootstrap();
  chromiumBootstrap.on("status", (status: ChromiumStatus) => {
    mainWindow?.webContents.send("chromium:status", status);
  });
  // Kick off the ensure() in the background so the UI can render immediately
  // and show download progress. Profile launches will wait until ready.
  void chromiumBootstrap.ensure().catch((e) => {
    process.stderr.write(`Chromium bootstrap failed: ${String(e)}\n`);
  });

  browserDriver = new ChromiumBrowserDriver({ profileManager, chromiumBootstrap });

  const mcp = createMultizenMcpServer({ profileManager, browserDriver });
  activityLog = mcp.activityLog;

  // Forward activity events to renderer
  activityLog.on("event", (e: ActivityEvent) => {
    mainWindow?.webContents.send("activity:event", e);
  });

  // Forward profile running-state changes (manual launch, manual close,
  // and — most importantly — external Chromium close where the user quits
  // the browser window directly).
  browserDriver.on("running-changed", (change) => {
    mainWindow?.webContents.send("profiles:running-changed", change);
  });

  // Optional embedded HTTP+SSE transport so external Cursor/Claude can connect
  if (cachedSettings.mcpHttpEnabled) {
    try {
      httpTransport = new HttpTransport({ port: cachedSettings.mcpHttpPort });
      await httpTransport.start(mcp.server);
    } catch (e) {
      // Port collision is non-fatal — log and continue
      process.stderr.write(`MCP HTTP transport failed to start: ${String(e)}\n`);
      httpTransport = null;
    }
  }

  // Profile IPC
  ipcMain.handle("profiles:list", () =>
    profileManager.list().map((p) => ({ ...p, isRunning: browserDriver.isRunning(p.id) })),
  );
  ipcMain.handle("profiles:get", (_e, id: string) => profileManager.get(id));
  ipcMain.handle("profiles:create", (_e, input: Parameters<ProfileManager["create"]>[0]) =>
    profileManager.create(input),
  );
  ipcMain.handle(
    "profiles:update",
    (_e, id: string, patch: Parameters<ProfileManager["update"]>[1]) =>
      profileManager.update(id, patch),
  );
  ipcMain.handle("profiles:delete", (_e, id: string) => {
    void browserDriver.close(id).catch(() => {});
    profileManager.delete(id);
  });
  ipcMain.handle("profiles:launch", (_e, id: string) => browserDriver.launch(id));
  ipcMain.handle("profiles:close", (_e, id: string) => browserDriver.close(id));

  // Settings IPC
  ipcMain.handle("settings:get", () => settingsStore.load());
  ipcMain.handle("settings:update", async (_e, patch: Partial<AppSettings>) => {
    cachedSettings = await settingsStore.update(patch);
    return cachedSettings;
  });

  // Activity IPC
  ipcMain.handle("activity:recent", () => activityLog.recent());

  // Chromium bootstrap IPC
  ipcMain.handle("chromium:status", () => chromiumBootstrap.getStatus());
  ipcMain.handle("chromium:retry", () => chromiumBootstrap.ensure());

  // Fingerprint generator IPC — called from create + edit forms when the
  // user hits Regen. Returns a fresh, internally-consistent preset.
  ipcMain.handle("fingerprint:generate", () => generateFingerprint());
  ipcMain.handle("fingerprint:devices", () => deviceCatalog());
  ipcMain.handle("fingerprint:locales", () => localeCatalog());
  ipcMain.handle(
    "fingerprint:reconcile",
    (
      _e,
      current: Parameters<typeof reconcileFingerprint>[0],
      patch: Parameters<typeof reconcileFingerprint>[1],
    ) => reconcileFingerprint(current, patch),
  );

  // Proxy geo-IP probe — verifies that the profile's locale + timezone are
  // coherent with the proxy IP's country. Detection vendors flag mismatches
  // like "Accept-Language: ru-RU + IP in US" as suspicious.
  ipcMain.handle(
    "proxy:detectGeo",
    async (
      _e,
      proxy: ProxyConfig,
    ): Promise<{ ok: true; geo: ProxyGeoResult } | { ok: false; error: string }> => {
      try {
        const geo = await probeProxyGeo(proxy);
        return { ok: true, geo };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  // Profile import / export
  ipcMain.handle(
    "profiles:export",
    async (_e, id: string, passphrase: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
      const profile = profileManager.get(id);
      if (!profile) return { ok: false, reason: "not_found" };
      const result = await dialog.showSaveDialog(mainWindow ?? undefined!, {
        title: "Export profile",
        defaultPath: `${profile.name.replace(/[^a-z0-9-_]+/gi, "_")}.mzar`,
        filters: [{ name: "MultiZen archive", extensions: ["mzar"] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, reason: "cancelled" };
      await exportProfile(profile, passphrase, result.filePath);
      return { ok: true, path: result.filePath };
    },
  );

  ipcMain.handle(
    "profiles:import",
    async (_e, passphrase: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
      const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
        title: "Import profile",
        filters: [{ name: "MultiZen archive", extensions: ["mzar"] }],
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, reason: "cancelled" };
      }
      const archivePath = result.filePaths[0];
      if (!archivePath) return { ok: false, reason: "cancelled" };
      try {
        const restored = await importProfile(archivePath, passphrase, join(dataRoot, "profiles"));
        // Re-insert into DB. ProfileManager.create generates new id; here we want to preserve id.
        // For now we treat import as create-with-known-id: skip if id collision.
        if (profileManager.get(restored.id)) {
          return { ok: false, reason: "already_exists" };
        }
        // Quick path: insert via raw create then update to inherit id-bound dataDir
        const inserted = profileManager.create({
          name: restored.name,
          notes: restored.notes,
          tags: restored.tags,
          proxy: restored.proxy,
          fingerprint: restored.fingerprint,
        });
        return { ok: true, id: inserted.id };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  );

  // System info
  ipcMain.handle("system:info", () => ({
    mcpHttpUrl: httpTransport ? `http://127.0.0.1:${cachedSettings?.mcpHttpPort}` : null,
    appVersion: app.getVersion(),
    platform: process.platform,
  }));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (e) => {
  e.preventDefault();
  try {
    await browserDriver?.closeAll();
    await httpTransport?.stop();
    profileManager?.close();
  } finally {
    app.exit(0);
  }
});
