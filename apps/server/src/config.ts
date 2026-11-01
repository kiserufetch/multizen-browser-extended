import { existsSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { homedir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  policedToolNames,
  TOOL_GROUPS,
  type CreateTokenInput,
  type ToolGroup,
} from "@multizen/mcp-server";
import { EGRESS_MODES, isEgressMode, parseEgressAllowEntry, type EgressMode } from "@multizen/browser-runtime";
import type { BrowserEngine, DisplayModeSetting } from "@multizen/types";
import { DISPLAY_MODES, isBrowserEngine, isDisplayMode } from "@multizen/types";

/** Bad flags or values: reported as such, exit code 2. */
export class UsageError extends Error {}

export interface ServerConfig {
  dataDir: string;
  host: string;
  port: number;
  noAuth: boolean;
  /** Overrides the stored setting for profiles that haven't pinned an engine. */
  defaultEngine?: BrowserEngine;
  /** A directory upload_file may read from, besides each profile's uploads dir. */
  uploadsRoot?: string;
  /** Browsers at once, over both engines. */
  maxBrowsers: number;
  /** How long a launch waits for a free slot before BROWSER_LIMIT_REACHED. Default: the router's. */
  browserQueueTimeoutMs?: number;
  /** The mode when nothing else names one: below the launch's own, the profile's and the setting. */
  displayMode: DisplayModeSetting;
  /** No windows, whatever a profile has saved. An explicit request for one is refused. */
  headless: boolean;
  /** Where browsers may connect. A server blocks private addresses unless told otherwise. */
  egressPolicy: EgressMode;
  /** Exceptions to `block-private`: IPs, CIDRs, names, `*.suffix`, each with an optional `:port`. */
  egressAllow: string[];
  /** Bound to a loopback address. */
  loopback: boolean;
  /** Host header values to accept besides the bind address and loopback. */
  allowedHosts: string[];
  /** Origins to accept besides those of the allowed hosts. */
  allowedOrigins: string[];
  /** Where clients reach this server, if a proxy or a name stands in front of it. */
  publicUrl?: string;
  tls?: { certPath: string; keyPath: string };
  /** A proxy of ours is in front: failed logins count against X-Forwarded-For's rightmost hop. */
  trustProxy: boolean;
  /** A session with no call in flight and no request for this long is closed. */
  sessionIdleTtlMs: number;
  maxSessions: number;
}

export type Env = Record<string, string | undefined>;

export interface PlatformFacts {
  platform: NodeJS.Platform;
  home: string;
  /** Inside a Docker or Podman container. */
  inContainer: boolean;
}

function currentPlatform(): PlatformFacts {
  return {
    platform: process.platform,
    home: homedir(),
    inContainer:
      process.platform === "linux" &&
      (existsSync("/.dockerenv") || existsSync("/run/.containerenv")),
  };
}

/** Short on Windows on purpose: see {@link dataDirPathWarning}. */
export function defaultDataDir(facts: PlatformFacts, env: Env): string {
  if (facts.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(facts.home, "AppData", "Local"), "mzs");
  }
  if (facts.platform === "darwin") return join(facts.home, ".multizen-server");
  if (facts.inContainer) return "/data";
  return join(facts.home, ".local", "share", "multizen-server");
}

/** Where everything lives under a data dir. */
export function dataPaths(dataDir: string): {
  dbPath: string;
  profilesRoot: string;
  extensionStoreRoot: string;
  ownerTokenPath: string;
  tokensPath: string;
  secretKeyPath: string;
} {
  return {
    dbPath: join(dataDir, "profiles.db"),
    profilesRoot: join(dataDir, "profiles"),
    extensionStoreRoot: join(dataDir, "extension-store"),
    ownerTokenPath: join(dataDir, "owner-token"),
    tokensPath: join(dataDir, "tokens.json"),
    secretKeyPath: join(dataDir, "secret.key"),
  };
}

/** `\profiles\<uuid>\engines\cloakbrowser`, the deepest path under a data dir. */
const USER_DATA_SUFFIX_LENGTH = 67;
const SAFE_USER_DATA_DIR_LENGTH = 120;

