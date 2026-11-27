import type {
  BrowserEngine,
  ClientHints,
  FingerprintConfig,
  ProfileId,
  ProxyConfig,
} from "./index.js";
import type { CapturedFrame, DriverAction, HumanInputEvent } from "./driver.js";

export const CHALLENGE_KINDS = [
  "turnstile",
  "recaptcha_v2",
  "recaptcha_v3",
  "hcaptcha",
  "geetest",
  "arkose",
  "datadome",
  "custom",
  "unknown",
] as const;

export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export function isChallengeKind(value: unknown): value is ChallengeKind {
  return typeof value === "string" && (CHALLENGE_KINDS as readonly string[]).includes(value);
}

export const PROXY_EXPOSURE_MODES = ["bridge", "raw", "none"] as const;
export type ProxyExposureMode = (typeof PROXY_EXPOSURE_MODES)[number];

export function isProxyExposureMode(value: unknown): value is ProxyExposureMode {
  return typeof value === "string" && (PROXY_EXPOSURE_MODES as readonly string[]).includes(value);
}

export const SOLVER_FALLBACK_POLICIES = [
  "solver-then-human",
  "solver-only",
  "human-only",
] as const;
export type SolverFallbackPolicy = (typeof SOLVER_FALLBACK_POLICIES)[number];

export function isSolverFallbackPolicy(value: unknown): value is SolverFallbackPolicy {
  return (
    typeof value === "string" && (SOLVER_FALLBACK_POLICIES as readonly string[]).includes(value)
  );
}

export const SOLVER_ADAPTER_KINDS = [
  "none",
  "capsolver",
  "2captcha",
  "rucaptcha",
  "webhook",
  "module",
] as const;
export type SolverAdapterKind = (typeof SOLVER_ADAPTER_KINDS)[number];

export function isSolverAdapterKind(value: unknown): value is SolverAdapterKind {
  return typeof value === "string" && (SOLVER_ADAPTER_KINDS as readonly string[]).includes(value);
}

export const PROFILE_SOLVER_MODES = ["inherit", "enabled", "disabled"] as const;
export type ProfileSolverMode = (typeof PROFILE_SOLVER_MODES)[number];

export function isProfileSolverMode(value: unknown): value is ProfileSolverMode {
  return typeof value === "string" && (PROFILE_SOLVER_MODES as readonly string[]).includes(value);
}

export const SOLVER_STRATEGIES = [
  "auto",
  "token-only",
  "interactive-only",
  "token-then-interactive",
] as const;
export type SolverStrategy = (typeof SOLVER_STRATEGIES)[number];

export function isSolverStrategy(value: unknown): value is SolverStrategy {
  return typeof value === "string" && (SOLVER_STRATEGIES as readonly string[]).includes(value);
}

/** Per-profile override for the challenge solver port. */
export interface ProfileSolverConfig {
  mode: ProfileSolverMode;
  adapter?: SolverAdapterKind;
  strategy?: SolverStrategy;
  apiKey?: string;
  apiBaseUrl?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  fallbackPolicy?: SolverFallbackPolicy;
  proxyExposure?: ProxyExposureMode;
  allowMainWorldJs?: boolean;
  timeoutMs?: number;
}

/** App/server-level configuration for the challenge solver port. */
export interface SolverSettings {
  enabled: boolean;
  adapter: SolverAdapterKind;
  strategy?: SolverStrategy;
  webhookUrl?: string;
  webhookSecret?: string;
  apiKey?: string;
  modulePath?: string;
  fallbackPolicy: SolverFallbackPolicy;
  proxyExposure: ProxyExposureMode;
  allowMainWorldJs: boolean;
  timeoutMs: number;
  options?: Record<string, unknown>;
}

