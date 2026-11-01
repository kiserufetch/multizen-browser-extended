import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DeviceFamily, FingerprintConfig } from "@multizen/types";
import { generateFingerprint, migrateFingerprint, reconcileFingerprint } from "./fingerprint.js";
import { ProfileManager } from "./ProfileManager.js";

/**
 * Linux personas' WebGL pairs. CloakBrowser hands an "ANGLE (...)" renderer to
 * pages unchanged, shows any other string raw, and wraps a bare "NVIDIA ..."
 * renderer itself with a second "/PCIe/SSE2" (measured on 146.0.7680.177.5).
 * So every Linux pair must already be in Chrome-on-Linux form, and pairs stored
 * by the older catalog must be brought to it.
 */

const LINUX_FAMILIES: DeviceFamily[] = [
  "linux-laptop-intel",
  "linux-laptop-amd",
  "linux-laptop-nvidia",
  "linux-desktop-intel",
  "linux-desktop-amd",
  "linux-desktop-nvidia",
];

/** Every WebGL pair the generator can give a device family. */
function catalogPairs(device: DeviceFamily): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const fp = reconcileFingerprint(generateFingerprint(`webgl-${i}`, { hostFilter: false }), { device });
    seen.add(`${fp.webgl.vendor}|${fp.webgl.renderer}`);
  }
  return seen;
}

test("every Linux WebGL pair is in Chrome-on-Linux form, with no doubled driver suffix", () => {
  for (const device of LINUX_FAMILIES) {
    const pairs = catalogPairs(device);
    assert.ok(pairs.size >= 2, `${device}: ${pairs.size} pairs`);
    for (const pair of pairs) {
      const [vendor, renderer] = pair.split("|") as [string, string];
      const gl = /^Google Inc\. \((.+)\)$/.exec(vendor)?.[1];
      assert.ok(gl, `${device}: vendor ${vendor}`);
      assert.ok(renderer.startsWith(`ANGLE (${gl}, `), `${device}: ${renderer}`);
      assert.match(renderer, /, OpenGL [\d.]+ /, `${device}: ${renderer}`);
      assert.doesNotMatch(renderer, /(\/PCIe\/SSE2){2}/, `${device}: ${renderer}`);
      if (device.endsWith("-nvidia")) {
        assert.equal(vendor, "Google Inc. (NVIDIA Corporation)");
        assert.match(renderer, /^ANGLE \(NVIDIA Corporation, NVIDIA GeForce .+\/PCIe\/SSE2, OpenGL 4\.5\.0 NVIDIA [\d.]+\)$/);
      }
    }
  }
});

test("a seed still picks the same WebGL pair on every generate", () => {
  for (let i = 0; i < 20; i++) {
    const a = generateFingerprint(`stable-${i}`, { hostFilter: false });
    const b = generateFingerprint(`stable-${i}`, { hostFilter: false });
    assert.deepEqual(a.webgl, b.webgl);
  }
});

/** The older catalog's Linux pairs → what a saved profile becomes. */
const LEGACY: Array<[DeviceFamily, { vendor: string; renderer: string }, { vendor: string; renderer: string }]> = [
  [
    "linux-desktop-nvidia",
    { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4070/PCIe/SSE2" },
    {
      vendor: "Google Inc. (NVIDIA Corporation)",
      renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)",
    },
  ],
  [
    "linux-desktop-nvidia",
    // Was shown as vendor "Mesa" with the doubled renderer: same GPU, proprietary driver.
    { vendor: "Mesa", renderer: "NVIDIA GeForce RTX 4070/PCIe/SSE2" },
    {
      vendor: "Google Inc. (NVIDIA Corporation)",
      renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)",
    },
  ],
  [
    "linux-laptop-nvidia",
    { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4050 Laptop GPU/PCIe/SSE2" },
    {
      vendor: "Google Inc. (NVIDIA Corporation)",
      renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4050 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)",
    },
  ],
  [
    "linux-laptop-nvidia",
    // nouveau chip id (and not a real chip): takes the family's first GPU.
    { vendor: "Mesa", renderer: "NV178" },
    {
      vendor: "Google Inc. (NVIDIA Corporation)",
      renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4060 Laptop GPU/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 565.77)",
    },
  ],
  [
    "linux-laptop-intel",
    { vendor: "Mesa", renderer: "Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)" },
    {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.9)",
    },
  ],
  [
    "linux-laptop-intel",
    { vendor: "Intel", renderer: "Intel(R) Iris(R) Xe Graphics (0x0000A7A0)" },
    {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6 (Core Profile) Mesa 24.0.9)",
    },
  ],
  [
    "linux-desktop-amd",
    { vendor: "Mesa", renderer: "AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6, DRM 3.57, 6.6.0)" },
    {
      vendor: "Google Inc. (AMD)",
      renderer:
        "ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 17.0.6, DRM 3.57, 6.6.0), OpenGL 4.6 (Core Profile) Mesa 24.0.9)",
    },
  ],
];

