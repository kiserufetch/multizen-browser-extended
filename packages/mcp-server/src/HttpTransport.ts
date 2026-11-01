import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { isIPv6 } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { clientAddress, type AuthFailureLimiter } from "./auth/AuthFailureLimiter.js";
import { FULL_PRINCIPAL, type Principal } from "./auth/principal.js";

/**
 * Covers `upload_file`'s largest file: 16 MiB is 22.4 MB once in base64, plus the JSON
 * around it. The SDK would cap legacy SSE at 4 MB, so POST bodies are read here.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 22 * 1024 * 1024;

const SWEEP_MIN_INTERVAL_MS = 25;
const SWEEP_MAX_INTERVAL_MS = 30_000;

export interface RouteContext {
  /** Null on a public route, which has to authenticate by its own means. */
  principal: Principal | null;
  /** Whom to hold a failed attempt against. Honours `trustProxy`. */
  clientAddress: string;
  /**
   * The request's Origin is absent or ours. A route taking a browser's writes also
   * wants it present, which `req.headers.origin` tells.
   */
  originAllowed: boolean;
}

/** Answers and returns true, or returns false to pass the request on. */
export type HttpRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
) => Promise<boolean>;

export interface ReadyState {
  ready: boolean;
  [key: string]: unknown;
}

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** Optional bearer token; if set, requests must send Authorization: Bearer <token> */
  authToken?: string;
  /** Decides who a request is, or null to refuse it. Takes over from `authToken`. */
  authenticate?: (req: IncomingMessage) => Principal | null;
  /**
   * Factory that builds a FRESH MCP server for each session. A single
   * `Server` instance can only be bound to one transport at a time, so every
   * connection gets its own — sharing the heavy deps (ProfileManager,
   * BrowserDriver, ActivityLog) via the closure that creates them.
   */
  createServer: () => McpServer;
  /**
   * SSE keep-alive heartbeat interval in ms. A comment line is written to each
   * open SSE stream so idle connections aren't silently dropped by the OS /
   * intermediaries. Set to 0 to disable. Default 15000.
   */
  heartbeatMs?: number;
  /**
   * Host header values to accept besides our own loopback endpoint. `name` matches
   * any port or none, for proxies that drop it and mapped ports; `name:port` only that.
   */
  allowedHosts?: string[];
  /** Origins to accept besides those of the allowed hosts. */
  allowedOrigins?: string[];
  tls?: { cert: Buffer; key: Buffer };
  /** Off unless given: a desktop's sessions live until it quits. */
  sessionPolicy?: {
    /** A session with no call in flight and no request for this long is closed. */
    idleTtlMs?: number;
    /** Past this, a new session gets SESSION_LIMIT. */
    maxSessions?: number;
    /**
     * One token's share. Past it, its own oldest idle session is closed for the new one, so one
     * client leaking sessions costs nobody else. With none idle, the new one gets SESSION_LIMIT.
     */
    maxSessionsPerPrincipal?: number;
  };
  /** POST bodies above this get 413 FILE_TOO_LARGE. Default {@link DEFAULT_MAX_REQUEST_BYTES}. */
  maxRequestBytes?: number;
  /**
   * What all POST bodies still being read or handled may add up to. Past it a request gets 503
   * RATE_LIMITED: the per-request limit alone lets a few clients hold the whole heap. Off unless given.
   */
  maxBodyBytesInFlight?: number;
  /** Sockets beyond this are dropped by the OS-level accept. Off unless given. */
  maxConnections?: number;
  /** /healthz answers only `{ok:true}`, to anyone. Default: as any other route, behind auth. */
  publicHealthz?: boolean;
  /** Tried before authentication, for a request with an allowed Host. */
  publicRoutes?: HttpRoute[];
  /** Tried after authentication and the Host and Origin checks, before the MCP routes. */
  authedRoutes?: HttpRoute[];
  /** Called with the session id whenever a session ends, for any reason. */
  onSessionClosed?: (sessionKey: string) => void;
  /** Counts refused credentials per client address and answers 429 past its limit. */
  authFailureLimiter?: AuthFailureLimiter;
  /** A proxy we run is in front: take the client's address from X-Forwarded-For. */
  trustProxy?: boolean;
  /** What /readyz reports, behind auth. Without it there is no such route. */
  readyState?: () => ReadyState | Promise<ReadyState>;
}