/**
 * Chromium with a long --user-data-dir fails silently on Windows: the process
 * runs, the debugging port never opens, and the launch times out with no error
 * from the browser (seen on CloakBrowser 146 in the headless spike).
 */
export function dataDirPathWarning(dataDir: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const length = dataDir.length + USER_DATA_SUFFIX_LENGTH;
  if (length <= SAFE_USER_DATA_DIR_LENGTH) return null;
  return (
    `The data directory path is long: a profile's browser directory would be ${length} characters ` +
    `(safe up to ${SAFE_USER_DATA_DIR_LENGTH}). Chromium fails silently on long paths here, with the ` +
    "debugging port never opening. Use a shorter --data-dir."
  );
}

const GIB = 1024 ** 3;
/** Left for the system and this server. */
const MEMORY_RESERVE_BYTES = GIB;
/** A busy page and its browser take about this much. */
const MEMORY_PER_BROWSER_BYTES = GIB;

/** What a container's limit leaves, where there is one: totalmem reports the whole host. */
function usableMemoryBytes(): number {
  const constrained = process.constrainedMemory();
  const total = totalmem();
  return constrained > 0 && constrained < total ? constrained : total;
}

/** Past this a machine thrashes and every browser on it gets slow, so it isn't unlimited. */
export function defaultMaxBrowsers(memoryBytes: number = usableMemoryBytes()): number {
  return Math.max(1, Math.floor((memoryBytes - MEMORY_RESERVE_BYTES) / MEMORY_PER_BROWSER_BYTES));
}

function parsePositiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`${flag} must be a positive whole number, got "${value}"`);
  }
  return n;
}

function parseEngine(value: string | undefined): BrowserEngine | undefined {
  if (value === undefined) return undefined;
  if (!isBrowserEngine(value)) throw new UsageError(`Unknown engine "${value}"`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port must be between 1 and 65535, got "${value}"`);
  }
  return port;
}

function parseBindHost(value: string): string {
  const host = value.replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost") return "127.0.0.1";
  if (!host || /[\s/]/.test(host)) throw new UsageError(`--host needs an address, got "${value}"`);
  return host;
}

function isLoopbackHost(host: string): boolean {
  return host === "::1" || (isIPv4(host) && host.startsWith("127."));
}

export function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** A wildcard stays refused here: it would turn the DNS-rebinding check off. */
function parseAllowedHost(value: string): string {
  if (isIPv6(value)) return `[${value}]`;
  if (!/^(\[[0-9a-fA-F:.]+\]|[^\s:/*[\]]+)(:\d+)?$/.test(value)) {
    throw new UsageError(`--allowed-hosts takes names or name:port, got "${value}"`);
  }
  return value;
}

function parseHttpUrl(flag: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`${flag} needs an http(s) URL, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${flag} needs an http(s) URL, got "${value}"`);
  }
  return url;
}

function parseAllowedOrigin(value: string): string {
  const url = parseHttpUrl("--allowed-origins", value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new UsageError(`--allowed-origins takes origins, with no path, got "${value}"`);
  }
  return url.origin;
}

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

interface ParsedFlags {
  flag(name: string): string | undefined;
  isSet(name: string): boolean;
  positionals: string[];
}

function parseFlags(argv: string[], options: NonNullable<ParseArgsConfig["options"]>): ParsedFlags {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  return {
    flag: (name) => values[name] as string | undefined,
    isSet: (name) => values[name] !== undefined,
    positionals,
  };
}

function rejectPositionals(positionals: string[]): void {
  if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}"`);
}

const DATA_DIR_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  "data-dir": { type: "string" },
  "default-engine": { type: "string" },
};

function resolveDataDir(flags: ParsedFlags, env: Env, facts: PlatformFacts): string {
  return resolve(flags.flag("data-dir") ?? env.MULTIZEN_DATA_DIR ?? defaultDataDir(facts, env));
}

