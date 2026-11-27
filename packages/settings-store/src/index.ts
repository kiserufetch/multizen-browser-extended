import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isDisplayMode,
  isProxyExposureMode,
  isSolverAdapterKind,
  isSolverFallbackPolicy,
  type BrowserEngine,
  type DisplayMode,
  type SolverSettings,
} from "@multizen/types";

export type { BrowserEngine, DisplayMode, SolverSettings };

export const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
  enabled: false,
  adapter: "none",
  fallbackPolicy: "solver-then-human",
  proxyExposure: "bridge",
  allowMainWorldJs: false,
  timeoutMs: 120_000,
};

export function normalizeSolverSettings(raw: unknown): SolverSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SOLVER_SETTINGS };
  const s = raw as Partial<SolverSettings>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT_SOLVER_SETTINGS.enabled,
    adapter: isSolverAdapterKind(s.adapter) ? s.adapter : DEFAULT_SOLVER_SETTINGS.adapter,
    ...(typeof s.webhookUrl === "string" && s.webhookUrl.trim() !== ""
      ? { webhookUrl: s.webhookUrl.trim() }
      : {}),
    ...(typeof s.webhookSecret === "string" && s.webhookSecret !== ""
      ? { webhookSecret: s.webhookSecret }
      : {}),
    ...(typeof s.apiKey === "string" && s.apiKey !== "" ? { apiKey: s.apiKey } : {}),
    ...(typeof s.modulePath === "string" && s.modulePath.trim() !== ""
      ? { modulePath: s.modulePath.trim() }
      : {}),
    fallbackPolicy: isSolverFallbackPolicy(s.fallbackPolicy)
      ? s.fallbackPolicy
      : DEFAULT_SOLVER_SETTINGS.fallbackPolicy,
    proxyExposure: isProxyExposureMode(s.proxyExposure)
      ? s.proxyExposure
      : DEFAULT_SOLVER_SETTINGS.proxyExposure,
    allowMainWorldJs:
      typeof s.allowMainWorldJs === "boolean"
        ? s.allowMainWorldJs
        : DEFAULT_SOLVER_SETTINGS.allowMainWorldJs,
    timeoutMs:
      typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs) && s.timeoutMs > 0
        ? Math.round(s.timeoutMs)
        : DEFAULT_SOLVER_SETTINGS.timeoutMs,
    ...(s.options && typeof s.options === "object" && !Array.isArray(s.options)
      ? { options: s.options }
      : {}),
  };
}

/**
 * Linux sandbox secure-setup state.
 * - "unset": never decided; re-evaluate live each launch.
 * - "declined": user chose to launch without the sandbox; do not auto-prompt.
 * - "unsupported": the AppArmor secure setup cannot be performed on this system
 *   (reason surfaced once + kept visible in Settings); do not re-nag.
 * Only meaningful on Linux. "active" is never stored — it is verified live
 * against the OS at launch (a persisted flag must never be trusted).
 */
export type LinuxSandboxState = "unset" | "declined" | "unsupported";

export interface AppSettings {
  /** Theme — "dark" only for now, kept for forward compatibility */
  theme: "dark";
  /** Whether to spawn local MCP HTTP server on app start */
  mcpHttpEnabled: boolean;
  /** Port for MCP HTTP server */
  mcpHttpPort: number;
  /** Which Chromium binary to download + run. Switching requires app restart. */
  browserEngine: BrowserEngine;
  /**
   * Automatically check for + (on Windows/Linux) download app updates in the
   * background. On macOS the app can only notify, not auto-install. Manual
   * "Check for updates" works regardless of this flag.
   */
  autoUpdate: boolean;
  /**
   * Automatically check for + stage new versions of the downloaded browser
   * ENGINE (CloakBrowser / Camoufox) in the background. A staged engine
   * applies on the next profile launch; running browsers are never
   * interrupted. Manual "Check for updates" works regardless of this flag.
   */
  engineAutoUpdate: boolean;
  /**
   * Opt-in anonymous usage heartbeat. OFF by default — for an anti-detect
   * audience any call-home must be an explicit choice. When on, the app sends
   * at most one ping/day carrying only app version + OS family + an ephemeral
   * single-use nonce — no persistent id, no IP sent. The MULTIZEN_NO_TELEMETRY
   * env var force-disables it regardless. See docs/TELEMETRY.md.
   */
  usageReporting: boolean;
  /**
   * Linux sandbox secure-setup state (see LinuxSandboxState). Only consulted on
   * Linux kernels that restrict unprivileged user namespaces; ignored elsewhere.
   */
  linuxSandboxState: LinuxSandboxState;
  /**
   * How profiles without a mode of their own open. Unset means headed on the
   * desktop, and the `--display-mode` flag on a server.
   */
  defaultDisplayMode?: DisplayMode;
  /**
   * Optional challenge solver port configuration.
   */
  solver?: SolverSettings;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  mcpHttpEnabled: true,
  mcpHttpPort: 7777,
  // CloakBrowser is the default engine for newly created profiles.
  browserEngine: "cloakbrowser",
  autoUpdate: true,
  engineAutoUpdate: true,
  // Opt-in. Never phone home unless the user explicitly turns this on.
  usageReporting: false,
  // Re-evaluated live on each Linux launch until the user decides or the system
  // is found unable to run the secure setup.
  linuxSandboxState: "unset",
};

export class SettingsStore {
  private readonly jsonPath: string;
  private cache: AppSettings | null = null;

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    mkdirSync(dirname(jsonPath), { recursive: true });
  }

  async load(): Promise<AppSettings> {
    if (this.cache) return this.cache;

    let raw: Partial<AppSettings> = {};
    if (existsSync(this.jsonPath)) {
      try {
        const txt = readFileSync(this.jsonPath, "utf8");
        raw = JSON.parse(txt) as Partial<AppSettings>;
      } catch {
        raw = {};
      }
    }

    const merged: AppSettings = { ...DEFAULTS, ...raw };
    if (merged.browserEngine !== "cloakbrowser" && merged.browserEngine !== "camoufox") {
      merged.browserEngine = DEFAULTS.browserEngine;
    }
    if (typeof merged.autoUpdate !== "boolean") {
      merged.autoUpdate = DEFAULTS.autoUpdate;
    }
    if (typeof merged.engineAutoUpdate !== "boolean") {
      merged.engineAutoUpdate = DEFAULTS.engineAutoUpdate;
    }
    if (typeof merged.usageReporting !== "boolean") {
      merged.usageReporting = DEFAULTS.usageReporting;
    }
    if (
      merged.linuxSandboxState !== "unset" &&
      merged.linuxSandboxState !== "declined" &&
      merged.linuxSandboxState !== "unsupported"
    ) {
      merged.linuxSandboxState = DEFAULTS.linuxSandboxState;
    }
    // A value this build can't run is dropped, not defaulted: unset has its own meaning.
    if (!isDisplayMode(merged.defaultDisplayMode)) delete merged.defaultDisplayMode;
    if (merged.solver !== undefined) {
      merged.solver = normalizeSolverSettings(merged.solver);
    }
    this.cache = merged;
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const mode: unknown = patch.defaultDisplayMode;
    if (mode !== undefined && !isDisplayMode(mode)) {
      throw new Error(`Unknown display mode "${String(mode)}"`);
    }
    const current = await this.load();
    const next: AppSettings = {
      ...current,
      ...patch,
      ...(patch.solver !== undefined
        ? { solver: normalizeSolverSettings({ ...current.solver, ...patch.solver }) }
        : {}),
    };
    this.cache = next;
    writeFileSync(this.jsonPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}
