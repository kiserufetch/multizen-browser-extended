import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import { MultizenError } from "@multizen/types";

import { CdpSession, InputNotDeliveredError, type TargetSender } from "./CdpSession.js";
import { describeNamedKey, parseChord } from "./keyboard.js";
import { TargetRegistry } from "./targetRegistry.js";
import type { AccessibilityNode } from "./types.js";

/**
 * A fake browser behind the one websocket: scripted answers per session, events
 * emitted the way chrome-remote-interface does, and a log of every command. Stealth
 * assertions read that log.
 */
interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => unknown;

class FakeBrowser extends EventEmitter {
  readonly log: Sent[] = [];
  readonly handlers = new Map<string, Handler>();
  closed = 0;
  /** Commands whose answer never comes, as with a renderer a dialog is blocking. */
  readonly hang = new Set<string>();

  constructor() {
    super();
    this.setMaxListeners(0);
    this.handlers.set("Target.getTargets", () => ({ targetInfos: [] }));
    this.handlers.set("Target.createTarget", () => ({ targetId: "NEW" }));
    this.handlers.set("Page.createIsolatedWorld", () => ({ executionContextId: 77 }));
    this.handlers.set("Runtime.evaluate", (p) => this.onEvaluate(p));
    this.handlers.set("DOM.getContentQuads", () => ({ quads: [quad(10, 20, 100, 40)] }));
    this.handlers.set("Page.getFrameTree", (_p, sid) => ({
      frameTree: { frame: { id: `F-${sid}`, loaderId: "L1" } },
    }));
  }

  /** The default answer is the probe seeing everything, as on a healthy page. */
  private onEvaluate(p: Record<string, unknown>): unknown {
    const expression = String(p.expression);
    if (expression.includes("visibilityState") && p.contextId !== undefined) {
      return {
        result: {
          value: JSON.stringify({
            pressed: true,
            released: true,
            keys: 100,
            hidden: false,
            painted: true,
          }),
        },
      };
    }
    if (expression.startsWith("JSON.stringify({ url")) {
      return { result: { value: JSON.stringify({ url: "http://t/", title: "T" }) } };
    }
    return { result: {} };
  }

  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.log.push({ method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    if (this.hang.has(method)) return new Promise(() => {});
    const handler = this.handlers.get(method);
    return handler ? handler(params ?? {}, sessionId) : {};
  }

  async close(): Promise<void> {
    this.closed++;
  }

  /** As the transport does: by method, and by method and session. */
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.emit(method, params, sessionId);
    if (sessionId) this.emit(`${method}.${sessionId}`, params, sessionId);
  }

  attachPage(targetId: string, sessionId: string): void {
    this.event("Target.attachedToTarget", {
      sessionId,
      targetInfo: { targetId, type: "page", url: "http://t/" },
      waitingForDebugger: false,
    });
  }

  attachIframe(targetId: string, sessionId: string, parentSessionId: string): void {
    this.event(
      "Target.attachedToTarget",
      {
        sessionId,
        targetInfo: { targetId, type: "iframe", url: "http://x/" },
        waitingForDebugger: true,
      },
      parentSessionId,
    );
  }

  methods(sessionId?: string): string[] {
    return this.log
      .filter((c) => sessionId === undefined || c.sessionId === sessionId)
      .map((c) => c.method);
  }

  calls(method: string): Sent[] {
    return this.log.filter((c) => c.method === method);
  }
}

function quad(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/** A session through the real connect(), on the fake instead of a socket. */
function newSession(browser: FakeBrowser, opts: { platform?: "macos" } = {}): CdpSession {
  const s = new CdpSession({ port: 0, ...opts });
  (s as unknown as { openBrowserSocket: () => Promise<unknown> }).openBrowserSocket = async () =>
    browser;
  return s;
}

async function connected(pages: string[] = ["P"]): Promise<{ b: FakeBrowser; s: CdpSession }> {
  const b = new FakeBrowser();
  b.handlers.set("Target.setAutoAttach", (_p, sid) => {
    // The browser reports its existing pages when asked to auto-attach.
    if (!sid) for (const id of pages) b.attachPage(id, `S-${id}`);
    return {};
  });
  const s = newSession(b);
  await s.connect();
  return { b, s };
}

function axTree(...nodes: Array<{ id: string; role: string; name?: string; backend?: number; kids?: string[] }>) {
  return {
    nodes: nodes.map((n) => ({
      nodeId: n.id,
      role: { value: n.role },
      ...(n.name ? { name: { value: n.name } } : {}),
      ...(n.backend !== undefined ? { backendDOMNodeId: n.backend } : {}),
      ...(n.kids ? { childIds: n.kids } : {}),
    })),
  };
}

function flatten(nodes: AccessibilityNode[]): AccessibilityNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

function refNamed(nodes: AccessibilityNode[], name: string): string {
  const ref = flatten(nodes).find((n) => n.name === name)?.ref;
  assert.ok(ref, `no ref for ${name}`);
  return ref;
}

function assertStealth(b: FakeBrowser): void {
  const methods = b.log.map((c) => c.method);
  assert.ok(!methods.includes("Runtime.enable"), "Runtime.enable must never be sent");
  assert.ok(!methods.includes("DOM.enable"), "DOM.enable must never be sent");
}

async function assertMultizenCode(p: Promise<unknown>, code: string): Promise<MultizenError> {
  const e = await p.then(
    () => assert.fail(`expected ${code}`),
    (err: unknown) => err,
  );
  assert.ok(e instanceof MultizenError, String(e));
  assert.equal(e.code, code, e.message);
  return e;
}

// ── connect ──────────────────────────────────────────────────────────────────

test("connect attaches each page through the browser socket and enables only Page", async () => {
  const { b, s } = await connected(["A", "B"]);
  assert.equal(b.calls("Target.setAutoAttach")[0]?.sessionId, undefined, "browser level first");
  assert.deepEqual(b.calls("Target.setAutoAttach")[0]?.params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "page" }],
  });
  for (const session of ["S-A", "S-B"]) {
    assert.ok(b.methods(session).includes("Page.enable"));
    assert.ok(b.methods(session).includes("Target.setAutoAttach"), "iframes come per page session");
    assert.ok(b.methods(session).includes("Runtime.runIfWaitingForDebugger"));
  }
  assertStealth(b);
  const tabs = (await s.listTabs()) as { activeTargetId: string };
  assert.equal(tabs.activeTargetId, "A");
});