interface Session {
  /** Whose it is: any other principal's request on it gets 403. */
  principalId: string;
  lastActivityAt: number;
  /** Requests still owed an answer. A session with any isn't idle, however long they take. */
  inFlight: Set<string | number>;
}

interface SseSession extends Session {
  transport: SSEServerTransport;
  server: McpServer;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface StreamableSession extends Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

type AuthedRequest = IncomingMessage & { auth?: AuthInfo };

interface HostName {
  name: string;
  port?: string;
}

/**
 * Lower-cased, without a root dot, and without a port the scheme implies: a client or
 * proxy may drop it, or spell it out. Rebinding only ever changes the name, so the port
 * isn't what keeps a page out.
 */
function parseHost(value: string): HostName | null {
  const text = value.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(text) ?? /^([^:[\]\s/]+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const port = match[2];
  return {
    name: match[1]!.replace(/\.$/, ""),
    ...(port !== undefined && port !== "80" && port !== "443" ? { port } : {}),
  };
}

/**
 * Keeps the session's idea of what it owes up to date. The SDK sends no answer to a
 * cancelled request, so that end has to be read from the notification.
 */
function trackActivity(transport: Transport, session: Session): void {
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    session.lastActivityAt = Date.now();
    if (isJSONRPCRequest(message)) {
      session.inFlight.add(message.id);
    } else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
      if (requestId !== undefined) session.inFlight.delete(requestId);
    }
    deliver?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      session.lastActivityAt = Date.now();
      if (message.id !== undefined) session.inFlight.delete(message.id);
    }
    return send(message, options);
  };
}

/**
 * HTTP transport so external MCP clients (Cursor, Claude Desktop) can connect
 * to the running desktop app, not just spawn a stdio child.
 *
 * Supports both transports:
 *   - Streamable HTTP (primary): POST/GET/DELETE /mcp
 *   - HTTP+SSE (legacy/back-compat): GET /sse + POST /messages?sessionId=…
 *   - GET /healthz — liveness + per-transport session counts
 *   - GET /readyz — engine state, when the app gives a `readyState`
 *
 * Every connection is bound to its own freshly-created `Server` and tracked by
 * session id, so a reconnect can never clobber the active session's binding
 * (the bug behind "MCP accepts the SSE connection but never initialises") and a
 * second client cannot wedge the first. On shutdown all sockets are forcibly
 * destroyed so `before-quit` can never hang waiting on a keep-alive SSE stream.
 *
 * A request runs: /healthz if public, public routes, authentication, /healthz,
 * /readyz, authed routes, then the MCP routes.
 */
