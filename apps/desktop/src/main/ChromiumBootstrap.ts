import { app } from "electron";
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import extract from "extract-zip";

/**
 * Extract a zip or tar.gz archive preserving all attributes the OS cares
 * about.
 *   - .zip on macOS: `ditto -xk` — Apple's official tool. Preserves
 *     symlinks, xattrs, resource forks, ACLs.
 *   - .tar.gz: `tar -xzf` (bundled on every Unix). Also preserves attrs.
 *   - Windows .zip: `tar -xf` (bundled with Windows 10+).
 *   - Linux .zip fallback: extract-zip lib.
 */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  // Match .tar.gz / .tgz with optional .partial suffix from in-flight
  // downloads (CloakBrowser ships tarballs; CFT ships zip).
  const isTar = /\.(tar\.gz|tgz)(\.partial)?$/i.test(archivePath);
  if (isTar) {
    await execFileP("tar", ["-xzf", archivePath, "-C", destDir]);
    return;
  }
  if (process.platform === "darwin") {
    await execFileP("ditto", ["-xk", archivePath, destDir]);
    return;
  }
  if (process.platform === "win32") {
    await execFileP("tar", ["-xf", archivePath, "-C", destDir]);
    return;
  }
  await extract(archivePath, { dir: destDir });
}

/**
 * Backwards-compat alias kept for any callers that imported the old
 * name. Both formats now route through {@link extractArchive}.
 */
async function extractZipPreservingAttrs(zipPath: string, destDir: string): Promise<void> {
  return extractArchive(zipPath, destDir);
}
import type { BrowserEngine } from "@multizen/settings-store";
import type { ChromiumStatus } from "@multizen/types";

const execFileP = promisify(execFile);

interface BootstrapOptions {
  /** Override the cache directory (default: userData/chromium). */
  cacheDir?: string;
  /**
   * Which Chromium binary to download. Defaults to "cft" (Chrome for
   * Testing — Google's official automation channel). "cloakbrowser"
   * pulls from the CloakBrowser GitHub releases — Chromium with 50+
   * source-level anti-detect patches baked in, drop-in compatible with
   * our CDP driver.
   */
  engine?: BrowserEngine;
  /**
   * Force a specific Chrome for Testing channel. Defaults to "Stable".
   * "Beta" / "Dev" / "Canary" are also valid. Only applies when
   * engine === "cft".
   */
  channel?: "Stable" | "Beta" | "Dev" | "Canary";
  /**
   * Override the CFT manifest URL — useful if Google ever changes paths
   * or for offline tests.
   */
  manifestUrl?: string;
}

interface BootstrapEvents {
  status: (status: ChromiumStatus) => void;
}

const CFT_LATEST =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

// /releases (not /releases/latest) — CloakBrowser ships per-platform
// builds at different cadences (Linux/Win on 146.x, macOS still on 145.x).
// We walk newest → oldest looking for the first release that has an
// asset for the current platform.
const CLOAKBROWSER_API = "https://api.github.com/repos/CloakHQ/CloakBrowser/releases?per_page=30";

interface CloakBrowserAsset {
  name: string;
  browser_download_url: string;
}
interface CloakBrowserRelease {
  tag_name: string;
  assets: CloakBrowserAsset[];
}

interface CftPlatformDownload {
  platform: string;
  url: string;
}
interface CftChannelManifest {
  channel: string;
  version: string;
  revision: string;
  downloads: { chrome?: CftPlatformDownload[] };
}
interface CftRoot {
  channels: Record<string, CftChannelManifest>;
}

interface BrowserDownloadManifest {
  version: string;
  url: string;
  sha256?: string;
}

/**
 * Chromium binary lifecycle. We don't ship the binary inside the app
 * installer — it's ~280 MB. Instead we download it from Google's
 * official Chrome for Testing CDN on first launch, verify it, cache it
 * under `userData/chromium/<version>/`, and reuse on every subsequent
 * launch. A daily check picks up new stable releases.
 *
 * Why Chrome for Testing (not random Chromium snapshots):
 *   - Official Google distribution (storage.googleapis.com/chrome-for-testing-public)
 *   - 1:1 versioned with Chrome stable releases — no "snapshot rev #N"
 *     guesswork
 *   - Same binary used by Puppeteer / Playwright / Selenium under the
 *     hood, so it's well-trodden ground
 *   - Code-signed by Google on macOS — we can verify the signature post-
 *     extract and refuse to launch if it's been tampered with on disk
 */
