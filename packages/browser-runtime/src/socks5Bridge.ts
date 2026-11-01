import { createServer, isIP, type LookupFunction, type Socket, type AddressInfo } from "node:net";
import { connect as netConnect } from "node:net";
import { SocksClient } from "socks";
import { MultizenError, type ProfileId, type ProxyConfig } from "@multizen/types";
import { egressBlocked, type EgressDecision, type EgressPolicy } from "./egressPolicy.ts";

/**
 * Local SOCKS5 → upstream-proxy bridge, per profile.
 *
 * Why this exists: with Chromium's `--proxy-server=http://localhost:port`
 * (an HTTP-CONNECT relay), DNS resolution leaks. Chromium does its own
 * DNS for prefetch, predictor, background networking, DoH, etc. — none
 * of which traverse the HTTP proxy. browserscan / pixelscan see 9+
 * different DNS resolver IPs and flag it as "DNS leak: yes".
 *
 * With `--proxy-server=socks5://localhost:port`, Chromium does *remote*
 * DNS resolution by spec — every hostname is sent to the SOCKS5 server
 * inside the SOCKS5 CONNECT command, and the server resolves it. Result:
 * the test sees one resolver IP (the proxy provider's egress) and the
 * leak disappears.
 *
 * This module spins up a tiny localhost SOCKS5 server per profile that
 * accepts no-auth handshakes (it's localhost-only — the OS firewall
 * keeps it private) and forwards every CONNECT either to:
 *   - an upstream HTTP/HTTPS proxy via HTTP CONNECT (with Proxy-Authorization)
 *   - an upstream SOCKS5 proxy via the `socks` library
 *
 * The host string from the SOCKS5 CONNECT is forwarded as-is — no local
 * DNS resolution happens on the MultiZen process side either.
 *
 * Under an enforcing egress policy every profile comes through here, and every
 * CONNECT is checked before anything is dialed. With `upstream === null` (a direct
 * profile) the bridge is the last hop: it resolves the name itself and dials only
 * the addresses it checked. A proxied profile still resolves nothing here.
 */

interface BridgeHandle {
  /** localhost port Chromium connects to */
  port: number;
  /** Upstream proxy config (kept so the GUI can render diagnostics). Null: direct. */
  upstream: ProxyConfig | null;
  close: () => Promise<void>;
}

const byProfile = new Map<ProfileId, BridgeHandle>();

/** Rate-limit the per-request bridge failure logs. A dead/blocked upstream
 *  proxy fails EVERY CONNECT (e.g. "403 Forbidden"), which floods stderr with
 *  identical lines. Log each distinct message at most once per 30s. */
const bridgeWarnAt = new Map<string, number>();
/** Under an egress policy a message names a target, which a page chooses. */
const BRIDGE_WARN_KEPT = 1_024;
function warnBridgeThrottled(msg: string): void {
  const now = Date.now();
  if (now - (bridgeWarnAt.get(msg) ?? 0) < 30_000) return;
  if (bridgeWarnAt.size >= BRIDGE_WARN_KEPT) bridgeWarnAt.clear();
  bridgeWarnAt.set(msg, now);
  console.warn("[multizen] socks5 bridge:", msg);
}

/** How long a navigation's failure can still be put down to one the bridge recorded. */
const FAILURE_WINDOW_MS = 2_000;

interface RecordedFailure {
  /** The policy refused it. Otherwise it was allowed, and just couldn't be reached. */
  blocked: boolean;
  target: string;
  reason: string;
  at: number;
}

const lastFailure = new Map<ProfileId, RecordedFailure>();

/**
 * What a load reports when the bridge ended its CONNECT: see {@link refuseConnect}. On
 * Chromium, connected and closed. On Firefox, a SOCKS failure, which it calls a plain
 * NS_ERROR_CONNECTION_REFUSED whichever reply it got (measured on Camoufox), or, when its
 * error page commits before the failure is reported, an interruption by that page.
 */
const ENDED_BY_BRIDGE =
  /ERR_SOCKET_NOT_CONNECTED|ERR_CONNECTION_(?:CLOSED|RESET|ABORTED)|ERR_EMPTY_RESPONSE|ERR_SOCKS_|ERR_PROXY_|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_UNKNOWN_HOST|NS_ERROR_PROXY_|NS_ERROR_SOCKS_|NS_ERROR_UNKNOWN_PROXY|interrupted by another navigation/;

/**
 * A navigation that failed because the bridge refused one of its connections is
 * EGRESS_BLOCKED, whichever hop it was: this is what catches a redirect, which no check
 * of the URL could see. One the bridge couldn't reach stays NAVIGATION_FAILED, and says what
 * really happened, which the browser can't know. Anything else stays what it was.
 */
