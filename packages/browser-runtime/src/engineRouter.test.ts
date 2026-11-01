import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultizenError } from "@multizen/types";
import type {
  BrowserEngine,
  ChromiumStatus,
  DisplayMode,
  LaunchedProfile,
  LaunchOptions,
  Profile,
  ProfileId,
} from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import { DownloadTracker } from "./downloads.ts";
import type { EngineRegistry } from "./engineRegistry.ts";
import { EngineRouter, type EngineRouterOptions } from "./engineRouter.ts";
import { StrictGeoCoherenceError } from "./launchTimezone";

// Deadlines here are unref'd, as they are in the code they test. Node 22's runner takes an
// event loop with nothing else in it to mean a test will never finish, and cancels it.
let holdLoop: NodeJS.Timeout;
beforeEach(() => {
  holdLoop = setInterval(() => {}, 1_000);
});
afterEach(() => clearInterval(holdLoop));

const READY: ChromiumStatus = { kind: "ready", version: "146", binaryPath: "x" };

/** An engine whose ensure() the test controls, like a real one on a cold cache. */
class FakeBootstrap {
  status: ChromiumStatus = { kind: "missing" };
  ensureCalls = 0;
  private release: ((status: ChromiumStatus) => void) | null = null;
  private fail: ((e: Error) => void) | null = null;

  constructor(private readonly installed: boolean) {}

  ensure(): Promise<ChromiumStatus> {
    this.ensureCalls += 1;
    if (this.installed) {
      this.status = READY;
      return Promise.resolve(READY);
    }
    this.status = { kind: "downloading", bytesReceived: 10, bytesTotal: 100, version: "146" };
    return new Promise((resolve, reject) => {
      this.release = resolve;
      this.fail = reject;
    });
  }
  getStatus(): ChromiumStatus {
    return this.status;
  }
  finishInstall(): void {
    this.status = READY;
    this.release?.(READY);
  }
  failInstall(message: string): void {
    this.status = { kind: "error", message };
    this.fail?.(new Error(message));
  }
}

class FakeDriver extends EventEmitter {
  launches = 0;
  launchError: unknown = null;

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    this.launches += 1;
    if (this.launchError) throw this.launchError;
    return { id: profileId, cdpEndpoint: "", pid: 1, startedAt: "now" };
  }
  async close(profileId: ProfileId): Promise<void> {
    this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
  }
  isRunning(): boolean {
    return true;
  }
  async closeAll(): Promise<void> {}
}

function router(
  bootstrap: FakeBootstrap,
  driver: FakeDriver,
  engineNotReady?: EngineRouterOptions["engineNotReady"],
  dataDir = "unused",
): EngineRouter {
  return new EngineRouter({
    profileManager: {
      get: (id: ProfileId) => ({ id, engine: "cloakbrowser", dataDir }) as Profile,
    } as unknown as ProfileManager,
    engineRegistry: { get: () => bootstrap } as unknown as EngineRegistry,
    getDefaultEngine: (): BrowserEngine => "cloakbrowser",
    chromiumDriver: driver as unknown as ChromiumBrowserDriver,
    displayEnvironment: WINDOWS_MACHINE,
    engineNotReady,
  });
}

function code(e: unknown): string {
  assert.ok(e instanceof MultizenError, `not a MultizenError: ${String(e)}`);
  return e.code;
}

test("reject: a launch during an install answers at once, retryable, and the install goes on", async () => {
  const bootstrap = new FakeBootstrap(false);
  const driver = new FakeDriver();
  const r = router(bootstrap, driver, "reject");

  const error = await r.launch("p").then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as MultizenError,
  );
  assert.equal(code(error), "ENGINE_NOT_READY");
  assert.equal(error.retryable, true);
  assert.equal(error.details?.retry_after_ms, 5_000);
  assert.equal(error.details?.status, "downloading");
  assert.equal(error.details?.bytes_received, 10);
  assert.equal(driver.launches, 0, "no browser was started");

  // The install finishes in the background; a retry then launches.
  bootstrap.finishInstall();
  (bootstrap as unknown as { installed: boolean }).installed = true;
  await r.launch("p");
  assert.equal(driver.launches, 1);
});

