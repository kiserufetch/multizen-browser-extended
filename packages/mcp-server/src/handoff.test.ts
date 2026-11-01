import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryHumanHandoff, isSensitiveKind, type HandoffRecord } from "./handoff.js";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a request starts a pending record with its own id, kind and expiry", () => {
  const h = new InMemoryHumanHandoff();
  const before = Date.now();
  const record = h.request("p", "solve it", { kind: "captcha", requestedBy: "agent" });
  assert.equal(record.status, "pending");
  assert.equal(record.kind, "captcha");
  assert.equal(record.requestedBy, "agent");
  assert.equal(h.activeForProfile("p")?.id, record.id);
  assert.equal(h.get(record.id)?.reason, "solve it");
  const ttl = Date.parse(record.expiresAt) - before;
  assert.ok(ttl >= 15 * 60_000 && ttl < 15 * 60_000 + 5_000, `default TTL is 15 min, got ${ttl}`);
  h.abortById(record.id);
});

test("a kind defaults to other, and only 2fa and login are sensitive", () => {
  const h = new InMemoryHumanHandoff();
  assert.equal(h.request("p", "x").kind, "other");
  h.resume("p");
  assert.deepEqual(
    (["captcha", "2fa", "login", "confirm", "other"] as const).filter(isSensitiveKind),
    ["2fa", "login"],
  );
});

test("asking again on a pending profile keeps its id, kind and expiry, and takes the new reason", () => {
  const h = new InMemoryHumanHandoff();
  const first = h.request("p", "one", { kind: "2fa" });
  const second = h.request("p", "two", { kind: "captcha", ttlMs: 99_000_000 });
  assert.equal(second.id, first.id);
  assert.equal(second.kind, "2fa", "an agent can't loosen what it may read");
  assert.equal(second.expiresAt, first.expiresAt, "nor keep the profile from ever coming back");
  assert.equal(h.activeForProfile("p")?.reason, "two");
  assert.equal(h.pending().length, 1);
  h.abortById(first.id);
});

test("an endless reason is cut: it reaches a webhook and a panel", () => {
  const h = new InMemoryHumanHandoff();
  assert.equal(h.request("p", "x".repeat(100_000)).reason.length, 2_000);
  h.resume("p");
});

test("the end of a handoff is recorded with who did it, and only the first end counts", () => {
  const h = new InMemoryHumanHandoff();
  const { id } = h.request("p", "x");
  assert.equal(h.resumeById(id, "alice"), true);
  assert.equal(h.resumeById(id, "bob"), false);
  assert.equal(h.abortById(id, "bob"), false);
  const ended = h.get(id)!;
  assert.equal(ended.status, "resumed");
  assert.equal(ended.settledBy, "alice");
  assert.equal(typeof ended.settledAt, "string");
  assert.equal(h.isPending("p"), false);
});

test("a TTL runs out on its own, and the record says expired", async () => {
  const h = new InMemoryHumanHandoff({ defaultTtlMs: 20 });
  const { id } = h.request("p", "x");
  await wait(60);
  assert.equal(h.get(id)?.status, "expired");
  assert.equal(h.isPending("p"), false);
  assert.deepEqual(h.pending(), []);
});

test("closeForProfile aborts what was pending, and does nothing to a profile with none", () => {
  const h = new InMemoryHumanHandoff();
  const { id } = h.request("p", "x");
  h.closeForProfile("p", "browser exited");
  assert.equal(h.get(id)?.status, "aborted");
  assert.equal(h.get(id)?.settledBy, "browser exited");
  h.closeForProfile("p", "again");
  assert.equal(h.get(id)?.settledBy, "browser exited");
});

test("a new request after an end gets a new id, and the old one stays readable", () => {
  const h = new InMemoryHumanHandoff();
  const first = h.request("p", "x");
  h.abortById(first.id);
  const second = h.request("p", "y");
  assert.notEqual(second.id, first.id);
  assert.equal(h.latestForProfile("p")?.id, second.id);
  assert.equal(h.get(first.id)?.status, "aborted");
  h.resumeById(second.id);
  assert.equal(h.latestForProfile("p")?.status, "resumed");
});

test("waitForId wakes on the end, and gives the record as it stands when the time runs out", async () => {
  const h = new InMemoryHumanHandoff();
  const { id } = h.request("p", "x");
  assert.equal((await h.waitForId(id, 10))?.status, "pending");
  const waiting = h.waitForId(id, 5_000);
  h.abortById(id, "alice");
  const ended = await waiting;
  assert.equal(ended?.status, "aborted");
  assert.equal(ended?.settledBy, "alice");
  // Already over: at once.
  assert.equal((await h.waitForId(id, 5_000))?.status, "aborted");
  assert.equal(await h.waitForId("nobody", 10), null);
});

test("the old waitFor says resumed only for a resume", async () => {
  const h = new InMemoryHumanHandoff();
  const { id } = h.request("p", "x");
  const waiting = h.waitFor("p", 5_000);
  h.abortById(id);
  assert.deepEqual(await waiting, { resumed: false });

  const h2 = new InMemoryHumanHandoff({ defaultTtlMs: 10 });
  h2.request("p", "x");
  assert.deepEqual(await h2.waitFor("p", 5_000), { resumed: false });
});

test("finished handoffs are kept up to the cap, oldest gone first", () => {
  const h = new InMemoryHumanHandoff();
  const first = h.request("p", "x");
  h.resumeById(first.id);
  const second = h.request("p", "x");
  h.resumeById(second.id);
  for (let i = 0; i < 499; i++) h.resumeById(h.request("p", "x").id);
  assert.equal(h.get(first.id), null, "the 501st end pushes the oldest out");
  assert.equal(h.get(second.id)?.status, "resumed");
});

test("a finished handoff is forgotten after an hour", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = new InMemoryHumanHandoff();
  const { id } = h.request("p", "x");
  h.resumeById(id);
  t.mock.timers.tick(59 * 60_000);
  assert.equal(h.get(id)?.status, "resumed");
  t.mock.timers.tick(2 * 60_000);
  assert.equal(h.get(id), null);
  assert.equal(h.latestForProfile("p"), null);
});

test("onTransition reports each start and end once; onChange follows the pending set", () => {
  const h = new InMemoryHumanHandoff();
  const seen: HandoffRecord["status"][] = [];
  const sizes: number[] = [];
  h.onTransition((r) => seen.push(r.status));
  h.onChange((p) => sizes.push(p.length));
  const { id } = h.request("p", "x");
  h.request("p", "again");
  h.resumeById(id);
  h.resumeById(id);
  assert.deepEqual(seen, ["pending", "resumed"]);
  assert.deepEqual(sizes, [1, 1, 0]);
});

test("a waiter is awake before a transition listener runs, so it can't overtake one", async () => {
  const h = new InMemoryHumanHandoff();
  const order: string[] = [];
  const { id } = h.request("p", "x");
  void h.waitForId(id, 5_000).then(() => order.push("waiter continued"));
  h.onTransition(() => order.push("listener"));
  h.resumeById(id);
  await wait(0);
  assert.deepEqual(order, ["listener", "waiter continued"]);
});
