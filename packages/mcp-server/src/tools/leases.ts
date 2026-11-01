import { z } from "zod";
import { MultizenError } from "@multizen/types";
import { assertProfileExists } from "../errorMapping.js";
import { ProfileIdSchema, type ExtensionTool } from "./shared.js";

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

/** Refuses rather than handing out a lease nothing would enforce. */
function leasesUnavailable(tool: string): MultizenError {
  return new MultizenError(
    "UNSUPPORTED_ON_ENGINE",
    `${tool} is not available in this build: profile leases are not enforced yet.`,
    { hint: "Without a lease, calls work as usual and sessions share the profile." },
  );
}

const TTL_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Lease lifetime in ms (default 5 minutes, at most 1 hour)",
} as const;

export const LEASE_TOOLS: ExtensionTool[] = [
  {
    definition: {
      name: "acquire_profile",
      description:
        "Take an exclusive lease on a profile, so other sessions get PROFILE_LEASED on it until it ends. Optional: without a lease, sessions share the profile. Returns a lease_id; pass it again to reattach after a reconnect.",
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
      const { profile_id: id } = AcquireSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      throw leasesUnavailable("acquire_profile");
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
      const { profile_id: id } = RenewSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      throw leasesUnavailable("renew_profile");
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
      const { profile_id: id } = ReleaseSchema.parse(args);
      assertProfileExists(ctx.profileManager, id);
      throw leasesUnavailable("release_profile");
    },
  },
];
