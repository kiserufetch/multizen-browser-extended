import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  dataDirPathWarning,
  dataPaths,
  defaultDataDir,
  defaultMaxBrowsers,
  isWildcardHost,
  parseExpiry,
  parseProfileCommand,
  parseSecretsCommand,
  parseServeConfig,
  parseStdioConfig,
  parseTokenCommand,
  UsageError,
  type PlatformFacts,
} from "./config.ts";

const LINUX: PlatformFacts = { platform: "linux", home: "/home/u", inContainer: false };

test("default data dir per platform", () => {
  assert.equal(
    defaultDataDir({ ...LINUX, platform: "win32", home: "C:\\Users\\u" }, { LOCALAPPDATA: "L:\\app" }),
    join("L:\\app", "mzs"),
  );
  assert.equal(
    defaultDataDir({ ...LINUX, platform: "win32", home: "H" }, {}),
    join("H", "AppData", "Local", "mzs"),
  );
  assert.equal(defaultDataDir(LINUX, {}), join("/home/u", ".local", "share", "multizen-server"));
  assert.equal(defaultDataDir({ ...LINUX, inContainer: true }, {}), "/data");
  assert.equal(
    defaultDataDir({ ...LINUX, platform: "darwin" }, {}),
    join("/home/u", ".multizen-server"),
  );
});

test("the layout under a data dir matches the long-path suffix", () => {
  const dataDir = resolve("root");
  const uuid = "00000000-0000-0000-0000-000000000000";
  const browserDir = join(dataPaths(dataDir).profilesRoot, uuid, "engines", "cloakbrowser");
  assert.equal(browserDir.length - dataDir.length, 67);
});

test("long-path check: warns past the limit on Windows only", () => {
  const atLimit = "C:\\" + "x".repeat(120 - 67 - 3);
  assert.equal(atLimit.length, 53);
  assert.equal(dataDirPathWarning(atLimit, "win32"), null);
  const warning = dataDirPathWarning(atLimit + "y", "win32");
  assert.match(warning ?? "", /121 characters/);
  assert.match(warning ?? "", /--data-dir/);
  assert.equal(dataDirPathWarning(atLimit + "y".repeat(500), "linux"), null);
});

test("serve: flags, defaults and environment", () => {
  const defaults = parseServeConfig([], {}, LINUX);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 7777);
  assert.equal(defaults.noAuth, false);
  assert.equal(defaults.defaultEngine, undefined);
  assert.equal(defaults.dataDir, resolve(join("/home/u", ".local", "share", "multizen-server")));

  const env = {
    MULTIZEN_DATA_DIR: "from-env",
    MULTIZEN_PORT: "1234",
    MULTIZEN_DEFAULT_ENGINE: "camoufox",
    MULTIZEN_NO_AUTH: "1",
  };
  const fromEnv = parseServeConfig([], env, LINUX);
  assert.equal(fromEnv.dataDir, resolve("from-env"));
  assert.equal(fromEnv.port, 1234);
  assert.equal(fromEnv.defaultEngine, "camoufox");
  assert.equal(fromEnv.noAuth, true);

  const flags = parseServeConfig(
    ["--data-dir", "from-flag", "--port", "4321", "--default-engine", "cloakbrowser"],
    env,
    LINUX,
  );
  assert.equal(flags.dataDir, resolve("from-flag"));
  assert.equal(flags.port, 4321);
  assert.equal(flags.defaultEngine, "cloakbrowser");
});

test("serve and a local stdio take an uploads root, resolved; flag over env; absent by default", () => {
  assert.equal("uploadsRoot" in parseServeConfig([], {}, LINUX), false);
  assert.equal(
    parseServeConfig([], { MULTIZEN_UPLOADS_ROOT: "from-env" }, LINUX).uploadsRoot,
    resolve("from-env"),
  );
  assert.equal(
    parseServeConfig(["--uploads-root", "from-flag"], { MULTIZEN_UPLOADS_ROOT: "from-env" }, LINUX)
      .uploadsRoot,
    resolve("from-flag"),
  );
  const stdio = parseStdioConfig(["--uploads-root", "u"], {}, LINUX);
  assert.ok(stdio.kind === "local");
  assert.equal(stdio.uploadsRoot, resolve("u"));
  assert.throws(
    () => parseStdioConfig(["--connect", "http://x", "--uploads-root", "u"], {}, LINUX),
    /runs no browsers/,
  );
});

