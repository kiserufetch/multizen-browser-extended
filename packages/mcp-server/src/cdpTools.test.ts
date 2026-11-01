import { test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMultizenMcpServer, type BrowserDriver } from "./server.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import {
  CHROME_VERSION_FULL,
  CHROME_VERSION_MAJOR,
  generateFingerprint,
  type ProfileManager,
} from "@multizen/profile-manager";
import type { DriverAction, FingerprintConfig, LaunchedProfile, Profile, ProfileId } from "@multizen/types";

/**
 * End-to-end exercise of the MCP server CDP tool surfaces. We connect a real
 * MCP `Client` to a real `Server` over an in-memory transport pair, so every
 * assertion goes through genuine `tools/list` + `tools/call` JSON-RPC round
 * trips (including Zod validation and the dispatch switch). The browser layer
 * is faked so we can capture exactly what `dispatch()` asks the driver to do.
 */

const NEW_TOOLS = [
  "cdp_send",
  "cdp_send_no_safety",
  "evaluate_js",
  "wait_for_selector",
  "get_cookies",
  "set_cookies",
  "list_tabs",
  "new_tab",
  "activate_tab",
  "close_tab",
  "wait_for_navigation",
  "wait_for_load",
] as const;

interface CdpCall {
  profileId: string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  opts?: { safe?: boolean };
}

const notUsedHere = async (): Promise<never> => {
  throw new Error("not used by these tests");
};

/** A BrowserDriver that records every cdpSend and returns a configurable
 *  response, so dispatch composition (method + params + safe flag) is
 *  observable without a browser. */
class SpyDriver implements BrowserDriver {
  readonly actions: DriverAction[] = [];
  async performAction(_profileId: ProfileId, action: DriverAction): Promise<{ ok: true }> {
    this.actions.push(action);
    return { ok: true };
  }
  listDownloads = notUsedHere;
  getDownload = notUsedHere;
  deleteDownload = notUsedHere;
  setDialogPolicy = notUsedHere;
  listDialogs = notUsedHere;
  handleDialog = notUsedHere;
  captureFrame = notUsedHere;
  dispatchInput = notUsedHere;
  readonly running = new Set<string>();
  readonly calls: CdpCall[] = [];
  respond: (method: string, params?: Record<string, unknown>) => unknown = () => ({ ok: true });

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    this.running.add(profileId);
    return {
      id: profileId,
      cdpEndpoint: "http://127.0.0.1:0",
      pid: 1,
      startedAt: new Date().toISOString(),
    };
  }
  async close(profileId: ProfileId): Promise<void> {
    this.running.delete(profileId);
  }
  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }
  async navigate(_profileId: ProfileId, url: string): Promise<{ url: string }> {
    return { url };
  }
  async click(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async type(): Promise<{ ok: true }> {
    return { ok: true };
  }
  readonly refCalls: Array<{ kind: "click" | "type"; ref: string; text?: string }> = [];
  async clickRef(_p: ProfileId, ref: string): Promise<{ ok: true }> {
    this.refCalls.push({ kind: "click", ref });
    return { ok: true };
  }
  async typeRef(_p: ProfileId, ref: string, text: string): Promise<{ ok: true }> {
    this.refCalls.push({ kind: "type", ref, text });
    return { ok: true };
  }
  async extract(): Promise<{ result: unknown }> {
    return { result: {} };
  }
  async screenshot(): Promise<{ pngBase64: string }> {
    return { pngBase64: "" };
  }
  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    this.calls.push({ profileId, method, params, sessionId, opts });
    return this.respond(method, params);
  }
  // The curated verbs compose CDP exactly as ChromiumBrowserDriver does, so the
  // dispatch tests below keep pinning the method + params that reach the browser.
  async evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
      { safe: true },
    );
  }
  async getCookies(profileId: ProfileId, urls?: string[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.getCookies", urls ? { urls } : {}, sessionId, {
      safe: true,
    });
  }
  async setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.setCookies", { cookies }, sessionId, { safe: true });
  }
  async listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.getTargets", {}, sessionId, { safe: true });
  }
  async newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Target.createTarget",
      { url: url ?? "about:blank" },
      sessionId,
      { safe: true },
    );
  }
  async activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.activateTarget", { targetId }, sessionId, { safe: true });
  }
  async closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.closeTarget", { targetId }, sessionId, { safe: true });
  }
}