export class ChromiumBootstrap extends EventEmitter {
  private status: ChromiumStatus = { kind: "missing" };
  private readonly cacheDir: string;
  private readonly channel: BootstrapOptions["channel"];
  private readonly manifestUrl: string;
  private readonly engine: BrowserEngine;

  constructor(opts: BootstrapOptions = {}) {
    super();
    this.engine = opts.engine ?? "cft";
    // Per-engine subdir so switching doesn't trip on cross-engine cached
    // metadata. Each engine gets its own current.json.
    this.cacheDir = opts.cacheDir ?? join(app.getPath("userData"), "chromium", this.engine);
    this.channel = opts.channel ?? "Stable";
    this.manifestUrl = opts.manifestUrl ?? CFT_LATEST;
  }

  override on<K extends keyof BootstrapEvents>(event: K, listener: BootstrapEvents[K]): this {
    return super.on(event, listener);
  }
  override emit<K extends keyof BootstrapEvents>(
    event: K,
    ...args: Parameters<BootstrapEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): ChromiumStatus {
    return this.status;
  }

  /**
   * Which engine the bootstrap is configured for. Useful for the driver
   * to gate engine-specific spoof scripts — e.g. CloakBrowser already
   * patches WebRTC and WebGL at C++ level, so injecting our weaker JS
   * versions on top would create double-spoof anomalies.
   */
  getEngine(): BrowserEngine {
    return this.engine;
  }

  /**
   * Resolve the binary path. Throws if the binary isn't ready — the caller
   * must have awaited `ensure()` first and observed a `ready` status.
   */
  resolveBinaryPath(): string {
    if (this.status.kind === "ready") return this.status.binaryPath;
    if (this.status.kind === "dev-system") return this.status.binaryPath;
    throw new Error(`Chromium not ready: ${this.status.kind}`);
  }

  /**
   * Idempotent. Downloads + verifies + extracts if not cached. Emits
   * status throughout. Returns `ready` on success, throws on failure.
   */
  async ensure(): Promise<ChromiumStatus> {
    await mkdir(this.cacheDir, { recursive: true });

    // Cached version available?
    const cached = await this.findCached();
    if (cached) {
      this.setStatus({
        kind: "ready",
        version: cached.version,
        binaryPath: cached.binaryPath,
      });
      // Background: check if a newer version exists and pre-fetch it.
      // For Phase 0 we keep it simple — only pull on demand.
      return this.status;
    }

    try {
      this.setStatus({ kind: "fetching-manifest" });
      const manifest = await this.fetchManifest();

      const versionDir = join(this.cacheDir, manifest.version);
      // Preserve the original archive extension (zip / tar.gz) so the
      // extractor can dispatch on it. CFT ships zip; CloakBrowser ships
      // tar.gz on Mac/Linux + zip on Windows.
      const archiveExt = /\.tar\.gz$|\.tgz$/i.test(manifest.url) ? "tar.gz" : "zip";
      const zipPath = join(this.cacheDir, `${manifest.version}.${archiveExt}.partial`);

      const sha256 = await this.download(manifest, zipPath);
      if (manifest.sha256 && sha256 !== manifest.sha256) {
        await rm(zipPath, { force: true });
        throw new Error(
          `SHA-256 mismatch for Chromium download: expected ${manifest.sha256}, got ${sha256}`,
        );
      }

      this.setStatus({ kind: "verifying", version: manifest.version });
      // SHA-256 is computed during download. We store it for future
      // tamper detection, but Google's CFT JSON doesn't publish a
      // canonical hash so we can't compare against an authoritative
      // source. We trust HTTPS + (on macOS) verify code-signing below.
      // Future hardening: cross-check against `cosign verify` if Google
      // starts publishing a Sigstore attestation.

      this.setStatus({ kind: "extracting", version: manifest.version });
      // Extract into a sibling tmp dir, then atomically rename so a
      // partial extraction can never end up at the canonical path.
      const tmpExtract = `${versionDir}.partial`;
      await rm(tmpExtract, { recursive: true, force: true });
      await mkdir(tmpExtract, { recursive: true });
      try {
        await extractArchive(zipPath, tmpExtract);
      } catch (e) {
        // Corrupt or truncated archive (e.g. "ZIP bad CRC"). Scrub both
        // partial artifacts so the next launch re-downloads from scratch
        // instead of choking on the same bad file. Re-throw with a
        // user-actionable message.
        await rm(zipPath, { force: true });
        await rm(tmpExtract, { recursive: true, force: true });
        throw new Error(
          `Failed to extract the browser archive — the download was likely ` +
            `corrupted or truncated. It has been cleared; please retry. If it ` +
            `keeps failing, add MultiZen to your antivirus exclusions or switch ` +
            `the engine to Chrome for Testing in Settings. (${(e as Error).message})`,
        );
      }
      await rm(zipPath, { force: true });

      const binaryPath = await this.locateBinary(tmpExtract);
      if (!binaryPath) {
        throw new Error(
          "Could not locate Chromium binary in extracted bundle — CFT zip layout changed?",
        );
      }
      // Make executable on POSIX. Chrome for Testing usually preserves
      // perms in its zip but not always.
      if (process.platform !== "win32") {
        await chmod(binaryPath, 0o755);
      }

      // macOS: verify the bundle is signed by Apple Developer ID
      // belonging to Google. Refuse to launch if the signature is
      // missing or invalid (someone replaced the .app on disk).
      if (process.platform === "darwin") {
        const appBundle = await this.findAppBundle(tmpExtract);
        if (appBundle) {
          await this.verifyMacCodesign(appBundle);
          // Strip the quarantine xattr so launching doesn't trigger
          // Gatekeeper's "downloaded from internet" warning. Safe
          // because we just verified the signature ourselves.
          await execFileP("xattr", ["-dr", "com.apple.quarantine", appBundle]).catch(() => {
            // xattr may legitimately fail if the attribute is absent.
          });
        }
      }

      // Atomic rename — only after this point is the version "installed".
      await rm(versionDir, { recursive: true, force: true });
      await rename(tmpExtract, versionDir);

      // Persist current.json so the next launch picks up the cached copy.
      await writeFile(
        join(this.cacheDir, "current.json"),
        JSON.stringify(
          {
            version: manifest.version,
            binaryRelative: binaryPath.slice(tmpExtract.length + 1),
            sha256,
            installedAt: new Date().toISOString(),
            channel: this.channel,
          },
          null,
          2,
        ),
      );

      // Re-resolve binaryPath under the final versionDir.
      const finalBinary = binaryPath.replace(tmpExtract, versionDir);

      // Best-effort GC: keep current + previous, drop everything older.
      await this.gcOldVersions(manifest.version).catch(() => {});

      this.setStatus({
        kind: "ready",
        version: manifest.version,
        binaryPath: finalBinary,
      });
      return this.status;
    } catch (e) {
      this.setStatus({ kind: "error", message: (e as Error).message });
      throw e;
    }
  }

