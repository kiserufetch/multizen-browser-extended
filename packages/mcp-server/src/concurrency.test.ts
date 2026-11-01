import { after, test } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ProfileManager } from "@multizen/profile-manager";
import { MultizenError, type LaunchedProfile, type LaunchOptions, type Profile } from "@multizen/types";

import { ActivityLog, type ActivityEvent } from "./ActivityLog.js";
import { createPrincipal, type Principal, type ToolGroup } from "./auth/principal.js";
import { MockBrowserDriver } from "./MockBrowserDriver.js";
import { createMultizenMcpServer } from "./server.js";
import { createSharedMcpState, type SharedMcpState } from "./sharedState.js";

/**
 * The gate over the wire, with several real SDK clients on one shared state. The driver
 * is a stand-in that records when its verbs start and end: apps/server has the same
 * checks through the real drivers.
 */

class RecordingDriver extends MockBrowserDriver {
  readonly log: string[] = [];
  /** Verbs wait on this while it is set. */
  barrier: Promise<void> | null = null;
  /** What wait_for_selector's poll reads. */
  selectorPresent = false;
  evaluations = 0;
  launchOptions: Array<LaunchOptions | undefined> = [];

  private async verb(name: string): Promise<void> {
    this.log.push(`${name} start`);
    await this.barrier;
    await new Promise((resolve) => setImmediate(resolve));
    this.log.push(`${name} end`);
  }

  override async click(_id: string, selector: string): Promise<{ ok: true }> {
    await this.verb(`click ${selector}`);
    return { ok: true };
  }

  override async evaluateJs(id: string): Promise<unknown> {
    if (!this.isRunning(id)) throw new MultizenError("PROFILE_NOT_RUNNING", "stopped");
    this.evaluations += 1;
    await this.verb("evaluate");
    return { result: { value: this.selectorPresent } };
  }

  override launch(id: string, opts?: LaunchOptions): Promise<LaunchedProfile> {
    this.launchOptions.push(opts);
    return super.launch(id);
  }
}

