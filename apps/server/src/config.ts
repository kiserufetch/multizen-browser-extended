import { existsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { BrowserEngine } from "@multizen/types";
import { isBrowserEngine } from "@multizen/types";

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
} {
  return {
    dbPath: join(dataDir, "profiles.db"),
    profilesRoot: join(dataDir, "profiles"),
    extensionStoreRoot: join(dataDir, "extension-store"),
    ownerTokenPath: join(dataDir, "owner-token"),
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

/** Remote binding has its own rules and arrives with the token store. */
function parseLoopbackHost(value: string): string {
  if (value === "127.0.0.1" || value === "localhost") return "127.0.0.1";
  throw new UsageError(`--host must be a loopback address (127.0.0.1 or localhost), got "${value}"`);
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

function uploadsRootField(flags: ParsedFlags, env: Env): { uploadsRoot?: string } {
  const uploadsRoot = flags.flag("uploads-root") ?? env.MULTIZEN_UPLOADS_ROOT;
  return uploadsRoot ? { uploadsRoot: resolve(uploadsRoot) } : {};
}

export function parseServeConfig(
  argv: string[],
  env: Env = process.env,
  facts: PlatformFacts = currentPlatform(),
): ServerConfig {
  const flags = parseFlags(argv, {
    ...DATA_DIR_OPTIONS,
    host: { type: "string" },
    port: { type: "string" },
    "no-auth": { type: "boolean" },
    "uploads-root": { type: "string" },
    ...BROWSER_LIMIT_OPTIONS,
  });
  rejectPositionals(flags.positionals);
  return {
    dataDir: resolveDataDir(flags, env, facts),
    host: parseLoopbackHost(flags.flag("host") ?? env.MULTIZEN_HOST ?? "127.0.0.1"),
    port: parsePort(flags.flag("port") ?? env.MULTIZEN_PORT ?? "7777"),
    noAuth: flags.isSet("no-auth") || env.MULTIZEN_NO_AUTH === "1",
    defaultEngine: resolveDefaultEngine(flags, env),
    ...uploadsRootField(flags, env),
    ...browserLimitFields(flags, env),
  };
}

export type StdioConfig =
  | ({ kind: "local"; dataDir: string; defaultEngine?: BrowserEngine; uploadsRoot?: string } & Pick<
      ServerConfig,
      "maxBrowsers" | "browserQueueTimeoutMs"
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
    };
  }

  if (
    ["data-dir", "default-engine", "uploads-root", "max-browsers", "browser-queue-timeout-ms"].some(
      (flag) => flags.isSet(flag),
    )
  ) {
    throw new UsageError(
      "--connect runs no browsers: --data-dir, --default-engine, --uploads-root, --max-browsers and --browser-queue-timeout-ms don't apply",
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