async function connect(
  driver: BrowserDriver,
  // The profile manager is never touched by the CDP tool paths (they only
  // need isRunning + cdpSend), so a bare stub is the default. probe_fingerprint
  // reads the stored profile and passes one with `get`.
  profileManager = {} as unknown as ProfileManager,
): Promise<Client> {
  const { server } = createMultizenMcpServer({ profileManager, browserDriver: driver });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

interface CallResult {
  isError: boolean;
  parsed: any;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { isError: res.isError === true, parsed };
}

/** No convenience wrapper is allowed to enable a CDP domain — that is the
 *  whole stealth point of composing them over the bare primitive. */
function assertNoDomainEnable(spy: SpyDriver): void {
  for (const c of spy.calls) {
    assert.ok(
      !/\.enable$/.test(c.method),
      `wrapper unexpectedly issued a domain enable: ${c.method}`,
    );
  }
}

// ── initialize guidance ──────────────────────────────────────────────────────

test("initialize: autonomy within the product's limits, and how display modes work", async () => {
  const client = await connect(new SpyDriver());
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions, "initialize must include server-level guidance");
    assert.match(instructions, /tools and access available to you/);
    assert.match(instructions, /Do not stop and ask a human to perform work you can complete yourself/);
    assert.match(instructions, /concrete missing prerequisite actually prevents progress/);
    assert.match(instructions, /CAPTCHA.*do not attempt to solve or bypass it yourself/);
    assert.match(instructions, /Do not create or launch profiles in bulk to farm accounts/);
    assert.match(instructions, /authorized workflows/);
    assert.match(instructions, /EGRESS_BLOCKED/);

    assert.doesNotMatch(instructions, /no headless mode/i);
    assert.doesNotMatch(instructions, /always open as visible/i);
    for (const mode of ["headed", "headless", "xvfb"]) assert.match(instructions, new RegExp(mode));
    assert.match(instructions, /display_mode/);
    assert.match(instructions, /PROFILE_ALREADY_RUNNING/);
    assert.match(instructions, /--headless/);
  } finally {
    await client.close();
  }
});

// ── tools/list registration ─────────────────────────────────────────────────

test("tools/list exposes all 12 CDP tool surfaces with object input schemas", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of NEW_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool, `tool ${name} is not registered in TOOL_DEFINITIONS`);
    assert.equal(typeof tool!.description, "string");
    assert.ok((tool!.description ?? "").length > 0, `tool ${name} has no description`);
    assert.equal((tool!.inputSchema as { type?: string }).type, "object");
  }
  await client.close();
});

test("cdp_send_no_safety description explicitly warns it bypasses stealth", async () => {
  const client = await connect(new SpyDriver());
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "cdp_send_no_safety");
  assert.ok(tool);
  const desc = tool!.description ?? "";
  assert.match(desc, /bypass/i);
  assert.match(desc, /stealth/i);
  await client.close();
});

// ── safe / no-safety routing ────────────────────────────────────────────────

test("cdp_send routes to driver.cdpSend with safe:true and verbatim method/params", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "cdp_send", {
    profile_id: "p1",
    method: "Page.captureScreenshot",
    params: { format: "png" },
    sessionId: "S1",
  });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Page.captureScreenshot");
  assert.deepEqual(c.params, { format: "png" });
  assert.equal(c.sessionId, "S1");
  assert.equal(c.opts?.safe, true);
  await client.close();
});

test("cdp_send_no_safety routes to driver.cdpSend with safe:false", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "cdp_send_no_safety", { profile_id: "p1", method: "Network.enable" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Network.enable");
  assert.equal(c.opts?.safe, false);
  await client.close();
});

// ── convenience wrappers compose the right CDP method without enabling ───────

