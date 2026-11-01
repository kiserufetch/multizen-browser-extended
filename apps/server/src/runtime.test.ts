import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileManager } from "@multizen/profile-manager";
import type { ExtensionConfig } from "@multizen/types";
import { dataPaths } from "./config.ts";
import {
  buildRuntime,
  DataDirMismatchError,
  engineProgressLogger,
  enginesInUse,
  openProfiles,
  SERVER_FIREFOX_OPTIONS,
  serverDisabledFeatures,
  serverFirefoxPrefs,
  type ServerRuntime,
} from "./runtime.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** A data dir whose engine looks installed, so ensure() stays offline. */
function dataDirWithEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-rt-"));
  const cache = join(dir, "chromium", "cloakbrowser");
  mkdirSync(join(cache, "146.0.0.0"), { recursive: true });
  writeFileSync(join(cache, "146.0.0.0", "chrome.exe"), "");
  writeFileSync(
    join(cache, "current.json"),
    JSON.stringify({ version: "146.0.0.0", binaryRelative: "chrome.exe" }),
  );
  return dir;
}

async function withRuntime<T>(
  fn: (runtime: ServerRuntime, dir: string) => Promise<T>,
  prepare: (dir: string) => void = () => {},
  defaultEngine?: "cloakbrowser" | "camoufox",
): Promise<T> {
  const dir = dataDirWithEngine();
  prepare(dir);
  const runtime = await buildRuntime({ dataDir: dir, defaultEngine });
  try {
    return await fn(runtime, dir);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the layout sits directly under the data dir", async () => {
  await withRuntime(async (runtime, dir) => {
    const profile = runtime.profileManager.create({ name: "a" });
    assert.equal(profile.dataDir, join(dir, "profiles", profile.id));
    assert.equal(existsSync(join(dir, "profiles.db")), true);
    await runtime.settings.update({});
    assert.equal(existsSync(join(dir, "settings.json")), true);
  });
});

test("--default-engine overrides the stored setting", async () => {
  await withRuntime(
    async (runtime) => {
      assert.equal(runtime.getDefaultEngine(), "camoufox");
      assert.equal(runtime.driver.isRunning("nope"), false);
    },
    (dir) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ browserEngine: "cloakbrowser" }));
    },
    "camoufox",
  );
});

test("without the flag the stored setting decides", async () => {
  await withRuntime(
    async (runtime) => assert.equal(runtime.getDefaultEngine(), "camoufox"),
    (dir) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ browserEngine: "camoufox" }));
    },
  );
});

test("building touches no engine; the bootstrap brings the default one up", async () => {
  await withRuntime(async (runtime) => {
    assert.deepEqual(runtime.engineRegistry.instantiatedEngines(), []);
    runtime.startEngineBootstrap();
    await eventually(
      () => runtime.engineRegistry.getStatus("cloakbrowser").kind === "ready",
      "the engine to be ready",
    );
  });
});

