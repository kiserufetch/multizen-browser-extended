import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@multizen/profile-manager";
import { startMcpServer } from "./mcp.ts";
import { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

let mainWindow: BrowserWindow | null = null;
let profileManager: ProfileManager;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0f",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  const dataRoot = join(app.getPath("userData"), "data");
  profileManager = new ProfileManager({
    dbPath: join(dataRoot, "profiles.db"),
    profilesRoot: join(dataRoot, "profiles"),
  });

  const browserDriver = new ChromiumBrowserDriver({
    profileManager,
  });

  // Start embedded MCP server on localhost (not stdio — desktop mode uses HTTP/SSE)
  await startMcpServer({ profileManager, browserDriver });

  // IPC for renderer to talk to profile manager
  ipcMain.handle("profiles:list", () => profileManager.list());
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
    profileManager.delete(id);
  });
  ipcMain.handle("profiles:launch", (_e, id: string) => browserDriver.launch(id));
  ipcMain.handle("profiles:close", (_e, id: string) => browserDriver.close(id));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  profileManager?.close();
});
