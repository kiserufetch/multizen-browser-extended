import { z } from "zod";
import type { ProfileId } from "@multizen/types";
import { MultizenError } from "@multizen/types";
import { assertProfileRunning } from "../errorMapping.js";
import { HANDOFF_KINDS, type HandoffRecord } from "../handoff.js";
import { ProfileIdSchema, type ExtensionTool, type ToolContext } from "./shared.js";

const DEFAULT_WAIT_MS = 50_000;
/** Under the MCP SDK client's 60 s timeout, so the answer gets read. */
const MAX_WAIT_MS = 55_000;

const RequestHumanSchema = ProfileIdSchema.extend({
  reason: z.string().min(1),
  kind: z.enum(HANDOFF_KINDS).optional(),
});
const WaitForHumanSchema = ProfileIdSchema.extend({
  timeout_ms: z.number().int().positive().optional(),
  handoff_id: z.string().min(1).optional(),
});
const HumanStatusSchema = ProfileIdSchema.extend({ handoff_id: z.string().min(1).optional() });

function notFound(id: string): MultizenError {
  return new MultizenError("HANDOFF_NOT_FOUND", `No handoff ${id} on this profile.`, {
    hint: "Handoffs don't outlive the server, or more than an hour of being finished. If the human step is still needed, call request_human.",
  });
}

/** A handoff of this profile by id, so one agent's id can't read another profile's. */
function byId(ctx: ToolContext, profileId: ProfileId, id: string): HandoffRecord {
  const record = ctx.handoff.get(id);
  if (!record || record.profileId !== profileId) throw notFound(id);
  return record;
}

function statusFields(record: HandoffRecord): Record<string, unknown> {
  return {
    status: record.status,
    handoff_id: record.id,
    kind: record.kind,
    reason: record.reason,
    since: record.createdAt,
    expires_at: record.expiresAt,
    ...(record.settledAt !== undefined ? { settled_at: record.settledAt } : {}),
    ...(record.settledBy !== undefined ? { settled_by: record.settledBy } : {}),
  };
}

export const HUMAN_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "get_human_status",
      description:
        "Check without blocking how a handoff from request_human stands. Returns { pending, status, ... }; status is pending, resumed, aborted, expired, or none when this profile has had no handoff lately. Only resumed means the person did the step. Pass handoff_id to ask about one in particular; an id this server doesn't know, as after a restart, gets HANDOFF_NOT_FOUND.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          handoff_id: { type: "string", description: "Id from request_human" },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, handoff_id: handoffId } = HumanStatusSchema.parse(args);
      const record = handoffId ? byId(ctx, id, handoffId) : ctx.handoff.latestForProfile(id);
      if (!record) return { pending: false, status: "none" };
      return { pending: record.status === "pending", ...statusFields(record) };
    },
  },
];

/** The tools whose definitions stay in TOOL_DEFINITIONS, where they always were. */
export const HUMAN_HANDLERS: ReadonlyMap<string, ExtensionTool["handler"]> = new Map<
  string,
  ExtensionTool["handler"]
>([
  [
    "request_human",
    async (args, ctx) => {
      const { profile_id: id, reason, kind } = RequestHumanSchema.parse(args);
      assertProfileRunning(ctx.browserDriver, id);
      const record = ctx.handoff.request(id, reason, {
        ...(kind ? { kind } : {}),
        requestedBy: ctx.caller.principal.name,
      });
      // Surface the window to the operator (best-effort; don't fail the call). A verb, not
      // cdp_send: Camoufox has no CDP.
      await ctx.browserDriver.performAction(id, { type: "bring_to_front" }).catch(() => {});
      return {
        status: "waiting_for_human",
        handoff_id: record.id,
        handoff_status: record.status,
        kind: record.kind,
        reason: record.reason,
        expires_at: record.expiresAt,
        note: `A human must complete this step (e.g. CAPTCHA/2FA): in the browser window, or for a profile with no window (headless, xvfb) ${ctx.handoffGate ? "in the handoff panel at /panel on this server" : "in the desktop app's handoff panel; plain stdio has no panel"}. Repeat wait_for_human, or poll get_human_status, until the status is no longer pending. Only resumed means they did it; aborted and expired mean you must not assume so.`,
      };
    },
  ],
  [
    "wait_for_human",
    async (args, ctx) => {
      const { profile_id: id, timeout_ms: timeoutMs, handoff_id: handoffId } =
        WaitForHumanSchema.parse(args);
      const known = handoffId ? byId(ctx, id, handoffId) : ctx.handoff.latestForProfile(id);
      if (!known) {
        // A desktop's agents were told this returns at once when nothing is pending.
        if (!ctx.handoffGate) {
          assertProfileRunning(ctx.browserDriver, id);
          return { resumed: true, timedOut: false, status: "none" };
        }
        throw new MultizenError("HANDOFF_NOT_FOUND", `Profile ${id} has no handoff on record.`, {
          hint: "Handoffs don't outlive the server. If the human step is still needed, call request_human.",
        });
      }
      const budget = Math.min(timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
      const record = (await ctx.handoff.waitForId(known.id, budget)) ?? known;
      return {
        resumed: record.status === "resumed",
        timedOut: record.status === "pending",
        status: record.status,
        handoff_id: record.id,
      };
    },
  ],
  [
    "resume_human",
    async (args, ctx) => {
      const { profile_id: id } = ProfileIdSchema.parse(args);
      const active = ctx.handoff.activeForProfile(id);
      if (active) ctx.handoff.resumeById(active.id, ctx.caller.principal.name);
      return { ok: true };
    },
  ],
]);