export interface ChallengeFrameInfo {
  targetId?: string;
  frameId?: string;
  url: string;
  isCrossOrigin: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ChallengeDescriptor {
  kind: ChallengeKind;
  /** Optional vendor/variant identifier (e.g. "turnstile-managed", "recaptcha-v2-enterprise"). */
  vendor?: string;
  pageUrl: string;
  pageTitle?: string;
  frame?: ChallengeFrameInfo;
  sitekey?: string;
  action?: string;
  dataS?: string;
  rqdata?: string;
  pagedata?: string;
  enterprise?: boolean;
  invisible?: boolean;
  /** Safe DOM attributes collected in an isolated world without touching page JS globals. */
  rawAttributes?: Record<string, string>;
  detectedAt: string;
}

export interface SolverNetworkContext {
  profileId: ProfileId;
  engine: BrowserEngine;
  fingerprint: {
    userAgent: string;
    platform: FingerprintConfig["platform"];
    clientHints: ClientHints;
    locale: string;
    languages: string[];
    acceptLanguage: string;
    timezone: string;
    screen: { width: number; height: number };
    dpr: number;
  };
  /**
   * Local SOCKS5 bridge endpoint for this profile (`socks5://127.0.0.1:<port>`).
   * Present when `proxyExposure` is `"bridge"` or `"raw"` and the profile has a running bridge.
   */
  bridgeProxy?: {
    type: "socks5";
    host: "127.0.0.1";
    port: number;
    url: string;
  };
  /**
   * Raw upstream proxy credentials. Present ONLY when `proxyExposure` is `"raw"`.
   */
  upstreamProxy?: ProxyConfig;
  proxyCountry?: string;
}

export interface SolverTokenPayload {
  /** Solved token value (e.g. g-recaptcha-response, cf-turnstile-response, h-captcha-response). */
  token: string;
  /** Optional explicit CSS selector for the response input/textarea. */
  targetSelector?: string;
  /** Additional key-value fields to populate (e.g. GeeTest lot_number, pass_token, gen_time). */
  extraFields?: Record<string, string>;
  /** Whether to dispatch input/change events (and optional callback when allowMainWorldJs is true). Default true. */
  triggerCallback?: boolean;
}

export interface ApplyTokenResult {
  applied: boolean;
  textareaUpdated?: boolean;
  callbackInvoked?: boolean;
  details?: string;
}

export interface ChallengeTileBounds {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChallengeFrameInspection {
  frameBounds: { x: number; y: number; width: number; height: number };
  promptText?: string;
  exampleBounds?: { x: number; y: number; width: number; height: number };
  challengeType?: "grid" | "canvas" | "checkbox";
  tileBounds?: ChallengeTileBounds[];
  canvasBounds?: { x: number; y: number; width: number; height: number };
  checkboxBounds?: { x: number; y: number; width: number; height: number };
  checkboxChecked?: boolean;
  submitButtonBounds?: { x: number; y: number; width: number; height: number };
  submitButtonText?: string;
  errorText?: string;
  roundSignature?: string;
  loading?: boolean;
  isVisible: boolean;
}

/** Read-only page port exposed to ChallengeDetectorPort. */
export interface SolverPageReadPort {
  readonly profileId: ProfileId;
  readonly engine: BrowserEngine;
  extract(): Promise<{ result: unknown }>;
  captureFrame(opts?: { quality?: number }): Promise<CapturedFrame>;
  /** Captures a specific viewport region (or full viewport if bounds omitted) as a base64-encoded JPEG. */
  captureRegionBase64?(bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string>;
  /** Inspects a child challenge iframe (e.g. "hcaptcha.com") in an isolated world and returns its prompt, tile bounds, and submit button in root-viewport coordinates. */
  inspectChallengeFrame?(frameUrlPattern?: string): Promise<ChallengeFrameInspection | null>;
  listTabs(): Promise<unknown>;
  getCookies(urls?: string[]): Promise<unknown>;
  /** Evaluates a JS expression strictly in an isolated world (invisible to main-world hooks). */
  evaluateIsolatedJs(
    expression: string,
    opts?: { frameUrlPattern?: string },
  ): Promise<unknown>;
}

/** Full hybrid page port (Token + Interactive UI) exposed to CaptchaSolverPort during an active solve task. */
export interface SolverPagePort extends SolverPageReadPort {
  applyToken(payload: SolverTokenPayload): Promise<ApplyTokenResult>;
  setCookies(cookies: unknown[]): Promise<unknown>;
  dispatchInput(event: HumanInputEvent): Promise<void>;
  clickRef(ref: string): Promise<{ ok: true }>;
  typeRef(ref: string, text: string): Promise<{ ok: true }>;
  performAction(action: DriverAction): Promise<{ ok: true }>;
  /**
   * Evaluates a JS expression in the page's main world.
   * Allowed ONLY when `allowMainWorldJs: true` is enabled in the solver policy;
   * otherwise throws MultizenError("FORBIDDEN", ...).
   */
  evaluateMainWorldJs(expression: string): Promise<unknown>;
}

export interface ChallengeDetectorPort {
  detect(
    page: SolverPageReadPort,
    hint?: Partial<ChallengeDescriptor>,
  ): Promise<ChallengeDescriptor | null>;
}

export interface SolverTask {
  taskId: string;
  handoffId?: string;
  profileId: ProfileId;
  reason?: string;
  strategy?: SolverStrategy;
  challenge: ChallengeDescriptor;
  network: SolverNetworkContext;
  createdAt: string;
  expiresAt: string;
}

export type SolverOutcome =
  | {
      status: "solved";
      mode: "token" | "interactive";
      tokenPayload?: SolverTokenPayload;
      notes?: string;
    }
  | {
      status: "unsupported";
      reason: string;
      fallbackToHuman?: boolean;
    }
  | {
      status: "failed";
      reason: string;
      retryable?: boolean;
      fallbackToHuman?: boolean;
    };

export type SolverTaskStatus =
  | "solving"
  | "solved"
  | "failed"
  | "unsupported"
  | "canceled"
  | "handed_off";

export interface SolverTaskRecord {
  taskId: string;
  handoffId?: string;
  profileId: ProfileId;
  adapterId: string;
  challengeKind: ChallengeKind;
  status: SolverTaskStatus;
  reason?: string;
  error?: string;
  createdAt: string;
   expiresAt: string;
  settledAt?: string;
}

export interface CaptchaSolverPort {
  readonly id: string;
  readonly name: string;
  readonly capabilities: {
    kinds: readonly ChallengeKind[];
    modes: readonly ("token" | "interactive")[];
  };
  readonly detector?: ChallengeDetectorPort;
  canSolve?(
    challenge: ChallengeDescriptor,
    network: SolverNetworkContext,
  ): Promise<boolean> | boolean;
  solve(task: SolverTask, page: SolverPagePort, signal: AbortSignal): Promise<SolverOutcome>;
  healthcheck?(): Promise<{ ok: boolean; latencyMs?: number; details?: Record<string, unknown> }>;
  dispose?(): Promise<void>;
}