export function asEgressBlocked(profileId: ProfileId, e: unknown): unknown {
  const failure = lastFailure.get(profileId);
  if (!failure || Date.now() - failure.at > FAILURE_WINDOW_MS) return e;
  if (!ENDED_BY_BRIDGE.test(e instanceof Error ? e.message : String(e))) return e;
  if (failure.blocked) {
    return egressBlocked(`The egress policy blocked ${failure.target} during this navigation: ${failure.reason}`, {
      target: failure.target,
    });
  }
  if (e instanceof MultizenError && e.code === "NAVIGATION_FAILED") {
    return new MultizenError("NAVIGATION_FAILED", `${e.message} (${failure.target}: ${failure.reason})`, {
      details: { ...e.details, target: failure.target, reason: failure.reason },
    });
  }
  return e;
}

export async function startBridgeForProfile(
  profileId: ProfileId,
  upstream: ProxyConfig | null,
  policy?: EgressPolicy,
  opts: { refuseByClosing?: boolean } = {},
): Promise<string> {
  const existing = byProfile.get(profileId);
  if (existing) return `socks5://127.0.0.1:${existing.port}`;

  const handle = await startBridge(
    upstream,
    policy?.enforced
      ? {
          policy,
          refuseByClosing: opts.refuseByClosing ?? false,
          onFailure: (blocked, target, reason) => {
            lastFailure.set(profileId, { blocked, target, reason, at: Date.now() });
            if (blocked) warnBridgeThrottled(`egress policy blocked ${target}: ${reason}`);
          },
        }
      : undefined,
  );
  byProfile.set(profileId, handle);
  return `socks5://127.0.0.1:${handle.port}`;
}

export async function stopBridgeForProfile(profileId: ProfileId): Promise<void> {
  const handle = byProfile.get(profileId);
  if (!handle) return;
  byProfile.delete(profileId);
  lastFailure.delete(profileId);
  await handle.close().catch(() => {});
}

export async function stopAllBridges(): Promise<void> {
  const ids = [...byProfile.keys()];
  await Promise.all(ids.map((id) => stopBridgeForProfile(id)));
}

interface BridgeEgress {
  policy: EgressPolicy;
  /** How this browser has to be told: see {@link refuseConnect}. */
  refuseByClosing: boolean;
  onFailure: (blocked: boolean, target: string, reason: string) => void;
}