test("connect attaches a page the auto-attach did not report", async () => {
  const b = new FakeBrowser();
  b.handlers.set("Target.getTargets", () => ({
    targetInfos: [{ targetId: "A", type: "page", url: "http://t/" }],
  }));
  b.handlers.set("Target.attachToTarget", () => {
    b.attachPage("A", "S-A");
    return { sessionId: "S-A" };
  });
  const s = newSession(b);
  await s.connect();
  assert.ok(b.methods("S-A").includes("Page.enable"));
});

test("a failed connect closes the socket and leaves the session unconnected", async () => {
  const b = new FakeBrowser();
  b.handlers.set("Target.getTargets", () => {
    throw new Error("browser going away");
  });
  const s = newSession(b);
  await assert.rejects(s.connect(), /browser going away/);
  assert.equal(b.closed, 1);
  assert.equal((s as unknown as { client: unknown }).client, null);
  await assert.rejects(s.cdpSend("Target.getTargets"), /not connected/i);
});

test("connect with no attachable page fails, so the readiness ladder retries", async () => {
  const b = new FakeBrowser();
  const s = newSession(b);
  await assert.rejects(s.connect(), /No page target/);
  assert.equal((s as unknown as { client: unknown }).client, null);
  assert.equal(b.closed, 1);

  b.handlers.set("Target.setAutoAttach", (_p, sid) => {
    if (!sid) b.attachPage("A", "S-A");
    return {};
  });
  await s.connect();
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "A");
});

test("connect fails while no page session can be set up", async () => {
  const b = new FakeBrowser();
  b.handlers.set("Target.setAutoAttach", (_p, sid) => {
    if (!sid) b.attachPage("A", "S-A");
    return {};
  });
  b.handlers.set("Page.enable", () => {
    throw new Error("nope");
  });
  const s = newSession(b);
  await assert.rejects(s.connect(), /No page target/);
  assert.ok(b.methods("S-A").includes("Runtime.runIfWaitingForDebugger"), "resumed anyway");
});

test("a second attach for a known target is resumed and detached, and setup runs once", async () => {
  const { b, s } = await connected(["A"]);
  const setups: string[] = [];
  await s.bootstrapTargets(async (send: TargetSender, ctx) => {
    setups.push(ctx.type);
    await send("Emulation.setLocaleOverride", { locale: "en-US" });
  });
  b.attachPage("A", "S-DUP");
  await settle();
  assert.deepEqual(setups, ["page"]);
  assert.ok(b.methods("S-DUP").includes("Runtime.runIfWaitingForDebugger"));
  assert.deepEqual(
    b.calls("Target.detachFromTarget").map((c) => c.params.sessionId),
    ["S-DUP"],
  );
  assert.ok(!b.methods("S-DUP").includes("Page.enable"));
  await s.navigate("http://t/next").catch(() => {});
  assert.ok(b.calls("Page.navigate").every((c) => c.sessionId === "S-A"), "first session wins");
});

test("setup runs on new targets before they resume, on every tab and iframe", async () => {
  const { b, s } = await connected(["A"]);
  const seen: Array<[string, boolean]> = [];
  await s.bootstrapTargets(async (_send, ctx) => {
    seen.push([ctx.type, ctx.isRoot]);
  });
  b.attachPage("B", "S-B");
  await settle();
  b.attachIframe("IF", "S-IF", "S-B");
  await settle();
  assert.deepEqual(seen, [
    ["page", true],
    ["page", true],
    ["iframe", false],
  ]);
  const order = b.methods("S-B");
  assert.ok(order.indexOf("Page.enable") < order.indexOf("Runtime.runIfWaitingForDebugger"));
  assert.ok(b.methods("S-IF").includes("Runtime.runIfWaitingForDebugger"));
});

test("a target is resumed even when its setup never finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = new FakeBrowser();
  b.handlers.set("Target.setAutoAttach", (_p, sid) => {
    if (!sid) b.attachPage("A", "S-A");
    return {};
  });
  const s = newSession(b);
  const connecting = s.connect();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await connecting;
  b.hang.add("Page.enable");
  b.attachPage("SLOW", "S-SLOW");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!b.methods("S-SLOW").includes("Runtime.runIfWaitingForDebugger"));
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(b.methods("S-SLOW").includes("Runtime.runIfWaitingForDebugger"));
});

test("page and iframe sessions auto-attach iframes, so nested OOPIFs arrive", async () => {
  const { b } = await connected(["A"]);
  b.attachIframe("IF1", "S-IF1", "S-A");
  await settle();
  b.attachIframe("IF2", "S-IF2", "S-IF1");
  await settle();
  for (const session of ["S-IF1", "S-IF2"]) {
    const autoAttach = b.log.find(
      (c) => c.method === "Target.setAutoAttach" && c.sessionId === session,
    );
    assert.deepEqual(autoAttach?.params, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "iframe" }],
    });
    assert.ok(!b.methods(session).includes("Page.enable"), "no enable on an iframe session");
  }
  assertStealth(b);
});

test("a session an agent attached through cdp_send stays its own", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Target.attachToTarget", (p) => {
    b.attachPage(String(p.targetId), "S-AGENT");
    return { sessionId: "S-AGENT" };
  });
  await s.cdpSend("Target.attachToTarget", { targetId: "A", flatten: true });
  await settle();
  assert.deepEqual(b.calls("Target.detachFromTarget"), []);
  await s.cdpSend("Runtime.evaluate", { expression: "1" }, "S-AGENT");
  assert.equal(b.calls("Runtime.evaluate").at(-1)?.sessionId, "S-AGENT");
});

test("a prerender is resumed and not treated as a tab", async () => {
  const { b, s } = await connected(["A"]);
  b.event("Target.attachedToTarget", {
    sessionId: "S-PRE",
    targetInfo: { targetId: "PRE", type: "page", subtype: "prerender" },
    waitingForDebugger: true,
  });
  await settle();
  assert.ok(b.methods("S-PRE").includes("Runtime.runIfWaitingForDebugger"));
  await assertMultizenCode(s.activateTab("PRE"), "TAB_NOT_FOUND");
});

// ── identity ─────────────────────────────────────────────────────────────────

test("browserPid reads the browser process, and null when the command fails", async () => {
  const { b, s } = await connected();
  b.handlers.set("SystemInfo.getProcessInfo", () => ({
    processInfo: [
      { id: 7, type: "renderer" },
      { id: 42, type: "browser" },
    ],
  }));
  assert.equal(await s.browserPid(), 42);
  assert.equal(b.calls("SystemInfo.getProcessInfo")[0]?.sessionId, undefined);
  b.handlers.set("SystemInfo.getProcessInfo", () => {
    throw new Error("unsupported");
  });
  assert.equal(await s.browserPid(), null);
});

