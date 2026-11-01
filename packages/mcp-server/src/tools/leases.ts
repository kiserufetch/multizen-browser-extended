import { z } from "zod";
import { MultizenError } from "@multizen/types";
import { assertProfileExists } from "../errorMapping.js";
import type { LeaseGrant } from "../LeaseRegistry.js";
import { leaseHolder } from "../toolGate.js";
import { ProfileIdSchema, type ExtensionTool, type ToolContext } from "./shared.js";

const AcquireSchema = ProfileIdSchema.extend({
  ttl_ms: z.number().int().positive().optional(),
  lease_id: z.string().min(1).optional(),
});
const RenewSchema = ProfileIdSchema.extend({
  lease_id: z.string().min(1),
  ttl_ms: z.number().int().positive().optional(),
});
const ReleaseSchema = ProfileIdSchema.extend({
  lease_id: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

const TTL_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Lease lifetime in ms (default 5 minutes, at most 1 hour)",
} as const;

function holderOf(ctx: ToolContext): ReturnType<typeof leaseHolder> {
  return leaseHolder(ctx.caller.principal, ctx.caller.sessionId);
}

function grantResult(grant: LeaseGrant): Record<string, unknown> {
  return {
    lease_id: grant.leaseId,
    profile_id: grant.profileId,
    expires_at: grant.expiresAt,
    ttl_ms: grant.ttlMs,
  };
}

export const LEASE_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "acquire_profile",
      description:
        "Take an exclusive lease on a profile: until it ends, other sessions can read the profile but get PROFILE_LEASED on anything that changes it. Optional: without a lease, sessions share the profile. Returns a lease_id; pass it again to reattach after a reconnect. The lease survives a dropped connection and lasts until its TTL, so renew it while you work and release it when done.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          ttl_ms: TTL_PROPERTY,
          lease_id: { type: "string", description: "An existing lease to reattach to" },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, ttl_ms: ttlMs, lease_id: leaseId } = AcquireSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      return grantResult(
        ctx.leases.acquire(id, holderOf(ctx), {
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(leaseId !== undefined ? { leaseId } : {}),
        }),
      );
    },
  },
  {
    definition: {
      name: "renew_profile",
      description: "Extend a lease before it runs out.",
      inputSchema: {
        type: "object",
        required: ["profile_id", "lease_id"],
        properties: {
          profile_id: { type: "string" },
          lease_id: { type: "string" },
          ttl_ms: TTL_PROPERTY,
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, lease_id: leaseId, ttl_ms: ttlMs } = RenewSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      return grantResult(ctx.leases.renew(id, holderOf(ctx), leaseId, ttlMs));
    },
  },
  {
    definition: {
      name: "release_profile",
      description:
        "End a lease. Pass the lease_id you hold; force ends someone else's and needs the operator group.",
      inputSchema: {
        type: "object",
        required: ["profile_id"],
        properties: {
          profile_id: { type: "string" },
          lease_id: { type: "string" },
          force: { type: "boolean" },
        },
      },
    },
    handler: async (args, ctx) => {
      const { profile_id: id, lease_id: leaseId, force } = ReleaseSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      if (force) {
        if (!ctx.caller.principal.tools.groups.includes("operator")) {
          throw new MultizenError("FORBIDDEN", "Force-releasing a lease needs the operator group");
        }
        return { released: ctx.leases.forceRelease(id) };
      }
      if (leaseId === undefined) {
        throw new MultizenError("INVALID_INPUT", "release_profile needs a lease_id, or force");
      }
      ctx.leases.release(id, holderOf(ctx), leaseId);
      return { released: true };
    },
  },
];
