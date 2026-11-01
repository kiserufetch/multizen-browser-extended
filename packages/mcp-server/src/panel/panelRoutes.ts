import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { ProfileManager } from "@multizen/profile-manager";
import {
  MultizenError,
  PROFILE_UPLOADS_DIR,
  UPLOAD_INBOX_DIR,
  type BrowserDriver,
  type CapturedFrame,
  type HumanInputEvent,
  type ProfileId,
} from "@multizen/types";
import type { ActivityLog } from "../ActivityLog.js";
import type { AuthFailureLimiter } from "../auth/AuthFailureLimiter.js";
import type { Principal } from "../auth/principal.js";
import type { HandoffRecord, HumanHandoff } from "../handoff.js";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  readRequestBody,
  RequestTooLargeError,
  type HttpRoute,
  type RouteContext,
} from "../HttpTransport.js";
import type { ProfileMutex } from "../ProfileMutex.js";
import { mayUseProfile } from "../toolGate.js";
import { planUploads, saveToInbox } from "../tools/interaction.js";
import { DEFAULT_MAX_INLINE_FILE_BYTES } from "../tools/shared.js";
import { PANEL_CSS, PANEL_FAVICON, PANEL_HTML, PANEL_JS } from "./assets.js";
import type { PanelSession, PanelSessions } from "./panelSessions.js";

const COOKIE_NAME = "mz_panel";
const LOGIN_BODY_LIMIT_BYTES = 8 * 1024;
const JSON_BODY_LIMIT_BYTES = 256 * 1024;
/** Five frames a second, whatever a client asks for: a frame costs the browser a repaint. */
const MIN_FRAME_INTERVAL_MS = 200;
/** A frame stays in memory only as long as someone is watching. */
const FRAME_RETAIN_MS = 1_000;
const INPUT_LOCK_WAIT_MS = 5_000;
/** Past this with no input from its owner, anyone may type. */
const INPUT_OWNER_IDLE_MS = 15_000;
const MAX_EVENTS_PER_REQUEST = 256;

/** Sent with everything under /panel. */
export const PANEL_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
};

const STATIC_ASSETS: ReadonlyMap<string, { type: string; body: string }> = new Map([
  ["/panel", { type: "text/html; charset=utf-8", body: PANEL_HTML }],
  ["/panel/", { type: "text/html; charset=utf-8", body: PANEL_HTML }],
  ["/panel/app.js", { type: "text/javascript; charset=utf-8", body: PANEL_JS }],
  ["/panel/app.css", { type: "text/css; charset=utf-8", body: PANEL_CSS }],
  ["/panel/favicon.svg", { type: "image/svg+xml", body: PANEL_FAVICON }],
]);

const Fraction = z.number().min(0).max(1);
const Modifiers = z.number().int().min(0).max(15);
const Delta = z.number().finite().min(-100_000).max(100_000);

const HumanInputSchema: z.ZodType<HumanInputEvent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: Fraction,
    y: Fraction,
    button: z.enum(["left", "right", "middle", "none"]),
    buttons: z.number().int().min(0).max(31),
    clickCount: z.number().int().min(0).max(8).optional(),
    modifiers: Modifiers.optional(),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: Fraction,
    y: Fraction,
    deltaX: Delta,
    deltaY: Delta,
    modifiers: Modifiers.optional(),
  }),
  z.object({
    kind: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(64),
    code: z.string().max(64),
    keyCode: z.number().int().min(0).max(1024),
    modifiers: Modifiers,
    text: z.string().max(16).optional(),
    location: z.number().int().min(0).max(3).optional(),
    repeat: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(16_384) }),
]);