// ── routing ──────────────────────────────────────────────────────────────────

test("cdpSend goes to the active tab, an explicit session wins, Target and Browser stay up", async () => {
  const { b, s } = await connected(["A", "B"]);
  await s.cdpSend("Runtime.evaluate", { expression: "1" });
  assert.equal(b.log.at(-1)?.sessionId, "S-A");
  await s.cdpSend("Runtime.evaluate", { expression: "1" }, "S-B");
  assert.equal(b.log.at(-1)?.sessionId, "S-B");
  await s.cdpSend("Target.getTargets");
  assert.equal(b.log.at(-1)?.sessionId, undefined);
  await s.cdpSend("Browser.getVersion");
  assert.equal(b.log.at(-1)?.sessionId, undefined);
  await s.cdpSend("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false });
  assert.equal(b.log.at(-1)?.sessionId, "S-A", "must not detach the browser's own sessions");

  await s.activateTab("B");
  await s.cdpSend("Page.bringToFront");
  assert.equal(b.log.at(-1)?.sessionId, "S-B");
});

test("page verbs act on the active tab", async () => {
  const { b, s } = await connected(["A", "B"]);
  b.handlers.set("Page.captureScreenshot", () => ({ data: "PNG" }));
  await s.screenshot();
  assert.equal(b.log.at(-1)?.sessionId, "S-A");
  await s.activateTab("B");
  await s.screenshot();
  assert.equal(b.log.at(-1)?.sessionId, "S-B");
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "B");
});

test("activate_tab on an unknown target is TAB_NOT_FOUND", async () => {
  const { s } = await connected(["A"]);
  await assertMultizenCode(s.activateTab("nope"), "TAB_NOT_FOUND");
});

test("new_tab waits for the session, activates it, and navigate lands on it", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Target.createTarget", () => {
    setTimeout(() => b.attachPage("NEW", "S-NEW"), 5);
    return { targetId: "NEW" };
  });
  b.handlers.set("Page.navigate", () => ({ frameId: "F", loaderId: "L2" }));
  const created = (await s.newTab()) as { targetId: string };
  assert.equal(created.targetId, "NEW");
  assert.ok(b.methods("S-NEW").includes("Page.enable"), "attached before new_tab returned");
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "NEW");

  const navigating = s.navigate("http://t/x");
  await settle();
  assert.equal(b.calls("Page.navigate")[0]?.sessionId, "S-NEW");
  b.event("Page.loadEventFired", {}, "S-NEW");
  await navigating;
});

test("a popup does not take the active tab, and closing the active one skips it", async () => {
  const { b, s } = await connected(["A", "B"]);
  await s.activateTab("B");
  await s.activateTab("A");
  b.attachPage("POPUP", "S-POP");
  await settle();
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "A");
  await s.closeTab("A");
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "B");
});

test("closing the active tab raises the most recently used one, and the session lives on", async () => {
  const { b, s } = await connected(["ROOT", "B", "C"]);
  await s.activateTab("B");
  await s.activateTab("C");
  await s.activateTab("ROOT");
  await s.closeTab("ROOT");
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "C");
  assert.equal(b.calls("Target.activateTarget").at(-1)?.params.targetId, "C");
  await s.cdpSend("Runtime.evaluate", { expression: "1" });
  assert.equal(b.log.at(-1)?.sessionId, "S-C");
});

test("an active tab closed from outside is reselected, and the next input raises the new one", async () => {
  const { b, s } = await connected(["A", "B"]);
  await s.activateTab("B");
  const activations = b.calls("Target.activateTarget").length;
  b.event("Target.detachedFromTarget", { sessionId: "S-B", targetId: "B" });
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "A");
  assert.equal(b.calls("Target.activateTarget").length, activations, "no raise until it's needed");
  await s.pressKey("Enter");
  assert.equal(b.calls("Target.activateTarget").at(-1)?.params.targetId, "A");
});

test("closing an unknown tab is TAB_NOT_FOUND", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Target.closeTarget", () => {
    throw new Error("No target with given id found");
  });
  await assertMultizenCode(s.closeTab("nope"), "TAB_NOT_FOUND");
});

test("no tab left: a verb says so instead of hanging", async () => {
  const { b, s } = await connected(["A"]);
  b.event("Target.targetDestroyed", { targetId: "A" });
  await assertMultizenCode(s.screenshot(), "TAB_NOT_FOUND");
});

// ── refs ─────────────────────────────────────────────────────────────────────

/** One tab with a same-process iframe and an OOPIF holding a nested OOPIF. */
async function framedPage(): Promise<{ b: FakeBrowser; s: CdpSession; names: Map<string, string> }> {
  const { b, s } = await connected(["A"]);
  b.attachIframe("OOPIF", "S-OOP", "S-A");
  await settle();
  b.attachIframe("NESTED", "S-NEST", "S-OOP");
  await settle();
  b.handlers.set("Page.getFrameTree", (_p, sid) => {
    if (sid === "S-A") {
      return {
        frameTree: {
          frame: { id: "MAIN", loaderId: "LM" },
          childFrames: [{ frame: { id: "SAME", loaderId: "LS" } }],
        },
      };
    }
    if (sid === "S-OOP") return { frameTree: { frame: { id: "OOPIF", loaderId: "LO" } } };
    return { frameTree: { frame: { id: "NESTED", loaderId: "LN" } } };
  });
  b.handlers.set("Accessibility.getFullAXTree", (p) => {
    switch (p.frameId) {
      case "MAIN":
        return axTree(
          { id: "1", role: "RootWebArea", name: "main", backend: 1, kids: ["2", "3", "4"] },
          { id: "2", role: "button", name: "Main button", backend: 11 },
          { id: "3", role: "Iframe", backend: 12 },
          { id: "4", role: "Iframe", backend: 13 },
        );
      case "SAME":
        return axTree(
          { id: "1", role: "RootWebArea", name: "same", backend: 2, kids: ["2"] },
          { id: "2", role: "button", name: "Same button", backend: 21 },
        );
      case "OOPIF":
        return axTree(
          { id: "1", role: "RootWebArea", name: "oopif", backend: 3, kids: ["2", "3"] },
          // The same backend id as the main frame's: each process numbers its own.
          { id: "2", role: "button", name: "Oopif button", backend: 11 },
          { id: "3", role: "Iframe", backend: 31 },
        );
      default:
        return axTree(
          { id: "1", role: "RootWebArea", name: "nested", backend: 4, kids: ["2"] },
          { id: "2", role: "button", name: "Nested button", backend: 41 },
        );
    }
  });
  b.handlers.set("DOM.getFrameOwner", (p) => {
    const owners: Record<string, number> = { SAME: 12, OOPIF: 13, NESTED: 31 };
    return { backendNodeId: owners[String(p.frameId)] };
  });
  b.handlers.set("DOM.getContentQuads", (p, sid) => {
    const id = Number(p.backendNodeId);
    if (sid === "S-A" && id === 13) return { quads: [quad(100, 200, 400, 300)] }; // OOPIF owner
    if (sid === "S-OOP" && id === 31) return { quads: [quad(10, 20, 200, 100)] }; // nested owner
    if (sid === "S-A" && id === 21) return { quads: [quad(50, 60, 20, 10)] }; // in the same-process frame
    return { quads: [quad(1, 2, 10, 20)] };
  });
  // Box-model quads don't follow scrolling: only their differences may be used.
  b.handlers.set("DOM.getBoxModel", (p, sid) => {
    const inset = sid === "S-A" && Number(p.backendNodeId) === 13 ? 10 : 2;
    return {
      model: {
        border: quad(5000, 7000, 10, 10),
        content: quad(5000 + inset, 7000 + inset, 6, 6),
      },
    };
  });
  const { result } = await s.extract();
  const names = new Map<string, string>();
  for (const name of ["Main button", "Same button", "Oopif button", "Nested button"]) {
    names.set(name, refNamed(result.accessibilityTree, name));
  }
  return { b, s, names };
}

