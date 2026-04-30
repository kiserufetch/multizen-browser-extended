import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import { join } from "node:path";
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
}

interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
}

/**
 * Real driver: spawns patched Chromium per profile with --user-data-dir
 * and --remote-debugging-port. The Chromium binary ships from the closed
 * fingerprint engine (loaded at packaging time) and falls back to system
 * Chrome in dev.
 *
 * v0.2-pre: skeleton. Discovery of patched Chromium binary, port allocation,
 * and CDP-based navigate/click/extract come in subsequent commits.
 */
export class ChromiumBrowserDriver implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningProcess>();
  private nextPort = 9222;
  private readonly profileManager: ProfileManager;

  constructor(opts: ChromiumBrowserDriverOptions) {
    this.profileManager = opts.profileManager;
  }

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: existing.cdpEndpoint,
        pid: existing.pid,
        startedAt: existing.startedAt,
      };
    }

    const profile = this.profileManager.get(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const port = this.nextPort++;
    const chromiumPath = resolveChromiumPath();
    const args = [
      `--user-data-dir=${profile.dataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--lang=${profile.fingerprint.locale}`,
    ];
    if (profile.proxy) {
      args.push(`--proxy-server=${profile.proxy.host}:${profile.proxy.port}`);
    }
    if (profile.fingerprint.userAgent) {
      args.push(`--user-agent=${profile.fingerprint.userAgent}`);
    }

    const child = spawn(chromiumPath, args, {
      detached: false,
      stdio: "ignore",
    });

    if (!child.pid) {
      throw new Error("Failed to spawn Chromium");
    }

    const startedAt = new Date().toISOString();
    const cdpEndpoint = `ws://localhost:${port}`;
    this.running.set(profileId, { child, cdpEndpoint, pid: child.pid, startedAt });

    child.on("exit", () => {
      this.running.delete(profileId);
    });

    return { id: profileId, cdpEndpoint, pid: child.pid, startedAt };
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    r.child.kill();
    this.running.delete(profileId);
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(_profileId: ProfileId, url: string): Promise<{ url: string }> {
    // TODO(v0.2): connect to CDP and call Page.navigate
    return { url };
  }

  async click(_profileId: ProfileId, _target: string): Promise<{ ok: true }> {
    // TODO(v0.2): CSS selector or accessibility-tree lookup, then Input.dispatchMouseEvent
    return { ok: true };
  }

  async type(
    _profileId: ProfileId,
    _target: string,
    _text: string,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async extract(
    _profileId: ProfileId,
    query: string,
  ): Promise<{ result: unknown }> {
    return { result: { todo: "CDP extract not implemented yet", query } };
  }

  async screenshot(_profileId: ProfileId): Promise<{ pngBase64: string }> {
    return { pngBase64: "" };
  }
}

function resolveChromiumPath(): string {
  // Production: bundled patched Chromium under app resources
  if (app.isPackaged) {
    return join(process.resourcesPath, "chromium", platformBinary());
  }
  // Dev: prefer system Chrome / Chromium
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  return "google-chrome";
}

function platformBinary(): string {
  if (process.platform === "darwin") return "MultiZen Chromium.app/Contents/MacOS/MultiZen Chromium";
  if (process.platform === "win32") return "chromium.exe";
  return "chromium";
}