function resolveDefaultEngine(flags: ParsedFlags, env: Env): BrowserEngine | undefined {
  return parseEngine(flags.flag("default-engine") ?? env.MULTIZEN_DEFAULT_ENGINE);
}

const BROWSER_LIMIT_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  "max-browsers": { type: "string" },
  "browser-queue-timeout-ms": { type: "string" },
};

function browserLimitFields(
  flags: ParsedFlags,
  env: Env,
): Pick<ServerConfig, "maxBrowsers" | "browserQueueTimeoutMs"> {
  const max = flags.flag("max-browsers") ?? env.MULTIZEN_MAX_BROWSERS;
  const wait = flags.flag("browser-queue-timeout-ms") ?? env.MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS;
  return {
    maxBrowsers: max === undefined ? defaultMaxBrowsers() : parsePositiveInt("--max-browsers", max),
    ...(wait !== undefined
      ? { browserQueueTimeoutMs: parsePositiveInt("--browser-queue-timeout-ms", wait) }
      : {}),
  };
}

const DISPLAY_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  "display-mode": { type: "string" },
  headless: { type: "boolean" },
};

function displayFields(flags: ParsedFlags, env: Env): Pick<ServerConfig, "displayMode" | "headless"> {
  const mode = flags.flag("display-mode") ?? env.MULTIZEN_DISPLAY_MODE ?? "auto";
  if (mode !== "auto" && !isDisplayMode(mode)) {
    throw new UsageError(
      `--display-mode must be one of auto, ${DISPLAY_MODES.join(", ")}, got "${mode}"`,
    );
  }
  return { displayMode: mode, headless: flags.isSet("headless") || env.MULTIZEN_HEADLESS === "1" };
}

const EGRESS_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  "egress-policy": { type: "string" },
  "egress-allow": { type: "string" },
};

