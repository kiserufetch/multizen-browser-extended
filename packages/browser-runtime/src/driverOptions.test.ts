import { mock, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@multizen/profile-manager";
import type { ChromiumStatus, MultizenError, ProfileId } from "@multizen/types";
import { ChromiumBrowserDriver, type ChromiumBrowserDriverOptions } from "./ChromiumBrowserDriver.ts";
import type { EngineRegistry } from "./engineRegistry.ts";
import { EngineRouter } from "./engineRouter.ts";
import type { RuntimeHost } from "./host.ts";

const host: RuntimeHost = {
  userDataDir: () => "unused",
  resourceDir: () => null,
  fetch: () => {
    throw new Error("fetch not expected");
  },
  request: () => {
    throw new Error("request not expected");
  },
};

/** A registry whose engine is "installed" at `binaryPath`, without touching disk. */
function fakeRegistry(binaryPath: string): EngineRegistry {
  const status: ChromiumStatus = { kind: "ready", version: "146.0.0.0", binaryPath };
  return {
    get: () => ({
      ensure: async () => status,
      getStatus: () => status,
      resolveBinaryPath: () => binaryPath,
      getInstalledVersion: () => status.version,
    }),
  } as unknown as EngineRegistry;
}

async function withProfile<T>(
  fn: (pm: ProfileManager, id: ProfileId, dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-driver-"));
  const pm = new ProfileManager({
    dbPath: join(dir, "profiles.db"),
    profilesRoot: join(dir, "profiles"),
  });
  try {
    return await fn(pm, pm.create({ name: "p" }).id, dir);
  } finally {
    pm.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function driverFor(
  pm: ProfileManager,
  binaryPath: string,
  overrides: Partial<ChromiumBrowserDriverOptions> = {},
): ChromiumBrowserDriver {
  return new ChromiumBrowserDriver({
    host,
    profileManager: pm,
    engineRegistry: fakeRegistry(binaryPath),
    getDefaultEngine: () => "cloakbrowser",
    extensionStoreRoot: "unused",
    readinessBudgetMs: 500,
    allocatePort: async () => 1,
    ...overrides,
  });
}

test("a binary that can't spawn rejects the launch and is not an uncaught exception", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "does-not-exist.exe"));
    let uncaught: unknown = null;
    const onUncaught = (e: unknown): void => {
      uncaught = e;
    };
    process.on("uncaughtException", onUncaught);
    try {
      await assert.rejects(driver.launch(id), /Failed to spawn Chromium/);
      // The "error" event comes a tick after spawn returns.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(uncaught, null);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    assert.equal(driver.isRunning(id), false);
  });
});

test("custom options reach the launch: port, readiness budget, stderr hook", async () => {
  await withProfile(async (pm, id) => {
    const stderrLines: Array<{ pid: number; text: string }> = [];
    let portsAsked = 0;
    // Node, handed Chromium's flags, prints "bad option" to stderr and exits.
    const driver = driverFor(pm, process.execPath, {
      allocatePort: async () => {
        portsAsked += 1;
        return 1;
      },
      onBrowserStderr: (pid, text) => stderrLines.push({ pid, text }),
    });
    const startedAt = Date.now();
    await assert.rejects(driver.launch(id), /within 500ms/);
    assert.ok(Date.now() - startedAt < 10_000);
    assert.equal(portsAsked, 1);
    assert.ok(stderrLines.length > 0);
    assert.match(stderrLines[0]!.text, /bad option/);
    assert.ok(stderrLines[0]!.pid > 0);
  });
});

