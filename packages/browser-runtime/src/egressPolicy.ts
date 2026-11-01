import { promises as dns } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
import { MultizenError, trimEndChars, type ProxyConfig } from "@multizen/types";

/**
 * Where a server's browsers may connect. `allow-all` is the desktop's behaviour: nothing
 * here runs, and a launch has the flags it always had. `block-private` keeps pages and
 * agents away from what only the machine itself can reach: private and link-local
 * addresses, loopback, cloud metadata.
 *
 * The bridge asks this about every connection a browser opens. A direct profile's names
 * resolve here and only the addresses checked are dialed, which is what closes DNS
 * rebinding. A proxied profile's names stay unresolved on this machine, or its DNS would
 * leak: only literal addresses and well-known names can be judged, and the rest is the
 * upstream proxy's own network.
 */
export type EgressMode = "allow-all" | "block-private";

export const EGRESS_MODES: readonly EgressMode[] = ["allow-all", "block-private"];

export function isEgressMode(value: string): value is EgressMode {
  return (EGRESS_MODES as readonly string[]).includes(value);
}

export interface EgressDecision {
  allowed: boolean;
  /** Why not. */
  reason?: string;
  /** Not a refusal: the name didn't resolve, so there is nowhere to connect to. */
  unresolved?: boolean;
  /** The addresses checked, the only ones to dial. A proxied target has none. */
  connectTo?: readonly string[];
}

type Bytes = readonly number[];

const VALID_HOST = /^[a-z0-9._-]+$/;

/** Longer than this, a URL is refused before anything reads it. Browsers take more; a server's tools don't. */
export const MAX_URL_CHARS = 8_192;

interface Range {
  label: string;
  bytes: Bytes;
  bits: number;
}

function parseIp(text: string): Bytes | null {
  const zoneAt = text.indexOf("%");
  const plain = zoneAt === -1 ? text : text.slice(0, zoneAt);
  // A zone belongs to an IPv6 address and names an interface: past that it is smuggled text.
  if (zoneAt !== -1 && !(isIPv6(plain) && VALID_HOST.test(text.slice(zoneAt + 1)))) return null;
  if (isIPv4(plain)) return plain.split(".").map(Number);
  if (!isIPv6(plain)) return null;
  const bytes = ipv6Bytes(plain);
  // The same address as its IPv4 self: to the blocklist, the allowlist and the socket.
  return inPrefix(bytes, IPV4_MAPPED.bytes, IPV4_MAPPED.bits) ? bytes.slice(12) : bytes;
}

function ipv6Bytes(text: string): Bytes {
  const dotted = /[\d.]+$/.exec(text)?.[0];
  const hex = dotted?.includes(".")
    ? text.slice(0, -dotted.length) +
      dotted
        .split(".")
        .map(Number)
        .reduce((groups, byte, i) => groups + (i === 2 ? ":" : "") + byte.toString(16).padStart(2, "0"), "")
    : text;
  const [head = "", tail = ""] = hex.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = [
    ...headGroups,
    ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
    ...tailGroups,
  ];
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function inPrefix(bytes: Bytes, prefix: Bytes, bits: number): boolean {
  if (bytes.length !== prefix.length) return false;
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff;
    if ((bytes[bit / 8]! & mask) !== (prefix[bit / 8]! & mask)) return false;
  }
  return true;
}

/** `10.0.0.0/8`. Only for literals in this file: an operator's go through the allowlist parser. */
function range(cidr: string): Range {
  const [base, bits] = cidr.split("/") as [string, string];
  return {
    label: cidr,
    bytes: isIPv4(base) ? base.split(".").map(Number) : ipv6Bytes(base),
    bits: Number(bits),
  };
}

const IPV4_MAPPED = range("::ffff:0:0/96");

const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  // Azure's wireserver: a public address, but a metadata endpoint from inside a VM.
  "168.63.129.16/32",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(range);

const BLOCKED_V6 = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"].map(range);