function egressFields(flags: ParsedFlags, env: Env): Pick<ServerConfig, "egressPolicy" | "egressAllow"> {
  const egressPolicy = flags.flag("egress-policy") ?? env.MULTIZEN_EGRESS_POLICY ?? "block-private";
  if (!isEgressMode(egressPolicy)) {
    throw new UsageError(`--egress-policy must be one of ${EGRESS_MODES.join(", ")}, got "${egressPolicy}"`);
  }
  const egressAllow = commaList(flags.flag("egress-allow") ?? env.MULTIZEN_EGRESS_ALLOW);
  for (const entry of egressAllow) {
    try {
      parseEgressAllowEntry(entry);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  return { egressPolicy, egressAllow };
}

function uploadsRootField(flags: ParsedFlags, env: Env): { uploadsRoot?: string } {
  const uploadsRoot = flags.flag("uploads-root") ?? env.MULTIZEN_UPLOADS_ROOT;
  return uploadsRoot ? { uploadsRoot: resolve(uploadsRoot) } : {};
}

const REMOTE_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  host: { type: "string" },
  "allow-remote": { type: "boolean" },
  "allow-insecure-remote": { type: "boolean" },
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  "allowed-hosts": { type: "string" },
  "allowed-origins": { type: "string" },
  "public-url": { type: "string" },
  "trust-proxy": { type: "boolean" },
  "no-auth": { type: "boolean" },
};

/**
 * Who may reach this server, and the rules that keep it from reaching too far: a
 * non-loopback bind must be asked for, and over plain HTTP asked for twice. That at
 * least one token exists is checked at start, with the store open (serve.ts).
 */
function remoteFields(
  flags: ParsedFlags,
  env: Env,
): Pick<
  ServerConfig,
  | "host"
  | "loopback"
  | "noAuth"
  | "allowedHosts"
  | "allowedOrigins"
  | "publicUrl"
  | "tls"
  | "trustProxy"
> {
  const host = parseBindHost(flags.flag("host") ?? env.MULTIZEN_HOST ?? "127.0.0.1");
  const loopback = isLoopbackHost(host);
  const noAuth = flags.isSet("no-auth") || env.MULTIZEN_NO_AUTH === "1";

  const publicUrlValue = flags.flag("public-url") ?? env.MULTIZEN_PUBLIC_URL;
  const publicUrl = publicUrlValue ? parseHttpUrl("--public-url", publicUrlValue) : undefined;
  const allowedHosts = [
    ...commaList(flags.flag("allowed-hosts") ?? env.MULTIZEN_ALLOWED_HOSTS).map(parseAllowedHost),
    ...(publicUrl ? [publicUrl.host] : []),
  ];
  const allowedOrigins = [
    ...commaList(flags.flag("allowed-origins") ?? env.MULTIZEN_ALLOWED_ORIGINS).map(parseAllowedOrigin),
    ...(publicUrl ? [publicUrl.origin] : []),
  ];

  const certPath = flags.flag("tls-cert") ?? env.MULTIZEN_TLS_CERT;
  const keyPath = flags.flag("tls-key") ?? env.MULTIZEN_TLS_KEY;
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new UsageError("--tls-cert and --tls-key only work together");
  }

  if (noAuth && (!loopback || allowedHosts.length > 0)) {
    throw new UsageError("--no-auth only works on a loopback address with no extra allowed hosts");
  }
  if (!loopback) {
    if (!flags.isSet("allow-remote") && env.MULTIZEN_ALLOW_REMOTE !== "1") {
      throw new UsageError(
        `--host ${host} is not a loopback address: binding it needs --allow-remote, ` +
          "and --tls-cert with --tls-key, or --allow-insecure-remote",
      );
    }
    if (
      certPath === undefined &&
      !flags.isSet("allow-insecure-remote") &&
      env.MULTIZEN_ALLOW_INSECURE_REMOTE !== "1"
    ) {
      throw new UsageError(
        `Plain HTTP on ${host} would send tokens readable across the network: ` +
          "give --tls-cert and --tls-key, or say --allow-insecure-remote",
      );
    }
    if (isWildcardHost(host) && allowedHosts.length === 0) {
      throw new UsageError(
        `--host ${host} names no address clients could use: say which with --allowed-hosts or --public-url`,
      );
    }
  }

  return {
    host,
    loopback,
    noAuth,
    allowedHosts,
    allowedOrigins,
    ...(publicUrl ? { publicUrl: publicUrl.href.replace(/\/$/, "") } : {}),
    ...(certPath !== undefined && keyPath !== undefined
      ? { tls: { certPath: resolve(certPath), keyPath: resolve(keyPath) } }
      : {}),
    trustProxy: flags.isSet("trust-proxy") || env.MULTIZEN_TRUST_PROXY === "1",
  };
}

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 64;

export function parseServeConfig(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): ServerConfig {
  const flags = parseFlags(argv, {
    ...DATA_DIR_OPTIONS,
    ...REMOTE_OPTIONS,
    port: { type: "string" },
    "session-idle-ttl-ms": { type: "string" },
    "max-sessions": { type: "string" },
    "uploads-root": { type: "string" },
    ...BROWSER_LIMIT_OPTIONS,
    ...DISPLAY_OPTIONS,
    ...EGRESS_OPTIONS,
  });
  rejectPositionals(flags.positionals);
  const idleTtl = flags.flag("session-idle-ttl-ms") ?? env.MULTIZEN_SESSION_IDLE_TTL_MS;
  const maxSessions = flags.flag("max-sessions") ?? env.MULTIZEN_MAX_SESSIONS;
  return {
    dataDir: resolveDataDir(flags, env, facts),
    ...remoteFields(flags, env),
    port: parsePort(flags.flag("port") ?? env.MULTIZEN_PORT ?? "7777"),
    sessionIdleTtlMs:
      idleTtl === undefined
        ? DEFAULT_SESSION_IDLE_TTL_MS
        : parsePositiveInt("--session-idle-ttl-ms", idleTtl),
    maxSessions:
      maxSessions === undefined ? DEFAULT_MAX_SESSIONS : parsePositiveInt("--max-sessions", maxSessions),
    defaultEngine: resolveDefaultEngine(flags, env),
    ...uploadsRootField(flags, env),
    ...browserLimitFields(flags, env),
    ...displayFields(flags, env),
    ...egressFields(flags, env),
  };
}