test("serve: localhost binds the IPv4 loopback", () => {
  assert.equal(parseServeConfig(["--host", "localhost"], {}, LINUX).host, "127.0.0.1");
});

for (const [name, argv, pattern] of [
  ["a non-loopback host", ["--host", "0.0.0.0"], /loopback/],
  ["a public address", ["--host", "10.0.0.5"], /loopback/],
  ["port zero", ["--port", "0"], /--port/],
  ["a non-numeric port", ["--port", "abc"], /--port/],
  ["an unknown engine", ["--default-engine", "chrome"], /Unknown engine/],
  ["an unknown flag", ["--allow-everything"], /allow-everything/],
  ["a stray argument", ["extra"], /Unexpected argument/],
] as Array<[string, string[], RegExp]>) {
  test(`serve rejects ${name}`, () => {
    assert.throws(() => parseServeConfig(argv, {}, LINUX), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, pattern);
      return true;
    });
  });
}

const GIB = 1024 ** 3;

test("the browser limit defaults from memory, a gigabyte each after a gigabyte kept back", () => {
  assert.equal(defaultMaxBrowsers(GIB / 2), 1);
  assert.equal(defaultMaxBrowsers(2 * GIB), 1);
  assert.equal(defaultMaxBrowsers(4 * GIB), 3);
  assert.equal(defaultMaxBrowsers(16 * GIB), 15);
  assert.ok(defaultMaxBrowsers() >= 1);
});

test("the browser limit comes from the flag, then the environment, then memory", () => {
  const env = { MULTIZEN_MAX_BROWSERS: "4", MULTIZEN_BROWSER_QUEUE_TIMEOUT_MS: "5000" };
  const fromEnv = parseServeConfig([], env, LINUX);
  assert.equal(fromEnv.maxBrowsers, 4);
  assert.equal(fromEnv.browserQueueTimeoutMs, 5000);

  const fromFlags = parseServeConfig(
    ["--max-browsers", "2", "--browser-queue-timeout-ms", "100"],
    env,
    LINUX,
  );
  assert.equal(fromFlags.maxBrowsers, 2);
  assert.equal(fromFlags.browserQueueTimeoutMs, 100);

  const fromMemory = parseServeConfig([], {}, LINUX);
  assert.equal(fromMemory.maxBrowsers, defaultMaxBrowsers());
  assert.equal(fromMemory.browserQueueTimeoutMs, undefined, "the router's default then");

  const stdio = parseStdioConfig(["--max-browsers", "3"], {}, LINUX);
  assert.equal(stdio.kind === "local" && stdio.maxBrowsers, 3);
});

for (const [flag, value] of [
  ["--max-browsers", "0"],
  ["--max-browsers", "-1"],
  ["--max-browsers", "1.5"],
  ["--max-browsers", "many"],
  ["--browser-queue-timeout-ms", "0"],
  ["--browser-queue-timeout-ms", "soon"],
] as Array<[string, string]>) {
  test(`serve rejects ${flag} ${value}`, () => {
    assert.throws(() => parseServeConfig([`${flag}=${value}`], {}, LINUX), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, new RegExp(flag));
      return true;
    });
  });
}

test("--connect runs no browsers, so it takes no browser limit", () => {
  assert.throws(
    () => parseStdioConfig(["--connect", "http://127.0.0.1:1", "--max-browsers", "2"], {}, LINUX),
    /don't apply/,
  );
});

test("stdio: local by default, --connect switches to the relay", () => {
  assert.deepEqual(parseStdioConfig(["--data-dir", "d", "--max-browsers", "2"], {}, LINUX), {
    maxBrowsers: 2,
    kind: "local",
    dataDir: resolve("d"),
    defaultEngine: undefined,
    displayMode: "auto",
    headless: false,
    egressPolicy: "block-private",
    egressAllow: [],
  });
  assert.deepEqual(
    parseStdioConfig(["--connect", "http://127.0.0.1:7777/mcp", "--token-file", "t"], {}, LINUX),
    { kind: "connect", url: "http://127.0.0.1:7777/mcp", tokenFile: "t" },
  );
});

