import type { ProfileId } from "@multizen/types";

/**
 * What a token may do, by tool group. The tool-to-group table is in toolPolicy.ts.
 * `operator` holds resume_human and panel access, apart from `profile-admin` so a
 * prompt-injected agent can't release its own handoff.
 */
export const TOOL_GROUPS = ["read", "act", "profile-admin", "raw", "operator"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface Principal {
  id: string;
  name: string;
  full: boolean;
  tools: { groups: ToolGroup[]; names: string[] };
  profiles: "*" | ProfileId[];
  /** Derived: panel access comes only from the `operator` group. */
  panel: boolean;
}

export function createPrincipal(init: Omit<Principal, "panel">): Principal {
  return { ...init, panel: init.tools.groups.includes("operator") };
}

/** The desktop's mcp-token and stdio: everything, as before tokens had permissions. */
export const FULL_PRINCIPAL: Principal = createPrincipal({
  id: "full",
  name: "full",
  full: true,
  tools: { groups: [...TOOL_GROUPS], names: [] },
  profiles: "*",
});

/** The part of the SDK's request `extra` that carries HttpTransport's `req.auth`. */
export interface PrincipalCarrier {
  authInfo?: { extra?: Record<string, unknown> };
}

export function principalFrom(
  extra: PrincipalCarrier | undefined,
  fallback: Principal = FULL_PRINCIPAL,
): Principal {
  return (extra?.authInfo?.extra?.principal as Principal | undefined) ?? fallback;
}

/**
 * What a call may wait on. The SDK aborts `extra.signal` when the client cancels or the
 * session closes; HttpTransport adds its signal for the client's connection dropping.
 */
export function callSignal(extra: PrincipalCarrier & { signal: AbortSignal }): AbortSignal {
  const gone = extra.authInfo?.extra?.clientGone as AbortSignal | undefined;
  return gone ? AbortSignal.any([extra.signal, gone]) : extra.signal;
}
