import { InMemoryHumanHandoff, type HumanHandoff } from "./handoff.js";
import { LeaseRegistry } from "./LeaseRegistry.js";
import { ProfileMutex, type MutexOptions } from "./ProfileMutex.js";

/**
 * What every MCP session of a process has to see the same. A transport builds one
 * server per session, so the app makes one of these and hands it to each of them.
 */
export interface SharedMcpState {
  handoff: HumanHandoff;
  mutex: ProfileMutex;
  leases: LeaseRegistry;
}

export function createSharedMcpState(
  opts: { handoff?: HumanHandoff; mutex?: MutexOptions; now?: () => number } = {},
): SharedMcpState {
  return {
    handoff: opts.handoff ?? new InMemoryHumanHandoff(),
    mutex: new ProfileMutex(opts.mutex),
    leases: new LeaseRegistry(opts.now ? { now: opts.now } : {}),
  };
}