/** IPv6 forms that carry an IPv4 address, and where: each is as blocked as what it carries. */
const CARRYING_V4: ReadonlyArray<{ prefix: Range; at: number }> = [
  { prefix: range("64:ff9b::/96"), at: 12 }, // NAT64
  { prefix: range("::ffff:0:0:0/96"), at: 12 }, // IPv4-translated
  { prefix: range("::/96"), at: 12 }, // IPv4-compatible, deprecated
  { prefix: range("2002::/16"), at: 2 }, // 6to4
];

/** Local-use NAT64 and Teredo put the address where only their own network knows. */
const BLOCKED_V6_TUNNELS = ["64:ff9b:1::/48", "2001::/32"].map(range);

function blockedRange(bytes: Bytes): string | null {
  if (bytes.length === 4) {
    return BLOCKED_V4.find((r) => inPrefix(bytes, r.bytes, r.bits))?.label ?? null;
  }
  const direct = [...BLOCKED_V6, ...BLOCKED_V6_TUNNELS].find((r) => inPrefix(bytes, r.bytes, r.bits));
  if (direct) return direct.label;
  for (const { prefix, at } of CARRYING_V4) {
    if (!inPrefix(bytes, prefix.bytes, prefix.bits)) continue;
    const carried = blockedRange(bytes.slice(at, at + 4));
    if (carried) return `${carried} inside ${prefix.label}`;
  }
  return null;
}

const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);
const BLOCKED_NAME_SUFFIXES = [".localhost", ".internal"];

