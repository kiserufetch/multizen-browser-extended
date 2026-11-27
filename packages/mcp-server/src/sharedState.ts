import { InMemoryHumanHandoff, type HumanHandoff } from "./handoff.js";
import { LeaseRegistry } from "./LeaseRegistry.js";
import { ProfileMutex, type MutexOptions } from "./ProfileMutex.js";
import { SolverCoordinator, type SolverCoordinatorOptions } from "./solver/SolverCoordinator.js";

/**
 * What every MCP session of a process has to see the same. A transport builds one
 * server per session, so the app makes one of these and hands it to each of them.
 */
export interface SharedMcpState {
  handoff: HumanHandoff;
  mutex: ProfileMutex;
  leases: LeaseRegistry;
  solver: SolverCoordinator;
}

export function createSharedMcpState(
  opts: {
    handoff?: HumanHandoff;
    mutex?: MutexOptions;
    now?: () => number;
    solver?: SolverCoordinator;
    solverOptions?: Omit<SolverCoordinatorOptions, "handoff">;
  } = {},
): SharedMcpState {
  const handoff = opts.handoff ?? new InMemoryHumanHandoff();
  return {
    handoff,
    mutex: new ProfileMutex(opts.mutex),
    leases: new LeaseRegistry(opts.now ? { now: opts.now } : {}),
    solver: opts.solver ?? new SolverCoordinator({ handoff, ...opts.solverOptions }),
  };
}
