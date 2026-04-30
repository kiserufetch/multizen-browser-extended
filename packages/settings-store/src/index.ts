import keytar from "keytar";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SERVICE = "com.multizen.desktop";

export interface AppSettings {
  /** Anthropic key only — stored in OS keychain, never in plain JSON */
  anthropicApiKey?: string;
  /** Default LLM model for natural-language click/extract */
  resolverModel: string;
  /** Theme — "dark" only for now, kept for forward compatibility */
  theme: "dark";
  /** Whether to spawn local MCP HTTP server on app start */
  mcpHttpEnabled: boolean;
  /** Port for MCP HTTP server */
  mcpHttpPort: number;
}

const DEFAULTS: AppSettings = {
  resolverModel: "claude-sonnet-4-6",
  theme: "dark",
  mcpHttpEnabled: true,
  mcpHttpPort: 7777,
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

    // Anthropic key lives in keychain, not JSON
    try {
      const stored = await keytar.getPassword(SERVICE, "anthropic_api_key");
      if (stored) merged.anthropicApiKey = stored;
    } catch {
      // keychain not available (CI, headless dev) — ignore
    }

    this.cache = merged;
    return merged;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next = { ...current, ...patch };
    this.cache = next;

    // Persist key to keychain separately
    if (patch.anthropicApiKey !== undefined) {
      try {
        if (patch.anthropicApiKey === "") {
          await keytar.deletePassword(SERVICE, "anthropic_api_key");
        } else {
          await keytar.setPassword(SERVICE, "anthropic_api_key", patch.anthropicApiKey);
        }
      } catch {
        // keychain not available — fall through to JSON
      }
    }

    // JSON gets everything except the secret
    const { anthropicApiKey: _omit, ...rest } = next;
    writeFileSync(this.jsonPath, JSON.stringify(rest, null, 2), "utf8");

    return next;
  }
}

export function defaultSettingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}
