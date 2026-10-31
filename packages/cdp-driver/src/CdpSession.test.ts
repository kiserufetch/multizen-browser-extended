import { test } from "node:test";
import assert from "node:assert/strict";

import { CdpSession, InputNotDeliveredError } from "./CdpSession.js";

/**
 * Unit/integration coverage for the stealth-preserving `cdpSend` primitive.
 *
 * We bypass the real chrome-remote-interface transport by injecting a fake
 * client straight onto the session (the only thing `connect()` would set), then
 * record the exact sequence of CDP commands the safe layer emits. This lets us
 * assert the stealth invariants precisely without a browser.
 */

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FakeClient {
  client: { send: (m: string, p?: Record<string, unknown>, s?: string) => Promise<unknown> };
  calls: SendCall[];
  methods: () => string[];
}

function makeFakeClient(opts: { throwOn?: (method: string, callIndex: number) => boolean } = {}): FakeClient {
  const calls: SendCall[] = [];
  let i = 0;
  const client = {
    send: async (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
      const idx = i++;
      calls.push({ method, params, sessionId });
      if (opts.throwOn?.(method, idx)) throw new Error(`fake CDP failure: ${method}`);
      return { ok: true, method };
    },
  };
  return { client, calls, methods: () => calls.map((c) => c.method) };
}

/** Build a session and graft the fake client on, skipping the real connect(). */
function sessionWith(fake: FakeClient, engine?: string): CdpSession {
  const s = new CdpSession({ port: 0, engine });
  (s as unknown as { client: unknown }).client = fake.client;
  return s;
}

function refcount(s: CdpSession): Map<string, number> {
  return (s as unknown as { safeEnableRefcount: Map<string, number> }).safeEnableRefcount;
}

// ── connect-domain protection (Page is sacred) ───────────────────────────────

test("safe cdp_send never disables a connect-enabled domain (Page.enable is a no-op for disable)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
  assert.ok(!fake.methods().includes("Page.disable"), "Page must never be disabled");
  assert.equal(refcount(s).size, 0);
});

// ── allowlisted domain: enable is paired with a disable ──────────────────────

test("safe cdp_send pairs an allowlisted *.enable with a *.disable (Accessibility)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Accessibility.enable");
  assert.deepEqual(fake.methods(), ["Accessibility.enable", "Accessibility.disable"]);
  assert.equal(refcount(s).size, 0, "refcount must return to empty after the paired disable");
});

test("safe cdp_send pairs Runtime.enable with Runtime.disable on a non-anti-detect engine", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cft");
  await s.cdpSend("Runtime.enable");
  assert.deepEqual(fake.methods(), ["Runtime.enable", "Runtime.disable"]);
});

test("the paired disable is threaded through the same sessionId as the enable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Accessibility.enable", undefined, "SESS-1");
  assert.deepEqual(
    fake.calls.map((c) => [c.method, c.sessionId]),
    [
      ["Accessibility.enable", "SESS-1"],
      ["Accessibility.disable", "SESS-1"],
    ],
  );
});

// ── unknown domains are left strictly alone (allowlist, not a heuristic) ──────

test("safe cdp_send does NOT pair a disable for a domain outside the allowlist", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Foo.enable");
  assert.deepEqual(fake.methods(), ["Foo.enable"], "unknown domains must not be auto-disabled");
  assert.equal(refcount(s).size, 0);
});

// ── CloakBrowser: refuse risky enables at enable time ────────────────────────

for (const method of ["Runtime.enable", "Network.enable"]) {
  test(`safe cdp_send on cloakbrowser refuses ${method} with a clear error and never sends it`, async () => {
    const fake = makeFakeClient();
    const s = sessionWith(fake, "cloakbrowser");
    await assert.rejects(s.cdpSend(method), (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /refus/i);
      assert.match(msg, /cdp_send_no_safety/);
      return true;
    });
    assert.deepEqual(fake.methods(), [], "the risky enable must not reach the transport");
    assert.equal(refcount(s).size, 0);
  });
}

test("safe cdp_send on cloakbrowser STILL pairs a non-risky enable (DOM) normally", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("DOM.enable");
  assert.deepEqual(fake.methods(), ["DOM.enable", "DOM.disable"]);
});

