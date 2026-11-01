import { errorFields, flushLogs, log } from "./log.ts";

/** Bounds the whole shutdown. Below compose's stop_grace_period. */
const DEFAULT_WATCHDOG_MS = 15_000;
const DEFAULT_STEP_BUDGET_MS = 5_000;

interface ShutdownStep {
  name: string;
  run: () => unknown;
  budgetMs: number;
}

/** Waits for `work` for at most `ms`; true if it finished in time. */
export function withinBudget(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * One way out of the process. Cleanup registered with {@link add} runs last-added
 * first, like nested try/finally, so the order follows from startup: the lock goes
 * first and comes off last. A step that fails or overruns its budget is logged and
 * skipped, so a wedged HTTP stop can't leave browsers running. A watchdog bounds
 * the whole thing, and whatever a watchdog cuts short, the next start's lock and
 * reaper deal with.
 */
export class ShutdownManager {
  private readonly steps: ShutdownStep[] = [];
  private readonly watchdogMs: number;
  private readonly exit: (code: number) => void;
  private running: Promise<void> | null = null;
  private exitCode = 0;
  private exited = false;

  constructor(opts: { watchdogMs?: number; exit?: (code: number) => void } = {}) {
    this.watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    this.exit = opts.exit ?? ((code) => process.exit(code));
  }

  add(name: string, run: () => unknown, budgetMs: number = DEFAULT_STEP_BUDGET_MS): void {
    this.steps.push({ name, run, budgetMs });
  }

  /** Starts the shutdown once; later calls can only make the exit code worse. */
  run(reason: string, code = 0): Promise<void> {
    this.exitCode = Math.max(this.exitCode, code);
    if (!this.running) this.running = this.execute(reason);
    return this.running;
  }

  /** Signals end the process cleanly, anything uncaught ends it with exit 1. */
  installProcessHandlers(): void {
    // SIGBREAK is Ctrl+Break on Windows, the one signal a console can send there
    // without also meaning Ctrl+C. SIGHUP is a closed terminal or console window.
    for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"] as const) {
      process.on(signal, () => {
        void this.run(signal, 0);
      });
    }
    process.on("uncaughtException", (e) => {
      log.error("uncaught exception", errorFields(e));
      void this.run("uncaughtException", 1);
    });
    process.on("unhandledRejection", (reason) => {
      log.error("unhandled rejection", errorFields(reason));
      void this.run("unhandledRejection", 1);
    });
  }

  private async execute(reason: string): Promise<void> {
    log.info("shutting down", { reason });
    const watchdog = setTimeout(() => {
      log.error("shutdown timed out, forcing exit", { watchdogMs: this.watchdogMs });
      void this.finish(1);
    }, this.watchdogMs);

    for (const step of [...this.steps].reverse()) {
      try {
        if (!(await withinBudget(Promise.resolve().then(step.run), step.budgetMs))) {
          log.warn("shutdown step overran its budget", { step: step.name, budgetMs: step.budgetMs });
        }
      } catch (e) {
        log.error("shutdown step failed", { step: step.name, ...errorFields(e) });
      }
    }

    clearTimeout(watchdog);
    log.info("shutdown complete", { reason, exitCode: this.exitCode });
    await this.finish(this.exitCode);
  }

  private async finish(code: number): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await flushLogs();
    this.exit(code);
  }
}