test("reject: an installed engine launches with no refusal", async () => {
  const driver = new FakeDriver();
  await router(new FakeBootstrap(true), driver, "reject").launch("p");
  assert.equal(driver.launches, 1);
});

test("reject: a failed install is not an unhandled rejection and shows in the next refusal", async () => {
  const bootstrap = new FakeBootstrap(false);
  const r = router(bootstrap, new FakeDriver(), "reject");
  await assert.rejects(r.launch("p"), (e) => code(e) === "ENGINE_NOT_READY");

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    bootstrap.failInstall("no network");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);

  const error = await r.launch("p").then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as MultizenError,
  );
  assert.equal(code(error), "ENGINE_NOT_READY");
  assert.equal(error.details?.last_error, "no network");
  bootstrap.finishInstall();
});

test("wait, the default: a launch blocks through the install and then runs", async () => {
  const bootstrap = new FakeBootstrap(false);
  const driver = new FakeDriver();
  const launching = router(bootstrap, driver).launch("p");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(driver.launches, 0, "still waiting on the engine");
  bootstrap.finishInstall();
  await launching;
  assert.equal(driver.launches, 1);
});

test("a launch failure gets one code, keeping each engine's message", async () => {
  const driver = new FakeDriver();
  const r = router(new FakeBootstrap(true), driver);

  driver.launchError = new Error("Failed to spawn Chromium");
  await assert.rejects(r.launch("p"), (e: Error) => {
    assert.equal(code(e), "LAUNCH_FAILED");
    assert.equal(e.message, "Failed to spawn Chromium");
    return true;
  });

  driver.launchError = new StrictGeoCoherenceError(
    "proxy geo country 'de' ≠ fingerprint country 'us'",
  );
  await assert.rejects(r.launch("p"), (e) => code(e) === "GEO_MISMATCH");

  const typed = new MultizenError("SANDBOX_UNAVAILABLE", "no sandbox");
  driver.launchError = typed;
  await assert.rejects(r.launch("p"), (e) => e === typed);
});

test("a verb on a profile that isn't running is typed", () => {
  const r = router(new FakeBootstrap(true), new FakeDriver());
  assert.throws(
    () => r.listDialogs("p"),
    (e) => code(e) === "PROFILE_NOT_RUNNING",
  );
  assert.equal(r.hasOpenDialog("p"), false);
  assert.equal(r.runningInfo("p"), null);
});

test("downloads of a stopped profile come from its engine's driver", async () => {
  const driver = new FakeDriver() as FakeDriver & {
    listDownloads: () => Promise<unknown[]>;
    getDownload: (id: ProfileId, downloadId: string) => Promise<unknown>;
  };
  driver.listDownloads = async () => [{ id: "d1" }];
  driver.getDownload = async (_id, downloadId) => ({ id: downloadId });
  const r = router(new FakeBootstrap(true), driver);
  assert.deepEqual(await r.listDownloads("p"), [{ id: "d1" }]);
  assert.deepEqual(await r.getDownload("p", "d1"), { id: "d1" });
});

