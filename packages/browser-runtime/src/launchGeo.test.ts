import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FingerprintConfig, ProxyConfig } from "@multizen/types";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { resolveProxyLaunchGeo } from "./launchGeo";
import { probeProxyGeo } from "./proxyGeo";
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

test("a proxy the policy couldn't resolve isn't probed: that lookup would be past the policy", async () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    let probed = false;
    const res = await resolveProxyLaunchGeo({ id: "p", proxy }, fp, {
      setProxyCountry: () => {},
      upstream: { allowed: false, unresolved: true, reason: "did not resolve" },
      probe: (async () => {
        probed = true;
        return geoLA;
      }) as never,
    });
    assert.equal(probed, false);
    assert.equal(res.coords, null);
    assert.equal(res.fingerprint.timezone, "America/New_York");
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("the probe is told which addresses were checked", async () => {
  const seen: unknown[] = [];
  await resolveProxyLaunchGeo({ id: "p", proxy }, fp, {
    setProxyCountry: () => {},
    upstream: { allowed: true, connectTo: ["93.184.216.34"] },
    probe: (async (_proxy: unknown, opts: unknown) => {
      seen.push(opts);
      return geoLA;
    }) as never,
  });
  assert.deepEqual(seen, [{ timeoutMs: 4000, connectTo: ["93.184.216.34"] }]);
});

test("without a policy the probe runs as it always did", async () => {
  const seen: unknown[] = [];
  await resolveProxyLaunchGeo({ id: "p", proxy }, fp, {
    setProxyCountry: () => {},
    probe: (async (_proxy: unknown, opts: unknown) => {
      seen.push(opts);
      return geoLA;
    }) as never,
  });
  assert.deepEqual(seen, [{ timeoutMs: 4000 }]);
});

for (const type of ["http", "socks5"] as const) {
  test(`${type}: a probe with connectTo dials that address, whatever the proxy's name says`, async () => {
    let connections = 0;
    const server =
      type === "http"
        ? createHttpServer()
        : createNetServer();
    server.on("connection", (socket) => {
      connections += 1;
      socket.on("error", () => {});
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // `.invalid` never resolves, so only the pin can get this anywhere.
      const pinnedProxy = { type, host: "proxy.invalid", port } as unknown as ProxyConfig;
      await assert.rejects(probeProxyGeo(pinnedProxy, { timeoutMs: 1500, connectTo: ["127.0.0.1"] }));
      assert.ok(connections > 0, "nothing reached the checked address");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
