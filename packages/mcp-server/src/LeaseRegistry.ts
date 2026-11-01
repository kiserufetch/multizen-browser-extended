import { randomUUID, timingSafeEqual } from "node:crypto";
import { MultizenError, type ProfileId } from "@multizen/types";

export const LEASE_TTL_DEFAULT_MS = 5 * 60_000;
export const LEASE_TTL_MAX_MS = 60 * 60_000;

/** Who holds or asks for a lease: a token and one MCP session of it. */
export interface LeaseHolder {
  principalId: string;
  /** For the others' error message. */
  principalName: string;
  sessionId: string;
}

export interface LeaseGrant {
  leaseId: string;
  profileId: ProfileId;
  expiresAt: string;
  ttlMs: number;
}

interface Lease {
  id: string;
  holder: LeaseHolder;
  expiresAt: number;
}

function sameId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function invalidLease(profileId: ProfileId): MultizenError {
  return new MultizenError(
    "LEASE_INVALID",
    `That lease_id is not a current lease on profile ${profileId}. It may have expired.`,
    { hint: "Call acquire_profile without a lease_id for a new lease." },
  );
}

/**
 * Exclusive claims on profiles, on top of the mutex: the mutex keeps two calls from
 * interleaving, a lease keeps a sequence of them from being interleaved by anyone else.
 * Optional, so a profile with no lease works as if this weren't here.
 *
 * A lease runs on its TTL alone. A session's end doesn't drop it, because a client
 * coming back after a dropped connection reattaches with the id; nor does a human
 * handoff pause it, so renewing stays possible during one. Expired entries go when next
 * looked at, so no timer outlives the process's interest in them.
 */
export class LeaseRegistry {
  private readonly leases = new Map<ProfileId, Lease>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private active(profileId: ProfileId): Lease | undefined {
    const lease = this.leases.get(profileId);
    if (lease && lease.expiresAt <= this.now()) {
      this.leases.delete(profileId);
      return undefined;
    }
    return lease;
  }

  private static holdsIt(lease: Lease, who: LeaseHolder): boolean {
    return lease.holder.principalId === who.principalId && lease.holder.sessionId === who.sessionId;
  }

  private leased(profileId: ProfileId, lease: Lease): MultizenError {
    const remaining = lease.expiresAt - this.now();
    return new MultizenError(
      "PROFILE_LEASED",
      `Profile ${profileId} is leased by ${lease.holder.principalName} until ${new Date(lease.expiresAt).toISOString()}.`,
      {
        hint: "Reads still work. If this lease is yours from before a reconnect, call acquire_profile with its lease_id.",
        details: {
          held_by: lease.holder.principalName,
          expires_at: new Date(lease.expiresAt).toISOString(),
          retry_after_ms: remaining,
        },
      },
    );
  }

  private grant(profileId: ProfileId, lease: Lease, ttlMs: number | undefined): LeaseGrant {
    const effective = Math.min(ttlMs ?? LEASE_TTL_DEFAULT_MS, LEASE_TTL_MAX_MS);
    lease.expiresAt = this.now() + effective;
    return {
      leaseId: lease.id,
      profileId,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      ttlMs: effective,
    };
  }

  /** The lease this id names, for this principal. Its session may be a newer one. */
  private owned(profileId: ProfileId, who: LeaseHolder, leaseId: string): Lease {
    const lease = this.active(profileId);
    if (!lease || lease.holder.principalId !== who.principalId || !sameId(lease.id, leaseId)) {
      throw invalidLease(profileId);
    }
    return lease;
  }

  /** With `leaseId`: reattach, from a new session of the same principal. Again: extends it. */
  acquire(
    profileId: ProfileId,
    who: LeaseHolder,
    opts: { ttlMs?: number; leaseId?: string } = {},
  ): LeaseGrant {
    if (opts.leaseId !== undefined) {
      const lease = this.owned(profileId, who, opts.leaseId);
      lease.holder = who;
      return this.grant(profileId, lease, opts.ttlMs);
    }
    let lease = this.active(profileId);
    if (lease && !LeaseRegistry.holdsIt(lease, who)) throw this.leased(profileId, lease);
    if (!lease) {
      lease = { id: `lease_${randomUUID()}`, holder: who, expiresAt: 0 };
      this.leases.set(profileId, lease);
    }
    return this.grant(profileId, lease, opts.ttlMs);
  }

  renew(profileId: ProfileId, who: LeaseHolder, leaseId: string, ttlMs?: number): LeaseGrant {
    const lease = this.owned(profileId, who, leaseId);
    lease.holder = who;
    return this.grant(profileId, lease, ttlMs);
  }

  release(profileId: ProfileId, who: LeaseHolder, leaseId: string): void {
    this.owned(profileId, who, leaseId);
    this.leases.delete(profileId);
  }

  /** The operator's way out of a lease nobody will release. False when there was none. */
  forceRelease(profileId: ProfileId): boolean {
    const held = this.active(profileId) !== undefined;
    this.leases.delete(profileId);
    return held;
  }

  /** For a call that would change the profile. */
  assertAccess(profileId: ProfileId, who: LeaseHolder): void {
    const lease = this.active(profileId);
    if (lease && !LeaseRegistry.holdsIt(lease, who)) throw this.leased(profileId, lease);
  }
}