function pressPoint(b: FakeBrowser): { x: unknown; y: unknown; sessionId?: string } {
  const press = b.calls("Input.dispatchMouseEvent").filter((c) => c.params.type === "mousePressed").at(-1);
  assert.ok(press, "no press was dispatched");
  return { x: press.params.x, y: press.params.y, sessionId: press.sessionId };
}

test("extract stitches every frame's tree under its owner element", async () => {
  const { b, s } = await framedPage();
  const { result } = await s.extract();
  const main = result.accessibilityTree[0]!;
  assert.equal(main.name, "main");
  const iframes = main.children!.filter((n) => n.role === "Iframe");
  assert.equal(iframes.length, 2);
  assert.ok(flatten(iframes[0]!.children!).some((n) => n.name === "Same button"));
  const oopif = flatten(iframes[1]!.children!);
  assert.ok(oopif.some((n) => n.name === "Oopif button"));
  assert.ok(oopif.some((n) => n.name === "Nested button"), "a nested OOPIF hangs under its parent");
  assert.equal(result.framesSkipped, undefined);
  assertStealth(b);
});

test("Accessibility.enable goes to the page session only, and is disabled after", async () => {
  const { b, s } = await framedPage();
  await s.extract();
  const enables = b.calls("Accessibility.enable");
  assert.ok(enables.length > 0);
  for (const call of enables) assert.equal(call.sessionId, "S-A");
  assert.equal(b.calls("Accessibility.disable").length, enables.length);
  assert.ok(
    b.calls("Accessibility.getFullAXTree").some((c) => c.sessionId === "S-NEST"),
    "the nested frame's tree came from its own session",
  );
});

test("a ref on the page or a same-process frame has no offset", async () => {
  const { b, s, names } = await framedPage();
  await s.clickRef(names.get("Same button")!);
  assert.deepEqual(pressPoint(b), { x: 60, y: 65, sessionId: "S-A" });
});

test("a ref in an OOPIF sums owner quads and insets, and input stays on the page session", async () => {
  const { b, s, names } = await framedPage();
  await s.clickRef(names.get("Oopif button")!);
  // Owner's border box at (100, 200), its content 10 inside, the button's center at (6, 12).
  assert.deepEqual(pressPoint(b), { x: 116, y: 222, sessionId: "S-A" });

  await s.clickRef(names.get("Nested button")!);
  // That, plus the nested owner at (10, 20), its content 2 inside.
  assert.deepEqual(pressPoint(b), { x: 128, y: 244, sessionId: "S-A" });
});

test("the probe for a ref in a frame is armed in that frame, on that frame's session", async () => {
  const { b, s, names } = await framedPage();
  await s.clickRef(names.get("Same button")!);
  assert.deepEqual(b.calls("Page.createIsolatedWorld").at(-1), {
    method: "Page.createIsolatedWorld",
    params: { frameId: "SAME", worldName: "mz_input_probe" },
    sessionId: "S-A",
  });
  await s.typeRef(names.get("Oopif button")!, "x");
  const worlds = b.calls("Page.createIsolatedWorld").slice(-2);
  for (const world of worlds) {
    assert.deepEqual(world, {
      method: "Page.createIsolatedWorld",
      params: { frameId: "OOPIF", worldName: "mz_input_probe" },
      sessionId: "S-OOP",
    });
  }
  const keys = b.calls("Input.dispatchKeyEvent");
  assert.ok(keys.length > 0 && keys.every((c) => c.sessionId === "S-A"));
  assertStealth(b);
});

test("a dropped click in an OOPIF still throws InputNotDeliveredError", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("Runtime.evaluate", (p) => {
    if (String(p.expression).includes("visibilityState")) {
      return {
        result: {
          value: JSON.stringify({
            pressed: false,
            released: false,
            keys: 0,
            hidden: true,
            painted: false,
          }),
        },
      };
    }
    return { result: {} };
  });
  await assert.rejects(s.clickRef(names.get("Nested button")!), (e: unknown) => {
    assert.ok(e instanceof InputNotDeliveredError);
    assert.match(e.message, /has not painted/);
    return true;
  });
});

test("a ref is stable across snapshots, and two frames' equal backend ids get two refs", async () => {
  const { s, names } = await framedPage();
  const { result } = await s.extract();
  for (const [name, ref] of names) {
    assert.equal(refNamed(result.accessibilityTree, name), ref, name);
  }
  assert.notEqual(names.get("Main button"), names.get("Oopif button"));
  assert.match(names.get("Main button")!, /^e\d+$/);
});

