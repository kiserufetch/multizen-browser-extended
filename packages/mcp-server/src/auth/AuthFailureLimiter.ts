import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Each address costs a map entry, and addresses are what an attacker has plenty of. */
const MAX_TRACKED_ADDRESSES = 4096;

export interface AuthFailureLimiterOptions {
  limit?: number;
  windowMs?: number;
  maxAddresses?: number;
  now?: () => number;
}

interface Bucket {
  failures: number;
  resetsAt: number;
}

/**
 * Failed token attempts per client address, in fixed windows. A token has 256 random
 * bits, so this keeps out the noise and the cost rather than a guess that could work.
 * Memory stays bounded: past the cap, spent windows go first, then the oldest.
 */
export class AuthFailureLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxAddresses: number;
  private readonly now: () => number;

  constructor(opts: AuthFailureLimiterOptions = {}) {
    this.limit = opts.limit ?? AUTH_FAILURE_LIMIT;
    this.windowMs = opts.windowMs ?? AUTH_FAILURE_WINDOW_MS;
    this.maxAddresses = opts.maxAddresses ?? MAX_TRACKED_ADDRESSES;
    this.now = opts.now ?? Date.now;
  }

  /** How long this address must wait, or 0 when it may try. */
  retryAfterMs(address: string): number {
    const bucket = this.buckets.get(address);
    if (!bucket || bucket.failures < this.limit) return 0;
    return Math.max(0, bucket.resetsAt - this.now());
  }

  recordFailure(address: string): void {
    const now = this.now();
    const bucket = this.buckets.get(address);
    if (bucket && bucket.resetsAt > now) {
      bucket.failures += 1;
      return;
    }
    // Delete first: a Map keeps insertion order, which is how the oldest is found.
    this.buckets.delete(address);
    this.buckets.set(address, { failures: 1, resetsAt: now + this.windowMs });
    if (this.buckets.size > this.maxAddresses) this.evict(now);
  }

  get trackedAddresses(): number {
    return this.buckets.size;
  }

  private evict(now: number): void {
    for (const [address, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(address);
    }
    for (const address of this.buckets.keys()) {
      if (this.buckets.size <= this.maxAddresses) return;
      this.buckets.delete(address);
    }
  }
}

function withoutMappedPrefix(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * The address to hold a failure against. `trustProxy` says a proxy we run is in front:
 * it appends the peer it saw to X-Forwarded-For, so the rightmost hop is the only one
 * the client can't forge. Everything left of it came from the client.
 */
export function clientAddress(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const rightmost = header?.split(",").at(-1)?.trim();
    if (rightmost && isIP(rightmost)) return withoutMappedPrefix(rightmost);
  }
  return withoutMappedPrefix(req.socket.remoteAddress ?? "unknown");
}
