import { createHmac } from "node:crypto";
import type { HumanHandoff, PendingHandoff } from "@multizen/mcp-server";
import type { ProfileId } from "@multizen/types";
import { log } from "./log.ts";

const WEBHOOK_TIMEOUT_MS = 5_000;

export interface HandoffWebhookOptions {
  handoff: HumanHandoff;
  /** The owner's, from the command line: no agent says where it goes. Its body has the agent's reason. */
  url: string;
  /** Signs the body as `X-MultiZen-Signature: sha256=<hex>`. */
  secret?: string;
  /** The panel's address, which carries no token: a person still signs in. */
  panelUrl: string;
  profileName: (id: ProfileId) => string | undefined;
  /** Replaced by tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<typeof log, "warn">;
}

/** What went wrong, without the URL or anything else it may hold, such as a token in its path. */
function failure(e: unknown): Record<string, unknown> {
  const error = e as { name?: string; cause?: { code?: string } };
  return { error: error.name ?? "Error", ...(error.cause?.code ? { code: error.cause.code } : {}) };
}

/**
 * Tells the owner's endpoint about each new handoff, once. It never blocks or fails one: a
 * bad endpoint costs a log line. A redirect counts as a failure and isn't followed, since
 * nothing said the body may go wherever it points.
 */
export function startHandoffWebhook(opts: HandoffWebhookOptions): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? log;
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  const deliver = async (pending: PendingHandoff): Promise<void> => {
    const body = JSON.stringify({
      id: pending.handoffId,
      profileId: pending.profileId,
      profileName: opts.profileName(pending.profileId) ?? null,
      kind: pending.kind,
      reason: pending.reason,
      panelUrl: `${opts.panelUrl}#${pending.handoffId}`,
      createdAt: pending.since,
      expiresAt: pending.expiresAt,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "multizen-server",
    };
    if (opts.secret) {
      const signature = createHmac("sha256", opts.secret).update(body).digest("hex");
      headers["x-multizen-signature"] = `sha256=${signature}`;
    }
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) logger.warn("handoff webhook refused", { handoff: pending.handoffId, status: res.status });
    } catch (e) {
      logger.warn("handoff webhook failed", { handoff: pending.handoffId, ...failure(e) });
    }
  };

  // Only ids still pending are worth keeping: an id is never reused.
  let seen = new Set<string>();
  return opts.handoff.onChange((pending) => {
    for (const item of pending) {
      if (!seen.has(item.handoffId)) void deliver(item);
    }
    seen = new Set(pending.map((item) => item.handoffId));
  });
}