function isBlockedName(name: string): boolean {
  return BLOCKED_NAMES.has(name) || BLOCKED_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** One part of an inet_aton address: decimal, 0-prefixed octal or 0x-prefixed hex. */
function numericPart(part: string): number | null {
  if (/^0x[0-9a-f]*$/.test(part)) return part.length === 2 ? 0 : parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
  if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
  return null;
}

/**
 * What inet_aton, a URL parser and many resolvers make of a name that ends in a number:
 * `2852039166`, `0x7f.1`, `0177.0.0.1` are addresses. No such top-level domain exists, so
 * what doesn't parse (`1.2.3.256`, `foo.1`) has no safe reading and is refused.
 */
function numericAddress(name: string): Bytes | "invalid" | null {
  const parts = name.split(".");
  if (!/^(\d+|0x[0-9a-f]*)$/.test(parts.at(-1)!)) return null;
  if (parts.length > 4) return "invalid";
  const values = parts.map(numericPart);
  if (values.some((value) => value === null)) return "invalid";
  const leading = values.slice(0, -1) as number[];
  const last = values.at(-1)!;
  if (leading.some((value) => value > 255) || last >= 256 ** (5 - values.length)) return "invalid";
  const bytes = [0, 0, 0, 0];
  leading.forEach((value, i) => (bytes[i] = value));
  for (let i = 3, rest = last; i >= leading.length; i--, rest = Math.floor(rest / 256)) {
    bytes[i] = rest % 256;
  }
  return bytes;
}

type Target = { ip: Bytes; text: string } | { name: string } | { invalid: true };

/** A name has at most 253 characters. These two are for its brackets or root dot. */
const MAX_HOST_CHARS = 255;
/** A host in an error goes to the log, and only the gate's own check has looked at its length. */
const MAX_HOST_CHARS_SHOWN = 80;

function shownHost(host: string): string {
  return host.slice(0, MAX_HOST_CHARS_SHOWN);
}

/**
 * A host as a browser or an operator wrote it: any case, bracketed, a trailing dot. What isn't
 * an address has to be a plain name. `169.254.169.254:80/#` passes for one that won't resolve
 * until something builds a URL from it, and then it is the metadata address.
 */
function parseTarget(host: string): Target {
  if (host.length > MAX_HOST_CHARS) return { invalid: true };
  const plain = trimEndChars(host.toLowerCase().replace(/^\[(.*)\]$/, "$1"), ".");
  if (!plain || /[\s\0]/.test(plain)) return { invalid: true };
  const literal = parseIp(plain);
  if (literal) return { ip: literal, text: ipText(literal, plain) };
  if (!VALID_HOST.test(plain)) return { invalid: true };
  const numeric = numericAddress(plain);
  if (numeric === "invalid") return { invalid: true };
  if (numeric) return { ip: numeric, text: numeric.join(".") };
  return { name: plain };
}

function ipText(bytes: Bytes, written: string): string {
  return bytes.length === 4 ? bytes.join(".") : written.split("%")[0]!;
}

export interface EgressAllowEntry {
  port?: number;
  range?: Range;
  name?: string;
  /** With its leading dot. */
  suffix?: string;
}

const VALID_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/**
 * One `--egress-allow` value: an IP, a CIDR, a name or `*.suffix`, each optionally with
 * `:port` (`[v6]:port` for an IPv6 address).
 */
export function parseEgressAllowEntry(raw: string): EgressAllowEntry {
  let text = raw.trim().toLowerCase();
  const refused = new Error(
    `--egress-allow takes an IP, a CIDR, a name or *.suffix, with an optional :port, got "${raw}"`,
  );
  let portText: string | undefined;
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(text);
  if (bracketed) {
    text = bracketed[1]!;
    portText = bracketed[2];
  } else if (text.split(":").length === 2) {
    // An IPv6 address has at least two colons, so one colon is a port.
    [text, portText] = text.split(":") as [string, string];
  }
  let port: number | undefined;
  if (portText !== undefined) {
    port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw refused;
  }
  const withPort = port === undefined ? {} : { port };

  const cidr = /^(.+)\/(\d+)$/.exec(text);
  if (cidr) {
    const bytes = parseIp(cidr[1]!);
    const bits = Number(cidr[2]);
    if (!bytes || bits > bytes.length * 8) throw refused;
    return { ...withPort, range: { label: text, bytes, bits } };
  }
  if (text.startsWith("*.")) {
    const name = text.slice(2);
    if (!VALID_NAME.test(name)) throw refused;
    return { ...withPort, suffix: `.${name}` };
  }
  const target = parseTarget(text);
  if ("ip" in target) {
    return { ...withPort, range: { label: target.text, bytes: target.ip, bits: target.ip.length * 8 } };
  }
  if (!("name" in target) || !VALID_NAME.test(target.name)) throw refused;
  return { ...withPort, name: target.name };
}

export type EgressLookup = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

const systemLookup: EgressLookup = (host) => dns.lookup(host, { all: true });

/** libuv's own, unless UV_THREADPOOL_SIZE says otherwise. The server's start sets that to 64. */
const DEFAULT_THREADPOOL_SIZE = 4;
/**
 * What a lookup may take before its connection is refused. The resolver may take far longer, and it
 * retries at 5 s by default in glibc: a limit right there fails a name that its second try would answer.
 */
const LOOKUP_TIMEOUT_MS = 10_000;
/** Below this a browser's page and its one slow name take turns, and a page has many. */
const MIN_BRIDGE_LOOKUPS = 2;

function threadpoolSize(): number {
  return Number(process.env.UV_THREADPOOL_SIZE) || DEFAULT_THREADPOOL_SIZE;
}

/**
 * A lookup that holds at most `limit` of libuv's threads at once. dns.lookup takes a thread for as
 * long as the resolver takes and can't be cancelled, and the same threads do this process's file
 * work, so a page asking for names a resolver never answers could stop everything else. A call
 * waits `queueTimeoutMs` for its turn and then gets `timeoutMs` of its own, so a turn that comes
 * late doesn't cost it the time to get an answer. One that times out only stops waiting: its thread
 * counts until it is back.
 */
export function boundedLookup(
  lookup: EgressLookup,
  limit: number,
  timeoutMs = LOOKUP_TIMEOUT_MS,
  queueTimeoutMs = timeoutMs,
): EgressLookup {
  let running = 0;
  const queue: Array<() => void> = [];
  return (host) =>
    new Promise((resolve, reject) => {
      let turnLate: ReturnType<typeof setTimeout> | undefined;
      const start = (): void => {
        clearTimeout(turnLate);
        running++;
        const timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
        // In an async function so a lookup that throws, rather than rejects, still gives its turn back.
        void (async () => lookup(host))()
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            running--;
            queue.shift()?.();
          });
      };
      if (running < limit) {
        start();
        return;
      }
      queue.push(start);
      turnLate = setTimeout(() => {
        queue.splice(queue.indexOf(start), 1);
        reject(new Error(`no turn to look it up within ${queueTimeoutMs} ms`));
      }, queueTimeoutMs);
    });
}

