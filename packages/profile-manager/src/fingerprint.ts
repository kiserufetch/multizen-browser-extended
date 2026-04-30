import type { FingerprintConfig } from "@multizen/types";

const macFingerprints: FingerprintConfig[] = [
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "en-US",
    timezone: "America/New_York",
    screen: { width: 1440, height: 900 },
    webgl: { vendor: "Apple Inc.", renderer: "Apple M1 Pro" },
    hardwareConcurrency: 10,
    deviceMemory: 16,
    platform: "MacIntel",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "en-GB",
    timezone: "Europe/London",
    screen: { width: 1680, height: 1050 },
    webgl: { vendor: "Apple Inc.", renderer: "Apple M2" },
    hardwareConcurrency: 8,
    deviceMemory: 16,
    platform: "MacIntel",
  },
];

const winFingerprints: FingerprintConfig[] = [
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    locale: "en-US",
    timezone: "America/Chicago",
    screen: { width: 1920, height: 1080 },
    webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)" },
    hardwareConcurrency: 16,
    deviceMemory: 32,
    platform: "Win32",
  },
];

/**
 * Pick a sane fingerprint preset deterministically from a seed string.
 * In v0.2 we ship a small curated pool; the closed fingerprint engine
 * generates fresh ones in production builds.
 */
export function defaultFingerprint(seed: string): FingerprintConfig {
  const pool = [...macFingerprints, ...winFingerprints];
  const idx = hashString(seed) % pool.length;
  const fp = pool[idx];
  if (!fp) throw new Error("Fingerprint pool empty");
  return structuredClone(fp);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
