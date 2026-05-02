import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProfileManager,
  exportProfile,
  importProfile,
} from "@multizen/profile-manager";
import {
  HttpTransport,
  createMultizenMcpServer,
  type ActivityEvent,
  type ActivityLog,
} from "@multizen/mcp-server";
import { SettingsStore, defaultSettingsPath, type AppSettings } from "@multizen/settings-store";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let profileManager: ProfileManager;
let browserDriver: ChromiumBrowserDriver;
let activityLog: ActivityLog;
let settingsStore: SettingsStore;
let httpTransport: HttpTransport | null = null;
let cachedSettings: AppSettings | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0f",
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

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const dataRoot = join(userData, "data");

  settingsStore = new SettingsStore(defaultSettingsPath(userData));
  cachedSettings = await settingsStore.load();

  profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  browserDriver = new ChromiumBrowserDriver({ profileManager });

  const mcp = createMultizenMcpServer({ profileManager, browserDriver });
  activityLog = mcp.activityLog;

  // Forward activity events to renderer
  activityLog.on("event", (e: ActivityEvent) => {
    mainWindow?.webContents.send("activity:event", e);
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