test("a stopped Camoufox profile reaches its downloads with its driver not loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-router-"));
  try {
    // What an earlier run of the server left: one finished download.
    const earlier = await DownloadTracker.open(join(dir, "downloads"));
    earlier.began({ guid: "g1", url: "http://site/f", suggestedFilename: "report.txt" });
    writeFileSync(join(dir, "downloads", "g1"), "bytes");
    earlier.progress({ guid: "g1", totalBytes: 5, receivedBytes: 5, state: "completed" });
    await earlier.settled();

    const r = new EngineRouter({
      profileManager: {
        get: (id: ProfileId) => ({ id, engine: "camoufox", dataDir: dir }) as Profile,
      } as unknown as ProfileManager,
      engineRegistry: { get: () => new FakeBootstrap(true) } as unknown as EngineRegistry,
      getDefaultEngine: (): BrowserEngine => "cloakbrowser",
      chromiumDriver: new FakeDriver() as unknown as ChromiumBrowserDriver,
    });
    const [record] = await r.listDownloads("p");
    assert.equal(record?.fileName, "report.txt");
    assert.equal((await r.getDownload("p", record!.id))?.path, join(dir, "downloads", "report.txt"));
    assert.equal(await r.getDownload("p", "nope"), null);
    assert.equal(
      (r as unknown as { firefoxDriver: unknown }).firefoxDriver,
      null,
      "reading downloads must not load camoufox-js",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing a profile clears its upload inbox and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-router-"));
  try {
    const inbox = join(dir, "uploads", ".inbox");
    mkdirSync(join(inbox, "uuid"), { recursive: true });
    writeFileSync(join(inbox, "uuid", "a.pdf"), "inbox");
    writeFileSync(join(dir, "uploads", "kept.pdf"), "kept");

    const driver = new FakeDriver();
    const r = router(new FakeBootstrap(true), driver, "wait", dir);
    await r.launch("p");
    await r.close("p");

    for (let i = 0; i < 100 && existsSync(inbox); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(inbox), false);
    assert.equal(existsSync(join(dir, "uploads", "kept.pdf")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── launches under way ───────────────────────────────────────────────────────

/** A driver whose launches finish when the test says, as a real browser takes its time. */
class SlowDriver extends EventEmitter {
  launches: ProfileId[] = [];
  closes: ProfileId[] = [];
  readonly running = new Set<ProfileId>();
  private readonly pending = new Map<ProfileId, { finish: () => void; fail: (e: Error) => void }>();

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    this.launches.push(profileId);
    await new Promise<void>((resolve, reject) => {
      this.pending.set(profileId, { finish: resolve, fail: reject });
    });
    this.running.add(profileId);
    return { id: profileId, cdpEndpoint: "", pid: 1, startedAt: "now" };
  }
  finish(profileId: ProfileId): void {
    this.pending.get(profileId)?.finish();
  }
  fail(profileId: ProfileId, message: string): void {
    this.pending.get(profileId)?.fail(new Error(message));
  }
  /** The browser died: the event every driver reports it with. */
  exit(profileId: ProfileId): void {
    this.running.delete(profileId);
    this.emit("running-changed", { kind: "closed", profileId, reason: "external-exit" });
  }
  async close(profileId: ProfileId): Promise<void> {
    this.closes.push(profileId);
    if (this.running.delete(profileId)) {
      this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
    }
  }
  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.running].map((id) => this.close(id)));
  }
}

function limitedRouter(
  driver: SlowDriver,
  opts: Partial<EngineRouterOptions> = {},
): EngineRouter {
  return new EngineRouter({
    profileManager: {
      get: (id: ProfileId) =>
        ({ id, engine: id.startsWith("fox") ? "camoufox" : "cloakbrowser", dataDir: "unused" }) as Profile,
    } as unknown as ProfileManager,
    engineRegistry: { get: () => new FakeBootstrap(true) } as unknown as EngineRegistry,
    getDefaultEngine: (): BrowserEngine => "cloakbrowser",
    chromiumDriver: driver as unknown as ChromiumBrowserDriver,
    displayEnvironment: WINDOWS_MACHINE,
    ...opts,
  });
}

/** The real router on a second stand-in engine, as if Camoufox had been loaded. */
function withFakeFirefox(r: EngineRouter, firefox: SlowDriver): void {
  const internals = r as unknown as {
    firefoxLoading: Promise<unknown>;
    firefoxDriver: unknown;
    onSubEvent: (change: unknown) => void;
  };
  internals.firefoxDriver = firefox;
  internals.firefoxLoading = Promise.resolve(firefox);
  firefox.on("running-changed", (c) => internals.onSubEvent(c));
}

const turn = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("parallel launches of a profile share one launch and one result", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launches = [r.launch("p"), r.launch("p"), r.launch("p")];
  await turn();
  assert.deepEqual(driver.launches, ["p"]);
  driver.finish("p");
  const [a, b, c] = await Promise.all(launches);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(r.isRunning("p"), true);
});

