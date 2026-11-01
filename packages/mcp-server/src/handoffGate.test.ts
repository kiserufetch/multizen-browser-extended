import { after, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";
import type { Profile } from "@multizen/types";

import { ActivityLog } from "./ActivityLog.js";
import { createPrincipal, type Principal, type ToolGroup } from "./auth/principal.js";
import { bindHandoffToBrowser, type RunningEvents } from "./handoffBinding.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";
import { createSharedMcpState, type SharedMcpState } from "./sharedState.js";
import { policedToolNames, policyFor } from "./toolPolicy.js";

/**
 * The human gate over the wire, with real SDK clients on one shared state. apps/server's
 * e2e runs the same against real browsers.
 */

const profiles = {
  get: (id: string) => ({ id, dataDir: "unused", name: id, fingerprint: {} }) as unknown as Profile,
  list: () => [],
} as unknown as ProfileManager;

const CLIENTS: Client[] = [];
after(async () => {
  await Promise.all(CLIENTS.map((c) => c.close().catch(() => {})));
});

function principal(name: string, groups: ToolGroup[] = ["read", "act", "profile-admin", "raw"]): Principal {
  return createPrincipal({ id: name, name, full: false, tools: { groups, names: [] }, profiles: "*" });
}

class SlowDriver extends MockBrowserDriver {
  barrier: Promise<void> | null = null;
  readonly clicks: string[] = [];
  evaluations = 0;

  override async click(id: string, selector: string): Promise<{ ok: true }> {
    this.clicks.push(`${selector} start`);
    await this.barrier;
    this.clicks.push(`${selector} end`);
    return super.click(id, selector);
  }

  override async evaluateJs(): Promise<unknown> {
    this.evaluations += 1;
    return { result: { value: false } };
  }
}

interface Rig {
  driver: SlowDriver;
  shared: SharedMcpState;
  client: Client;
  other: Client;
}

async function rig(opts: { gate?: boolean; who?: Principal } = {}): Promise<Rig> {
  const driver = new SlowDriver();
  await driver.launch("p");
  const shared = createSharedMcpState();
  const connect = async (sessionId: string, who: Principal): Promise<Client> => {
    const { server } = createMultizenMcpServer({
      profileManager: profiles,
      browserDriver: driver,
      shared,
      handoffGate: opts.gate ?? true,
      principal: who,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = sessionId;
    const client = new Client({ name: sessionId, version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    CLIENTS.push(client);
    return client;
  };
  return {
    driver,
    shared,
    client: await connect("a", opts.who ?? principal("agent")),
    other: await connect("b", principal("other")),
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: { profile_id: "p", ...args } });
  const content = res.content as Array<{ type: string; text?: string }>;
  const body = content[0]?.type === "text" ? (JSON.parse(content[0].text!) as Record<string, any>) : {};
  return { isError: res.isError === true, body };
}

async function codeOf(client: Client, name: string, args: Record<string, unknown> = {}) {
  const { isError, body } = await call(client, name, args);
  return isError ? (body.error.code as string) : null;
}

/** Enough arguments to get past validation, for any tool. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  navigate: { url: "http://example.test/" },
  click: { selector: "#a" },
  type: { selector: "#a", text: "x" },
  click_ref: { ref: "e1" },
  type_ref: { ref: "e1", text: "x" },
  press_key: { key: "Enter" },
  hover: { selector: "#a" },
  select_option: { selector: "#a", index: 0 },
  scroll: { delta_y: 1 },
  upload_file: { selector: "#a", files: [{ file_name: "x", data_base64: "eA==" }] },
  handle_dialog: { action: "accept" },
  set_dialog_policy: { mode: "manual" },
  evaluate_js: { expression: "1" },
  wait_for_selector: { selector: "#a", timeout_ms: 1 },
  wait_for_navigation: { timeout_ms: 1 },
  wait_for_load: { timeout_ms: 1 },
  set_cookies: { cookies: [{ name: "a", value: "b" }] },
  activate_tab: { target_id: "t" },
  close_tab: { target_id: "t" },
  cdp_send: { method: "Page.getFrameTree" },
  cdp_send_no_safety: { method: "Page.getFrameTree" },
  update_profile: { name: "x" },
};

const BLOCKED_ALWAYS = policedToolNames().filter((name) => policyFor(name)!.humanGate === "block");

test("every action is refused with HUMAN_IN_CONTROL, retryable, naming the handoff", async () => {
  for (const kind of ["captcha", "2fa"] as const) {
    const { client, shared, driver } = await rig();
    const { id } = shared.handoff.request("p", "x", { kind });
    for (const tool of BLOCKED_ALWAYS) {
      const { isError, body } = await call(client, tool, VALID_ARGS[tool] ?? {});
      assert.equal(isError, true, tool);
      assert.equal(body.error.code, "HUMAN_IN_CONTROL", tool);
      assert.equal(body.error.retryable, true, tool);
      assert.equal(body.error.details.handoff_id, id, tool);
    }
    assert.deepEqual(driver.clicks, []);
    shared.handoff.abortById(id);
  }
});

test("the policy's list of actions is the one the spec names", () => {
  for (const name of ["evaluate_js", "cdp_send", "cdp_send_no_safety", "wait_for_selector", "wait_for_load", "wait_for_navigation", "delete_profile", "launch_profile"]) {
    assert.ok(BLOCKED_ALWAYS.includes(name), name);
  }
});

test("reads pass for captcha, confirm and other, and are blocked for 2fa and login", async () => {
  for (const [kind, blocked] of [
    ["captcha", false],
    ["confirm", false],
    ["other", false],
    ["2fa", true],
    ["login", true],
  ] as const) {
    const { client, shared } = await rig();
    const { id } = shared.handoff.request("p", "x", { kind });
    for (const tool of ["extract", "screenshot", "get_cookies"]) {
      const code = await codeOf(client, tool);
      assert.equal(code, blocked ? "HUMAN_IN_CONTROL" : null, `${tool} during ${kind}`);
    }
    // What says nothing about the page goes on either way.
    for (const tool of ["list_tabs", "list_dialogs", "list_downloads", "get_human_status", "list_fingerprint_options"]) {
      assert.equal(await codeOf(client, tool), null, `${tool} during ${kind}`);
    }
    shared.handoff.abortById(id);
  }
});

test("the lease tools keep working: a lease's TTL doesn't stop for a person", async () => {
  const { client, shared } = await rig();
  const { body } = await call(client, "acquire_profile");
  const { id } = shared.handoff.request("p", "x", { kind: "2fa" });
  assert.equal(await codeOf(client, "renew_profile", { lease_id: body.lease_id }), null);
  assert.equal(await codeOf(client, "release_profile", { lease_id: body.lease_id }), null);
  assert.equal(await codeOf(client, "acquire_profile"), null);
  shared.handoff.abortById(id);
});

test("close_profile goes through and aborts the handoff, with who did it", async () => {
  const { client, shared, driver } = await rig();
  const { id } = shared.handoff.request("p", "x", { kind: "2fa" });
  assert.equal(await codeOf(client, "close_profile"), null);
  assert.equal(driver.isRunning("p"), false);
  const record = shared.handoff.get(id)!;
  assert.equal(record.status, "aborted");
  assert.equal(record.settledBy, "agent");
});

test("delete_profile is refused while a handoff is on, and works after", async () => {
  const deleted: string[] = [];
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const shared = createSharedMcpState();
  const { server } = createMultizenMcpServer({
    profileManager: {
      ...profiles,
      get: profiles.get,
      delete: (id: string) => deleted.push(id),
    } as unknown as ProfileManager,
    browserDriver: driver,
    shared,
    handoffGate: true,
    principal: principal("admin"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "x", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  CLIENTS.push(client);

  const { id } = shared.handoff.request("p", "x");
  assert.equal(await codeOf(client, "delete_profile"), "HUMAN_IN_CONTROL");
  assert.deepEqual(deleted, []);
  shared.handoff.abortById(id);
  assert.equal(await codeOf(client, "delete_profile"), null);
  assert.deepEqual(deleted, ["p"]);
});

test("a call already waiting for the profile is refused when its turn comes", async () => {
  const { driver, shared, client, other } = await rig();
  let open = (): void => {};
  driver.barrier = new Promise((resolve) => {
    open = resolve;
  });
  const running = call(client, "click", { selector: "#first" });
  while (!driver.clicks.includes("#first start")) await new Promise((r) => setImmediate(r));
  const queued = call(other, "click", { selector: "#queued" });
  while (shared.mutex.queued("p") === 0) await new Promise((r) => setImmediate(r));

  const { id } = shared.handoff.request("p", "x");
  open();
  assert.equal((await running).isError, false, "what started before the handoff finishes");
  const { isError, body } = await queued;
  assert.equal(isError, true);
  assert.equal(body.error.code, "HUMAN_IN_CONTROL");
  assert.deepEqual(driver.clicks, ["#first start", "#first end"], "the queued click never fired");
  shared.handoff.abortById(id);
});

test("a wait_* in progress stops at its next poll when a handoff starts", async () => {
  const { shared, client, driver } = await rig();
  const waiting = call(client, "wait_for_selector", { selector: "#never", timeout_ms: 10_000 });
  while (driver.evaluations === 0) await new Promise((r) => setTimeout(r, 5));
  const { id } = shared.handoff.request("p", "x", { kind: "captcha" });
  const { isError, body } = await waiting;
  assert.equal(isError, true);
  assert.equal(body.error.code, "HUMAN_IN_CONTROL");
  shared.handoff.abortById(id);
});

test("after the handoff ends, whichever way, the same calls work again", async () => {
  for (const end of ["resumeById", "abortById"] as const) {
    const { shared, client } = await rig();
    const { id } = shared.handoff.request("p", "x");
    assert.equal(await codeOf(client, "click", { selector: "#a" }), "HUMAN_IN_CONTROL");
    shared.handoff[end](id);
    assert.equal(await codeOf(client, "click", { selector: "#a" }), null);
  }
});

test("with the gate off, the desktop's and plain stdio's way, a handoff blocks nothing", async () => {
  const { shared, client, driver } = await rig({ gate: false });
  const { id } = shared.handoff.request("p", "x", { kind: "2fa" });
  for (const tool of ["click", "extract", "screenshot", "get_cookies", "evaluate_js"]) {
    assert.equal(await codeOf(client, tool, VALID_ARGS[tool] ?? {}), null, tool);
  }
  assert.equal(driver.clicks.length, 2);
  shared.handoff.abortById(id);
});

test("gate off, a wait with nothing on record still returns at once, as agents were told", async () => {
  const { client } = await rig({ gate: false });
  const { isError, body } = await call(client, "wait_for_human");
  assert.equal(isError, false);
  assert.equal(body.resumed, true);
  assert.equal(body.timedOut, false);
  assert.equal(body.status, "none");
});

// ── the human tools ──────────────────────────────────────────────────────────

test("request_human returns at once with its id; a repeat is the same handoff", async () => {
  const { client, driver, shared } = await rig();
  const first = await call(client, "request_human", { reason: "code please", kind: "2fa" });
  assert.equal(first.isError, false);
  assert.equal(first.body.status, "waiting_for_human");
  assert.equal(first.body.handoff_status, "pending");
  assert.equal(first.body.kind, "2fa");
  assert.equal(typeof first.body.expires_at, "string");
  assert.match(first.body.note, /panel/);
  const repeat = await call(client, "request_human", { reason: "again", kind: "captcha" });
  assert.equal(repeat.body.handoff_id, first.body.handoff_id);
  assert.equal(repeat.body.kind, "2fa");
  assert.equal(shared.handoff.pending().length, 1);
  assert.ok(driver.isRunning("p"));
  shared.handoff.abortById(first.body.handoff_id);
});

test("request_human refuses a kind it doesn't know, and a profile that isn't running", async () => {
  const { client } = await rig();
  assert.equal(await codeOf(client, "request_human", { reason: "x", kind: "nope" }), "INVALID_INPUT");
  await call(client, "close_profile");
  assert.equal(await codeOf(client, "request_human", { reason: "x" }), "PROFILE_NOT_RUNNING");
});

test("wait_for_human gives the status: resumed only for a resume", async () => {
  for (const [end, status, resumed] of [
    ["resumeById", "resumed", true],
    ["abortById", "aborted", false],
  ] as const) {
    const { client, shared } = await rig();
    const { body } = await call(client, "request_human", { reason: "x" });
    const waiting = call(client, "wait_for_human", { timeout_ms: 5_000 });
    shared.handoff[end](body.handoff_id, "alice");
    const res = await waiting;
    assert.equal(res.body.status, status);
    assert.equal(res.body.resumed, resumed);
    assert.equal(res.body.timedOut, false);
    assert.equal(res.body.handoff_id, body.handoff_id);
    // Asked again afterwards, the tombstone says the same.
    const later = await call(client, "wait_for_human");
    assert.equal(later.body.status, status);
    assert.equal(later.body.resumed, resumed);
    const byId = await call(client, "get_human_status", { handoff_id: body.handoff_id });
    assert.equal(byId.body.pending, false);
    assert.equal(byId.body.status, status);
    assert.equal(byId.body.settled_by, "alice");
  }
});

test("wait_for_human after an expiry is never resumed", async () => {
  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const { InMemoryHumanHandoff } = await import("./handoff.js");
  const shared = createSharedMcpState({ handoff: new InMemoryHumanHandoff({ defaultTtlMs: 20 }) });
  const { server } = createMultizenMcpServer({
    profileManager: profiles,
    browserDriver: driver,
    shared,
    handoffGate: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "x", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  CLIENTS.push(client);

  await call(client, "request_human", { reason: "x" });
  const { body } = await call(client, "wait_for_human", { timeout_ms: 5_000 });
  assert.equal(body.status, "expired");
  assert.equal(body.resumed, false);
  assert.equal(body.timedOut, false);
  assert.equal(await codeOf(client, "click", { selector: "#a" }), null, "an expired handoff blocks nothing");
});

test("wait_for_human runs out as pending, never as an end, and is clamped to 55 s", async (t) => {
  const { client, shared } = await rig();
  const { body } = await call(client, "request_human", { reason: "x" });
  const res = await call(client, "wait_for_human", { timeout_ms: 20 });
  assert.equal(res.body.status, "pending");
  assert.equal(res.body.resumed, false);
  assert.equal(res.body.timedOut, true);

  const asked: number[] = [];
  const realWait = shared.handoff.waitForId.bind(shared.handoff);
  t.mock.method(shared.handoff, "waitForId", (id: string, ms: number) => {
    asked.push(ms);
    return realWait(id, 1);
  });
  await call(client, "wait_for_human");
  await call(client, "wait_for_human", { timeout_ms: 300_000 });
  assert.deepEqual(asked, [50_000, 55_000]);
  shared.handoff.abortById(body.handoff_id);
});

test("an id nobody knows, as after a restart, is HANDOFF_NOT_FOUND", async () => {
  const { client, shared } = await rig();
  assert.equal(await codeOf(client, "wait_for_human", { handoff_id: "gone" }), "HANDOFF_NOT_FOUND");
  assert.equal(await codeOf(client, "get_human_status", { handoff_id: "gone" }), "HANDOFF_NOT_FOUND");
  assert.equal(await codeOf(client, "wait_for_human"), "HANDOFF_NOT_FOUND", "gate on: no record");
  assert.deepEqual((await call(client, "get_human_status")).body, { pending: false, status: "none" });

  // Another profile's id doesn't read as this one's.
  await shared.handoff.request("q", "x");
  const foreign = shared.handoff.activeForProfile("q")!.id;
  assert.equal(await codeOf(client, "get_human_status", { handoff_id: foreign }), "HANDOFF_NOT_FOUND");
  shared.handoff.abortById(foreign);
});

test("a wait still answers after the browser went: aborted, not PROFILE_NOT_RUNNING", async () => {
  const { client, shared, driver } = await rig();
  const { body } = await call(client, "request_human", { reason: "x" });
  await driver.close("p");
  shared.handoff.closeForProfile("p", "browser exited");
  const res = await call(client, "wait_for_human", { handoff_id: body.handoff_id });
  assert.equal(res.isError, false);
  assert.equal(res.body.status, "aborted");
  assert.equal(res.body.resumed, false);
});

test("resume_human takes the operator group, and records who", async () => {
  const { client, shared } = await rig();
  const { body } = await call(client, "request_human", { reason: "x" });
  assert.equal(await codeOf(client, "resume_human"), "FORBIDDEN");
  assert.equal(shared.handoff.get(body.handoff_id)?.status, "pending");

  const driver = new MockBrowserDriver();
  await driver.launch("p");
  const { server } = createMultizenMcpServer({
    profileManager: profiles,
    browserDriver: driver,
    shared,
    handoffGate: true,
    principal: principal("boss", ["read", "act", "operator"]),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const operator = new Client({ name: "op", version: "0" });
  await server.connect(serverTransport);
  await operator.connect(clientTransport);
  CLIENTS.push(operator);
  assert.equal(await codeOf(operator, "resume_human"), null, "works during the handoff");
  const record = shared.handoff.get(body.handoff_id)!;
  assert.equal(record.status, "resumed");
  assert.equal(record.settledBy, "boss");
});

// ── the binding to the browser ───────────────────────────────────────────────

function emitter(): RunningEvents & { emit(change: { kind: string; profileId: string; reason?: string }): void } {
  const listeners: Array<(c: { kind: string; profileId: string; reason?: string }) => void> = [];
  return {
    on: (_event, listener) => listeners.push(listener),
    emit: (change) => listeners.forEach((l) => l(change)),
  };
}

test("the browser closing or crashing aborts a handoff, and says which", () => {
  const { InMemoryHumanHandoff } = { InMemoryHumanHandoff: createSharedMcpState().handoff.constructor as any };
  const handoff = new InMemoryHumanHandoff();
  const events = emitter();
  const driver = Object.assign(new MockBrowserDriver(), { on: events.on });
  bindHandoffToBrowser({ handoff, driver, panelDriven: () => false });

  const crashed = handoff.request("p", "x");
  events.emit({ kind: "launched", profileId: "p" });
  assert.equal(handoff.get(crashed.id).status, "pending");
  events.emit({ kind: "closed", profileId: "p", reason: "external-exit" });
  assert.equal(handoff.get(crashed.id).status, "aborted");
  assert.equal(handoff.get(crashed.id).settledBy, "browser exited");

  const closed = handoff.request("p", "x");
  events.emit({ kind: "closing", profileId: "p" });
  assert.equal(handoff.get(closed.id).status, "aborted");
  assert.equal(handoff.get(closed.id).settledBy, "browser closed");
});

test("a panel handoff holds dialogs and choosers for its length; a windowed one leaves them alone", async () => {
  const { handoff } = createSharedMcpState();
  const driver = new MockBrowserDriver();
  let panel = true;
  bindHandoffToBrowser({ handoff, driver, panelDriven: () => panel });

  const first = handoff.request("p", "x");
  assert.deepEqual(driver.handoffModes, [{ profileId: "p", active: true }], "before anything awaits");
  handoff.resumeById(first.id);
  assert.deepEqual(driver.handoffModes.at(-1), { profileId: "p", active: false });

  panel = false;
  driver.handoffModes.length = 0;
  const second = handoff.request("p", "x");
  handoff.abortById(second.id);
  assert.deepEqual(driver.handoffModes, []);
});

test("the activity log gets the lifecycle with the actor, and not the reason", () => {
  const { handoff } = createSharedMcpState();
  const log = new ActivityLog();
  bindHandoffToBrowser({ handoff, driver: new MockBrowserDriver(), activityLog: log, panelDriven: () => false });
  const { id } = handoff.request("p", "SECRET-REASON", { kind: "login", requestedBy: "agent" });
  handoff.resumeById(id, "alice");
  const events = log.recent();
  assert.deepEqual(
    events.map((e) => [e.tool, e.actor, e.profileId, e.status]),
    [
      ["handoff.requested", "agent", "p", "ok"],
      ["handoff.resumed", "alice", "p", "ok"],
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /SECRET-REASON/);
});