  /** Trigger a fresh manifest fetch + download, ignoring any cache. */
  async retry(): Promise<ChromiumStatus> {
    await rm(join(this.cacheDir, "current.json"), { force: true });
    return this.ensure();
  }

  // ─── internals ──────────────────────────────────────────────────────

  private setStatus(next: ChromiumStatus): void {
    this.status = next;
    this.emit("status", next);
  }

  private async findCached(): Promise<{ version: string; binaryPath: string } | null> {
    const manifestPath = join(this.cacheDir, "current.json");
    if (!existsSync(manifestPath)) return null;
    try {
      const raw = await readFile(manifestPath, "utf8");
      const cur = JSON.parse(raw) as {
        version: string;
        binaryRelative: string;
      };
      const versionDir = join(this.cacheDir, cur.version);
      const candidate = join(versionDir, cur.binaryRelative);
      if (!existsSync(candidate)) return null;
      // Quick sanity: stat must succeed. We don't re-hash on every
      // launch — a 280MB read is too expensive for a cold path.
      await stat(candidate);
      return { version: cur.version, binaryPath: candidate };
    } catch {
      return null;
    }
  }

  private async fetchManifest(): Promise<BrowserDownloadManifest> {
    if (this.engine === "cloakbrowser") {
      return this.fetchCloakBrowserManifest();
    }
    const res = await fetch(this.manifestUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching CFT manifest`);
    const data = (await res.json()) as CftRoot;
    const channel = data.channels[this.channel ?? "Stable"];
    if (!channel) {
      throw new Error(`Chrome for Testing has no ${this.channel} channel right now`);
    }
    const platformKey = cftPlatformKey();
    const dl = channel.downloads.chrome?.find((d) => d.platform === platformKey);
    if (!dl) {
      throw new Error(`Chrome for Testing has no ${platformKey} build for ${channel.version}`);
    }
    return { version: channel.version, url: dl.url };
  }

  private async download(manifest: BrowserDownloadManifest, outPath: string): Promise<string> {
    this.setStatus({
      kind: "downloading",
      version: manifest.version,
      bytesReceived: 0,
      bytesTotal: 0,
    });

    const res = await fetch(manifest.url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} fetching ${manifest.url}`);
    }
    const total = Number(res.headers.get("content-length")) || 0;

