import { createHash } from "node:crypto";

const RECORD_HEADER_LENGTH = 5;
const CONTENT_TYPE_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const HANDSHAKE_HEADER_LENGTH = 4;

export const EXT_SERVER_NAME = 0x0000;
export const EXT_SUPPORTED_GROUPS = 0x000a;
export const EXT_EC_POINT_FORMATS = 0x000b;
export const EXT_SIGNATURE_ALGORITHMS = 0x000d;
export const EXT_ALPN = 0x0010;
export const EXT_COMPRESS_CERTIFICATE = 0x001b;
export const EXT_PRE_SHARED_KEY = 0x0029;
export const EXT_SUPPORTED_VERSIONS = 0x002b;
export const EXT_PSK_MODES = 0x002d;
export const EXT_KEY_SHARE = 0x0033;
export const EXT_ECH = 0xfe0d;

/** What a ClientHello says, in the order it says it. GREASE values are still in here. */
export interface ClientHello {
  legacyVersion: number;
  sessionIdLength: number;
  ciphers: number[];
  extensions: number[];
  sni: string | null;
  alpn: string[];
  supportedVersions: number[];
  signatureAlgorithms: number[];
  supportedGroups: number[];
  ecPointFormats: number[];
  keyShareGroups: number[];
  pskKeyExchangeModes: number[];
  compressCertificate: number[];
}

/** RFC 8701: 0x0a0a, 0x1a1a, ... 0xfafa. */
export function isGrease(value: number): boolean {
  return (value & 0x0f0f) === 0x0a0a && value >> 8 === (value & 0xff);
}

const hex4 = (value: number): string => value.toString(16).padStart(4, "0");

class Reader {
  private at = 0;

  constructor(private readonly bytes: Buffer) {}

  get left(): number {
    return this.bytes.length - this.at;
  }

  private take(n: number): number {
    if (this.left < n) throw new Error("truncated ClientHello");
    const start = this.at;
    this.at += n;
    return start;
  }

  u8(): number {
    return this.bytes.readUInt8(this.take(1));
  }

  u16(): number {
    return this.bytes.readUInt16BE(this.take(2));
  }

  slice(n: number): Buffer {
    const start = this.take(n);
    return this.bytes.subarray(start, start + n);
  }

  /** A length-prefixed part: 1, or 2 bytes of length. */
  part(lengthBytes: 1 | 2): Reader {
    return new Reader(this.slice(lengthBytes === 1 ? this.u8() : this.u16()));
  }

  u16List(): number[] {
    const out: number[] = [];
    while (this.left > 0) out.push(this.u16());
    return out;
  }

  u8List(): number[] {
    const out: number[] = [];
    while (this.left > 0) out.push(this.u8());
    return out;
  }
}

/**
 * The ClientHello handshake message from the start of a TLS stream, across as many
 * records as it takes. Null: not all of it has arrived yet.
 *
 * @throws when these bytes aren't a TLS handshake.
 */
export function clientHelloMessage(stream: Buffer): Buffer | null {
  const chunks: Buffer[] = [];
  let at = 0;
  let have = 0;
  let needed: number | null = null;
  while (needed === null || have < needed) {
    if (stream.length < at + RECORD_HEADER_LENGTH) return null;
    if (stream.readUInt8(at) !== CONTENT_TYPE_HANDSHAKE) throw new Error("not a TLS handshake");
    const length = stream.readUInt16BE(at + 3);
    if (stream.length < at + RECORD_HEADER_LENGTH + length) return null;
    chunks.push(stream.subarray(at + RECORD_HEADER_LENGTH, at + RECORD_HEADER_LENGTH + length));
    have += length;
    at += RECORD_HEADER_LENGTH + length;
    if (needed === null && have >= HANDSHAKE_HEADER_LENGTH) {
      const head = Buffer.concat(chunks);
      if (head.readUInt8(0) !== HANDSHAKE_CLIENT_HELLO) throw new Error("not a ClientHello");
      needed = HANDSHAKE_HEADER_LENGTH + head.readUIntBE(1, 3);
    }
  }
  return Buffer.concat(chunks).subarray(0, needed);
}

/** Parses what {@link clientHelloMessage} found. */
export function parseClientHello(message: Buffer): ClientHello {
  const r = new Reader(message);
  if (r.u8() !== HANDSHAKE_CLIENT_HELLO) throw new Error("not a ClientHello");
  r.slice(3); // message length
  const legacyVersion = r.u16();
  r.slice(32); // random
  const sessionIdLength = r.part(1).left;
  const ciphers = r.part(2).u16List();
  r.part(1); // compression methods
  const hello: ClientHello = {
    legacyVersion,
    sessionIdLength,
    ciphers,
    extensions: [],
    sni: null,
    alpn: [],
    supportedVersions: [],
    signatureAlgorithms: [],
    supportedGroups: [],
    ecPointFormats: [],
    keyShareGroups: [],
    pskKeyExchangeModes: [],
    compressCertificate: [],
  };
  if (r.left === 0) return hello;
  const extensions = r.part(2);
  while (extensions.left > 0) {
    const type = extensions.u16();
    const body = extensions.part(2);
    hello.extensions.push(type);
    switch (type) {
      case EXT_SERVER_NAME: {
        const list = body.part(2);
        while (list.left > 0) {
          const nameType = list.u8();
          const name = list.part(2);
          if (nameType === 0) hello.sni = name.slice(name.left).toString("utf8");
        }
        break;
      }
      case EXT_ALPN: {
        const list = body.part(2);
        while (list.left > 0) {
          const protocol = list.part(1);
          hello.alpn.push(protocol.slice(protocol.left).toString("latin1"));
        }
        break;
      }
      case EXT_SUPPORTED_VERSIONS:
        hello.supportedVersions = body.part(1).u16List();
        break;
      case EXT_SIGNATURE_ALGORITHMS:
        hello.signatureAlgorithms = body.part(2).u16List();
        break;
      case EXT_SUPPORTED_GROUPS:
        hello.supportedGroups = body.part(2).u16List();
        break;
      case EXT_EC_POINT_FORMATS:
        hello.ecPointFormats = body.part(1).u8List();
        break;
      case EXT_KEY_SHARE: {
        const shares = body.part(2);
        while (shares.left > 0) {
          hello.keyShareGroups.push(shares.u16());
          shares.part(2);
        }
        break;
      }
      case EXT_PSK_MODES:
        hello.pskKeyExchangeModes = body.part(1).u8List();
        break;
      case EXT_COMPRESS_CERTIFICATE:
        hello.compressCertificate = body.part(1).u16List();
        break;
      default:
        break;
    }
  }
  return hello;
}