test("the default allocator skips an occupied debugging port", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const taken = (blocker.address() as AddressInfo).port;
  try {
    await withProfile(async (pm, id, dir) => {
      const driver = driverFor(pm, join(dir, "does-not-exist.exe"), { allocatePort: undefined });
      (driver as unknown as { nextPort: number }).nextPort = taken;
      await assert.rejects(driver.launch(id), /Failed to spawn/);
      assert.ok((driver as unknown as { nextPort: number }).nextPort >= taken + 2);
    });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("extra disabled features join the one --disable-features switch; default adds none", async () => {
  await withProfile(async (pm, id, dir) => {
    let captured: readonly string[] = [];
    const spawnMock = mock.method(childProcess, "spawn", (_bin: string, args: readonly string[]) => {
      captured = args;
      throw new Error("stop before a real spawn");
    });
    syncBuiltinESMExports();
    try {
      const switches = (): string[] => captured.filter((a) => a.startsWith("--disable-features="));

      await assert.rejects(driverFor(pm, join(dir, "x.exe")).launch(id), /stop before a real spawn/);
      assert.deepEqual(switches(), ["--disable-features=Translate"]);

      const withExtra = driverFor(pm, join(dir, "x.exe"), {
        extraDisabledFeatures: ["CalculateNativeWinOcclusion"],
      });
      await assert.rejects(withExtra.launch(id), /stop before a real spawn/);
      assert.deepEqual(switches(), ["--disable-features=Translate,CalculateNativeWinOcclusion"]);
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test("the router hands firefoxOptions to the driver it constructs", async () => {
  await withProfile(async (pm, id, dir) => {
    const launchExtras = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
    pm.update(id, { engine: "camoufox" });
    const chromiumDriver = driverFor(pm, join(dir, "unused.exe"));
    // The driver's own lookup comes after the router's. Answering null there stops
    // the launch before camoufox-js could look for a real binary to start.
    let lookups = 0;
    const once = {
      get: (profileId: ProfileId) => (lookups++ === 0 ? pm.get(profileId) : null),
      markOpened: () => {},
    } as unknown as ProfileManager;
    const router = new EngineRouter({
      profileManager: once,
      engineRegistry: fakeRegistry(join(dir, "unused.exe")),
      getDefaultEngine: () => "cloakbrowser",
      chromiumDriver,
      firefoxOptions: { launchExtras },
    });

    await assert.rejects(router.launch(id), /not found/);

    const constructed = (router as unknown as { firefoxDriver: { launchExtras: unknown } })
      .firefoxDriver;
    assert.deepEqual(constructed.launchExtras, launchExtras);
  });
});

/** A running record with a stand-in session, so the verbs run without a browser. */
function graftRunning(
  driver: ChromiumBrowserDriver,
  id: ProfileId,
  session: Record<string, unknown>,
): void {
  (driver as unknown as { running: Map<ProfileId, unknown> }).running.set(id, {
    session,
    windowWatcher: setInterval(() => {}, 60_000).unref(),
  });
}

test("downloads arm on the first list or get, once, into the profile's downloads dir", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const armed: string[] = [];
    graftRunning(driver, id, {
      enableDownloads: async (downloadsDir: string) => armed.push(downloadsDir),
    });
    assert.deepEqual(await driver.listDownloads(id), []);
    assert.equal(await driver.getDownload(id, "nope"), null);
    assert.deepEqual(armed, [join(pm.get(id)!.dataDir, "downloads")]);
  });
});

test("arming that failed is tried again on the next call", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    let attempts = 0;
    graftRunning(driver, id, {
      enableDownloads: async () => {
        if (++attempts === 1) throw new Error("browser busy");
      },
    });
    await assert.rejects(driver.listDownloads(id), /browser busy/);
    assert.deepEqual(await driver.listDownloads(id), []);
    assert.equal(attempts, 2);
  });
});

test("a stopped profile lists its downloads without arming anything", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    assert.deepEqual(await driver.listDownloads(id), []);
    assert.equal(await driver.getDownload(id, "nope"), null);
  });
});

test("performAction reaches the session verb for each action", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const seen: unknown[][] = [];
    const record =
      (name: string) =>
      async (...args: unknown[]): Promise<void> => {
        seen.push([name, ...args]);
      };
    graftRunning(driver, id, {
      pressKey: record("pressKey"),
      hover: record("hover"),
      selectOption: record("selectOption"),
      scroll: record("scroll"),
      uploadFile: record("uploadFile"),
      bringToFront: record("bringToFront"),
    });
    const target = { ref: "e1" };
    await driver.performAction(id, { type: "press_key", key: "Enter", target });
    await driver.performAction(id, { type: "hover", target });
    await driver.performAction(id, { type: "select_option", target, label: "Two" });
    await driver.performAction(id, { type: "scroll", deltaY: 5 });
    await driver.performAction(id, { type: "upload_file", target, paths: ["a"] });
    await driver.performAction(id, { type: "bring_to_front" });
    assert.deepEqual(seen, [
      ["pressKey", "Enter", target],
      ["hover", target],
      ["selectOption", target, { label: "Two" }],
      ["scroll", { type: "scroll", deltaY: 5 }],
      ["uploadFile", target, ["a"]],
      ["bringToFront"],
    ]);
  });
});

test("only the handoff panel's capture and input still refuse on this engine", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    await assert.rejects(driver.captureFrame(), (e: MultizenError) => e.code === "UNSUPPORTED_ON_ENGINE");
    await assert.rejects(driver.dispatchInput(), (e: MultizenError) => e.code === "UNSUPPORTED_ON_ENGINE");
    await assert.rejects(
      driver.performAction(id, { type: "hover", target: { ref: "e1" } }),
      (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING",
    );
    await assert.rejects(driver.listDialogs(id), (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING");
  });
});
