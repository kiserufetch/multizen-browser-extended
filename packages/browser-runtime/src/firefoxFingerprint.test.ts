import { test } from "node:test";
import assert from "node:assert/strict";
import { generateFingerprint, reconcileFingerprint } from "@multizen/profile-manager";
import type { DeviceFamily, Profile } from "@multizen/types";
import {
  camoufoxConfigFor,
  osForDevice,
  pickCamoufoxWebgl,
  windowGeometry,
  type CamoufoxEnv,
} from "./firefoxFingerprint.ts";

/**
 * Camoufox personas must read the same at every launch, and be coherent with
 * themselves. camoufox-js draws a new BrowserForge fingerprint per launch and
 * only fills the keys our config leaves unset, so everything identifying is set
 * here from the persona or the profile's seed.
 */

const PAIRS: CamoufoxEnv["webglPairs"] = {
  lin: [
    { vendor: "Intel", renderer: "Intel(R) HD Graphics, or similar" },
    { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce GTX 980, or similar" },
    { vendor: "Intel", renderer: "Intel(R) HD Graphics 400, or similar" },
    { vendor: "AMD", renderer: "Radeon R9 200 Series, or similar" },
    { vendor: "AMD", renderer: "Radeon HD 3200 Graphics, or similar" },
    { vendor: "Mesa", renderer: "llvmpipe, or similar" },
    { vendor: "Intel", renderer: "Intel(R) HD Graphics 400" },
    { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce GTX 980/PCIe/SSE2" },
    { vendor: "Mesa", renderer: "GeForce GTX 980, or similar" },
  ],
  win: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, Radeon R9 200 Series Direct3D11 vs_5_0 ps_5_0), or similar" },
    { vendor: "Google Inc. (Microsoft)", renderer: "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0), or similar" },
  ],
  mac: [
    { vendor: "Apple", renderer: "Apple M1, or similar" },
    { vendor: "Intel Inc.", renderer: "Intel(R) HD Graphics 400, or similar" },
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar" },
  ],
};
const ENV: CamoufoxEnv = { firefoxMajor: "152", webglPairs: PAIRS };

function profileFor(device: DeviceFamily, seed = "cf-seed", id = "p1"): Profile {
  const fp = reconcileFingerprint(generateFingerprint(seed, { hostFilter: false }), { device });
  return { id, name: id, tags: [], fingerprint: { ...fp, seed }, dataDir: "/x", createdAt: "", updatedAt: "" };
}

const DEVICES: DeviceFamily[] = [
  "linux-laptop-intel",
  "linux-desktop-amd",
  "linux-desktop-nvidia",
  "windows-laptop-intel",
  "windows-desktop-nvidia",
  "windows-desktop-amd",
  "macbook-pro-14-m3",
];

test("the same profile gets the same Camoufox config at every launch", () => {
  for (const device of DEVICES) {
    const p = profileFor(device);
    assert.deepEqual(camoufoxConfigFor(p, ENV), camoufoxConfigFor(structuredClone(p), ENV), device);
  }
});

test("the persona's identity is pinned: threads, touch, UA and noise seeds", () => {
  const p = profileFor("linux-desktop-nvidia");
  const { config } = camoufoxConfigFor(p, ENV) as { config: Record<string, unknown> };
  assert.equal(config["navigator.hardwareConcurrency"], p.fingerprint.hardwareConcurrency);
  assert.equal(config["navigator.maxTouchPoints"], 0);
  assert.equal(config.timezone, p.fingerprint.timezone);
  assert.equal(
    config["navigator.userAgent"],
    "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
  );
  assert.equal(config["navigator.appVersion"], "5.0 (X11)");
  for (const key of ["fonts:spacing_seed", "audio:seed", "canvas:seed"]) {
    const v = config[key] as number;
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 0xffffffff, `${key}=${v}`);
  }
  const aa = config["canvas:aaOffset"] as number;
  assert.ok(Number.isInteger(aa) && aa >= -50 && aa <= 50, `aaOffset=${aa}`);
});

test("another seed is another device's noise; no seed falls back to the profile id", () => {
  const a = camoufoxConfigFor(profileFor("linux-desktop-amd", "seed-a"), ENV) as { config: Record<string, unknown> };
  const b = camoufoxConfigFor(profileFor("linux-desktop-amd", "seed-b"), ENV) as { config: Record<string, unknown> };
  assert.notEqual(a.config["canvas:seed"], b.config["canvas:seed"]);
  assert.notEqual(a.config["audio:seed"], b.config["audio:seed"]);

  const unseeded = (id: string): Profile => {
    const p = profileFor("linux-desktop-amd", "x", id);
    const { seed: _seed, ...fingerprint } = p.fingerprint;
    return { ...p, fingerprint };
  };
  const one = camoufoxConfigFor(unseeded("id-1"), ENV) as { config: Record<string, unknown> };
  assert.deepEqual(camoufoxConfigFor(unseeded("id-1"), ENV), one);
  const two = camoufoxConfigFor(unseeded("id-2"), ENV) as { config: Record<string, unknown> };
  assert.notEqual(one.config["canvas:seed"], two.config["canvas:seed"]);
});