const VERSION_CODES: Readonly<Record<number, string>> = {
  0x0304: "13",
  0x0303: "12",
  0x0302: "11",
  0x0301: "10",
  0x0300: "s3",
  0x0002: "s2",
  0xfeff: "d1",
  0xfefd: "d2",
  0xfefc: "d3",
};

function versionCode(hello: ClientHello): string {
  const listed = hello.supportedVersions.filter((v) => !isGrease(v));
  // Compared as numbers, DTLS's would sort below TLS's, but a hello never lists both.
  const version = listed.length > 0 ? Math.max(...listed) : hello.legacyVersion;
  return VERSION_CODES[version] ?? "00";
}

const isAlphanumeric = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

function alpnCode(hello: ClientHello): string {
  const first = hello.alpn[0];
  if (!first) return "00";
  const bytes = Buffer.from(first, "latin1");
  const head = bytes[0]!;
  const tail = bytes[bytes.length - 1]!;
  if (isAlphanumeric(head) && isAlphanumeric(tail)) {
    return String.fromCharCode(head) + String.fromCharCode(tail);
  }
  return head.toString(16).padStart(2, "0")[0]! + tail.toString(16).padStart(2, "0")[1]!;
}

const truncatedSha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

const twoDigits = (n: number): string => String(Math.min(n, 99)).padStart(2, "0");

export interface Ja4 {
  ja4: string;
  /** The same with the lists spelled out, sorted: what the hashes were taken of. */
  ja4_r: string;
}

/**
 * JA4 as FoxIO specifies it (technical_details/JA4.md). Sorting takes out the order, which
 * Chrome shuffles per connection. GREASE doesn't count anywhere. SNI and ALPN count in the
 * first part and leave the hash, so a site's name and protocols don't change it.
 */
export function ja4(hello: ClientHello, transport: "t" | "q" | "d" = "t"): Ja4 {
  const ciphers = hello.ciphers.filter((c) => !isGrease(c));
  const extensions = hello.extensions.filter((e) => !isGrease(e));
  const a =
    transport +
    versionCode(hello) +
    (hello.extensions.includes(EXT_SERVER_NAME) ? "d" : "i") +
    twoDigits(ciphers.length) +
    twoDigits(extensions.length) +
    alpnCode(hello);
  const sortedCiphers = ciphers.map(hex4).sort().join(",");
  const sortedExtensions = extensions
    .filter((e) => e !== EXT_SERVER_NAME && e !== EXT_ALPN)
    .map(hex4)
    .sort()
    .join(",");
  const sigalgs = hello.signatureAlgorithms.filter((s) => !isGrease(s)).map(hex4).join(",");
  const extensionPart = sigalgs ? `${sortedExtensions}_${sigalgs}` : sortedExtensions;
  const b = sortedCiphers ? truncatedSha256(sortedCiphers) : "000000000000";
  const c = sortedExtensions ? truncatedSha256(extensionPart) : "000000000000";
  return { ja4: `${a}_${b}_${c}`, ja4_r: `${a}_${sortedCiphers}_${extensionPart}` };
}

/** What a report keeps of a hello: hex, no GREASE, and extensions without Chrome's shuffle. */
export function describeClientHello(hello: ClientHello): Record<string, unknown> {
  const clean = (list: number[]): string[] => list.filter((v) => !isGrease(v)).map(hex4);
  return {
    ...ja4(hello),
    legacyVersion: hex4(hello.legacyVersion),
    sessionIdLength: hello.sessionIdLength,
    sni: hello.sni,
    alpn: hello.alpn,
    ciphers: clean(hello.ciphers),
    extensionsSorted: clean(hello.extensions).sort(),
    extensionsWire: clean(hello.extensions),
    grease: hello.extensions.some(isGrease) || hello.ciphers.some(isGrease),
    supportedVersions: clean(hello.supportedVersions),
    signatureAlgorithms: clean(hello.signatureAlgorithms),
    supportedGroups: clean(hello.supportedGroups),
    keyShareGroups: clean(hello.keyShareGroups),
    pskKeyExchangeModes: hello.pskKeyExchangeModes,
    compressCertificate: clean(hello.compressCertificate),
    ech: hello.extensions.includes(EXT_ECH),
    resumed: hello.extensions.includes(EXT_PRE_SHARED_KEY),
  };
}
