import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultizenError } from "@multizen/types";
import type {
  BrowserEngine,
  ChromiumStatus,
  LaunchedProfile,
  Profile,
  ProfileId,
} from "@multizen/types";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ChromiumBrowserDriver } from "./ChromiumBrowserDriver.ts";
import type { EngineRegistry } from "./engineRegistry.ts";
import { EngineRouter, type EngineRouterOptions } from "./engineRouter.ts";
import { StrictGeoCoherenceError } from "./launchTimezone";

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

test("closing a profile clears its upload inbox and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mz-router-"));
  try {
    const inbox = join(dir, "uploads", ".inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "uuid-a.pdf"), "inbox");
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