const blocked = (reason: string): EgressDecision => ({ allowed: false, reason });

export class EgressPolicy {
  readonly mode: EgressMode;
  /** False in `allow-all`: every check allows, with no lookup, and launches stay as they were. */
  readonly enforced: boolean;
  private readonly allow: readonly EgressAllowEntry[];
  private readonly rawLookup: EgressLookup;
  /** For tools and launches: a token can ask for as many names as a page can. */
  private readonly lookup: EgressLookup;
  private readonly lookupTimeoutMs: number | undefined;

  /** @throws on an `allow` entry {@link parseEgressAllowEntry} refuses. */
  constructor(opts: {
    mode: EgressMode;
    allow?: readonly string[];
    lookup?: EgressLookup;
    lookupTimeoutMs?: number;
  }) {
    this.mode = opts.mode;
    this.enforced = opts.mode !== "allow-all";
    this.allow = (opts.allow ?? []).map(parseEgressAllowEntry);
    this.rawLookup = opts.lookup ?? systemLookup;
    this.lookupTimeoutMs = opts.lookupTimeoutMs;
    this.lookup = boundedLookup(this.rawLookup, Math.max(1, threadpoolSize() >> 2), opts.lookupTimeoutMs);
  }

  /** A bridge's own share, so one page can only run out of its own: an eighth of the pool. */
  bridgeLookup(): EgressLookup {
    return boundedLookup(this.rawLookup, Math.max(MIN_BRIDGE_LOOKUPS, threadpoolSize() >> 3), this.lookupTimeoutMs);
  }

  private allowsIp(bytes: Bytes, port: number): boolean {
    return this.allow.some(
      (e) =>
        (e.port === undefined || e.port === port) &&
        e.range !== undefined &&
        inPrefix(bytes, e.range.bytes, e.range.bits),
    );
  }

  private allowsName(name: string, port: number): boolean {
    return this.allow.some(
      (e) =>
        (e.port === undefined || e.port === port) &&
        (e.name === name || (e.suffix !== undefined && name.endsWith(e.suffix))),
    );
  }

  private checkIp(bytes: Bytes, text: string, port: number): EgressDecision {
    if (this.allowsIp(bytes, port)) return { allowed: true, connectTo: [text] };
    const hit = blockedRange(bytes);
    return hit ? blocked(`${text} is in ${hit}`) : { allowed: true, connectTo: [text] };
  }

  /** Direct bridge path: resolves the name, classifies every address, keeps the allowed ones. */
  async checkDirect(host: string, port: number, lookup: EgressLookup = this.lookup): Promise<EgressDecision> {
    if (!this.enforced) return { allowed: true };
    const target = parseTarget(host);
    if ("invalid" in target) return blocked(`"${shownHost(host)}" is neither a name nor an address`);
    if ("ip" in target) return this.checkIp(target.ip, target.text, port);

    const named = this.allowsName(target.name, port);
    if (!named && isBlockedName(target.name)) return blocked(`${target.name} is a local or metadata name`);
    let addresses: readonly string[];
    try {
      addresses = (await lookup(target.name)).map((a) => a.address);
    } catch (e) {
      return { allowed: false, unresolved: true, reason: `${target.name} did not resolve: ${(e as Error).message}` };
    }
    if (addresses.length === 0) {
      return { allowed: false, unresolved: true, reason: `${target.name} did not resolve` };
    }
    const checked = addresses.flatMap((address) => {
      const bytes = parseIp(address);
      if (!bytes) return [];
      const text = ipText(bytes, address);
      return named || this.checkIp(bytes, text, port).allowed ? [text] : [];
    });
    if (checked.length === 0) {
      return blocked(`${target.name} resolves only to blocked addresses (${addresses.join(", ")})`);
    }
    return { allowed: true, connectTo: checked };
  }

