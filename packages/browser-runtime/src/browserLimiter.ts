import { MultizenError, type ProfileId } from "@multizen/types";

/** Under the MCP SDK client's 60 s timeout, so a waiting client gets to read the answer. */
export const BROWSER_QUEUE_TIMEOUT_MS = 30_000;

interface SlotWaiter {
  profileId: ProfileId;
  admit(): void;
}

/**
 * How many browsers may run at once, over all engines. A profile holds a slot from the
 * moment its launch is let through until its browser is gone, so one starting up counts
 * too. Slots are kept by profile, which makes giving one back idempotent: a close and
 * the browser's own exit event can both report the same end.
 */
export class BrowserLimiter {
  private readonly holders = new Set<ProfileId>();
  private readonly waiters: SlotWaiter[] = [];

  constructor(private readonly max: number) {}

  /**
   * Resolves with a slot held, in arrival order. A profile that holds one already just
   * has it. `signal` ends the wait, so it only matters when there is one.
   */
  acquire(profileId: ProfileId, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    if (this.holders.has(profileId)) return Promise.resolve();
    if (this.holders.size < this.max) {
      this.holders.add(profileId);
      return Promise.resolve();
    }
    if (opts.signal?.aborted) return Promise.reject(launchCalledOff(profileId));
    return new Promise<void>((resolve, reject) => {
      const leaveLine = (): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
      };
      const waiter: SlotWaiter = {
        profileId,
        admit: () => {
          leaveLine();
          resolve();
        },
      };
      const onAbort = (): void => {
        leaveLine();
        reject(launchCalledOff(profileId));
      };
      const timer = setTimeout(() => {
        leaveLine();
        reject(
          new MultizenError(
            "BROWSER_LIMIT_REACHED",
            `All ${this.max} browser slots stayed in use for ${opts.timeoutMs} ms, so profile ${profileId} was not started.`,
            {
              hint: "Close a profile you are done with, or call launch_profile again after details.retry_after_ms.",
              details: {
                retry_after_ms: opts.timeoutMs,
                max_browsers: this.max,
                running: this.holders.size,
              },
            },
          ),
        );
      }, opts.timeoutMs);
      // A bound on a wait, not work itself: it must not keep a finished process alive.
      timer.unref?.();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Exactly once per slot, however many paths report the same browser's end. */
  release(profileId: ProfileId): void {
    if (!this.holders.delete(profileId)) return;
    const next = this.waiters[0];
    if (!next) return;
    this.holders.add(next.profileId);
    next.admit();
  }

  /** Browsers running or starting. */
  get inUse(): number {
    return this.holders.size;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}

export function launchCalledOff(profileId: ProfileId): MultizenError {
  return new MultizenError(
    "LAUNCH_FAILED",
    `The launch of profile ${profileId} was called off before a browser was started.`,
  );
}