const InputBodySchema = z.object({
  events: z.array(HumanInputSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
});
const LoginBodySchema = z.object({ token: z.string().max(1024) });
const ActivateTabSchema = z.object({ target_id: z.string().min(1).max(256) });
const DialogBodySchema = z.object({
  dialog_id: z.string().min(1).max(64).optional(),
  action: z.enum(["accept", "dismiss"]),
  prompt_text: z.string().max(16_384).optional(),
});
const ChooserBodySchema = z.object({
  chooser_id: z.string().min(1).max(64),
  cancel: z.boolean().optional(),
  files: z
    .array(z.object({ file_name: z.string().min(1).max(1024), data_base64: z.string() }))
    .max(32)
    .optional(),
});

export interface PanelRouteOptions {
  handoff: HumanHandoff;
  driver: BrowserDriver;
  /** So a person's input doesn't land in the middle of an agent's operation. */
  mutex: ProfileMutex;
  profiles: Pick<ProfileManager, "get">;
  sessions: PanelSessions;
  /** A token's principal if it is valid now. */
  authenticateToken: (token: string) => Principal | null;
  /** The same by id, per request, which is what makes revoking a token end its panel. */
  principalById: (id: string) => Principal | null;
  limiter?: AuthFailureLimiter;
  /** TLS, or an https public URL in front. */
  secureCookie: boolean;
  /** `--no-auth`: signing in takes no token. */
  noLogin?: boolean;
  /** Who did what: lifecycle only, never a frame or anything typed. */
  activityLog?: ActivityLog;
  maxUploadBytes?: number;
  /** For an operator's log. Gets the route and the error's code or name, never its message. */
  onError?: (route: string, code: string) => void;
}

/** Who is typing on one handoff, and what they have pressed but not yet let go. */
interface InputControl {
  ownerSession: string | null;
  ownerName: string | null;
  lastInputAt: number;
  heldKeys: Map<string, Extract<HumanInputEvent, { kind: "key" }>>;
  heldButtons: Map<string, Extract<HumanInputEvent, { kind: "mouse" }>>;
}

interface FrameSlot {
  capturedAt: number;
  frame: CapturedFrame | null;
  capturing: Promise<CapturedFrame> | null;
  forget: ReturnType<typeof setTimeout> | null;
}

/** The handoff ended under a request that was waiting its turn. */
class HandoffEnded extends Error {}

function send(
  res: ServerResponse,
  status: number,
  body: string | Uint8Array,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { ...PANEL_HEADERS, "content-type": type, ...extra }).end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  send(res, status, JSON.stringify(body), "application/json", extra);
}

function errorCode(e: unknown): string {
  if (e instanceof MultizenError) return e.code;
  return e instanceof Error ? e.name : "unknown";
}

