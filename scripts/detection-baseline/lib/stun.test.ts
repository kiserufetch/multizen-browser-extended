import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { bindingResponse, parseBindingRequest, startStunResponder } from "./stun.ts";

const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const ID = Buffer.from("0123456789ab", "latin1");
const REQUEST = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), COOKIE, ID]);

test("a binding request gives its transaction id, and nothing else does", () => {
  assert.deepEqual(parseBindingRequest(REQUEST), ID);
  assert.equal(parseBindingRequest(REQUEST.subarray(0, 10)), null);
  assert.equal(parseBindingRequest(Buffer.concat([Buffer.from([0x01, 0x01, 0, 0]), COOKIE, ID])), null);
  assert.equal(parseBindingRequest(Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(4), ID])), null);
});

test("the answer XORs the sender's address with the cookie, as RFC 8489's example does", () => {
  // RFC 5769 section 2.2: 192.0.2.1 port 32853 encodes to a1 47 e1 12 a6 43.
  const response = bindingResponse(ID, "192.0.2.1", 32853);
  assert.equal(response.readUInt16BE(0), 0x0101);
  assert.equal(response.readUInt16BE(2), 12);
  assert.deepEqual(response.subarray(8, 20), ID);
  assert.equal(response.readUInt16BE(20), 0x0020);
  assert.equal(response.subarray(26, 32).toString("hex"), "a147e112a643");
});

test("the responder answers a real datagram and counts it", async () => {
  const stun = await startStunResponder();
  const client = createSocket("udp4");
  try {
    const answer = new Promise<Buffer>((resolve) => client.once("message", (m) => resolve(m)));
    client.send(Buffer.from("not stun"), stun.port, "127.0.0.1");
    client.send(REQUEST, stun.port, "127.0.0.1");
    const response = await answer;
    assert.equal(response.readUInt16BE(0), 0x0101);
    assert.equal(stun.requests(), 1);
  } finally {
    client.close();
    await stun.close();
  }
});