test("safe cdp_send on cloakbrowser does not touch Page (connect domain) at all", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Page.enable");
  assert.deepEqual(fake.methods(), ["Page.enable"]);
});

// ── no-safety passthrough ────────────────────────────────────────────────────

test("cdp_send_no_safety is a pure passthrough: no disable, even for risky enables", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Network.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Network.enable"], "no auto-disable in unsafe mode");
  assert.equal(refcount(s).size, 0);
});

test("cdp_send_no_safety on cloakbrowser does not apply the risky-enable refusal", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  // Must resolve (not throw) — the caller owns the consequences.
  await s.cdpSend("Runtime.enable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Runtime.enable"]);
});

// ── wrappers' underlying calls never enable a domain ─────────────────────────

test("typical wrapper calls (Runtime.evaluate, Network.getCookies, Target.*) never enable/disable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await s.cdpSend("Runtime.evaluate", { expression: "1", returnByValue: true });
  await s.cdpSend("Network.getCookies", {});
  await s.cdpSend("Network.setCookies", { cookies: [] });
  await s.cdpSend("Target.getTargets", {});
  await s.cdpSend("Target.createTarget", { url: "about:blank" });
  assert.deepEqual(fake.methods(), [
    "Runtime.evaluate",
    "Network.getCookies",
    "Network.setCookies",
    "Target.getTargets",
    "Target.createTarget",
  ]);
  assert.ok(!fake.methods().some((m) => /\.(enable|disable)$/.test(m)));
});

// ── concurrency: refcount keeps the disable until the last enable finishes ────

test("parallel safe enables of one domain refcount to a single trailing disable", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  await Promise.all([s.cdpSend("Runtime.enable"), s.cdpSend("Runtime.enable")]);

  const enables = fake.methods().filter((m) => m === "Runtime.enable").length;
  const disables = fake.methods().filter((m) => m === "Runtime.disable").length;
  assert.equal(enables, 2, "both enables must reach the transport");
  assert.equal(disables, 1, "only one disable once the refcount hits zero");
  assert.equal(fake.methods().at(-1), "Runtime.disable", "disable must come after both enables");
  assert.equal(refcount(s).size, 0);
});

// ── exception safety: a throwing enable must not pin the domain ───────────────

test("an exception after increment still decrements the refcount (domain not pinned)", async () => {
  // Throw only on the FIRST Runtime.enable so we can prove the domain is not
  // left pinned: a later enable must behave normally.
  const fake = makeFakeClient({ throwOn: (method, idx) => method === "Runtime.enable" && idx === 0 });
  const s = sessionWith(fake, "cft");

  await assert.rejects(s.cdpSend("Runtime.enable"), /fake CDP failure/);
  assert.equal(refcount(s).size, 0, "refcount must be cleared even when the enable throws");

  // A subsequent enable enables + pairs a disable as usual — proof the domain
  // was never stuck in the 'enabled' accounting state.
  await s.cdpSend("Runtime.enable");
  assert.equal(refcount(s).size, 0);
  const tail = fake.methods().slice(-2);
  assert.deepEqual(tail, ["Runtime.enable", "Runtime.disable"]);
});

// ── require(): cdpSend before connect throws a clear error ────────────────────

test("cdp_send before connect() throws a clear 'not connected' error", async () => {
  const s = new CdpSession({ port: 0 });
  await assert.rejects(s.cdpSend("Runtime.evaluate"), /not connected/i);
});

// ── keyboard descriptor (BEH-1 input correctness) ────────────────────────────
import { describeKey, CDP_MOD_SHIFT } from "./keyboard.js";

test("describeKey maps lowercase letters to code/keyCode/text without Shift", () => {
  const a = describeKey("a");
  assert.equal(a.key, "a");
  assert.equal(a.code, "KeyA");
  assert.equal(a.keyCode, 65);
  assert.equal(a.text, "a");
  assert.equal(a.shift, false);
});

test("describeKey marks uppercase letters as Shift with the uppercase glyph", () => {
  const A = describeKey("A");
  assert.equal(A.key, "A");
  assert.equal(A.code, "KeyA");
  assert.equal(A.keyCode, 65);
  assert.equal(A.text, "A");
  assert.equal(A.shift, true);
});