test("egress: a server blocks private addresses unless told otherwise; flag over env", () => {
  for (const parse of [parseServeConfig, parseStdioConfig]) {
    const defaults = parse([], {}, LINUX) as ReturnType<typeof parseServeConfig>;
    assert.equal(defaults.egressPolicy, "block-private");
    assert.deepEqual(defaults.egressAllow, []);
    const env = { MULTIZEN_EGRESS_POLICY: "allow-all", MULTIZEN_EGRESS_ALLOW: "10.0.0.1, db.lan:5432" };
    const fromEnv = parse([], env, LINUX) as ReturnType<typeof parseServeConfig>;
    assert.equal(fromEnv.egressPolicy, "allow-all");
    assert.deepEqual(fromEnv.egressAllow, ["10.0.0.1", "db.lan:5432"]);
    const flags = parse(
      ["--egress-policy", "block-private", "--egress-allow", "*.lan,10.0.0.0/8,127.0.0.1:80,[::1]:80,fd00::/8"],
      env,
      LINUX,
    ) as ReturnType<typeof parseServeConfig>;
    assert.equal(flags.egressPolicy, "block-private");
    assert.deepEqual(flags.egressAllow, ["*.lan", "10.0.0.0/8", "127.0.0.1:80", "[::1]:80", "fd00::/8"]);
  }
});

for (const [name, argv, pattern] of [
  ["an unknown policy", ["--egress-policy", "block"], /--egress-policy must be one of allow-all, block-private/],
  ["a bad allow entry", ["--egress-allow", "10.0.0.0/33"], /--egress-allow takes/],
  ["a wildcard for everything", ["--egress-allow", "*"], /--egress-allow takes/],
] as Array<[string, string[], RegExp]>) {
  test(`egress: ${name} is a usage error`, () => {
    for (const parse of [parseServeConfig, parseStdioConfig]) {
      assert.throws(() => parse(argv, {}, LINUX), (e: unknown) => e instanceof UsageError && pattern.test(e.message));
    }
  });
}

test("--connect runs no browsers, so the egress flags don't apply", () => {
  for (const flag of [["--egress-policy", "allow-all"], ["--egress-allow", "10.0.0.1"]]) {
    assert.throws(() => parseStdioConfig(["--connect", "http://x", ...flag], {}, LINUX), /runs no browsers/);
  }
});

test("stdio --connect: a bare origin means /mcp", () => {
  assert.deepEqual(parseStdioConfig(["--connect", "http://127.0.0.1:7777"], {}, LINUX), {
    kind: "connect",
    url: "http://127.0.0.1:7777/mcp",
    tokenFile: undefined,
  });
});

for (const [name, argv, pattern] of [
  ["a token file without --connect", ["--token-file", "t"], /only applies with --connect/],
  ["--connect with a data dir", ["--connect", "http://x", "--data-dir", "d"], /runs no browsers/],
  ["--connect with an engine", ["--connect", "http://x", "--default-engine", "camoufox"], /runs no browsers/],
  ["--connect with no URL", ["--connect", "nonsense"], /needs a URL/],
  ["--connect with another scheme", ["--connect", "ftp://x"], /http\(s\)/],
] as Array<[string, string[], RegExp]>) {
  test(`stdio rejects ${name}`, () => {
    assert.throws(() => parseStdioConfig(argv, {}, LINUX), pattern);
  });
}

test("profile: export and import", () => {
  assert.deepEqual(
    parseProfileCommand(["export", "id1", "--out", "o.mzar", "--passphrase-file", "p"], {}, {
      ...LINUX,
      inContainer: true,
    }),
    {
      action: "export",
      dataDir: resolve("/data"),
      profileId: "id1",
      outPath: "o.mzar",
      passphraseFile: "p",
    },
  );
  assert.deepEqual(
    parseProfileCommand(["import", "a.mzar", "--data-dir", "d", "--default-engine", "camoufox"], {}, LINUX),
    {
      action: "import",
      dataDir: resolve("d"),
      archivePath: "a.mzar",
      passphraseFile: undefined,
      defaultEngine: "camoufox",
    },
  );
});

