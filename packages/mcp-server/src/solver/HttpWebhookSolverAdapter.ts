import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CHALLENGE_KINDS,
  MultizenError,
  type CaptchaSolverPort,
  type ChallengeKind,
  type DriverAction,
  type HumanInputEvent,
  type SolverOutcome,
  type SolverPagePort,
  type SolverTask,
  type SolverTokenPayload,
} from "@multizen/types";
import { sameSecret } from "../auth/principal.js";
import { readRequestBody, RequestTooLargeError, type HttpRoute } from "../HttpTransport.js";

const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_MAX_BODY_BYTES = 256 * 1024;

interface ActiveWebhookSession {
  taskId: string;
  sessionToken: string;
  page: SolverPagePort;
  expiresAtMs: number;
  settle: (outcome: SolverOutcome) => void;
}

/**
 * Registry of ephemeral per-task tokens for the `/solver/v1/tasks/:taskId/*` callback routes.
 * A token is valid only for its single taskId and expires the moment the task settles or aborts.
 */
export class SolverWebhookSessions {
  private readonly sessions = new Map<string, ActiveWebhookSession>();

  register(opts: {
    taskId: string;
    page: SolverPagePort;
    expiresAtMs: number;
    settle: (outcome: SolverOutcome) => void;
  }): string {
    const sessionToken = randomBytes(32).toString("base64url");
    this.sessions.set(opts.taskId, {
      ...opts,
      sessionToken,
    });
    return sessionToken;
  }

  authenticate(taskId: string, bearerToken: string | null): ActiveWebhookSession | null {
    if (!bearerToken) return null;
    const entry = this.sessions.get(taskId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAtMs) {
      this.sessions.delete(taskId);
      return null;
    }
    if (!sameSecret(bearerToken, entry.sessionToken)) return null;
    return entry;
  }

  revoke(taskId: string): void {
    this.sessions.delete(taskId);
  }
}

