import { test } from "node:test";
import assert from "node:assert/strict";
import type { MultizenError } from "@multizen/types";
import { EgressPolicy, parseEgressAllowEntry, type EgressLookup } from "./egressPolicy.ts";

const noLookup: EgressLookup = () => {
  throw new Error("this path must not look anything up");
};

const resolvesTo =
  (...addresses: string[]): EgressLookup =>
  async () =>
    addresses.map((address) => ({ address }));

function enforcing(allow: string[] = [], lookup: EgressLookup = noLookup): EgressPolicy {
  return new EgressPolicy({ mode: "block-private", allow, lookup });
}

const BLOCKED_ADDRESSES = [
  // IPv4, one or two from each range and both ends of the narrow ones.
  "0.0.0.0",
  "0.1.2.3",
  "10.0.0.1",
  "10.255.255.255",
  "100.64.0.0",
  "100.100.100.200",
  "100.127.255.255",
  "127.0.0.1",
  "127.1.2.3",
  "168.63.129.16",
  "169.254.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.1",
  "192.0.0.192",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.255",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6.
  "::",
  "::1",
  "fc00::1",
  "fd00:ec2::254",
  "fe80::1",
  "fec0::1",
  "ff02::1",
  // IPv4-mapped, in each spelling, with what it carries deciding.
  "::ffff:169.254.169.254",
  "::ffff:a9fe:a9fe",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:0:0",
  // NAT64.
  "64:ff9b::a9fe:a9fe",
  "64:ff9b::169.254.169.254",
  "64:ff9b::7f00:1",
  "64:ff9b:1::1",
  // The other forms that carry an IPv4 address.
  "::ffff:0:a9fe:a9fe",
  "::a9fe:a9fe",
  "::127.0.0.1",
  "2002:a9fe:a9fe::1",
  "2002:7f00:1::",
  "2001::1",
];

const PUBLIC_ADDRESSES = [
  "1.1.1.1",
  "8.8.8.8",
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.1",
  "169.253.255.255",
  "169.255.0.1",
  "172.15.255.255",
  "172.32.0.0",
  "192.0.1.1",
  "192.167.255.255",
  "192.169.0.0",
  "198.17.255.255",
  "198.20.0.0",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "2a00:1450:4001:81b::200e",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "2002:808:808::1",
];

for (const address of BLOCKED_ADDRESSES) {
  test(`${address} is blocked on both paths`, async () => {
    const policy = enforcing();
    assert.equal(policy.checkProxied(address, 80).allowed, false);
    assert.equal((await policy.checkDirect(address, 80)).allowed, false);
    assert.equal(policy.checkProxied(`[${address}]`, 80).allowed, false, "bracketed, as in a URL");
  });
}

for (const address of PUBLIC_ADDRESSES) {
  test(`${address} passes on both paths`, async () => {
    const policy = enforcing();
    assert.equal(policy.checkProxied(address, 443).allowed, true);
    assert.equal((await policy.checkDirect(address, 443)).allowed, true);
  });
}

test("a direct check of a literal dials that literal; a mapped address as its IPv4 self", async () => {
  const policy = enforcing();
  assert.deepEqual((await policy.checkDirect("8.8.8.8", 80)).connectTo, ["8.8.8.8"]);
  assert.deepEqual((await policy.checkDirect("2606:4700::1", 80)).connectTo, ["2606:4700::1"]);
  assert.deepEqual((await policy.checkDirect("::ffff:808:808", 80)).connectTo, ["8.8.8.8"]);
  assert.equal(policy.checkProxied("8.8.8.8", 80).connectTo, undefined, "what a proxied profile dials is its proxy");
});

// ── names ────────────────────────────────────────────────────────────────────