test("close during a launch waits for it and closes what it brought up", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  let closed = false;
  const closing = r.close("p").then(() => {
    closed = true;
  });
  await turn();
  assert.equal(closed, false, "nothing to close until the launch is through");
  driver.finish("p");
  await launching;
  await closing;
  assert.deepEqual(driver.closes, ["p"]);
  assert.equal(r.isRunning("p"), false);
});

test("close during a failing launch has nothing to do", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  const closing = r.close("p");
  driver.fail("p", "no browser");
  await assert.rejects(launching, (e) => code(e) === "LAUNCH_FAILED");
  await closing;
  assert.deepEqual(driver.closes, []);
});

test("a launch after a close waits until the browser let go of its data dir", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  driver.finish("p");
  await launching;
  let release = (): void => {};
  driver.close = async (profileId) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    driver.running.delete(profileId);
    driver.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
  };
  const closing = r.close("p");
  await turn();
  const relaunching = r.launch("p");
  await turn();
  assert.deepEqual(driver.launches, ["p"], "no second browser on the same data dir yet");
  release();
  await closing;
  await turn();
  assert.deepEqual(driver.launches, ["p", "p"]);
  driver.finish("p");
  await relaunching;
});

test("closeAll: a launch finishing after it had begun is closed and fails", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  const closingAll = r.closeAll();
  await turn();
  driver.finish("p");
  await assert.rejects(launching, (e) => code(e) === "LAUNCH_FAILED");
  await closingAll;
  assert.deepEqual(driver.closes, ["p"]);
  assert.equal(driver.running.size, 0);
});

test("closeAll waits for a close already under way, even one that fails", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  driver.finish("p");
  await launching;
  let finish: (e?: Error) => void = () => {};
  driver.close = () =>
    new Promise<void>((resolve, reject) => {
      finish = (e) => (e ? reject(e) : resolve());
    });
  driver.closeAll = async () => {};
  const closing = r.close("p").catch(() => {});
  await turn();
  let done = false;
  const closingAll = r.closeAll().then(() => {
    done = true;
  });
  await turn();
  assert.equal(done, false, "that browser is still going down");
  finish(new Error("it went badly"));
  await closingAll;
  await closing;
});

test("closeAll covers launches: it doesn't return before they have settled", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const launching = r.launch("p");
  await turn();
  let done = false;
  const closingAll = r.closeAll().then(() => {
    done = true;
  });
  await turn();
  assert.equal(done, false);
  driver.fail("p", "gone");
  await assert.rejects(launching);
  await closingAll;
});

test("once shutting down, a new launch is refused and starts nothing", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  await r.closeAll();
  await assert.rejects(r.launch("p"), (e) => code(e) === "LAUNCH_FAILED");
  assert.deepEqual(driver.launches, []);
});

test("closeAll calls off a launch still waiting for a slot", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1 });
  const first = r.launch("a");
  await turn();
  driver.finish("a");
  await first;
  const waiting = r.launch("b");
  await turn();
  await r.closeAll();
  await assert.rejects(waiting, (e) => code(e) === "LAUNCH_FAILED");
  assert.deepEqual(driver.launches, ["a"]);
});

test("a browser that died the moment it came up isn't bound and gives its slot back", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1, browserQueueTimeoutMs: 20 });
  const launching = r.launch("a");
  await turn();
  driver.running.delete("a");
  driver.finish("a");
  driver.isRunning = () => false;
  await assert.rejects(launching, /exited right after/);
  assert.equal(r.isRunning("a"), false);
  driver.isRunning = (id) => driver.running.has(id);
  const next = r.launch("b");
  await turn();
  driver.finish("b");
  await next;
});

// ── the browser limit ────────────────────────────────────────────────────────