for (const [name, argv, pattern] of [
  ["no action", [], /needs "export" or "import"/],
  ["an unknown action", ["list"], /needs "export" or "import"/],
  ["export with no id", ["export"], /needs a profile id/],
  ["import with no archive", ["import"], /needs an archive path/],
  ["--out on import", ["import", "a", "--out", "o"], /--out only applies/],
  ["an engine on export", ["export", "a", "--default-engine", "camoufox"], /only applies to profile import/],
  ["a passphrase flag, which would show in process lists", ["export", "a", "--passphrase", "x"], /passphrase/],
  ["a stray argument", ["export", "a", "b"], /Unexpected argument/],
] as Array<[string, string[], RegExp]>) {
  test(`profile rejects ${name}`, () => {
    assert.throws(() => parseProfileCommand(argv, {}, LINUX), pattern);
  });
}

test("display flags: auto and not forced by default, on serve and a local stdio", () => {
  for (const parse of [parseServeConfig, parseStdioConfig]) {
    const config = parse([], {}, LINUX) as { displayMode: string; headless: boolean };
    assert.equal(config.displayMode, "auto");
    assert.equal(config.headless, false);
  }
});

test("display flags: the flag wins over the environment", () => {
  const env = { MULTIZEN_DISPLAY_MODE: "xvfb", MULTIZEN_HEADLESS: "1" };
  assert.equal(parseServeConfig([], env, LINUX).displayMode, "xvfb");
  assert.equal(parseServeConfig([], env, LINUX).headless, true);
  assert.equal(parseServeConfig(["--display-mode", "headed"], env, LINUX).displayMode, "headed");
  assert.equal(parseServeConfig(["--headless"], {}, LINUX).headless, true);
  assert.equal(parseServeConfig([], { MULTIZEN_HEADLESS: "0" }, LINUX).headless, false);
  const stdio = parseStdioConfig(["--headless", "--display-mode", "headless"], {}, LINUX);
  assert.deepEqual(
    stdio.kind === "local" ? [stdio.displayMode, stdio.headless] : [],
    ["headless", true],
  );
});

test("display flags: every mode and auto are accepted, nothing else", () => {
  for (const mode of ["auto", "headed", "xvfb", "headless"]) {
    assert.equal(parseServeConfig(["--display-mode", mode], {}, LINUX).displayMode, mode);
  }
  assert.throws(() => parseServeConfig(["--display-mode", "holographic"], {}, LINUX), UsageError);
  assert.throws(() => parseServeConfig([], { MULTIZEN_DISPLAY_MODE: "holographic" }, LINUX), UsageError);
  assert.throws(() => parseServeConfig(["--display-mode", ""], {}, LINUX), UsageError);
});

test("--headless and --display-mode together are fine: the force simply wins at launch", () => {
  const config = parseServeConfig(["--headless", "--display-mode", "headed"], {}, LINUX);
  assert.equal(config.headless, true);
  assert.equal(config.displayMode, "headed");
});

test("--connect runs no browsers, so it takes no display flags", () => {
  for (const flags of [["--headless"], ["--display-mode", "headless"]]) {
    assert.throws(
      () => parseStdioConfig(["--connect", "http://127.0.0.1:1", ...flags], {}, LINUX),
      /--connect runs no browsers/,
    );
  }
});

// ── remote access ────────────────────────────────────────────────────────────

const LAN = ["--host", "10.0.0.5"];
const LAN_ALLOWED = [...LAN, "--allow-remote"];
const TLS_FLAGS = ["--tls-cert", "c.pem", "--tls-key", "k.pem"];
const ANY = ["--host", "0.0.0.0", "--allow-remote", "--allow-insecure-remote"];

