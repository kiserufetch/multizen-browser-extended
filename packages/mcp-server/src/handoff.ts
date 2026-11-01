import { randomUUID } from "node:crypto";
import type { ProfileId } from "@multizen/types";

export const HANDOFF_KINDS = ["captcha", "2fa", "login", "confirm", "other"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
export type HandoffStatus = "pending" | "resumed" | "aborted" | "expired";

/** How long a handoff waits for a person, however its agent is doing. */
export const DEFAULT_HANDOFF_TTL_MS = 15 * 60_000;
/** How long a finished handoff can still be asked about. */
const TOMBSTONE_TTL_MS = 60 * 60_000;
const MAX_TOMBSTONES = 500;
/** A reason reaches a webhook and a panel. It comes from an agent, which can be talked into anything. */
const MAX_REASON_CHARS = 2_000;

/**
 * These pages show what the person types: a read during one of them would hand their
 * code or password to the agent.
 */
export function isSensitiveKind(kind: HandoffKind): boolean {
  return kind === "2fa" || kind === "login";
}

export interface HandoffRecord {
  id: string;
  profileId: ProfileId;
  kind: HandoffKind;
  reason: string;
  status: HandoffStatus;
  createdAt: string;
  expiresAt: string;
  /** The token that asked. */
  requestedBy?: string;
  settledAt?: string;
  /** Who ended it: an operator's name, or what happened to the browser. */
  settledBy?: string;
}

/**
 * Human-handoff coordination for the CAPTCHA / 2FA pause-and-resume protocol.
 *
 * The agent never solves a CAPTCHA or 2FA itself: it calls `request_human`,
 * then waits on `wait_for_human` while a person completes the challenge in the
 * browser window or the panel, and continues once the person signals they are
 * done (an operator action, bridged to `resume`). This interface is the
 * in-process rendezvous; the desktop app also surfaces the pending handoff in
 * its UI, while standalone/tests use the in-memory default.
 */
export interface PendingHandoff {
  profileId: ProfileId;
  reason: string;
  /** ISO timestamp of the request. */
  since: string;
  handoffId: string;
  kind: HandoffKind;
  expiresAt: string;
}

export interface HandoffRequestOptions {
  kind?: HandoffKind;
  ttlMs?: number;
  requestedBy?: string;
}

export interface HumanHandoff {
  /**
   * Record that `profileId` needs a human (CAPTCHA / 2FA / manual step). A profile has one
   * at a time: asking again keeps its id, kind and expiry, so an agent can neither loosen
   * what it may read during a 2FA nor keep a person's profile from ever coming back.
   */
  request(profileId: ProfileId, reason: string, opts?: HandoffRequestOptions): HandoffRecord;
  /** Signal that the human finished — resolves any `waitFor` for this profile. */
  resume(profileId: ProfileId): void;
  /** Block until the profile is resumed or `timeoutMs` elapses. */
  waitFor(profileId: ProfileId, timeoutMs: number): Promise<{ resumed: boolean }>;
  /** Currently-pending handoffs (for the operator UI). */
  pending(): PendingHandoff[];
  isPending(profileId: ProfileId): boolean;
  /** Subscribe to pending-set changes; returns an unsubscribe. */
  onChange(cb: (pending: PendingHandoff[]) => void): () => void;
  /** Null for an id this process never issued, or one forgotten since. */
  get(id: string): HandoffRecord | null;
  activeForProfile(profileId: ProfileId): HandoffRecord | null;
  /** The most recent one of a profile, finished or not. */
  latestForProfile(profileId: ProfileId): HandoffRecord | null;
  /** False unless this call ended it. */
  resumeById(id: string, by?: string): boolean;
  abortById(id: string, by?: string): boolean;
  /** The browser is going or gone: whatever was pending on it is over. */
  closeForProfile(profileId: ProfileId, by?: string): void;
  /** The record once it ends, or as it stands when `timeoutMs` runs out. Null: no such id. */
  waitForId(id: string, timeoutMs: number): Promise<HandoffRecord | null>;
  /** Each handoff as it starts and as it ends, exactly once each. */
  onTransition(cb: (record: HandoffRecord) => void): () => void;
}

interface Entry {
  record: HandoffRecord;
  timer: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

export class InMemoryHumanHandoff implements HumanHandoff {
  private readonly entries = new Map<ProfileId, Entry>();
  /** In the order they ended, which is how the oldest is found. */
  private readonly tombstones = new Map<string, { record: HandoffRecord; endedAtMs: number }>();
  private readonly listeners = new Set<(pending: PendingHandoff[]) => void>();
  private readonly transitionListeners = new Set<(record: HandoffRecord) => void>();
  private readonly defaultTtlMs: number;

  constructor(opts: { defaultTtlMs?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_HANDOFF_TTL_MS;
  }

  request(profileId: ProfileId, reason: string, opts: HandoffRequestOptions = {}): HandoffRecord {
    const cappedReason = reason.slice(0, MAX_REASON_CHARS);
    const existing = this.entries.get(profileId);
    if (existing) {
      existing.record.reason = cappedReason;
      this.notify();
      return { ...existing.record };
    }
    const now = Date.now();
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs;
    const record: HandoffRecord = {
      id: randomUUID(),
      profileId,
      kind: opts.kind ?? "other",
      reason: cappedReason,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy } : {}),
    };
    const timer = setTimeout(() => this.settle(profileId, "expired", "ttl"), ttlMs);
    // A bound on a wait, not work itself: it must not keep a finished process alive.
    timer.unref?.();
    this.entries.set(profileId, { record, timer, waiters: new Set() });
    this.announce(record);
    this.notify();
    return { ...record };
  }

  resume(profileId: ProfileId): void {
    this.settle(profileId, "resumed");
  }

  waitFor(profileId: ProfileId, timeoutMs: number): Promise<{ resumed: boolean }> {
    // No pending request → nothing to wait for; treat as already resumed so a
    // stray wait doesn't hang the caller.
    const entry = this.entries.get(profileId);
    if (!entry) return Promise.resolve({ resumed: true });
    const { id } = entry.record;
    return this.waitForEntry(entry, timeoutMs).then(() => ({
      resumed: this.get(id)?.status === "resumed",
    }));
  }

  pending(): PendingHandoff[] {
    return Array.from(this.entries, ([profileId, { record }]) => ({
      profileId,
      reason: record.reason,
      since: record.createdAt,
      handoffId: record.id,
      kind: record.kind,
      expiresAt: record.expiresAt,
    }));
  }

  isPending(profileId: ProfileId): boolean {
    return this.entries.has(profileId);
  }

  onChange(cb: (pending: PendingHandoff[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onTransition(cb: (record: HandoffRecord) => void): () => void {
    this.transitionListeners.add(cb);
    return () => this.transitionListeners.delete(cb);
  }

  get(id: string): HandoffRecord | null {
    for (const { record } of this.entries.values()) {
      if (record.id === id) return { ...record };
    }
    this.pruneTombstones();
    const ended = this.tombstones.get(id);
    return ended ? { ...ended.record } : null;
  }

  activeForProfile(profileId: ProfileId): HandoffRecord | null {
    const entry = this.entries.get(profileId);
    return entry ? { ...entry.record } : null;
  }

  latestForProfile(profileId: ProfileId): HandoffRecord | null {
    const active = this.activeForProfile(profileId);
    if (active) return active;
    this.pruneTombstones();
    let latest: HandoffRecord | null = null;
    for (const { record } of this.tombstones.values()) {
      if (record.profileId === profileId) latest = record;
    }
    return latest ? { ...latest } : null;
  }

  resumeById(id: string, by?: string): boolean {
    return this.settleById(id, "resumed", by);
  }

  abortById(id: string, by?: string): boolean {
    return this.settleById(id, "aborted", by);
  }

  closeForProfile(profileId: ProfileId, by?: string): void {
    this.settle(profileId, "aborted", by);
  }

  async waitForId(id: string, timeoutMs: number): Promise<HandoffRecord | null> {
    for (const entry of this.entries.values()) {
      if (entry.record.id === id) {
        await this.waitForEntry(entry, timeoutMs);
        break;
      }
    }
    return this.get(id);
  }

  private waitForEntry(entry: Entry, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const settle = (): void => {
        entry.waiters.delete(settle);
        if (timer) clearTimeout(timer);
        resolve();
      };
      entry.waiters.add(settle);
      const timer = timeoutMs > 0 ? setTimeout(settle, timeoutMs) : undefined;
    });
  }

  private settleById(id: string, status: HandoffStatus, by?: string): boolean {
    for (const [profileId, { record }] of this.entries) {
      if (record.id === id) return this.settle(profileId, status, by);
    }
    return false;
  }

  /** Exactly once per handoff: the first to get here wins, and the rest find nothing. */
  private settle(profileId: ProfileId, status: HandoffStatus, by?: string): boolean {
    const entry = this.entries.get(profileId);
    if (!entry) return false;
    this.entries.delete(profileId);
    clearTimeout(entry.timer);
    const now = Date.now();
    const record: HandoffRecord = {
      ...entry.record,
      status,
      settledAt: new Date(now).toISOString(),
      ...(by !== undefined ? { settledBy: by } : {}),
    };
    this.tombstones.set(record.id, { record, endedAtMs: now });
    this.pruneTombstones();
    for (const wake of [...entry.waiters]) wake();
    this.announce(record);
    this.notify();
    return true;
  }

  private pruneTombstones(): void {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [id, { endedAtMs }] of this.tombstones) {
      if (endedAtMs > cutoff && this.tombstones.size <= MAX_TOMBSTONES) break;
      this.tombstones.delete(id);
    }
  }

  /** A listener that throws mustn't undo a handoff that has already started or ended. */
  private call(listener: () => void): void {
    try {
      listener();
    } catch (e) {
      process.stderr.write(`[multizen] a handoff listener failed: ${(e as Error).message}\n`);
    }
  }

  private announce(record: HandoffRecord): void {
    for (const listener of this.transitionListeners) this.call(() => listener({ ...record }));
  }

  private notify(): void {
    const snapshot = this.pending();
    for (const listener of this.listeners) this.call(() => listener(snapshot));
  }
}
