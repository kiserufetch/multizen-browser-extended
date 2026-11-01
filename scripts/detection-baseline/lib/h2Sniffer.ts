const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");
const FRAME_HEADER_LENGTH = 9;

const FRAME_NAMES: Readonly<Record<number, string>> = {
  0x0: "DATA",
  0x1: "HEADERS",
  0x2: "PRIORITY",
  0x3: "RST_STREAM",
  0x4: "SETTINGS",
  0x5: "PUSH_PROMISE",
  0x6: "PING",
  0x7: "GOAWAY",
  0x8: "WINDOW_UPDATE",
  0x9: "CONTINUATION",
};

const FLAG_ACK = 0x1;
const FLAG_END_STREAM = 0x1;
const FLAG_PADDED = 0x8;
const FLAG_PRIORITY = 0x20;

/** RFC 7541's static table, as far as pseudo-headers go: every browser indexes those by name. */
const STATIC_PSEUDO: Readonly<Record<number, string>> = {
  1: ":authority",
  2: ":method",
  3: ":method",
  4: ":path",
  5: ":path",
  6: ":scheme",
  7: ":scheme",
  8: ":status",
  9: ":status",
  10: ":status",
  11: ":status",
  12: ":status",
  13: ":status",
  14: ":status",
};

export interface H2Priority {
  streamId?: number;
  dependsOn: number;
  /** As a browser means it: 1 to 256. */
  weight: number;
  exclusive: boolean;
}

export interface H2Fingerprint {
  preface: boolean;
  /** The first SETTINGS frame's `[id, value]` pairs, in the browser's order. */
  settings: Array<[number, number]>;
  /** The first WINDOW_UPDATE on the connection itself. */
  windowUpdate: number | null;
  priorityFrames: H2Priority[];
  /** Up to the first request and a little past it. */
  frameOrder: string[];
  firstHeaders: {
    streamId: number;
    endStream: boolean;
    priority: H2Priority | null;
    pseudoOrder: string[];
  } | null;
  /** Akamai's form: `SETTINGS|WINDOW_UPDATE|PRIORITY frames|pseudo-header order`. */
  akamai: string;
}

const MAX_FRAME_ORDER = 16;

/**
 * Pseudo-headers come first in a header block, and all browsers index their names in
 * the static table, so this reads integers and skips values with no dynamic table or
 * Huffman decoder. It stops at the first name it can't place, which by then is a
 * regular header.
 */
