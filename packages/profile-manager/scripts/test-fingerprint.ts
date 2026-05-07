/**
 * Sanity test for fingerprint coherence.
 *
 * Generates 200 fingerprints (100 random + 100 deterministic) and asserts
 * core invariants. Run with `tsx scripts/test-fingerprint.ts` from the
 * package root.
 */
import { generateFingerprint, deviceCatalog, localeCatalog } from "../src/fingerprint.js";
import type { FingerprintConfig } from "@multizen/types";

interface InvariantResult {
  name: string;
  passed: boolean;
  message?: string;
}

function check(fp: FingerprintConfig): InvariantResult[] {
  const results: InvariantResult[] = [];

  // ─── Platform alignment ───────────────────────────────────────────
  // navigator.platform must align with Sec-CH-UA-Platform.
  const platformPair: Record<string, string> = {
    MacIntel: "macOS",
    Win32: "Windows",
    "Linux x86_64": "Linux",
  };
  results.push({
    name: "navigator.platform ↔ Sec-CH-UA-Platform",
    passed: platformPair[fp.platform] === fp.clientHints.secChUaPlatform,
    message: `${fp.platform} vs ${fp.clientHints.secChUaPlatform}`,
  });

  // UA platform token must align with Sec-CH-UA-Platform.
  const uaSaysMac = fp.userAgent.includes("Macintosh");
  const uaSaysWin = fp.userAgent.includes("Windows NT");
  const uaSaysLinux = fp.userAgent.includes("X11; Linux");
  const expectedUaPlatform =
    fp.clientHints.secChUaPlatform === "macOS"
      ? uaSaysMac
      : fp.clientHints.secChUaPlatform === "Windows"
        ? uaSaysWin
        : fp.clientHints.secChUaPlatform === "Linux"
          ? uaSaysLinux
          : false;
  results.push({
    name: "UA platform token ↔ Sec-CH-UA-Platform",
    passed: expectedUaPlatform,
    message: `UA: "${fp.userAgent.slice(0, 60)}…" / SecCHUAPlatform: ${fp.clientHints.secChUaPlatform}`,
  });

  // ─── Architecture ─────────────────────────────────────────────────
  // Mac on Apple Silicon = arm; everything else here = x86.
  const expectedArch = fp.platform === "MacIntel" ? "arm" : "x86";
  results.push({
    name: "Sec-CH-UA-Arch matches device family",
    passed: fp.clientHints.secChUaArch === expectedArch,
    message: `arch=${fp.clientHints.secChUaArch}, expected=${expectedArch}`,
  });

  // ─── Bitness ──────────────────────────────────────────────────────
  results.push({
    name: "Sec-CH-UA-Bitness is 64",
    passed: fp.clientHints.secChUaBitness === "64",
  });

  // ─── Mobile flag ──────────────────────────────────────────────────
  results.push({
    name: "Sec-CH-UA-Mobile is ?0 (desktop)",
    passed: fp.clientHints.secChUaMobile === "?0",
  });

  // ─── Languages ────────────────────────────────────────────────────
  results.push({
    name: "languages[0] matches locale",
    passed: fp.languages[0] === fp.locale,
    message: `languages[0]=${fp.languages[0]}, locale=${fp.locale}`,
  });

  // Accept-Language header starts with the primary locale.
  results.push({
    name: "Accept-Language starts with locale",
    passed: fp.acceptLanguage.startsWith(fp.locale),
    message: `acceptLanguage="${fp.acceptLanguage}"`,
  });

  // ─── Timezone ↔ locale country ────────────────────────────────────
  // Just check that the timezone is in the catalog for this locale.
  const localeEntry = localeCatalog().find((l) => l.locale === fp.locale);
  results.push({
    name: "timezone is in locale's allowed list",
    passed: !!localeEntry && localeEntry.timezones.includes(fp.timezone),
    message: `timezone=${fp.timezone}, allowed=${localeEntry?.timezones.join(",")}`,
  });

  // ─── Country alignment ────────────────────────────────────────────
  results.push({
    name: "country matches locale catalog",
    passed: !!localeEntry && localeEntry.country === fp.country,
    message: `country=${fp.country}, expected=${localeEntry?.country}`,
  });

  // ─── Screen ───────────────────────────────────────────────────────
  const deviceEntry = deviceCatalog().find((d) => d.family === fp.device);
  const screenInDevice =
    !!deviceEntry &&
    deviceEntry.screens.some(
      (s) => s.width === fp.screen.width && s.height === fp.screen.height,
    );
  results.push({
    name: "screen size belongs to device family",
    passed: screenInDevice,
    message: `screen=${fp.screen.width}x${fp.screen.height}, device=${fp.device}`,
  });

  // availScreen <= screen
  results.push({
    name: "availScreen ≤ screen",
    passed:
      !fp.availScreen ||
      (fp.availScreen.width <= fp.screen.width &&
        fp.availScreen.height <= fp.screen.height),
  });

  // ─── DPR ──────────────────────────────────────────────────────────
  results.push({
    name: "dpr is 2 on Mac, 1 on Win/Linux",
    passed: fp.platform === "MacIntel" ? fp.dpr === 2 : fp.dpr === 1,
    message: `dpr=${fp.dpr}, platform=${fp.platform}`,
  });

  // ─── WebGL alignment ──────────────────────────────────────────────
  if (fp.platform === "MacIntel") {
    results.push({
      name: "Mac → WebGL vendor is Apple",
      passed: fp.webgl.vendor === "Apple Inc.",
    });
  } else if (fp.platform === "Win32") {
    results.push({
      name: "Win → WebGL renderer contains ANGLE",
      passed: fp.webgl.renderer.includes("ANGLE"),
    });
  } else if (fp.platform === "Linux x86_64") {
    results.push({
      name: "Linux → WebGL vendor is Mesa",
      passed: fp.webgl.vendor === "Mesa",
    });
  }

  // ─── HW concurrency / memory presence ─────────────────────────────
  results.push({
    name: "hardwareConcurrency > 0",
    passed: fp.hardwareConcurrency > 0,
  });
  results.push({
    name: "deviceMemory > 0",
    passed: fp.deviceMemory > 0,
  });

  // ─── Chrome version in UA matches Sec-CH-UA full version list ─────
  const uaChromeMatch = fp.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  const chFullMatch = fp.clientHints.secChUaFullVersionList.match(
    /"Google Chrome";v="([^"]+)"/,
  );
  results.push({
    name: "UA Chrome version == Sec-CH-UA-Full-Version-List Chrome",
    passed:
      !!uaChromeMatch && !!chFullMatch && uaChromeMatch[1] === chFullMatch[1],
    message: `UA: ${uaChromeMatch?.[1]}, CH: ${chFullMatch?.[1]}`,
  });

  return results;
}