test("a ref on a background tab activates that tab first", async () => {
  const { b, s, names } = await framedPage();
  b.attachPage("B", "S-B");
  await settle();
  await s.activateTab("B");
  await s.clickRef(names.get("Main button")!);
  assert.equal(b.calls("Target.activateTarget").at(-1)?.params.targetId, "A");
  assert.equal(((await s.listTabs()) as { activeTargetId: string }).activeTargetId, "A");
  const activation = b.log.findLastIndex((c) => c.method === "Target.activateTarget");
  const press = b.log.findLastIndex(
    (c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed",
  );
  assert.ok(activation < press);
  assert.equal(pressPoint(b).sessionId, "S-A");
});

test("after a main-frame navigation every ref of that tab is STALE_REF", async () => {
  const { b, s, names } = await framedPage();
  b.event("Page.frameNavigated", { frame: { id: "MAIN" } }, "S-A");
  for (const ref of names.values()) await assertMultizenCode(s.clickRef(ref), "STALE_REF");
  assert.equal(b.calls("Input.dispatchMouseEvent").length, 0, "never a click on something else");
});

test("a frame's navigation stales only that frame's refs", async () => {
  const { b, s, names } = await framedPage();
  b.event("Page.frameNavigated", { frame: { id: "SAME", parentId: "MAIN" } }, "S-A");
  await assertMultizenCode(s.clickRef(names.get("Same button")!), "STALE_REF");
  await s.clickRef(names.get("Main button")!);
});

test("an OOPIF that navigated without any event is caught by its loader id", async () => {
  const { b, s, names } = await framedPage();
  const tree = b.handlers.get("Page.getFrameTree")!;
  b.handlers.set("Page.getFrameTree", (p, sid) =>
    sid === "S-OOP" ? { frameTree: { frame: { id: "OOPIF", loaderId: "NEW" } } } : tree(p, sid),
  );
  await assertMultizenCode(s.clickRef(names.get("Oopif button")!), "STALE_REF");
  assert.equal(b.calls("Input.dispatchMouseEvent").length, 0);
});

test("a new snapshot of a replaced document issues new refs, never the old ones", async () => {
  const { b, s, names } = await framedPage();
  const tree = b.handlers.get("Page.getFrameTree")!;
  b.handlers.set("Page.getFrameTree", (p, sid) =>
    sid === "S-OOP" ? { frameTree: { frame: { id: "OOPIF", loaderId: "NEW" } } } : tree(p, sid),
  );
  const { result } = await s.extract();
  const fresh = refNamed(result.accessibilityTree, "Oopif button");
  assert.notEqual(fresh, names.get("Oopif button"));
  await assertMultizenCode(s.clickRef(names.get("Oopif button")!), "STALE_REF");
});

test("a detached OOPIF's refs are stale", async () => {
  const { b, s, names } = await framedPage();
  b.event("Target.detachedFromTarget", { sessionId: "S-NEST", targetId: "NESTED" }, "S-OOP");
  await assertMultizenCode(s.clickRef(names.get("Nested button")!), "STALE_REF");
});

test("DOM errors map to STALE_REF and ELEMENT_NOT_VISIBLE", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("DOM.scrollIntoViewIfNeeded", () => {
    throw new Error("Node does not have a layout object");
  });
  await assertMultizenCode(s.clickRef(names.get("Main button")!), "ELEMENT_NOT_VISIBLE");

  b.handlers.set("DOM.scrollIntoViewIfNeeded", () => ({}));
  b.handlers.set("DOM.getContentQuads", () => ({ quads: [quad(0, 0, 0, 0)] }));
  await assertMultizenCode(s.clickRef(names.get("Main button")!), "ELEMENT_NOT_VISIBLE");

  b.handlers.set("DOM.scrollIntoViewIfNeeded", () => {
    throw new Error("No node with given id found");
  });
  await assertMultizenCode(s.clickRef(names.get("Main button")!), "STALE_REF");
  await assertMultizenCode(s.clickRef(names.get("Main button")!), "STALE_REF");
});

test("a ref nobody issued is ELEMENT_NOT_FOUND", async () => {
  const { s } = await framedPage();
  await assertMultizenCode(s.clickRef("e999999"), "ELEMENT_NOT_FOUND");
  await assertMultizenCode(s.clickRef("nonsense"), "ELEMENT_NOT_FOUND");
});

test("frames over the limit or failing are counted in framesSkipped", async () => {
  const { b, s } = await connected(["A"]);
  const many = Array.from({ length: 40 }, (_, i) => ({ frame: { id: `C${i}`, loaderId: "L" } }));
  b.handlers.set("Page.getFrameTree", () => ({
    frameTree: { frame: { id: "MAIN", loaderId: "L" }, childFrames: many },
  }));
  b.handlers.set("DOM.getFrameOwner", () => ({ backendNodeId: 999 }));
  b.handlers.set("Accessibility.getFullAXTree", (p) => {
    if (p.frameId === "C3") throw new Error("frame gone");
    return axTree({ id: "1", role: "RootWebArea", name: String(p.frameId), backend: 1 });
  });
  const { result } = await s.extract();
  assert.equal(result.framesSkipped, 11 + 1);
  assert.equal(b.calls("Accessibility.getFullAXTree").length, 30);
});

test("a main frame that won't give its tree fails the snapshot, instead of an empty page", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Accessibility.getFullAXTree", () => {
    throw new Error("renderer gone");
  });
  await assert.rejects(s.extract(), /renderer gone/);
  assert.ok(b.calls("Accessibility.disable").length > 0, "Accessibility is not left enabled");
});

// ── navigation ───────────────────────────────────────────────────────────────

test("navigate throws NAVIGATION_FAILED with the errorText, and stops waiting", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Page.navigate", () => ({ frameId: "F", errorText: "net::ERR_UNSAFE_PORT" }));
  const e = await assertMultizenCode(s.navigate("http://x:1/"), "NAVIGATION_FAILED");
  assert.match(e.message, /ERR_UNSAFE_PORT/);
  assert.equal(b.listenerCount("Page.loadEventFired.S-A"), 0);
});

test("a same-document navigation has no load event to wait for", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Page.navigate", () => ({ frameId: "F" }));
  assert.deepEqual(await s.navigate("http://t/#x"), { url: "http://t/", title: "T" });
});

// ── dialogs ──────────────────────────────────────────────────────────────────

const answers = (b: FakeBrowser): Array<Record<string, unknown>> =>
  b.calls("Page.handleJavaScriptDialog").map((c) => c.params);

test("the default policy is today's: alert and beforeunload accepted, the rest dismissed", async () => {
  const { b, s } = await connected(["A"]);
  for (const type of ["alert", "beforeunload", "confirm", "prompt"]) {
    b.event("Page.javascriptDialogOpening", { type, message: "m" }, "S-A");
  }
  await settle();
  assert.deepEqual(answers(b), [
    { accept: true },
    { accept: true },
    { accept: false },
    { accept: false },
  ]);
  assert.equal(s.hasOpenDialog(), false);
});

