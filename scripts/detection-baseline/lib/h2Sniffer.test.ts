import { test } from "node:test";
import assert from "node:assert/strict";
import { H2Sniffer, pseudoHeaderOrder } from "./h2Sniffer.ts";

const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");

function frame(type: number, flags: number, streamId: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(9);
  head.writeUIntBE(payload.length, 0, 3);
  head.writeUInt8(type, 3);
  head.writeUInt8(flags, 4);
  head.writeUInt32BE(streamId, 5);
  return Buffer.concat([head, payload]);
}

function settings(pairs: Array<[number, number]>): Buffer {
  const body = Buffer.alloc(pairs.length * 6);
  pairs.forEach(([id, value], i) => {
    body.writeUInt16BE(id, i * 6);
    body.writeUInt32BE(value, i * 6 + 2);
  });
  return frame(0x4, 0, 0, body);
}

function windowUpdate(streamId: number, increment: number): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(increment);
  return frame(0x8, 0, streamId, body);
}

/**
 * What Chrome sends for a first GET, in the bytes a captured connection has:
 * 0x82 `:method GET` indexed, 0x41 + literal `:authority` with its name indexed,
 * 0x87 `:scheme https` indexed, 0x84 `:path /` indexed, then literal regular headers.
 */
const CHROME_BLOCK = Buffer.concat([
  Buffer.from([0x82, 0x41, 0x8a]),
  Buffer.from("0123456789"),
  Buffer.from([0x87, 0x84]),
  // sec-ch-ua, a literal name with incremental indexing.
  Buffer.from([0x40, 0x09]),
  Buffer.from("sec-ch-ua"),
  Buffer.from([0x03]),
  Buffer.from("abc"),
]);

/** Firefox: method, then path as a literal with its name indexed, authority, scheme. */
const FIREFOX_BLOCK = Buffer.concat([
  Buffer.from([0x82, 0x04, 0x01]),
  Buffer.from("/"),
  Buffer.from([0x41, 0x04]),
  Buffer.from("a.io"),
  Buffer.from([0x87]),
  Buffer.from([0x53, 0x02]),
  Buffer.from("zz"),
]);

const CHROME_SETTINGS: Array<[number, number]> = [
  [1, 65536],
  [2, 0],
  [4, 6291456],
  [6, 262144],
];

function headersPayload(block: Buffer, priority?: { exclusive: boolean; dependsOn: number; weight: number }): Buffer {
  if (!priority) return block;
  const head = Buffer.alloc(5);
  head.writeUInt32BE((priority.exclusive ? 0x80000000 : 0) + priority.dependsOn);
  head.writeUInt8(priority.weight - 1, 4);
  return Buffer.concat([head, block]);
}

const CHROME_CONNECTION = Buffer.concat([
  PREFACE,
  settings(CHROME_SETTINGS),
  windowUpdate(0, 15663105),
  frame(
    0x1,
    0x1 | 0x4 | 0x20,
    1,
    headersPayload(CHROME_BLOCK, { exclusive: true, dependsOn: 0, weight: 256 }),
  ),
]);

test("a first connection in Chrome's shape reads as its Akamai fingerprint", () => {
  const sniffer = new H2Sniffer();
  sniffer.push(CHROME_CONNECTION);
  const r = sniffer.result();
  assert.equal(r.preface, true);
  assert.deepEqual(r.settings, CHROME_SETTINGS);
  assert.equal(r.windowUpdate, 15663105);
  assert.deepEqual(r.firstHeaders?.pseudoOrder, [":method", ":authority", ":scheme", ":path"]);
  assert.deepEqual(r.firstHeaders?.priority, { dependsOn: 0, exclusive: true, weight: 256 });
  assert.equal(r.firstHeaders?.endStream, true);
  assert.equal(r.akamai, "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p");
  assert.deepEqual(r.frameOrder, ["SETTINGS", "WINDOW_UPDATE", "HEADERS"]);
});

