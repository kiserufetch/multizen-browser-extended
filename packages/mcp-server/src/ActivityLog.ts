import { EventEmitter } from "node:events";

export interface ActivityEvent {
  id: string;
  timestamp: string;
  /** Tool name as called via MCP, e.g. "navigate" */
  tool: string;
  /** The name of the token that made the call. */
  actor?: string;
  profileId?: string;
  /** Sanitized args (no secrets) */
  args: Record<string, unknown>;
  /** "ok" if completed, "error" if threw, "pending" if still running */
  status: "pending" | "ok" | "error";
  /** Result summary or error message */
  summary?: string;
  durationMs?: number;
}

interface ActivityLogEvents {
  event: (e: ActivityEvent) => void;
}

/**
 * Emits ActivityEvent for every MCP tool call. The renderer subscribes
 * via IPC, the desktop app shows them in real-time, and they can also
 * be piped to a JSONL file for audit.
 */
export class ActivityLog extends EventEmitter {
  private readonly buffer: ActivityEvent[] = [];
  private readonly maxBuffer = 500;

  override on<K extends keyof ActivityLogEvents>(event: K, listener: ActivityLogEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof ActivityLogEvents>(
    event: K,
    ...args: Parameters<ActivityLogEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  startCall(tool: string, args: Record<string, unknown>, actor?: string): ActivityEvent {
    const event: ActivityEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      tool,
      ...(actor !== undefined ? { actor } : {}),
      profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
      args: sanitize(tool, args),
      status: "pending",
    };
    this.push(event);
    return event;
  }

  finish(event: ActivityEvent, status: "ok" | "error", summary: string, startedAt: number): void {
    event.status = status;
    event.summary = summary.slice(0, 500);
    event.durationMs = Date.now() - startedAt;
    this.emit("event", event);
  }

  /**
   * Something that happened to a handoff rather than a tool call, as `handoff.resumed` and
   * the like, with who did it. Never a frame or anything a person typed: there's no field
   * for it to go in.
   */
  recordLifecycle(name: string, fields: { profileId?: string; actor?: string; summary?: string }): void {
    this.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      tool: name,
      ...(fields.actor !== undefined ? { actor: fields.actor } : {}),
      ...(fields.profileId !== undefined ? { profileId: fields.profileId } : {}),
      args: {},
      status: "ok",
      ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    });
  }

  recent(limit = 200): ActivityEvent[] {
    return this.buffer.slice(-limit);
  }

  private push(e: ActivityEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    this.emit("event", e);
  }
}

const SELECTORS = ["ref", "selector"] as const;
const PROFILE = ["profile_id"] as const;
const PROFILE_AND_SESSION = ["profile_id", "sessionId"] as const;
const WAIT = [...PROFILE_AND_SESSION, "timeout_ms"] as const;
const DIALOG_MODE_FIELDS = ["mode", "alert", "confirm", "prompt", "beforeunload"] as const;

/**
 * The arguments each tool may put in the activity feed, which the desktop renders
 * and an operator can pipe to a file. An argument not named here is not logged, so
 * a new argument or a new tool stays private until someone decides otherwise. Left
 * out on purpose: `expression` and cdp `params` (page and session secrets),
 * `lease_id` (a capability), `prompt_text` (often a credential), and the seed and
 * notes of a profile. A test keeps this table in step with toolPolicy.ts.
 */