export class HttpTransport {
  private readonly server: HttpServer | HttpsServer;
  private readonly opts: HttpTransportOptions;
  private readonly heartbeatMs: number;
  private readonly maxRequestBytes: number;
  private readonly allowedHosts: HostName[];
  private readonly allowedOrigins: Set<string>;
  private readonly sseSessions = new Map<string, SseSession>();
  private readonly streamableSessions = new Map<string, StreamableSession>();
  /** Initializing, so not in the map yet: a burst must not pass the limit between the two. */
  private openingSessions = 0;
  private readonly openingByPrincipal = new Map<string, number>();
  private bodyBytesInFlight = 0;
  private sweep: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(opts: HttpTransportOptions) {
    this.opts = opts;
    this.heartbeatMs = opts.heartbeatMs ?? 15000;
    this.maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    const host = opts.host ?? "127.0.0.1";
    const self = isIPv6(host) ? `[${host}]` : host;
    // Only requests whose Host header names our own endpoint are accepted
    // (DNS-rebinding defence). Pair with authToken — the Host allowlist alone no
    // longer protects it.
    this.allowedHosts = [
      `${self}:${opts.port}`,
      `127.0.0.1:${opts.port}`,
      `localhost:${opts.port}`,
      ...(opts.allowedHosts ?? []),
    ].map((entry) => {
      const parsed = parseHost(entry);
      if (!parsed) throw new Error(`Not a host or host:port: "${entry}"`);
      return parsed;
    });
    // A browser page can send cross-origin requests to our loopback port
    // (DNS-rebinding / CSRF against the local MCP server). Native MCP clients
    // (Cursor, Claude Desktop, Codex) are not browsers and send no Origin, so
    // a present Origin must name one of our own endpoints or we reject it (MCP
    // transport security, 2025-06-18+).
    this.allowedOrigins = new Set((opts.allowedOrigins ?? []).map((o) => o.toLowerCase()));
    const listener = (req: IncomingMessage, res: ServerResponse): void => {
      void this.handle(req, res).catch((e) => {
        process.stderr.write(`[mcp-http] unhandled request error: ${String(e)}\n`);
        if (!res.headersSent) res.writeHead(500).end("internal error");
        else res.end();
      });
    };
    this.server = opts.tls
      ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, listener)
      : createHttpServer(listener);
    if (opts.maxConnections !== undefined) this.server.maxConnections = opts.maxConnections;
  }

  async start(): Promise<void> {
    // Guardrail: this server exposes browser-control tools on loopback. Warn
    // loudly if started without a token rather than failing silently open.
    if (!this.opts.authToken && !this.opts.authenticate) {
      process.stderr.write(
        "[multizen] WARNING: MCP HTTP transport starting WITHOUT an auth token — " +
          "the local control port is UNAUTHENTICATED and any local process can drive it.\n",
      );
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.opts.port, this.opts.host ?? "127.0.0.1");
    });
    const idleTtlMs = this.opts.sessionPolicy?.idleTtlMs;
    if (idleTtlMs !== undefined) {
      this.sweep = setInterval(
        () => this.closeIdleSessions(idleTtlMs),
        Math.min(SWEEP_MAX_INTERVAL_MS, Math.max(SWEEP_MIN_INTERVAL_MS, idleTtlMs / 4)),
      );
      this.sweep.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweep) clearInterval(this.sweep);

    // Close every tracked session. Closing the transport ends its HTTP
    // response and fires its onclose, which tears down the bound server and
    // clears the heartbeat. Snapshot first so the onclose-driven map deletes
    // don't mutate what we're iterating.
    for (const session of [...this.sseSessions.values()]) {
      await session.transport.close().catch(() => {});
    }
    this.sseSessions.clear();

    for (const session of [...this.streamableSessions.values()]) {
      await session.transport.close().catch(() => {});
    }
    this.streamableSessions.clear();

    // Forcibly destroy any lingering keep-alive sockets so the close callback
    // actually fires. Without this, an open SSE stream keeps `server.close()`
    // pending forever and the app can only be killed via Task Manager.
    this.server.closeAllConnections?.();

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Snapshot of live sessions — surfaced via /healthz for diagnostics. */
  status(): { sse: number; streamable: number } {
    return { sse: this.sseSessions.size, streamable: this.streamableSessions.size };
  }

  /**
   * Ends every session of a token that stopped being valid. Closing a transport aborts
   * what its calls wait on, so its queued calls go too, and its streams end.
   */
  async closeSessionsFor(principalId: string): Promise<void> {
    await Promise.all(
      [...this.sseSessions.values(), ...this.streamableSessions.values()]
        .filter((session) => session.principalId === principalId)
        .map((session) => session.transport.close().catch(() => {})),
    );
  }

  private closeIdleSessions(idleTtlMs: number): void {
    const cutoff = Date.now() - idleTtlMs;
    for (const session of [...this.sseSessions.values(), ...this.streamableSessions.values()]) {
      if (session.inFlight.size === 0 && session.lastActivityAt <= cutoff) {
        void session.transport.close().catch(() => {});
      }
    }
  }

  /** True if this principal can have one more: closes its oldest idle sessions when it has to. */
  private madeRoomFor(principalId: string, cap: number): boolean {
    const own = [...this.sseSessions.values(), ...this.streamableSessions.values()].filter(
      (session) => session.principalId === principalId,
    );
    const excess = own.length + (this.openingByPrincipal.get(principalId) ?? 0) + 1 - cap;
    if (excess <= 0) return true;
    const idle = own
      .filter((session) => session.inFlight.size === 0)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    if (idle.length < excess) return false;
    for (const session of idle.slice(0, excess)) void session.transport.close().catch(() => {});
    return true;
  }

  /** True when it answered: a new session would go past `sessionPolicy`'s limits. */
  private refusedBySessionLimit(res: ServerResponse, principalId: string): boolean {
    const perPrincipal = this.opts.sessionPolicy?.maxSessionsPerPrincipal;
    if (perPrincipal !== undefined && !this.madeRoomFor(principalId, perPrincipal)) {
      jsonRpcError(res, 503, -32000, `SESSION_LIMIT: this token has ${perPrincipal} sessions, all busy.`, {
        code: "SESSION_LIMIT",
        retryable: true,
      });
      return true;
    }
    const max = this.opts.sessionPolicy?.maxSessions;
    const open = this.sseSessions.size + this.streamableSessions.size + this.openingSessions;
    if (max === undefined || open < max) return false;
    jsonRpcError(res, 503, -32000, `SESSION_LIMIT: this server already has ${open} open sessions.`, {
      code: "SESSION_LIMIT",
      retryable: true,
    });
    return true;
  }

  /** Constant-time bearer check; false if no/incorrect token when one is required. */
  private authOk(req: IncomingMessage, token: string): boolean {
    const expected = Buffer.from(`Bearer ${token}`);
    const got = Buffer.from(req.headers.authorization ?? "");
    // Length check first — timingSafeEqual throws on unequal lengths, and the
    // length itself isn't the secret.
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  private principalOf(req: IncomingMessage): Principal | null {
    if (this.opts.authenticate) return this.opts.authenticate(req);
    const token = this.opts.authToken;
    if (!token) return FULL_PRINCIPAL; // auth disabled
    return this.authOk(req, token) ? FULL_PRINCIPAL : null;
  }

  /**
   * A refused credential. Past the limit it is 429 for that address, but only a wrong
   * token gets this far, so nobody sharing the address can lock out a right one.
   */
  private refuseCredential(res: ServerResponse, address: string): void {
    const limiter = this.opts.authFailureLimiter;
    if (limiter) {
      const waitMs = limiter.retryAfterMs(address);
      if (waitMs > 0) {
        res
          .writeHead(429, {
            "content-type": "application/json",
            "retry-after": String(Math.ceil(waitMs / 1000)),
          })
          .end(
            JSON.stringify({
              error: "rate_limited",
              code: "RATE_LIMITED",
              retryable: true,
              details: { retry_after_ms: waitMs },
            }),
          );
        return;
      }
      limiter.recordFailure(address);
    }
    res.writeHead(401, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: "unauthorized",
        detail: this.opts.authenticate
          ? "Send 'Authorization: Bearer <token>' with a valid, unexpired token."
          : "Send 'Authorization: Bearer <token>'. The token is shown in MultiZen → Settings → MCP, or in the 'mcp-token' file in the app data directory.",
      }),
    );
  }

  private matchesAllowedHost(value: string): boolean {
    const host = parseHost(value);
    if (!host) return false;
    return this.allowedHosts.some(
      (allowed) =>
        allowed.name === host.name && (allowed.port === undefined || allowed.port === host.port),
    );
  }

  /** Host header must name an endpoint of ours (DNS-rebinding defence). */
  private hostAllowed(req: IncomingMessage): boolean {
    return this.matchesAllowedHost(req.headers.host ?? "");
  }

  /**
   * Origin, when present, must name our own endpoint or a configured origin. Native
   * MCP clients send no Origin header (allowed); only a browser attaches one, and
   * a cross-origin browser request is exactly the DNS-rebinding / CSRF vector
   * the MCP transport-security guidance tells us to reject.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.allowedOrigins.has(origin.toLowerCase())) return true;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return /^https?:$/.test(parsed.protocol) && this.matchesAllowedHost(parsed.host);
  }

  /** Combined client gate: correct Host and (if present) Origin. */
  private localClientAllowed(req: IncomingMessage): boolean {
    return this.hostAllowed(req) && this.originAllowed(req);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      res.writeHead(503).end("shutting down");
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    const pathname = url.pathname;

    // Says only that the process answers, so a probe needs no token and no right Host.
    if (pathname === "/healthz" && this.opts.publicHealthz) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    const address = clientAddress(req, this.opts.trustProxy);
    if (this.opts.publicRoutes && this.hostAllowed(req)) {
      const ctx = { principal: null, clientAddress: address, originAllowed: this.originAllowed(req) };
      for (const route of this.opts.publicRoutes) {
        if (await route(req, res, url, ctx)) return;
      }
    }

    const principal = this.principalOf(req);
    if (!principal) {
      this.refuseCredential(res, address);
      return;
    }
    // The SDK hands this to each tool handler as `extra.authInfo`.
    (req as AuthedRequest).auth = {
      token: "",
      clientId: principal.id,
      scopes: [],
      extra: { principal },
    };

    // /healthz stays auth-gated above but skips Host checks so local probes work.
    if (pathname === "/healthz") {
      const status = this.status();
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          name: "multizen-mcp",
          sessions: status,
          connected: status.sse + status.streamable > 0,
        }),
      );
      return;
    }

    if (pathname === "/readyz" && this.opts.readyState) {
      const state = await this.opts.readyState();
      res
        .writeHead(state.ready ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ ...state, sessions: this.status() }));
      return;
    }

    if (this.opts.authedRoutes && this.localClientAllowed(req)) {
      const ctx = { principal, clientAddress: address, originAllowed: true };
      for (const route of this.opts.authedRoutes) {
        if (await route(req, res, url, ctx)) return;
      }
    }

    // Streamable HTTP (primary) — single endpoint for GET/POST/DELETE.
    // DNS-rebinding defence: Host must name our endpoint.
    if (pathname === "/mcp") {
      if (!this.localClientAllowed(req)) {
        res.writeHead(403).end("forbidden host or origin");
        return;
      }
      await this.handleStreamable(req, res, principal);
      return;
    }

    // Legacy HTTP+SSE.
    if (pathname === "/sse" && req.method === "GET") {
      if (!this.localClientAllowed(req)) {
        res.writeHead(403).end("forbidden host or origin");
        return;
      }
      await this.handleSseConnect(res, principal);
      return;
    }
    if (pathname === "/messages" && req.method === "POST") {
      if (!this.localClientAllowed(req)) {
        res.writeHead(403).end("forbidden host or origin");
        return;
      }
      await this.handleSsePost(req, res, url, principal);
      return;
    }

    res.writeHead(404).end("not found");
  }

  /**
   * The JSON of a POST body, within the limit, or `undefined` when it already answered.
   * Only called once the caller is authenticated and the session is theirs.
   */
  private async readPostBody(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ body: unknown } | undefined> {
    const account = this.bodyAccount(res);
    let raw: Buffer;
    try {
      raw = await readRequestBody(req, this.maxRequestBytes, account);
    } catch (e) {
      if (e instanceof BodyBudgetError) {
        res.setHeader("retry-after", String(BODY_BUDGET_RETRY_AFTER_S));
        jsonRpcError(res, 503, -32000, `RATE_LIMITED: ${e.message}`, {
          code: "RATE_LIMITED",
          retryable: true,
          details: { retry_after_ms: BODY_BUDGET_RETRY_AFTER_S * 1000 },
        });
      } else if (e instanceof RequestTooLargeError) {
        jsonRpcError(res, 413, -32000, `FILE_TOO_LARGE: ${e.message}`, {
          code: "FILE_TOO_LARGE",
          retryable: false,
          details: { max_bytes: this.maxRequestBytes },
        });
      } else {
        jsonRpcError(res, 400, -32700, `Parse error: ${(e as Error).message}`);
      }
      return undefined;
    }
    try {
      return { body: JSON.parse(raw.toString("utf8")) };
    } catch (e) {
      jsonRpcError(res, 400, -32700, `Parse error: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Charges a body to the budget as it arrives, the size it declares up front. It stays charged
   * until its response ends, as its parsed form lives as long as the call does.
   */
  private bodyAccount(res: ServerResponse): ((bytes: number) => void) | undefined {
    const budget = this.opts.maxBodyBytesInFlight;
    if (budget === undefined) return undefined;
    let charged = 0;
    res.once("close", () => {
      this.bodyBytesInFlight -= charged;
      charged = 0;
    });
    return (bytes) => {
      if (bytes <= charged) return;
      if (this.bodyBytesInFlight + bytes - charged > budget) {
        throw new BodyBudgetError(`Requests in flight hold this server's ${budget} bytes for bodies.`);
      }
      this.bodyBytesInFlight += bytes - charged;
      charged = bytes;
    };
  }

  /**
   * A dropped POST never reaches the SDK as such: with no DELETE its session lives on,
   * and so would a call still waiting for the profile, to fire on whatever the page
   * shows by then. The answer has nowhere to go anyway, as no event store is kept.
   */
  private armClientGone(req: AuthedRequest, res: ServerResponse): void {
    const gone = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    if (req.auth?.extra) req.auth.extra.clientGone = gone.signal;
  }

  // ── Streamable HTTP ──────────────────────────────────────────────────────
  private async handleStreamable(
    req: AuthedRequest,
    res: ServerResponse,
    principal: Principal,
  ): Promise<void> {
    const sessionId = headerValue(req.headers["mcp-session-id"]);

    if (sessionId) {
      const existing = this.streamableSessions.get(sessionId);
      if (!existing) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      if (existing.principalId !== principal.id) {
        jsonRpcError(res, 403, -32000, "This session belongs to another token");
        return;
      }
      existing.lastActivityAt = Date.now();
      if (req.method !== "POST") {
        await existing.transport.handleRequest(req, res);
        return;
      }
      const parsed = await this.readPostBody(req, res);
      if (!parsed) return;
      this.armClientGone(req, res);
      await existing.transport.handleRequest(req, res, parsed.body);
      return;
    }

    // No session id → only valid as an initialization POST that opens one.
    if (req.method !== "POST") {
      jsonRpcError(res, 400, -32000, "Bad Request: missing mcp-session-id");
      return;
    }

    const parsed = await this.readPostBody(req, res);
    if (!parsed) return;

    if (!isInitializeRequest(parsed.body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: no valid session ID provided");
      return;
    }
    if (this.refusedBySessionLimit(res, principal.id)) return;

    const server = this.opts.createServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.streamableSessions.set(sid, session);
      },
    });
    const session: StreamableSession = {
      transport,
      server,
      principalId: principal.id,
      lastActivityAt: Date.now(),
      inFlight: new Set(),
    };
    // Idempotent teardown. server.close() closes the transport, whose onclose
    // re-enters here — the guard stops that from recursing into a stack
    // overflow while still releasing the per-session server exactly once.
    let torndown = false;
    transport.onclose = () => {
      if (torndown) return;
      torndown = true;
      const sid = transport.sessionId;
      if (sid) {
        this.streamableSessions.delete(sid);
        this.opts.onSessionClosed?.(sid);
      }
      void server.close().catch(() => {});
    };

    this.openingSessions += 1;
    this.openingByPrincipal.set(principal.id, (this.openingByPrincipal.get(principal.id) ?? 0) + 1);
    try {
      await server.connect(transport);
      trackActivity(transport, session);
      this.armClientGone(req, res);
      await transport.handleRequest(req, res, parsed.body);
    } catch (e) {
      await transport.close().catch(() => {});
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
      process.stderr.write(`[mcp-http] streamable init failed: ${String(e)}\n`);
    } finally {
      this.openingSessions -= 1;
      const opening = (this.openingByPrincipal.get(principal.id) ?? 1) - 1;
      if (opening > 0) this.openingByPrincipal.set(principal.id, opening);
      else this.openingByPrincipal.delete(principal.id);
    }
  }

  // ── Legacy HTTP+SSE ──────────────────────────────────────────────────────
  private async handleSseConnect(res: ServerResponse, principal: Principal): Promise<void> {
    if (this.refusedBySessionLimit(res, principal.id)) return;

    const server = this.opts.createServer();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    const session: SseSession = {
      transport,
      server,
      principalId: principal.id,
      lastActivityAt: Date.now(),
      inFlight: new Set(),
    };

    // Single idempotent teardown shared by transport.onclose and res 'close'.
    let torndown = false;
    const cleanup = (): void => {
      if (torndown) return;
      torndown = true;
      if (session.heartbeat) clearInterval(session.heartbeat);
      this.sseSessions.delete(sessionId);
      this.opts.onSessionClosed?.(sessionId);
      void server.close().catch(() => {});
    };
    transport.onclose = cleanup;
    res.on("close", cleanup);

    this.sseSessions.set(sessionId, session);

    try {
      // connect() calls transport.start(), which writes 200 + `event: endpoint`.
      await server.connect(transport);
      trackActivity(transport, session);
    } catch (e) {
      cleanup();
      if (!res.headersSent) res.writeHead(500).end("failed to start SSE session");
      else res.end();
      process.stderr.write(`[mcp-http] SSE connect failed: ${String(e)}\n`);
      return;
    }

    if (this.heartbeatMs > 0) {
      session.heartbeat = setInterval(() => {
        // A comment line is a no-op for the client but keeps the socket warm
        // and surfaces a broken pipe so we can tear the session down.
        try {
          res.write(": ping\n\n");
        } catch {
          cleanup();
        }
      }, this.heartbeatMs);
      // Don't let the heartbeat timer hold the process open on its own.
      session.heartbeat.unref?.();
    }
  }

  private async handleSsePost(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
  ): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? this.sseSessions.get(sessionId) : undefined;
    if (!session) {
      res.writeHead(404).end("no SSE session for sessionId");
      return;
    }
    if (session.principalId !== principal.id) {
      res.writeHead(403).end("this session belongs to another token");
      return;
    }
    session.lastActivityAt = Date.now();
    const parsed = await this.readPostBody(req, res);
    if (!parsed) return;
    // The SDK reads `null` as nothing parsed, and would wait on a body already consumed.
    if (parsed.body === null) {
      res.writeHead(400).end("Invalid message: null");
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res, parsed.body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end((e as Error).message);
      else res.end();
    }
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function jsonRpcError(
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(httpStatus, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message, ...(data ? { data } : {}) },
      id: null,
    }),
  );
}

