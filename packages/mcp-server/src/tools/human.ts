import { ProfileIdSchema, type ExtensionTool } from "./shared.js";

export const HUMAN_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "get_human_status",
      description:
        "Check without blocking whether a profile is waiting for a human after request_human. Returns { pending, status, reason?, since? }; status is pending or none.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: { profile_id: { type: "string" } },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id } = ProfileIdSchema.parse(args);
      const pending = ctx.handoff.pending().find((p) => p.profileId === id);
      return pending
        ? { pending: true, status: "pending", reason: pending.reason, since: pending.since }
        : { pending: false, status: "none" };
    },
  },
];
