import { randomBytes } from "node:crypto";

const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 8 * 3_600_000;
const CODE_TTL_MS = 60_000;
/** Getting a session takes a valid token, so this bounds a mistake rather than an attack. */
const MAX_SESSIONS = 256;
const MAX_CODES = 64;

export interface PanelSession {
  /** Not the cookie: safe to compare and hold onto, and worthless to anyone who reads it. */
  id: string;
  /** Looked up again per request, so the end of a token is the end of its panel. */
  principalId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface PanelSessionsOptions {
  idleMs?: number;
  absoluteMs?: number;
  codeTtlMs?: number;
  now?: () => number;
}

/**
 * Who is signed in to the panel: in memory, so a restart signs everyone out. A session's
 * value goes in a cookie only the panel's routes read, so it can't reach /mcp or a download.
 * A one-time code gets a session without a token, for a window the desktop app opens itself.
 */
export class PanelSessions {
  private readonly sessions = new Map<string, PanelSession>();
  private readonly codes = new Map<string, { principalId: string; expiresAt: number }>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly codeTtlMs: number;
  private readonly now: () => number;

  constructor(opts: PanelSessionsOptions = {}) {
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    this.absoluteMs = opts.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.codeTtlMs = opts.codeTtlMs ?? CODE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The value for the cookie. */
  create(principalId: string): string {
    const now = this.now();
    this.prune(now);
    const value = randomBytes(32).toString("base64url");
    this.sessions.set(value, {
      id: randomBytes(8).toString("hex"),
      principalId,
      createdAt: now,
      lastSeenAt: now,
    });
    // A Map keeps insertion order, which is how the oldest is found.
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.sessions.delete(oldest);
    }
    return value;
  }

  /** Counts as activity. Null once it has been idle too long or lived too long. */
  find(value: string): PanelSession | null {
    const session = this.sessions.get(value);
    if (!session) return null;
    const now = this.now();
    if (now - session.lastSeenAt >= this.idleMs || now - session.createdAt >= this.absoluteMs) {
      this.sessions.delete(value);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  destroy(value: string): void {
    this.sessions.delete(value);
  }

  /** A token ended: its panel sessions and its codes go with it. */
  dropPrincipal(principalId: string): void {
    for (const [value, session] of this.sessions) {
      if (session.principalId === principalId) this.sessions.delete(value);
    }
    for (const [code, entry] of this.codes) {
      if (entry.principalId === principalId) this.codes.delete(code);
    }
  }

  mintCode(principalId: string): string {
    const now = this.now();
    this.prune(now);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { principalId, expiresAt: now + this.codeTtlMs });
    for (const oldest of this.codes.keys()) {
      if (this.codes.size <= MAX_CODES) break;
      this.codes.delete(oldest);
    }
    return code;
  }

  /** Once only. The principal it was minted for, or null. */
  redeemCode(code: string): string | null {
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.expiresAt > this.now() ? entry.principalId : null;
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(now: number): void {
    for (const [value, session] of this.sessions) {
      if (now - session.lastSeenAt >= this.idleMs || now - session.createdAt >= this.absoluteMs) {
        this.sessions.delete(value);
      }
    }
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }
}