for (const [name, means] of [
  ["2852039166", "169.254.169.254 in decimal"],
  ["0xa9fea9fe", "169.254.169.254 in hex"],
  ["025177524776", "169.254.169.254 in octal"],
  ["0xA9.0xFE.0xA9.0xFE", "169.254.169.254 by part, in any case"],
  ["0251.0376.0251.0376", "169.254.169.254 in octal parts"],
  ["169.254.43518", "three parts"],
  ["169.16689662", "two parts"],
  ["0x7f.1", "127.0.0.1"],
  ["127.1", "127.0.0.1"],
  ["2130706433", "127.0.0.1"],
  ["017700000001", "127.0.0.1"],
  ["0", "0.0.0.0"],
  ["0x", "0.0.0.0"],
  ["10.1", "10.0.0.1"],
  ["127.0.0.1.", "a trailing dot"],
  ["2852039166.", "a trailing dot"],
  ["1.2.3.256", "not an address, and no such domain"],
  ["1.2.3.4.5", "too many parts"],
  ["999999999999", "too large"],
  ["08", "not octal"],
  ["foo.1", "ends in a number"],
  ["foo.0x1", "ends in a hex number"],
]) {
  test(`the numeric-looking name "${name}" (${means}) is blocked, with no lookup`, async () => {
    const policy = enforcing();
    assert.equal(policy.checkProxied(name!, 80).allowed, false);
    assert.equal((await policy.checkDirect(name!, 80)).allowed, false);
  });
}

test("a numeric-looking name that means a public address passes, as that address", async () => {
  const policy = enforcing();
  assert.deepEqual((await policy.checkDirect("134744072", 80)).connectTo, ["8.8.8.8"]);
  assert.equal(policy.checkProxied("0x8.0x8.0x8.0x8", 80).allowed, true);
});

for (const name of [
  "localhost",
  "LOCALHOST",
  "localhost.",
  "foo.localhost",
  "a.b.localhost",
  "metadata",
  "metadata.google.internal",
  "METADATA.GOOGLE.INTERNAL.",
  "instance-data",
  "anything.internal",
  "host.docker.internal",
]) {
  test(`the name "${name}" is blocked on both paths, with no lookup`, async () => {
    const policy = enforcing();
    assert.equal(policy.checkProxied(name, 80).allowed, false);
    assert.equal((await policy.checkDirect(name, 80)).allowed, false);
  });
}

test("names that only look like the blocked ones are ordinary names", () => {
  const policy = enforcing();
  for (const name of ["notlocalhost", "localhost.example.com", "metadata.example.com", "internal", "a.internal.example"]) {
    assert.equal(policy.checkProxied(name, 80).allowed, true, name);
  }
});

test("what is neither a name nor an address is refused", async () => {
  const policy = enforcing();
  for (const host of ["", ".", "a b", "a\0b"]) {
    assert.equal(policy.checkProxied(host, 80).allowed, false, JSON.stringify(host));
    assert.equal((await policy.checkDirect(host, 80)).allowed, false, JSON.stringify(host));
  }
});

// ── direct: resolve, then classify every address ─────────────────────────────

test("direct: a name resolving to a private address is blocked", async () => {
  const decision = await enforcing([], resolvesTo("169.254.169.254")).checkDirect("rebind.example", 80);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /169\.254\.169\.254/);
  assert.equal(decision.unresolved, undefined);
});

test("direct: only the allowed addresses of a mixed answer are ever to be dialed", async () => {
  const lookup = resolvesTo("10.0.0.1", "8.8.8.8", "::1", "2606:4700::1", "::ffff:127.0.0.1");
  const decision = await enforcing([], lookup).checkDirect("mixed.example", 80);
  assert.deepEqual(decision, { allowed: true, connectTo: ["8.8.8.8", "2606:4700::1"] });
});

test("direct: a name that doesn't resolve is no refusal, and has nothing to dial", async () => {
  const failing: EgressLookup = async () => {
    throw new Error("ENOTFOUND");
  };
  for (const lookup of [failing, resolvesTo()]) {
    const decision = await enforcing([], lookup).checkDirect("nowhere.example", 80);
    assert.equal(decision.allowed, false);
    assert.equal(decision.unresolved, true);
    assert.equal(decision.connectTo, undefined);
  }
});

test("proxied: nothing is ever looked up, whatever the host", async () => {
  const policy = enforcing([], noLookup);
  for (const host of ["example.com", "rebind.example", "169.254.169.254", "metadata", "2852039166"]) {
    policy.checkProxied(host, 80);
    await policy.assertUrlAllowed(`http://${host}/`, { proxied: true }).catch(() => {});
  }
  assert.equal(policy.checkProxied("rebind.example", 80).allowed, true, "only the proxy can resolve this");
});

// ── the upstream proxy's own address ─────────────────────────────────────────