for (const [name, argv] of [
  ["loopback, by default", []],
  ["a loopback address of any spelling", ["--host", "127.0.0.2"]],
  ["IPv6 loopback", ["--host", "::1"]],
  ["IPv6 loopback in brackets", ["--host", "[::1]"]],
  ["loopback behind a proxy: only --allowed-hosts", ["--allowed-hosts", "example.test"]],
  ["loopback behind a proxy: only --public-url", ["--public-url", "https://example.test"]],
  ["--allow-remote on loopback, which changes nothing", ["--allow-remote"]],
  ["--no-auth on loopback", ["--no-auth"]],
  ["a LAN address with TLS", [...LAN_ALLOWED, ...TLS_FLAGS]],
  ["a LAN address with plain HTTP, asked for twice", [...LAN_ALLOWED, "--allow-insecure-remote"]],
  ["TLS on loopback", TLS_FLAGS],
  ["any address, with a name for clients to use", [...ANY, "--allowed-hosts", "a.test"]],
  ["any address, with a public URL", [...ANY, "--public-url", "https://a.test"]],
] as Array<[string, string[]]>) {
  test(`serve accepts ${name}`, () => {
    assert.doesNotThrow(() => parseServeConfig(argv, {}, LINUX));
  });
}

for (const [name, argv, pattern] of [
  ["a LAN address alone", LAN, /--allow-remote/],
  ["a LAN address with TLS but no --allow-remote", [...LAN, ...TLS_FLAGS], /--allow-remote/],
  ["a LAN address with only --allow-insecure-remote", [...LAN, "--allow-insecure-remote"], /--allow-remote/],
  ["plain HTTP on a LAN address, asked for once", LAN_ALLOWED, /--allow-insecure-remote/],
  ["a host name that isn't loopback", ["--host", "server.lan"], /--allow-remote/],
  ["IPv6 any address alone", ["--host", "::"], /--allow-remote/],
  ["any address with no name for clients", ANY, /--allowed-hosts or --public-url/],
  ["a certificate with no key", ["--tls-cert", "c.pem"], /only work together/],
  ["a key with no certificate", ["--tls-key", "k.pem"], /only work together/],
  ["--no-auth beyond loopback", ["--no-auth", ...LAN_ALLOWED, "--allow-insecure-remote"], /--no-auth only/],
  ["--no-auth with extra hosts", ["--no-auth", "--allowed-hosts", "a.test"], /--no-auth only/],
  ["--no-auth with a public URL", ["--no-auth", "--public-url", "https://a.test"], /--no-auth only/],
  ["a wildcard in the allowed hosts", ["--allowed-hosts", "*"], /--allowed-hosts/],
  ["a pattern in the allowed hosts", ["--allowed-hosts", "*.example.test"], /--allowed-hosts/],
  ["a URL in the allowed hosts", ["--allowed-hosts", "https://a.test"], /--allowed-hosts/],
  ["a path in the allowed origins", ["--allowed-origins", "https://a.test/x"], /--allowed-origins/],
  ["a non-http origin", ["--allowed-origins", "ftp://a.test"], /--allowed-origins/],
  ["a non-http public URL", ["--public-url", "ftp://a.test"], /--public-url/],
  ["a public URL that isn't one", ["--public-url", "a.test"], /--public-url/],
  ["an empty host", ["--host", ""], /--host/],
  ["a zero session TTL", ["--session-idle-ttl-ms", "0"], /--session-idle-ttl-ms/],
  ["a session limit that isn't a number", ["--max-sessions", "lots"], /--max-sessions/],
] as Array<[string, string[], RegExp]>) {
  test(`serve refuses ${name}`, () => {
    assert.throws(() => parseServeConfig(argv, {}, LINUX), (e: unknown) => {
      assert.ok(e instanceof UsageError, String(e));
      assert.match(e.message, pattern);
      return true;
    });
  });
}

