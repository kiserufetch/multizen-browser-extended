import { MultizenError, type BrowserDriver, type ProfileId } from "@multizen/types";
import type { Principal } from "./auth/principal.js";
import type { LeaseHolder } from "./LeaseRegistry.js";
import { MUTEX_WAIT_MS, type MutexRunOptions } from "./ProfileMutex.js";
import type { SharedMcpState } from "./sharedState.js";
import { leaseBinds, policyFor, type ToolHints, type ToolPolicy } from "./toolPolicy.js";

/** A wait_* call's budget when it names none: what `dispatch` polls for. */
const WAIT_TOOL_DEFAULT_MS = 30_000;
/** Enough for a turn on a free profile, however little of its budget a wait has left. */
const POLL_MIN_LOCK_WAIT_MS = 1_000;

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

export interface GateContext {
  principal: Principal;
  /** The MCP session. A transport with none (stdio) has the one session anyway. */
  sessionId: string;
  /** Aborted when the client cancels this call or its connection closes. */
  signal?: AbortSignal;
  shared: SharedMcpState;
  driver: BrowserDriver;
}

export function leaseHolder(principal: Principal, sessionId: string): LeaseHolder {
  return { principalId: principal.id, principalName: principal.name, sessionId };
}

/** The same driver, with some of its methods replaced for this one call. */
function withOverrides(driver: BrowserDriver, overrides: Partial<BrowserDriver>): BrowserDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A wait_* tool polls through evaluateJs. It holds the profile per poll, not for the
 * whole wait, so what it is waiting for can happen. `admit` runs at each turn, because
 * a poll can outlive whatever let the call in.
 */
function pollingDriver(
  ctx: GateContext,
  profileId: ProfileId,
  args: Record<string, unknown>,
  admit: () => void,
  lockOptions: MutexRunOptions,
): BrowserDriver {
  const { driver, shared } = ctx;
  const budgetMs = typeof args.timeout_ms === "number" ? args.timeout_ms : WAIT_TOOL_DEFAULT_MS;
  const endsAt = Date.now() + budgetMs;
  return withOverrides(driver, {
    evaluateJs: (id, expression, sessionId) =>
      shared.mutex.run(
        profileId,
        async () => {
          admit();
          return driver.evaluateJs(id, expression, sessionId);
        },
        {
          ...lockOptions,
          timeoutMs: Math.min(MUTEX_WAIT_MS, Math.max(POLL_MIN_LOCK_WAIT_MS, endsAt - Date.now())),
        },
      ),
  });
}

/**
 * Every tools/call goes through here, before the tool's own validation, so a
 * caller learns nothing about a tool it may not use. No policy means refused, for
 * every principal. `run` gets the driver the tool should use.
 */
export async function runGated<T>(
  tool: string,
  args: Record<string, unknown>,
  ctx: GateContext,
  run: (driver: BrowserDriver) => Promise<T>,
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
  if (policy.scope !== "profile" || typeof profileId !== "string") return run(ctx.driver);
  if (ctx.principal.profiles !== "*" && !ctx.principal.profiles.includes(profileId)) {
    throw new MultizenError("FORBIDDEN", `This token may not use profile ${profileId}`);
  }

  const { mutex, leases } = ctx.shared;
  const admit = (): void => {
    if (leaseBinds(policy)) leases.assertAccess(profileId, leaseHolder(ctx.principal, ctx.sessionId));
  };
  admit();
  if (policy.preempts) {
    mutex.rejectWaiters(
      profileId,
      new MultizenError("PROFILE_NOT_RUNNING", `Profile ${profileId} was closed while this call waited.`),
    );
  }

  const lockOptions: MutexRunOptions = {
    sessionId: ctx.sessionId,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  switch (policy.lock) {
    case "none":
      return run(ctx.driver);
    case "iteration":
      return run(pollingDriver(ctx, profileId, args, admit, lockOptions));
    case "op":
      return mutex.run(
        profileId,
        async () => {
          // A lease can have been taken during the wait.
          admit();
          return run(
            withOverrides(ctx.driver, {
              // A launch waiting for a browser slot is another queue a client can leave.
              launch: (id, opts) =>
                ctx.driver.launch(id, ctx.signal ? { ...opts, signal: ctx.signal } : opts),
            }),
          );
        },
        lockOptions,
      );
  }
}
