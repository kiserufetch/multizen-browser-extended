import { test } from "node:test";
import assert from "node:assert/strict";
import { clientHelloMessage, describeClientHello, isGrease, ja4, parseClientHello, type ClientHello } from "./ja4.ts";

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const list16 = (values: number[]): Buffer => Buffer.concat(values.map(u16));
const with16 = (body: Buffer): Buffer => Buffer.concat([u16(body.length), body]);
const with8 = (body: Buffer): Buffer => Buffer.concat([Buffer.from([body.length]), body]);

function extension(type: number, body: Buffer): Buffer {
  return Buffer.concat([u16(type), with16(body)]);
}

/** A hello as a browser sends it, with these lists in this order. */
function helloMessage(opts: {
  ciphers: number[];
  extensions: Array<[number, Buffer]>;
  legacyVersion?: number;
}): Buffer {
  const body = Buffer.concat([
    u16(opts.legacyVersion ?? 0x0303),
    Buffer.alloc(32, 7),
    with8(Buffer.alloc(32, 9)),
    with16(list16(opts.ciphers)),
    with8(Buffer.from([0])),
    with16(Buffer.concat(opts.extensions.map(([type, ext]) => extension(type, ext)))),
  ]);
  const length = Buffer.alloc(3);
  length.writeUIntBE(body.length, 0, 3);
  return Buffer.concat([Buffer.from([1]), length, body]);
}

function record(fragment: Buffer): Buffer {
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(fragment.length), fragment]);
}

const SNI = with16(Buffer.concat([Buffer.from([0]), with16(Buffer.from("example.com"))]));
const ALPN = with16(Buffer.concat([with8(Buffer.from("h2")), with8(Buffer.from("http/1.1"))]));
const SIGALGS = with16(list16([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601]));
const VERSIONS = with8(list16([0x0304, 0x0303]));

/**
 * The worked example of FoxIO's JA4.md: ciphers and extensions in its "original" order
 * (JA4_ro), and its published result.
 */
const SPEC_CIPHERS = [
  0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f,
  0x0035,
];
const SPEC_EXTENSIONS: Array<[number, Buffer]> = [
  [0x001b, with8(list16([0x0002]))],
  [0x0000, SNI],
  [0x0033, with16(Buffer.concat([u16(0x001d), with16(Buffer.alloc(32, 1))]))],
  [0x0010, ALPN],
  [0x4469, Buffer.alloc(0)],
  [0x0017, Buffer.alloc(0)],
  [0x002d, with8(Buffer.from([1]))],
  [0x000d, SIGALGS],
  [0x0005, Buffer.alloc(0)],
  [0x0023, Buffer.alloc(0)],
  [0x0012, Buffer.alloc(0)],
  [0x002b, VERSIONS],
  [0xff01, Buffer.from([0])],
  [0x000b, with8(Buffer.from([0]))],
  [0x000a, with16(list16([0x001d, 0x0017]))],
  [0x0015, Buffer.alloc(0)],
];

const PUBLISHED_JA4 = "t13d1516h2_8daaf6152771_e5627efa2ab1";
const PUBLISHED_JA4_R =
  "t13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_" +
  "0005,000a,000b,000d,0012,0015,0017,001b,0023,002b,002d,0033,4469,ff01_" +
  "0403,0804,0401,0503,0805,0501,0806,0601";

test("ja4 gives the specification's published result for its worked example", () => {
  const hello = parseClientHello(helloMessage({ ciphers: SPEC_CIPHERS, extensions: SPEC_EXTENSIONS }));
  const { ja4: value, ja4_r } = ja4(hello);
  assert.equal(value, PUBLISHED_JA4);
  assert.equal(ja4_r, PUBLISHED_JA4_R);
});

test("ja4 ignores GREASE everywhere and the wire order of extensions", () => {
  const grease: [number, Buffer] = [0x2a2a, Buffer.alloc(0)];
  const shuffled = [grease, ...[...SPEC_EXTENSIONS].reverse(), [0xfafa, Buffer.from([0])] as [number, Buffer]];
  const hello = parseClientHello(helloMessage({ ciphers: [0x4a4a, ...SPEC_CIPHERS], extensions: shuffled }));
  assert.equal(ja4(hello).ja4, PUBLISHED_JA4);
});

test("no SNI reads i, and it leaves the extension hash as it was", () => {
  const extensions = SPEC_EXTENSIONS.filter(([type]) => type !== 0x0000);
  const hello = parseClientHello(helloMessage({ ciphers: SPEC_CIPHERS, extensions }));
  assert.equal(ja4(hello).ja4, "t13i1515h2_8daaf6152771_e5627efa2ab1");
});