test("server session defaults: 30 minutes idle, 64 sessions; flags and environment override", () => {
  const defaults = parseServeConfig([], {}, LINUX);
  assert.equal(defaults.sessionIdleTtlMs, 30 * 60_000);
  assert.equal(defaults.maxSessions, 64);
  assert.equal(defaults.trustProxy, false);
  assert.deepEqual(defaults.allowedHosts, []);
  assert.deepEqual(defaults.allowedOrigins, []);
  assert.equal("tls" in defaults, false);
  assert.equal("publicUrl" in defaults, false);
  assert.equal(defaults.loopback, true);

  const env = { MULTIZEN_SESSION_IDLE_TTL_MS: "5000", MULTIZEN_MAX_SESSIONS: "2" };
  assert.equal(parseServeConfig([], env, LINUX).sessionIdleTtlMs, 5000);
  assert.equal(parseServeConfig([], env, LINUX).maxSessions, 2);
  const flags = parseServeConfig(["--session-idle-ttl-ms", "7", "--max-sessions", "3"], env, LINUX);
  assert.equal(flags.sessionIdleTtlMs, 7);
  assert.equal(flags.maxSessions, 3);
});

test("remote settings from the environment follow the same rules", () => {
  const remote = {
    MULTIZEN_HOST: "0.0.0.0",
    MULTIZEN_ALLOW_REMOTE: "1",
    MULTIZEN_ALLOW_INSECURE_REMOTE: "1",
    MULTIZEN_ALLOWED_HOSTS: "localhost:7777, 127.0.0.1:7777",
    MULTIZEN_ALLOWED_ORIGINS: "https://app.test",
    MULTIZEN_TRUST_PROXY: "1",
  };
  const config = parseServeConfig([], remote, LINUX);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.loopback, false);
  assert.deepEqual(config.allowedHosts, ["localhost:7777", "127.0.0.1:7777"]);
  assert.deepEqual(config.allowedOrigins, ["https://app.test"]);
  assert.equal(config.trustProxy, true);

  assert.throws(() => parseServeConfig([], { MULTIZEN_HOST: "0.0.0.0" }, LINUX), /--allow-remote/);
  assert.throws(() => parseServeConfig([], { ...remote, MULTIZEN_NO_AUTH: "1" }, LINUX), /--no-auth only/);
  assert.equal(
    parseServeConfig([], { MULTIZEN_TLS_CERT: "c", MULTIZEN_TLS_KEY: "k" }, LINUX).tls?.certPath,
    resolve("c"),
  );
});

test("--public-url joins the allowed hosts and origins, port and all", () => {
  const config = parseServeConfig(
    ["--public-url", "https://Example.test:8443/", "--allowed-hosts", "other.test", "--allowed-origins", "https://app.test"],
    {},
    LINUX,
  );
  assert.equal(config.publicUrl, "https://example.test:8443");
  assert.deepEqual(config.allowedHosts, ["other.test", "example.test:8443"]);
  assert.deepEqual(config.allowedOrigins, ["https://app.test", "https://example.test:8443"]);
  assert.deepEqual(parseServeConfig(["--public-url", "https://a.test"], {}, LINUX).allowedHosts, ["a.test"]);
});

test("allowed hosts: a bare IPv6 address gets its brackets, or no port could be told from it", () => {
  assert.deepEqual(parseServeConfig(["--allowed-hosts", "::1,[::1]:8080,a.test:1"], {}, LINUX).allowedHosts, [
    "[::1]",
    "[::1]:8080",
    "a.test:1",
  ]);
});

test("a wildcard bind is recognised, and TLS paths come back resolved", () => {
  assert.equal(isWildcardHost("0.0.0.0"), true);
  assert.equal(isWildcardHost("::"), true);
  assert.equal(isWildcardHost("10.0.0.5"), false);
  assert.deepEqual(parseServeConfig(TLS_FLAGS, {}, LINUX).tls, {
    certPath: resolve("c.pem"),
    keyPath: resolve("k.pem"),
  });
});

// ── token and secrets commands ───────────────────────────────────────────────

test("token create: read and act by default, on every profile, and never raw", () => {
  const command = parseTokenCommand(["create", "--name", "r"], {}, LINUX);
  assert.ok(command.action === "create");
  assert.deepEqual(command.input.groups, ["read", "act"]);
  assert.deepEqual(command.input.names, []);
  assert.equal(command.input.profiles, "*");
  assert.equal("expiresAt" in command.input, false);
  assert.equal(command.dataDir, resolve(join("/home/u", ".local", "share", "multizen-server")));
});