export type StdioConfig =
  | ({ kind: "local"; dataDir: string; defaultEngine?: BrowserEngine; uploadsRoot?: string } & Pick<
      ServerConfig,
      "maxBrowsers" | "browserQueueTimeoutMs" | "displayMode" | "headless" | "egressPolicy" | "egressAllow"
    >)
  | { kind: "connect"; url: string; tokenFile?: string };

export function parseStdioConfig(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): StdioConfig {
  const flags = parseFlags(argv, {
    ...DATA_DIR_OPTIONS,
    connect: { type: "string" },
    "token-file": { type: "string" },
    "uploads-root": { type: "string" },
    ...BROWSER_LIMIT_OPTIONS,
    ...DISPLAY_OPTIONS,
    ...EGRESS_OPTIONS,
  });
  rejectPositionals(flags.positionals);

  const connect = flags.flag("connect");
  const tokenFile = flags.flag("token-file");
  if (connect === undefined) {
    if (tokenFile !== undefined) throw new UsageError("--token-file only applies with --connect");
    return {
      kind: "local",
      dataDir: resolveDataDir(flags, env, facts),
      defaultEngine: resolveDefaultEngine(flags, env),
      ...uploadsRootField(flags, env),
      ...browserLimitFields(flags, env),
      ...displayFields(flags, env),
      ...egressFields(flags, env),
    };
  }

  const browserFlags = [
    "data-dir",
    "default-engine",
    "uploads-root",
    "max-browsers",
    "browser-queue-timeout-ms",
    "display-mode",
    "headless",
    "egress-policy",
    "egress-allow",
  ];
  if (browserFlags.some((flag) => flags.isSet(flag))) {
    throw new UsageError(
      `--connect runs no browsers: ${browserFlags.map((flag) => `--${flag}`).join(", ")} don't apply`,
    );
  }
  let url: URL;
  try {
    url = new URL(connect);
  } catch {
    throw new UsageError(`--connect needs a URL, got "${connect}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--connect needs an http(s) URL, got "${connect}"`);
  }
  if (url.pathname === "/") url.pathname = "/mcp";
  return { kind: "connect", url: url.href, tokenFile };
}

export type ProfileCommand =
  | {
      action: "export";
      dataDir: string;
      profileId: string;
      outPath?: string;
      passphraseFile?: string;
    }
  | {
      action: "import";
      dataDir: string;
      archivePath: string;
      passphraseFile?: string;
      defaultEngine?: BrowserEngine;
    };

export function parseProfileCommand(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): ProfileCommand {
  const flags = parseFlags(argv, {
    ...DATA_DIR_OPTIONS,
    out: { type: "string" },
    "passphrase-file": { type: "string" },
  });
  const [action, target, extra] = flags.positionals;
  if (extra !== undefined) throw new UsageError(`Unexpected argument "${extra}"`);
  const dataDir = resolveDataDir(flags, env, facts);
  const passphraseFile = flags.flag("passphrase-file");

  if (action === "export") {
    if (!target) throw new UsageError("profile export needs a profile id");
    if (flags.isSet("default-engine")) {
      throw new UsageError("--default-engine only applies to profile import");
    }
    return { action, dataDir, profileId: target, outPath: flags.flag("out"), passphraseFile };
  }
  if (action === "import") {
    if (!target) throw new UsageError("profile import needs an archive path");
    if (flags.isSet("out")) throw new UsageError("--out only applies to profile export");
    return {
      action,
      dataDir,
      archivePath: target,
      passphraseFile,
      defaultEngine: resolveDefaultEngine(flags, env),
    };
  }
  throw new UsageError(`profile needs "export" or "import", got "${action ?? ""}"`);
}

export type TokenCommand =
  | { action: "create"; dataDir: string; input: CreateTokenInput }
  | { action: "list"; dataDir: string }
  | { action: "revoke"; dataDir: string; target: string };

