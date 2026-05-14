export type ProfileId = string;

export interface ProxyConfig {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Identifier of a real device family — defines the platform / CPU / GPU class. */
export type DeviceFamily =
  | "macbook-pro-14-m3"
  | "macbook-pro-14-m3-pro"
  | "macbook-pro-16-m3-pro"
  | "macbook-air-13-m3"
  | "imac-24-m3"
  | "windows-laptop-intel"
  | "windows-laptop-nvidia"
  | "windows-desktop-nvidia"
  | "linux-desktop-intel";

/**
 * Sec-CH-UA Client Hints — what every modern Chromium send as headers AND
 * exposes via `navigator.userAgentData`. Detection vendors cross-check
 * these against the legacy User-Agent string and `navigator.platform`,
 * so they MUST stay coherent.
 *
 * In our open-source build we can only set `navigator.userAgent` (via
 * Chromium `--user-agent` flag); the Sec-CH-UA family requires native
 * patches in our closed Chromium binary. The fields below are stored
 * with the profile so the patched Chromium can apply them at runtime.
 */
export interface ClientHints {
  /** Sec-CH-UA header value, e.g. `"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"` */
  secChUa: string;
  /** Sec-CH-UA-Platform: `"macOS" | "Windows" | "Linux" | "Android" | "iOS"` */
  secChUaPlatform: string;
  /** Sec-CH-UA-Platform-Version: `"14.6.0"` for macOS 14, `"10.0.0"` for Win 10 */
  secChUaPlatformVersion: string;
  /** Sec-CH-UA-Arch: `"arm" | "x86"` */
  secChUaArch: "arm" | "x86";
  /** Sec-CH-UA-Bitness: `"64" | "32"` */
  secChUaBitness: "64" | "32";
  /** Sec-CH-UA-Mobile: `"?0" | "?1"` */
  secChUaMobile: "?0" | "?1";
  /** Sec-CH-UA-Model: usually empty on desktop, e.g. `"Pixel 8"` on mobile */
  secChUaModel: string;
  /** Sec-CH-UA-Full-Version-List: full version per brand */
  secChUaFullVersionList: string;
}

export interface FingerprintConfig {
  /** Real device family this fingerprint impersonates */
  device: DeviceFamily;

  // ── Headers / navigator ──────────────────────────────────────────
  /** Full legacy User-Agent string */
  userAgent: string;
  /** `navigator.platform` — must match device family */
  platform: "MacIntel" | "Win32" | "Linux x86_64";
  /** Client Hints (Sec-CH-UA-*) */
  clientHints: ClientHints;

  // ── Locale / geo ─────────────────────────────────────────────────
  /** BCP 47 primary locale, e.g. `"en-US"` */
  locale: string;
  /** Ordered list for `navigator.languages`, e.g. `["en-US", "en"]` */
  languages: string[];
  /** HTTP `Accept-Language` header, derived from `languages` */
  acceptLanguage: string;
  /** IANA timezone, e.g. `"America/New_York"` */
  timezone: string;
  /** ISO 3166-1 alpha-2 country code matching the locale, for flag rendering */
  country: string;

  // ── Display ──────────────────────────────────────────────────────
  /** Logical screen size — `screen.width` / `screen.height` */
  screen: { width: number; height: number };
  /** Available area (screen minus dock/taskbar). Defaults to screen. */
  availScreen?: { width: number; height: number };
  /** `devicePixelRatio` — 2 on Retina, 1 on most desktops */
  dpr: number;

  // ── GPU ──────────────────────────────────────────────────────────
  webgl: {
    /** UNMASKED_VENDOR_WEBGL */
    vendor: string;
    /** UNMASKED_RENDERER_WEBGL */
    renderer: string;
  };

  // ── CPU / RAM ────────────────────────────────────────────────────
  hardwareConcurrency: number;
  deviceMemory: number;
}

export interface Profile {
  id: ProfileId;
  name: string;
  notes?: string;
  tags: string[];
  proxy?: ProxyConfig;
  fingerprint: FingerprintConfig;
  dataDir: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /** ISO 3166-1 alpha-2 country code resolved from the proxy's egress IP.
   *  Cached on every successful proxy probe (launch flow + manual ProxyTester).
   *  Used by the GUI to render the country flag — proxy egress trumps the
   *  fingerprint's timezone-derived country, since that's what websites see. */
  proxyCountry?: string;
}

export interface ProfileSummary {
  id: ProfileId;
  name: string;
  tags: string[];
  lastOpenedAt?: string;
  isRunning: boolean;
  /** Proxy config (denormalised so the GUI can render a proxy chip without a second fetch) */
  proxy?: ProxyConfig;
  /** IANA timezone from the profile's fingerprint (for flag inference) */
  timezone?: string;
  /** Country code resolved from the proxy's egress IP — preferred over
   *  `timezone` for flag rendering when the profile has a proxy. */
  proxyCountry?: string;
  /** Device family from the fingerprint — drives the platform icon
   *  (windows-laptop-intel → 🪟, macbook-pro-14-m3 → ). */
  device?: DeviceFamily;
}

export interface CreateProfileInput {
  name: string;
  notes?: string;
  tags?: string[];
  proxy?: ProxyConfig;
  fingerprint?: Partial<FingerprintConfig>;
}

export interface UpdateProfileInput {
  name?: string;
  notes?: string;
  tags?: string[];
  proxy?: ProxyConfig | null;
  fingerprint?: Partial<FingerprintConfig>;
}

export interface LaunchedProfile {
  id: ProfileId;
  cdpEndpoint: string;
  pid: number;
  startedAt: string;
}

export interface McpToolError {
  code: "PROFILE_NOT_FOUND" | "PROFILE_ALREADY_RUNNING" | "PROFILE_NOT_RUNNING" | "LAUNCH_FAILED" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Status of the bundled / downloaded patched Chromium runtime.
 *
 *   ready          — binary present + verified, ready for spawn
 *   missing        — never downloaded, first run
 *   downloading    — fetch in progress
 *   verifying      — sha256 check after download
 *   error          — last attempt failed; retry or fall back
 *   dev-system     — dev mode, using system Chrome (no patches)
 */
export type ChromiumStatus =
  | { kind: "ready"; version: string; binaryPath: string }
  | { kind: "missing" }
  | { kind: "fetching-manifest" }
  | { kind: "downloading"; bytesReceived: number; bytesTotal: number; version: string }
  | { kind: "verifying"; version: string }
  | { kind: "extracting"; version: string }
  | { kind: "error"; message: string }
  | { kind: "dev-system"; binaryPath: string };

export interface ChromiumManifest {
  version: string;
  /** Direct download URL; we recommend our R2 CDN */
  url: string;
  /** SHA-256 of the downloaded blob (lowercase hex) */
  sha256: string;
  /** Uncompressed size in bytes — used for progress UI when content-length is missing */
  size: number;
}