async function startBridge(upstream: ProxyConfig | null, egress?: BridgeEgress): Promise<BridgeHandle> {
  // Track accepted client sockets so close() can forcibly destroy them.
  // net.Server has no closeAllConnections(), and a still-open proxied socket
  // keeps server.close()'s callback pending forever — which would hang the
  // app's shutdown path.
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.on("error", () => {
      /* swallow — pipes / close handlers will tear down */
    });
    handleSocksClient(sock, upstream, egress).catch((e: unknown) => {
      const msg = (e as Error).message;
      if (
        /socket closed|ECONNRESET|EPIPE|This socket is closed|read ECONNRESET/i.test(
          msg,
        )
      ) {
        sock.destroy();
        return;
      }
      warnBridgeThrottled(msg);
      sock.destroy();
    });
  });

  server.on("error", (e) => {
    console.error("[multizen] socks5 bridge server error:", e);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;

  return {
    port: addr.port,
    upstream,
    close: () =>
      new Promise<void>((resolve) => {
        // Forcibly destroy any still-open proxied sockets so server.close()'s
        // callback actually fires — otherwise a lingering connection keeps the
        // bridge (and the app's shutdown path) pending indefinitely.
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

async function handleSocksClient(
  client: Socket,
  upstream: ProxyConfig | null,
  egress?: BridgeEgress,
): Promise<void> {
  client.setNoDelay(true);
  const reader = new BufferedReader(client);

  // 1. Greeting: VER + NMETHODS + METHODS[NMETHODS]
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error(`unsupported SOCKS version ${greeting[0]}`);
  const nMethods = greeting[1] ?? 0;
  if (nMethods > 0) await reader.read(nMethods); // discard methods, we only do no-auth
  client.write(Buffer.from([0x05, 0x00]));

  // 2. Request: VER + CMD + RSV + ATYP + DST.ADDR + DST.PORT
  const head = await reader.read(4);
  if (head[0] !== 0x05) throw new Error("bad SOCKS version on request");
  const cmd = head[1];
  const atyp = head[3];
  if (cmd !== 0x01) {
    client.write(replyBuffer(0x07));
    client.end();
    return;
  }

  let targetHost: string;
  if (atyp === 0x01) {
    const b = await reader.read(4);
    targetHost = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  } else if (atyp === 0x03) {
    const lenByte = await reader.read(1);
    const len = lenByte[0] ?? 0;
    const nameBuf = await reader.read(len);
    targetHost = nameBuf.toString("ascii");
  } else if (atyp === 0x04) {
    const b = await reader.read(16);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
    targetHost = groups.join(":");
  } else {
    client.write(replyBuffer(0x08));
    client.end();
    return;
  }
  const portBuf = await reader.read(2);
  const targetPort = portBuf.readUInt16BE(0);

  // 3. The policy's word on this CONNECT, before anything is dialed.
  const decision = egress
    ? await checkConnect(egress.policy, targetHost, targetPort, upstream)
    : undefined;
  if (decision && !decision.allowed) {
    egress?.onFailure(!decision.unresolved, `${targetHost}:${targetPort}`, decision.reason ?? "");
    // Host unreachable, or connection not allowed by ruleset.
    refuseConnect(client, decision.unresolved ? 0x04 : 0x02, egress);
    return;
  }
  const pinned = decision?.connectTo && pinnedLookup(decision.connectTo);

  // 4. Open the upstream tunnel, or for a direct profile the connection itself.
  let upstreamSock: Socket;
  try {
    upstreamSock = !upstream
      ? await openTcp(targetHost, targetPort, pinned)
      : upstream.type === "socks5"
        ? await connectViaSocks5(targetHost, targetPort, upstream, pinned)
        : await connectViaHttpConnect(targetHost, targetPort, upstream, pinned);
  } catch (e) {
    egress?.onFailure(false, `${targetHost}:${targetPort}`, (e as Error).message);
    refuseConnect(client, 0x05, egress); // connection refused
    throw e;
  }
  // It may have given up while this connected, and then nothing would end this connection.
  if (client.destroyed) {
    upstreamSock.destroy();
    return;
  }

  // 5. Tell the SOCKS5 client we're ready.
  client.write(replyBuffer(0x00));

  // 6. Hand control over to byte-piping. Detach the buffered reader so
  //    Chromium's TLS bytes flow straight through; flush anything we
  //    already buffered.
  upstreamSock.setNoDelay(true);
  reader.detach((leftover) => {
    if (leftover.length > 0) upstreamSock.write(leftover);
    client.pipe(upstreamSock, { end: true });
  });
  upstreamSock.pipe(client, { end: true });

  const cleanup = (): void => {
    client.destroy();
    upstreamSock.destroy();
  };
  client.once("error", cleanup);
  client.once("close", cleanup);
  upstreamSock.once("error", cleanup);
  upstreamSock.once("close", cleanup);
}

/**
 * Ends a CONNECT that won't go anywhere. Normally with its SOCKS failure reply. But on any of
 * those Chromium reconnects to the proxy at once, without backing off, some 3000 times a second
 * for anything from 100 ms to 6 s per request, and a late reply only makes the request hang
 * longer (measured on CloakBrowser 146). Under a policy a page could point any number of
 * requests at that, each attempt another lookup or connection from here. There, "connected"
 * and then closed ends a request at once, after one attempt, with nothing dialed. Firefox gets
 * the reply: it doesn't spin on one, trying a refused fetch twice where it tries a closed one
 * twenty times (measured on Camoufox).
 */
function refuseConnect(client: Socket, status: number, egress?: BridgeEgress): void {
  client.write(replyBuffer(egress?.refuseByClosing ? 0x00 : status));
  client.end();
}

/**
 * For a proxied profile the target gets the no-lookup check, and what is dialed is the
 * upstream proxy: its own address is checked each time, as a name can change its answer.
 */
async function checkConnect(
  policy: EgressPolicy,
  host: string,
  port: number,
  upstream: ProxyConfig | null,
): Promise<EgressDecision> {
  if (!upstream) return policy.checkDirect(host, port);
  const target = policy.checkProxied(host, port);
  return target.allowed ? policy.checkUpstream(upstream) : target;
}

/**
 * Makes a connection go to the addresses just checked and nowhere else. Node then tries
 * them in turn, as for any name, and the OS resolver isn't asked again: its second answer
 * is the whole of a DNS rebinding attack. A literal host never reaches a lookup.
 */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const all = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_host, options, callback) => {
    if (options.all) callback(null, all);
    else callback(null, all[0]!.address, all[0]!.family);
  };
}

function replyBuffer(status: number): Buffer {
  return Buffer.from([
    0x05,
    status,
    0x00,
    0x01, // IPv4 BND.ADDR
    0,
    0,
    0,
    0,
    0,
    0, // BND.PORT
  ]);
}

async function connectViaHttpConnect(
  targetHost: string,
  targetPort: number,
  upstream: ProxyConfig,
  pinned?: LookupFunction,
): Promise<Socket> {
  const sock = await openTcp(upstream.host, upstream.port, pinned);
  const reader = new BufferedReader(sock);
  const authority = isIP(targetHost) === 6 ? `[${targetHost}]` : targetHost;
  const lines: string[] = [
    `CONNECT ${authority}:${targetPort} HTTP/1.1`,
    `Host: ${authority}:${targetPort}`,
  ];
  if (upstream.username) {
    const token = Buffer.from(
      `${upstream.username}:${upstream.password ?? ""}`,
      "utf8",
    ).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  lines.push("Proxy-Connection: keep-alive", "", "");
  sock.write(lines.join("\r\n"));

  const statusLine = await readLine(reader);
  const m = /^HTTP\/1\.[01] (\d{3}) /.exec(statusLine);
  if (!m || !m[1]?.startsWith("2")) {
    sock.destroy();
    throw new Error(`upstream HTTP CONNECT failed: ${statusLine.trim()}`);
  }
  // Drain the rest of the headers — terminator is an empty line.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await readLine(reader);
    if (line === "") break;
  }
  // Push any bytes the upstream may have sent past the CONNECT response
  // (rare with HTTP/1.1 CONNECT, but possible with some proxies).
  reader.detach((leftover) => {
    if (leftover.length > 0) sock.unshift(leftover);
  });
  return sock;
}

async function connectViaSocks5(
  targetHost: string,
  targetPort: number,
  upstream: ProxyConfig,
  pinned?: LookupFunction,
): Promise<Socket> {
  const info = await SocksClient.createConnection({
    proxy: {
      host: upstream.host,
      port: upstream.port,
      type: 5,
      userId: upstream.username,
      password: upstream.password,
    },
    command: "connect",
    destination: { host: targetHost, port: targetPort },
    ...(pinned ? { socket_options: { port: upstream.port, lookup: pinned } } : {}),
  });
  return info.socket as Socket;
}

function openTcp(host: string, port: number, pinned?: LookupFunction): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host, port, ...(pinned ? { lookup: pinned } : {}) });
    sock.once("connect", () => {
      sock.off("error", reject);
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

/**
 * Pull-mode reader on top of a Socket. Adds a single permanent `data`
 * listener that accumulates into an internal buffer; consumers call
 * `read(n)` to await N bytes. Avoids the foot-guns of using `socket.
 * unshift()` / multiple `data` listeners (which can drop bytes during
 * handshake → pipe transitions).
 *
 * Call `detach(handler)` once you're ready to switch back to streaming
 * mode — the buffered reader stops listening, hands you any leftover
 * bytes, and from that point on you can `pipe()` the socket as normal.
 */
class BufferedReader {
  private buf = Buffer.alloc(0);
  private pending:
    | { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }
    | null = null;
  private closed = false;
  private err: Error | null = null;
  private detached = false;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onClose: () => void;
  private readonly onError: (e: Error) => void;

  constructor(private readonly sock: Socket) {
    this.onData = (chunk: Buffer) => {
      if (this.detached) return;
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    };
    this.onClose = () => {
      this.closed = true;
      this.pump();
    };
    this.onError = (e) => {
      this.err = e;
      this.pump();
    };
    sock.on("data", this.onData);
    sock.once("close", this.onClose);
    sock.once("error", this.onError);
  }

  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(new Error("BufferedReader: concurrent read not supported"));
        return;
      }
      this.pending = { n, resolve, reject };
      this.pump();
    });
  }

  /**
   * Stop intercepting `data` events. The handler is invoked with any
   * bytes still in the internal buffer — the caller decides how to
   * forward them (write to upstream, unshift, etc.).
   */
  detach(handler: (leftover: Buffer) => void): void {
    if (this.detached) return;
    this.detached = true;
    this.sock.off("data", this.onData);
    this.sock.off("close", this.onClose);
    this.sock.off("error", this.onError);
    handler(this.buf);
    this.buf = Buffer.alloc(0);
  }

  private pump(): void {
    if (!this.pending) return;
    const head = this.pending;
    if (this.buf.length >= head.n) {
      const slice = Buffer.from(this.buf.subarray(0, head.n));
      this.buf = this.buf.subarray(head.n);
      this.pending = null;
      head.resolve(slice);
      return;
    }
    if (this.err) {
      this.pending = null;
      head.reject(this.err);
      return;
    }
    if (this.closed) {
      this.pending = null;
      head.reject(new Error("socket closed before all bytes received"));
    }
  }
}

async function readLine(reader: BufferedReader): Promise<string> {
  const out: number[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const b = await reader.read(1);
    const ch = b[0] ?? 0;
    if (ch === 0x0a) {
      if (out[out.length - 1] === 0x0d) out.pop();
      return Buffer.from(out).toString("utf8");
    }
    out.push(ch);
    if (out.length > 8192) throw new Error("response line too long");
  }
}
