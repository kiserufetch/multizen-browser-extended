import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isDisplayMode } from "@multizen/types";
import type {
  Profile,
  ProfileId,
  ProfileSummary,
  CreateProfileInput,
  UpdateProfileInput,
  ProxyConfig,
  FingerprintConfig,
  ExtensionConfig,
  BrowserEngine,
  DisplayMode,
} from "@multizen/types";
import { defaultFingerprint } from "./fingerprint.js";
import { isSealed, SecretKeyError, type SecretBox } from "./secretBox.js";

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
  icon: string | null;
  start_url: string | null;
  search_provider: string | null;
  align_timezone_to_proxy: number | null;
  strict_geo_coherence: number | null;
  engine: string | null;
  display_mode: string | null;
}

export interface ProfileManagerOptions {
  dbPath: string;
  profilesRoot: string;
  /** Encrypts proxy passwords at rest. The desktop passes none and stores them as they are. */
  secrets?: SecretBox;
}

/** How the proxy passwords in the database are held. */
export interface StoredSecrets {
  sealed: number;
  plaintext: number;
}

export interface DataDirReconciliation {
  /** Rows now pointing at the directory found under the profiles root. */
  rebased: ProfileId[];
  /** Rows left untouched: outside the root, with no directory for them under it. */
  unresolved: Array<{ id: ProfileId; name: string; dataDir: string; expected: string }>;
}

export class ProfileManager {
  private readonly db: Database.Database;
  private readonly profilesRoot: string;
  private secrets: SecretBox | undefined;