test("upstream: judged like a direct connection, name included", async () => {
  const proxy = (host: string): { type: "socks5"; host: string; port: number } => ({
    type: "socks5",
    host,
    port: 1080,
  });
  assert.equal((await enforcing().checkUpstream(proxy("169.254.169.254"))).allowed, false);
  assert.equal((await enforcing().checkUpstream(proxy("2852039166"))).allowed, false);
  assert.equal((await enforcing().checkUpstream(proxy("metadata.google.internal"))).allowed, false);
  assert.equal(
    (await enforcing([], resolvesTo("10.0.0.5")).checkUpstream(proxy("pivot.example"))).allowed,
    false,
  );
  const good = await enforcing([], resolvesTo("203.0.113.9")).checkUpstream(proxy("proxy.example"));
  assert.deepEqual(good.connectTo, ["203.0.113.9"]);
});

test("upstream: --egress-allow makes the exception, by address, port or name", async () => {
  const proxy = { host: "127.0.0.1", port: 1080 };
  assert.equal((await enforcing(["127.0.0.1"]).checkUpstream(proxy)).allowed, true);
  assert.equal((await enforcing(["127.0.0.1:1080"]).checkUpstream(proxy)).allowed, true);
  assert.equal((await enforcing(["127.0.0.1:1081"]).checkUpstream(proxy)).allowed, false);
  const named = await enforcing(["proxy.lan"], resolvesTo("192.168.1.5")).checkUpstream({
    host: "proxy.lan",
    port: 1080,
  });
  assert.deepEqual(named.connectTo, ["192.168.1.5"]);
});

test("assertProxyAllowed: EGRESS_BLOCKED for a refusal, nothing for a name that won't resolve", async () => {
  await assert.rejects(enforcing().assertProxyAllowed({ host: "169.254.169.254", port: 80 }), (e: MultizenError) => {
    assert.equal(e.code, "EGRESS_BLOCKED");
    assert.equal(e.retryable, false);
    assert.match(e.hint ?? "", /--egress-allow/);
    return true;
  });
  const failing: EgressLookup = async () => {
    throw new Error("ENOTFOUND");
  };
  await enforcing([], failing).assertProxyAllowed({ host: "gone.example", port: 80 });
});

// ── the allowlist ────────────────────────────────────────────────────────────

test("allow: an IP", async () => {
  const policy = enforcing(["10.1.2.3", "fd00::5"]);
  assert.equal(policy.checkProxied("10.1.2.3", 80).allowed, true);
  assert.equal(policy.checkProxied("10.1.2.4", 80).allowed, false);
  assert.equal(policy.checkProxied("fd00::5", 80).allowed, true);
  assert.equal(policy.checkProxied("fd00:0:0::5", 80).allowed, true, "another spelling");
  assert.equal(policy.checkProxied("fd00::6", 80).allowed, false);
  assert.equal(policy.checkProxied("::ffff:10.1.2.3", 80).allowed, true, "the same address, mapped");
  assert.equal(policy.checkProxied("0xa010203", 80).allowed, true, "the same address, as a number");
});

test("allow: a CIDR, IPv4 and IPv6", () => {
  const policy = enforcing(["10.1.0.0/16", "fd00:1::/32"]);
  assert.equal(policy.checkProxied("10.1.255.255", 80).allowed, true);
  assert.equal(policy.checkProxied("10.2.0.0", 80).allowed, false);
  assert.equal(policy.checkProxied("fd00:1:2::3", 80).allowed, true);
  assert.equal(policy.checkProxied("fd00:2::3", 80).allowed, false);
});

test("allow: a name overrides the name list, and what it resolves to", async () => {
  const policy = enforcing(["metadata.google.internal", "db.lan"], resolvesTo("10.0.0.9"));
  assert.equal(policy.checkProxied("metadata.google.internal", 80).allowed, true);
  assert.deepEqual((await policy.checkDirect("db.lan", 5432)).connectTo, ["10.0.0.9"]);
  assert.equal((await policy.checkDirect("other.lan", 5432)).allowed, false);
});

test("allow: *.suffix takes the subdomains, not the name itself", async () => {
  const policy = enforcing(["*.corp.example"], resolvesTo("10.0.0.9"));
  assert.equal((await policy.checkDirect("a.corp.example", 80)).allowed, true);
  assert.equal((await policy.checkDirect("a.b.corp.example", 80)).allowed, true);
  assert.equal((await policy.checkDirect("corp.example", 80)).allowed, false);
  assert.equal((await policy.checkDirect("evilcorp.example", 80)).allowed, false);
});