test("the third profile waits at limit 2, then gets BROWSER_LIMIT_REACHED", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 2, browserQueueTimeoutMs: 40 });
  const launches = [r.launch("a"), r.launch("b")];
  await turn();
  driver.finish("a");
  driver.finish("b");
  await Promise.all(launches);

  const startedAt = Date.now();
  const error = await r.launch("c").then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as MultizenError,
  );
  assert.equal(code(error), "BROWSER_LIMIT_REACHED");
  assert.equal(error.retryable, true);
  assert.ok(Date.now() - startedAt >= 35);
  assert.deepEqual(driver.launches, ["a", "b"], "no browser started for it");
  assert.equal(r.isRunning("c"), false);
});

test("the third profile starts as soon as one closes", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 2 });
  const launches = [r.launch("a"), r.launch("b")];
  await turn();
  driver.finish("a");
  driver.finish("b");
  await Promise.all(launches);

  const third = r.launch("c");
  await turn();
  assert.deepEqual(driver.launches, ["a", "b"]);
  await r.close("a");
  await turn();
  assert.deepEqual(driver.launches, ["a", "b", "c"]);
  driver.finish("c");
  await third;
});

test("starting counts: a browser coming up takes its slot before it is up", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1, browserQueueTimeoutMs: 20 });
  const starting = r.launch("a");
  await turn();
  await assert.rejects(r.launch("b"), (e) => code(e) === "BROWSER_LIMIT_REACHED");
  driver.finish("a");
  await starting;
});

test("a failed launch gives its slot back", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1 });
  const failing = r.launch("a");
  const waiting = r.launch("b");
  await turn();
  assert.deepEqual(driver.launches, ["a"]);
  driver.fail("a", "no browser");
  await assert.rejects(failing);
  await turn();
  assert.deepEqual(driver.launches, ["a", "b"]);
  driver.finish("b");
  await waiting;
});

test("a killed browser gives its slot back", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1 });
  const first = r.launch("a");
  await turn();
  driver.finish("a");
  await first;
  const waiting = r.launch("b");
  await turn();
  driver.exit("a");
  await turn();
  assert.deepEqual(driver.launches, ["a", "b"]);
  driver.finish("b");
  await waiting;
  assert.equal(r.isRunning("a"), false);
});

test("slots free once: a close and the driver's own event don't count twice", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 2, browserQueueTimeoutMs: 20 });
  const launches = [r.launch("a"), r.launch("b")];
  await turn();
  driver.finish("a");
  driver.finish("b");
  await Promise.all(launches);
  await r.close("a"); // emits "closed" and returns: two reports of one end
  driver.exit("a"); // and a late third
  const c = r.launch("c");
  await turn();
  driver.finish("c");
  await c;
  await assert.rejects(r.launch("d"), (e) => code(e) === "BROWSER_LIMIT_REACHED");
});

test("both engines are counted together", async () => {
  const chromium = new SlowDriver();
  const firefox = new SlowDriver();
  const r = limitedRouter(chromium, { maxBrowsers: 2, browserQueueTimeoutMs: 20 });
  withFakeFirefox(r, firefox);
  const launches = [r.launch("cloak1"), r.launch("fox1")];
  await turn();
  chromium.finish("cloak1");
  firefox.finish("fox1");
  await Promise.all(launches);

  await assert.rejects(r.launch("cloak2"), (e) => code(e) === "BROWSER_LIMIT_REACHED");
  await assert.rejects(r.launch("fox2"), (e) => code(e) === "BROWSER_LIMIT_REACHED");

  // A Camoufox browser's slot goes to a CloakBrowser profile.
  firefox.exit("fox1");
  const next = r.launch("cloak2");
  await turn();
  chromium.finish("cloak2");
  await next;
  assert.deepEqual(chromium.launches, ["cloak1", "cloak2"]);
});

test("a launch can leave the queue for a slot; the driver is never asked", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1 });
  const first = r.launch("a");
  await turn();
  driver.finish("a");
  await first;
  const client = new AbortController();
  const waiting = r.launch("b", { signal: client.signal });
  await turn();
  client.abort();
  await assert.rejects(waiting, (e) => code(e) === "LAUNCH_FAILED");
  assert.deepEqual(driver.launches, ["a"]);
  assert.equal(r.isRunning("b"), false);
});

