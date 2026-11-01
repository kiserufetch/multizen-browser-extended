import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ProfileId } from "@multizen/types";
import { createPrincipal, TOOL_GROUPS, type Principal, type ToolGroup } from "./principal.js";

const FILE_VERSION = 1;
/** `mz_<id>_<32 random bytes, base64url>`. A base64url secret can hold `_`, so its length sets it apart. */
const TOKEN_RE = /^mz_(t_[0-9a-f]+)_[A-Za-z0-9_-]{43}$/;
const POLL_INTERVAL_MS = 500;
const LOCK_WAIT_MS = 5_000;
/** A writer holds the lock for one small file write, so this one crashed. */
const LOCK_STALE_MS = 10_000;
const RETRY_DELAY_MS = 25;
/** What Windows reports while something else has the file open for a moment. */
const TRANSIENT_FS_ERRORS: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES"]);

export interface TokenRecord {
  id: string;
  name: string;
  hash: string;
  tools: { groups: ToolGroup[]; names: string[] };
  profiles: "*" | ProfileId[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateTokenInput {
  name: string;
  groups: ToolGroup[];
  names?: string[];
  profiles?: "*" | ProfileId[];
  expiresAt?: Date | null;
}

export type TokenStatus = "active" | "expired" | "revoked";

/** What `token list` may show. The hash stays in the file. */
export type TokenSummary = Omit<TokenRecord, "hash"> & { panel: boolean; status: TokenStatus };

export interface TokenStoreOptions {
  warn?: (message: string) => void;
  now?: () => number;
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hashOf(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTokenRecord(value: unknown): value is TokenRecord {
  const r = value as Partial<TokenRecord> | null;
  return (
    typeof r?.id === "string" &&
    typeof r.name === "string" &&
    typeof r.hash === "string" &&
    isStringArray(r.tools?.groups) &&
    isStringArray(r.tools?.names) &&
    (r.profiles === "*" || isStringArray(r.profiles)) &&
    (r.expiresAt === null || typeof r.expiresAt === "string") &&
    (r.revokedAt === null || typeof r.revokedAt === "string")
  );
}

function principalOf(record: TokenRecord): Principal {
  return createPrincipal({
    id: record.id,
    name: record.name,
    full:
      record.profiles === "*" && TOOL_GROUPS.every((group) => record.tools.groups.includes(group)),
    tools: { groups: [...record.tools.groups], names: [...record.tools.names] },
    profiles: record.profiles === "*" ? "*" : [...record.profiles],
  });
}

/**
 * Named bearer tokens in `<data-dir>/tokens.json`: hashes only, 0600, replaced whole by
 * rename so a reader never sees half a file. SHA-256 is enough for a 256-bit random secret.
 *
 * `token create` and `token revoke` are other processes, so the file is the authority:
 * every authentication stats it, and a change applies to the very next request. A timer
 * does the same so that open streams close when a token ends, with no request to notice.
 */
export class TokenStore {
  private readonly path: string;
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  private readonly listeners = new Set<(principalId: string) => void>();
  private records: TokenRecord[] = [];
  /** What the loaded records came from. Null: nothing usable yet, read again. */
  private signature: string | null = null;
  private live = new Set<string>();
  private poll: ReturnType<typeof setInterval> | undefined;
  private warnedAboutMode = false;

  constructor(path: string, opts: TokenStoreOptions = {}) {
    this.path = path;
    this.warn = opts.warn ?? ((message) => process.stderr.write(`[multizen] ${message}\n`));
    this.now = opts.now ?? Date.now;
    this.refresh();
  }

  /** The bearer value of an `Authorization` header, or null for anything not currently valid. */
  authenticate(token: string): Principal | null {
    this.refresh();
    const id = TOKEN_RE.exec(token)?.[1];
    const record = id === undefined ? undefined : this.records.find((r) => r.id === id);
    if (!record || this.statusOf(record) !== "active") return null;
    return sameHash(record.hash, hashOf(token)) ? principalOf(record) : null;
  }

  authenticateHeader(authorization: string | undefined): Principal | null {
    const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
    return token === undefined ? null : this.authenticate(token);
  }

  /** The new token in plaintext, for the caller to show once. It is not kept anywhere. */
  create(input: CreateTokenInput): { token: string; record: TokenRecord } {
    return this.withLock(() => {
      const records = this.readFile();
      const clash = records.find(
        (r) => r.name === input.name && this.statusOf(r) !== "revoked",
      );
      if (clash) throw new Error(`A token named "${input.name}" already exists (${clash.id})`);

      let id: string;
      do {
        id = `t_${randomBytes(4).toString("hex")}`;
      } while (records.some((r) => r.id === id));
      const token = `mz_${id}_${randomBytes(32).toString("base64url")}`;
      const record: TokenRecord = {
        id,
        name: input.name,
        hash: hashOf(token),
        tools: { groups: [...new Set(input.groups)], names: [...new Set(input.names ?? [])] },
        profiles: input.profiles ?? "*",
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
        revokedAt: null,
      };
      this.writeFile([...records, record]);
      return { token, record };
    });
  }

  /** By id or by name. A token already revoked stays as it was. */
  revoke(idOrName: string): TokenRecord {
    return this.withLock(() => {
      const records = this.readFile();
      const record =
        records.find((r) => r.id === idOrName) ??
        records.find((r) => r.name === idOrName && r.revokedAt === null);
      if (!record) throw new Error(`No token with id or name "${idOrName}"`);
      if (record.revokedAt !== null) return record;
      const revoked = { ...record, revokedAt: new Date(this.now()).toISOString() };
      this.writeFile(records.map((r) => (r === record ? revoked : r)));
      return revoked;
    });
  }

  list(): TokenSummary[] {
    this.refresh();
    return this.records.map(({ hash: _hash, ...record }) => ({
      ...record,
      panel: record.tools.groups.includes("operator"),
      status: this.statusOf(record),
    }));
  }

  /**
   * Whether anything has ever been stored: revoked and expired tokens count. Throws on
   * a file it can't read, which must not pass for a store that is merely new.
   */
  get isEmpty(): boolean {
    return this.readFile().length === 0;
  }

  activeCount(): number {
    return this.list().filter((token) => token.status === "active").length;
  }

  /** Called with a token's id when it stops being valid: revoked, expired or removed. */
  onInvalidated(listener: (principalId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts noticing changes between requests. Pointless for a one-shot CLI. */
  watch(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
    this.poll.unref?.();
  }

  close(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.listeners.clear();
  }

  private statusOf(record: Pick<TokenRecord, "expiresAt" | "revokedAt">): TokenStatus {
    if (record.revokedAt !== null) return "revoked";
    // Written so that a date nobody can read counts as past, not as never.
    return record.expiresAt === null || Date.parse(record.expiresAt) > this.now()
      ? "active"
      : "expired";
  }

  /** Re-reads the file if it changed, then tells listeners about whatever just ended. */
  private refresh(): void {
    let signature: string;
    try {
      const stat = statSync(this.path);
      signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (e) {
      if (errorCode(e) !== "ENOENT") return;
      signature = "absent";
    }
    if (signature !== this.signature) {
      try {
        this.records = this.readFile();
        this.signature = signature;
      } catch (e) {
        // Writes are atomic, so this is a moment's lock or a hand edit gone wrong. Only
        // the second must fail closed: an unreadable file may hold a revocation.
        if (TRANSIENT_FS_ERRORS.has(errorCode(e) ?? "")) return;
        this.warn(`Refusing every token: ${(e as Error).message}`);
        this.records = [];
        this.signature = null;
      }
    }
    this.notifyInvalidated();
  }

  private notifyInvalidated(): void {
    const live = new Set(
      this.records.filter((r) => this.statusOf(r) === "active").map((r) => r.id),
    );
    const ended = [...this.live].filter((id) => !live.has(id));
    this.live = live;
    for (const id of ended) {
      for (const listener of this.listeners) {
        try {
          listener(id);
        } catch (e) {
          this.warn(`A listener failed on the end of token ${id}: ${(e as Error).message}`);
        }
      }
    }
  }

  private readFile(): TokenRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if (errorCode(e) === "ENOENT") return [];
      throw e;
    }
    let parsed: { version?: unknown; tokens?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (e) {
      throw new Error(`${this.path} is not valid JSON: ${(e as Error).message}`, { cause: e });
    }
    if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.tokens)) {
      throw new Error(`${this.path} should hold version ${FILE_VERSION} with a tokens list`);
    }
    if (!parsed.tokens.every(isTokenRecord)) throw new Error(`${this.path} has a malformed token`);
    this.checkFileMode();
    return parsed.tokens;
  }

  /** Only reachable under the lock. Keeps the store current for this process too. */
  private writeFile(records: TokenRecord[]): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, tokens: records }, null, 2)}\n`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    this.retrying(() => renameSync(tmp, this.path));
    this.refresh();
  }

  private checkFileMode(): void {
    if (process.platform === "win32") {
      if (!this.warnedAboutMode) {
        this.warnedAboutMode = true;
        this.warn(`File modes don't apply on Windows: ${this.path} relies on the directory's ACL`);
      }
      return;
    }
    if ((statSync(this.path).mode & 0o077) === 0) return;
    chmodSync(this.path, 0o600);
    this.warn(`${this.path} was readable by others; restricted to 0600`);
  }

  /** A rename onto a file someone has open fails on Windows until they let go. */
  private retrying(work: () => void): void {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        work();
        return;
      } catch (e) {
        if (!TRANSIENT_FS_ERRORS.has(errorCode(e) ?? "") || Date.now() > deadline) throw e;
        sleepSync(RETRY_DELAY_MS);
      }
    }
  }

  /** Two `token create` at once would each write back what the other didn't see. */
  private withLock<T>(work: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lockPath, "wx", 0o600));
        break;
      } catch (e) {
        const code = errorCode(e) ?? "";
        if (code !== "EEXIST" && !TRANSIENT_FS_ERRORS.has(code)) throw e;
        this.removeLockIfStale(lockPath);
        if (Date.now() > deadline) {
          throw new Error(`${lockPath} stayed locked for ${LOCK_WAIT_MS} ms`, { cause: e });
        }
        sleepSync(RETRY_DELAY_MS);
      }
    }
    try {
      return work();
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  private removeLockIfStale(lockPath: string): void {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // It went away by itself, or is still being created: the next attempt tells.
    }
  }
}