test("window geometry: a maximized window inside the available area, never past the screen", () => {
  for (const device of DEVICES) {
    for (let i = 0; i < 20; i++) {
      const p = profileFor(device, `geo-${i}`);
      const fp = p.fingerprint;
      const os = osForDevice(fp.device);
      const g = windowGeometry(fp, os);
      assert.equal(g["screen.width"], fp.screen.width);
      assert.equal(g["screen.height"], fp.screen.height);
      assert.ok(g["screen.availWidth"]! <= g["screen.width"]!, device);
      assert.ok(g["screen.availTop"]! + g["screen.availHeight"]! <= g["screen.height"]!, device);
      assert.ok(g["window.innerWidth"]! <= g["window.outerWidth"]!, device);
      assert.ok(g["window.innerHeight"]! < g["window.outerHeight"]!, device);
      const chrome = g["window.outerHeight"]! - g["window.innerHeight"]!;
      assert.ok(chrome >= 60 && chrome <= 120, `${device}: ${chrome}px of browser UI`);
      if (os === "windows") {
        // Maximized on Windows: the frame overhangs the work area by 8 px a side.
        assert.equal(g["window.outerWidth"], g["screen.availWidth"]! + 16);
        assert.equal(g["window.screenX"], -8);
        assert.equal(g["window.innerWidth"], g["screen.availWidth"]);
      } else {
        assert.equal(g["window.outerWidth"], g["screen.availWidth"]);
        assert.equal(g["window.outerHeight"], g["screen.availHeight"]);
        assert.equal(g["window.screenY"], g["screen.availTop"]);
      }
    }
  }
});

test("a profile from before availScreen gets its platform's default work area", () => {
  const p = profileFor("linux-laptop-intel");
  const { availScreen: _a, ...fingerprint } = p.fingerprint;
  const g = windowGeometry(fingerprint, "linux");
  assert.equal(g["screen.availHeight"], p.fingerprint.screen.height - 30);
});

test("WebGL: the persona's GPU vendor, a sanitized hardware renderer, stable per profile", () => {
  const cases: Array<[DeviceFamily, RegExp]> = [
    ["linux-desktop-nvidia", /^NVIDIA Corporation$/],
    ["linux-laptop-intel", /^Intel$/],
    ["linux-desktop-amd", /^AMD$/],
    ["windows-desktop-nvidia", /NVIDIA/],
    ["windows-laptop-intel", /Intel/],
    ["windows-desktop-amd", /AMD/],
    ["macbook-pro-14-m3", /^Apple$/],
  ];
  for (const [device, vendor] of cases) {
    for (let i = 0; i < 30; i++) {
      const p = profileFor(device, `gpu-${i}`);
      const cfg = camoufoxConfigFor(p, ENV) as { webgl_config: [string, string] };
      const [v, r] = cfg.webgl_config;
      assert.match(v, vendor, `${device}: ${v} | ${r}`);
      assert.ok(r.endsWith(", or similar"), r);
      assert.doesNotMatch(r, /llvmpipe|Basic Render/);
    }
  }
});

test("WebGL: a profile keeps its pick when camoufox-js adds or drops other pairs", () => {
  const lin = PAIRS.lin!;
  const persona = { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) ...)" };
  const added = { vendor: "Intel", renderer: "Intel(R) Iris(R) Xe Graphics, or similar" };
  let movedToNew = 0;
  for (let i = 0; i < 200; i++) {
    const seed = `keep-${i}`;
    const pick = pickCamoufoxWebgl(lin, "linux", persona, seed)!;
    // Dropping any other pair never moves a profile.
    for (const gone of lin.filter((p) => p !== pick)) {
      assert.deepEqual(pickCamoufoxWebgl(lin.filter((p) => p !== gone), "linux", persona, seed), pick);
    }
    // Adding one moves a profile only onto the new pair.
    const after = pickCamoufoxWebgl([...lin, added], "linux", persona, seed)!;
    if (after !== pick) {
      assert.deepEqual(after, added);
      movedToNew++;
    }
  }
  // Two Intel pairs before, three after: about a third move, not all of them.
  assert.ok(movedToNew > 30 && movedToNew < 110, `${movedToNew}/200 moved`);
});

test("WebGL: with no pair of the persona's vendor, any usable one; with none usable, camoufox's own", () => {
  const onlyIntel = [{ vendor: "Intel", renderer: "Intel(R) HD Graphics, or similar" }];
  const nv = { vendor: "Google Inc. (NVIDIA Corporation)", renderer: "ANGLE (NVIDIA Corporation, ...)" };
  assert.deepEqual(pickCamoufoxWebgl(onlyIntel, "linux", nv, "s"), onlyIntel[0]);
  assert.equal(pickCamoufoxWebgl([{ vendor: "Mesa", renderer: "llvmpipe, or similar" }], "linux", nv, "s"), null);
  const cfg = camoufoxConfigFor(profileFor("linux-desktop-nvidia"), { firefoxMajor: "152", webglPairs: {} });
  assert.equal("webgl_config" in cfg, false);
});

test("WebGL: every Linux persona finds a pair of its vendor in camoufox-js's real data", async () => {
  const { getPossiblePairs } = await import("camoufox-js/dist/webgl/sample.js");
  const env: CamoufoxEnv = { firefoxMajor: "152", webglPairs: await getPossiblePairs() };
  for (const device of DEVICES) {
    const p = profileFor(device);
    const cfg = camoufoxConfigFor(p, env) as { webgl_config?: [string, string] };
    assert.ok(cfg.webgl_config, device);
    const want = /nvidia/i.test(p.fingerprint.webgl.renderer)
      ? /NVIDIA/
      : /AMD|Radeon/i.test(p.fingerprint.webgl.renderer)
        ? /AMD|ATI/
        : /Apple/.test(p.fingerprint.webgl.renderer)
          ? /Apple/
          : /Intel/;
    assert.match(cfg.webgl_config![0], want, `${device}: ${cfg.webgl_config!.join(" | ")}`);
  }
});
