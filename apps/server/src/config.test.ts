import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  dataDirPathWarning,
  dataPaths,
  defaultDataDir,
  parseProfileCommand,
  parseServeConfig,
  parseStdioConfig,
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

test("serve: localhost binds the IPv4 loopback", () => {
  assert.equal(parseServeConfig(["--host", "localhost"], {}, LINUX).host, "127.0.0.1");
});

for (const [name, argv, pattern] of [
  ["a non-loopback host", ["--host", "0.0.0.0"], /loopback/],
  ["a public address", ["--host", "10.0.0.5"], /loopback/],
  ["port zero", ["--port", "0"], /--port/],
  ["a non-numeric port", ["--port", "abc"], /--port/],
  ["an unknown engine", ["--default-engine", "chrome"], /Unknown engine/],
  ["a flag from a later stage", ["--display-mode", "headed"], /display-mode/],
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

test("stdio: local by default, --connect switches to the relay", () => {
  assert.deepEqual(parseStdioConfig(["--data-dir", "d"], {}, LINUX), {
    kind: "local",
    dataDir: resolve("d"),
    defaultEngine: undefined,
  });
  assert.deepEqual(
    parseStdioConfig(["--connect", "http://127.0.0.1:7777/mcp", "--token-file", "t"], {}, LINUX),
    { kind: "connect", url: "http://127.0.0.1:7777/mcp", tokenFile: "t" },
  );
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