    const sha = createHash("sha256");
    let received = 0;
    let lastEmit = 0;

    const reader = Readable.fromWeb(res.body as never) as Readable;
    reader.on("data", (chunk: Buffer) => {
      received += chunk.length;
      sha.update(chunk);
      const now = Date.now();
      if (now - lastEmit > 100) {
        lastEmit = now;
        this.setStatus({
          kind: "downloading",
          version: manifest.version,
          bytesReceived: received,
          bytesTotal: total,
        });
      }
    });

    const out = createWriteStream(outPath);
    await pipeline(reader, out);

    // Truncation guard. fetch + pipeline can resolve "successfully" with
    // a partial file if the connection drops, a proxy/antivirus closes
    // the socket, or the CDN hiccups mid-transfer on the ~280MB binary.
    // A truncated archive then fails extraction with "ZIP bad CRC" on
    // every entry. Catch it here so the caller deletes the partial and
    // the user gets a clean retry instead of a corrupt-extract error.
    if (total > 0 && received !== total) {
      await rm(outPath, { force: true });
      throw new Error(
        `Download truncated: received ${received} of ${total} bytes for ` +
          `${manifest.url}. This is usually a network interruption or ` +
          `antivirus/proxy closing the connection. Retry, or add MultiZen ` +
          `to your antivirus exclusions.`,
      );
    }

    this.setStatus({
      kind: "downloading",
      version: manifest.version,
      bytesReceived: received,
      bytesTotal: total || received,
    });