test("allow: host:port holds only for that port, in every form", async () => {
  const policy = enforcing(
    ["127.0.0.1:8080", "[::1]:8081", "localhost:8082", "*.lan:8083", "10.0.0.0/8:8084"],
    resolvesTo("192.168.0.1"),
  );
  for (const [host, port] of [
    ["127.0.0.1", 8080],
    ["::1", 8081],
    ["[::1]", 8081],
    ["localhost", 8082],
    ["printer.lan", 8083],
    ["10.9.9.9", 8084],
  ] as const) {
    assert.equal((await policy.checkDirect(host, port)).allowed, true, `${host}:${port}`);
    assert.equal((await policy.checkDirect(host, port + 100)).allowed, false, `${host}:${port + 100}`);
  }
});

test("allow: a URL's default port counts", async () => {
  const policy = enforcing(["127.0.0.1:80", "127.0.0.2:443"]);
  await policy.assertUrlAllowed("http://127.0.0.1/", { proxied: false });
  await policy.assertUrlAllowed("https://127.0.0.2/", { proxied: false });
  await assert.rejects(policy.assertUrlAllowed("https://127.0.0.1/", { proxied: false }), { code: "EGRESS_BLOCKED" });
});

for (const bad of ["", "*", "*.", "a b", "10.0.0.0/33", "fd00::/129", "host:0", "host:70000", "host:x", "1.2.3.256", "http://x", "a/b"]) {
  test(`allow: "${bad}" is refused`, () => {
    assert.throws(() => parseEgressAllowEntry(bad), /--egress-allow takes/);
    assert.throws(() => new EgressPolicy({ mode: "block-private", allow: [bad] }), /--egress-allow takes/);
  });
}

// ── URLs ─────────────────────────────────────────────────────────────────────

for (const url of [
  "http://169.254.169.254/latest/meta-data/",
  "http://2852039166/",
  "http://0x7f.1/",
  "http://[::ffff:169.254.169.254]/",
  "http://[::1]:8080/",
  "https://localhost/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://user:s3cret@127.0.0.1/",
  "http://LOCALHOST:7777/",
]) {
  test(`${url} is EGRESS_BLOCKED, on both paths`, async () => {
    for (const proxied of [false, true]) {
      await assert.rejects(enforcing().assertUrlAllowed(url, { proxied }), (e: MultizenError) => {
        assert.equal(e.code, "EGRESS_BLOCKED");
        assert.ok(!e.message.includes("s3cret"), "the error gets logged");
        assert.ok(!e.message.includes("meta-data"), "only the origin");
        return true;
      });
    }
  });
}

test("a URL to a public name: resolved for a direct profile, not for a proxied one", async () => {
  let lookups = 0;
  const counting: EgressLookup = async () => {
    lookups += 1;
    return [{ address: "8.8.8.8" }];
  };
  const policy = enforcing([], counting);
  await policy.assertUrlAllowed("https://example.com/", { proxied: true });
  assert.equal(lookups, 0);
  await policy.assertUrlAllowed("https://example.com/", { proxied: false });
  assert.equal(lookups, 1);
});

test("a URL whose name doesn't resolve is the browser's to fail, not the policy's", async () => {
  const failing: EgressLookup = async () => {
    throw new Error("ENOTFOUND");
  };
  await enforcing([], failing).assertUrlAllowed("http://nowhere.example/", { proxied: false });
});

test("what isn't an http(s) URL is left to the tool's own validation", async () => {
  const policy = enforcing();
  for (const url of ["not a url", "file:///etc/passwd", "about:blank", "javascript:1"]) {
    await policy.assertUrlAllowed(url, { proxied: false });
  }
});

// ── allow-all ────────────────────────────────────────────────────────────────

test("allow-all: everything passes with no lookup, and nothing is pinned", async () => {
  const policy = new EgressPolicy({ mode: "allow-all", lookup: noLookup });
  assert.equal(policy.enforced, false);
  assert.deepEqual(policy.checkProxied("169.254.169.254", 80), { allowed: true });
  assert.deepEqual(await policy.checkDirect("169.254.169.254", 80), { allowed: true });
  assert.deepEqual(await policy.checkDirect("example.com", 80), { allowed: true });
  assert.deepEqual(await policy.checkUpstream({ host: "metadata", port: 80 }), { allowed: true });
  await policy.assertUrlAllowed("http://169.254.169.254/", { proxied: false });
  await policy.assertProxyAllowed({ host: "169.254.169.254", port: 80 });
});

test("block-private enforces", () => {
  assert.equal(enforcing().enforced, true);
});