test("close calls off a launch still waiting for a slot, and it takes none", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver, { maxBrowsers: 1, browserQueueTimeoutMs: 20 });
  const first = r.launch("a");
  await turn();
  driver.finish("a");
  await first;
  const waiting = r.launch("b");
  await turn();
  await r.close("b");
  await assert.rejects(waiting, (e) => code(e) === "LAUNCH_FAILED");
  assert.deepEqual(driver.launches, ["a"]);
});

test("close during an engine download doesn't sit through it, and no browser comes of the launch", async () => {
  const bootstrap = new FakeBootstrap(false);
  const driver = new FakeDriver();
  const r = router(bootstrap, driver);
  const launching = r.launch("p");
  await turn();
  await r.close("p");
  await assert.rejects(launching, (e) => code(e) === "LAUNCH_FAILED");
  bootstrap.finishInstall();
  await turn();
  assert.equal(driver.launches, 0);
});

test("a client that stops waiting during an engine download doesn't call the launch off", async () => {
  const bootstrap = new FakeBootstrap(false);
  const driver = new FakeDriver();
  const r = router(bootstrap, driver);
  const client = new AbortController();
  const launching = r.launch("p", { signal: client.signal });
  await turn();
  client.abort();
  await turn();
  (bootstrap as unknown as { installed: boolean }).installed = true;
  bootstrap.finishInstall();
  await launching;
  assert.equal(driver.launches, 1);
});

test("no limit by default, as on the desktop", async () => {
  const driver = new SlowDriver();
  const r = limitedRouter(driver);
  const ids = Array.from({ length: 50 }, (_, i) => `p${i}`);
  const launches = ids.map((id) => r.launch(id));
  await turn();
  assert.equal(driver.launches.length, 50);
  ids.forEach((id) => driver.finish(id));
  await Promise.all(launches);
});

test("two launches during the Firefox import load one driver", async () => {
  const r = limitedRouter(new SlowDriver());
  const internals = r as unknown as { firefox: () => Promise<unknown> };
  const [a, b] = await Promise.all([internals.firefox(), internals.firefox()]);
  assert.equal(a, b);
  assert.ok(a);
});

// ── display modes ────────────────────────────────────────────────────────────

/** Records what the router resolved, and answers for it as an engine's driver does. */
class ModeDriver extends EventEmitter {
  launches: Array<LaunchOptions | undefined> = [];
  running: DisplayMode | null = null;

  async launch(profileId: ProfileId, opts?: LaunchOptions): Promise<LaunchedProfile> {
    this.launches.push(opts);
    this.running ??= opts?.displayMode ?? "headed";
    return { id: profileId, cdpEndpoint: "", pid: 1, startedAt: "now", displayMode: this.running };
  }
  async close(profileId: ProfileId): Promise<void> {
    this.running = null;
    this.emit("running-changed", { kind: "closed", profileId, reason: "user-close" });
  }
  isRunning(): boolean {
    return this.running !== null;
  }
  runningDisplayMode(): DisplayMode | null {
    return this.running;
  }
  async closeAll(): Promise<void> {}
}

const WINDOWS_MACHINE = { platform: "win32", env: {}, hasXvfb: () => false } as const;

function modeRouter(
  driver: ModeDriver,
  overrides: Partial<EngineRouterOptions> & { saved?: DisplayMode } = {},
): EngineRouter {
  const { saved, ...options } = overrides;
  return new EngineRouter({
    profileManager: {
      get: (id: ProfileId) =>
        ({ id, engine: "cloakbrowser", dataDir: "unused", displayMode: saved }) as Profile,
    } as unknown as ProfileManager,
    engineRegistry: { get: () => new FakeBootstrap(true) } as unknown as EngineRegistry,
    getDefaultEngine: (): BrowserEngine => "cloakbrowser",
    chromiumDriver: driver as unknown as ChromiumBrowserDriver,
    displayEnvironment: WINDOWS_MACHINE,
    ...options,
  });
}