export interface HttpWebhookSolverAdapterOptions {
  id?: string;
  name?: string;
  webhookUrl: string;
  webhookSecret?: string;
  apiKey?: string;
  /** Base URL where the remote solver can reach this MultiZen server (e.g. http://127.0.0.1:7777). */
  callbackBaseUrl: () => string;
  sessions: SolverWebhookSessions;
  supportedKinds?: readonly ChallengeKind[];
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

function isImmediateOutcome(value: unknown): value is SolverOutcome {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return status === "solved" || status === "failed" || status === "unsupported";
}

export class HttpWebhookSolverAdapter implements CaptchaSolverPort {
  readonly id: string;
  readonly name: string;
  readonly capabilities: {
    kinds: readonly ChallengeKind[];
    modes: readonly ("token" | "interactive")[];
  };
  private readonly opts: HttpWebhookSolverAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: HttpWebhookSolverAdapterOptions) {
    this.opts = opts;
    this.id = opts.id ?? "webhook";
    this.name = opts.name ?? "HTTP Webhook Solver Port";
    this.capabilities = {
      kinds: opts.supportedKinds ?? CHALLENGE_KINDS,
      modes: ["token", "interactive"],
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  }

  async solve(
    task: SolverTask,
    page: SolverPagePort,
    signal: AbortSignal,
  ): Promise<SolverOutcome> {
    let settleFn: ((outcome: SolverOutcome) => void) | undefined;
    const settledPromise = new Promise<SolverOutcome>((resolve) => {
      settleFn = resolve;
    });

    const expiresAtMs = new Date(task.expiresAt).getTime();
    const sessionToken = this.opts.sessions.register({
      taskId: task.taskId,
      page,
      expiresAtMs,
      settle: (outcome) => settleFn?.(outcome),
    });

    const baseUrl = this.opts.callbackBaseUrl().replace(/\/+$/, "");
    const body = JSON.stringify({
      taskId: task.taskId,
      handoffId: task.handoffId ?? null,
      profileId: task.profileId,
      reason: task.reason ?? null,
      challenge: task.challenge,
      network: task.network,
      endpoints: {
        baseUrl: `${baseUrl}/solver/v1/tasks/${encodeURIComponent(task.taskId)}`,
        sessionToken,
      },
      createdAt: task.createdAt,
      expiresAt: task.expiresAt,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "multizen-server",
    };
    if (this.opts.apiKey) {
      headers["authorization"] = `Bearer ${this.opts.apiKey}`;
    }
    if (this.opts.webhookSecret) {
      const sig = createHmac("sha256", this.opts.webhookSecret).update(body).digest("hex");
      headers["x-multizen-signature"] = `sha256=${sig}`;
    }

    const onAbort = (): void => {
      settleFn?.({
        status: "failed",
        reason: "Solver task was aborted or timed out.",
        retryable: true,
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const reqSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.requestTimeoutMs),
      ]);
      const res = await this.fetchImpl(this.opts.webhookUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: reqSignal,
      });

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          status: "failed",
          reason: `Solver webhook answered HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }

      const text = await res.text();
      if (text.trim() !== "") {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (isImmediateOutcome(parsed)) {
            return parsed;
          }
        } catch {
          // Non-JSON or pending ack body: wait for callback /settle.
        }
      }

      return await settledPromise;
    } catch (e) {
      return {
        status: "failed",
        reason: `Solver webhook request failed: ${(e as Error).message}`,
        retryable: true,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.opts.sessions.revoke(task.taskId);
    }
  }

  async healthcheck(): Promise<{ ok: boolean; latencyMs?: number; details?: Record<string, unknown> }> {
    const start = Date.now();
    try {
      const headers: Record<string, string> = { "user-agent": "multizen-server" };
      if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;
      const res = await this.fetchImpl(this.opts.webhookUrl, {
        method: "HEAD",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      await res.body?.cancel().catch(() => {});
      // A POST-only webhook endpoint often returns 405 Method Not Allowed on HEAD, which still proves reachability.
      const ok = res.ok || res.status === 405;
      return {
        ok,
        latencyMs: Date.now() - start,
        details: { status: res.status },
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        details: { error: (e as Error).message },
      };
    }
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(payload));
}

function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

async function parseJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const buf = await readRequestBody(req, CALLBACK_MAX_BODY_BYTES);
    if (buf.length === 0) return {};
    const parsed = JSON.parse(buf.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "bad_json_object" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      sendJson(res, 413, { error: "payload_too_large" });
      return null;
    }
    sendJson(res, 400, { error: "invalid_json" });
    return null;
  }
}

/**
 * Public HTTP route handling `/solver/v1/tasks/:taskId/:verb`.
 * Authenticated exclusively via the ephemeral per-task `sessionToken` issued to the webhook.
 */
export function createSolverRoute(sessions: SolverWebhookSessions): HttpRoute {
  return async (req, res, url) => {
    const match = /^\/solver\/v1\/tasks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;

    let taskId: string;
    let verb: string;
    try {
      taskId = decodeURIComponent(match[1]!);
      verb = decodeURIComponent(match[2]!);
    } catch {
      sendJson(res, 400, { error: "bad_path" });
      return true;
    }

    const session = sessions.authenticate(taskId, bearerFrom(req));
    if (!session) {
      sendJson(res, 401, { error: "invalid_or_expired_solver_session" });
      return true;
    }

    try {
      if (verb === "frame" && req.method === "GET") {
        const qualityParam = url.searchParams.get("quality");
        const quality = qualityParam ? Number.parseInt(qualityParam, 10) : undefined;
        const frame = await session.page.captureFrame(
          quality && Number.isFinite(quality) ? { quality } : undefined,
        );
        if (url.searchParams.get("format") === "json") {
          sendJson(res, 200, {
            jpegBase64: Buffer.from(frame.jpeg).toString("base64"),
            viewport: frame.viewport,
            targetId: frame.targetId,
            url: frame.url,
          });
          return true;
        }
        res
          .writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(frame.jpeg.byteLength),
            "cache-control": "no-store",
            "x-multizen-viewport-width": String(frame.viewport.width),
            "x-multizen-viewport-height": String(frame.viewport.height),
            "x-multizen-target-id": frame.targetId,
          })
          .end(Buffer.from(frame.jpeg));
        return true;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }

      const body = await parseJsonObject(req, res);
      if (!body) return true;

      switch (verb) {
        case "extract": {
          const out = await session.page.extract();
          sendJson(res, 200, out);
          return true;
        }
        case "input": {
          await session.page.dispatchInput(body as unknown as HumanInputEvent);
          sendJson(res, 200, { ok: true });
          return true;
        }
        case "action": {
          if (body.type === "click_ref" && typeof body.ref === "string") {
            const out = await session.page.clickRef(body.ref);
            sendJson(res, 200, out);
            return true;
          }
          if (
            body.type === "type_ref" &&
            typeof body.ref === "string" &&
            typeof body.text === "string"
          ) {
            const out = await session.page.typeRef(body.ref, body.text);
            sendJson(res, 200, out);
            return true;
          }
          const out = await session.page.performAction(body as unknown as DriverAction);
          sendJson(res, 200, out);
          return true;
        }
        case "evaluate-isolated": {
          if (typeof body.expression !== "string" || body.expression.length === 0) {
            sendJson(res, 400, { error: "expression_required" });
            return true;
          }
          const result = await session.page.evaluateIsolatedJs(body.expression);
          sendJson(res, 200, { result });
          return true;
        }
        case "evaluate-main": {
          if (typeof body.expression !== "string" || body.expression.length === 0) {
            sendJson(res, 400, { error: "expression_required" });
            return true;
          }
          const result = await session.page.evaluateMainWorldJs(body.expression);
          sendJson(res, 200, { result });
          return true;
        }
        case "apply-token": {
          if (typeof body.token !== "string" || body.token.length === 0) {
            sendJson(res, 400, { error: "token_required" });
            return true;
          }
          const out = await session.page.applyToken(body as unknown as SolverTokenPayload);
          sendJson(res, 200, out);
          return true;
        }
        case "cookies": {
          if (Array.isArray(body.cookies)) {
            const out = await session.page.setCookies(body.cookies);
            sendJson(res, 200, out);
            return true;
          }
          const urls = Array.isArray(body.urls)
            ? body.urls.filter((u): u is string => typeof u === "string")
            : undefined;
          const out = await session.page.getCookies(urls);
          sendJson(res, 200, out);
          return true;
        }
        case "settle": {
          if (!isImmediateOutcome(body)) {
            sendJson(res, 400, { error: "invalid_solver_outcome" });
            return true;
          }
          session.settle(body);
          sessions.revoke(taskId);
          sendJson(res, 200, { ok: true });
          return true;
        }
        default:
          sendJson(res, 404, { error: "unknown_solver_endpoint" });
          return true;
      }
    } catch (e) {
      if (e instanceof MultizenError) {
        const status = e.code === "FORBIDDEN" ? 403 : e.code === "INVALID_INPUT" ? 400 : 500;
        sendJson(res, status, { error: e.code, message: e.message });
        return true;
      }
      sendJson(res, 500, { error: "internal_error", message: (e as Error).message });
      return true;
    }
  };
}