test("Playwright's signal handlers stay off, so it can't exit the process", () => {
  assert.deepEqual(SERVER_FIREFOX_OPTIONS.launchExtras, {
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
});

test("the occlusion tracker is off on Windows only, and only here", async () => {
  assert.deepEqual(serverDisabledFeatures("win32"), ["CalculateNativeWinOcclusion"]);
  assert.deepEqual(serverDisabledFeatures("linux"), []);
  assert.deepEqual(serverDisabledFeatures("darwin"), []);
  await withRuntime(async (runtime) => {
    const chromium = (
      runtime.driver as unknown as { chromiumDriver: { extraDisabledFeatures: unknown } }
    ).chromiumDriver;
    assert.deepEqual(chromium.extraDisabledFeatures, serverDisabledFeatures(process.platform));
  });
});

test("Camoufox's occlusion tracker is off on Windows only, and reaches the router", async () => {
  assert.deepEqual(serverFirefoxPrefs("win32"), {
    "widget.windows.window_occlusion_tracking.enabled": false,
  });
  assert.deepEqual(serverFirefoxPrefs("linux"), {});
  assert.deepEqual(serverFirefoxPrefs("darwin"), {});
  await withRuntime(async (runtime) => {
    const { firefoxOptions } = runtime.driver as unknown as {
      firefoxOptions: { extraPrefs: unknown; launchExtras: unknown };
    };
    assert.deepEqual(firefoxOptions.extraPrefs, serverFirefoxPrefs(process.platform));
    assert.deepEqual(firefoxOptions.launchExtras, SERVER_FIREFOX_OPTIONS.launchExtras);
  });
});

test("the egress policy is one object, known to both drivers and to the tools", async () => {
  const dir = dataDirWithEngine();
  const runtime = await buildRuntime({
    dataDir: dir,
    egressPolicy: "block-private",
    egressAllow: ["127.0.0.1:1"],
  } as Parameters<typeof buildRuntime>[0]);
  try {
    assert.equal(runtime.egress.enforced, true);
    const router = runtime.driver as unknown as {
      chromiumDriver: { egress: unknown };
      firefoxOptions: { egress: unknown };
    };
    assert.equal(router.chromiumDriver.egress, runtime.egress);
    assert.equal(router.firefoxOptions.egress, runtime.egress);
    assert.equal(runtime.egress.checkProxied("127.0.0.1", 1).allowed, true);
    assert.equal(runtime.egress.checkProxied("127.0.0.1", 2).allowed, false);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("--egress-policy allow-all: the drivers have nothing to enforce", async () => {
  const dir = dataDirWithEngine();
  const runtime = await buildRuntime({
    dataDir: dir,
    egressPolicy: "allow-all",
    egressAllow: [],
  } as Parameters<typeof buildRuntime>[0]);
  try {
    assert.equal(runtime.egress.enforced, false);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("a launch during an engine install is refused, not left blocking a client", async () => {
  await withRuntime(async (runtime) => {
    assert.equal(
      (runtime.driver as unknown as { engineNotReady: unknown }).engineNotReady,
      "reject",
    );
  });
});

test("no companion: nothing wires its install button and the host has no resource", async () => {
  await withRuntime(async (runtime) => {
    const chromium = (runtime.driver as unknown as { chromiumDriver: { onCompanionInstall?: unknown } })
      .chromiumDriver;
    assert.equal(chromium.onCompanionInstall, undefined);
  });
});

test("the desktop-only services are absent from the server's sources", () => {
  const sources = (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
  assert.ok(sources.length >= 9);
  for (const name of [
    "EngineUpdateService",
    "UpdaterService",
    "UsageReporting",
    "backfillProxyCountries",
    "onCompanionInstall",
  ]) {
    for (const source of sources) assert.equal(source.includes(name), false, name);
  }
});

const sharedExt: ExtensionConfig = {
  id: "abc",
  name: "Ext",
  version: "1.0",
  scope: "shared",
  enabled: true,
  dir: "",
  source: "file",
};

test("sweepOrphans: an unreferenced store entry goes at start", async () => {
  await withRuntime(
    async (runtime, dir) => {
      const orphan = join(dataPaths(dir).extensionStoreRoot, "orphan");
      await eventually(() => !existsSync(orphan), "the orphan to be swept");
      assert.equal(runtime.profileManager.list().length, 0);
    },
    (dir) => {
      mkdirSync(join(dataPaths(dir).extensionStoreRoot, "orphan", "1.0"), { recursive: true });
    },
  );
});

test("sweepOrphans: deleting the last referencing profile reclaims the store entry", async () => {
  await withRuntime(async (runtime, dir) => {
    const store = dataPaths(dir).extensionStoreRoot;
    const entry = join(store, sharedExt.id, sharedExt.version);
    mkdirSync(entry, { recursive: true });
    const keeper = runtime.profileManager.create({ name: "keeper", extensions: [sharedExt] });
    const leaver = runtime.profileManager.create({ name: "leaver", extensions: [sharedExt] });

    runtime.profileManager.delete(leaver.id);
    // Give a wrong sweep time to run before trusting that it left the entry.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(entry), true);

    runtime.profileManager.delete(keeper.id);
    await eventually(() => !existsSync(entry), "the entry to be reclaimed");
  });
});

function plantMovedRow(dir: string, withDirectory: boolean): string {
  const { dbPath, profilesRoot } = dataPaths(dir);
  const elsewhere = new ProfileManager({ dbPath, profilesRoot: join(dir, "elsewhere") });
  const { id } = elsewhere.create({ name: "moved" });
  elsewhere.close();
  if (withDirectory) mkdirSync(join(profilesRoot, id), { recursive: true });
  return id;
}

test("a row outside the profiles root is rebased when its directory is under it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-rt-"));
  try {
    const id = plantMovedRow(dir, true);
    const pm = openProfiles(dir);
    assert.equal(pm.get(id)?.dataDir, join(dir, "profiles", id));
    pm.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row outside the profiles root with no directory refuses the start, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-rt-"));
  try {
    const id = plantMovedRow(dir, false);
    assert.throws(
      () => openProfiles(dir),
      (e: unknown) => {
        assert.ok(e instanceof DataDirMismatchError);
        assert.match(e.message, new RegExp(id));
        assert.match(e.message, /moved/);
        assert.match(e.message, /point outside/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("buildRuntime refuses the same way, before any engine work", async () => {
  const dir = dataDirWithEngine();
  try {
    plantMovedRow(dir, false);
    await assert.rejects(buildRuntime({ dataDir: dir }), DataDirMismatchError);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("close is idempotent and closes the database", async () => {
  const dir = dataDirWithEngine();
  try {
    const runtime = await buildRuntime({ dataDir: dir });
    await Promise.all([runtime.close(), runtime.close()]);
    await runtime.close();
    assert.throws(() => runtime.profileManager.list(), /not open/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("engine progress: downloads are throttled, other changes pass at once", () => {
  const logged: Array<Record<string, unknown>> = [];
  let clock = 0;
  const sink = {
    info: (_msg: string, fields?: Record<string, unknown>) => logged.push(fields ?? {}),
    error: (_msg: string, fields?: Record<string, unknown>) => logged.push(fields ?? {}),
  };
  const report = engineProgressLogger(sink, () => clock, 5000);
  const downloading = (bytesReceived: number) => ({
    kind: "downloading" as const,
    version: "1",
    bytesReceived,
    bytesTotal: 100,
  });

  report("cloakbrowser", { kind: "fetching-manifest" });
  report("cloakbrowser", downloading(1));
  clock = 1000;
  report("cloakbrowser", downloading(2));
  report("camoufox", downloading(3));
  clock = 5000;
  report("cloakbrowser", downloading(4));
  report("cloakbrowser", { kind: "extracting", version: "1" });
  report("cloakbrowser", { kind: "error", message: "boom" });

  assert.deepEqual(
    logged.map((l) => [l.engine, l.status, l.bytesReceived]),
    [
      ["cloakbrowser", "fetching-manifest", undefined],
      ["cloakbrowser", "downloading", 1],
      ["camoufox", "downloading", 3],
      ["cloakbrowser", "downloading", 4],
      ["cloakbrowser", "extracting", undefined],
      ["cloakbrowser", "error", undefined],
    ],
  );
  assert.equal(logged.at(-1)?.error, "boom");
});

test("a server never turns the sandbox off, and owns the Singleton files of its data dir", async () => {
  await withRuntime(async (runtime) => {
    const chromium = (
      runtime.driver as unknown as { chromiumDriver: { requireSandbox: boolean; ownsDataDir: boolean } }
    ).chromiumDriver;
    assert.equal(chromium.requireSandbox, true);
    assert.equal(chromium.ownsDataDir, true);
  });
});

test("the engines in use: the default and every profile's own pin", async () => {
  await withRuntime(
    async (runtime) => {
      assert.deepEqual([...enginesInUse(runtime)], ["camoufox"]);
      runtime.profileManager.create({ name: "follows the default" });
      assert.deepEqual([...enginesInUse(runtime)], ["camoufox"]);
      runtime.profileManager.create({ name: "pinned", engine: "cloakbrowser" });
      assert.deepEqual([...enginesInUse(runtime)].sort(), ["camoufox", "cloakbrowser"]);
    },
    () => {},
    "camoufox",
  );
});

test("the readiness budget on a server is 30 s, for software GL in a container", async () => {
  await withRuntime(async (runtime) => {
    const chromium = (runtime.driver as unknown as { chromiumDriver: { readinessBudgetMs: number } })
      .chromiumDriver;
    assert.equal(chromium.readinessBudgetMs, 30_000);
  });
});

test("display: the flags and the stored setting reach the router", async () => {
  const dir = dataDirWithEngine();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultDisplayMode: "headless" }));
  const runtime = await buildRuntime({
    dataDir: dir,
    maxBrowsers: 1,
    displayMode: "xvfb",
    headless: true,
  });
  try {
    const router = runtime.driver as unknown as {
      displayModeDefault: string;
      forcedDisplayMode: string | undefined;
      getDefaultDisplayMode: () => string | undefined;
    };
    assert.equal(router.displayModeDefault, "xvfb");
    assert.equal(router.forcedDisplayMode, "headless");
    assert.equal(router.getDefaultDisplayMode(), "headless");
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("display: without --headless nothing is forced, and a bad setting is simply absent", async () => {
  const dir = dataDirWithEngine();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultDisplayMode: "holographic" }));
  const runtime = await buildRuntime({ dataDir: dir, maxBrowsers: 1, displayMode: "auto", headless: false });
  try {
    const router = runtime.driver as unknown as {
      forcedDisplayMode: string | undefined;
      getDefaultDisplayMode: () => string | undefined;
    };
    assert.equal(router.forcedDisplayMode, undefined);
    assert.equal(router.getDefaultDisplayMode(), undefined);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