test("auto mode takes per-type answers and a prompt's text", async () => {
  const { b, s } = await connected(["A"]);
  await s.setDialogPolicy({ mode: "auto", prompt: "accept", confirm: "accept", promptText: "yes" });
  b.event("Page.javascriptDialogOpening", { type: "prompt", message: "m" }, "S-A");
  b.event("Page.javascriptDialogOpening", { type: "confirm", message: "m" }, "S-A");
  await settle();
  assert.deepEqual(answers(b), [{ accept: true, promptText: "yes" }, { accept: true }]);
});

test("a dialog on another tab, reported by a session nobody here owns, is left alone", async () => {
  const { b } = await connected(["A"]);
  b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-AGENT");
  await settle();
  assert.deepEqual(answers(b), []);
});

test("manual mode keeps the dialog for handle_dialog, and page verbs say DIALOG_OPEN", async () => {
  const { b, s } = await framedPage();
  await s.setDialogPolicy({ mode: "manual" });
  b.event(
    "Page.javascriptDialogOpening",
    { type: "prompt", message: "Name?", defaultPrompt: "x", url: "http://t/" },
    "S-A",
  );
  assert.equal(s.hasOpenDialog(), true);
  const [dialog] = s.listDialogs();
  assert.equal(dialog?.type, "prompt");
  assert.equal(dialog?.defaultPrompt, "x");
  assert.equal("sessionId" in dialog!, false);

  const before = b.log.length;
  await assertMultizenCode(s.screenshot(), "DIALOG_OPEN");
  await assertMultizenCode(s.extract(), "DIALOG_OPEN");
  await assertMultizenCode(s.click("#a"), "DIALOG_OPEN");
  await assertMultizenCode(s.type("#a", "x"), "DIALOG_OPEN");
  await assertMultizenCode(s.clickRef("e1"), "DIALOG_OPEN");
  await assertMultizenCode(s.navigate("http://t/"), "DIALOG_OPEN");
  await assertMultizenCode(s.pressKey("Enter"), "DIALOG_OPEN");
  await assertMultizenCode(s.hover({ selector: "#a" }), "DIALOG_OPEN");
  await assertMultizenCode(s.scroll({ deltaY: 1 }), "DIALOG_OPEN");
  await assertMultizenCode(s.selectOption({ selector: "#a" }, { index: 0 }), "DIALOG_OPEN");
  await assertMultizenCode(s.uploadFile({ selector: "#a" }, ["x"]), "DIALOG_OPEN");
  await assertMultizenCode(s.evaluateJs("1") as Promise<unknown>, "DIALOG_OPEN");
  assert.equal(b.log.length, before, "nothing reached a renderer that would not answer");

  await s.handleDialog({ action: "accept", promptText: "Ann" });
  assert.deepEqual(answers(b), [{ accept: true, promptText: "Ann" }]);
  assert.equal(s.hasOpenDialog(), false);
  await assert.doesNotReject(s.extract());
});

test("the dialog goes when the browser closes it, and when its tab does", async () => {
  const { b, s } = await connected(["A", "B"]);
  await s.setDialogPolicy({ mode: "manual" });
  b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-A");
  b.event("Page.javascriptDialogClosed", { result: true, userInput: "" }, "S-A");
  assert.equal(s.hasOpenDialog(), false);
  b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-B");
  b.event("Target.targetDestroyed", { targetId: "B" });
  assert.equal(s.hasOpenDialog(), false);
});

test("handle_dialog with nothing open is INVALID_INPUT", async () => {
  const { s } = await connected(["A"]);
  await assertMultizenCode(s.handleDialog({ action: "accept" }), "INVALID_INPUT");
  await assertMultizenCode(s.handleDialog({ action: "accept", dialogId: "d9" }), "INVALID_INPUT");
});

test("back to auto answers what manual left open", async () => {
  const { b, s } = await connected(["A"]);
  await s.setDialogPolicy({ mode: "manual" });
  b.event("Page.javascriptDialogOpening", { type: "confirm", message: "m" }, "S-A");
  await s.setDialogPolicy({ mode: "auto", confirm: "accept" });
  assert.deepEqual(answers(b), [{ accept: true }]);
  assert.equal(s.hasOpenDialog(), false);
});

test("a dialog on another tab doesn't stop this one", async () => {
  const { b, s } = await connected(["A", "B"]);
  b.handlers.set("Page.captureScreenshot", () => ({ data: "PNG" }));
  await s.setDialogPolicy({ mode: "manual" });
  b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-B");
  await assert.doesNotReject(s.screenshot());
  assert.equal(s.hasOpenDialog(), true);
});

test("a screenshot in flight when a dialog opens returns DIALOG_OPEN instead of hanging", async () => {
  const { b, s } = await connected(["A"]);
  await s.setDialogPolicy({ mode: "manual" });
  b.hang.add("Page.captureScreenshot");
  const shot = s.screenshot();
  await settle();
  b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-A");
  await assertMultizenCode(shot, "DIALOG_OPEN");
});

test("a click that opens a manual dialog returns ok: the renderer can't confirm it", async () => {
  const { b, s, names } = await framedPage();
  await s.setDialogPolicy({ mode: "manual" });
  b.hang.add("Input.dispatchMouseEvent");
  const click = s.clickRef(names.get("Main button")!);
  while (b.calls("Input.dispatchMouseEvent").length === 0) await settle();
  b.event("Page.javascriptDialogOpening", { type: "confirm", message: "Sure?" }, "S-A");
  assert.deepEqual(await click, { ok: true });
  assert.equal(s.listDialogs()[0]?.message, "Sure?");
});

test("a dialog opened mid-typing stops the typing and says DIALOG_OPEN", async () => {
  const { b, s, names } = await framedPage();
  await s.setDialogPolicy({ mode: "manual" });
  let keys = 0;
  b.handlers.set("Input.dispatchKeyEvent", (p) => {
    if (p.type === "keyDown" && ++keys === 1) {
      b.event("Page.javascriptDialogOpening", { type: "alert", message: "m" }, "S-A");
      return new Promise(() => {});
    }
    return {};
  });
  await assertMultizenCode(s.typeRef(names.get("Main button")!, "abc"), "DIALOG_OPEN");
  assert.equal(keys, 1);
});

// ── new verbs ────────────────────────────────────────────────────────────────

