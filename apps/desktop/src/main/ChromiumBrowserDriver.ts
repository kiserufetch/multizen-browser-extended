import { app } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
import type { BrowserDriver } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import { reconcileDeviceFamilyToHost } from "@multizen/profile-manager";
import type {
  ClientHints,
  FingerprintConfig,
  LaunchedProfile,
  ProfileId,
} from "@multizen/types";
import { CdpSession } from "@multizen/cdp-driver";
import type { ChromiumBootstrap } from "./ChromiumBootstrap";
import { anonymizeForProfile, releaseForProfile } from "./proxyAnonymizer";
import { probeProxyGeo } from "./proxyGeo";

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
  chromiumBootstrap: ChromiumBootstrap;
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
  private readonly bootstrap: ChromiumBootstrap;

  constructor(opts: ChromiumBrowserDriverOptions) {
    super();
    this.profileManager = opts.profileManager;
    this.bootstrap = opts.chromiumBootstrap;
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
    const chromiumPath = this.bootstrap.resolveBinaryPath();
    // Read the actual Chromium binary's version and reconcile the
    // profile's spoofed UA against it. Detection vendors fingerprint the
    // JS engine and compare against the claimed UA — claiming Chrome
    // 148 while running 147 is an instant flag.
    const actualVersion = await detectChromiumVersion(chromiumPath);
    // Reconcile (1) device family to host OS (claiming Win on a Mac
    //   binary is detected via V8/CSS feature signatures), then
    //   (2) Chrome version to the actual binary version. Both run
    //   on every launch so legacy profiles auto-fix.
    let fp = reconcileDeviceFamilyToHost(profile.fingerprint);
    if (actualVersion) fp = reconcileVersionInFingerprint(fp, actualVersion);

    // Make Chromium reopen last-session tabs on every launch — what
    // Multilogin / AdsPower / GoLogin do by default. The setting is
    // `session.restore_on_startup = 1` in the Default profile's
    // Preferences JSON. We mutate it before spawn (Chrome must be off
    // to avoid corruption).
    await ensureSessionRestore(profile.dataDir).catch((e: unknown) => {
      console.warn(
        "[multizen] failed to write session restore preference:",
        (e as Error).message,
      );
    });

    // Best-effort: suppress CFT's "is only for automated testing" infobar
    // via the macOS managed-preference. Idempotent — only prompts for
    // admin if the plist doesn't already exist or doesn't have the key.
    if (process.platform === "darwin") {
      await ensureCftInfobarSuppressed().catch((e: unknown) => {
        console.warn(
          "[multizen] failed to suppress CFT infobar (continuing):",
          (e as Error).message,
        );
      });
    }
    // Chromium's --accept-lang flag expects a PLAIN comma-separated list
    // of language tags ("en-US,en"). It then computes q-values itself for
    // the HTTP Accept-Language header AND for `navigator.languages`. If
    // we pass a pre-formatted string with q-values ("en-US,en;q=0.9"),
    // Chromium parses it as ["en-US", "en;q=0.9"] and then re-adds q's,
    // producing the malformed "en-US,en;q=0.9;q=0.9" we saw on browserscan.
    const acceptLangPlain = fp.languages.join(",");
    const args = [
      `--user-data-dir=${profile.dataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Suppresses Chrome for Testing's "this build is for automated
      // testing only" infobar. Verified via chromium source:
      //   chrome/browser/ui/startup/infobar_utils.cc:
      //     if (!IsGpuTest()) ChromeForTestingInfoBarDelegate::Create();
      // IsGpuTest() returns true ONLY when --test-type=gpu (exact value).
      // We previously tried --test-type without a value — that doesn't
      // satisfy IsGpuTest() and the infobar still shows.
      "--test-type=gpu",
      "--disable-features=Translate,MediaRouter",
      // UI language for the Chromium chrome itself
      `--lang=${fp.locale}`,
      // Accept-Language: plain list, Chromium adds q-values.
      `--accept-lang=${acceptLangPlain}`,
      // User-Agent (legacy header + navigator.userAgent)
      `--user-agent=${fp.userAgent}`,
      // Initial window size
      `--window-size=${fp.screen.width},${fp.screen.height}`,
    ];
    if (profile.proxy) {
      // Chromium's --proxy-server= does NOT accept embedded credentials.
      // For authenticated proxies we'd otherwise see a "Sign in" dialog
      // on every navigation. anonymizeForProfile spins up a local HTTP
      // relay that forwards to the upstream with creds; Chromium sees a
      // credential-less localhost proxy.
      const localProxyUrl = await anonymizeForProfile(profileId, profile.proxy);
      args.push(`--proxy-server=${localProxyUrl}`);
      // WebRTC leaks the *real* public IP via STUN even when HTTP traffic
      // is proxied — STUN uses UDP and bypasses HTTP proxies by default.
      // `disable_non_proxied_udp` forces WebRTC to either go through a
      // SOCKS proxy that supports UDP, or fall back to TCP through the
      // configured proxy. Without this flag, browserscan / browserleaks /
      // ipleak.net all show the user's real IP next to the proxy IP.
      // Only set when a proxy is configured — direct profiles intentionally
      // expose their real IP.
      args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
      args.push("--enforce-webrtc-ip-permission-check");
    }

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

    // Apply per-target emulation: timezone, locale, Sec-CH-UA via
    // userAgentMetadata (works on stock Chromium — no patches needed!),
    // plus a WebRTC handler when a proxy is configured. Runs on the
    // root tab + every existing tab + every future tab.
    //
    // Order matters: WebRTC injection goes FIRST so that even if
    // Emulation commands fail, the IP leak is already plugged.
    const useProxy = !!profile.proxy;

    // Probe the proxy's public IP so we can spoof WebRTC ICE candidates
    // to match it (the convincing fingerprint pattern: VPN user with
    // WebRTC enabled, candidates pointing to the egress IP). If the
    // probe fails (proxy down, ipapi blocked) we fall back to disabling
    // RTCPeerConnection entirely — less stealthy but still leak-proof.
    let webrtcScript = WEBRTC_BLOCK_SCRIPT;
    if (useProxy && profile.proxy) {
      try {
        const geo = await probeProxyGeo(profile.proxy, { timeoutMs: 4000 });
        webrtcScript = buildWebRtcSpoofScript(geo.ip);
        // Align the profile's timezone with the proxy's actual geo so
        // browserscan-style "IP timezone vs JS timezone" checks always
        // match. Without this, locale picks a random tz from its group
        // (e.g. en-US → America/Los_Angeles) while the proxy egresses
        // from New York — instant -10% flag.
        if (geo.timezone && geo.timezone !== fp.timezone) {
          console.log(
            `[multizen] aligning fingerprint timezone ${fp.timezone} → ${geo.timezone} (proxy geo)`,
          );
          fp = { ...fp, timezone: geo.timezone };
        }
      } catch (e) {
        console.warn(
          "[multizen] proxy IP probe failed; using WebRTC block fallback:",
          (e as Error).message,
        );
      }
    }
    // Unified fingerprint preload — covers everything CDP `Emulation`
    // domain doesn't (navigator.platform, hardwareConcurrency, deviceMemory,
    // WebGL UNMASKED_VENDOR/RENDERER). Always injected — coherence matters
    // even without a proxy (browserleaks.com etc. cross-checks these).
    const fingerprintScript = buildFingerprintPreloadScript(fp);
    await session
      .bootstrapTargets(async (send) => {
        // 1. WebRTC kill-switch FIRST when proxy is on. Phase 1 will
        //    replace with proxy-IP candidate spoofing (see PATCHED_CHROMIUM).
        if (useProxy) {
          try {
            await send("Page.addScriptToEvaluateOnNewDocument", {
              source: webrtcScript,
            });
            await send("Runtime.evaluate", { expression: webrtcScript });
          } catch (e) {
            console.error("[multizen] WebRTC inject failed:", e);
          }
        }
        // 1b. Generic fingerprint patches (always)
        try {
          await send("Page.addScriptToEvaluateOnNewDocument", {
            source: fingerprintScript,
          });
          await send("Runtime.evaluate", { expression: fingerprintScript });
        } catch (e) {
          console.error("[multizen] fingerprint inject failed:", e);
        }
        // 1c. Screen / device metrics — sets screen.width, screen.height,
        //     window.devicePixelRatio coherently. The preload script is
        //     the primary source of these values; this is belt-and-braces
        //     for sites that read native screen.* via internal APIs.
        try {
          await send("Emulation.setDeviceMetricsOverride", {
            width: 0,
            height: 0,
            deviceScaleFactor: fp.dpr,
            mobile: false,
            screenWidth: fp.screen.width,
            screenHeight: fp.screen.height,
            screenOrientation: { type: "landscapePrimary", angle: 0 },
          });
        } catch (e) {
          // "Target does not support metrics override" fires for
          // non-page targets (workers, background pages, OOPIFs). The
          // preload script covers the JS side either way.
          const msg = (e as Error).message;
          if (!/does not support metrics override/i.test(msg)) {
            console.error("[multizen] setDeviceMetricsOverride failed:", e);
          }
        }
        // 2. Timezone — without this, JS Intl.DateTimeFormat returns the
        //    OS timezone (e.g. "America/Santiago"), which mismatches the
        //    proxy IP's timezone and instantly flags the profile.
        try {
          await send("Emulation.setTimezoneOverride", {
            timezoneId: fp.timezone,
          });
        } catch (e) {
          console.error("[multizen] setTimezoneOverride failed:", e);
        }
        // 3. Locale — overrides Intl.* locale resolution.
        try {
          await send("Emulation.setLocaleOverride", { locale: fp.locale });
        } catch (e) {
          // "Another locale override is already in effect" fires when
          // Target.setAutoAttach re-attaches an already-configured target;
          // the override is in place, we just can't replace it. Harmless.
          const msg = (e as Error).message;
          if (!/already in effect/i.test(msg)) {
            console.error("[multizen] setLocaleOverride failed:", e);
          }
        }
        // 4. UA + Client Hints — single CDP call sets `navigator.userAgent`
        //    AND every Sec-CH-UA-* header AND `navigator.userAgentData`.
        //    No Chromium patch required.
        const meta = safeBuildUserAgentMetadata(fp);
        try {
          const params: Record<string, unknown> = {
            userAgent: fp.userAgent,
            // Plain language list — see --accept-lang comment above.
            acceptLanguage: acceptLangPlain,
            platform: fp.platform,
          };
          if (meta) params.userAgentMetadata = meta;
          await send("Emulation.setUserAgentOverride", params);
        } catch (e) {
          console.error("[multizen] setUserAgentOverride failed:", e);
        }
        // Diagnostic: capture what the page actually sees AFTER overrides.
        // Logs once per session — if browserscan reports "Different browser
        // name", these values tell us whether our override landed.
        try {
          const probe = await send<{
            result?: { value?: string };
          }>("Runtime.evaluate", {
            expression: `JSON.stringify({
              ua: navigator.userAgent,
              brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
              platform: navigator.platform,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              lang: navigator.language,
              langs: navigator.languages,
              webrtcSpoofed: typeof window.__multizenWebrtc === "string" ? window.__multizenWebrtc : false,
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
      })
      .catch((e: unknown) => {
        console.error("[multizen] CDP bootstrap failed:", e);
      });

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
      void releaseForProfile(profileId).catch(() => {});
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
    await releaseForProfile(profileId).catch(() => {});
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

/**
 * Convert our string-formatted ClientHints into the structured
 * `userAgentMetadata` shape that CDP `Emulation.setUserAgentOverride`
 * expects. The CDP call then sets every Sec-CH-UA-* header AND populates
 * `navigator.userAgentData` — no Chromium patch needed.
 */
function safeBuildUserAgentMetadata(
  fp: FingerprintConfig,
): ReturnType<typeof buildUserAgentMetadata> | null {
  if (!fp.clientHints || !fp.clientHints.secChUa) {
    // Legacy profile created before clientHints existed. The basic
    // userAgent + platform string are still applied via the parent call;
    // Sec-CH-UA-* headers will fall back to Chromium defaults until the
    // user regenerates the fingerprint.
    return null;
  }
  try {
    return buildUserAgentMetadata(fp);
  } catch (e) {
    console.error("[multizen] buildUserAgentMetadata threw:", e);
    return null;
  }
}

function buildUserAgentMetadata(fp: FingerprintConfig): {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  mobile: boolean;
  wow64: boolean;
} {
  const ch: ClientHints = fp.clientHints;
  return {
    brands: parseBrandList(ch.secChUa),
    fullVersionList: parseBrandList(ch.secChUaFullVersionList),
    platform: ch.secChUaPlatform,
    platformVersion: ch.secChUaPlatformVersion,
    architecture: ch.secChUaArch,
    bitness: ch.secChUaBitness,
    model: ch.secChUaModel,
    mobile: ch.secChUaMobile === "?1",
    wow64: false,
  };
}

/**
 * Parse an Sec-CH-UA header value of the form:
 *   "Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"
 * into the [{brand, version}] array CDP wants.
 */
function parseBrandList(
  header: string,
): Array<{ brand: string; version: string }> {
  const out: Array<{ brand: string; version: string }> = [];
  // Each item is `"<brand>";v="<version>"` — split on top-level commas
  // (brand strings cannot contain commas in practice).
  for (const part of header.split(",")) {
    const m = part.trim().match(/^"([^"]*)"\s*;\s*v="([^"]*)"\s*$/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ brand: m[1], version: m[2] });
  }
  return out;
}

/**
 * Patches non-CDP-controllable fingerprint surfaces:
 *   - `navigator.platform` (CDP `setUserAgentOverride` sets it once but
 *     iframes / web-workers can drift — reapplied on every document)
 *   - `navigator.hardwareConcurrency`
 *   - `navigator.deviceMemory`
 *   - `WebGLRenderingContext.getParameter` UNMASKED_VENDOR_WEBGL (0x9245)
 *     and UNMASKED_RENDERER_WEBGL (0x9246) for both WebGL1 and WebGL2.
 *
 * All wrappers carry a spoofed `.toString()` that returns
 * `function <name>() { [native code] }` so naive detection via
 * `Function.prototype.toString.call(fn)` passes.
 */
function buildFingerprintPreloadScript(fp: FingerprintConfig): string {
  return `
(() => {
  const PLATFORM = ${JSON.stringify(fp.platform)};
  const HW_CONCURRENCY = ${fp.hardwareConcurrency};
  const DEVICE_MEMORY = ${fp.deviceMemory};
  const GPU_VENDOR = ${JSON.stringify(fp.webgl.vendor)};
  const GPU_RENDERER = ${JSON.stringify(fp.webgl.renderer)};
  const SCREEN_W = ${fp.screen.width};
  const SCREEN_H = ${fp.screen.height};
  const AVAIL_W = ${fp.availScreen?.width ?? fp.screen.width};
  const AVAIL_H = ${fp.availScreen?.height ?? fp.screen.height};
  const DPR = ${fp.dpr};

  function fakeNative(fn, name) {
    try {
      const stringified = "function " + name + "() { [native code] }";
      Object.defineProperty(fn, "toString", {
        value: function () { return stringified; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  function defineProp(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, {
        get: function () { return value; },
        configurable: true,
      });
    } catch (_) {}
  }

  // ---- navigator props ----------------------------------------------------
  defineProp(Navigator.prototype, "platform", PLATFORM);
  defineProp(Navigator.prototype, "hardwareConcurrency", HW_CONCURRENCY);
  defineProp(Navigator.prototype, "deviceMemory", DEVICE_MEMORY);

  // ---- screen props (some sites read screen.* not via Emulation) ----------
  defineProp(Screen.prototype, "width", SCREEN_W);
  defineProp(Screen.prototype, "height", SCREEN_H);
  defineProp(Screen.prototype, "availWidth", AVAIL_W);
  defineProp(Screen.prototype, "availHeight", AVAIL_H);
  defineProp(Screen.prototype, "colorDepth", 24);
  defineProp(Screen.prototype, "pixelDepth", 24);

  // ---- devicePixelRatio (Emulation should set this but cover it) ----------
  defineProp(window, "devicePixelRatio", DPR);

  // ---- WebGL renderer / vendor -------------------------------------------
  // Real Chrome only resolves UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
  // *after* the page has activated WEBGL_debug_renderer_info via
  // gl.getExtension(...). If we return spoofed strings unconditionally, sites
  // that probe getParameter without enabling the extension see a string
  // where real Chrome returns "" — that anomaly = browserscan "WebGL exception".
  const debugInfoEnabled = new WeakMap();
  function patchGetExtension(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    const origGet = Ctor.prototype.getExtension;
    if (!origGet) return;
    function wrapped(name) {
      const result = origGet.call(this, name);
      if (result && name === "WEBGL_debug_renderer_info") {
        debugInfoEnabled.set(this, true);
      }
      return result;
    }
    fakeNative(wrapped, "getExtension");
    Object.defineProperty(Ctor.prototype, "getExtension", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  function patchGetParameter(Ctor) {
    if (!Ctor || !Ctor.prototype || !Ctor.prototype.getParameter) return;
    const orig = Ctor.prototype.getParameter;
    function wrapped(p) {
      // 0x9245 = UNMASKED_VENDOR_WEBGL, 0x9246 = UNMASKED_RENDERER_WEBGL
      if (p === 0x9245 || p === 0x9246) {
        if (!debugInfoEnabled.get(this)) {
          // Page didn't enable WEBGL_debug_renderer_info — match real Chrome
          // which returns null/empty. Returning the spoof here is a tell.
          return orig.call(this, p);
        }
        return p === 0x9245 ? GPU_VENDOR : GPU_RENDERER;
      }
      return orig.call(this, p);
    }
    fakeNative(wrapped, "getParameter");
    Object.defineProperty(Ctor.prototype, "getParameter", {
      value: wrapped, configurable: true, writable: true,
    });
  }
  patchGetExtension(window.WebGLRenderingContext);
  patchGetExtension(window.WebGL2RenderingContext);
  patchGetParameter(window.WebGLRenderingContext);
  patchGetParameter(window.WebGL2RenderingContext);

  // ---- navigator.userAgentData getHighEntropyValues fallback --------------
  // CDP Emulation.setUserAgentOverride.userAgentMetadata sets this on stock
  // Chromium, but iframes occasionally see the unpatched version. Cover the
  // gap by mirroring values from navigator.userAgent + platform.
  // (Not invoked here — handled via CDP. Placeholder for future hardening.)
})();
`;
}

/**
 * Build the WebRTC spoof script with the supplied proxy IP baked in.
 *
 * Stealth strategy: we DO NOT replace `window.RTCPeerConnection` — its
 * `.toString()` would diverge from `[native code]`. Instead we patch the
 * prototype's `addEventListener`, the `onicecandidate` setter, and the
 * `localDescription` / `currentLocalDescription` getters to launder ICE
 * candidates as they leave the API. The constructor stays native.
 *
 * For every emitted ICE candidate:
 *   - Drop mDNS `.local` host candidates (would expose hostname).
 *   - Drop loopback / private-RFC1918 candidates.
 *   - Replace any public IP in `candidate.candidate` and `candidate.address`
 *     with the proxy's public IP, keeping foundation/port/typ srflx so
 *     the SDP looks like a real STUN-discovered candidate.
 *
 * For SDP munging (`localDescription`):
 *   - Same IP rewrite + remove `c=IN IP4 <real>` lines that don't match
 *     the proxy IP.
 *
 * `Function.prototype.toString` is also patched on our wrappers so that
 * naive `RTCPeerConnection.prototype.addEventListener.toString()` checks
 * still return `function addEventListener() { [native code] }`.
 */
function buildWebRtcSpoofScript(proxyIp: string): string {
  return `
(() => {
  // Marker visible to the probe — confirms the spoof actually ran in
  // this document context. If post-bootstrap probe shows
  // webrtcSpoofed: true, the wrapper is active.
  try { Object.defineProperty(window, "__multizenWebrtc", { value: ${JSON.stringify(proxyIp)}, configurable: false }); } catch (_) {}
  if (!window.RTCPeerConnection) return;
  const PROXY_IP = ${JSON.stringify(proxyIp)};
  // Sentinel: patchEvent returns this when the candidate must be
  // silently suppressed. Listener wrappers check for it and skip
  // dispatch entirely — emitting candidate=null would prematurely
  // signal "gathering done" to the page.
  const SUPPRESS = Symbol("suppress-ice");
  // Plausible LAN IP for raddr/rport — real srflx candidates carry
  // the local interface IP that STUN used. Stripping these creates
  // an "srflx without raddr" anomaly that fingerprinters flag.
  const FAKE_LAN = "192.168.1.42";

  const PRIV_RE = /^(10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|169\\.254\\.|127\\.|fe80:|fc00:|fd)/i;
  function isPrivate(ip) {
    if (!ip) return true;
    if (ip.endsWith(".local")) return true;
    return PRIV_RE.test(ip);
  }

  function rewriteCandidateLine(line) {
    // candidate:foundation 1 udp 2113937151 1.2.3.4 50000 typ host generation 0 ufrag XXX network-id 1
    const parts = line.split(" ");
    if (parts.length < 8) return line;
    const port = parts[5];
    parts[4] = PROXY_IP;       // public IP
    parts[7] = "srflx";        // looks STUN-discovered

    // Walk extra k/v pairs after typ — rewrite raddr/rport to fake LAN.
    let hasRaddr = false;
    for (let i = 8; i < parts.length - 1; i++) {
      if (parts[i] === "raddr") { parts[i + 1] = FAKE_LAN; hasRaddr = true; }
      if (parts[i] === "rport") { parts[i + 1] = port; }
    }
    if (!hasRaddr) {
      // Insert raddr/rport right after "typ srflx" so the candidate
      // looks like a real STUN-reflected one.
      parts.splice(8, 0, "raddr", FAKE_LAN, "rport", port);
    }
    return parts.join(" ");
  }

  function patchEvent(event) {
    const c = event && event.candidate;
    if (!c) return event; // end-of-gathering marker — pass through
    const real = c.address || c.ip || "";
    // mDNS .local hostnames leak the device hostname — suppress, but
    // do NOT replace with candidate=null mid-stream.
    if (real.endsWith(".local")) return SUPPRESS;
    try {
      const newStr = rewriteCandidateLine(c.candidate || "");
      const fake = new RTCIceCandidate({
        candidate: newStr,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      });
      return new RTCPeerConnectionIceEvent("icecandidate", { candidate: fake });
    } catch (_) {
      return SUPPRESS;
    }
  }

  function mungeSdp(sdp) {
    if (!sdp) return sdp;
    // Replace c=IN IP4 / c=IN IP6 with proxy IP.
    let out = sdp.replace(/c=IN IP4 \\S+/g, "c=IN IP4 " + PROXY_IP);
    // Rewrite a=candidate lines, drop private-IP entries (mDNS .local).
    out = out
      .split(/\\r?\\n/)
      .map((line) => {
        if (!line.startsWith("a=candidate:")) return line;
        const parts = line.replace("a=candidate:", "").split(" ");
        const ip = parts[4];
        if (ip && (ip.endsWith(".local"))) return null;
        return "a=candidate:" + rewriteCandidateLine(parts.join(" "));
      })
      .filter((l) => l !== null)
      .join("\\r\\n");
    return out;
  }

  // ---- Hook prototype, leave constructor untouched ------------------------
  const proto = window.RTCPeerConnection.prototype;
  const ctorVariants = [window.RTCPeerConnection];
  if (window.webkitRTCPeerConnection && window.webkitRTCPeerConnection !== window.RTCPeerConnection) {
    ctorVariants.push(window.webkitRTCPeerConnection);
  }

  // 1. addEventListener('icecandidate', ...)
  const origAdd = proto.addEventListener;
  function wrappedAdd(type, listener, options) {
    if (type === "icecandidate" && typeof listener === "function") {
      const wrapped = function (event) {
        return listener.call(this, patchEvent(event));
      };
      // Make .toString look ordinary so detection that does
      // listener.toString() doesn't see "wrapped".
      try {
        Object.defineProperty(wrapped, "toString", {
          value: listener.toString.bind(listener),
        });
      } catch (_) {}
      return origAdd.call(this, type, wrapped, options);
    }
    return origAdd.call(this, type, listener, options);
  }
  Object.defineProperty(proto, "addEventListener", { value: wrappedAdd });
  fakeNativeToString(wrappedAdd, "addEventListener");

  // 2. onicecandidate setter
  const origDescr = Object.getOwnPropertyDescriptor(proto, "onicecandidate");
  if (origDescr && origDescr.set) {
    const origSet = origDescr.set;
    Object.defineProperty(proto, "onicecandidate", {
      get: origDescr.get,
      set: function (cb) {
        if (typeof cb === "function") {
          const wrapped = function (event) {
            return cb.call(this, patchEvent(event));
          };
          try {
            Object.defineProperty(wrapped, "toString", {
              value: cb.toString.bind(cb),
            });
          } catch (_) {}
          return origSet.call(this, wrapped);
        }
        return origSet.call(this, cb);
      },
      configurable: true,
    });
  }

  // 3. localDescription / currentLocalDescription getters
  for (const propName of ["localDescription", "currentLocalDescription"]) {
    const d = Object.getOwnPropertyDescriptor(proto, propName);
    if (!d || !d.get) continue;
    const origGet = d.get;
    Object.defineProperty(proto, propName, {
      get: function () {
        const desc = origGet.call(this);
        if (desc && desc.sdp) {
          try {
            return { type: desc.type, sdp: mungeSdp(desc.sdp), toJSON: desc.toJSON };
          } catch (_) {
            return desc;
          }
        }
        return desc;
      },
      configurable: true,
    });
  }

  // 4. createOffer / createAnswer munge their SDP before resolving.
  for (const fnName of ["createOffer", "createAnswer"]) {
    const orig = proto[fnName];
    function wrapped() {
      const args = arguments;
      return orig.apply(this, args).then((desc) => {
        if (desc && desc.sdp) desc.sdp = mungeSdp(desc.sdp);
        return desc;
      });
    }
    fakeNativeToString(wrapped, fnName);
    Object.defineProperty(proto, fnName, { value: wrapped, configurable: true, writable: true });
  }

  // 4b. getStats() — bypasses onicecandidate / localDescription wrappers.
  // Returns RTCIceCandidateStats with .address / .ip / .relatedAddress
  // fields straight from internal state. browserscan reads these to
  // catch the real public IP. We rewrite IPs in stats too.
  const origGetStats = proto.getStats;
  if (origGetStats) {
    function wrappedGetStats() {
      const args = arguments;
      return origGetStats.apply(this, args).then((report) => {
        try {
          report.forEach((stat) => {
            if (!stat) return;
            if (typeof stat.address === "string" && !isPrivate(stat.address) && !stat.address.endsWith(".local")) {
              stat.address = PROXY_IP;
            }
            if (typeof stat.ip === "string" && !isPrivate(stat.ip) && !stat.ip.endsWith(".local")) {
              stat.ip = PROXY_IP;
            }
            if (typeof stat.relatedAddress === "string" && !isPrivate(stat.relatedAddress)) {
              stat.relatedAddress = "192.168.1.42";
            }
            // Hide candidate type "host" (which would imply native interface)
            if (stat.candidateType === "host") {
              stat.candidateType = "srflx";
            }
          });
        } catch (_) {}
        return report;
      });
    }
    fakeNativeToString(wrappedGetStats, "getStats");
    Object.defineProperty(proto, "getStats", { value: wrappedGetStats, configurable: true, writable: true });
  }

  // 5. mediaDevices.enumerateDevices — keep working but strip per-device
  //    ids that uniquely identify hardware. Returns generic labels.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnum = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.enumerateDevices = function () {
      return origEnum().then((list) =>
        list.map((d) => ({
          deviceId: "",
          groupId: "",
          kind: d.kind,
          label: "",
          toJSON: d.toJSON,
        })),
      );
    };
    fakeNativeToString(navigator.mediaDevices.enumerateDevices, "enumerateDevices");
  }

  function fakeNativeToString(fn, name) {
    try {
      Object.defineProperty(fn, "toString", {
        value: function () { return "function " + name + "() { [native code] }"; },
        configurable: false,
        writable: false,
      });
      Object.defineProperty(fn, "name", { value: name });
    } catch (_) {}
  }

  // Sanity: keep ctorVariants reachable so if the page fishes the
  // original via a global, it still reaches our patched prototype.
  void ctorVariants;
})();
`;
}

/**
 * Removes WebRTC peer-connection APIs entirely. Runs before any page
 * script via Page.addScriptToEvaluateOnNewDocument.
 *
 * We do not just override with `undefined` — we use `Object.defineProperty`
 * with a getter that returns undefined and `configurable: false` so a
 * page cannot later restore the constructor by digging out the original
 * via iframe contentWindow. Iframes also get the script via the same
 * preload mechanism (it runs on every new document, including frames).
 *
 * This is detectable as a "no WebRTC" signal — a real Chrome on a real
 * machine has it. For an anti-detect profile that's an OK trade-off:
 * "WebRTC disabled" is a small population but not unheard of (corporate
 * networks, privacy extensions). "WebRTC reveals real IP" is the
 * unambiguous-bot-or-proxy-leak signal we MUST avoid.
 */
const WEBRTC_BLOCK_SCRIPT = `
(() => {
  const noop = function () { throw new TypeError("WebRTC is disabled"); };
  // Make .toString() look like a native function so naive detection
  // (Function.prototype.toString.call(RTCPeerConnection)) returns
  // [native code] like in real Chrome with WebRTC behind enterprise
  // policy.
  try {
    Object.defineProperty(noop, "toString", {
      value: function () { return "function () { [native code] }"; },
      configurable: false,
      writable: false,
    });
    Object.defineProperty(noop, "name", { value: "RTCPeerConnection" });
  } catch (_) {}

  const kill = (name) => {
    try {
      Object.defineProperty(window, name, {
        get: () => undefined,
        set: () => {},
        configurable: false,
      });
    } catch (_) {}
  };

  kill("RTCPeerConnection");
  kill("webkitRTCPeerConnection");
  kill("RTCDataChannel");
  kill("RTCSessionDescription");
  kill("RTCIceCandidate");

  // mediaDevices.enumerateDevices() can also leak hardware identifiers;
  // wrap it so it returns an empty list. getUserMedia stays so sites
  // can ask permission, but it'll never actually return devices.
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = function () {
        return Promise.resolve([]);
      };
      // Preserve toString shape
      try {
        Object.defineProperty(navigator.mediaDevices.enumerateDevices, "toString", {
          value: orig.toString.bind(orig),
        });
      } catch (_) {}
    }
  } catch (_) {}
})();
`;

/**
 * Ensure the profile's Chrome `Default/Preferences` JSON has
 * `session.restore_on_startup = 1` so a relaunch reopens the tabs that
 * were open when the user last closed the window. Called before each
 * spawn — Chromium must NOT be running, otherwise we'll corrupt its
 * pref file (Chromium writes Preferences atomically with no flock).
 */
/**
 * Run `chromium --version` and parse the version triple. Returns null
 * if the probe fails — the caller should then trust whatever version is
 * baked into the profile.
 */
async function detectChromiumVersion(
  binaryPath: string,
): Promise<{ major: number; full: string } | null> {
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
        const m = out.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
        if (!m) return done(null);
        done({ major: Number(m[1]), full: `${m[1]}.${m[2]}.${m[3]}.${m[4]}` });
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
  const newUA = fp.userAgent.replace(
    /Chrome\/\d+\.\d+\.\d+\.\d+/,
    `Chrome/${actual.full}`,
  );
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
 * Suppress Chrome for Testing's "this build is only for automated testing"
 * infobar by writing the macOS managed-preference plist that the CfT
 * policy `CommandLineFlagSecurityWarningsEnabled` lives in. The path is
 * `/Library/Managed Preferences/com.google.chrome.for.testing.plist`,
 * which requires admin — but only ONCE; subsequent launches see the
 * file and skip the prompt.
 *
 * If the user declines admin (or just hits cancel), we swallow the
 * error and continue with the infobar visible. We don't keep prompting.
 */
async function ensureCftInfobarSuppressed(): Promise<void> {
  // macOS reads managed prefs from BOTH paths; the per-user one wins on
  // recent macOS (Big Sur+), the system-wide one is the fallback. We
  // write both for max compatibility.
  const username = process.env.USER ?? "";
  const userPlistPath = `/Library/Managed Preferences/${username}/com.google.chrome.for.testing.plist`;
  const systemPlistPath =
    "/Library/Managed Preferences/com.google.chrome.for.testing.plist";
  const plistPath = systemPlistPath; // primary write target; user-dir handled in script below

  // Skip if already configured. Read the plist value to ensure it's
  // actually `false`, not just present.
  if (existsSync(plistPath) || existsSync(userPlistPath)) {
    try {
      const { stdout } = await execFileP("defaults", [
        "read",
        "/Library/Managed Preferences/com.google.chrome.for.testing",
        "CommandLineFlagSecurityWarningsEnabled",
      ]);
      if (stdout.trim() === "0") return;
    } catch {
      // Key missing — fall through and (re-)write below.
    }
  }

  // Sentinel file: if the user has previously declined the admin
  // prompt, remember that and do NOT re-prompt on every launch.
  const sentinelPath = `${app.getPath(
    "userData",
  )}/.cft-infobar-prompt-declined`;
  if (existsSync(sentinelPath)) return;

  // Write the plist to a tempfile in user-space first (no admin needed),
  // then `cp` it to /Library/Managed Preferences/ via osascript admin.
  // Avoids the shell-escaping nightmare of putting XML inside a nested
  // AppleScript double-quoted string.
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CommandLineFlagSecurityWarningsEnabled</key>
  <false/>
</dict>
</plist>
`;
  const tempPath = `${app.getPath("temp")}/multizen-cft-policy-${process.pid}.plist`;
  await writeFile(tempPath, plistXml);

  const shellScript =
    `/bin/mkdir -p '/Library/Managed Preferences/${username}' && ` +
    `/bin/cp '${tempPath}' '${plistPath}' && ` +
    `/bin/chmod 644 '${plistPath}' && ` +
    `/usr/sbin/chown root:wheel '${plistPath}' && ` +
    `/bin/cp '${tempPath}' '${userPlistPath}' && ` +
    `/bin/chmod 644 '${userPlistPath}' && ` +
    `/usr/sbin/chown root:wheel '${userPlistPath}'`;
  const apple = `do shell script "${shellScript.replace(/"/g, '\\"')}" with administrator privileges with prompt "MultiZen needs a one-time admin authorization to hide the 'Chrome for Testing' warning bar."`;

  try {
    await execFileP("osascript", ["-e", apple]);
    // Cleanup tempfile after copy succeeds (no admin needed since we own it).
    await fsp.unlink(tempPath).catch(() => {});
    console.log(
      "[multizen] CFT infobar suppressed via managed-preferences plist",
    );
  } catch (e) {
    await fsp.unlink(tempPath).catch(() => {});
    // User cancelled or osascript failed. Plant the sentinel so we
    // don't pester them on every launch.
    try {
      await writeFile(sentinelPath, new Date().toISOString());
    } catch {
      // Sentinel write may fail in weird envs — not critical.
    }
    throw e;
  }
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
  const session = (prefs.session as Record<string, unknown>) ?? {};
  // 1 = restore last session ("Continue where you left off")
  // 5 = new tab page (Chromium default)
  if (session.restore_on_startup === 1) return;
  session.restore_on_startup = 1;
  prefs.session = session;

  await fsp.mkdir(join(dataDir, "Default"), { recursive: true });
  // Atomic-ish write: write to .tmp then rename.
  const tmpPath = `${prefsPath}.multizen.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(prefs));
  await fsp.rename(tmpPath, prefsPath);
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