test("describeKey handles digits, shifted symbols, Enter, Tab and space", () => {
  assert.deepEqual(describeKey("1"), { key: "1", code: "Digit1", keyCode: 49, text: "1", shift: false });
  // '!' is Shift+1 on US layout → same physical key as '1'.
  const bang = describeKey("!");
  assert.equal(bang.code, "Digit1");
  assert.equal(bang.keyCode, 49);
  assert.equal(bang.shift, true);
  assert.equal(bang.text, "!");
  const enter = describeKey("\n");
  assert.equal(enter.key, "Enter");
  assert.equal(enter.code, "Enter");
  assert.equal(enter.keyCode, 13);
  const tab = describeKey("\t");
  assert.equal(tab.key, "Tab");
  assert.equal(tab.text, undefined); // control key, no inserted text
  assert.equal(describeKey(" ").code, "Space");
  assert.equal(CDP_MOD_SHIFT, 8);
});

test("describeKey still types unknown characters (emoji) with key+text, blank code", () => {
  const e = describeKey("😀");
  assert.equal(e.key, "😀");
  assert.equal(e.text, "😀");
  assert.equal(e.code, "");
  assert.equal(e.keyCode, 0);
});

// ── STE-4: safe-mode method denylist ─────────────────────────────────────────
test("safe cdp_send refuses Page.disable, addBinding and exposeDevToolsProtocol", async () => {
  for (const method of [
    "Page.disable",
    "Runtime.addBinding",
    "Target.exposeDevToolsProtocol",
    "Page.exposeDevToolsProtocol",
  ]) {
    const fake = makeFakeClient();
    const s = sessionWith(fake, "cloakbrowser");
    await assert.rejects(() => s.cdpSend(method), /safe mode/i, `${method} must be refused`);
    assert.deepEqual(fake.methods(), [], `${method} must not reach the transport`);
  }
});

test("cdp_send_no_safety still allows the denied methods (caller owns the risk)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake, "cloakbrowser");
  await s.cdpSend("Page.disable", undefined, undefined, { safe: false });
  assert.deepEqual(fake.methods(), ["Page.disable"]);
});

// ── AGT-5: per-command timeout ───────────────────────────────────────────────
test("cdpSend rejects when a command exceeds its timeout", async () => {
  // A client whose send never resolves — simulates a wedged renderer.
  const hung = {
    client: { send: () => new Promise<unknown>(() => {}) },
  };
  const s = new CdpSession({ port: 0 });
  (s as unknown as { client: unknown }).client = hung.client;
  await assert.rejects(
    () => s.cdpSend("Runtime.evaluate", { expression: "1" }, undefined, { safe: false, timeoutMs: 25 }),
    /timed out/i,
  );
});

test("cdpSend with timeoutMs=0 does not impose a timeout (resolves normally)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  const r = (await s.cdpSend("Runtime.evaluate", { expression: "1" }, undefined, {
    safe: false,
    timeoutMs: 0,
  })) as { ok?: boolean };
  assert.equal(r.ok, true);
});

// ── STE-8: target registry (active tab + re-selection) ───────────────────────
import { TargetRegistry } from "./targetRegistry.js";

test("registry tracks pages only and makes the first one active", () => {
  const r = new TargetRegistry();
  assert.equal(r.upsert({ targetId: "t1", type: "page", url: "a" }), true);
  assert.equal(r.upsert({ targetId: "i1", type: "iframe" }), false, "iframes are not tabs");
  assert.equal(r.upsert({ targetId: "t2", type: "page", url: "b" }), true);
  assert.equal(r.active(), "t1");
  assert.equal(r.size, 2);
  assert.deepEqual(r.list().map((t) => t.targetId), ["t1", "t2"]);
});

test("removing the active page re-selects the most recent remaining page", () => {
  const r = new TargetRegistry();
  r.upsert({ targetId: "t1", type: "page" });
  r.upsert({ targetId: "t2", type: "page" });
  r.upsert({ targetId: "t3", type: "page" });
  assert.equal(r.active(), "t1");
  r.remove("t1");
  assert.equal(r.active(), "t3", "falls back to the most recently seen page");
  r.remove("t3");
  assert.equal(r.active(), "t2");
  r.remove("t2");
  assert.equal(r.active(), null, "no page left → no active target");
});