test("no signature algorithms: the hash has no underscore, as the specification's example", () => {
  const extensions = SPEC_EXTENSIONS.filter(([type]) => type !== 0x000d);
  const hello = parseClientHello(helloMessage({ ciphers: SPEC_CIPHERS, extensions }));
  // 15 extensions now, and 000d is no longer among the hashed ones.
  assert.match(ja4(hello).ja4, /^t13d1515h2_8daaf6152771_[0-9a-f]{12}$/);
});

function bareHello(over: Partial<ClientHello>): ClientHello {
  return {
    legacyVersion: 0x0303,
    sessionIdLength: 0,
    ciphers: [],
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
    ...over,
  };
}

test("the parts the specification gives rules for: empty lists, version, ALPN bytes", () => {
  assert.equal(ja4(bareHello({})).ja4, "t12i000000_000000000000_000000000000");
  assert.equal(ja4(bareHello({ legacyVersion: 0x0301 })).ja4.slice(0, 3), "t10");
  assert.equal(ja4(bareHello({ alpn: ["http/1.1"] })).ja4.slice(8, 10), "h1");
  assert.equal(ja4(bareHello({ alpn: ["a"] })).ja4.slice(8, 10), "aa");
  // The specification's own table for what isn't alphanumeric.
  assert.equal(ja4(bareHello({ alpn: ["\xab"] })).ja4.slice(8, 10), "ab");
  assert.equal(ja4(bareHello({ alpn: ["\xab\xcd"] })).ja4.slice(8, 10), "ad");
  assert.equal(ja4(bareHello({ alpn: ["\x30\xab"] })).ja4.slice(8, 10), "3b");
  assert.equal(ja4(bareHello({ alpn: ["\x61\x20"] })).ja4.slice(8, 10), "60");
  assert.equal(ja4(bareHello({}), "q").ja4[0], "q");
});

test("GREASE is exactly the sixteen values of RFC 8701", () => {
  const all = Array.from({ length: 0x10000 }, (_, v) => v).filter(isGrease);
  assert.equal(all.length, 16);
  assert.equal(all[0], 0x0a0a);
  assert.equal(all[15], 0xfafa);
});

test("clientHelloMessage waits for all of it and takes it across records", () => {
  const message = helloMessage({ ciphers: SPEC_CIPHERS, extensions: SPEC_EXTENSIONS });
  const whole = record(message);
  assert.equal(clientHelloMessage(whole.subarray(0, 3)), null, "not even a header");
  assert.equal(clientHelloMessage(whole.subarray(0, whole.length - 1)), null, "one byte short");
  assert.deepEqual(clientHelloMessage(whole), message);
  const split = Buffer.concat([record(message.subarray(0, 2)), record(message.subarray(2))]);
  assert.deepEqual(clientHelloMessage(split), message);
  // What follows the hello is someone else's.
  assert.deepEqual(clientHelloMessage(Buffer.concat([whole, Buffer.from([1, 2, 3])])), message);
});

test("clientHelloMessage refuses what isn't TLS", () => {
  assert.throws(() => clientHelloMessage(Buffer.from("GET / HTTP/1.1\r\n\r\n")), /not a TLS handshake/);
  assert.throws(() => clientHelloMessage(record(Buffer.from([2, 0, 0, 0]))), /not a ClientHello/);
});

test("parseClientHello refuses a truncated hello instead of reading past it", () => {
  const message = helloMessage({ ciphers: SPEC_CIPHERS, extensions: SPEC_EXTENSIONS });
  assert.throws(() => parseClientHello(message.subarray(0, 60)), /truncated/);
});

test("describeClientHello names what a comparison needs, with no GREASE in it", () => {
  const extensions: Array<[number, Buffer]> = [
    [0x2a2a, Buffer.alloc(0)],
    ...SPEC_EXTENSIONS,
    [0xfe0d, Buffer.alloc(8)],
    [0x0029, Buffer.alloc(8)],
  ];
  const report = describeClientHello(
    parseClientHello(helloMessage({ ciphers: [0x4a4a, ...SPEC_CIPHERS], extensions })),
  );
  assert.equal(report.sni, "example.com");
  assert.deepEqual(report.alpn, ["h2", "http/1.1"]);
  assert.equal(report.ech, true);
  assert.equal(report.resumed, true);
  assert.equal(report.grease, true);
  assert.deepEqual(report.keyShareGroups, ["001d"]);
  assert.deepEqual(report.compressCertificate, ["0002"]);
  assert.ok(!(report.extensionsSorted as string[]).includes("2a2a"));
  assert.ok(!(report.ciphers as string[]).includes("4a4a"));
});
