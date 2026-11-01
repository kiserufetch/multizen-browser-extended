import { createSocket, type Socket } from "node:dgram";

const HEADER_LENGTH = 20;
const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_RESPONSE = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const FAMILY_IPV4 = 0x01;

/** The transaction id of a STUN binding request. Null for anything else. */
export function parseBindingRequest(packet: Buffer): Buffer | null {
  if (packet.length < HEADER_LENGTH) return null;
  if (packet.readUInt16BE(0) !== BINDING_REQUEST) return null;
  if (packet.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  return packet.subarray(8, HEADER_LENGTH);
}

/** RFC 8489's answer: where the request came from, XORed with the cookie. IPv4 only. */
export function bindingResponse(transactionId: Buffer, address: string, port: number): Buffer {
  const octets = address.split(".").map(Number);
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt8(FAMILY_IPV4, 5);
  attribute.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 6);
  const packed = (octets[0]! * 2 ** 24 + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
  attribute.writeUInt32BE((packed ^ MAGIC_COOKIE) >>> 0, 8);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(BINDING_RESPONSE, 0);
  header.writeUInt16BE(attribute.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  return Buffer.concat([header, transactionId, attribute]);
}

export interface StunResponder {
  port: number;
  /** Binding requests seen so far. */
  requests(): number;
  close(): Promise<void>;
}

/** Answers on every local address, for a page's RTCPeerConnection to find. */
export async function startStunResponder(): Promise<StunResponder> {
  const socket: Socket = createSocket("udp4");
  let requests = 0;
  socket.on("message", (packet, from) => {
    const transactionId = parseBindingRequest(packet);
    if (!transactionId) return;
    requests += 1;
    socket.send(bindingResponse(transactionId, from.address, from.port), from.port, from.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return {
    port: socket.address().port,
    requests: () => requests,
    close: () => new Promise((resolve) => socket.close(() => resolve())),
  };
}
