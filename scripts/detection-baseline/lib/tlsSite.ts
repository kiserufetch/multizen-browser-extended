import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createSecureContext, TLSSocket, type SecureContext } from "node:tls";
import selfsigned from "selfsigned";
import { H2Sniffer, type H2Fingerprint } from "./h2Sniffer.ts";
import { clientHelloMessage, parseClientHello, type ClientHello } from "./ja4.ts";

const CERT_DAYS = 2;
const PAGE = "<!doctype html><title>MultiZen baseline TLS</title><h1>TLS</h1>";

/** One connection as the wire saw it. */
export interface TlsConnection {
  hello: ClientHello | null;
  /** What it negotiated: `h2`, `http/1.1`, or false. */
  alpn: string | false | null;
  sniffer: H2Sniffer;
  /** The first request's, in the browser's order. Empty until one arrives. */
  requestHeaders: Array<[string, string]>;
  error?: string;
}

export interface TlsSite {
  port: number;
  url: string;
  connections(): TlsConnection[];
  /** The first connection that sent an HTTP/2 request. */
  h2(): H2Fingerprint | null;
  close(): Promise<void>;
}

/** Pairs a readable side with where its writes go, and shows each chunk to `see` on the way. */
class Pass extends Duplex {
  constructor(
    private readonly below: Socket | TLSSocket,
    first?: Buffer,
    see?: (chunk: Buffer) => void,
  ) {
    super();
    if (first) this.push(first);
    below.on("data", (chunk: Buffer) => {
      see?.(chunk);
      if (!this.push(chunk)) below.pause();
    });
    below.on("end", () => this.push(null));
    below.on("error", (e) => this.destroy(e));
    below.on("close", () => this.destroy());
  }

  override _read(): void {
    this.below.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (e?: Error | null) => void): void {
    this.below.write(chunk, done);
  }

  override _final(done: () => void): void {
    this.below.end(done);
  }

  override _destroy(e: Error | null, done: (e?: Error | null) => void): void {
    this.below.destroy();
    done(e);
  }
}

function selfSignedContext(): SecureContext {
  const pems = selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    days: CERT_DAYS,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  });
  return createSecureContext({ cert: pems.cert, key: pems.private });
}

function pairsOf(raw: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
}

/**
 * `https://localhost:<port>/`: reads each ClientHello from the raw bytes before TLS gets
 * them, then replays them into a real TLS and HTTP stack and watches the plain text pass.
 * Its certificate is self-signed, so a browser has to be told to take it: that's for the
 * run, and nothing an agent can reach.
 */
export async function startTlsSite(): Promise<TlsSite> {
  const secureContext = selfSignedContext();
  const connections: TlsConnection[] = [];
  const sockets = new Set<Socket>();
  const connectionOf = new WeakMap<object, TlsConnection>();

  const http1 = createHttpServer((req, res) => {
    const connection = connectionOf.get(req.socket);
    if (connection && connection.requestHeaders.length === 0) {
      connection.requestHeaders = pairsOf(req.rawHeaders);
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });

  const http2 = createHttp2Server();
  // The server emits this synchronously from "connection", below.
  let arriving: TlsConnection | null = null;
  http2.on("session", (session) => {
    if (arriving) connectionOf.set(session, arriving);
  });
  // Node passes the raw headers as a fourth argument, which its types leave out.
  const onStream = (stream: ServerHttp2Stream, _h: IncomingHttpHeaders, _f: number, rawHeaders: string[]): void => {
    const connection = stream.session && connectionOf.get(stream.session);
    if (connection && connection.requestHeaders.length === 0) {
      connection.requestHeaders = pairsOf(rawHeaders);
    }
    stream.on("error", () => {});
    stream.respond({ ":status": 200, "content-type": "text/html" });
    stream.end(PAGE);
  };
  http2.on("stream", onStream as unknown as (stream: ServerHttp2Stream) => void);
  http2.on("sessionError", () => {});

  const onSecure = (tlsSocket: TLSSocket, connection: TlsConnection): void => {
    connection.alpn = tlsSocket.alpnProtocol ?? false;
    const plain = new Pass(tlsSocket, undefined, (chunk) => connection.sniffer.push(chunk));
    plain.on("error", () => {});
    if (connection.alpn === "h2") {
      arriving = connection;
      http2.emit("connection", plain);
      arriving = null;
    } else {
      connectionOf.set(plain, connection);
      http1.emit("connection", plain);
    }
  };

  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const connection: TlsConnection = {
      hello: null,
      alpn: null,
      sniffer: new H2Sniffer(),
      requestHeaders: [],
    };
    connections.push(connection);
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        const message = clientHelloMessage(buffered);
        if (!message) return;
        connection.hello = parseClientHello(message);
      } catch (e) {
        connection.error = (e as Error).message;
        socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      const raw = new Pass(socket, buffered);
      raw.on("error", () => {});
      const tlsSocket = new TLSSocket(raw, {
        isServer: true,
        secureContext,
        ALPNProtocols: ["h2", "http/1.1"],
      });
      tlsSocket.on("secure", () => onSecure(tlsSocket, connection));
      tlsSocket.on("error", (e) => {
        connection.error = e.message;
      });
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `https://localhost:${port}/`,
    connections: () => connections,
    h2: () => {
      const first = connections.find((c) => c.alpn === "h2" && c.sniffer.result().firstHeaders);
      return first ? first.sniffer.result() : null;
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