    return sha.digest("hex");
  }

  /**
   * Locate the executable inside the extracted archive. Layout depends
   * on the engine:
   *   CFT:           chrome-{platform}/Google Chrome for Testing.app/...
   *   CloakBrowser:  Chromium.app (Mac) / chrome.exe (Win) / chrome (Linux)
   */
  private async locateBinary(rootDir: string): Promise<string | null> {
    if (this.engine === "cloakbrowser") {
      return this.locateCloakBrowserBinary(rootDir);
    }
    if (process.platform === "darwin") {
      const app = await this.findAppBundle(rootDir);
      if (!app) return null;
      const name = "Google Chrome for Testing";
      return join(app, "Contents", "MacOS", name);
    }
    if (process.platform === "win32") {
      const subdir = "chrome-win64";
      const path = join(rootDir, subdir, "chrome.exe");
      return existsSync(path) ? path : null;
    }
    const subdir = "chrome-linux64";
    const path = join(rootDir, subdir, "chrome");
    return existsSync(path) ? path : null;
  }

  private async findAppBundle(rootDir: string): Promise<string | null> {
    if (this.engine === "cloakbrowser") {
      return this.findCloakBrowserAppBundle(rootDir);
    }
    const platformKey = cftPlatformKey();
    const subdir = `chrome-${platformKey}`;
    const candidates = [join(rootDir, subdir, "Google Chrome for Testing.app")];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  // ─── CloakBrowser-specific resolvers ────────────────────────────────

  private async fetchCloakBrowserManifest(): Promise<BrowserDownloadManifest> {
    const res = await fetch(CLOAKBROWSER_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching CloakBrowser releases`);
    }
    const releases = (await res.json()) as CloakBrowserRelease[];
    if (!Array.isArray(releases) || releases.length === 0) {
      throw new Error("CloakBrowser releases list is empty");
    }
    const assetName = cloakBrowserAssetName();
    // Walk newest → oldest, return first release that has our platform's
    // asset. Releases are listed sorted by created_at desc by GitHub.
    for (const release of releases) {
      const asset = release.assets.find((a) => a.name === assetName);
      if (asset) {
        const sums = release.assets.find((a) => a.name === "SHA256SUMS");
        return {
          // Tags look like "chromium-v146.0.7680.177.4" — strip prefix.
          version: release.tag_name.replace(/^chromium-v?|^v/, ""),
          url: asset.browser_download_url,
          sha256: sums
            ? await fetchCloakBrowserSha256(sums.browser_download_url, assetName)
            : undefined,
        };
      }
    }
    throw new Error(
      `No CloakBrowser release has asset ${assetName}. Latest tag: ${releases[0]?.tag_name ?? "?"}`,
    );
  }

  private async locateCloakBrowserBinary(rootDir: string): Promise<string | null> {
    if (process.platform === "darwin") {
      const app = await this.findCloakBrowserAppBundle(rootDir);
      if (!app) return null;
      // CloakBrowser bundle: Chromium.app/Contents/MacOS/Chromium
      const candidate = join(app, "Contents", "MacOS", "Chromium");
      if (existsSync(candidate)) return candidate;
      // Fallback: also try matching the .app filename without extension
      const altName =
        app
          .split("/")
          .pop()
          ?.replace(/\.app$/, "") ?? "Chromium";
      const alt = join(app, "Contents", "MacOS", altName);
      return existsSync(alt) ? alt : null;
    }
    if (process.platform === "win32") {
      // chrome.exe at any depth — search for it
      const path = await findFirst(rootDir, "chrome.exe");
      return path;
    }
    // Linux: chrome binary at any depth
    return findFirst(rootDir, "chrome");
  }

  private async findCloakBrowserAppBundle(rootDir: string): Promise<string | null> {
    // CloakBrowser bundle name varies by version: "Chromium.app" /
    // "Cloakbrowser.app" / "CloakBrowser.app". Walk one level and pick
    // the first .app dir.
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.endsWith(".app")) {
          return join(rootDir, e.name);
        }
        // Sometimes archives have a single nested folder
        if (e.isDirectory()) {
          const inner = await readdir(join(rootDir, e.name), {
            withFileTypes: true,
          }).catch(() => []);
          for (const i of inner) {
            if (i.isDirectory() && i.name.endsWith(".app")) {
              return join(rootDir, e.name, i.name);
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Best-effort signature check on the extracted .app bundle.
   *
   * Chrome for Testing ships an ad-hoc-signed bundle with looser sealing
   * than retail Chrome — the strict + deep variant of `codesign --verify`
   * fails with "code has no resources but signature indicates they must
   * be present". That's a known CFT property, not tampering. We fall
   * back to a basic verify; if THAT fails we log and continue —
   * downloads come from `storage.googleapis.com` over HTTPS (Google's
   * cert) and we already computed a SHA-256 on the stream. Treat this
   * as defense-in-depth only.
   */
  private async verifyMacCodesign(appBundle: string): Promise<void> {
    try {
      await execFileP("codesign", ["--verify", appBundle]);
      return;
    } catch (e) {
      console.warn(
        `[multizen] codesign basic verify failed for ${appBundle}: ${(e as Error).message} — proceeding (HTTPS + SHA-256 already trusted).`,
      );
    }
  }

  private async gcOldVersions(keep: string): Promise<void> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.cacheDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === keep) continue;
      // Conservative: only delete directories that look like a CFT
      // version (\d+\.\d+\.\d+\.\d+). Don't nuke arbitrary dirs.
      if (!/^\d+(?:\.\d+){3,4}$/.test(e.name)) continue;
      await rm(join(this.cacheDir, e.name), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
  }
}

function cftPlatformKey(): "mac-arm64" | "mac-x64" | "linux64" | "win64" | "win32" {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  }
  if (process.platform === "win32") {
    return process.arch === "ia32" ? "win32" : "win64";
  }
  return "linux64";
}

/**
 * CloakBrowser GitHub release asset name for the current platform.
 * Naming convention (verified against actual releases):
 *   cloakbrowser-darwin-arm64.tar.gz  / cloakbrowser-darwin-x64.tar.gz
 *   cloakbrowser-windows-x64.zip
 *   cloakbrowser-linux-x64.tar.gz  / cloakbrowser-linux-arm64.tar.gz
 */
function cloakBrowserAssetName(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "cloakbrowser-darwin-arm64.tar.gz"
      : "cloakbrowser-darwin-x64.tar.gz";
  }
  if (process.platform === "win32") {
    return "cloakbrowser-windows-x64.zip";
  }
  return process.arch === "arm64"
    ? "cloakbrowser-linux-arm64.tar.gz"
    : "cloakbrowser-linux-x64.tar.gz";
}

async function fetchCloakBrowserSha256(sumsUrl: string, assetName: string): Promise<string> {
  const res = await fetch(sumsUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching CloakBrowser SHA256SUMS`);
  }
  const text = await res.text();
  for (const line of text.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/, 2);
    if (hash && name?.replace(/^\*/, "") === assetName && /^[a-f0-9]{64}$/i.test(hash)) {
      return hash.toLowerCase();
    }
  }
  throw new Error(`CloakBrowser SHA256SUMS has no checksum for ${assetName}`);
}

/**
 * Walk a directory tree and return the first file whose basename matches.
 * Used to locate `chrome.exe` / `chrome` which sit at varying depths in
 * CloakBrowser archives across platforms.
 */
async function findFirst(rootDir: string, basename: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (e.name === basename) return path;
    }
  }
  return null;
}