function cookieValue(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

function releaseOf(event: Extract<HumanInputEvent, { kind: "key" | "mouse" }>): HumanInputEvent {
  if (event.kind === "mouse") return { ...event, action: "up", buttons: 0, clickCount: 1 };
  const { text: _text, repeat: _repeat, ...key } = event;
  return { ...key, action: "up", modifiers: 0 };
}

/**
 * The panel, on one HTTP route. Everything under /panel gets the same headers, and a browser
 * write needs an allowed Origin and a JSON body. No handler logs a body, and only a person's
 * lifecycle goes to the activity log: never frames, input or typed text.
 */
export function createPanelRoute(opts: PanelRouteOptions): HttpRoute {
  const { handoff, driver, mutex, profiles, sessions } = opts;
  const controls = new Map<string, InputControl>();
  const frames = new Map<string, FrameSlot>();
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_MAX_INLINE_FILE_BYTES;

  const cookieHeader = (value: string, attributes = ""): string =>
    `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/panel${
      opts.secureCookie ? "; Secure" : ""
    }${attributes}`;
  const clearedCookie = (): string => cookieHeader("", "; Max-Age=0");

  const forgetFrame = (id: string): void => {
    const slot = frames.get(id);
    if (slot?.forget) clearTimeout(slot.forget);
    frames.delete(id);
  };

  /** Up, for all that's down: a person who left mid-drag or mid-chord leaves nothing pressed. */
  const releaseHeld = async (profileId: ProfileId, control: InputControl): Promise<void> => {
    const held = [...control.heldKeys.values(), ...control.heldButtons.values()];
    control.heldKeys.clear();
    control.heldButtons.clear();
    if (held.length === 0) return;
    await mutex
      .run(
        profileId,
        async () => {
          for (const event of held) await driver.dispatchInput(profileId, releaseOf(event));
        },
        { timeoutMs: INPUT_LOCK_WAIT_MS },
      )
      .catch(() => {});
  };

  // Runs in the same tick as the handoff ending, before whoever waits on it gets to act,
  // so an agent's next call lines up behind this.
  handoff.onTransition((record) => {
    if (record.status === "pending") return;
    forgetFrame(record.id);
    const control = controls.get(record.id);
    controls.delete(record.id);
    if (control) void releaseHeld(record.profileId, control);
  });

  const controlOf = (id: string): InputControl => {
    let control = controls.get(id);
    if (!control) {
      control = {
        ownerSession: null,
        ownerName: null,
        lastInputAt: 0,
        heldKeys: new Map(),
        heldButtons: new Map(),
      };
      controls.set(id, control);
    }
    return control;
  };

  const takeControl = (
    record: HandoffRecord,
    control: InputControl,
    session: PanelSession,
    principal: Principal,
  ): void => {
    if (control.ownerSession === session.id) return;
    control.ownerSession = session.id;
    control.ownerName = principal.name;
    opts.activityLog?.recordLifecycle("handoff.control", {
      profileId: record.profileId,
      actor: principal.name,
    });
  };

  const handoffView = (record: HandoffRecord): Record<string, unknown> => ({
    id: record.id,
    profileId: record.profileId,
    profileName: profiles.get(record.profileId)?.name ?? record.profileId,
    kind: record.kind,
    reason: record.reason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    displayMode: driver.runningDisplayMode?.(record.profileId) ?? null,
  });

  const captureFrame = (record: HandoffRecord): Promise<CapturedFrame> => {
    const slot: FrameSlot = frames.get(record.id) ?? {
      capturedAt: 0,
      frame: null,
      capturing: null,
      forget: null,
    };
    frames.set(record.id, slot);
    if (slot.frame && Date.now() - slot.capturedAt < MIN_FRAME_INTERVAL_MS) {
      return Promise.resolve(slot.frame);
    }
    slot.capturing ??= driver
      .captureFrame(record.profileId)
      .then((frame) => {
        // The handoff may have ended during the capture: nothing of it stays.
        if (frames.get(record.id) === slot) {
          slot.frame = frame;
          slot.capturedAt = Date.now();
          if (slot.forget) clearTimeout(slot.forget);
          slot.forget = setTimeout(() => forgetFrame(record.id), FRAME_RETAIN_MS);
          slot.forget.unref?.();
        }
        return frame;
      })
      .finally(() => {
        slot.capturing = null;
      });
    return slot.capturing;
  };

  /** One event after another, each only while the handoff is still on. */
  const dispatchEvents = async (
    record: HandoffRecord,
    control: InputControl,
    session: PanelSession,
    events: readonly HumanInputEvent[],
  ): Promise<void> => {
    await mutex.run(
      record.profileId,
      async () => {
        for (const event of events) {
          if (handoff.get(record.id)?.status !== "pending") throw new HandoffEnded();
          if (event.kind === "key") {
            if (event.action === "down") control.heldKeys.set(event.code || event.key, event);
            else control.heldKeys.delete(event.code || event.key);
          } else if (event.kind === "mouse") {
            if (event.action === "down") control.heldButtons.set(event.button, event);
            else if (event.action === "up") control.heldButtons.delete(event.button);
          }
          await driver.dispatchInput(record.profileId, event);
        }
      },
      { timeoutMs: INPUT_LOCK_WAIT_MS, sessionId: `panel:${session.id}` },
    );
  };

  /** What a failure from the driver means to the page. */
  const sendDriverError = async (
    res: ServerResponse,
    record: HandoffRecord,
    route: string,
    e: unknown,
  ): Promise<void> => {
    const code = errorCode(e);
    if (e instanceof HandoffEnded || code === "PROFILE_NOT_RUNNING") {
      const current = handoff.get(record.id);
      sendJson(res, 409, { error: "not_pending", status: current?.status ?? "aborted" });
    } else if (code === "DIALOG_OPEN") {
      const dialogs = await driver.listDialogs(record.profileId).catch(() => []);
      sendJson(res, 423, { error: "dialog_open", dialogs });
    } else if (code === "TIMEOUT") {
      sendJson(res, 504, { error: "timeout" });
    } else if (code === "TAB_NOT_FOUND") {
      sendJson(res, 404, { error: "no_tab" });
    } else {
      opts.onError?.(route, code);
      sendJson(res, 500, { error: "internal" });
    }
  };

  const readJson = async (
    req: IncomingMessage,
    res: ServerResponse,
    limitBytes: number,
  ): Promise<{ body: unknown } | null> => {
    let raw: Buffer;
    try {
      raw = await readRequestBody(req, limitBytes);
    } catch (e) {
      if (e instanceof RequestTooLargeError) sendJson(res, 413, { error: "too_large" });
      else sendJson(res, 400, { error: "bad_body" });
      return null;
    }
    try {
      return { body: JSON.parse(raw.toString("utf8")) };
    } catch {
      sendJson(res, 400, { error: "bad_json" });
      return null;
    }
  };

  /** Body parsed by `schema`, or null when it already answered. Never echoes what it got. */
  const readBody = async <T>(
    req: IncomingMessage,
    res: ServerResponse,
    schema: z.ZodType<T>,
    limitBytes: number,
  ): Promise<T | null> => {
    const parsed = await readJson(req, res, limitBytes);
    if (!parsed) return null;
    const result = schema.safeParse(parsed.body);
    if (!result.success) {
      sendJson(res, 400, { error: "invalid_input" });
      return null;
    }
    return result.data;
  };

  /** The page's own writes only: a browser can't hide Origin, nor a form send JSON. */
  const writeAllowed = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean => {
    if (!req.headers.origin || !ctx.originAllowed) {
      req.resume();
      sendJson(res, 403, { error: "bad_origin" });
      return false;
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      req.resume();
      sendJson(res, 415, { error: "json_required" });
      return false;
    }
    return true;
  };

  const refused = (res: ServerResponse, address: string): boolean => {
    const waitMs = opts.limiter?.retryAfterMs(address) ?? 0;
    if (waitMs > 0) {
      sendJson(
        res,
        429,
        { error: "rate_limited", retry_after_ms: waitMs },
        { "retry-after": String(Math.ceil(waitMs / 1000)) },
      );
      return true;
    }
    opts.limiter?.recordFailure(address);
    return false;
  };

  const handleLogin = async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<void> => {
    if (!writeAllowed(req, res, ctx)) return;
    const body = await readBody(req, res, LoginBodySchema, LOGIN_BODY_LIMIT_BYTES);
    if (!body) return;
    const principal = opts.authenticateToken(body.token);
    if (!principal) {
      if (!refused(res, ctx.clientAddress)) sendJson(res, 401, { error: "bad_token" });
      return;
    }
    if (!principal.panel) {
      sendJson(res, 403, { error: "no_operator" });
      return;
    }
    sendJson(res, 200, { name: principal.name }, { "set-cookie": cookieHeader(sessions.create(principal.id)) });
  };

  /** A desktop's own window. The redirect takes the code out of the address and history. */
  const handleCodeLogin = (res: ServerResponse, url: URL, ctx: RouteContext): void => {
    const principalId = sessions.redeemCode(url.searchParams.get("code") ?? "");
    const principal = principalId !== null ? opts.principalById(principalId) : null;
    if (!principal?.panel) {
      if (!refused(res, ctx.clientAddress)) send(res, 302, "", "text/plain", { location: "/panel" });
      return;
    }
    send(res, 302, "", "text/plain", {
      location: "/panel",
      "set-cookie": cookieHeader(sessions.create(principal.id)),
    });
  };

  const handleHandoffRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
    who: { session: PanelSession; principal: Principal },
    id: string,
    action: string,
  ): Promise<void> => {
    const { session, principal } = who;
    const record = handoff.get(id);
    // Outside its scope a handoff doesn't exist, rather than being someone else's.
    if (!record || !mayUseProfile(principal, record.profileId)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const isRead = action === "frame" || action === "state";
    if (req.method !== (isRead ? "GET" : "POST")) {
      res.setHeader("allow", isRead ? "GET" : "POST");
      req.resume();
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!isRead && !writeAllowed(req, res, ctx)) return;
    if (record.status !== "pending") {
      req.resume();
      sendJson(res, 409, { error: "not_pending", status: record.status });
      return;
    }
    const { profileId } = record;

    switch (action) {
      case "frame": {
        try {
          const frame = await captureFrame(record);
          send(res, 200, frame.jpeg, "image/jpeg", {
            "x-frame-width": String(frame.viewport.width),
            "x-frame-height": String(frame.viewport.height),
          });
        } catch (e) {
          await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "state": {
        try {
          const [tabs, dialogs, fileChoosers] = await Promise.all([
            driver.listTabs(profileId) as Promise<{
              targetInfos?: Array<{
                targetId: string;
                type: string;
                subtype?: string;
                title?: string;
                url?: string;
              }>;
              activeTargetId?: string | null;
            }>,
            driver.listDialogs(profileId),
            driver.listFileChoosers?.(profileId) ?? Promise.resolve([]),
          ]);
          const control = controls.get(id);
          const ownerActive =
            control?.ownerSession &&
            Date.now() - control.lastInputAt < INPUT_OWNER_IDLE_MS &&
            control.ownerSession !== session.id;
          sendJson(res, 200, {
            ...handoffView(record),
            now: new Date().toISOString(),
            tabs: (tabs.targetInfos ?? [])
              .filter((t) => t.type === "page" && !t.subtype)
              .map((t) => ({
                targetId: t.targetId,
                title: t.title ?? "",
                url: t.url ?? "",
                active: t.targetId === tabs.activeTargetId,
              })),
            dialogs,
            fileChoosers,
            otherOwner: ownerActive ? control.ownerName : null,
          });
        } catch (e) {
          await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "input": {
        const body = await readBody(req, res, InputBodySchema, JSON_BODY_LIMIT_BYTES);
        if (!body) return;
        const control = controlOf(id);
        if (
          control.ownerSession &&
          control.ownerSession !== session.id &&
          Date.now() - control.lastInputAt < INPUT_OWNER_IDLE_MS
        ) {
          sendJson(res, 409, { error: "input_owned", owner: control.ownerName });
          return;
        }
        takeControl(record, control, session, principal);
        control.lastInputAt = Date.now();
        try {
          await dispatchEvents(record, control, session, body.events);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "take-control": {
        const body = await readBody(req, res, z.object({}), LOGIN_BODY_LIMIT_BYTES);
        if (!body) return;
        const control = controlOf(id);
        await releaseHeld(profileId, control);
        takeControl(record, control, session, principal);
        control.lastInputAt = Date.now();
        sendJson(res, 200, { ok: true });
        return;
      }
      case "activate-tab": {
        const body = await readBody(req, res, ActivateTabSchema, LOGIN_BODY_LIMIT_BYTES);
        if (!body) return;
        try {
          await mutex.run(
            profileId,
            async () => {
              if (handoff.get(id)?.status !== "pending") throw new HandoffEnded();
              await driver.activateTab(profileId, body.target_id);
            },
            { timeoutMs: INPUT_LOCK_WAIT_MS, sessionId: `panel:${session.id}` },
          );
          forgetFrame(id);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "dialog": {
        const body = await readBody(req, res, DialogBodySchema, JSON_BODY_LIMIT_BYTES);
        if (!body) return;
        try {
          // Not under the profile's lock: whatever holds it may be stuck behind this dialog.
          await driver.handleDialog(profileId, {
            action: body.action,
            ...(body.dialog_id !== undefined ? { dialogId: body.dialog_id } : {}),
            ...(body.prompt_text !== undefined ? { promptText: body.prompt_text } : {}),
          });
          const control = controls.get(id);
          if (control) await releaseHeld(profileId, control);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          if (errorCode(e) === "INVALID_INPUT") sendJson(res, 404, { error: "no_dialog" });
          else await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "file-chooser": {
        const body = await readBody(req, res, ChooserBodySchema, DEFAULT_MAX_REQUEST_BYTES);
        if (!body) return;
        try {
          await answerChooser(driver, profiles, profileId, body, maxUploadBytes);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          const code = errorCode(e);
          if (code === "FILE_TOO_LARGE") sendJson(res, 413, { error: "too_large" });
          else if (code === "INVALID_INPUT") sendJson(res, 400, { error: "invalid_input" });
          else await sendDriverError(res, record, action, e);
        }
        return;
      }
      case "resume":
      case "abort": {
        const body = await readBody(req, res, z.object({}), LOGIN_BODY_LIMIT_BYTES);
        if (!body) return;
        const ended =
          action === "resume"
            ? handoff.resumeById(id, principal.name)
            : handoff.abortById(id, principal.name);
        if (ended) sendJson(res, 200, { ok: true });
        else sendJson(res, 409, { error: "not_pending", status: handoff.get(id)?.status });
        return;
      }
      default:
        sendJson(res, 404, { error: "not_found" });
    }
  };

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: RouteContext,
  ): Promise<void> => {
    const path = url.pathname;
    if (path === "/panel/api/login" && req.method === "POST") {
      await handleLogin(req, res, ctx);
      return;
    }

    const cookie = cookieValue(req);
    const session = cookie ? sessions.find(cookie) : null;
    const principal = session ? opts.principalById(session.principalId) : null;
    if (!cookie || !session || !principal?.panel) {
      if (cookie) sessions.destroy(cookie);
      req.resume();
      sendJson(
        res,
        401,
        { error: "unauthenticated", no_login: opts.noLogin === true },
        cookie ? { "set-cookie": clearedCookie() } : {},
      );
      return;
    }

    if (path === "/panel/api/me" && req.method === "GET") {
      sendJson(res, 200, { name: principal.name });
      return;
    }
    if (path === "/panel/api/logout" && req.method === "POST") {
      if (!writeAllowed(req, res, ctx)) return;
      sessions.destroy(cookie);
      req.resume();
      sendJson(res, 200, { ok: true }, { "set-cookie": clearedCookie() });
      return;
    }
    if (path === "/panel/api/handoffs" && req.method === "GET") {
      const visible = handoff
        .pending()
        .filter((p) => mayUseProfile(principal, p.profileId))
        .flatMap((p) => {
          const record = handoff.get(p.handoffId);
          return record ? [handoffView(record)] : [];
        });
      sendJson(res, 200, { handoffs: visible, now: new Date().toISOString() });
      return;
    }
    const match = /^\/panel\/api\/handoffs\/([^/]+)\/([a-z-]+)$/.exec(path);
    if (match) {
      await handleHandoffRoute(req, res, ctx, { session, principal }, match[1]!, match[2]!);
      return;
    }
    req.resume();
    sendJson(res, 404, { error: "not_found" });
  };

  return async (req, res, url, ctx) => {
    const path = url.pathname;
    if (path !== "/panel" && !path.startsWith("/panel/")) return false;

    if (path.startsWith("/panel/api/")) {
      try {
        await handleApi(req, res, url, ctx);
      } catch (e) {
        opts.onError?.(path.split("/").pop() ?? "", errorCode(e));
        if (!res.headersSent) sendJson(res, 500, { error: "internal" });
        else res.end();
      }
      return true;
    }
    if (path === "/panel/login" && req.method === "GET") {
      handleCodeLogin(res, url, ctx);
      return true;
    }
    const asset = STATIC_ASSETS.get(path);
    if (!asset) {
      send(res, 404, "not found", "text/plain; charset=utf-8");
      return true;
    }
    if (req.method !== "GET") {
      req.resume();
      send(res, 405, "method not allowed", "text/plain; charset=utf-8", { allow: "GET" });
      return true;
    }
    send(res, 200, asset.body, asset.type);
    return true;
  };
}

/** Files from the person's machine, by the same rules as upload_file's base64. */
async function answerChooser(
  driver: BrowserDriver,
  profiles: Pick<ProfileManager, "get">,
  profileId: ProfileId,
  body: z.infer<typeof ChooserBodySchema>,
  maxUploadBytes: number,
): Promise<void> {
  if (body.cancel) {
    await driver.dismissFileChooser?.(profileId, body.chooser_id);
    return;
  }
  const dataDir = profiles.get(profileId)?.dataDir;
  if (!dataDir || !body.files || body.files.length === 0 || !driver.respondFileChooser) {
    throw new MultizenError("INVALID_INPUT", "No files, or nowhere to put them.");
  }
  const chooser = (await driver.listFileChoosers?.(profileId))?.find((c) => c.id === body.chooser_id);
  if (!chooser || (!chooser.multiple && body.files.length > 1)) {
    throw new MultizenError("INVALID_INPUT", "No such chooser, or too many files for it.");
  }
  const planned = await planUploads(body.files, [], maxUploadBytes);
  const inbox = join(dataDir, PROFILE_UPLOADS_DIR, UPLOAD_INBOX_DIR);
  const { paths, cleanup } = await saveToInbox(inbox, planned);
  try {
    await driver.respondFileChooser(profileId, body.chooser_id, paths);
  } catch (e) {
    await cleanup();
    throw e;
  }
}
