import { MultizenError } from "@multizen/types";
import type { Principal } from "./auth/principal.js";
import { policyFor, type ToolHints, type ToolPolicy } from "./toolPolicy.js";

function mayUse(principal: Principal, tool: string, policy: ToolPolicy): boolean {
  return principal.tools.groups.includes(policy.group) || principal.tools.names.includes(tool);
}

/** tools/list: what this principal may call, with its annotations. No policy, no tool. */
export function visibleTools<T extends { name: string }>(
  definitions: readonly T[],
  principal: Principal,
): Array<T & { annotations: ToolHints }> {
  return definitions.flatMap((definition) => {
    const policy = policyFor(definition.name);
    return policy && mayUse(principal, definition.name, policy)
      ? [{ ...definition, annotations: policy.annotations }]
      : [];
  });
}

/**
 * Every tools/call goes through here, before the tool's own validation, so a
 * caller learns nothing about a tool it may not use. No policy means refused, for
 * every principal.
 */
export async function runGated<T>(
  tool: string,
  args: Record<string, unknown>,
  ctx: { principal: Principal },
  run: () => Promise<T>,
): Promise<T> {
  const policy = policyFor(tool);
  if (!policy) {
    throw new MultizenError("FORBIDDEN", `Unknown tool: ${tool}`, {
      hint: "Call tools/list for the tools this token can use.",
    });
  }
  if (!mayUse(ctx.principal, tool, policy)) {
    throw new MultizenError("FORBIDDEN", `This token may not call ${tool}`);
  }
  const { profile_id: profileId } = args;
  if (
    policy.scope === "profile" &&
    ctx.principal.profiles !== "*" &&
    typeof profileId === "string" &&
    !ctx.principal.profiles.includes(profileId)
  ) {
    throw new MultizenError("FORBIDDEN", `This token may not use profile ${profileId}`);
  }
  return run();
}
