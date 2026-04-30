import { spawn, type ChildProcess } from "node:child_process";
import { app } from "electron";
import { join } from "node:path";
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";
import { CdpSession, AnthropicResolver, type NaturalLanguageResolver } from "@multizen/cdp-driver";

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
}

export interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
  /** Returns the resolver fresh on each call so settings updates take effect */
  getResolver: () => NaturalLanguageResolver | undefined;
}

/**
 * Real driver: spawns Chromium per profile with --user-data-dir + --remote-debugging-port,
 * connects to its CDP endpoint, and routes navigate / click / type / extract / screenshot
 * through the CdpSession.
 *
 * In production builds the binary is the patched anti-detect Chromium shipped from
 * the closed fingerprint engine. In dev we fall back to system Chrome.
 */
export class ChromiumBrowserDriver implements BrowserDriver {
  private readonly running = new Map<ProfileId, RunningProcess>();
  private nextPort = 9222;
  private readonly profileManager: ProfileManager;
  private readonly getResolver: () => NaturalLanguageResolver | undefined;

  constructor(opts: ChromiumBrowserDriverOptions) {
    this.profileManager = opts.profileManager;
    this.getResolver = opts.getResolver;
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

    const port = this.allocatePort();
    const chromiumPath = resolveChromiumPath();
    const args = [
      `--user-data-dir=${profile.dataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      `--lang=${profile.fingerprint.locale}`,
    ];
    if (profile.proxy) {
      args.push(`--proxy-server=${profile.proxy.host}:${profile.proxy.port}`);
    }
    if (profile.fingerprint.userAgent) {
      args.push(`--user-agent=${profile.fingerprint.userAgent}`);
    }
    if (profile.fingerprint.screen) {
      args.push(
        `--window-size=${profile.fingerprint.screen.width},${profile.fingerprint.screen.height}`,
      );
    }

    const child = spawn(chromiumPath, args, {
      detached: false,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Failed to spawn Chromium");

    const startedAt = new Date().toISOString();
    const cdpEndpoint = `http://127.0.0.1:${port}`;

    const session = new CdpSession({ port, resolver: this.getResolver() });
    // Wait for CDP to come up before declaring success
    await waitForCdpReady(port, 10000);
    await session.connect();

    const record: RunningProcess = {
      child,
      cdpEndpoint,
      port,
      pid: child.pid,
      startedAt,
      session,
    };
    this.running.set(profileId, record);

    child.on("exit", () => {
      void session.close().catch(() => {});
      this.running.delete(profileId);
    });

    return { id: profileId, cdpEndpoint, pid: child.pid, startedAt };
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    await r.session.close().catch(() => {});
    r.child.kill();
    this.running.delete(profileId);
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const session = this.requireSession(profileId);
    const result = await session.navigate(url);
    return { url: result.url };
  }

  async click(profileId: ProfileId, target: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.click(target);
    return { ok: true };
  }

  async type(profileId: ProfileId, target: string, text: string): Promise<{ ok: true }> {
    const session = this.requireSession(profileId);
    await session.type(target, text);
    return { ok: true };
  }

  async extract(profileId: ProfileId, query: string): Promise<{ result: unknown }> {
    const session = this.requireSession(profileId);
    return session.extract(query);
  }

  async screenshot(profileId: ProfileId): Promise<{ pngBase64: string }> {
    const session = this.requireSession(profileId);
    return session.screenshot();
  }

  async closeAll(): Promise<void> {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private requireSession(profileId: ProfileId): CdpSession {
    const r = this.running.get(profileId);
    if (!r) throw new Error(`Profile ${profileId} is not running`);
    return r.session;
  }

  private allocatePort(): number {
    return this.nextPort++;
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
  if (process.platform === "darwin")
    return "MultiZen Chromium.app/Contents/MacOS/MultiZen Chromium";
  if (process.platform === "win32") return "chromium.exe";
  return "chromium";
}

async function waitForCdpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await sleep(150);
  }
  throw new Error(`CDP did not become ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