test("evaluate_js composes Runtime.evaluate{returnByValue} (no domain enable)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "evaluate_js", {
    profile_id: "p1",
    expression: "1 + 1",
    sessionId: "S2",
  });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Runtime.evaluate");
  assert.deepEqual(c.params, { expression: "1 + 1", returnByValue: true });
  assert.equal(c.sessionId, "S2");
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("wait_for_selector polls Runtime.evaluate(querySelector) and reports found", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) =>
    method === "Runtime.evaluate" ? { result: { value: true } } : { ok: true };
  const client = await connect(spy);
  const { parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
  });
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Runtime.evaluate");
  assert.equal(c.params?.expression, '!!document.querySelector("#login")');
  assert.equal(c.params?.returnByValue, true);
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("wait_for_selector returns found:false when the budget elapses", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = () => ({ result: { value: false } });
  const client = await connect(spy);
  const { parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#never",
    timeout_ms: 1,
  });
  assert.deepEqual(parsed, { found: false, selector: "#never" });
  await client.close();
});

// ── pollUntil scoped-retry on transient navigation errors ────────────────────
// pollUntil (shared by wait_for_selector / wait_for_navigation / wait_for_load)
// must keep polling through transient "execution context destroyed" failures
// raised mid-navigation, but never mask a real error.

test("wait_for_selector swallows transient navigation errors and resolves once the context returns", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  let attempts = 0;
  spy.respond = (method) => {
    if (method !== "Runtime.evaluate") return { ok: true };
    attempts += 1;
    // The first couple of evaluations land while the page is reloading.
    if (attempts <= 2) throw new Error("Execution context was destroyed.");
    return { result: { value: true } };
  };
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
  });
  assert.equal(isError, false);
  assert.deepEqual(parsed, { found: true, selector: "#login" });
  assert.ok(attempts >= 3, "retried through the transient errors before succeeding");
  await client.close();
});

test("wait_for_selector rethrows a non-transient error immediately (no retry to timeout)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) => {
    if (method === "Runtime.evaluate") throw new Error("SyntaxError: 'foo[' is not a valid selector");
    return { ok: true };
  };
  const client = await connect(spy);
  // A generous budget: if a real error were (wrongly) retried this would spin
  // ~30s and rack up many calls. We assert it returns at once after one check.
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "foo[",
    timeout_ms: 30000,
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not a valid selector/i);
  assert.doesNotMatch(parsed.error.message, /timed out/i, "surfaced the real error, not a timeout");
  const evals = spy.calls.filter((c) => c.method === "Runtime.evaluate");
  assert.equal(evals.length, 1, "thrown on the first check — no retry loop");
  await client.close();
});

test("wait_for_selector throws a clear timeout when transient errors persist past the budget", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) => {
    if (method === "Runtime.evaluate") throw new Error("Cannot find context with specified id");
    return { ok: true };
  };
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "wait_for_selector", {
    profile_id: "p1",
    selector: "#login",
    timeout_ms: 1,
  });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /timed out/i);
  assert.match(parsed.error.message, /Cannot find context/i, "names the underlying transient error");
  await client.close();
});

test("get_cookies composes Network.getCookies with an optional url filter", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "get_cookies", { profile_id: "p1" });
  assert.equal(spy.calls.at(-1)!.method, "Network.getCookies");
  assert.deepEqual(spy.calls.at(-1)!.params, {});

  await call(client, "get_cookies", { profile_id: "p1", urls: ["https://example.com"] });
  assert.deepEqual(spy.calls.at(-1)!.params, { urls: ["https://example.com"] });
  assert.equal(spy.calls.at(-1)!.opts?.safe, true);

  assertNoDomainEnable(spy);
  await client.close();
});

// NOTE: the implementation uses Network.setCookies (PLURAL) — a known,
// intentional deviation from the plan's "Network.setCookie". The test asserts
// the actual shipped behaviour.
test("set_cookies composes Network.setCookies (plural) with the cookie batch", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const cookies = [
    { name: "sid", value: "abc", domain: "example.com" },
    { name: "theme", value: "dark" },
  ];
  await call(client, "set_cookies", { profile_id: "p1", cookies });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Network.setCookies");
  assert.deepEqual(c.params, { cookies });
  assert.equal(c.opts?.safe, true);
  assertNoDomainEnable(spy);
  await client.close();
});

test("list_tabs composes Target.getTargets", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  await call(client, "list_tabs", { profile_id: "p1" });
  const c = spy.calls.at(-1)!;
  assert.equal(c.method, "Target.getTargets");
  assert.deepEqual(c.params, {});
  assertNoDomainEnable(spy);
  await client.close();
});

