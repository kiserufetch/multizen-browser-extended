import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle, readAssetLock, rewriteAsset, type AssetBundle } from "./assets.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function bundle(files: Record<string, string>): AssetBundle {
  return {
    repository: "https://example.invalid/repo",
    commit: "0123456789abcdef",
    urlTemplate: "https://example.invalid/{commit}/{file}",
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])),
  };
}

function withCache(work: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "mzb-assets-"));
    try {
      await work(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "a bundle is fetched at its pinned commit, into a path of its own, nested files too",
  withCache(async (cache) => {
    const urls: string[] = [];
    const fetchFile = (async (url: string) => {
      urls.push(url);
      return new Response(url.endsWith("a.js") ? "alpha" : "beta");
    }) as unknown as typeof fetch;
    const dir = await ensureBundle("page", bundle({ "a.js": "alpha", "sub/b.js": "beta" }), cache, fetchFile);
    assert.equal(dir, join(cache, "page-0123456789ab"));
    assert.deepEqual(urls, [
      "https://example.invalid/0123456789abcdef/a.js",
      "https://example.invalid/0123456789abcdef/sub/b.js",
    ]);
    assert.equal(readFileSync(join(dir, "sub", "b.js"), "utf8"), "beta");
  }),
);

test(
  "a matching file in the cache isn't fetched again; a tampered one is replaced",
  withCache(async (cache) => {
    let fetches = 0;
    const fetchFile = (async () => {
      fetches += 1;
      return new Response("alpha");
    }) as unknown as typeof fetch;
    const b = bundle({ "a.js": "alpha" });
    const dir = await ensureBundle("page", b, cache, fetchFile);
    await ensureBundle("page", b, cache, fetchFile);
    assert.equal(fetches, 1);
    writeFileSync(join(dir, "a.js"), "tampered");
    await ensureBundle("page", b, cache, fetchFile);
    assert.equal(fetches, 2);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), "alpha");
  }),
);

test(
  "the wrong bytes are refused and leave nothing to be served",
  withCache(async (cache) => {
    const fetchFile = (async () => new Response("not alpha")) as unknown as typeof fetch;
    await assert.rejects(ensureBundle("page", bundle({ "a.js": "alpha" }), cache, fetchFile), /has sha256/);
    assert.equal(existsSync(join(cache, "page-0123456789ab", "a.js")), false);
  }),
);

test(
  "an unreachable or refusing server fails the bundle with where it tried",
  withCache(async (cache) => {
    const unreachable = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(ensureBundle("page", bundle({ "a.js": "alpha" }), cache, unreachable), /fetch failed/);
    const refusing = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(ensureBundle("page", bundle({ "a.js": "alpha" }), cache, refusing), /answered 404/);
  }),
);

test("rewriteAsset replaces every occurrence, and refuses when the pattern is gone", () => {
  assert.equal(rewriteAsset("a x a", [{ from: "a", to: "b" }]), "b x b");
  assert.throws(() => rewriteAsset("x", [{ from: "a", to: "b" }]), /Expected to find/);
});

test("the checked-in lock pins both detector pages to full commits and sha256s", () => {
  const lock = readAssetLock(fileURLToPath(new URL("../assets.lock.json", import.meta.url)));
  assert.deepEqual(Object.keys(lock).sort(), ["creepjs", "rebrowser-bot-detector"]);
  for (const b of Object.values(lock)) {
    assert.match(b.commit, /^[0-9a-f]{40}$/);
    assert.ok(Object.keys(b.files).length > 0);
    for (const hash of Object.values(b.files)) assert.match(hash, /^[0-9a-f]{64}$/);
  }
});