export class RequestTooLargeError extends Error {}
class BodyBudgetError extends Error {}

const BODY_BUDGET_RETRY_AFTER_S = 1;

/**
 * The whole body, up to a limit. Past it the rest is still read and thrown away rather
 * than the socket being cut: a client still sending would otherwise lose the answer to
 * a reset. Node's own request timeout bounds a client that never stops. `account` hears of
 * the size so far, the declared size first, and throws to refuse the request the same way.
 */
export function readRequestBody(
  req: IncomingMessage,
  limitBytes: number,
  account?: (bytes: number) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): RequestTooLargeError =>
      new RequestTooLargeError(`The request is over the ${limitBytes} byte limit.`);
    const declared = Number(req.headers["content-length"]);
    if (declared > limitBytes) {
      req.resume();
      reject(tooLarge());
      return;
    }
    try {
      if (declared > 0) account?.(declared);
    } catch (e) {
      req.resume();
      reject(e as Error);
      return;
    }
    let chunks: Buffer[] | null = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (!chunks) return;
      size += chunk.length;
      if (size > limitBytes) {
        chunks = null;
        reject(tooLarge());
        return;
      }
      try {
        account?.(size);
      } catch (e) {
        chunks = null;
        reject(e as Error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => reject(e));
    // Gone mid-body, which may raise neither. Harmless after the body has arrived.
    req.on("close", () => reject(new Error("the connection closed before the body ended")));
  });
}