function legacyFingerprint(device: DeviceFamily, webgl: { vendor: string; renderer: string }): FingerprintConfig {
  const fp = reconcileFingerprint(generateFingerprint("legacy", { hostFilter: false }), { device });
  return { ...fp, webgl };
}

test("migrateFingerprint keeps a saved Linux profile's GPU, in the form pages get unchanged", () => {
  for (const [device, before, after] of LEGACY) {
    const fp = legacyFingerprint(device, before);
    const migrated = migrateFingerprint(fp);
    assert.deepEqual(migrated.webgl, after, `${device} ${before.renderer}`);
    // Nothing else about the persona moves.
    assert.deepEqual({ ...migrated, webgl: fp.webgl }, fp);
    // The result is a catalog pair, so a later reconcile (e.g. a timezone change) keeps it.
    assert.deepEqual(reconcileFingerprint(migrated, { timezone: migrated.timezone }).webgl, after);
    // And a legacy pair reaching reconcile directly lands on the same GPU.
    assert.deepEqual(reconcileFingerprint(fp, {}).webgl, after);
    // Idempotent: a current pair is returned as the same object.
    assert.equal(migrateFingerprint(migrated), migrated);
  }
});

test("migrateFingerprint leaves a malformed stored pair alone instead of throwing", () => {
  const fp = legacyFingerprint("linux-desktop-nvidia", { vendor: "NVIDIA Corporation", renderer: "x" });
  const broken = { ...fp, webgl: {} } as unknown as FingerprintConfig;
  assert.equal(migrateFingerprint(broken), broken);
  const noWebgl = { ...fp, webgl: undefined } as unknown as FingerprintConfig;
  assert.equal(migrateFingerprint(noWebgl), noWebgl);
});

test("migrateFingerprint leaves Windows and macOS personas alone", () => {
  for (const device of ["windows-desktop-nvidia", "macbook-pro-14-m3"] as DeviceFamily[]) {
    const fp = reconcileFingerprint(generateFingerprint("keep", { hostFilter: false }), { device });
    assert.equal(migrateFingerprint(fp), fp);
  }
});

function openWith(t: TestContext, rows: Array<{ id: string; fp: FingerprintConfig }>): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-webgl-"));
  const dbPath = join(dir, "profiles.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT, tags TEXT NOT NULL DEFAULT '[]',
      proxy TEXT, fingerprint TEXT NOT NULL, data_dir TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO profiles (id, name, tags, fingerprint, data_dir, created_at, updated_at)
     VALUES (?, ?, '[]', ?, ?, 'c', 'u')`,
  );
  for (const r of rows) insert.run(r.id, r.id, JSON.stringify(r.fp), join(dir, r.id));
  db.close();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dbPath;
}

test("a saved legacy Linux profile is migrated on open, persisted once, updated_at untouched", (t) => {
  const [device, before, after] = LEGACY[0]!;
  const legacy = legacyFingerprint(device, before);
  const current = generateFingerprint("current", { hostFilter: false });
  const dbPath = openWith(t, [
    { id: "legacy", fp: legacy },
    { id: "current", fp: current },
  ]);
  const pm = new ProfileManager({ dbPath, profilesRoot: join(dbPath, "..", "profiles") });
  try {
    assert.deepEqual(pm.get("legacy")!.fingerprint.webgl, after);
    assert.deepEqual(pm.get("current")!.fingerprint, current);
  } finally {
    pm.close();
  }
  const db = new Database(dbPath);
  try {
    const row = db.prepare(`SELECT fingerprint, updated_at FROM profiles WHERE id = 'legacy'`).get() as {
      fingerprint: string;
      updated_at: string;
    };
    assert.deepEqual((JSON.parse(row.fingerprint) as FingerprintConfig).webgl, after);
    assert.equal(row.updated_at, "u");
  } finally {
    db.close();
  }
});
