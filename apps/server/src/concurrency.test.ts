import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ChromiumBrowserDriver,
  EngineRouter,
  type EngineRegistry,
  type RuntimeHost,
} from "@multizen/browser-runtime";
import { CdpSession } from "@multizen/cdp-driver";
import { createMultizenMcpServer, createSharedMcpState } from "@multizen/mcp-server";
import type { SharedMcpState } from "@multizen/mcp-server";
import type { ProfileManager } from "@multizen/profile-manager";
import type { ChromiumStatus, LaunchedProfile, Profile, ProfileId } from "@multizen/types";

/**
 * The MCP gate over the real router, the real Chromium driver and a real CdpSession, with
 * only the browser at the far end faked. This is the one workspace allowed to import both
 * sides. scripts/e2e.ts does the same against a real browser.
 */

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const X_OF_SELECTOR: Record<string, number> = { "#a": 10, "#b": 20, "#c": 30 };

/** A browser behind one websocket. Each command takes a turn of the event loop, as a socket does. */
class FakeBrowser extends EventEmitter {
  readonly log: Sent[] = [];
  readonly hang = new Set<string>();
  private readonly released: Array<() => void> = [];
  /** Answers Browser.close; a real one takes a moment and then exits. */
  onBrowserClose: () => void = () => {};

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /** Lets go of what is hanging: the page came back after all. */
  unhang(): void {
    this.hang.clear();
    for (const release of this.released.splice(0)) release();
  }

  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.log.push({ method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    if (this.hang.has(method)) {
      await new Promise<void>((resolve) => this.released.push(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    return this.answer(method, params ?? {}, sessionId);
  }

  private answer(method: string, params: Record<string, unknown>, sessionId?: string): unknown {
    switch (method) {
      case "Target.setAutoAttach":
        if (!sessionId) {
          this.emit("Target.attachedToTarget", {
            sessionId: "S",
            targetInfo: { targetId: "T", type: "page", url: "http://t/" },
            waitingForDebugger: true,
          });
        }
        return {};
      case "Target.getTargets":
        return { targetInfos: [{ targetId: "T", type: "page", url: "http://t/" }] };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "F", loaderId: "L" } } };
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      case "Runtime.evaluate":
        return this.evaluate(String(params.expression));
      case "Browser.close":
        this.onBrowserClose();
        return {};
      default:
        return {};
    }
  }

  private evaluate(expression: string): unknown {
    if (expression.includes("return JSON.stringify")) {
      const delivered = { pressed: true, released: true, keys: 100, hidden: false, painted: true };
      return { result: { value: JSON.stringify(delivered) } };
    }
    const selector = /querySelector\("([^"]+)"\)/.exec(expression)?.[1];
    if (selector) {
      if (expression.includes("focus")) return { result: { value: true } };
      if (expression.includes("getBoundingClientRect")) {
        return { result: { value: { ok: true, x: X_OF_SELECTOR[selector] ?? 0, y: 5 } } };
      }
      return { result: { value: selector === "#present" } };
    }
    return { result: { value: null } };
  }

  async close(): Promise<void> {}

  /** Which element each mouse event of the log went to, in order. */
  mouseTargets(): number[] {
    return this.log
      .filter((c) => c.method === "Input.dispatchMouseEvent")
      .map((c) => c.params.x as number);
  }