const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30d`, `12h`, `45m`, `90s`, or a date. */
export function parseExpiry(value: string, now: number = Date.now()): Date {
  const duration = /^(\d+)([smhd])$/.exec(value);
  const at = duration
    ? now + Number(duration[1]) * DURATION_UNIT_MS[duration[2]!]!
    : Date.parse(value);
  if (Number.isNaN(at)) {
    throw new UsageError(`--expires takes a duration like 30d or a date, got "${value}"`);
  }
  if (at <= now) throw new UsageError(`--expires must be in the future, got "${value}"`);
  return new Date(at);
}

const TOKEN_DEFAULT_GROUPS: ToolGroup[] = ["read", "act"];

function parseTokenTools(value: string | undefined, panel: boolean): { groups: ToolGroup[]; names: string[] } {
  const groups: ToolGroup[] = [];
  const names: string[] = [];
  for (const item of value === undefined ? TOKEN_DEFAULT_GROUPS : commaList(value)) {
    if ((TOOL_GROUPS as readonly string[]).includes(item)) groups.push(item as ToolGroup);
    else if (policedToolNames().includes(item)) names.push(item);
    else {
      throw new UsageError(
        `--tools takes groups (${TOOL_GROUPS.join(", ")}) or tool names, got "${item}"`,
      );
    }
  }
  if (groups.length === 0 && names.length === 0) throw new UsageError("--tools names nothing");
  // Panel access has no field of its own: it comes with the operator group.
  if (panel && !groups.includes("operator")) groups.push("operator");
  return { groups, names };
}

export function parseTokenCommand(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): TokenCommand {
  const flags = parseFlags(argv, {
    "data-dir": { type: "string" },
    name: { type: "string" },
    tools: { type: "string" },
    profiles: { type: "string" },
    panel: { type: "boolean" },
    expires: { type: "string" },
  });
  const [action, target, extra] = flags.positionals;
  if (extra !== undefined) throw new UsageError(`Unexpected argument "${extra}"`);
  const dataDir = resolveDataDir(flags, env, facts);
  const createOnly = ["name", "tools", "profiles", "panel", "expires"];

  if (action === "create") {
    if (target !== undefined) throw new UsageError(`Unexpected argument "${target}"`);
    const name = flags.flag("name");
    if (!name) throw new UsageError("token create needs --name");
    const profiles = flags.flag("profiles");
    const expires = flags.flag("expires");
    const tools = parseTokenTools(flags.flag("tools"), flags.isSet("panel"));
    const ids = commaList(profiles);
    if (profiles !== undefined && ids.length === 0) throw new UsageError("--profiles names nothing");
    return {
      action,
      dataDir,
      input: {
        name,
        groups: tools.groups,
        names: tools.names,
        profiles: profiles === undefined || ids.includes("*") ? "*" : ids,
        ...(expires !== undefined ? { expiresAt: parseExpiry(expires) } : {}),
      },
    };
  }
  if (createOnly.some((flag) => flags.isSet(flag))) {
    throw new UsageError(`${createOnly.map((flag) => `--${flag}`).join(", ")} only apply to token create`);
  }
  if (action === "list") {
    if (target !== undefined) throw new UsageError(`Unexpected argument "${target}"`);
    return { action, dataDir };
  }
  if (action === "revoke") {
    if (!target) throw new UsageError("token revoke needs a token's id or name");
    return { action, dataDir, target };
  }
  throw new UsageError(`token needs "create", "list" or "revoke", got "${action ?? ""}"`);
}

export interface SecretsCommand {
  action: "rotate";
  dataDir: string;
}

export function parseSecretsCommand(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): SecretsCommand {
  const flags = parseFlags(argv, { "data-dir": { type: "string" } });
  const [action, extra] = flags.positionals;
  if (extra !== undefined) throw new UsageError(`Unexpected argument "${extra}"`);
  if (action !== "rotate") throw new UsageError(`secrets needs "rotate", got "${action ?? ""}"`);
  return { action, dataDir: resolveDataDir(flags, env, facts) };
}
