import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One detector page at a pinned commit, and what each of its files must hash to. */
export interface AssetBundle {
  repository: string;
  commit: string;
  /** `{commit}` and `{file}` get filled in. */
  urlTemplate: string;
  /** File name to sha256. */
  files: Record<string, string>;
}

export type AssetLock = Record<string, AssetBundle>;

export function readAssetLock(path: string): AssetLock {
  return JSON.parse(readFileSync(path, "utf8")) as AssetLock;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const FETCH_TIMEOUT_MS = 60_000;

/**
 * The bundle's directory under `cacheRoot`, each file checked against the lock. A file
 * already there and matching isn't fetched again. One that fails any of this fails the
 * whole bundle: a half-served detector would report nonsense.
 */
export async function ensureBundle(
  name: string,
  bundle: AssetBundle,
  cacheRoot: string,
  fetchFile: typeof fetch = fetch,
): Promise<string> {
  const dir = join(cacheRoot, `${name}-${bundle.commit.slice(0, 12)}`);
  for (const [file, expected] of Object.entries(bundle.files)) {
    const path = join(dir, file);
    if (existsSync(path) && sha256(readFileSync(path)) === expected) continue;
    const url = bundle.urlTemplate.replace("{commit}", bundle.commit).replace("{file}", file);
    const response = await fetchFile(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`${url} has sha256 ${actual}, the lock says ${expected}`);
    mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, path);
  }
  return dir;
}

/** Replaces each `from` in a served file. A pattern that's gone means the pin moved. */
export function rewriteAsset(text: string, rules: ReadonlyArray<{ from: string; to: string }>): string {
  let out = text;
  for (const { from, to } of rules) {
    if (!out.includes(from)) throw new Error(`Expected to find "${from}" in the pinned file`);
    out = out.split(from).join(to);
  }
  return out;
}