test("the desktop's router, with nothing configured: headed, as it always was", async () => {
  const driver = new ModeDriver();
  const launched = await modeRouter(driver).launch("p");
  assert.equal(driver.launches[0]?.displayMode, "headed");
  assert.equal(launched.displayMode, "headed");
});

test("the driver gets the concrete mode: the profile's, the setting's, the flag's, the caller's", async () => {
  const cases: Array<[Partial<EngineRouterOptions> & { saved?: DisplayMode }, LaunchOptions, DisplayMode]> = [
    [{ saved: "headless" }, {}, "headless"],
    [{ getDefaultDisplayMode: () => "headless" }, {}, "headless"],
    [{ displayModeDefault: "headless" }, {}, "headless"],
    [{ saved: "headed", getDefaultDisplayMode: () => "headless" }, {}, "headed"],
    [{ saved: "headless" }, { displayMode: "headed" }, "headed"],
    [{ displayModeDefault: "auto" }, {}, "headed"],
  ];
  for (const [options, launchOptions, expected] of cases) {
    const driver = new ModeDriver();
    await modeRouter(driver, options).launch("p", launchOptions);
    assert.equal(driver.launches[0]?.displayMode, expected, JSON.stringify(options));
  }
});

test("the setting is read at each launch, so a change applies without a restart", async () => {
  const driver = new ModeDriver();
  let setting: DisplayMode | undefined;
  const r = modeRouter(driver, { getDefaultDisplayMode: () => setting });
  await r.launch("p");
  assert.equal(driver.launches.at(-1)?.displayMode, "headed");
  await r.close("p");
  setting = "headless";
  await r.launch("p");
  assert.equal(driver.launches.at(-1)?.displayMode, "headless");
});

test("--headless: a profile saved as headed launches headless", async () => {
  const driver = new ModeDriver();
  const r = modeRouter(driver, { saved: "headed", forcedDisplayMode: "headless" });
  const launched = await r.launch("p");
  assert.equal(driver.launches[0]?.displayMode, "headless");
  assert.equal(launched.displayMode, "headless");
});

test("--headless: an explicit contradiction is INVALID_INPUT, and starts nothing", async () => {
  const driver = new ModeDriver();
  const r = modeRouter(driver, { forcedDisplayMode: "headless" });
  await assert.rejects(r.launch("p", { displayMode: "headed" }), (e) => code(e) === "INVALID_INPUT");
  assert.equal(driver.launches.length, 0);
  await r.launch("p", { displayMode: "headless" });
  assert.equal(driver.launches.length, 1);
});

test("what the machine can't do is refused before any engine or browser work", async () => {
  const driver = new ModeDriver();
  const bootstrap = new FakeBootstrap(true);
  const r = new EngineRouter({
    profileManager: { get: () => ({ engine: "cloakbrowser" }) } as unknown as ProfileManager,
    engineRegistry: { get: () => bootstrap } as unknown as EngineRegistry,
    getDefaultEngine: (): BrowserEngine => "cloakbrowser",
    chromiumDriver: driver as unknown as ChromiumBrowserDriver,
    displayEnvironment: WINDOWS_MACHINE,
  });
  await assert.rejects(r.launch("p", { displayMode: "xvfb" }), (e) => code(e) === "DISPLAY_UNAVAILABLE");
  assert.equal(bootstrap.ensureCalls, 0);
  assert.equal(driver.launches.length, 0);
});

test("a saved mode this machine can't run fails the launch: nothing else is quietly chosen", async () => {
  const driver = new ModeDriver();
  await assert.rejects(modeRouter(driver, { saved: "xvfb" }).launch("p"), (e) => code(e) === "DISPLAY_UNAVAILABLE");
  assert.equal(driver.launches.length, 0);
});

test("running: no parameter stays idempotent, and so does naming the mode it runs in", async () => {
  const driver = new ModeDriver();
  const r = modeRouter(driver);
  await r.launch("p", { displayMode: "headless" });
  assert.equal((await r.launch("p")).displayMode, "headless");
  assert.equal((await r.launch("p", { displayMode: "headless" })).displayMode, "headless");
  assert.equal(r.runningDisplayMode("p"), "headless");
});