  constructor(opts: ProfileManagerOptions) {
    mkdirSync(opts.profilesRoot, { recursive: true });
    this.profilesRoot = opts.profilesRoot;
    this.secrets = opts.secrets;
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
    if (!cols.some((c) => c.name === "icon")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN icon TEXT`);
    }
    if (!cols.some((c) => c.name === "start_url")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN start_url TEXT`);
    }
    if (!cols.some((c) => c.name === "search_provider")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN search_provider TEXT`);
    }
    if (!cols.some((c) => c.name === "align_timezone_to_proxy")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN align_timezone_to_proxy INTEGER`);
    }
    if (!cols.some((c) => c.name === "strict_geo_coherence")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN strict_geo_coherence INTEGER`);
    }
    if (!cols.some((c) => c.name === "engine")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN engine TEXT`);
      // Rows older than this column keep their browser state in
      // engines/cloakbrowser. Pin them: NULL means "follow the app default", so
      // changing the default would move them onto an empty data dir.
      this.db.exec(`UPDATE profiles SET engine = 'cloakbrowser'`);
    }
    // NULL means "follow the default", which is what every older row should do.
    if (!cols.some((c) => c.name === "display_mode")) {
      this.db.exec(`ALTER TABLE profiles ADD COLUMN display_mode TEXT`);
    }
  }

  list(): ProfileSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, tags, last_opened_at, proxy, fingerprint, proxy_country, icon, engine, display_mode
         FROM profiles ORDER BY updated_at DESC`,
      )
      .all() as Pick<
      ProfileRow,
      | "id"
      | "name"
      | "tags"
      | "last_opened_at"
      | "proxy"
      | "fingerprint"
      | "proxy_country"
      | "icon"
      | "engine"
      | "display_mode"
    >[];
    return rows.map((r) => {
      const fingerprint = JSON.parse(r.fingerprint) as FingerprintConfig;
      return {
        id: r.id,
        name: r.name,
        tags: JSON.parse(r.tags) as string[],
        lastOpenedAt: r.last_opened_at ?? undefined,
        isRunning: false,
        icon: r.icon ?? undefined,
        proxy: r.proxy ? this.readProxy(r.proxy) : undefined,
        timezone: fingerprint.timezone,
        proxyCountry: r.proxy_country ?? undefined,
        device: fingerprint.device,
        // Pinned engine (undefined = inherits the app default). The profiles:list
        // IPC resolves this to the effective engine for the GUI badge.
        engine: (r.engine as BrowserEngine | null) ?? undefined,
        displayMode: storedDisplayMode(r.display_mode),
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
      icon: input.icon,
      startUrl: input.startUrl,
      searchProvider: input.searchProvider,
      engine: input.engine,
      displayMode: input.displayMode,
      dataDir,
      createdAt: now,
      updatedAt: now,
      alignTimezoneToProxy: input.alignTimezoneToProxy,
      strictGeoCoherence: input.strictGeoCoherence,
    };

    this.db
      .prepare(
        `INSERT INTO profiles
         (id, name, notes, tags, proxy, fingerprint, extensions, icon, start_url, search_provider, engine, display_mode, data_dir, created_at, updated_at, align_timezone_to_proxy, strict_geo_coherence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.notes ?? null,
        JSON.stringify(profile.tags),
        this.writeProxy(profile.proxy),
        JSON.stringify(profile.fingerprint),
        JSON.stringify(profile.extensions ?? []),
        profile.icon ?? null,
        profile.startUrl ?? null,
        profile.searchProvider ?? null,
        profile.engine ?? null,
        profile.displayMode ?? null,
        profile.dataDir,
        profile.createdAt,
        profile.updatedAt,
        profile.alignTimezoneToProxy ? 1 : null,
        profile.strictGeoCoherence ? 1 : null,
      );

    return profile;
  }

  /**
   * Insert an already-fully-formed profile verbatim — id, dataDir, extensions,
   * icon, startUrl, searchProvider, and timestamps all preserved. Used by
   * import, where the id + on-disk dataDir were established by
   * {@link importProfile} and must NOT be regenerated (that was the old bug: the
   * handler called create(), which minted a new id/dataDir and orphaned the
   * restored user-data-dir). Throws on id collision — the caller resolves that
   * before extracting files.
   */
  insertImported(profile: Profile): Profile {
    if (this.get(profile.id)) {
      throw new Error(`Profile ${profile.id} already exists`);
    }
    mkdirSync(profile.dataDir, { recursive: true });
    this.db
      .prepare(
        `INSERT INTO profiles
         (id, name, notes, tags, proxy, fingerprint, extensions, icon, start_url, search_provider, engine, display_mode, data_dir, created_at, updated_at, align_timezone_to_proxy, strict_geo_coherence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.notes ?? null,
        JSON.stringify(profile.tags),
        this.writeProxy(profile.proxy),
        JSON.stringify(profile.fingerprint),
        JSON.stringify(profile.extensions ?? []),
        profile.icon ?? null,
        profile.startUrl ?? null,
        profile.searchProvider ?? null,
        profile.engine ?? null,
        profile.displayMode ?? null,
        profile.dataDir,
        profile.createdAt,
        profile.updatedAt,
        profile.alignTimezoneToProxy ? 1 : null,
        profile.strictGeoCoherence ? 1 : null,
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
      // null clears a custom icon (revert to the derived default); undefined keeps it.
      icon: patch.icon === null ? undefined : (patch.icon ?? existing.icon),
      // null clears → app default start page; undefined keeps existing.
      startUrl: patch.startUrl === null ? undefined : (patch.startUrl ?? existing.startUrl),
      // null clears → no search seeding; undefined keeps existing.
      searchProvider:
        patch.searchProvider === null
          ? undefined
          : (patch.searchProvider ?? existing.searchProvider),
      alignTimezoneToProxy:
        patch.alignTimezoneToProxy === null
          ? undefined
          : (patch.alignTimezoneToProxy ?? existing.alignTimezoneToProxy),
      strictGeoCoherence:
        patch.strictGeoCoherence === null
          ? undefined
          : (patch.strictGeoCoherence ?? existing.strictGeoCoherence),
      // null clears → revert to the app default engine; undefined keeps existing.
      engine: patch.engine === null ? undefined : (patch.engine ?? existing.engine),
      // null clears → follow the default again; undefined keeps existing.
      displayMode:
        patch.displayMode === null ? undefined : (patch.displayMode ?? existing.displayMode),
      updatedAt: now,
      // Stale country if proxy changed — next launch / Test re-probes.
      proxyCountry: proxyChanged ? undefined : existing.proxyCountry,
    };

    this.db
      .prepare(
        `UPDATE profiles SET
           name = ?, notes = ?, tags = ?, proxy = ?, fingerprint = ?, extensions = ?,
           icon = ?, start_url = ?, search_provider = ?, engine = ?, display_mode = ?, updated_at = ?, proxy_country = ?,
           align_timezone_to_proxy = ?, strict_geo_coherence = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.notes ?? null,
        JSON.stringify(merged.tags),
        this.writeProxy(merged.proxy),
        JSON.stringify(merged.fingerprint),
        JSON.stringify(merged.extensions ?? []),
        merged.icon ?? null,
        merged.startUrl ?? null,
        merged.searchProvider ?? null,
        merged.engine ?? null,
        merged.displayMode ?? null,
        merged.updatedAt,
        merged.proxyCountry ?? null,
        merged.alignTimezoneToProxy ? 1 : null,
        merged.strictGeoCoherence ? 1 : null,
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

  /**
   * Fix rows whose stored `data_dir` is outside the profiles root, as left by a
   * copied database or a changed data dir. Launching such a row would open an
   * empty directory: logged out, with no error. A row is rebased when its
   * directory exists under the root. If any row can't be, nothing is written and
   * the caller decides; the desktop never calls this.
   */
  reconcileDataDirs(): DataDirReconciliation {
    const rows = this.db.prepare(`SELECT id, name, data_dir FROM profiles`).all() as Array<
      Pick<ProfileRow, "id" | "name" | "data_dir">
    >;
    const rebase: Array<{ id: ProfileId; dataDir: string }> = [];
    const unresolved: DataDirReconciliation["unresolved"] = [];
    for (const row of rows) {
      // path.relative compares case-insensitively on Windows.
      const rel = relative(this.profilesRoot, row.data_dir);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) continue;
      const expected = join(this.profilesRoot, row.id);
      if (existsSync(expected)) rebase.push({ id: row.id, dataDir: expected });
      else unresolved.push({ id: row.id, name: row.name, dataDir: row.data_dir, expected });
    }
    if (unresolved.length > 0) return { rebased: [], unresolved };

    const setDataDir = this.db.prepare(`UPDATE profiles SET data_dir = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const { id, dataDir } of rebase) setDataDir.run(dataDir, id);
    })();
    return { rebased: rebase.map((r) => r.id), unresolved };
  }

  /** From here on, passwords are sealed with this box and opened with it. */
  useSecrets(secrets: SecretBox): void {
    this.secrets = secrets;
  }

  private storedProxies(): Array<{ id: ProfileId; proxy: ProxyConfig }> {
    const rows = this.db
      .prepare(`SELECT id, proxy FROM profiles WHERE proxy IS NOT NULL`)
      .all() as Array<{ id: ProfileId; proxy: string }>;
    return rows.map((row) => ({ id: row.id, proxy: JSON.parse(row.proxy) as ProxyConfig }));
  }

  /** Counts without opening anything, so it works with no key at hand. */
  storedSecrets(): StoredSecrets {
    const counts: StoredSecrets = { sealed: 0, plaintext: 0 };
    for (const { proxy } of this.storedProxies()) {
      if (proxy.password) counts[isSealed(proxy.password) ? "sealed" : "plaintext"] += 1;
    }
    return counts;
  }

  /** Whether every sealed password opens with this box. */
  canOpenStoredSecrets(box: SecretBox): boolean {
    try {
      for (const { proxy } of this.storedProxies()) {
        if (proxy.password && isSealed(proxy.password)) box.open(proxy.password);
      }
      return true;
    } catch (e) {
      if (e instanceof SecretKeyError) return false;
      throw e;
    }
  }

  /**
   * Seals what older code left in plaintext. Sealed values are opened on the way, so a
   * wrong key is found now and by profile, not at some later launch. All or nothing.
   */
  sealStoredSecrets(): number {
    const box = this.secrets;
    if (!box) throw new SecretKeyError("Sealing needs a secret key");
    const setProxy = this.db.prepare(`UPDATE profiles SET proxy = ? WHERE id = ?`);
    return this.db.transaction(() => {
      let sealed = 0;
      for (const { id, proxy } of this.storedProxies()) {
        if (!proxy.password) continue;
        if (isSealed(proxy.password)) {
          try {
            box.open(proxy.password);
          } catch (e) {
            throw new SecretKeyError(
              `The proxy password of profile ${id} can't be opened with this key. ` +
                "Use the key it was encrypted with.",
              { cause: e },
            );
          }
          continue;
        }
        setProxy.run(JSON.stringify({ ...proxy, password: box.seal(proxy.password) }), id);
        sealed += 1;
      }
      return sealed;
    })();
  }

  /**
   * Re-encrypts every sealed password under `next`, which is the box from here on. All
   * or nothing, so a failure leaves the database readable with the key it had.
   */
  rotateStoredSecrets(next: SecretBox): number {
    const current = this.secrets;
    if (!current) throw new SecretKeyError("Rotating needs the current secret key");
    const setProxy = this.db.prepare(`UPDATE profiles SET proxy = ? WHERE id = ?`);
    const rotated = this.db.transaction(() => {
      let count = 0;
      for (const { id, proxy } of this.storedProxies()) {
        if (!proxy.password) continue;
        const plaintext = isSealed(proxy.password) ? current.open(proxy.password) : proxy.password;
        setProxy.run(JSON.stringify({ ...proxy, password: next.seal(plaintext) }), id);
        count += 1;
      }
      return count;
    })();
    this.secrets = next;
    return rotated;
  }

  /**
   * Rewrites the database and empties the WAL. An UPDATE leaves the old value in the WAL
   * and in free pages of the file, which is where a password sealed later would survive.
   */
  purgeOldValues(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  /**
   * Every extension reference across all profiles, used by the shared-store GC
   * to decide whether a store entry is still referenced (derived refcount — no
   * separate counter to drift out of sync).
   */
  allExtensionRefs(): Array<{ profileId: string; dataDir: string; ext: ExtensionConfig }> {
    const rows = this.db
      .prepare(`SELECT id, data_dir, extensions FROM profiles`)
      .all() as Array<Pick<ProfileRow, "id" | "data_dir" | "extensions">>;
    const out: Array<{ profileId: string; dataDir: string; ext: ExtensionConfig }> = [];
    for (const r of rows) {
      for (const ext of normalizeExtensions(r.extensions)) {
        out.push({ profileId: r.id, dataDir: r.data_dir, ext });
      }
    }
    return out;
  }

  /** A row written before there was a box reads as it is, until it is next written. */
  private readProxy(stored: string): ProxyConfig {
    const proxy = JSON.parse(stored) as ProxyConfig;
    if (!proxy.password || !isSealed(proxy.password)) return proxy;
    if (!this.secrets) {
      throw new SecretKeyError(
        "This database holds encrypted proxy passwords and no secret key was given.",
      );
    }
    return { ...proxy, password: this.secrets.open(proxy.password) };
  }

  private writeProxy(proxy: ProxyConfig | undefined): string | null {
    if (!proxy) return null;
    if (!this.secrets || !proxy.password) return JSON.stringify(proxy);
    return JSON.stringify({ ...proxy, password: this.secrets.seal(proxy.password) });
  }

  private rowToProfile(row: ProfileRow): Profile {
    return {
      id: row.id,
      name: row.name,
      notes: row.notes ?? undefined,
      tags: JSON.parse(row.tags) as string[],
      proxy: row.proxy ? this.readProxy(row.proxy) : undefined,
      fingerprint: JSON.parse(row.fingerprint) as FingerprintConfig,
      extensions: normalizeExtensions(row.extensions),
      icon: row.icon ?? undefined,
      startUrl: row.start_url ?? undefined,
      searchProvider: row.search_provider ?? undefined,
      engine: (row.engine as BrowserEngine | null) ?? undefined,
      displayMode: storedDisplayMode(row.display_mode),
      dataDir: row.data_dir,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at ?? undefined,
      proxyCountry: row.proxy_country ?? undefined,
      alignTimezoneToProxy: row.align_timezone_to_proxy === 1 ? true : undefined,
      strictGeoCoherence: row.strict_geo_coherence === 1 ? true : undefined,
    };
  }
}

/** A value this build can't run reads as unset, so the launch path only ever sees real modes. */
function storedDisplayMode(raw: string | null): DisplayMode | undefined {
  return isDisplayMode(raw) ? raw : undefined;
}

/**
 * Parse + normalize the JSON `extensions` column. Back-compat: rows written
 * before the dedup feature lack `scope`/`version`, so default them (legacy
 * per-profile copies → scope "profile", unknown version → ""). This is why the
 * new fields need no SQL migration — the column is additive JSON.
 */
function normalizeExtensions(raw: string | null): ExtensionConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Partial<ExtensionConfig>>).map((e) => ({
    id: e.id ?? "",
    name: e.name ?? "Extension",
    version: e.version ?? "",
    scope: e.scope ?? "profile",
    enabled: e.enabled ?? true,
    dir: e.dir ?? "",
    source: e.source ?? "file",
  }));
}
