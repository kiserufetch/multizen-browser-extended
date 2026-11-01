import { mock, test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ProfileManager } from "@multizen/profile-manager";
import { MultizenError, type ChromiumStatus, type DisplayMode, type ProfileId } from "@multizen/types";
import {
  browserDataDirForEngine,
  ChromiumBrowserDriver,
  dialogScopeFor,
  focusFirstPage,
  type ChromiumBrowserDriverOptions,
} from "./ChromiumBrowserDriver.ts";
import { EgressPolicy, type EgressLookup } from "./egressPolicy.ts";
import type { EngineRegistry } from "./engineRegistry.ts";
import { EngineRouter } from "./engineRouter.ts";
import type { RuntimeHost } from "./host.ts";
import { startBridgeForProfile, stopAllBridges, stopBridgeForProfile } from "./socks5Bridge.ts";

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

test("extra arguments go ahead of the start page, which has to stay last; default adds none", async () => {
  await withProfile(async (pm, id, dir) => {
    let captured: readonly string[] = [];
    const spawnMock = mock.method(childProcess, "spawn", (_bin: string, args: readonly string[]) => {
      captured = args;
      throw new Error("stop before a real spawn");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(driverFor(pm, join(dir, "x.exe")).launch(id), /stop before a real spawn/);
      assert.equal(captured.includes("--a-flag"), false);

      const withExtra = driverFor(pm, join(dir, "x.exe"), { extraArgs: ["--a-flag"] });
      await assert.rejects(withExtra.launch(id), /stop before a real spawn/);
      assert.equal(captured.at(-2), "--a-flag");
      assert.equal(captured.at(-1), "about:blank");
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

/** Spawns stand in for a browser that dies at once with this on stderr. */
function mockBrowserDying(stderr: string): { spawned: string[][]; restore: () => void } {
  const spawned: string[][] = [];
  const spawnMock = mock.method(childProcess, "spawn", (_bin: string, args: readonly string[]) => {
    spawned.push([...args]);
    const child = Object.assign(new EventEmitter(), {
      pid: 900_000 + spawned.length,
      exitCode: null as number | null,
      signalCode: null,
      stderr: new PassThrough(),
    });
    setImmediate(() => {
      child.stderr.write(stderr);
      setImmediate(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
    });
    return child;
  });
  syncBuiltinESMExports();
  return {
    spawned,
    restore: () => {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

const NO_USABLE_SANDBOX = "[12:12:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!\n";

test("requireSandbox: a sandbox that can't start fails typed, with no second try and no --no-sandbox", async () => {
  await withProfile(async (pm, id, dir) => {
    const browser = mockBrowserDying(NO_USABLE_SANDBOX);
    let inactive = 0;
    try {
      const driver = driverFor(pm, join(dir, "chrome"), {
        requireSandbox: true,
        onBrowserStderr: () => {},
        onSandboxInactive: () => (inactive += 1),
      });
      await assert.rejects(driver.launch(id), (e: unknown) => {
        assert.ok(e instanceof MultizenError, `not a MultizenError: ${String(e)}`);
        assert.equal(e.code, "SANDBOX_UNAVAILABLE");
        assert.equal(e.retryable, false);
        assert.match(e.hint ?? "", /seccomp-chromium\.json/);
        return true;
      });
      assert.equal(browser.spawned.length, 1);
      assert.ok(!browser.spawned[0]!.includes("--no-sandbox"));
      assert.equal(inactive, 0);
      assert.equal(driver.isRunning(id), false);
    } finally {
      browser.restore();
    }
  });
});

test("requireSandbox: neither the resolver nor the kernel check is asked", async () => {
  await withProfile(async (pm, id, dir) => {
    const browser = mockBrowserDying("");
    let asked = 0;
    try {
      const driver = driverFor(pm, join(dir, "chrome"), {
        requireSandbox: true,
        readinessBudgetMs: 50,
        onBrowserStderr: () => {},
        resolveSandboxDecision: async () => {
          asked += 1;
          return { noSandbox: true };
        },
      });
      await assert.rejects(driver.launch(id));
      assert.equal(asked, 0);
      assert.ok(!browser.spawned[0]!.includes("--no-sandbox"));
    } finally {
      browser.restore();
    }
  });
});

test("without requireSandbox the desktop's backstop stays: one relaunch with --no-sandbox", async () => {
  await withProfile(async (pm, id, dir) => {
    const browser = mockBrowserDying(NO_USABLE_SANDBOX);
    const inactive: string[] = [];
    const warn = mock.method(console, "warn", () => {});
    try {
      const driver = driverFor(pm, join(dir, "chrome"), {
        readinessBudgetMs: 50,
        onBrowserStderr: () => {},
        resolveSandboxDecision: async () => ({ noSandbox: false }),
        onSandboxInactive: (binaryPath) => inactive.push(binaryPath),
      });
      await assert.rejects(driver.launch(id));
      assert.equal(browser.spawned.length, 2);
      assert.ok(!browser.spawned[0]!.includes("--no-sandbox"));
      assert.equal(browser.spawned[1]![0], "--no-sandbox");
      assert.deepEqual(inactive, [join(dir, "chrome")]);
    } finally {
      warn.mock.restore();
      browser.restore();
    }
  });
});

/** Every Singleton* as a browser leaves them, naming a process that is alive right now. */
function plantSingletonFiles(browserDataDir: string): string[] {
  mkdirSync(browserDataDir, { recursive: true });
  const names = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const name of names) {
    const path = join(browserDataDir, name);
    // Links need a privilege on Windows, and Chromium only makes them on POSIX.
    if (process.platform === "win32") writeFileSync(path, "");
    else symlinkSync(`multizen-${process.pid}`, path);
  }
  return names.map((name) => join(browserDataDir, name));
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test("ownsDataDir: every Singleton* goes before the spawn, even one naming a live PID", async () => {
  await withProfile(async (pm, id, dir) => {
    const planted = plantSingletonFiles(browserDataDirForEngine(pm.get(id)!.dataDir, "cloakbrowser"));
    let atSpawn: boolean[] = [];
    const spawnMock = mock.method(childProcess, "spawn", () => {
      atSpawn = planted.map(present);
      throw new Error("stop before a real spawn");
    });
    syncBuiltinESMExports();
    try {
      const driver = driverFor(pm, join(dir, "chrome"), { ownsDataDir: true });
      await assert.rejects(driver.launch(id), /stop before a real spawn/);
      assert.deepEqual(atSpawn, [false, false, false]);
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test("without ownsDataDir a Singleton* naming a live PID stays, as on the desktop", async () => {
  await withProfile(async (pm, id, dir) => {
    const planted = plantSingletonFiles(browserDataDirForEngine(pm.get(id)!.dataDir, "cloakbrowser"));
    const spawnMock = mock.method(childProcess, "spawn", () => {
      throw new Error("stop before a real spawn");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(driverFor(pm, join(dir, "chrome")).launch(id), /stop before a real spawn/);
      assert.equal(present(planted[0]!), true);
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
    // The driver's own lookup comes after the router's two, for the mode and the engine.
    // Answering null there stops the launch before camoufox-js could look for a real
    // binary to start.
    let lookups = 0;
    const once = {
      get: (profileId: ProfileId) => (lookups++ < 2 ? pm.get(profileId) : null),
      markOpened: () => {},
    } as unknown as ProfileManager;
    const router = new EngineRouter({
      profileManager: once,
      engineRegistry: fakeRegistry(join(dir, "unused.exe")),
      getDefaultEngine: () => "cloakbrowser",
      chromiumDriver,
      firefoxOptions: { launchExtras },
      displayEnvironment: { platform: "win32", env: {}, hasXvfb: () => false },
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

test("the verbs that need a browser say so when there is none", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    await assert.rejects(driver.captureFrame(id), (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING");
    await assert.rejects(
      driver.dispatchInput(id, { kind: "text", text: "x" }),
      (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING",
    );
    await assert.rejects(driver.setHandoffMode(id, true), (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING");
    await assert.rejects(
      driver.performAction(id, { type: "hover", target: { ref: "e1" } }),
      (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING",
    );
    await assert.rejects(driver.listDialogs(id), (e: MultizenError) => e.code === "PROFILE_NOT_RUNNING");
  });
});

// ── one launch at a time ─────────────────────────────────────────────────────

/** doLaunch replaced by one that ends when told, with the wrapper around it real. */
function slowLaunch(driver: ChromiumBrowserDriver): { calls: () => number; finish: () => void } {
  let calls = 0;
  let finish = (): void => {};
  (driver as unknown as { doLaunch: unknown }).doLaunch = async (id: ProfileId) => {
    calls += 1;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    graftRunning(driver, id, { abortOperations: () => {}, closeBrowser: async () => {}, close: async () => {} });
    (driver as unknown as { running: Map<ProfileId, Record<string, unknown>> }).running.get(id)!.child = {
      exitCode: 0,
      killed: false,
      once: () => {},
      kill: () => {},
    };
    return { id, cdpEndpoint: "http://127.0.0.1:1", pid: 0, startedAt: "now" };
  };
  return { calls: () => calls, finish: () => finish() };
}

const turn = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("two parallel launches run doLaunch once; a later one answers from what runs", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const slow = slowLaunch(driver);
    const launches = [driver.launch(id), driver.launch(id)];
    await turn();
    assert.equal(slow.calls(), 1);
    slow.finish();
    const [a, b] = await Promise.all(launches);
    assert.equal(a, b);
    assert.equal(driver.isRunning(id), true);
    await driver.launch(id);
    assert.equal(slow.calls(), 1, "launching a running profile stays idempotent");
    await driver.close(id);
  });
});

test("a failed launch doesn't stick: the next one tries again", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    let calls = 0;
    (driver as unknown as { doLaunch: unknown }).doLaunch = async () => {
      calls += 1;
      throw new Error("no browser");
    };
    await assert.rejects(driver.launch(id), /no browser/);
    await assert.rejects(driver.launch(id), /no browser/);
    assert.equal(calls, 2);
  });
});

test("close during a launch waits for it, and closes what came up", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const slow = slowLaunch(driver);
    const launching = driver.launch(id);
    await turn();
    let closed = false;
    const closing = driver.close(id).then(() => {
      closed = true;
    });
    await turn();
    assert.equal(closed, false);
    slow.finish();
    await launching;
    await closing;
    assert.equal(driver.isRunning(id), false);
  });
});

test("closeAll during a launch: what the launch brings up is closed, and it fails", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const slow = slowLaunch(driver);
    const launching = driver.launch(id);
    await turn();
    const closingAll = driver.closeAll();
    await turn();
    slow.finish();
    await assert.rejects(launching, (e: MultizenError) => e.code === "LAUNCH_FAILED");
    await closingAll;
    assert.equal(driver.isRunning(id), false);
  });
});

test("closeAll during a launch stops waiting for a browser coming up, at once", async () => {
  await withProfile(async (pm, id) => {
    // Node exits at once on Chromium's flags, so no real browser comes up, and until its
    // budget runs out the launch would only end when something ends it.
    const driver = driverFor(pm, process.execPath, { readinessBudgetMs: 6_000 });
    const launching = driver.launch(id);
    const failure = assert.rejects(launching, (e: MultizenError) => e.code === "LAUNCH_FAILED");
    while (!(driver as unknown as { launching: Map<ProfileId, { killStarting?: unknown }> }).launching.get(id)?.killStarting) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const startedAt = Date.now();
    await driver.closeAll();
    await failure;
    assert.ok(Date.now() - startedAt < 4_000, `took ${Date.now() - startedAt} ms`);
    assert.equal(driver.isRunning(id), false);
  });
});

test("closing ends a call stuck on the browser right away", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    let aborted = 0;
    graftRunning(driver, id, {
      abortOperations: () => void aborted++,
      closeBrowser: async () => {},
      close: async () => {},
    });
    (driver as unknown as { running: Map<ProfileId, Record<string, unknown>> }).running.get(id)!.child = {
      exitCode: 0,
      killed: false,
      once: () => {},
      kill: () => {},
    };
    await driver.close(id);
    assert.equal(aborted, 1);
  });
});

// ── display modes ────────────────────────────────────────────────────────────

/** The flag names of a launch, as they stood before display modes existed. */
const HEADED_FLAGS = [
  "--user-data-dir",
  "--remote-debugging-port",
  "--no-first-run",
  "--no-default-browser-check",
  "--restore-last-session",
  ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ...(process.platform === "linux" ? ["--password-store"] : []),
  "--lang",
  "--accept-lang",
  "--window-size",
  "--fingerprint",
  "--fingerprint-platform",
  "--fingerprint-timezone",
  "--fingerprint-screen-width",
  "--fingerprint-screen-height",
  "--fingerprint-hardware-concurrency",
  "--fingerprint-device-memory",
  "--fingerprint-gpu-vendor",
  "--fingerprint-gpu-renderer",
  "--fingerprint-brand-version",
  "--fingerprint-platform-version",
  "--disable-features",
];

async function launchArgv(
  pm: ProfileManager,
  id: ProfileId,
  dir: string,
  displayMode?: DisplayMode,
  overrides: Partial<ChromiumBrowserDriverOptions> = {},
): Promise<string[]> {
  let captured: string[] = [];
  const spawnMock = mock.method(childProcess, "spawn", (_bin: string, args: readonly string[]) => {
    captured = [...args];
    throw new Error("stop before a real spawn");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      driverFor(pm, join(dir, "x.exe"), overrides).launch(id, displayMode ? { displayMode } : undefined),
      /stop before a real spawn/,
    );
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
  return captured;
}

test("headed argv is unchanged: the same flags, in the same order, with no mode given or named", async () => {
  await withProfile(async (pm, id, dir) => {
    const fingerprintDefault = await launchArgv(pm, id, dir);
    const named = await launchArgv(pm, id, dir, "headed");
    assert.deepEqual(named, fingerprintDefault);

    const flagNames = named.map((a) => a.split("=")[0]!);
    const positional = flagNames.pop();
    assert.equal(positional?.startsWith("--"), false, "the start URL stays last");
    const expected = HEADED_FLAGS.filter((flag) => named.some((a) => a.startsWith(`${flag}=`) || a === flag));
    assert.deepEqual(flagNames, expected);
    assert.equal(named.some((a) => a.startsWith("--headless")), false);
    assert.equal(named.some((a) => a.startsWith("--blink-settings")), false);
  });
});

test("headless adds exactly the two flags, before the positional URL, and changes nothing else", async () => {
  await withProfile(async (pm, id, dir) => {
    const headed = await launchArgv(pm, id, dir, "headed");
    const headless = await launchArgv(pm, id, dir, "headless");
    const added = headless.filter((a) => !headed.includes(a));
    assert.deepEqual(added, [
      "--headless=new",
      "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
    ]);
    assert.deepEqual(headless.filter((a) => !added.includes(a)), headed);
    assert.equal(headless.at(-1), headed.at(-1), "the positional URL stays last");
  });
});

// ── egress ───────────────────────────────────────────────────────────────────

const noLookup: EgressLookup = () => {
  throw new Error("nothing here should resolve a name");
};

const blockPrivate = (allow: string[] = []): EgressPolicy =>
  new EgressPolicy({ mode: "block-private", allow, lookup: noLookup });

/** Bridge ports differ from launch to launch. */
const withoutBridgePort = (argv: string[]): string[] =>
  argv.map((a) => a.replace(/^(--proxy-server=socks5:\/\/127\.0\.0\.1:)\d+$/, "$1PORT"));

const PROXIED_HARDENING = [
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--dns-over-https-mode=off",
  "--dns-prefetch-disable",
  "--disable-async-dns",
  "--no-prerender",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
];

test("no policy and allow-all: the desktop's argv, flag for flag, direct and proxied", async () => {
  await withProfile(async (pm, id, dir) => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const plain = await launchArgv(pm, id, dir);
      assert.deepEqual(
        await launchArgv(pm, id, dir, undefined, { egress: new EgressPolicy({ mode: "allow-all" }) }),
        plain,
      );
      assert.equal(plain.some((a) => a.startsWith("--proxy")), false);
      assert.equal(plain.some((a) => a.startsWith("--webrtc")), false);
      await stopAllBridges();

      pm.update(id, { proxy: { type: "socks5", host: "127.0.0.1", port: 1 } });
      const proxied = await launchArgv(pm, id, dir);
      await stopAllBridges();
      assert.equal(proxied.some((a) => a.startsWith("--proxy-bypass-list")), false);
      assert.deepEqual(
        withoutBridgePort(
          await launchArgv(pm, id, dir, undefined, { egress: new EgressPolicy({ mode: "allow-all" }) }),
        ),
        withoutBridgePort(proxied),
      );
    } finally {
      warn.mock.restore();
      await stopAllBridges();
    }
  });
});

test("enforced, direct: exactly the three flags, and none of the proxied hardening", async () => {
  await withProfile(async (pm, id, dir) => {
    try {
      const plain = await launchArgv(pm, id, dir);
      const bridged = await launchArgv(pm, id, dir, undefined, { egress: blockPrivate() });
      const added = bridged.filter((a) => !plain.includes(a));
      assert.equal(added.length, 3, added.join(" "));
      assert.match(added[0]!, /^--proxy-server=socks5:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(added[1], "--webrtc-ip-handling-policy=disable_non_proxied_udp");
      assert.equal(added[2], "--proxy-bypass-list=<-loopback>");
      assert.deepEqual(bridged.filter((a) => !added.includes(a)), plain, "nothing else moved or changed");
      assert.ok(bridged.includes("--disable-features=Translate"), "no proxy-only features");
      for (const flag of PROXIED_HARDENING.slice(1)) assert.ok(!bridged.includes(flag), flag);
    } finally {
      await stopAllBridges();
    }
  });
});

test("enforced, proxied: the proxied argv plus <-loopback> and nothing else", async () => {
  await withProfile(async (pm, id, dir) => {
    const warn = mock.method(console, "warn", () => {});
    try {
      pm.update(id, { proxy: { type: "socks5", host: "127.0.0.1", port: 1 } });
      const plain = withoutBridgePort(await launchArgv(pm, id, dir));
      await stopAllBridges();
      const enforced = withoutBridgePort(
        await launchArgv(pm, id, dir, undefined, { egress: blockPrivate(["127.0.0.1:1"]) }),
      );
      assert.deepEqual(enforced.filter((a) => !plain.includes(a)), ["--proxy-bypass-list=<-loopback>"]);
      assert.deepEqual(enforced.filter((a) => a !== "--proxy-bypass-list=<-loopback>"), plain);
      for (const flag of PROXIED_HARDENING) assert.ok(enforced.includes(flag), flag);
    } finally {
      warn.mock.restore();
      await stopAllBridges();
    }
  });
});

test("a proxy the policy refuses stops the launch before the geo probe or anything else", async () => {
  const proxy = createServer();
  let connections = 0;
  proxy.on("connection", (socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const port = (proxy.address() as AddressInfo).port;
  try {
    await withProfile(async (pm, id, dir) => {
      pm.update(id, { proxy: { type: "socks5", host: "127.0.0.1", port } });
      const openedBefore = pm.get(id)!.lastOpenedAt;
      let spawned = 0;
      const spawnMock = mock.method(childProcess, "spawn", () => {
        spawned += 1;
        throw new Error("no browser should start");
      });
      syncBuiltinESMExports();
      try {
        const driver = driverFor(pm, join(dir, "x.exe"), { egress: blockPrivate() });
        await assert.rejects(driver.launch(id), (e: MultizenError) => {
          assert.equal(e.code, "EGRESS_BLOCKED");
          assert.ok(e.message.includes(`127.0.0.1:${port}`));
          return true;
        });
      } finally {
        spawnMock.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(connections, 0, "the geo probe never connected to it");
      assert.equal(spawned, 0);
      assert.equal(pm.get(id)!.lastOpenedAt, openedBefore);
    });
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("navigate: a load the bridge refused is EGRESS_BLOCKED; another failure stays as it was", async () => {
  await withProfile(async (pm, id, dir) => {
    const warn = mock.method(console, "warn", () => {});
    const driver = driverFor(pm, join(dir, "x.exe"));
    const failed = new MultizenError("NAVIGATION_FAILED", "Navigation to http://x/ failed: net::ERR_SOCKET_NOT_CONNECTED");
    graftRunning(driver, id, { navigate: async () => Promise.reject(failed) });
    try {
      assert.equal(await driver.navigate(id, "http://x/").catch((e: unknown) => e), failed, "no block yet");

      const url = await startBridgeForProfile(id, null, blockPrivate());
      const socket = connect(Number(new URL(url).port), "127.0.0.1");
      await new Promise<void>((resolve) => {
        socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
        socket.once("data", () => {
          socket.write(Buffer.from([5, 1, 0, 1, 169, 254, 169, 254, 0, 80]));
          socket.once("data", () => resolve());
        });
      });
      socket.destroy();

      const typed = (await driver.navigate(id, "http://x/").catch((e: unknown) => e)) as MultizenError;
      assert.equal(typed.code, "EGRESS_BLOCKED");
      assert.match(typed.message, /169\.254\.169\.254:80/);
    } finally {
      warn.mock.restore();
      await stopAllBridges();
    }
  });
});

test("the router hands the egress policy to the Firefox driver it constructs", async () => {
  await withProfile(async (pm, id, dir) => {
    pm.update(id, { engine: "camoufox" });
    const egress = blockPrivate();
    let lookups = 0;
    const once = {
      get: (profileId: ProfileId) => (lookups++ < 2 ? pm.get(profileId) : null),
      markOpened: () => {},
    } as unknown as ProfileManager;
    const router = new EngineRouter({
      profileManager: once,
      engineRegistry: fakeRegistry(join(dir, "unused.exe")),
      getDefaultEngine: () => "cloakbrowser",
      chromiumDriver: driverFor(pm, join(dir, "unused.exe")),
      firefoxOptions: { egress },
      displayEnvironment: { platform: "win32", env: {}, hasXvfb: () => false },
    });
    await assert.rejects(router.launch(id), /not found/);
    const constructed = (router as unknown as { firefoxDriver: { egress: unknown } }).firefoxDriver;
    assert.equal(constructed.egress, egress);
  });
});

test("a readiness failure carries the end of the browser's stderr", async () => {
  await withProfile(async (pm, id) => {
    // Node, handed Chromium's flags, prints "bad option" to stderr and exits.
    const driver = driverFor(pm, process.execPath, { onBrowserStderr: () => {} });
    await assert.rejects(driver.launch(id), (e: Error) => {
      assert.match(e.message, /within 500ms/);
      assert.match(e.message, /stderr ended with:\n[^]*bad option/);
      assert.ok(e.message.length < 2_600, `${e.message.length} characters`);
      return true;
    });
  });
});

/** Speaks as Xvfb does on fd 3, and records how it was told to stop. */
class FakeXvfbProcess extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly stdio = [null, null, this.stderr, this.fd3];
  readonly signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

test("xvfb: the browser gets the private display, and the display goes when the launch fails", async () => {
  await withProfile(async (pm, id, dir) => {
    const screen = pm.get(id)!.fingerprint.screen;
    const xvfb = new FakeXvfbProcess();
    const spawned: Array<{ bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnMock = mock.method(
      childProcess,
      "spawn",
      (bin: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ bin, args, env: opts.env });
        if (bin !== "Xvfb") throw new Error("stop before a real browser");
        setImmediate(() => xvfb.fd3.write("42\n"));
        return xvfb;
      },
    );
    syncBuiltinESMExports();
    const before = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
    process.env.DISPLAY = ":0";
    process.env.XAUTHORITY = "session-auth";
    try {
      await assert.rejects(
        driverFor(pm, join(dir, "x.exe")).launch(id, { displayMode: "xvfb" }),
        /stop before a real browser/,
      );
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
      if (before.DISPLAY === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = before.DISPLAY;
      if (before.XAUTHORITY === undefined) delete process.env.XAUTHORITY;
      else process.env.XAUTHORITY = before.XAUTHORITY;
    }
    const [server, browser] = spawned as [(typeof spawned)[0], (typeof spawned)[0]];
    assert.equal(server.bin, "Xvfb");
    assert.ok(
      server.args.includes(`${screen.width + 1}x${screen.height + 1}x24`),
      "the fingerprint's screen, a pixel over, so the window can have the persona's exact size",
    );
    assert.equal(browser.env.DISPLAY, ":42");
    assert.equal(browser.env.XAUTHORITY, server.args[server.args.indexOf("-auth") + 1]);
    assert.equal(browser.env.WAYLAND_DISPLAY, undefined);
    assert.deepEqual(xvfb.signals, ["SIGTERM"], "stopped on the failure path");
    assert.equal(existsSync(browser.env.XAUTHORITY!), false, "and its auth file with it");
  });
});

test("with no window, the first page takes the focus from the address bar; headed leaves it", async () => {
  const calls: DisplayMode[] = [];
  const session = (mode: DisplayMode) => ({
    bringToFront: async () => {
      calls.push(mode);
    },
  });
  for (const mode of ["headed", "xvfb", "headless"] as const) await focusFirstPage(session(mode), mode);
  assert.deepEqual(calls, ["xvfb", "headless"]);

  const warn = mock.method(console, "warn", () => {});
  try {
    await focusFirstPage(
      {
        bringToFront: async () => {
          throw new Error("no such tab");
        },
      },
      "headless",
    );
    assert.equal(warn.mock.callCount(), 1, "a launch is not worth failing over this");
  } finally {
    warn.mock.restore();
  }
});

test("xvfb: the record's display stops on close and on a browser that exits by itself", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    let stops = 0;
    const closing = { abortOperations: () => {}, closeBrowser: async () => {}, close: async () => {} };
    graftRunning(driver, id, closing);
    const record = (driver as unknown as { running: Map<ProfileId, Record<string, unknown>> }).running.get(id)!;
    record.child = { exitCode: 0, killed: false, once: () => {}, kill: () => {} };
    record.xvfb = { stop: async () => void stops++ };
    await driver.close(id);
    assert.equal(stops, 1);
  });
});

test("dialogs: a person's tabs are theirs only with a window to answer in", () => {
  assert.equal(dialogScopeFor("headed", "agent-tabs"), "agent-tabs");
  assert.equal(dialogScopeFor("headed", "all-tabs"), "all-tabs", "a server");
  assert.equal(dialogScopeFor("headless", "agent-tabs"), "all-tabs");
  assert.equal(dialogScopeFor("xvfb", "agent-tabs"), "all-tabs");
});

test("an old browser's exit leaves its relaunch running, and that one's bridge", async (t) => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    const running = (driver as unknown as { running: Map<ProfileId, unknown> }).running;
    const onExit = (record: unknown): void =>
      (driver as unknown as { onBrowserExit: (p: ProfileId, r: unknown) => void }).onBrowserExit(id, record);
    const closed: string[] = [];
    const record = (name: string) => ({
      session: { close: async () => void closed.push(name) },
      windowWatcher: setInterval(() => {}, 60_000).unref(),
    });
    const changes: unknown[] = [];
    driver.on("running-changed", (change) => changes.push(change));
    const bridge = (): Promise<string> =>
      startBridgeForProfile(id, null, new EgressPolicy({ mode: "block-private" }));
    t.after(() => stopBridgeForProfile(id));

    const relaunched = record("new");
    running.set(id, relaunched);
    const url = await bridge();

    onExit(record("old"));
    assert.equal(running.get(id), relaunched);
    assert.deepEqual(changes, [], "this profile hasn't gone anywhere");
    assert.deepEqual(closed, ["old"], "its own session goes, though");
    assert.equal(await bridge(), url, "the same bridge: a new one would be a new port");

    onExit(relaunched);
    assert.equal(running.has(id), false);
    assert.deepEqual(changes, [{ kind: "closed", profileId: id, reason: "external-exit" }]);
    assert.notEqual(await bridge(), url);
  });
});

test("a driver reports the mode a browser runs in, and nothing once it is gone", async () => {
  await withProfile(async (pm, id, dir) => {
    const driver = driverFor(pm, join(dir, "x.exe"));
    assert.equal(driver.runningDisplayMode(id), null);
    graftRunning(driver, id, { abortOperations: () => {}, closeBrowser: async () => {}, close: async () => {} });
    const record = (driver as unknown as { running: Map<ProfileId, Record<string, unknown>> }).running.get(id)!;
    record.displayMode = "headless";
    record.cdpEndpoint = "http://127.0.0.1:1";
    assert.equal(driver.runningDisplayMode(id), "headless");
    assert.equal((await driver.launch(id)).displayMode, "headless", "idempotent, and says so");
    record.child = { exitCode: 0, killed: false, once: () => {}, kill: () => {} };
    await driver.close(id);
    assert.equal(driver.runningDisplayMode(id), null);
  });
});