function run(): void {
  let totalChecks = 0;
  let totalFails = 0;
  const failureSamples: Array<{ fp: FingerprintConfig; failures: InvariantResult[] }> = [];

  // 100 random
  for (let i = 0; i < 100; i++) {
    const fp = generateFingerprint();
    const results = check(fp);
    totalChecks += results.length;
    const failures = results.filter((r) => !r.passed);
    totalFails += failures.length;
    if (failures.length > 0 && failureSamples.length < 5) {
      failureSamples.push({ fp, failures });
    }
  }

  // 100 deterministic — same seed must yield same fp twice
  for (let i = 0; i < 100; i++) {
    const seed = `seed-${i}`;
    const fp1 = generateFingerprint(seed);
    const fp2 = generateFingerprint(seed);
    totalChecks++;
    if (JSON.stringify(fp1) !== JSON.stringify(fp2)) {
      totalFails++;
      console.error(`Determinism FAIL for seed=${seed}`);
    }
    const results = check(fp1);
    totalChecks += results.length;
    const failures = results.filter((r) => !r.passed);
    totalFails += failures.length;
    if (failures.length > 0 && failureSamples.length < 5) {
      failureSamples.push({ fp: fp1, failures });
    }
  }

  console.log(`\n${totalChecks - totalFails}/${totalChecks} invariants passed`);

  if (failureSamples.length > 0) {
    console.error("\nSample failures:");
    for (const sample of failureSamples) {
      console.error(`\nfp.device=${sample.fp.device}, fp.locale=${sample.fp.locale}`);
      for (const f of sample.failures) {
        console.error(`  ✗ ${f.name}${f.message ? `: ${f.message}` : ""}`);
      }
    }
    process.exit(1);
  }

  // Print one example
  console.log("\nExample fingerprint:");
  console.log(JSON.stringify(generateFingerprint("example"), null, 2));
}

run();