test("running: no parameter stays idempotent even when the saved mode has since become impossible", async () => {
  const driver = new ModeDriver();
  let setting: DisplayMode | undefined;
  const r = modeRouter(driver, { getDefaultDisplayMode: () => setting });
  await r.launch("p");
  setting = "xvfb";
  assert.equal((await r.launch("p")).displayMode, "headed");
});

test("running: an explicit mismatch is PROFILE_ALREADY_RUNNING with the way out, and starts nothing", async () => {
  const driver = new ModeDriver();
  const r = modeRouter(driver);
  await r.launch("p", { displayMode: "headless" });
  const launchesBefore = driver.launches.length;
  const error = await r.launch("p", { displayMode: "headed" }).then(
    () => assert.fail("expected a refusal"),
    (e: unknown) => e as MultizenError,
  );
  assert.equal(code(error), "PROFILE_ALREADY_RUNNING");
  assert.equal(error.retryable, false);
  assert.match(error.message, /"headless", not "headed"/);
  assert.match(error.hint ?? "", /close_profile/);
  assert.equal(driver.launches.length, launchesBefore);
  assert.equal(r.runningDisplayMode("p"), "headless");

  await r.close("p");
  assert.equal(r.runningDisplayMode("p"), null);
  assert.equal((await r.launch("p", { displayMode: "headed" })).displayMode, "headed");
});

test("running under --headless: a contradiction is still INVALID_INPUT, not a matter of closing", async () => {
  const driver = new ModeDriver();
  const r = modeRouter(driver, { forcedDisplayMode: "headless" });
  await r.launch("p");
  await assert.rejects(r.launch("p", { displayMode: "headed" }), (e) => code(e) === "INVALID_INPUT");
});

test("during a launch: the same rules, against the mode that launch is bringing up", async () => {
  const driver = new ModeDriver();
  let release = (): void => {};
  const original = driver.launch.bind(driver);
  driver.launch = async (id, opts) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(id, opts);
  };
  const r = modeRouter(driver);
  const first = r.launch("p", { displayMode: "headless" });
  await assert.rejects(r.launch("p", { displayMode: "headed" }), (e) => code(e) === "PROFILE_ALREADY_RUNNING");
  const shared = r.launch("p");
  const named = r.launch("p", { displayMode: "headless" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  release();
  const results = await Promise.all([first, shared, named]);
  assert.deepEqual(results.map((l) => l.displayMode), ["headless", "headless", "headless"]);
  assert.equal(driver.launches.length, 1, "one browser");
});

test("a stopped Camoufox profile's download can be deleted with its driver not loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-router-"));
  try {
    const earlier = await DownloadTracker.open(join(dir, "downloads"));
    earlier.began({ guid: "g1", url: "http://site/f", suggestedFilename: "report.txt" });
    writeFileSync(join(dir, "downloads", "g1"), "bytes");
    earlier.progress({ guid: "g1", totalBytes: 5, receivedBytes: 5, state: "completed" });
    await earlier.settled();

    const r = new EngineRouter({
      profileManager: {
        get: (id: ProfileId) => ({ id, engine: "camoufox", dataDir: dir }) as Profile,
      } as unknown as ProfileManager,
      engineRegistry: { get: () => new FakeBootstrap(true) } as unknown as EngineRegistry,
      getDefaultEngine: (): BrowserEngine => "cloakbrowser",
      chromiumDriver: new FakeDriver() as unknown as ChromiumBrowserDriver,
    });
    const [record] = await r.listDownloads("p");
    assert.equal(await r.deleteDownload("p", "nope"), false);
    assert.equal(await r.deleteDownload("p", record!.id), true);
    assert.deepEqual(await r.listDownloads("p"), []);
    assert.equal(existsSync(join(dir, "downloads", "report.txt")), false);
    assert.equal((r as unknown as { firefoxDriver: unknown }).firefoxDriver, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
