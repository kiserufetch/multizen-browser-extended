import type { ProfileId } from "@multizen/types";

/**
 * Human-handoff coordination for the CAPTCHA / 2FA pause-and-resume protocol.
 *
 * The agent never solves a CAPTCHA or 2FA itself: it calls `request_human`,
 * then blocks on `wait_for_human` while a person completes the challenge in the
 * same Chromium window, and continues once the person signals they are done
 * (an operator action in the desktop app, bridged to `resume`). This interface
 * is the in-process rendezvous; the desktop app supplies an implementation that
 * also surfaces the pending handoff in its UI, while standalone/tests use the
 * in-memory default.
 */
export interface PendingHandoff {
  profileId: ProfileId;
  reason: string;
  /** ISO timestamp of the request. */
  since: string;
}

export interface HumanHandoff {
  /** Record that `profileId` needs a human (CAPTCHA / 2FA / manual step). */
  request(profileId: ProfileId, reason: string): void;
  /** Signal that the human finished — resolves any `waitFor` for this profile. */
  resume(profileId: ProfileId): void;
  /** Block until the profile is resumed or `timeoutMs` elapses. */
  waitFor(profileId: ProfileId, timeoutMs: number): Promise<{ resumed: boolean }>;
  /** Currently-pending handoffs (for the operator UI). */
  pending(): PendingHandoff[];
  isPending(profileId: ProfileId): boolean;
  /** Subscribe to pending-set changes; returns an unsubscribe. */
  onChange(cb: (pending: PendingHandoff[]) => void): () => void;
}

interface Entry {
  reason: string;
  since: string;
  waiters: Set<(result: { resumed: boolean }) => void>;
}

export class InMemoryHumanHandoff implements HumanHandoff {
  private readonly entries = new Map<ProfileId, Entry>();
  private readonly listeners = new Set<(pending: PendingHandoff[]) => void>();

  request(profileId: ProfileId, reason: string): void {
    const existing = this.entries.get(profileId);
    if (existing) {
      existing.reason = reason;
    } else {
      this.entries.set(profileId, {
        reason,
        since: new Date().toISOString(),
        waiters: new Set(),
      });
    }
    this.notify();
  }

  resume(profileId: ProfileId): void {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    this.entries.delete(profileId);
    for (const w of entry.waiters) w({ resumed: true });
    entry.waiters.clear();
    this.notify();
  }

  waitFor(profileId: ProfileId, timeoutMs: number): Promise<{ resumed: boolean }> {
    // No pending request → nothing to wait for; treat as already resumed so a
    // stray wait_for_human doesn't hang the agent.
    const entry = this.entries.get(profileId);
    if (!entry) return Promise.resolve({ resumed: true });
    return new Promise((resolve) => {
      let done = false;
      const settle = (result: { resumed: boolean }): void => {
        if (done) return;
        done = true;
        entry.waiters.delete(settle);
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      entry.waiters.add(settle);
      const timer =
        timeoutMs > 0 ? setTimeout(() => settle({ resumed: false }), timeoutMs) : undefined;
    });
  }

  pending(): PendingHandoff[] {
    return Array.from(this.entries, ([profileId, e]) => ({
      profileId,
      reason: e.reason,
      since: e.since,
    }));
  }

  isPending(profileId: ProfileId): boolean {
    return this.entries.has(profileId);
  }

  onChange(cb: (pending: PendingHandoff[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    const snapshot = this.pending();
    for (const l of this.listeners) l(snapshot);
  }
}