test("new_tab composes Target.createTarget (defaulting url to about:blank)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "new_tab", { profile_id: "p1" });
  assert.equal(spy.calls.at(-1)!.method, "Target.createTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "about:blank" });

  await call(client, "new_tab", { profile_id: "p1", url: "https://example.com" });
  assert.deepEqual(spy.calls.at(-1)!.params, { url: "https://example.com" });

  assertNoDomainEnable(spy);
  await client.close();
});

test("activate_tab and close_tab compose Target.activateTarget / Target.closeTarget", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);

  await call(client, "activate_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.activateTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  await call(client, "close_tab", { profile_id: "p1", target_id: "T7" });
  assert.equal(spy.calls.at(-1)!.method, "Target.closeTarget");
  assert.deepEqual(spy.calls.at(-1)!.params, { targetId: "T7" });

  assertNoDomainEnable(spy);
  await client.close();
});

// NOTE: wait_for_navigation / wait_for_load poll document.readyState === "complete"
// via Runtime.evaluate — a known, intentional deviation from the plan's
// Page.loadEventFired event subscription.
for (const name of ["wait_for_navigation", "wait_for_load"] as const) {
  test(`${name} polls document.readyState and reports loaded`, async () => {
    const spy = new SpyDriver();
    spy.running.add("p1");
    spy.respond = (method) =>
      method === "Runtime.evaluate" ? { result: { value: "complete" } } : { ok: true };
    const client = await connect(spy);
    const { parsed } = await call(client, name, { profile_id: "p1" });
    assert.deepEqual(parsed, { loaded: true });
    const c = spy.calls.at(-1)!;
    assert.equal(c.method, "Runtime.evaluate");
    assert.equal(c.params?.expression, "document.readyState");
    assert.equal(c.params?.returnByValue, true);
    assert.equal(c.opts?.safe, true);
    assertNoDomainEnable(spy);
    await client.close();
  });
}

// ── negative / validation paths ─────────────────────────────────────────────

test("CDP tools require a running profile and return a clear error otherwise", async () => {
  const spy = new SpyDriver(); // nothing running
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "cdp_send", {
    profile_id: "ghost",
    method: "Runtime.evaluate",
  });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INTERNAL_ERROR");
  assert.match(parsed.error.message, /not running/i);
  assert.match(parsed.error.message, /launch_profile/i);
  assert.equal(spy.calls.length, 0, "driver.cdpSend must not run for a stopped profile");
  await client.close();
});

test("cdp_send rejects a missing method via Zod (INVALID_INPUT)", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "cdp_send", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  assert.equal(spy.calls.length, 0);
  await client.close();
});

test("set_cookies rejects an empty cookie array via Zod", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "set_cookies", { profile_id: "p1", cookies: [] });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  await client.close();
});