function barrier(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const profiles = {
  get: (id: string) => (id === "ghost" ? null : ({ id, dataDir: "unused" } as Profile)),
} as unknown as ProfileManager;

function principal(id: string, groups: ToolGroup[] = ["read", "act", "profile-admin"]): Principal {
  return createPrincipal({ id, name: id, full: false, tools: { groups, names: [] }, profiles: "*" });
}

const CLIENTS: Client[] = [];
after(async () => {
  await Promise.all(CLIENTS.map((c) => c.close().catch(() => {})));
});

interface Session {
  client: Client;
  log: ActivityLog;
}

/** A session of its own, as a transport builds one per connection. */
async function session(
  shared: SharedMcpState,
  driver: MockBrowserDriver,
  sessionId: string,
  who?: Principal,
): Promise<Session> {
  const log = new ActivityLog();
  const { server } = createMultizenMcpServer({
    profileManager: profiles,
    browserDriver: driver,
    shared,
    activityLog: log,
    ...(who ? { principal: who } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = sessionId;
  const client = new Client({ name: sessionId, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  CLIENTS.push(client);
  return { client, log };
}

async function rig(opts: Parameters<typeof createSharedMcpState>[0] = {}): Promise<{
  driver: RecordingDriver;
  shared: SharedMcpState;
}> {
  const driver = new RecordingDriver();
  await driver.launch("p");
  driver.launchOptions = [];
  return { driver, shared: createSharedMcpState(opts) };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: { profile_id: "p", ...args } });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, any> };
}

async function expectCode(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  code: string,
): Promise<Record<string, any>> {
  const { isError, body } = await call(client, name, args);
  assert.equal(isError, true, `${name} should have failed: ${JSON.stringify(body)}`);
  assert.equal(body.error.code, code, JSON.stringify(body.error));
  return body.error;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

// ── the mutex over the wire ──────────────────────────────────────────────────

test("two sessions' calls on one profile run one at a time, across their servers", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  await Promise.all([
    call(a.client, "click", { selector: "#a" }),
    call(b.client, "click", { selector: "#b" }),
  ]);
  assert.deepEqual(driver.log, ["click #a start", "click #a end", "click #b start", "click #b end"]);
});

test("without a shared state, each server would have had its own mutex", async () => {
  const driver = new RecordingDriver();
  await driver.launch("p");
  const gate = barrier();
  driver.barrier = gate.wait;
  const a = await session(createSharedMcpState(), driver, "a");
  const b = await session(createSharedMcpState(), driver, "b");
  const calls = [
    call(a.client, "click", { selector: "#a" }),
    call(b.client, "click", { selector: "#b" }),
  ];
  await settle();
  assert.deepEqual(driver.log, ["click #a start", "click #b start"]);
  gate.open();
  await Promise.all(calls);
});

test("arrival order holds across sessions; a third profile doesn't wait", async () => {
  const { driver, shared } = await rig();
  await driver.launch("other");
  const gate = barrier();
  driver.barrier = gate.wait;
  const sessions = await Promise.all(["a", "b", "c"].map((id) => session(shared, driver, id)));
  const calls = [];
  for (const [i, s] of sessions.entries()) {
    calls.push(call(s.client, "click", { selector: `#${i}` }));
    await settle();
  }
  assert.deepEqual(driver.log, ["click #0 start"]);
  assert.equal(shared.mutex.queued("p"), 2);
  driver.barrier = null;
  await call(sessions[0]!.client, "click", { profile_id: "other", selector: "#x" });
  driver.barrier = gate.wait;
  gate.open();
  await Promise.all(calls);
  assert.deepEqual(
    driver.log.filter((l) => l.endsWith("start")),
    ["click #0 start", "click #x start", "click #1 start", "click #2 start"],
  );
});

test("a queue timeout reaches the client as a retryable TIMEOUT, and the call never fires", async () => {
  const { driver, shared } = await rig({ mutex: { waitMs: 30 } });
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holder = call(a.client, "click", { selector: "#a" });
  await settle();
  const error = await expectCode(b.client, "click", { selector: "#b" }, "TIMEOUT");
  assert.equal(error.retryable, true);
  gate.open();
  await holder;
  assert.ok(!driver.log.includes("click #b start"));
});

test("past the queue depth a call is refused as a retryable TIMEOUT", async () => {
  const { driver, shared } = await rig({ mutex: { queueDepth: 1 } });
  const s = await session(shared, driver, "a");
  const gate = barrier();
  driver.barrier = gate.wait;
  const calls = [call(s.client, "click", { selector: "#1" }), call(s.client, "click", { selector: "#2" })];
  await settle();
  const error = await expectCode(s.client, "click", { selector: "#3" }, "TIMEOUT");
  assert.equal(error.retryable, true);
  assert.equal(error.details.queue_depth, 1);
  gate.open();
  await Promise.all(calls);
});

// ── what doesn't queue ───────────────────────────────────────────────────────

test("wait_* holds the profile per poll, so other calls run between polls", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const waiting = call(a.client, "wait_for_selector", { selector: "#later", timeout_ms: 5_000 });
  while (driver.evaluations < 2) await settle();
  // Not held across the sleep between polls, and the click gets its turn in there.
  await call(b.client, "click", { selector: "#x" });
  const evaluationsAtClick = driver.evaluations;
  driver.selectorPresent = true;
  assert.equal((await waiting).body.found, true);
  assert.ok(driver.evaluations > evaluationsAtClick, "the wait went on polling after the click");
  const lines = driver.log.join("\n");
  assert.ok(!/evaluate start\nclick #x start/.test(lines), "the click cut into a poll");
  assert.ok(!/click #x start\nevaluate start/.test(lines), "a poll cut into the click");
  assert.equal(shared.mutex.isHeld("p"), false);
});

test("wait_* queues each poll: a held profile holds it up, then it goes on", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holder = call(a.client, "click", { selector: "#a" });
  await settle();
  const waiting = call(b.client, "wait_for_load", { timeout_ms: 5_000 });
  await settle();
  assert.equal(driver.evaluations, 0);
  assert.equal(shared.mutex.queued("p"), 1);
  driver.selectorPresent = false;
  gate.open();
  await holder;
  driver.barrier = null;
  while (driver.evaluations === 0) await settle();
  await call(a.client, "close_profile");
  await expectCodeOf(waiting, "PROFILE_NOT_RUNNING");
});

async function expectCodeOf(pending: ReturnType<typeof call>, code: string): Promise<void> {
  const { isError, body } = await pending;
  assert.equal(isError, true, JSON.stringify(body));
  assert.equal(body.error.code, code, JSON.stringify(body.error));
}

test("a poll stops with its client: no further turn on the profile", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  void call(a.client, "wait_for_selector", { selector: "#never", timeout_ms: 5_000 }).catch(() => {});
  while (driver.evaluations < 1) await settle();
  await a.client.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = driver.evaluations;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(driver.evaluations, after);
  assert.equal(shared.mutex.isHeld("p"), false);
});

test("request_human and wait_for_human go past a held profile and hold nothing", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holder = call(a.client, "click", { selector: "#a" });
  await settle();

  const requested = await call(b.client, "request_human", { reason: "solve it" });
  assert.equal(requested.body.status, "waiting_for_human");

  const waitingForHuman = call(b.client, "wait_for_human", { timeout_ms: 5_000 });
  await settle();
  assert.equal(shared.mutex.queued("p"), 0, "wait_for_human doesn't line up");
  shared.handoff.resume("p");
  assert.equal((await waitingForHuman).body.resumed, true);

  gate.open();
  await holder;
  assert.equal(shared.mutex.isHeld("p"), false);
});

test("the tools that answer about a stuck page don't wait for it", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holder = call(a.client, "click", { selector: "#a" });
  await settle();
  for (const tool of ["list_tabs", "list_dialogs", "list_downloads", "get_human_status"]) {
    assert.equal((await call(b.client, tool)).isError, false, tool);
  }
  assert.equal(shared.mutex.queued("p"), 0);
  gate.open();
  await holder;
});

