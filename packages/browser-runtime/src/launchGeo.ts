import { localeCatalog } from "@multizen/profile-manager";
import type { FingerprintConfig, Profile, ProfileId } from "@multizen/types";
import { resolveLaunchTimezone, StrictGeoCoherenceError } from "./launchTimezone";
import { probeProxyGeo } from "./proxyGeo";

export interface ProxyLaunchGeo {
  fingerprint: FingerprintConfig;
  /** The proxy egress coordinates, null without a proxy or when the probe failed. */
  coords: { latitude: number; longitude: number } | null;
}

export interface ProxyLaunchGeoDeps {
  /** Cache the egress country on the profile so the GUI flag chip matches it. */
  setProxyCountry: (profileId: ProfileId, country: string) => void;
  probe?: typeof probeProxyGeo;
}

/**
 * The launch-time proxy geo policy, shared by every engine. Strict-pin: the
 * pinned fingerprint.timezone wins by default and proxy geo only feeds the
 * coordinates. Opt-in alignTimezoneToProxy may overwrite TZ only when the geo TZ
 * is in the locale's timezones[]; opt-in strictGeoCoherence rejects the launch
 * with StrictGeoCoherenceError on a country mismatch. A failed probe never
 * blocks a launch. Without a proxy nothing is probed, so the persona timezone
 * stands as configured (it is never snapped to the host timezone).
 */
export async function resolveProxyLaunchGeo(
  profile: Pick<Profile, "id" | "proxy" | "alignTimezoneToProxy" | "strictGeoCoherence">,
  fingerprint: FingerprintConfig,
  deps: ProxyLaunchGeoDeps,
): Promise<ProxyLaunchGeo> {
  if (!profile.proxy) return { fingerprint, coords: null };

  let fp = fingerprint;
  let coords: ProxyLaunchGeo["coords"] = null;
  const localeEntry = localeCatalog().find((l) => l.locale === fp.locale || l.id === fp.locale);
  const localeTimezones = localeEntry?.timezones ?? [fp.timezone];
  try {
    const geo = await (deps.probe ?? probeProxyGeo)(profile.proxy, { timeoutMs: 4000 });
    if (typeof geo.latitude === "number" && typeof geo.longitude === "number") {
      coords = { latitude: geo.latitude, longitude: geo.longitude };
    }
    // Cache the resolved country on the profile so the GUI flag chip
    // matches the proxy's egress (Luxembourg proxy → LU flag, not the
    // fingerprint's timezone-derived country).
    if (geo.country) {
      deps.setProxyCountry(profile.id, geo.country.toLowerCase());
    }
    const resolved = resolveLaunchTimezone(fp, geo, localeTimezones, {
      alignTimezoneToProxy: profile.alignTimezoneToProxy,
      strictGeoCoherence: profile.strictGeoCoherence,
    });
    for (const w of resolved.warnings) {
      console.warn(`[multizen] ${w}`);
    }
    if (resolved.appliedGeoTimezone && resolved.timezone !== fp.timezone) {
      console.log(
        `[multizen] aligning fingerprint timezone ${fp.timezone} → ${resolved.timezone} (alignTimezoneToProxy)`,
      );
      fp = { ...fp, timezone: resolved.timezone };
    }
  } catch (e) {
    if (e instanceof StrictGeoCoherenceError) throw e;
    console.warn(
      "[multizen] proxy geo probe failed; geolocation/timezone alignment skipped:",
      (e as Error).message,
    );
  }
  return { fingerprint: fp, coords };
}