  /** Proxied bridge path: no lookup, ever. Literals and well-known names only. */
  checkProxied(host: string, port: number): EgressDecision {
    if (!this.enforced) return { allowed: true };
    const target = parseTarget(host);
    if ("invalid" in target) return blocked(`"${shownHost(host)}" is neither a name nor an address`);
    if ("ip" in target) {
      const { allowed, reason } = this.checkIp(target.ip, target.text, port);
      return allowed ? { allowed } : blocked(reason!);
    }
    if (!this.allowsName(target.name, port) && isBlockedName(target.name)) {
      return blocked(`${target.name} is a local or metadata name`);
    }
    return { allowed: true };
  }

  /** The upstream proxy's own address: the bridge and the geo probe connect to it from here. */
  checkUpstream(proxy: Pick<ProxyConfig, "host" | "port">, lookup?: EgressLookup): Promise<EgressDecision> {
    return this.checkDirect(proxy.host, proxy.port, lookup);
  }

  /** Tool level, for a typed answer before anything starts. The bridge still has the last word. */
  async assertUrlAllowed(url: string, ctx: { proxied: boolean }): Promise<void> {
    if (!this.enforced) return;
    if (url.length > MAX_URL_CHARS) {
      throw new MultizenError("INVALID_INPUT", `A URL of ${url.length} characters is over the limit of ${MAX_URL_CHARS}.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return; // The tool's own validation reports this.
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const decision = ctx.proxied
      ? this.checkProxied(parsed.hostname, port)
      : await this.checkDirect(parsed.hostname, port);
    if (decision.allowed || decision.unresolved) return;
    // Not the whole URL: the error gets logged, and a URL can carry a password or a token.
    throw egressBlocked(`The egress policy blocks ${parsed.protocol}//${parsed.host}: ${decision.reason}`, {
      host: parsed.hostname,
      port,
    });
  }

  /**
   * A proxy that doesn't resolve is refused by no policy: it just won't connect. Gives the
   * decision, as whoever dials next must keep to it: {@link EgressDecision.connectTo}.
   */
  async assertProxyAllowed(proxy: Pick<ProxyConfig, "host" | "port">): Promise<EgressDecision> {
    if (!this.enforced) return { allowed: true };
    const decision = await this.checkUpstream(proxy);
    if (decision.allowed || decision.unresolved) return decision;
    const host = shownHost(proxy.host);
    throw egressBlocked(`The egress policy blocks the proxy ${host}:${proxy.port}: ${decision.reason}`, {
      host,
      port: proxy.port,
    });
  }

  /** Allow entries that let a page reach this machine's own ports, whatever is listening there. */
  loopbackAllowedOnAnyPort(): string[] {
    return this.allow.flatMap((e) =>
      e.port === undefined && reachesLoopback(e) ? [e.range?.label ?? e.name ?? `*${e.suffix ?? ""}`] : [],
    );
  }
}

const LOOPBACK_V4: Bytes = [127, 0, 0, 1];
const LOOPBACK_V6: Bytes = ipv6Bytes("::1");

function reachesLoopback(entry: EgressAllowEntry): boolean {
  if (entry.range) {
    return [LOOPBACK_V4, LOOPBACK_V6].some((ip) => inPrefix(ip, entry.range!.bytes, entry.range!.bits));
  }
  return entry.name === "localhost" || entry.suffix === ".localhost";
}

export function egressBlocked(message: string, details?: Record<string, unknown>): MultizenError {
  return new MultizenError("EGRESS_BLOCKED", message, {
    hint: "This server keeps browsers off private addresses. Its operator can allow one with --egress-allow.",
    ...(details ? { details } : {}),
  });
}