test("launch_profile hands the client's signal to the driver's queue for a browser slot", async () => {
  const { driver, shared } = await rig();
  const s = await session(shared, driver, "a");
  await call(s.client, "launch_profile");
  assert.equal(driver.launchOptions.length, 1);
  assert.ok(driver.launchOptions[0]?.signal instanceof AbortSignal);
});

// ── a client that goes away ──────────────────────────────────────────────────

test("a client that disconnects loses its queued click: it never fires later", async () => {
  const { driver, shared } = await rig();
  const holder = await session(shared, driver, "holder");
  const leaving = await session(shared, driver, "leaving");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holding = call(holder.client, "click", { selector: "#holder" });
  await settle();
  void leaving.client.callTool({ name: "click", arguments: { profile_id: "p", selector: "#gone" } })
    .catch(() => {});
  await settle();
  assert.equal(shared.mutex.queued("p"), 1);

  await leaving.client.close();
  await settle();
  assert.equal(shared.mutex.queued("p"), 0, "dequeued as soon as the session closed");

  gate.open();
  await holding;
  await settle();
  assert.ok(!driver.log.includes("click #gone start"), driver.log.join(", "));
});

test("cancelling a queued call takes it out of line too", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holding = call(a.client, "click", { selector: "#a" });
  await settle();
  const cancel = new AbortController();
  const cancelled = b.client.callTool(
    { name: "click", arguments: { profile_id: "p", selector: "#cancelled" } },
    undefined,
    { signal: cancel.signal },
  );
  await settle();
  assert.equal(shared.mutex.queued("p"), 1);
  cancel.abort();
  await assert.rejects(cancelled);
  await settle();
  assert.equal(shared.mutex.queued("p"), 0);
  gate.open();
  await holding;
  await settle();
  assert.ok(!driver.log.includes("click #cancelled start"));
});

// ── close_profile preempts ───────────────────────────────────────────────────

