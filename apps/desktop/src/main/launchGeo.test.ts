import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FingerprintConfig, ProxyConfig } from "@multizen/types";
import { resolveProxyLaunchGeo } from "./launchGeo";
import { StrictGeoCoherenceError } from "./launchTimezone";

const proxy = { type: "socks5", host: "127.0.0.1", port: 1080 } as unknown as ProxyConfig;
const fp = {
  locale: "en-US",
  timezone: "America/New_York",
  country: "us",
} as unknown as FingerprintConfig;
const geoLA = {
  timezone: "America/Los_Angeles",
  country: "US",
  latitude: 34,
  longitude: -118,
};

function deps(geo: unknown, countries: string[] = []) {
  return {
    setProxyCountry: (_id: string, c: string) => void countries.push(c),
    probe: (async () => {
      if (geo instanceof Error) throw geo;
      return geo;
    }) as never,
  };
}

test("no proxy: nothing is probed and the persona stands", async () => {
  let probed = false;
  const res = await resolveProxyLaunchGeo({ id: "p" }, fp, {
    setProxyCountry: () => {},
    probe: (async () => {
      probed = true;
      return {};
    }) as never,
  });
  assert.equal(probed, false);
  assert.equal(res.fingerprint.timezone, "America/New_York");
  assert.equal(res.coords, null);
});

test("strict pin by default: geo feeds coords + country, the pinned timezone wins", async () => {
  const countries: string[] = [];
  const res = await resolveProxyLaunchGeo({ id: "p", proxy }, fp, deps(geoLA, countries));
  assert.equal(res.fingerprint.timezone, "America/New_York");
  assert.deepEqual(res.coords, { latitude: 34, longitude: -118 });
  assert.deepEqual(countries, ["us"]);
});

test("alignTimezoneToProxy applies a geo timezone the locale allows", async () => {
  const res = await resolveProxyLaunchGeo(
    { id: "p", proxy, alignTimezoneToProxy: true },
    fp,
    deps(geoLA),
  );
  assert.equal(res.fingerprint.timezone, "America/Los_Angeles");
  assert.equal(fp.timezone, "America/New_York", "the input fingerprint is not mutated");
});

test("strictGeoCoherence rejects the launch on a country mismatch", async () => {
  await assert.rejects(
    resolveProxyLaunchGeo(
      { id: "p", proxy, strictGeoCoherence: true },
      fp,
      deps({ ...geoLA, country: "DE" }),
    ),
    StrictGeoCoherenceError,
  );
});

test("a failed probe never blocks the launch, even with strictGeoCoherence", async () => {
  const res = await resolveProxyLaunchGeo(
    { id: "p", proxy, strictGeoCoherence: true },
    fp,
    deps(new Error("timed out")),
  );
  assert.equal(res.fingerprint.timezone, "America/New_York");
  assert.equal(res.coords, null);
});