test("removing a non-active page leaves the active one untouched", () => {
  const r = new TargetRegistry();
  r.upsert({ targetId: "t1", type: "page" });
  r.upsert({ targetId: "t2", type: "page" });
  r.setActive("t2");
  r.remove("t1");
  assert.equal(r.active(), "t2");
});

test("setActive validates the target and upsert refreshes recency", () => {
  const r = new TargetRegistry();
  r.upsert({ targetId: "t1", type: "page" });
  r.upsert({ targetId: "t2", type: "page" });
  assert.equal(r.setActive("nope"), false);
  assert.equal(r.setActive("t2"), true);
  // Touching t1 moves it to most-recent, so after removing active t2 it wins.
  r.upsert({ targetId: "t1", type: "page", url: "updated" });
  r.remove("t2");
  assert.equal(r.active(), "t1");
  assert.equal(r.activeRecord()?.url, "updated");
});

test("after disconnect, actions fail loud with a clear message (not a hang)", async () => {
  const fake = makeFakeClient();
  const s = sessionWith(fake);
  (s as unknown as { disconnected: boolean }).disconnected = true;
  await assert.rejects(() => s.click("#x"), /connection lost/i);
  await assert.rejects(() => s.cdpSend("Runtime.evaluate", { expression: "1" }), /connection lost/i);
});

// ── input delivery check ─────────────────────────────────────────────────────

/**
 * A fake page for the input methods, which call `client.Domain.method()` rather
 * than `send`. Chromium acks Input.dispatch* whether or not the page receives
 * the event, so `delivers` decides what the isolated-world probe gets to see.
 */
interface FakePage {
  delivers: (kind: "press" | "release" | "key", nth: number) => boolean;
  hidden?: boolean;
  painted?: boolean;
  /** Replace the document on mouse release, as a link click would. */
  navigatesOnClick?: boolean;
}

function makeInputClient(page: FakePage): FakeClient & { client: unknown } {
  const calls: SendCall[] = [];
  let probe: { pressed: boolean; released: boolean; keys: number } | null = null;
  let navigated = false;
  let keySeq = 0;
  const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "F1" } } }),
    "Page.createIsolatedWorld": () => ({ executionContextId: 77 }),
    "DOM.resolveNode": () => ({ object: { objectId: "O1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: JSON.stringify({ x: 5, y: 6 }) } }),
    "Runtime.evaluate": (p) => {
      const expr = String(p.expression);
      if (p.contextId === undefined) {
        // Main world: the selector lookup (click) or focus (type).
        return {
          result: {
            value: expr.includes("getBoundingClientRect") ? { ok: true, x: 10, y: 20 } : true,
          },
        };
      }
      if (navigated) throw new Error("Cannot find context with specified id");
      if (expr.includes("delete globalThis.__mzInputProbe")) probe = null;
      else if (expr.includes("visibilityState")) {
        return {
          result: {
            value: JSON.stringify({
              pressed: probe?.pressed ?? false,
              released: probe?.released ?? false,
              keys: probe?.keys ?? 0,
              hidden: page.hidden ?? false,
              painted: page.painted ?? true,
            }),
          },
        };
      } else probe = { pressed: false, released: false, keys: 0 };
      return { result: {} };
    },
    "Input.dispatchMouseEvent": (p) => {
      if (p.type === "mousePressed" && probe && page.delivers("press", 1)) probe.pressed = true;
      if (p.type === "mouseReleased") {
        if (probe && page.delivers("release", 1)) probe.released = true;
        if (page.navigatesOnClick) navigated = true;
      }
      return {};
    },
    "Input.dispatchKeyEvent": (p) => {
      if ((p.type === "keyDown" || p.type === "rawKeyDown") && p.key !== "Shift") {
        keySeq++;
        if (probe && page.delivers("key", keySeq)) probe.keys++;
      }
      return {};
    },
  };
  const send = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params });
    return handlers[method]?.(params ?? {}) ?? {};
  };
  const client = new Proxy(
    { send },
    {
      get(target, domain) {
        if (domain === "send") return target.send;
        return new Proxy(
          {},
          {
            get: (_, m) => (params?: Record<string, unknown>) =>
              send(`${String(domain)}.${String(m)}`, params),
          },
        );
      },
    },
  );
  return {
    client: client as FakeClient["client"],
    calls,
    methods: () => calls.map((c) => c.method),
  };
}