test("press_key sends the chord with modifiers around it, on the page session", async () => {
  const { b, s } = await connected(["A"]);
  await s.pressKey("Control+Shift+A");
  const keys = b.calls("Input.dispatchKeyEvent").map((c) => [c.params.type, c.params.key, c.params.modifiers]);
  assert.deepEqual(keys, [
    ["rawKeyDown", "Control", 2],
    ["rawKeyDown", "Shift", 10],
    ["rawKeyDown", "A", 10],
    ["keyUp", "A", 10],
    ["keyUp", "Shift", 2],
    ["keyUp", "Control", 0],
  ]);
  assert.ok(b.calls("Input.dispatchKeyEvent").every((c) => c.sessionId === "S-A"));
});

test("press_key without a target arms the probe in every frame, so a key in a frame counts", async () => {
  const { b, s } = await framedPage();
  await s.pressKey("Enter");
  const armed = b.calls("Page.createIsolatedWorld").map((c) => [c.sessionId, c.params.frameId]);
  assert.deepEqual(armed, [
    ["S-A", "MAIN"],
    ["S-A", "SAME"],
    ["S-OOP", "OOPIF"],
    ["S-NEST", "NESTED"],
  ]);
  const enter = b.calls("Input.dispatchKeyEvent")[0];
  assert.equal(enter?.params.type, "keyDown");
  assert.equal(enter?.params.text, "\r");
  assert.equal(enter?.sessionId, "S-A");
});

test("press_key throws when no frame saw the key", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Runtime.evaluate", (p) =>
    String(p.expression).includes("visibilityState")
      ? {
          result: {
            value: JSON.stringify({
              pressed: false,
              released: false,
              keys: 0,
              hidden: false,
              painted: true,
            }),
          },
        }
      : { result: {} },
  );
  await assert.rejects(s.pressKey("Enter"), InputNotDeliveredError);
  await assert.doesNotReject(s.pressKey("Shift"), "nothing for the probe to count");
});

test("press_key with a target clicks it first, and the key lands in its frame's probe", async () => {
  const { b, s, names } = await framedPage();
  await s.pressKey("Enter", { ref: names.get("Oopif button")! });
  assert.ok(pressPoint(b));
  const worlds = b.calls("Page.createIsolatedWorld");
  assert.ok(worlds.every((c) => c.sessionId === "S-OOP" && c.params.frameId === "OOPIF"));
});

test("hover only moves the mouse: nothing to verify, and no probe", async () => {
  const { b, s, names } = await framedPage();
  await s.hover({ ref: names.get("Oopif button")! });
  const events = b.calls("Input.dispatchMouseEvent");
  assert.deepEqual(events.map((c) => c.params.type), ["mouseMoved"]);
  assert.equal(events[0]?.sessionId, "S-A");
  assert.equal(events[0]?.params.x, 116);
  assert.equal(b.calls("Page.createIsolatedWorld").length, 0);
});

test("scroll wheels over the element, or the viewport's middle, unverified", async () => {
  const { b, s, names } = await framedPage();
  await s.scroll({ target: { ref: names.get("Oopif button")! }, deltaY: 300 });
  const wheel = b.calls("Input.dispatchMouseEvent").at(-1);
  assert.equal(wheel?.params.type, "mouseWheel");
  assert.deepEqual([wheel?.params.x, wheel?.params.y, wheel?.params.deltaY], [116, 222, 300]);
  assert.equal(wheel?.sessionId, "S-A");

  b.handlers.set("Page.getLayoutMetrics", () => ({
    cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
  }));
  await s.scroll({ deltaX: 5 });
  const middle = b.calls("Input.dispatchMouseEvent").at(-1);
  assert.deepEqual([middle?.params.x, middle?.params.y, middle?.params.deltaX], [400, 300, 5]);
  assert.equal(b.calls("Page.createIsolatedWorld").length, 0);
});

test("scroll to an element with no deltas scrolls it into view and dispatches nothing", async () => {
  const { b, s, names } = await framedPage();
  await s.scroll({ target: { ref: names.get("Nested button")! } });
  assert.equal(b.calls("Input.dispatchMouseEvent").length, 0);
  assert.equal(b.calls("DOM.scrollIntoViewIfNeeded").at(-1)?.sessionId, "S-NEST");
});

test("select_option runs in an isolated world, on the frame's session", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("DOM.resolveNode", () => ({ object: { objectId: "O" } }));
  b.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "ok" } }));
  await s.selectOption({ ref: names.get("Oopif button")! }, { label: "Two" });
  assert.deepEqual(b.calls("DOM.resolveNode")[0], {
    method: "DOM.resolveNode",
    params: { backendNodeId: 11, executionContextId: 77 },
    sessionId: "S-OOP",
  });
  const call = b.calls("Runtime.callFunctionOn")[0];
  assert.deepEqual(call?.params.arguments, [{ value: { label: "Two" } }]);
  assert.equal(call?.sessionId, "S-OOP");
  assert.deepEqual(b.calls("Runtime.releaseObject")[0]?.params, { objectId: "O" });

  b.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "no-option" } }));
  await assertMultizenCode(
    s.selectOption({ ref: names.get("Oopif button")! }, { value: "x" }),
    "ELEMENT_NOT_FOUND",
  );
  b.handlers.set("Runtime.callFunctionOn", () => ({ result: { value: "not-select" } }));
  await assertMultizenCode(
    s.selectOption({ ref: names.get("Oopif button")! }, { index: 0 }),
    "INVALID_INPUT",
  );
  assertStealth(b);
});

test("upload_file sets a file input's files directly", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("DOM.describeNode", () => ({
    node: { nodeName: "INPUT", attributes: ["id", "f", "type", "file"] },
  }));
  await s.uploadFile({ ref: names.get("Main button")! }, ["C:\\u\\a.txt"]);
  assert.deepEqual(b.calls("DOM.setFileInputFiles")[0], {
    method: "DOM.setFileInputFiles",
    params: { files: ["C:\\u\\a.txt"], backendNodeId: 11 },
    sessionId: "S-A",
  });
  assert.equal(b.calls("Input.dispatchMouseEvent").length, 0);
  assertStealth(b);
});

test("upload_file on another element catches the chooser its click opens", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("DOM.describeNode", () => ({ node: { nodeName: "BUTTON" } }));
  b.handlers.set("Input.dispatchMouseEvent", (p) => {
    if (p.type === "mouseReleased") {
      setTimeout(() => b.event("Page.fileChooserOpened", { backendNodeId: 555 }, "S-A"), 1);
    }
    return {};
  });
  await s.uploadFile({ ref: names.get("Main button")! }, ["C:\\u\\a.txt"]);
  assert.deepEqual(
    b.calls("Page.setInterceptFileChooserDialog").map((c) => c.params.enabled),
    [true, false],
  );
  assert.deepEqual(b.calls("DOM.setFileInputFiles")[0]?.params, {
    files: ["C:\\u\\a.txt"],
    backendNodeId: 555,
  });
});

