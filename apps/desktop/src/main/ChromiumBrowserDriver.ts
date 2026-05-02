import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { app } from "electron";
import { join } from "node:path";
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type { LaunchedProfile, ProfileId } from "@multizen/types";
import { CdpSession } from "@multizen/cdp-driver";

interface RunningProcess {
  child: ChildProcess;
  cdpEndpoint: string;
  port: number;
  pid: number;
  startedAt: string;
  session: CdpSession;
  /** Polls /json/list and kills the child when no page targets remain. */
  windowWatcher: NodeJS.Timeout;
}

export interface ChromiumBrowserDriverOptions {
  profileManager: ProfileManager;
}

export type RunningStateChange =
  | { kind: "launched"; profileId: ProfileId }
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
  private nextPort = 9222;
  private readonly profileManager: ProfileManager;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
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

    const session = new CdpSession({ port });
    await waitForCdpReady(port, 10000);
    await session.connect();

    // Watch for "no more page targets" via CDP. On macOS Chrome stays alive
    // after the last window closes (standard Mac app lifecycle) — the spawned
    // process keeps running with zero windows. We poll /json/list and force-
    // kill the child when that happens, which then fires child.on('exit') and
    // emits the running-changed event.
    let zeroSinceMs: number | null = null;
    const windowWatcher = setInterval(async () => {
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
            r.child.kill();
          }
        } else {
          zeroSinceMs = null;
        }
      } catch {
        // CDP unreachable — process likely already dying. exit handler will
        // clean up.
      }
    }, 1000);

    const record: RunningProcess = {
      child,
      cdpEndpoint,
      port,
      pid: child.pid,
      startedAt,
      session,
      windowWatcher,
    };
    const r = record;
    this.running.set(profileId, record);

    child.on("exit", () => {
      const wasTracked = this.running.has(profileId);
      clearInterval(record.windowWatcher);
      void session.close().catch(() => {});
      this.running.delete(profileId);
      if (wasTracked) {
        // close() removes from the map first so wasTracked is false there;
        // this path covers (a) user quit Chrome directly with ⌘Q, and (b)
        // our own kill() from the windowWatcher when the last window closed.
        this.emit("running-changed", { kind: "closed", profileId, reason: "external-exit" });
      }
    });

    this.emit("running-changed", { kind: "launched", profileId });
    return { id: profileId, cdpEndpoint, pid: child.pid, startedAt };
  }

  async close(profileId: ProfileId): Promise<void> {
    const r = this.running.get(profileId);
    if (!r) return;
    // Remove from map first so the child.on('exit') handler treats this as
    // a planned close (no event emitted from there).
    this.running.delete(profileId);
    clearInterval(r.windowWatcher);
    await r.session.close().catch(() => {});
    r.child.kill();
    this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const session = this.requireSession(profileId);
    const result = await session.navigate(url);
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

  async extract(profileId: ProfileId): Promise<{ result: unknown }> {
    const session = this.requireSession(profileId);
    return session.extract();
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
  if (app.isPackaged) {
    return join(process.resourcesPath, "chromium", platformBinary());
  }
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