test("token create: --tools takes groups and tool names; --panel means the operator group", () => {
  const input = (...flags: string[]) => {
    const command = parseTokenCommand(["create", "--name", "n", ...flags], {}, LINUX);
    assert.ok(command.action === "create");
    return command.input;
  };
  assert.deepEqual(input("--tools", "read").groups, ["read"]);
  const mixed = input("--tools", "read, click_ref,raw,cdp_send");
  assert.deepEqual(mixed.groups, ["read", "raw"]);
  assert.deepEqual(mixed.names, ["click_ref", "cdp_send"]);

  assert.deepEqual(input("--panel").groups, ["read", "act", "operator"]);
  assert.deepEqual(input("--panel", "--tools", "read").groups, ["read", "operator"]);
  assert.deepEqual(input("--tools", "operator", "--panel").groups, ["operator"]);

  assert.deepEqual(input("--profiles", "p1, p2").profiles, ["p1", "p2"]);
  assert.equal(input("--profiles", "*").profiles, "*");
});

test("token create: --expires takes a duration or a date, in the future", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  assert.equal(parseExpiry("90s", now).toISOString(), "2026-06-01T00:01:30.000Z");
  assert.equal(parseExpiry("45m", now).toISOString(), "2026-06-01T00:45:00.000Z");
  assert.equal(parseExpiry("12h", now).toISOString(), "2026-06-01T12:00:00.000Z");
  assert.equal(parseExpiry("30d", now).toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(parseExpiry("2027-01-01", now).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.throws(() => parseExpiry("soon", now), /--expires/);
  assert.throws(() => parseExpiry("2020-01-01", now), /in the future/);
  assert.throws(() => parseExpiry("0d", now), /in the future/);

  const command = parseTokenCommand(["create", "--name", "n", "--expires", "1h"], {}, LINUX);
  assert.ok(command.action === "create" && (command.input.expiresAt?.getTime() ?? 0) > Date.now());
});

test("token list and revoke", () => {
  assert.deepEqual(parseTokenCommand(["list", "--data-dir", "d"], {}, LINUX), {
    action: "list",
    dataDir: resolve("d"),
  });
  assert.deepEqual(parseTokenCommand(["revoke", "t_1", "--data-dir", "d"], {}, LINUX), {
    action: "revoke",
    dataDir: resolve("d"),
    target: "t_1",
  });
});

for (const [name, argv, pattern] of [
  ["no action", [], /needs "create", "list" or "revoke"/],
  ["an unknown action", ["rotate"], /needs "create", "list" or "revoke"/],
  ["create with no name", ["create"], /needs --name/],
  ["an unknown tool or group", ["create", "--name", "n", "--tools", "cliks"], /--tools takes groups/],
  ["an empty tool list", ["create", "--name", "n", "--tools", ","], /names nothing/],
  ["an empty profile list", ["create", "--name", "n", "--profiles", ","], /names nothing/],
  ["a stray argument to create", ["create", "x", "--name", "n"], /Unexpected argument/],
  ["revoke with no target", ["revoke"], /needs a token's id or name/],
  ["a create flag on list", ["list", "--name", "n"], /only apply to token create/],
  ["a create flag on revoke", ["revoke", "t", "--panel"], /only apply to token create/],
  ["a stray argument to list", ["list", "x"], /Unexpected argument/],
] as Array<[string, string[], RegExp]>) {
  test(`token rejects ${name}`, () => {
    assert.throws(() => parseTokenCommand(argv, {}, LINUX), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, pattern);
      return true;
    });
  });
}

test("secrets rotate", () => {
  assert.deepEqual(parseSecretsCommand(["rotate", "--data-dir", "d"], {}, LINUX), {
    action: "rotate",
    dataDir: resolve("d"),
  });
  assert.throws(() => parseSecretsCommand([], {}, LINUX), /needs "rotate"/);
  assert.throws(() => parseSecretsCommand(["other"], {}, LINUX), /needs "rotate"/);
  assert.throws(() => parseSecretsCommand(["rotate", "x"], {}, LINUX), /Unexpected argument/);
});