test("upload_file refuses a chooser in an OOPIF before clicking anything", async () => {
  const { b, s, names } = await framedPage();
  b.handlers.set("DOM.describeNode", () => ({ node: { nodeName: "BUTTON" } }));
  await assertMultizenCode(
    s.uploadFile({ ref: names.get("Oopif button")! }, ["C:\\u\\a.txt"]),
    "INVALID_INPUT",
  );
  assert.equal(b.calls("Input.dispatchMouseEvent").length, 0);
  assert.equal(b.calls("Page.setInterceptFileChooserDialog").length, 0);
  assert.ok(!b.calls("Page.enable").some((c) => c.sessionId === "S-OOP"));
});

test("a selector target resolves in an isolated world and reports what it can't find", async () => {
  const { b, s } = await connected(["A"]);
  b.handlers.set("Runtime.evaluate", (p) => {
    if (String(p.expression).includes("querySelector")) {
      assert.equal(p.contextId, 77);
      return { result: {} };
    }
    return { result: {} };
  });
  await assertMultizenCode(s.hover({ selector: "#missing" }), "ELEMENT_NOT_FOUND");

  b.handlers.set("Runtime.evaluate", () => ({ result: {}, exceptionDetails: { text: "bad" } }));
  await assertMultizenCode(s.hover({ selector: "###" }), "INVALID_INPUT");

  b.handlers.set("Runtime.evaluate", () => ({ result: { objectId: "O" } }));
  b.handlers.set("DOM.describeNode", () => ({ node: { backendNodeId: 9 } }));
  await s.hover({ selector: "#ok" });
  assert.equal(b.calls("DOM.getContentQuads").at(-1)?.params.backendNodeId, 9);
  assert.deepEqual(b.calls("Runtime.releaseObject").at(-1)?.params, { objectId: "O" });
});

// ── downloads ────────────────────────────────────────────────────────────────

test("enableDownloads asks for allowAndName on the browser and passes events on", async () => {
  const { b, s } = await connected(["A"]);
  const began: unknown[] = [];
  const progress: unknown[] = [];
  await s.enableDownloads("C:\\dl", {
    began: (e) => began.push(e),
    progress: (e) => progress.push(e),
  });
  const call = b.calls("Browser.setDownloadBehavior")[0];
  assert.deepEqual(call?.params, {
    behavior: "allowAndName",
    downloadPath: "C:\\dl",
    eventsEnabled: true,
  });
  assert.equal(call?.sessionId, undefined);
  b.event("Browser.downloadWillBegin", { guid: "g", url: "u", suggestedFilename: "a.txt" });
  b.event("Browser.downloadProgress", {
    guid: "g",
    totalBytes: 1,
    receivedBytes: 1,
    state: "completed",
  });
  assert.equal(began.length, 1);
  assert.equal(progress.length, 1);
});

// ── keyboard ─────────────────────────────────────────────────────────────────

test("parseChord: named keys, single characters and chords", () => {
  const enter = parseChord("Enter");
  assert.equal(enter.key.key, "Enter");
  assert.equal(enter.key.text, "\r");
  assert.deepEqual(enter.modifiers, []);
  assert.equal(enter.countedKeydowns, 1);

  const ctrlA = parseChord("Control+A");
  assert.equal(ctrlA.key.key, "a");
  assert.equal(ctrlA.key.code, "KeyA");
  assert.equal(ctrlA.key.text, undefined, "a command chord inserts nothing");
  assert.equal(ctrlA.mask, 2);
  assert.equal(ctrlA.countedKeydowns, 2);

  const shiftA = parseChord("Shift+a");
  assert.equal(shiftA.key.key, "A");
  assert.equal(shiftA.key.text, "A");
  assert.equal(shiftA.mask, 8);
  assert.equal(shiftA.countedKeydowns, 1, "Shift itself is not counted");

  const bare = parseChord("A");
  assert.deepEqual(bare.modifiers.map((m) => m.key), ["Shift"], "an uppercase glyph holds Shift");

  const bang = parseChord("Control+!");
  assert.deepEqual(bang.modifiers.map((m) => m.key), ["Control", "Shift"]);

  assert.equal(parseChord("Shift+1").key.key, "!");
  assert.equal(parseChord("Control++").key.key, "+");
  assert.equal(parseChord("+").key.key, "+");
  assert.equal(parseChord("space").key.key, " ");
  assert.equal(parseChord("F5").key.keyCode, 116);
  assert.equal(parseChord("Shift").countedKeydowns, 0);
});

test("parseChord: ControlOrMeta follows the persona's platform", () => {
  assert.equal(parseChord("ControlOrMeta+a", "macos").modifiers[0]?.key, "Meta");
  assert.equal(parseChord("ControlOrMeta+a", "macos").mask, 4);
  assert.equal(parseChord("ControlOrMeta+a", "windows").modifiers[0]?.key, "Control");
  assert.equal(parseChord("ControlOrMeta+a", "linux").mask, 2);
});

test("parseChord refuses what it doesn't know", () => {
  assert.throws(() => parseChord("Foo"), /Unknown key "Foo"/);
  assert.throws(() => parseChord("Hyper+a"), /Unknown key "Hyper"/);
  assert.throws(() => parseChord("Enter+"), MultizenError);
});

test("describeNamedKey covers the common names and nothing else", () => {
  assert.equal(describeNamedKey("Escape")?.keyCode, 27);
  assert.equal(describeNamedKey("ArrowDown")?.code, "ArrowDown");
  assert.equal(describeNamedKey("PAGEUP")?.key, "PageUp");
  assert.equal(describeNamedKey("Shift")?.code, "ShiftLeft");
  assert.equal(describeNamedKey("nope"), null);
});

// ── registry ─────────────────────────────────────────────────────────────────

test("an idle page never outranks one in use, and takes the active slot only when empty", () => {
  const r = new TargetRegistry();
  assert.equal(r.addIdle({ targetId: "first", type: "page" }), true);
  assert.equal(r.active(), "first");
  r.upsert({ targetId: "used", type: "page" });
  r.addIdle({ targetId: "popup", type: "page" });
  assert.equal(r.addIdle({ targetId: "worker", type: "worker" }), false);
  r.setActive("first");
  r.remove("first");
  assert.equal(r.active(), "used");
  r.remove("used");
  assert.equal(r.active(), "popup");
});
