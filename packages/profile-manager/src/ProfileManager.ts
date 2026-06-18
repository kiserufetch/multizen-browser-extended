import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Profile,
  ProfileId,
  ProfileSummary,
  CreateProfileInput,
  UpdateProfileInput,
  ProxyConfig,
  FingerprintConfig,
  ExtensionConfig,
} from "@multizen/types";
import { defaultFingerprint } from "./fingerprint.js";

interface ProfileRow {
  id: string;
  name: string;
  notes: string | null;
  tags: string;
  proxy: string | null;
  fingerprint: string;
  data_dir: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  proxy_country: string | null;
  extensions: string | null;
}

export interface ProfileManagerOptions {
  dbPath: string;
  profilesRoot: string;
}

export class ProfileManager {
  private readonly db: Database.Database;
  private readonly profilesRoot: string;

  constructor(opts: ProfileManagerOptions) {
    mkdirSync(opts.profilesRoot, { recursive: true });
    this.profilesRoot = opts.profilesRoot;
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        proxy TEXT,
        fingerprint TEXT NOT NULL,
        data_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
    `);
    // Idempotent column add — existing DBs predate proxy_country.
    const cols = this.db.prepare(`PRAGMA table_info(profiles)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "proxy_country")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN proxy_country TEXT`);
    }
    if (!cols.some((c) => c.name === "extensions")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN extensions TEXT`);
    }
  }

  list(): ProfileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, tags, last_opened_at, proxy, fingerprint, proxy_country
         FROM profiles ORDER BY updated_at DESC`,
      )
      .all() as Pick<
      ProfileRow,
      "id" | "name" | "tags" | "last_opened_at" | "proxy" | "fingerprint" | "proxy_country"
    >[];
    return rows.map((r) => {
      const fingerprint = JSON.parse(r.fingerprint) as FingerprintConfig;
      return {
        id: r.id,
        name: r.name,
        tags: JSON.parse(r.tags) as string[],
        lastOpenedAt: r.last_opened_at ?? undefined,
        isRunning: false,
        proxy: r.proxy ? (JSON.parse(r.proxy) as ProxyConfig) : undefined,
        timezone: fingerprint.timezone,
        proxyCountry: r.proxy_country ?? undefined,
        device: fingerprint.device,
      };
    });
  }

  get(id: ProfileId): Profile | null {
    const row = this.db
      .prepare(`SELECT * FROM profiles WHERE id = ?`)
      .get(id) as ProfileRow | undefined;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  create(input: CreateProfileInput): Profile {
    const id = uuidv4();
    const now = new Date().toISOString();
    const dataDir = join(this.profilesRoot, id);
    mkdirSync(dataDir, { recursive: true });

    const fingerprint: FingerprintConfig = {
      ...defaultFingerprint(id),
      ...input.fingerprint,
    };

    const profile: Profile = {
      id,
      name: input.name,
      notes: input.notes,
      tags: input.tags ?? [],
      proxy: input.proxy,
      fingerprint,
      extensions: input.extensions ?? [],
      dataDir,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO profiles
         (id, name, notes, tags, proxy, fingerprint, extensions, data_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.notes ?? null,
        JSON.stringify(profile.tags),
        profile.proxy ? JSON.stringify(profile.proxy) : null,
        JSON.stringify(profile.fingerprint),
        JSON.stringify(profile.extensions ?? []),
        profile.dataDir,
        profile.createdAt,
        profile.updatedAt,
      );

    return profile;
  }

  update(id: ProfileId, patch: UpdateProfileInput): Profile {
    const existing = this.get(id);
    if (!existing) throw new Error(`Profile ${id} not found`);

    const now = new Date().toISOString();
    const proxyChanged =
      patch.proxy !== undefined &&
      JSON.stringify(patch.proxy ?? null) !== JSON.stringify(existing.proxy ?? null);

    const merged: Profile = {
      ...existing,
      name: patch.name ?? existing.name,
      notes: patch.notes ?? existing.notes,
      tags: patch.tags ?? existing.tags,
      proxy: patch.proxy === null ? undefined : (patch.proxy ?? existing.proxy),
      fingerprint: { ...existing.fingerprint, ...patch.fingerprint },
      extensions: patch.extensions ?? existing.extensions,
      updatedAt: now,
      // Stale country if proxy changed — next launch / Test re-probes.
      proxyCountry: proxyChanged ? undefined : existing.proxyCountry,
    };

    this.db
      .prepare(
        `UPDATE profiles SET
           name = ?, notes = ?, tags = ?, proxy = ?, fingerprint = ?, extensions = ?,
           updated_at = ?, proxy_country = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.notes ?? null,
        JSON.stringify(merged.tags),
        merged.proxy ? JSON.stringify(merged.proxy) : null,
        JSON.stringify(merged.fingerprint),
        JSON.stringify(merged.extensions ?? []),
        merged.updatedAt,
        merged.proxyCountry ?? null,
        id,
      );

    return merged;
  }

  /** Persist the country code resolved from the proxy's egress IP. */
  setProxyCountry(id: ProfileId, country: string | null): void {
    this.db
      .prepare(`UPDATE profiles SET proxy_country = ? WHERE id = ?`)
      .run(country, id);
  }

  delete(id: ProfileId): void {
    // Remove the on-disk profile directory (cookies, Chromium state, and any
    // installed extensions under dataDir/extensions/) so deleting a profile
    // doesn't orphan its data. Best-effort — a locked dir shouldn't block the
    // DB delete.
    const existing = this.get(id);
    this.db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
    if (existing) {
      try {
        rmSync(existing.dataDir, { recursive: true, force: true });
      } catch {
        // ignore — directory may be in use; DB row is already gone.
      }
    }
  }

  markOpened(id: ProfileId): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE profiles SET last_opened_at = ? WHERE id = ?`).run(now, id);
  }

  close(): void {
    this.db.close();
  }

  private rowToProfile(row: ProfileRow): Profile {
    return {
      id: row.id,
      name: row.name,
      notes: row.notes ?? undefined,
      tags: JSON.parse(row.tags) as string[],
      proxy: row.proxy ? (JSON.parse(row.proxy) as ProxyConfig) : undefined,
      fingerprint: JSON.parse(row.fingerprint) as FingerprintConfig,
      extensions: row.extensions ? (JSON.parse(row.extensions) as ExtensionConfig[]) : [],
      dataDir: row.data_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at ?? undefined,
      proxyCountry: row.proxy_country ?? undefined,
    };
  }
}