test("evaluate_js rejects a missing expression via Zod", async () => {
  const spy = new SpyDriver();
  spy.running.add("p1");
  const client = await connect(spy);
  const { isError, parsed } = await call(client, "evaluate_js", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.equal(parsed.error.code, "INVALID_INPUT");
  await client.close();
});

// ── the shipped MockBrowserDriver (standalone dev mode) ──────────────────────

test("MockBrowserDriver echoes the safe flag end-to-end through the server", async () => {
  const mock = new MockBrowserDriver();
  await mock.launch("p1"); // mark running without needing the profile manager
  const client = await connect(mock);

  const safe = await call(client, "cdp_send", {
    profile_id: "p1",
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  assert.equal(safe.parsed.mock, true);
  assert.equal(safe.parsed.method, "Runtime.evaluate");
  assert.deepEqual(safe.parsed.params, { expression: "1" });
  assert.equal(safe.parsed.safe, true);

  const raw = await call(client, "cdp_send_no_safety", {
    profile_id: "p1",
    method: "Network.enable",
  });
  assert.equal(raw.parsed.safe, false);
  assert.equal(raw.parsed.method, "Network.enable");

  await client.close();
});

test("MockBrowserDriver rejects CDP tools for a profile that was never launched", async () => {
  const mock = new MockBrowserDriver();
  const client = await connect(mock);
  const { isError, parsed } = await call(client, "list_tabs", { profile_id: "p1" });
  assert.equal(isError, true);
  assert.match(parsed.error.message, /not running/i);
  await client.close();
});

test("navigate and new_tab reject non-http(s) URL schemes (prompt-injection pivot guard)", async () => {
  const spy = new SpyDriver();
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const dangerous = [
    "file:///etc/passwd",
    "file://C:/Windows/win.ini",
    "javascript:alert(document.cookie)",
    "data:text/html,<script>1</script>",
    "chrome://settings",
    "chrome-extension://abc/x.html",
    "view-source:http://example.com",
  ];
  for (const url of dangerous) {
    const nav = await call(client, "navigate", { profile_id: "p1", url });
    assert.equal(nav.isError, true, `navigate should reject ${url}`);
    assert.equal(nav.parsed.error.code, "INVALID_INPUT");
    const tab = await call(client, "new_tab", { profile_id: "p1", url });
    assert.equal(tab.isError, true, `new_tab should reject ${url}`);
  }
  // Sanity: a normal http(s) URL is still accepted (reaches the driver).
  const okNav = await call(client, "navigate", { profile_id: "p1", url: "https://example.com/" });
  assert.equal(okNav.isError, false);
  await client.close();
});

test("screenshot returns an MCP image content block, not base64 JSON text", async () => {
  const spy = new SpyDriver();
  // 1x1 transparent PNG.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  (spy as unknown as { screenshot: () => Promise<{ pngBase64: string }> }).screenshot = async () => ({
    pngBase64: png,
  });
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const res = await client.callTool({ name: "screenshot", arguments: { profile_id: "p1" } });
  const content = res.content as Array<{ type: string; data?: string; mimeType?: string }>;
  assert.equal(content[0]?.type, "image");
  assert.equal(content[0]?.mimeType, "image/png");
  assert.equal(content[0]?.data, png);
  await client.close();
});

test("click_ref and type_ref route the ref (and text) to the driver", async () => {
  const spy = new SpyDriver();
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const c = await call(client, "click_ref", { profile_id: "p1", ref: "e7" });
  assert.equal(c.isError, false);
  const t = await call(client, "type_ref", { profile_id: "p1", ref: "e3", text: "hello" });
  assert.equal(t.isError, false);
  assert.deepEqual(spy.refCalls, [
    { kind: "click", ref: "e7" },
    { kind: "type", ref: "e3", text: "hello" },
  ]);
  await client.close();
});

test("lost input surfaces as INPUT_NOT_DELIVERED with the driver's message", async () => {
  const spy = new SpyDriver();
  const lost = new Error(
    'Click on ref "e7" was not delivered: the page received no pointer events.',
  );
  lost.name = "InputNotDeliveredError";
  spy.clickRef = async () => {
    throw lost;
  };
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const res = await call(client, "click_ref", { profile_id: "p1", ref: "e7" });
  assert.equal(res.isError, true);
  assert.equal(res.parsed.error.code, "INPUT_NOT_DELIVERED");
  assert.equal(res.parsed.error.message, lost.message);
  await client.close();
});

test("click_ref / type_ref require profile_id + ref (schema validation)", async () => {
  const spy = new SpyDriver();
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const bad = await call(client, "click_ref", { profile_id: "p1" });
  assert.equal(bad.isError, true);
  assert.equal(bad.parsed.error.code, "INVALID_INPUT");
  await client.close();
});

// ── AGT-6: human handoff (CAPTCHA / 2FA) ─────────────────────────────────────
import { InMemoryHumanHandoff } from "./handoff.js";

test("handoff registry: waitFor resolves on resume and reports pending", async () => {
  const h = new InMemoryHumanHandoff();
  assert.equal(h.isPending("p1" as ProfileId), false);
  h.request("p1" as ProfileId, "solve CAPTCHA");
  assert.equal(h.isPending("p1" as ProfileId), true);
  assert.deepEqual(
    h.pending().map((x) => ({ id: x.profileId, reason: x.reason })),
    [{ id: "p1", reason: "solve CAPTCHA" }],
  );
  const waiting = h.waitFor("p1" as ProfileId, 5000);
  h.resume("p1" as ProfileId);
  assert.deepEqual(await waiting, { resumed: true });
  assert.equal(h.isPending("p1" as ProfileId), false);
});

test("handoff registry: waitFor times out, and no-pending resolves immediately", async () => {
  const h = new InMemoryHumanHandoff();
  h.request("p1" as ProfileId, "x");
  assert.deepEqual(await h.waitFor("p1" as ProfileId, 20), { resumed: false });
  // Nothing pending → resolve as resumed so a stray wait doesn't hang.
  assert.deepEqual(await h.waitFor("p2" as ProfileId, 20), { resumed: true });
});

test("handoff registry: onChange fires on request and resume", () => {
  const h = new InMemoryHumanHandoff();
  const sizes: number[] = [];
  const off = h.onChange((p) => sizes.push(p.length));
  h.request("p1" as ProfileId, "a");
  h.resume("p1" as ProfileId);
  off();
  h.request("p2" as ProfileId, "b"); // after unsubscribe — not recorded
  assert.deepEqual(sizes, [1, 0]);
});

test("request_human then wait_for_human unblocks on resume_human", async () => {
  const spy = new SpyDriver();
  const client = await connect(spy);
  await spy.launch("p1" as ProfileId);
  const req = await call(client, "request_human", { profile_id: "p1", reason: "solve CAPTCHA" });
  assert.equal(req.isError, false);
  assert.equal(req.parsed.status, "waiting_for_human");
  // request_human brings the window forward (best-effort), with no CDP for Camoufox to lack.
  assert.ok(spy.actions.some((a) => a.type === "bring_to_front"));
  assert.ok(!spy.calls.some((c) => c.method === "Page.bringToFront"));
  // No gate: the desktop or plain stdio, neither with a /panel to send anyone to.
  assert.match(String(req.parsed.note), /plain stdio has no panel/);
  assert.doesNotMatch(String(req.parsed.note), /\/panel on this server/);
  const waiting = call(client, "wait_for_human", { profile_id: "p1", timeout_ms: 5000 });
  await call(client, "resume_human", { profile_id: "p1" });
  const res = await waiting;
  assert.equal(res.parsed.resumed, true);
  assert.equal(res.parsed.timedOut, false);
  await client.close();
});

// ── probe_fingerprint drift ──────────────────────────────────────────────────

interface LiveProbe {
  userAgent: string;
  platform: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number | null;
  screen: { width: number; height: number };
  webgl: { vendor: string | null; renderer: string | null };
  timezone: string;
  canvasHash: string | null;
}

/** A profile manager serving one stored fingerprint, all the probe reads. */
function profileManagerWith(id: string, fingerprint: FingerprintConfig): ProfileManager {
  return {
    get: (pid: string) => (pid === id ? ({ id, fingerprint } as unknown as Profile) : null),
  } as unknown as ProfileManager;
}

/** A fingerprint as the generator stores it: full-version UA, physical RAM.
 *  16 GB is a common persona value the Device Memory API reports as 8. */
function storedFingerprint(overrides: Partial<FingerprintConfig> = {}): FingerprintConfig {
  return {
    ...generateFingerprint("probe-seed", { hostFilter: false }),
    deviceMemory: 16,
    ...overrides,
  };
}

/** What CloakBrowser reports for the default `storedFingerprint()` when every
 *  pin holds: the reduced UA and the capped deviceMemory. */
function healthyLive(fp: FingerprintConfig): LiveProbe {
  return {
    userAgent: fp.userAgent.replace(
      `Chrome/${CHROME_VERSION_FULL}`,
      `Chrome/${CHROME_VERSION_MAJOR}.0.0.0`,
    ),
    platform: fp.platform,
    languages: [...fp.languages],
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: 8,
    screen: { ...fp.screen },
    webgl: { ...fp.webgl },
    timezone: fp.timezone,
    canvasHash: "1a2b3c",
  };
}

async function probe(fp: FingerprintConfig, live: LiveProbe): Promise<CallResult> {
  const spy = new SpyDriver();
  spy.running.add("p1");
  spy.respond = (method) =>
    method === "Runtime.evaluate" ? { result: { value: live } } : { ok: true };
  const client = await connect(spy, profileManagerWith("p1", fp));
  const res = await call(client, "probe_fingerprint", { profile_id: "p1" });
  await client.close();
  return res;
}

test("probe_fingerprint: a healthy CloakBrowser profile reports drift=[]", async () => {
  const fp = storedFingerprint();
  // The stored UA carries the full version; the live one is reduced.
  assert.ok(fp.userAgent.includes(`Chrome/${CHROME_VERSION_FULL} `), fp.userAgent);
  const live = healthyLive(fp);
  assert.ok(live.userAgent.includes(`Chrome/${CHROME_VERSION_MAJOR}.0.0.0 `), live.userAgent);

  const res = await probe(fp, live);
  assert.equal(res.isError, false);
  assert.deepEqual(res.parsed.drift, []);
  assert.equal(res.parsed.ok, true);
  // `expected` holds the values the comparison used, so it lines up with `live`.
  assert.equal(res.parsed.expected.userAgent, live.userAgent);
  assert.equal(res.parsed.expected.deviceMemory, 8);
});

test("probe_fingerprint: deviceMemory is compared as the quantized API value", async () => {
  // physical GB → navigator.deviceMemory (nearest power of two, capped at 8)
  const cases: Array<[number, number]> = [
    [2, 2],
    [3, 4],
    [4, 4],
    [6, 8],
    [12, 8],
    [18, 8],
    [64, 8],
  ];
  for (const [physical, api] of cases) {
    const fp = storedFingerprint({ deviceMemory: physical });
    const res = await probe(fp, { ...healthyLive(fp), deviceMemory: api });
    assert.deepEqual(res.parsed.drift, [], `${physical} GB should be reported as ${api}`);
  }
  // A browser reporting the raw physical value is real drift, not a match.
  const fp = storedFingerprint();
  const raw = await probe(fp, { ...healthyLive(fp), deviceMemory: 16 });
  assert.deepEqual(raw.parsed.drift, ["deviceMemory"]);
  assert.equal(raw.parsed.ok, false);
});

test("probe_fingerprint: still reports userAgent drift on a wrong major or an unreduced UA", async () => {
  const fp = storedFingerprint();
  const live = healthyLive(fp);
  const otherMajor = await probe(fp, {
    ...live,
    userAgent: live.userAgent.replace(
      `Chrome/${CHROME_VERSION_MAJOR}.`,
      `Chrome/${CHROME_VERSION_MAJOR - 1}.`,
    ),
  });
  assert.deepEqual(otherMajor.parsed.drift, ["userAgent"]);
  // Chrome never puts its full version in navigator.userAgent, so a live UA
  // matching the stored string verbatim is itself a mismatch.
  const unreduced = await probe(fp, { ...live, userAgent: fp.userAgent });
  assert.deepEqual(unreduced.parsed.drift, ["userAgent"]);
});

test("probe_fingerprint: an ICU alias of the stored timezone is not drift", async () => {
  // Stored (catalog, IANA) → what Chromium's ICU reports for that zone.
  const aliases: Array<[string, string]> = [
    ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
  ];
  for (const [stored, reported] of aliases) {
    const fp = storedFingerprint({ timezone: stored });
    const res = await probe(fp, { ...healthyLive(fp), timezone: reported });
    assert.deepEqual(res.parsed.drift, [], `${stored} reported as ${reported}`);
    assert.equal(res.parsed.expected.timezone, stored);
  }
  // A different zone with the same offset is still drift.
  const fp = storedFingerprint({ timezone: "America/Argentina/Buenos_Aires" });
  const res = await probe(fp, { ...healthyLive(fp), timezone: "America/Sao_Paulo" });
  assert.deepEqual(res.parsed.drift, ["timezone"]);
});

test("probe_fingerprint: Camoufox compares only screen, timezone and hardwareConcurrency", async () => {
  const fp = storedFingerprint();
  // Camoufox reports a Firefox UA and Firefox WebGL strings; it pins the persona's
  // screen, timezone and thread count.
  const live: LiveProbe = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
    platform: fp.platform === "Win32" ? "MacIntel" : "Win32",
    languages: ["xx-XX"],
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: null,
    screen: { ...fp.screen },
    webgl: { vendor: "Mozilla", renderer: "Mozilla" },
    timezone: fp.timezone,
    canvasHash: null,
  };
  const pinned = await probe(fp, live);
  assert.deepEqual(pinned.parsed.drift, []);

  const moved = await probe(fp, {
    ...live,
    timezone: "Antarctica/Troll",
    hardwareConcurrency: fp.hardwareConcurrency + 2,
    screen: { width: fp.screen.width + 1, height: fp.screen.height },
  });
  assert.deepEqual(moved.parsed.drift, ["timezone", "hardwareConcurrency", "screen"]);
});
