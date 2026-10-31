/**
 * Staged CDP readiness within a single fixed budget, reusing the supplied
 * session (connect() is idempotent). Stages, each polled on a fixed backoff:
 *   1. `/json/version` answers — the DevTools HTTP endpoint is up.
 *   2. `/json/list` reports at least one `type === "page"` target — Chromium
 *      has actually opened a page (chrome-remote-interface attaches to a page
 *      by default, so connecting before one exists throws).
 *   3. `session.connect()` succeeds — websocket attached + Page.enable done.
 *
 * Throws if the budget is exhausted at any stage; the caller is responsible
 * for tearing down the half-launched browser.
 *
 * `signal` lets the caller abandon the probe (e.g. the child crashed). Once it
 * aborts, the probe rejects with the abort reason and never starts another
 * fetch or connect(): left running, it would keep polling this port and, after
 * a relaunch on the same port, connect the caller's already-closed session to
 * the new browser. A connect() already in flight completes, so the caller
 * must wait for this promise to settle before closing the session.
 *
 * `fetch` and `sleep` are injectable so the staged ladder / budget behaviour
 * can be exercised without a real Chromium endpoint.
 */
export interface ReadinessResponseLike {
  ok: boolean;
  json: () => Promise<unknown>;
}

export interface ReadinessSession {
  connect(): Promise<void>;
}

export interface ReadinessDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<ReadinessResponseLike>;
  sleep: (ms: number) => Promise<void>;
}

const defaultReadinessDeps: ReadinessDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function waitForCdpSessionReady(
  port: number,
  session: ReadinessSession,
  budgetMs: number,
  deps: ReadinessDeps = defaultReadinessDeps,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = null;

  // Stage 1: /json/version answers.
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json/version`, { signal });
      if (res.ok) {
        lastError = null;
        break;
      }
    } catch (e) {
      lastError = e;
    }
    await deps.sleep(200);
  }
  if (Date.now() >= deadline) {
    throw new Error(
      `CDP /json/version not ready on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
    );
  }

  // Stage 2: a page target exists.
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/json/list`, { signal });
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type?: string }>;
        if (targets.some((t) => t.type === "page")) {
          lastError = null;
          break;
        }
      }
    } catch (e) {
      lastError = e;
    }
    await deps.sleep(200);
  }
  if (Date.now() >= deadline) {
    throw new Error(`No CDP page target on port ${port} within ${budgetMs}ms: ${String(lastError)}`);
  }

  // Stage 3: connect + attach (idempotent; returns immediately once attached).
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      await session.connect();
    } catch (e) {
      lastError = e;
      await deps.sleep(200);
      continue;
    }
    // A connect() that was in flight when the caller gave up must not report
    // ready; the caller closes the session once this settles.
    signal?.throwIfAborted();
    return;
  }
  throw new Error(
    `CDP connect/attach failed on port ${port} within ${budgetMs}ms: ${String(lastError)}`,
  );
}
