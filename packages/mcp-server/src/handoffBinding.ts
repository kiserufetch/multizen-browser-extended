import type { BrowserDriver, ProfileId } from "@multizen/types";
import type { ActivityLog } from "./ActivityLog.js";
import type { HumanHandoff } from "./handoff.js";

/** What a browser driver says about a profile's browser. The router has it; a mock may not. */
export interface RunningEvents {
  on(
    event: "running-changed",
    listener: (change: { kind: string; profileId: ProfileId; reason?: string }) => void,
  ): unknown;
}

export interface HandoffBindingOptions {
  handoff: HumanHandoff;
  driver: Pick<BrowserDriver, "setHandoffMode"> & Partial<RunningEvents>;
  activityLog?: ActivityLog;
  /**
   * Whether a person works on this profile through the panel, not in a window of their own.
   * Then a handoff keeps dialogs open and catches file choosers for them. Otherwise the
   * window handles both as it always has: Chromium shows its own dialog whether or not CDP
   * has Page enabled there, and the dialog policy answers it first only on the tabs that
   * policy covers, which on a desktop are the root tab and those an agent has acted on.
   */
  panelDriven: (profileId: ProfileId) => boolean;
}

/**
 * Ties the registry to the browsers: a handoff outlives no browser, whichever way it went,
 * and its start and end show in the activity log with who did it. Nothing else goes there:
 * no reason, frame or input.
 */
export function bindHandoffToBrowser(opts: HandoffBindingOptions): void {
  const { handoff, driver, activityLog } = opts;
  const held = new Set<string>();

  handoff.onTransition((record) => {
    const { profileId } = record;
    if (record.status === "pending") {
      activityLog?.recordLifecycle("handoff.requested", {
        profileId,
        ...(record.requestedBy !== undefined ? { actor: record.requestedBy } : {}),
        summary: record.kind,
      });
      if (opts.panelDriven(profileId)) {
        held.add(record.id);
        // Sets its flag before it first awaits: no dialog can slip by the policy.
        driver.setHandoffMode?.(profileId, true)?.catch(() => {});
      }
      return;
    }
    activityLog?.recordLifecycle(`handoff.${record.status}`, {
      profileId,
      ...(record.settledBy !== undefined ? { actor: record.settledBy } : {}),
      summary: record.kind,
    });
    if (held.delete(record.id)) driver.setHandoffMode?.(profileId, false)?.catch(() => {});
  });

  driver.on?.("running-changed", (change) => {
    if (change.kind !== "closed" && change.kind !== "closing") return;
    handoff.closeForProfile(
      change.profileId,
      change.reason === "external-exit" ? "browser exited" : "browser closed",
    );
  });
}
