import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { AuthFailureLimiter, clientAddress } from "./AuthFailureLimiter.js";

function request(remoteAddress: string | undefined, forwarded?: string): IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  } as unknown as IncomingMessage;
}

test("ten failures a minute by default, then a wait until the window ends", () => {
  let now = 1_000;
  const limiter = new AuthFailureLimiter({ now: () => now });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.retryAfterMs("a"), 0, `attempt ${i}`);
    limiter.recordFailure("a");
  }
  assert.equal(limiter.retryAfterMs("a"), 60_000);
  assert.equal(limiter.retryAfterMs("b"), 0, "per address");

  now += 59_000;
  assert.equal(limiter.retryAfterMs("a"), 1_000);
  now += 1_000;
  assert.equal(limiter.retryAfterMs("a"), 0);
  limiter.recordFailure("a");
  assert.equal(limiter.retryAfterMs("a"), 0, "a new window");
});

test("memory stays bounded: spent windows go first, then the oldest", () => {
  let now = 0;
  const limiter = new AuthFailureLimiter({ limit: 1, windowMs: 100, maxAddresses: 3, now: () => now });
  limiter.recordFailure("spent");
  now = 50;
  limiter.recordFailure("older");
  limiter.recordFailure("newer");
  now = 120;
  limiter.recordFailure("fourth");
  assert.equal(limiter.trackedAddresses, 3);
  assert.equal(limiter.retryAfterMs("spent"), 0);
  assert.ok(limiter.retryAfterMs("older") > 0, "not evicted while a spent one could go");

  limiter.recordFailure("fifth");
  assert.equal(limiter.trackedAddresses, 3);
  assert.equal(limiter.retryAfterMs("older"), 0, "the oldest goes when none are spent");
  assert.ok(limiter.retryAfterMs("fifth") > 0);

  for (let i = 0; i < 10_000; i++) limiter.recordFailure(`flood-${i}`);
  assert.equal(limiter.trackedAddresses, 3);
});

test("the client's address: the socket's, unless a proxy of ours says otherwise", () => {
  assert.equal(clientAddress(request("192.0.2.1")), "192.0.2.1");
  assert.equal(clientAddress(request("::ffff:192.0.2.1")), "192.0.2.1", "one bucket per v4 client");
  assert.equal(clientAddress(request("2001:db8::1")), "2001:db8::1");
  assert.equal(clientAddress(request(undefined)), "unknown");
  assert.equal(clientAddress(request("192.0.2.1", "203.0.113.5")), "192.0.2.1", "not trusted by default");

  const viaProxy = (forwarded?: string): string => clientAddress(request("127.0.0.1", forwarded), true);
  assert.equal(viaProxy("203.0.113.5"), "203.0.113.5");
  assert.equal(viaProxy("198.51.100.1, 203.0.113.5"), "203.0.113.5", "the proxy's own hop is the last");
  assert.equal(viaProxy("198.51.100.1,203.0.113.5 "), "203.0.113.5");
  assert.equal(viaProxy("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(viaProxy("2001:db8::2"), "2001:db8::2");
  assert.equal(viaProxy(), "127.0.0.1");
  assert.equal(viaProxy(""), "127.0.0.1");
  assert.equal(viaProxy("garbage"), "127.0.0.1");
  assert.equal(viaProxy("203.0.113.5, garbage"), "127.0.0.1", "a bad last hop isn't skipped over");
});
