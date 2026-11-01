/** Far inside the 30 minutes a server keeps an idle session by default. */
export const DEFAULT_KEEPALIVE_MS = 30_000;
const UNREACHABLE_RETRY_MS = 2_000;
const UNREACHABLE_ATTEMPTS = 3;
const PING_TIMEOUT_MS = 10_000;

/**
 * Why this HTTP status means the relay's session will never answer again, or null if it
 * might. Those are all a relay can do nothing about: it can't take a client's session over
 * to a new one, as the client holds state from its own initialize.
 */
export function whySessionGone(e: unknown): string | null {
  const status = (e as { code?: unknown } | null)?.code;
  if (status === 404) {
    return (
      "The server no longer has this session: it restarted, or closed the session for idling " +
      "past its --session-idle-ttl-ms (a lower --keepalive-ms here prevents that). Restart this relay."
    );
  }
  if (status === 401 || status === 403) {
    return "The server refuses this relay's token: it was revoked or has expired. Restart this relay with a valid one.";
  }
  return null;
}

export interface RelayKeepAliveOptions {
  intervalMs: number;
  /** One round trip to the server. Rejects as the transport does, with the HTTP status as `code`. */
  ping: () => Promise<void>;
  /** Once, with what to tell the operator. */
  onGone: (why: string) => void;
  retryMs?: number;
  attempts?: number;
  timeoutMs?: number;
}

/**
 * Pings on a timer, as a request is what counts as activity for a server's idle TTL. A ping is
 * also what finds out that the session is gone, which an idle relay would otherwise only learn
 * from its client's next call. A server that doesn't answer gets a few quick tries, so a blip
 * costs nothing and a dead one is reported within seconds.
 */
export class RelayKeepAlive {
  private timer: NodeJS.Timeout | undefined;
  private pinging = false;
  private stopped = false;
  private failures = 0;

  constructor(private readonly opts: RelayKeepAliveOptions) {}

  start(): void {
    if (this.stopped || this.timer || this.pinging) return;
    this.schedule(this.opts.intervalMs);
  }

  /** Something looks wrong: the answer comes sooner than the next tick. Retries keep their pace. */
  checkNow(): void {
    if (this.stopped || this.pinging || this.failures > 0) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.pinging = true;
    let failure: unknown = null;
    let failed = false;
    try {
      await this.withinTimeout(this.opts.ping());
    } catch (e) {
      failure = e;
      failed = true;
    }
    this.pinging = false;
    if (this.stopped) return;
    if (!failed) {
      this.failures = 0;
      this.schedule(this.opts.intervalMs);
      return;
    }
    const gone = whySessionGone(failure);
    if (gone) {
      this.giveUp(gone);
      return;
    }
    this.failures += 1;
    if (this.failures >= (this.opts.attempts ?? UNREACHABLE_ATTEMPTS)) {
      this.giveUp(
        `The server does not answer (${this.failures} tries, last: ${(failure as Error).message}). ` +
          "Whatever session it had is gone with it. Restart this relay once the server is back.",
      );
      return;
    }
    this.schedule(this.opts.retryMs ?? UNREACHABLE_RETRY_MS);
  }

  private giveUp(why: string): void {
    this.stop();
    this.opts.onGone(why);
  }

  private withinTimeout(work: Promise<void>): Promise<void> {
    const ms = this.opts.timeoutMs ?? PING_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      timer.unref?.();
      work.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e as Error);
        },
      );
    });
  }
}