export const LOGGED_ARGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["list_profiles", []],
  ["list_fingerprint_options", []],
  [
    "create_profile",
    ["name", "tags", "engine", "display_mode", "proxy", "alignTimezoneToProxy", "strictGeoCoherence"],
  ],
  [
    "update_profile",
    [
      "profile_id",
      "name",
      "tags",
      "engine",
      "display_mode",
      "proxy",
      "alignTimezoneToProxy",
      "strictGeoCoherence",
    ],
  ],
  ["delete_profile", PROFILE],
  ["launch_profile", [...PROFILE, "display_mode"]],
  ["close_profile", PROFILE],
  ["extract", PROFILE],
  ["screenshot", PROFILE],
  ["probe_fingerprint", PROFILE],
  ["navigate", ["profile_id", "url"]],
  ["click", ["profile_id", "selector"]],
  ["type", ["profile_id", "selector", "text"]],
  ["click_ref", ["profile_id", "ref"]],
  ["type_ref", ["profile_id", "ref", "text"]],
  ["request_human", ["profile_id", "reason", "kind"]],
  ["wait_for_human", ["profile_id", "timeout_ms", "handoff_id"]],
  ["resume_human", PROFILE],
  ["get_human_status", ["profile_id", "handoff_id"]],
  ["cdp_send", [...PROFILE_AND_SESSION, "method"]],
  ["cdp_send_no_safety", [...PROFILE_AND_SESSION, "method"]],
  ["evaluate_js", PROFILE_AND_SESSION],
  ["wait_for_selector", [...WAIT, "selector"]],
  ["wait_for_navigation", WAIT],
  ["wait_for_load", WAIT],
  ["get_cookies", [...PROFILE_AND_SESSION, "urls"]],
  ["set_cookies", [...PROFILE_AND_SESSION, "cookies"]],
  ["list_tabs", PROFILE_AND_SESSION],
  ["new_tab", [...PROFILE_AND_SESSION, "url"]],
  ["activate_tab", [...PROFILE_AND_SESSION, "target_id"]],
  ["close_tab", [...PROFILE_AND_SESSION, "target_id"]],
  ["press_key", [...PROFILE, ...SELECTORS, "key"]],
  ["hover", [...PROFILE, ...SELECTORS]],
  ["select_option", [...PROFILE, ...SELECTORS, "value", "label", "index"]],
  ["scroll", [...PROFILE, ...SELECTORS, "delta_x", "delta_y"]],
  ["upload_file", [...PROFILE, ...SELECTORS, "files"]],
  ["list_downloads", PROFILE],
  ["get_download", ["profile_id", "download_id"]],
  ["set_dialog_policy", [...PROFILE, ...DIALOG_MODE_FIELDS]],
  ["list_dialogs", PROFILE],
  ["handle_dialog", ["profile_id", "action", "dialog_id"]],
  ["acquire_profile", ["profile_id", "ttl_ms"]],
  ["renew_profile", ["profile_id", "ttl_ms"]],
  ["release_profile", ["profile_id", "force"]],
]);

const MAX_LOGGED_CHARS = 200;
const MAX_LOGGED_ITEMS = 20;
const MAX_LOGGED_DEPTH = 3;

/** Bounds a logged value: an allowlisted argument can still be huge or deeply nested. */
function capped(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_LOGGED_CHARS
      ? `${value.slice(0, MAX_LOGGED_CHARS)}…[${value.length} chars]`
      : value;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_LOGGED_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LOGGED_ITEMS).map((item) => capped(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_LOGGED_ITEMS)
      .map(([k, v]) => [k, capped(v, depth + 1)]),
  );
}

function sanitize(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of LOGGED_ARGS.get(tool) ?? []) {
    if (!Object.hasOwn(args, k)) continue;
    const v = args[k];
    if (k === "text" && typeof v === "string") {
      // The `type` tool's text is keystrokes into page fields — it may be a
      // password or an OTP, and short ones (< 80 chars) used to be logged in
      // full. The activity feed renders in the desktop UI and can be piped to
      // an audit file, so never record the content. Keep only a length hint.
      out[k] = `[${v.length} chars]`;
    } else if (k === "proxy" && v && typeof v === "object") {
      // create_profile / update_profile args carry proxy username/password in
      // cleartext. NEVER log them — the activity feed is rendered in the desktop
      // UI and can be piped to an audit file. Keep only the non-secret shape.
      const p = v as {
        type?: unknown;
        host?: unknown;
        port?: unknown;
        username?: unknown;
        password?: unknown;
      };
      out[k] = { type: p.type, host: p.host, port: p.port, hasAuth: Boolean(p.username || p.password) };
    } else if (k === "cookies" && Array.isArray(v)) {
      // set_cookies args carry cookie values (session tokens) in cleartext.
      // Redact each value in the audit trail; keep name/domain/etc. for context.
      out[k] = capped(
        v.map((c) =>
          c && typeof c === "object" ? { ...(c as Record<string, unknown>), value: "***" } : c,
        ),
      );
    } else if (k === "files" && Array.isArray(v)) {
      // upload_file carries file contents as base64. Only the names are logged.
      out[k] = capped(
        v.map((f) =>
          f && typeof f === "object" ? (f as { file_name?: unknown }).file_name : undefined,
        ),
      );
    } else {
      out[k] = capped(v);
    }
  }
  return out;
}