function inputSession(page: FakePage): { s: CdpSession; fake: FakeClient } {
  const fake = makeInputClient(page);
  const s = sessionWith(fake);
  (s as unknown as { snapshotRefs: Map<string, number> }).snapshotRefs = new Map([["e1", 42]]);
  return { s, fake };
}

const deliversAll = () => true;
const dropsAll = () => false;

test("click / clickRef / type / typeRef return ok when the page received the input", async () => {
  const { s } = inputSession({ delivers: deliversAll });
  assert.deepEqual(await s.click("#b"), { ok: true });
  assert.deepEqual(await s.clickRef("e1"), { ok: true });
  assert.deepEqual(await s.type("#i", "Hi!"), { ok: true });
  assert.deepEqual(await s.typeRef("e1", "abc"), { ok: true });
});

for (const [name, run] of [
  ["click", (s: CdpSession) => s.click("#b")],
  ["clickRef", (s: CdpSession) => s.clickRef("e1")],
  ["type", (s: CdpSession) => s.type("#i", "abc")],
  ["typeRef", (s: CdpSession) => s.typeRef("e1", "abc")],
] as const) {
  test(`${name} throws InputNotDeliveredError when Chromium drops the input on a hidden, unpainted page`, async () => {
    const { s } = inputSession({ delivers: dropsAll, hidden: true, painted: false });
    await assert.rejects(run(s), (e: unknown) => {
      assert.ok(e instanceof InputNotDeliveredError);
      assert.match(e.message, /not delivered/);
      assert.match(e.message, /visibilityState is "hidden"/);
      assert.match(e.message, /has not painted/);
      assert.match(e.message, /Page\.bringToFront/);
      return true;
    });
  });
}

test("typeRef sends no keys when its focusing click was lost", async () => {
  const { s, fake } = inputSession({ delivers: dropsAll, hidden: true, painted: false });
  await assert.rejects(s.typeRef("e1", "secret"), /Focusing click on ref "e1" was not delivered/);
  assert.ok(
    !fake.methods().includes("Input.dispatchKeyEvent"),
    "no key may reach whatever has focus",
  );
});

test("a partly delivered type reports how many keys arrived", async () => {
  const { s } = inputSession({ delivers: (kind, nth) => kind !== "key" || nth <= 2 });
  await assert.rejects(s.type("#i", "hello"), (e: unknown) => {
    assert.ok(e instanceof InputNotDeliveredError);
    assert.match(e.message, /received 2 of 5 keys/);
    return true;
  });
});

test("a press without a release is not a delivered click", async () => {
  const { s } = inputSession({ delivers: (kind) => kind === "press" });
  await assert.rejects(s.click("#b"), /received the press and no release/);
});

test("a lost click on a visible page does not blame visibility", async () => {
  const { s } = inputSession({ delivers: dropsAll, hidden: false });
  await assert.rejects(s.click("#b"), (e: unknown) => {
    assert.match((e as Error).message, /page is visible/);
    assert.doesNotMatch((e as Error).message, /bringToFront/);
    return true;
  });
});

test("a click that replaces the document (link navigation) counts as delivered", async () => {
  const { s } = inputSession({ delivers: dropsAll, navigatesOnClick: true });
  assert.deepEqual(await s.clickRef("e1"), { ok: true });
});

test("the probe runs only in its isolated world and is removed afterwards", async () => {
  const { s, fake } = inputSession({ delivers: deliversAll });
  await s.typeRef("e1", "ab");
  const worlds = fake.calls.filter((c) => c.method === "Page.createIsolatedWorld");
  assert.ok(worlds.length > 0);
  for (const w of worlds)
    assert.deepEqual(w.params, { frameId: "F1", worldName: "mz_input_probe" });
  const probeEvals = fake.calls.filter(
    (c) =>
      c.method === "Runtime.evaluate" && String(c.params?.expression).includes("__mzInputProbe"),
  );
  assert.ok(probeEvals.length > 0);
  for (const c of probeEvals)
    assert.equal(c.params?.contextId, 77, "probe code must never run in the page's main world");
  const installs = probeEvals.filter((c) =>
    String(c.params?.expression).includes("addEventListener"),
  ).length;
  const stops = probeEvals.filter((c) =>
    String(c.params?.expression).includes("delete globalThis"),
  ).length;
  assert.equal(stops, installs, "every armed probe is stopped");
});