test("the same bytes in any split give the same result", () => {
  const whole = new H2Sniffer();
  whole.push(CHROME_CONNECTION);
  for (const size of [1, 3, 7, 24, 25, 33]) {
    const sniffer = new H2Sniffer();
    for (let at = 0; at < CHROME_CONNECTION.length; at += size) {
      sniffer.push(CHROME_CONNECTION.subarray(at, at + size));
    }
    assert.deepEqual(sniffer.result(), whole.result(), `chunks of ${size}`);
  }
});

test("Firefox's order and its PRIORITY frames are kept", () => {
  const priority = Buffer.alloc(5);
  priority.writeUInt32BE(0);
  priority.writeUInt8(200, 4);
  const sniffer = new H2Sniffer();
  sniffer.push(
    Buffer.concat([
      PREFACE,
      settings([
        [1, 65536],
        [4, 131072],
        [5, 16384],
      ]),
      windowUpdate(0, 12517377),
      frame(0x2, 0, 3, priority),
      frame(0x1, 0x4, 15, FIREFOX_BLOCK),
    ]),
  );
  const r = sniffer.result();
  assert.deepEqual(r.priorityFrames, [{ streamId: 3, dependsOn: 0, exclusive: false, weight: 201 }]);
  assert.deepEqual(r.firstHeaders?.pseudoOrder, [":method", ":path", ":authority", ":scheme"]);
  assert.equal(r.firstHeaders?.priority, null);
  assert.equal(r.akamai, "1:65536;4:131072;5:16384|12517377|3:0:0:201|m,p,a,s");
});

test("only what the client said first counts: an ACK, a later SETTINGS, a stream's own window", () => {
  const sniffer = new H2Sniffer();
  sniffer.push(
    Buffer.concat([
      PREFACE,
      windowUpdate(1, 999),
      frame(0x4, 0x1, 0, Buffer.alloc(0)),
      settings([[3, 100]]),
      settings([[3, 200]]),
      windowUpdate(0, 7),
      windowUpdate(0, 8),
    ]),
  );
  const r = sniffer.result();
  assert.deepEqual(r.settings, [[3, 100]]);
  assert.equal(r.windowUpdate, 7);
  assert.deepEqual(r.frameOrder, [
    "WINDOW_UPDATE",
    "SETTINGS_ACK",
    "SETTINGS",
    "SETTINGS",
    "WINDOW_UPDATE",
    "WINDOW_UPDATE",
  ]);
});

test("padding and a second request don't disturb the first one's order", () => {
  const padded = Buffer.concat([Buffer.from([4]), CHROME_BLOCK, Buffer.alloc(4)]);
  const sniffer = new H2Sniffer();
  sniffer.push(
    Buffer.concat([
      PREFACE,
      frame(0x1, 0x8, 1, padded),
      frame(0x1, 0x4, 3, FIREFOX_BLOCK),
    ]),
  );
  const r = sniffer.result();
  assert.equal(r.firstHeaders?.streamId, 1);
  assert.deepEqual(r.firstHeaders?.pseudoOrder, [":method", ":authority", ":scheme", ":path"]);
});

test("what isn't HTTP/2 is left alone, not misread", () => {
  const sniffer = new H2Sniffer();
  sniffer.push(Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
  const r = sniffer.result();
  assert.equal(r.preface, false);
  assert.deepEqual(r.settings, []);
  assert.equal(r.firstHeaders, null);
  assert.equal(r.akamai, "|00|0|");
});

test("pseudoHeaderOrder reads long integers and a table size update, and survives truncation", () => {
  // A size update first, as Firefox can send, then :method GET.
  assert.deepEqual(pseudoHeaderOrder(Buffer.from([0x3f, 0xe1, 0x1f, 0x82])), [":method"]);
  // A literal value longer than 126 bytes takes a two-byte length.
  const long = Buffer.concat([Buffer.from([0x41, 0x7f, 0x01]), Buffer.alloc(128, 0x61), Buffer.from([0x82])]);
  assert.deepEqual(pseudoHeaderOrder(long), [":authority", ":method"]);
  assert.deepEqual(pseudoHeaderOrder(Buffer.from([0x82, 0x7f])), [":method"]);
  assert.deepEqual(pseudoHeaderOrder(Buffer.alloc(0)), []);
});