test("close_profile goes past the queue and tells whoever waited", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a");
  const b = await session(shared, driver, "b");
  const gate = barrier();
  driver.barrier = gate.wait;
  const holding = call(a.client, "click", { selector: "#a" });
  await settle();
  const waiting = call(b.client, "click", { selector: "#b" });
  await settle();

  const closed = await call(a.client, "close_profile");
  assert.equal(closed.isError, false);
  assert.equal(driver.isRunning("p"), false);
  await expectCodeOf(waiting, "PROFILE_NOT_RUNNING");

  gate.open();
  await holding;
  assert.ok(!driver.log.includes("click #b start"));
});

// ── leases over the wire ─────────────────────────────────────────────────────

test("no lease, no change: sessions share a profile as before", async () => {
  const { driver, shared } = await rig();
  const a = await session(shared, driver, "a", principal("alice"));
  const b = await session(shared, driver, "b", principal("bob"));
  assert.equal((await call(a.client, "click", { selector: "#a" })).isError, false);
  assert.equal((await call(b.client, "click", { selector: "#b" })).isError, false);
});

test("a lease blocks what would change the profile for others, and no reads", async () => {
  const { driver, shared } = await rig();
  const alice = await session(shared, driver, "a", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const lease = await call(alice.client, "acquire_profile", { ttl_ms: 60_000 });
  assert.equal(lease.isError, false);
  assert.match(lease.body.lease_id, /^lease_/);
  assert.equal(lease.body.ttl_ms, 60_000);

  const error = await expectCode(bob.client, "click", { selector: "#b" }, "PROFILE_LEASED");
  assert.equal(error.retryable, true);
  assert.equal(error.details.held_by, "alice");
  assert.equal(typeof error.details.expires_at, "string");
  assert.equal(typeof error.details.retry_after_ms, "number");
  assert.ok(!JSON.stringify(error).includes(lease.body.lease_id));
  for (const tool of ["close_profile", "launch_profile", "handle_dialog", "request_human"]) {
    await expectCode(bob.client, tool, { action: "accept", reason: "r" }, "PROFILE_LEASED");
  }
  await expectCode(bob.client, "acquire_profile", {}, "PROFILE_LEASED");

  for (const read of ["extract", "screenshot", "list_tabs", "get_cookies"]) {
    assert.equal((await call(bob.client, read)).isError, false, read);
  }
  assert.ok(!driver.log.includes("click #b start"));
  assert.equal((await call(alice.client, "click", { selector: "#a" })).isError, false);
});

test("a lease taken while a call waited stops that call at its turn", async () => {
  const { driver, shared } = await rig();
  const alice = await session(shared, driver, "a", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const gate = barrier();
  driver.barrier = gate.wait;
  const holding = call(alice.client, "click", { selector: "#a" });
  await settle();
  const queued = call(bob.client, "click", { selector: "#b" });
  await settle();
  await call(alice.client, "acquire_profile");
  gate.open();
  await holding;
  await expectCodeOf(queued, "PROFILE_LEASED");
  assert.ok(!driver.log.includes("click #b start"));
});

test("a reconnect reattaches with lease_id; a session end doesn't drop the lease", async () => {
  const { driver, shared } = await rig();
  const alice = await session(shared, driver, "a1", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const { lease_id: leaseId } = (await call(alice.client, "acquire_profile")).body;

  await alice.client.close();
  await settle();
  await expectCode(bob.client, "click", { selector: "#b" }, "PROFILE_LEASED");

  const back = await session(shared, driver, "a2", principal("alice"));
  await expectCode(back.client, "click", { selector: "#x" }, "PROFILE_LEASED");
  const reattached = await call(back.client, "acquire_profile", { lease_id: leaseId });
  assert.equal(reattached.body.lease_id, leaseId);
  assert.equal((await call(back.client, "click", { selector: "#x" })).isError, false);

  await expectCode(bob.client, "acquire_profile", { lease_id: leaseId }, "LEASE_INVALID");
});

test("TTL expiry lets others in; the old id is then LEASE_INVALID", async () => {
  const clock = { now: 1_000_000 };
  const { driver, shared } = await rig({ now: () => clock.now });
  const alice = await session(shared, driver, "a", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const { lease_id: leaseId } = (await call(alice.client, "acquire_profile", { ttl_ms: 1_000 })).body;
  await expectCode(bob.client, "click", { selector: "#b" }, "PROFILE_LEASED");
  clock.now += 1_000;
  assert.equal((await call(bob.client, "click", { selector: "#b" })).isError, false);
  await expectCode(alice.client, "renew_profile", { lease_id: leaseId }, "LEASE_INVALID");
});

test("renew and release work for the holder, and bad ids don't", async () => {
  const { driver, shared } = await rig();
  const alice = await session(shared, driver, "a", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const { lease_id: leaseId } = (await call(alice.client, "acquire_profile", { ttl_ms: 1_000 })).body;
  const renewed = await call(alice.client, "renew_profile", { lease_id: leaseId, ttl_ms: 90_000 });
  assert.equal(renewed.body.ttl_ms, 90_000);

  await expectCode(alice.client, "renew_profile", { lease_id: "nope" }, "LEASE_INVALID");
  await expectCode(alice.client, "release_profile", { lease_id: "nope" }, "LEASE_INVALID");
  await expectCode(bob.client, "release_profile", { lease_id: leaseId }, "LEASE_INVALID");
  await expectCode(alice.client, "release_profile", {}, "INVALID_INPUT");
  await expectCode(alice.client, "renew_profile", {}, "INVALID_INPUT");

  assert.deepEqual((await call(alice.client, "release_profile", { lease_id: leaseId })).body, {
    released: true,
  });
  assert.equal((await call(bob.client, "click", { selector: "#b" })).isError, false);
});

test("force-release needs the operator group", async () => {
  const { driver, shared } = await rig();
  const alice = await session(shared, driver, "a", principal("alice"));
  const bob = await session(shared, driver, "b", principal("bob"));
  const owner = await session(shared, driver, "o", principal("owner", ["read", "act", "operator"]));
  await call(alice.client, "acquire_profile");

  await expectCode(bob.client, "release_profile", { force: true }, "FORBIDDEN");
  await expectCode(bob.client, "click", { selector: "#b" }, "PROFILE_LEASED");

  assert.deepEqual((await call(owner.client, "release_profile", { force: true })).body, {
    released: true,
  });
  assert.equal((await call(bob.client, "click", { selector: "#b" })).isError, false);
  assert.deepEqual((await call(owner.client, "release_profile", { force: true })).body, {
    released: false,
  });
});

test("lease tools refuse an unknown profile and a malformed call", async () => {
  const { driver, shared } = await rig();
  const s = await session(shared, driver, "a");
  await expectCode(s.client, "acquire_profile", { profile_id: "ghost" }, "PROFILE_NOT_FOUND");
  await expectCode(s.client, "renew_profile", { profile_id: "ghost", lease_id: "l" }, "PROFILE_NOT_FOUND");
  await expectCode(s.client, "release_profile", { profile_id: "ghost", force: true }, "PROFILE_NOT_FOUND");
  await expectCode(s.client, "acquire_profile", { ttl_ms: -5 }, "INVALID_INPUT");
});

test("a lease_id never reaches the activity log, in arguments or results", async () => {
  const { driver, shared } = await rig();
  const s = await session(shared, driver, "a");
  const events: ActivityEvent[] = [];
  s.log.on("event", (e: ActivityEvent) => events.push(e));
  const { lease_id: leaseId } = (await call(s.client, "acquire_profile")).body;
  await call(s.client, "acquire_profile", { lease_id: leaseId });
  await call(s.client, "renew_profile", { lease_id: leaseId });
  await call(s.client, "renew_profile", { lease_id: "bad-secret" });
  await call(s.client, "release_profile", { lease_id: leaseId });
  assert.ok(events.length > 0);
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes(leaseId));
  assert.ok(!logged.includes("bad-secret"));
});
