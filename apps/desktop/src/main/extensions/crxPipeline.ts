import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extract from "extract-zip";
import type { ExtensionConfig } from "@multizen/types";

const MAX_UNPACKED_BYTES = 150 * 1024 * 1024; // ~150 MB cap per extension

export interface UnpackInput {
  /** Absolute path to a .crx file, .zip file, or an unpacked extension folder. */
  source: string;
  /** The profile's dataDir; the extension lands under `<dataDir>/extensions/<key>/`. */
  profileDataDir: string;
  /** How the extension was obtained (for the stored ExtensionConfig). */
  origin: ExtensionConfig["source"];
}

/**
 * Validate + unpack an extension (folder / .zip / .crx) into the profile's
 * extensions directory and return its ExtensionConfig. Atomic: everything
 * happens in a temp dir and is only renamed into place once validated, so a
 * failure never leaves a partial install.
 *
 * Rejects Manifest V2 (modern Chromium won't run it) and oversized bundles.
 */
export async function unpackToProfile(input: UnpackInput): Promise<ExtensionConfig> {
  const { source, profileDataDir, origin } = input;
  if (!existsSync(source)) throw new Error(`Extension source not found: ${source}`);

  const extRoot = join(profileDataDir, "extensions");
  await mkdir(extRoot, { recursive: true });
  const staging = join(extRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });

  try {
    const info = await stat(source);
    if (info.isDirectory()) {
      await cp(source, staging, { recursive: true });
    } else {
      // A file: detect CRX by its Cr24 magic, NOT the extension — a CRX saved
      // as .zip or with no extension still unpacks. crxToZip returns the source
      // path unchanged when it isn't a CRX, so plain .zip works too. (We do not
      // verify the CRX signature: trust rests on HTTPS to Google / the user
      // providing the file — acceptable for a user-initiated install.)
      const zipPath = await crxToZip(source, staging);
      await extract(zipPath, { dir: staging });
      if (zipPath !== source) await rm(zipPath, { force: true });
    }

    // The manifest is usually at the root, but some archives wrap everything in
    // a single top-level folder — descend into it if so.
    const root = await resolveManifestRoot(staging);
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("No manifest.json found in the extension.");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest_version?: number;
      name?: string;
      default_locale?: string;
      key?: string;
    };
    if (manifest.manifest_version !== 3) {
      throw new Error(
        `Manifest V${manifest.manifest_version ?? "?"} isn't supported by modern Chromium — only V3 extensions can be loaded.`,
      );
    }

    // Size cap. NOTE: this runs after extraction, so it rejects honestly-large
    // bundles but does not pre-empt a decompression bomb (small archive → huge
    // tree). The install is user-initiated (upload or explicit Web Store add),
    // not remote-attacker-driven, so the residual risk is the user filling
    // their own disk; a streamed entry-size pre-check is a follow-up.
    const size = await dirSize(root);
    if (size > MAX_UNPACKED_BYTES) {
      throw new Error(
        `Extension is too large (${Math.round(size / 1024 / 1024)} MB > 150 MB limit).`,
      );
    }

    // Move into place under a stable per-install directory key.
    const dirKey = randomUUID();
    const finalDir = join(extRoot, dirKey);
    await rm(finalDir, { recursive: true, force: true });
    // If the manifest was nested, move that inner root; else the staging dir.
    await rename(root, finalDir);
    // Clean the (now-empty or leftover) staging dir if root != staging.
    if (root !== staging) await rm(staging, { recursive: true, force: true });

    const id = computeExtensionId({ key: manifest.key, absPath: finalDir });
    const name = await resolveName(manifest, finalDir);
    return {
      id,
      name,
      enabled: true,
      dir: join("extensions", dirKey),
      source: origin,
    };
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Strip the CRX2/CRX3 header off a .crx, writing the inner zip to `outDir`. */
async function crxToZip(crxPath: string, outDir: string): Promise<string> {
  const buf = await readFile(crxPath);
  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") {
    // Not a CRX — maybe a plain zip mislabeled. Use as-is.
    return crxPath;
  }
  const version = buf.readUInt32LE(4);
  let zipStart: number;
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else {
    throw new Error(`Unsupported CRX version ${version}.`);
  }
  if (zipStart <= 0 || zipStart >= buf.length) {
    throw new Error("Corrupt CRX: invalid zip offset.");
  }
  const zipPath = join(outDir, `${randomUUID()}.zip`);
  await writeFile(zipPath, buf.subarray(zipStart));
  return zipPath;
}

/**
 * Compute the Chromium extension ID. With a manifest `key`, it's the SHA-256 of
 * the DER public key; otherwise it's the SHA-256 of the absolute install path
 * (how Chromium derives the ID for unpacked extensions). First 16 bytes, hex,
 * mapped 0–f → a–p.
 */
export function computeExtensionId(opts: { key?: string; absPath?: string }): string {
  let digestInput: Buffer;
  if (opts.key) {
    digestInput = Buffer.from(opts.key, "base64");
  } else {
    digestInput = Buffer.from(opts.absPath ?? "", "utf8");
  }
  const hash = createHash("sha256").update(digestInput).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    const byte = hash[i] ?? 0;
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/** If `dir` has no manifest.json but a single subdirectory that does, return it. */
async function resolveManifestRoot(dir: string): Promise<string> {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());
  if (subdirs.length === 1 && subdirs[0]) {
    const inner = join(dir, subdirs[0].name);
    if (existsSync(join(inner, "manifest.json"))) return inner;
  }
  return dir;
}

/** Resolve a display name, dereferencing `__MSG_x__` via the default locale. */
async function resolveName(
  manifest: { name?: string; default_locale?: string },
  extDir: string,
): Promise<string> {
  const raw = manifest.name ?? "";
  const msg = /^__MSG_(.+)__$/.exec(raw);
  if (msg && manifest.default_locale) {
    try {
      const messagesPath = join(extDir, "_locales", manifest.default_locale, "messages.json");
      const messages = JSON.parse(await readFile(messagesPath, "utf8")) as Record<
        string,
        { message?: string }
      >;
      const key = msg[1] ?? "";
      const resolved =
        messages[key]?.message ?? messages[key.toLowerCase()]?.message ?? undefined;
      if (resolved) return resolved;
    } catch {
      // fall through to a sensible fallback
    }
  }
  return raw && !msg ? raw : "Extension";
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        const s = await stat(p).catch(() => null);
        if (s) total += s.size;
      }
    }
  }
  return total;
}

/** Exposed for callers that download a CRX to a temp file first. */
export function tempCrxPath(): string {
  return join(tmpdir(), `mz-ext-${randomUUID()}.crx`);
}