  /** A condensed log of what input went out: one letter per key, m<x> per mouse event. */
  inputs(): string[] {
    return this.log.flatMap((c) => {
      if (c.method === "Input.dispatchMouseEvent") return [`m${String(c.params.x)}`];
      if (c.method === "Input.dispatchKeyEvent" && c.params.type !== "keyUp") {
        return [`k${String(c.params.key)}`];
      }
      return [];
    });
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
  kill(): boolean {
    this.exit();
    return true;
  }
}

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

const READY = { kind: "ready", version: "146.0.0.0", binaryPath: "unused" } satisfies ChromiumStatus;

function stack(opts: { maxBrowsers?: number; browserQueueTimeoutMs?: number } = {}): {
  driver: ChromiumBrowserDriver;
  router: EngineRouter;
} {
  const profileManager = {
    get: (id: ProfileId) => ({ id, dataDir: "unused-dir", engine: "cloakbrowser" }) as Profile,
    markOpened: () => {},
  } as unknown as ProfileManager;
  const engineRegistry = {
    get: () => ({
      ensure: async () => READY,
      getStatus: () => READY,
      resolveBinaryPath: () => "unused",
      getInstalledVersion: () => READY.version,
    }),
  } as unknown as EngineRegistry;
  const driver = new ChromiumBrowserDriver({
    host,
    profileManager,
    engineRegistry,
    getDefaultEngine: () => "cloakbrowser",
    extensionStoreRoot: "unused",
  });
  const router = new EngineRouter({
    profileManager,
    engineRegistry,
    getDefaultEngine: () => "cloakbrowser",
    chromiumDriver: driver,
    displayEnvironment: { platform: "win32", env: {}, hasXvfb: () => false },
    ...opts,
  });
  return { driver, router };
}

/** What doLaunch leaves behind, with a real session on a fake socket. */
async function graftRunning(
  driver: ChromiumBrowserDriver,
  id: ProfileId,
  opts: { operationDeadlineMs?: number } = {},
): Promise<{ browser: FakeBrowser; child: FakeChild }> {
  const browser = new FakeBrowser();
  const child = new FakeChild();
  browser.onBrowserClose = () => child.exit();
  const session = new CdpSession({ port: 0, ...opts });
  (session as unknown as { openBrowserSocket: () => Promise<unknown> }).openBrowserSocket = async () =>
    browser;
  await session.connect();
  const record = {
    child,
    session,
    pid: 0,
    port: 1,
    cdpEndpoint: "http://127.0.0.1:1",
    startedAt: "now",
    browserDataDir: "unused",
    windowWatcher: setInterval(() => {}, 60_000).unref(),
  };
  (driver as unknown as { running: Map<ProfileId, unknown> }).running.set(id, record);
  return { browser, child };
}

function bindRunning(router: EngineRouter, driver: ChromiumBrowserDriver, id: ProfileId): void {
  (router as unknown as { bindings: Map<ProfileId, unknown> }).bindings.set(id, driver);
}

async function running(
  opts: { operationDeadlineMs?: number; mutexWaitMs?: number } = {},
): Promise<{
  driver: ChromiumBrowserDriver;
  router: EngineRouter;
  browser: FakeBrowser;
  child: FakeChild;
  shared: SharedMcpState;
}> {
  const { driver, router } = stack();
  const { browser, child } = await graftRunning(driver, "p", opts);
  bindRunning(router, driver, "p");
  const shared = createSharedMcpState(opts.mutexWaitMs ? { mutex: { waitMs: opts.mutexWaitMs } } : {});
  return { driver, router, browser, child, shared };
}

const CLIENTS: Client[] = [];
after(async () => {
  await Promise.all(CLIENTS.map((c) => c.close().catch(() => {})));
});

async function session(
  shared: SharedMcpState,
  router: EngineRouter,
  sessionId: string,
): Promise<Client> {
  const { server } = createMultizenMcpServer({
    profileManager: {
      get: (id: ProfileId) => ({ id, dataDir: "unused-dir" }) as Profile,
    } as unknown as ProfileManager,
    browserDriver: router,
    shared,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = sessionId;
  const client = new Client({ name: sessionId, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  CLIENTS.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: { profile_id: "p", ...args } });
  const content = res.content as Array<{ text?: string }>;
  return {
    isError: res.isError === true,
    body: JSON.parse(content[0]?.text ?? "{}") as Record<string, any>,
  };
}

function assertErrorCode(result: Awaited<ReturnType<typeof call>>, code: string): Record<string, any> {
  assert.equal(result.isError, true, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body.error));
  return result.body.error;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** True when each element's mouse events all sit together, none cut into another's. */
function grouped(targets: number[]): boolean {
  const seen = new Set<number>();
  let last: number | undefined;
  for (const x of targets) {
    if (x !== last && seen.has(x)) return false;
    seen.add(x);
    last = x;
  }
  return true;
}

test("control: without the gate, two clicks do interleave on this fake", async () => {
  const { driver, router, browser } = await running();
  await Promise.all([router.click("p", "#a"), router.click("p", "#b")]);
  assert.equal(grouped(browser.mouseTargets()), false, browser.mouseTargets().join(","));
  await driver.close("p");
});

test("two parallel clicks from two sessions don't interleave, through the real verb path", async () => {
  const { driver, router, browser, shared } = await running();
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  const c = await session(shared, router, "c");
  const results = await Promise.all([
    call(a, "click", { selector: "#a" }),
    call(b, "click", { selector: "#b" }),
    call(c, "click", { selector: "#c" }),
  ]);
  for (const result of results) assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.deepEqual(browser.mouseTargets(), [10, 10, 10, 20, 20, 20, 30, 30, 30]);
  await driver.close("p");
});

test("a whole operation is one turn: a click can't cut into typed text", async () => {
  const { driver, router, browser, shared } = await running();
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  await Promise.all([
    call(a, "type", { selector: "#i", text: "hey" }),
    call(b, "click", { selector: "#b" }),
  ]);
  assert.deepEqual(browser.inputs(), ["kh", "ke", "ky", "m20", "m20", "m20"]);
  await driver.close("p");
});

test("wait_* polls through the real session and lets a click in between polls", async () => {
  const { driver, router, browser, shared } = await running();
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  const waiting = call(a, "wait_for_selector", { selector: "#never", timeout_ms: 700 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const startedAt = Date.now();
  assert.equal((await call(b, "click", { selector: "#b" })).isError, false);
  assert.ok(Date.now() - startedAt < 500, "the click waited for the wait to end");
  assert.deepEqual((await waiting).body, { found: false, selector: "#never" });
  assert.deepEqual(browser.mouseTargets(), [20, 20, 20]);
  await driver.close("p");
});

test("a wedged call is preempted by close_profile: the holder fails fast, the queue with it", async () => {
  const { router, browser, child, shared } = await running();
  const holder = await session(shared, router, "holder");
  const queued = await session(shared, router, "queued");
  const closer = await session(shared, router, "closer");
  browser.hang.add("Page.captureScreenshot");
  // A browser that takes its time going, as a real one with a stuck page does.
  browser.onBrowserClose = () => setTimeout(() => child.exit(), 400);

  const wedged = call(holder, "screenshot");
  await settle();
  const waiting = call(queued, "click", { selector: "#a" });
  await settle();
  assert.equal(shared.mutex.queued("p"), 1);

  const startedAt = Date.now();
  const closing = call(closer, "close_profile");
  assertErrorCode(await waiting, "PROFILE_NOT_RUNNING");
  assertErrorCode(await wedged, "PROFILE_NOT_RUNNING");
  assert.ok(Date.now() - startedAt < 300, `the holder took ${Date.now() - startedAt} ms to fail`);
  assert.equal(shared.mutex.isHeld("p"), false);
  assert.equal(child.exitCode, null, "and all that before the browser was even gone");

  assert.equal((await closing).isError, false);
  assert.equal(child.exitCode, 0);
  assert.equal(router.isRunning("p"), false);
  assert.deepEqual(browser.mouseTargets(), []);
});

test("a wedged call ends at its deadline, which unsticks the profile, and sends nothing after", async () => {
  const { driver, router, browser, shared } = await running({ operationDeadlineMs: 400 });
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  browser.hang.add("Runtime.evaluate");
  const wedged = call(a, "click", { selector: "#a" });
  await settle();
  const next = call(b, "click", { selector: "#b" });
  const error = assertErrorCode(await wedged, "TIMEOUT");
  assert.equal(error.retryable, true);
  // The next call now takes its turn, and is what comes through when the page recovers.
  browser.unhang();
  assert.equal((await next).isError, false, "the queue moved on");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(browser.mouseTargets(), [20, 20, 20]);
  await driver.close("p");
});

test("a client that disconnects drops its queued click: it never lands on the next agent's page", async () => {
  const { driver, router, browser, shared } = await running();
  const holder = await session(shared, router, "holder");
  const leaving = await session(shared, router, "leaving");
  browser.hang.add("Page.captureScreenshot");
  const holding = call(holder, "screenshot");
  await settle();
  void leaving
    .callTool({ name: "click", arguments: { profile_id: "p", selector: "#a" } })
    .catch(() => {});
  await settle();
  assert.equal(shared.mutex.queued("p"), 1);

  await leaving.close();
  await settle();
  assert.equal(shared.mutex.queued("p"), 0);

  browser.unhang();
  assert.equal((await holding).isError, false);
  await settle();
  assert.deepEqual(browser.mouseTargets(), []);
  await driver.close("p");
});

test("a queue timeout never fires the click, on the real verb path", async () => {
  const { driver, router, browser, shared } = await running({ mutexWaitMs: 30 });
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  browser.hang.add("Page.captureScreenshot");
  const holding = call(a, "screenshot");
  await settle();
  const error = assertErrorCode(await call(b, "click", { selector: "#a" }), "TIMEOUT");
  assert.equal(error.retryable, true);
  browser.unhang();
  await holding;
  await settle();
  assert.deepEqual(browser.mouseTargets(), []);
  await driver.close("p");
});

// ── launches through the gate, the router and the driver's own wrapper ───────

/** doLaunch replaced by one that ends when told. The router and wrapper around it are real. */
function slowDoLaunch(
  driver: ChromiumBrowserDriver,
): { calls: ProfileId[]; finish: (id: ProfileId) => Promise<void>; children: Map<ProfileId, FakeChild> } {
  const calls: ProfileId[] = [];
  const pending = new Map<ProfileId, () => void>();
  const children = new Map<ProfileId, FakeChild>();
  (driver as unknown as { doLaunch: unknown }).doLaunch = async (id: ProfileId): Promise<LaunchedProfile> => {
    calls.push(id);
    await new Promise<void>((resolve) => pending.set(id, resolve));
    const { child } = await graftRunning(driver, id);
    children.set(id, child);
    // As the real one wires it.
    child.on("exit", () => {
      const tracked = (driver as unknown as { running: Map<ProfileId, unknown> }).running.delete(id);
      if (tracked) driver.emit("running-changed", { kind: "closed", profileId: id, reason: "external-exit" });
    });
    return { id, cdpEndpoint: "http://127.0.0.1:1", pid: 0, startedAt: "now" };
  };
  return {
    calls,
    children,
    finish: async (id) => {
      while (!pending.has(id)) await settle();
      pending.get(id)!();
      pending.delete(id);
    },
  };
}

test("two sessions launching at once get one browser", async () => {
  const { driver, router } = stack();
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  const launches = [call(a, "launch_profile"), call(b, "launch_profile")];
  await slow.finish("p");
  const results = await Promise.all(launches);
  assert.deepEqual(slow.calls, ["p"]);
  for (const result of results) assert.equal(result.isError, false, JSON.stringify(result.body));
  assert.equal(results[0]!.body.id, results[1]!.body.id);
  await router.closeAll();
});

test("close during launch: the browser it brought up is closed", async () => {
  const { driver, router } = stack();
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const a = await session(shared, router, "a");
  const b = await session(shared, router, "b");
  const launching = call(a, "launch_profile");
  await settle();
  const closing = call(b, "close_profile");
  await settle();
  await slow.finish("p");
  await launching;
  assert.equal((await closing).isError, false);
  assert.equal(router.isRunning("p"), false);
  assert.equal(driver.isRunning("p"), false);
});

test("shutdown during launch kills the late browser", async () => {
  const { driver, router } = stack();
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const a = await session(shared, router, "a");
  const launching = call(a, "launch_profile");
  await settle();
  const shutdown = router.closeAll();
  await slow.finish("p");
  assertErrorCode(await launching, "LAUNCH_FAILED");
  await shutdown;
  assert.equal(slow.children.get("p")?.exitCode, 0, "the browser it brought up is gone");
  assert.equal(driver.isRunning("p"), false);
  assertErrorCode(await call(a, "launch_profile"), "LAUNCH_FAILED");
});

test("the limit through the gate: the third waits, a close lets it in; none closing times out", async () => {
  const { driver, router } = stack({ maxBrowsers: 2, browserQueueTimeoutMs: 300 });
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const s = await session(shared, router, "s");
  const up = [call(s, "launch_profile", { profile_id: "a" }), call(s, "launch_profile", { profile_id: "b" })];
  await slow.finish("a");
  await slow.finish("b");
  await Promise.all(up);

  const third = call(s, "launch_profile", { profile_id: "c" });
  await settle();
  assert.deepEqual(slow.calls, ["a", "b"]);
  await call(s, "close_profile", { profile_id: "a" });
  await slow.finish("c");
  assert.equal((await third).isError, false);

  const error = assertErrorCode(
    await call(s, "launch_profile", { profile_id: "d" }),
    "BROWSER_LIMIT_REACHED",
  );
  assert.equal(error.retryable, true);
  assert.equal(error.details.max_browsers, 2);
  assert.deepEqual(slow.calls, ["a", "b", "c"]);
  await router.closeAll();
});

test("a killed browser frees its slot, through the driver's own exit path", async () => {
  const { driver, router } = stack({ maxBrowsers: 1 });
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const s = await session(shared, router, "s");
  const first = call(s, "launch_profile", { profile_id: "a" });
  await slow.finish("a");
  await first;

  const second = call(s, "launch_profile", { profile_id: "b" });
  await settle();
  assert.deepEqual(slow.calls, ["a"]);
  slow.children.get("a")!.exit();
  await slow.finish("b");
  assert.equal((await second).isError, false);
  assert.equal(router.isRunning("a"), false);
  await router.closeAll();
});

test("a client leaving the queue for a slot takes the launch with it", async () => {
  const { driver, router } = stack({ maxBrowsers: 1 });
  const slow = slowDoLaunch(driver);
  const shared = createSharedMcpState();
  const s = await session(shared, router, "s");
  const leaving = await session(shared, router, "leaving");
  const first = call(s, "launch_profile", { profile_id: "a" });
  await slow.finish("a");
  await first;

  void leaving
    .callTool({ name: "launch_profile", arguments: { profile_id: "b" } })
    .catch(() => {});
  await settle();
  await leaving.close();
  await settle();
  await call(s, "close_profile", { profile_id: "a" });
  await settle();
  assert.deepEqual(slow.calls, ["a"], "nobody is left wanting browser b");
  await router.closeAll();
});
