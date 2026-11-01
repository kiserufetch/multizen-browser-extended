import { MultizenError, type ProfileId } from "@multizen/types";

/** How many calls may wait behind the one running on a profile. */
export const MUTEX_QUEUE_DEPTH = 16;
/** Under the MCP SDK client's 60 s timeout, so a waiting client gets to read the answer. */
export const MUTEX_WAIT_MS = 30_000;

export interface MutexOptions {
  queueDepth?: number;
  waitMs?: number;
}

export interface MutexRunOptions {
  timeoutMs?: number;
  /** Aborted when the client cancels or its connection closes: the call then never runs. */
  signal?: AbortSignal;
  /** Who is waiting, so the end of a session can drop what it left queued. */
  sessionId?: string;
}

interface Waiter {
  sessionId?: string;
  admit(): void;
  reject(e: unknown): void;
}

function cancelled(): MultizenError {
  return new MultizenError("TIMEOUT", "The call was cancelled while it waited for the profile.", {
    retryable: false,
  });
}

/**
 * One call at a time per profile, in arrival order, across every MCP session of a
 * process. Two agents on one profile would otherwise interleave their clicks and keys
 * on the same page. It covers a whole tool call, however many commands that takes.
 */
export class ProfileMutex {
  /** A profile has a line exactly while someone holds it. The line is who waits behind. */
  private readonly lines = new Map<ProfileId, Waiter[]>();
  private readonly queueDepth: number;
  private readonly waitMs: number;

  constructor(opts: MutexOptions = {}) {
    this.queueDepth = opts.queueDepth ?? MUTEX_QUEUE_DEPTH;
    this.waitMs = opts.waitMs ?? MUTEX_WAIT_MS;
  }

  async run<T>(
    profileId: ProfileId,
    work: () => Promise<T>,
    opts: MutexRunOptions = {},
  ): Promise<T> {
    await this.enter(profileId, opts);
    try {
      // The client may have gone in the moment between its turn coming and getting here.
      if (opts.signal?.aborted) throw cancelled();
      return await work();
    } finally {
      this.leave(profileId);
    }
  }

  isHeld(profileId: ProfileId): boolean {
    return this.lines.has(profileId);
  }

  queued(profileId: ProfileId): number {
    return this.lines.get(profileId)?.length ?? 0;
  }

  /** Fails everything waiting on a profile. Whoever holds it keeps running. */
  rejectWaiters(profileId: ProfileId, error: unknown): void {
    for (const waiter of [...(this.lines.get(profileId) ?? [])]) waiter.reject(error);
  }

  /** A closed session's waiters must not fire later, on whatever the page shows by then. */
  dropSession(sessionId: string): void {
    for (const line of this.lines.values()) {
      for (const waiter of [...line]) {
        if (waiter.sessionId === sessionId) waiter.reject(cancelled());
      }
    }
  }

  private enter(profileId: ProfileId, opts: MutexRunOptions): Promise<void> {
    if (opts.signal?.aborted) return Promise.reject(cancelled());
    const line = this.lines.get(profileId);
    if (!line) {
      this.lines.set(profileId, []);
      return Promise.resolve();
    }
    if (line.length >= this.queueDepth) {
      return Promise.reject(
        new MultizenError(
          "TIMEOUT",
          `Profile ${profileId} is busy: ${line.length} calls are already waiting for it.`,
          {
            hint: "Calls on one profile run one at a time. Retry shortly.",
            details: { queue_depth: this.queueDepth },
          },
        ),
      );
    }
    const timeoutMs = opts.timeoutMs ?? this.waitMs;
    return new Promise<void>((resolve, reject) => {
      const leaveLine = (): void => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        line.splice(line.indexOf(waiter), 1);
      };
      const waiter: Waiter = {
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        admit: () => {
          leaveLine();
          resolve();
        },
        reject: (e) => {
          leaveLine();
          reject(e);
        },
      };
      const onAbort = (): void => waiter.reject(cancelled());
      const timer = setTimeout(
        () =>
          waiter.reject(
            new MultizenError(
              "TIMEOUT",
              `Profile ${profileId} stayed busy for ${timeoutMs} ms: another call holds it.`,
              { hint: "Calls on one profile run one at a time. Retry shortly." },
            ),
          ),
        timeoutMs,
      );
      // A bound on a wait, not work itself: it must not keep a finished process alive.
      timer.unref?.();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      line.push(waiter);
    });
  }

  private leave(profileId: ProfileId): void {
    const next = this.lines.get(profileId)?.[0];
    if (next) next.admit();
    else this.lines.delete(profileId);
  }
}