export function pseudoHeaderOrder(block: Buffer): string[] {
  let at = 0;
  const readInt = (prefixBits: number): number => {
    const mask = (1 << prefixBits) - 1;
    let value = block[at++]! & mask;
    if (value < mask) return value;
    let shift = 0;
    for (;;) {
      const byte = block[at++];
      if (byte === undefined) throw new Error("truncated HPACK integer");
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const skipString = (): void => {
    const length = readInt(7);
    at += length;
  };

  const order: string[] = [];
  try {
    while (at < block.length) {
      const byte = block[at]!;
      let index: number;
      if (byte & 0x80) {
        index = readInt(7);
      } else if (byte & 0x40) {
        index = readInt(6);
      } else if (byte & 0x20) {
        readInt(5); // dynamic table size update
        continue;
      } else {
        index = readInt(4);
      }
      const name = STATIC_PSEUDO[index];
      if (!name) break;
      order.push(name);
      if ((byte & 0x80) === 0) skipString();
    }
  } catch {
    // A truncated block still says what it got to.
  }
  return order;
}

const AKAMAI_LETTER: Readonly<Record<string, string>> = {
  ":method": "m",
  ":authority": "a",
  ":scheme": "s",
  ":path": "p",
};

function readPriority(payload: Buffer, at: number): H2Priority {
  const dependency = payload.readUInt32BE(at);
  return {
    dependsOn: dependency & 0x7fffffff,
    exclusive: (dependency & 0x80000000) !== 0,
    weight: payload.readUInt8(at + 4) + 1,
  };
}

/**
 * Reads the client's side of an HTTP/2 connection as it passes, in whatever chunks it comes,
 * and keeps what tells browsers apart: SETTINGS order and values, the connection's
 * WINDOW_UPDATE, PRIORITY frames, and the pseudo-header order of the first request.
 */
export class H2Sniffer {
  private buffered: Buffer = Buffer.alloc(0);
  private sawPreface = false;
  private failed = false;
  private settings: Array<[number, number]> | null = null;
  private windowUpdate: number | null = null;
  private readonly priorityFrames: H2Priority[] = [];
  private readonly frameOrder: string[] = [];
  private firstHeaders: H2Fingerprint["firstHeaders"] = null;

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    if (!this.sawPreface) {
      if (this.buffered.length < PREFACE.length) return;
      if (!this.buffered.subarray(0, PREFACE.length).equals(PREFACE)) {
        this.failed = true;
        return;
      }
      this.sawPreface = true;
      this.buffered = this.buffered.subarray(PREFACE.length);
    }
    while (this.buffered.length >= FRAME_HEADER_LENGTH) {
      const length = this.buffered.readUIntBE(0, 3);
      if (this.buffered.length < FRAME_HEADER_LENGTH + length) return;
      const type = this.buffered.readUInt8(3);
      const flags = this.buffered.readUInt8(4);
      const streamId = this.buffered.readUInt32BE(5) & 0x7fffffff;
      const payload = this.buffered.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + length);
      this.buffered = this.buffered.subarray(FRAME_HEADER_LENGTH + length);
      this.onFrame(type, flags, streamId, payload);
    }
  }

  private onFrame(type: number, flags: number, streamId: number, payload: Buffer): void {
    if (this.frameOrder.length < MAX_FRAME_ORDER) {
      const name = FRAME_NAMES[type] ?? `UNKNOWN_${type}`;
      const isAck = type === 0x4 && (flags & FLAG_ACK) !== 0;
      this.frameOrder.push(isAck ? `${name}_ACK` : name);
    }
    switch (type) {
      case 0x1:
        this.onHeaders(flags, streamId, payload);
        break;
      case 0x2:
        if (payload.length >= 5) this.priorityFrames.push({ streamId, ...readPriority(payload, 0) });
        break;
      case 0x4:
        if ((flags & FLAG_ACK) === 0 && this.settings === null) {
          const settings: Array<[number, number]> = [];
          for (let at = 0; at + 6 <= payload.length; at += 6) {
            settings.push([payload.readUInt16BE(at), payload.readUInt32BE(at + 2)]);
          }
          this.settings = settings;
        }
        break;
      case 0x8:
        if (streamId === 0 && this.windowUpdate === null && payload.length >= 4) {
          this.windowUpdate = payload.readUInt32BE(0) & 0x7fffffff;
        }
        break;
      default:
        break;
    }
  }

  private onHeaders(flags: number, streamId: number, payload: Buffer): void {
    if (this.firstHeaders) return;
    let at = 0;
    let padding = 0;
    if (flags & FLAG_PADDED) {
      padding = payload.readUInt8(0);
      at += 1;
    }
    let priority: H2Priority | null = null;
    if (flags & FLAG_PRIORITY) {
      priority = readPriority(payload, at);
      at += 5;
    }
    // With no END_HEADERS the rest is in CONTINUATION, but pseudo-headers come first:
    // they fit in the first frame in any request a browser sends.
    this.firstHeaders = {
      streamId,
      endStream: (flags & FLAG_END_STREAM) !== 0,
      priority,
      pseudoOrder: pseudoHeaderOrder(payload.subarray(at, payload.length - padding)),
    };
  }

  result(): H2Fingerprint {
    const settings = this.settings ?? [];
    const pseudoOrder = this.firstHeaders?.pseudoOrder ?? [];
    const priorities = this.priorityFrames
      .map((p) => `${p.streamId}:${p.exclusive ? 1 : 0}:${p.dependsOn}:${p.weight}`)
      .join(",");
    const akamai = [
      settings.map(([id, value]) => `${id}:${value}`).join(";"),
      this.windowUpdate ?? "00",
      priorities || "0",
      pseudoOrder.map((name) => AKAMAI_LETTER[name] ?? name).join(","),
    ].join("|");
    return {
      preface: this.sawPreface,
      settings,
      windowUpdate: this.windowUpdate,
      priorityFrames: this.priorityFrames,
      frameOrder: this.frameOrder,
      firstHeaders: this.firstHeaders,
      akamai,
    };
  }
}
