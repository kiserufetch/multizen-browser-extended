import { test } from "node:test";
import assert from "node:assert/strict";
import { MultizenError } from "@multizen/types";
import {
  LEASE_TTL_DEFAULT_MS,
  LEASE_TTL_MAX_MS,
  LeaseRegistry,
  type LeaseHolder,
} from "./LeaseRegistry.js";

const ALICE_1: LeaseHolder = { principalId: "t_a", principalName: "alice", sessionId: "s1" };
const ALICE_2: LeaseHolder = { ...ALICE_1, sessionId: "s2" };
const BOB: LeaseHolder = { principalId: "t_b", principalName: "bob", sessionId: "s9" };

function rig(): { leases: LeaseRegistry; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  return { leases: new LeaseRegistry({ now: () => clock.now }), clock };
}

function hasCode(code: string) {
  return (e: unknown): boolean => {
    assert.ok(e instanceof MultizenError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  };
}

test("the TTL defaults to 5 minutes and stops at 1 hour", () => {
  const { leases } = rig();
  assert.equal(LEASE_TTL_DEFAULT_MS, 300_000);
  assert.equal(LEASE_TTL_MAX_MS, 3_600_000);
  assert.equal(leases.acquire("p", ALICE_1).ttlMs, 300_000);
  assert.equal(leases.acquire("q", ALICE_1, { ttlMs: 10 * 3_600_000 }).ttlMs, 3_600_000);
  assert.equal(leases.acquire("r", ALICE_1, { ttlMs: 1_000 }).ttlMs, 1_000);
});

test("no lease means no change", () => {
  const { leases } = rig();
  leases.assertAccess("p", ALICE_1);
  leases.assertAccess("p", BOB);
});

test("the holder gets through; another session and another principal don't", () => {
  const { leases, clock } = rig();
  const grant = leases.acquire("p", ALICE_1, { ttlMs: 60_000 });
  assert.match(grant.leaseId, /^lease_/);
  assert.equal(grant.expiresAt, new Date(clock.now + 60_000).toISOString());
  leases.assertAccess("p", ALICE_1);
  leases.assertAccess("q", BOB);
  for (const other of [ALICE_2, BOB]) {
    assert.throws(() => leases.assertAccess("p", other), hasCode("PROFILE_LEASED"));
    assert.throws(() => leases.acquire("p", other), hasCode("PROFILE_LEASED"));
  }
});

test("PROFILE_LEASED is retryable, says who and until when, and never shows the id", () => {
  const { leases, clock } = rig();
  const grant = leases.acquire("p", ALICE_1, { ttlMs: 60_000 });
  clock.now += 10_000;
  assert.throws(
    () => leases.assertAccess("p", BOB),
    (e: MultizenError) => {
      assert.equal(e.retryable, true);
      assert.equal(e.details?.held_by, "alice");
      assert.equal(e.details?.retry_after_ms, 50_000);
      assert.equal(e.details?.expires_at, new Date(clock.now + 50_000).toISOString());
      assert.ok(!JSON.stringify({ m: e.message, d: e.details, h: e.hint }).includes(grant.leaseId));
      return true;
    },
  );
});

test("acquiring again as the holder keeps the lease and extends it", () => {
  const { leases, clock } = rig();
  const first = leases.acquire("p", ALICE_1, { ttlMs: 1_000 });
  clock.now += 500;
  const again = leases.acquire("p", ALICE_1, { ttlMs: 1_000 });
  assert.equal(again.leaseId, first.leaseId);
  clock.now += 900;
  leases.assertAccess("p", ALICE_1);
  assert.throws(() => leases.assertAccess("p", BOB), hasCode("PROFILE_LEASED"));
});

test("a reconnect reattaches with the id: the new session holds it, the old one no longer", () => {
  const { leases } = rig();
  const { leaseId } = leases.acquire("p", ALICE_1);
  assert.equal(leases.acquire("p", ALICE_2, { leaseId }).leaseId, leaseId);
  leases.assertAccess("p", ALICE_2);
  assert.throws(() => leases.assertAccess("p", ALICE_1), hasCode("PROFILE_LEASED"));
});

test("a lease is bound to its principal: the id alone gets nobody else in", () => {
  const { leases } = rig();
  const { leaseId } = leases.acquire("p", ALICE_1);
  assert.throws(() => leases.acquire("p", BOB, { leaseId }), hasCode("LEASE_INVALID"));
  assert.throws(() => leases.renew("p", BOB, leaseId), hasCode("LEASE_INVALID"));
  assert.throws(() => leases.release("p", BOB, leaseId), hasCode("LEASE_INVALID"));
  leases.assertAccess("p", ALICE_1);
});

test("a bad id is LEASE_INVALID, with or without a lease on the profile", () => {
  const { leases } = rig();
  assert.throws(() => leases.acquire("p", ALICE_1, { leaseId: "nope" }), hasCode("LEASE_INVALID"));
  assert.throws(() => leases.renew("p", ALICE_1, "nope"), hasCode("LEASE_INVALID"));
  assert.throws(() => leases.release("p", ALICE_1, "nope"), hasCode("LEASE_INVALID"));
  const { leaseId } = leases.acquire("p", ALICE_1);
  assert.throws(() => leases.renew("p", ALICE_1, "nope"), hasCode("LEASE_INVALID"));
  // The id of one profile says nothing about another.
  assert.throws(() => leases.renew("q", ALICE_1, leaseId), hasCode("LEASE_INVALID"));
});

test("at its TTL a lease is gone for everyone, its id included", () => {
  const { leases, clock } = rig();
  const { leaseId } = leases.acquire("p", ALICE_1, { ttlMs: 1_000 });
  clock.now += 999;
  assert.throws(() => leases.assertAccess("p", BOB), hasCode("PROFILE_LEASED"));
  clock.now += 1;
  leases.assertAccess("p", BOB);
  assert.throws(() => leases.renew("p", ALICE_1, leaseId), hasCode("LEASE_INVALID"));
  assert.throws(() => leases.acquire("p", ALICE_1, { leaseId }), hasCode("LEASE_INVALID"));
  assert.notEqual(leases.acquire("p", BOB).leaseId, leaseId);
});

test("renewing extends from now, and a session end isn't something a lease hears about", () => {
  const { leases, clock } = rig();
  const { leaseId } = leases.acquire("p", ALICE_1, { ttlMs: 1_000 });
  clock.now += 900;
  const renewed = leases.renew("p", ALICE_1, leaseId, 5_000);
  assert.equal(renewed.expiresAt, new Date(clock.now + 5_000).toISOString());
  clock.now += 4_000;
  assert.throws(() => leases.assertAccess("p", BOB), hasCode("PROFILE_LEASED"));
});

test("release ends it; force ends it whoever holds it and says if there was one", () => {
  const { leases } = rig();
  const { leaseId } = leases.acquire("p", ALICE_1);
  leases.release("p", ALICE_1, leaseId);
  leases.assertAccess("p", BOB);
  assert.throws(() => leases.release("p", ALICE_1, leaseId), hasCode("LEASE_INVALID"));

  leases.acquire("p", ALICE_1);
  assert.equal(leases.forceRelease("p"), true);
  leases.assertAccess("p", BOB);
  assert.equal(leases.forceRelease("p"), false);
});

test("a token that ended loses its leases, and only its leases", () => {
  const registry = new LeaseRegistry();
  const revoked = { principalId: "revoked", principalName: "revoked", sessionId: "s1" };
  const kept = { principalId: "kept", principalName: "kept", sessionId: "s2" };
  registry.acquire("p1", revoked);
  registry.acquire("p2", revoked);
  registry.acquire("p3", kept);

  registry.dropPrincipal("revoked");

  assert.doesNotThrow(() => registry.assertAccess("p1", kept));
  assert.doesNotThrow(() => registry.assertAccess("p2", kept));
  assert.throws(() => registry.assertAccess("p3", revoked), /leased by kept/);
});
