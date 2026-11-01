import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeNetLog } from "./netlog.ts";

const TYPES = {
  HOST_RESOLVER_MANAGER_REQUEST: 1,
  HOST_RESOLVER_MANAGER_JOB: 2,
  SOCKS5_CONNECT: 3,
  DNS_TRANSACTION_HTTPS_ATTEMPT: 4,
  HOST_RESOLVER_MANAGER_DNS_CONFIG_CHANGED: 5,
};

function netlog(events: Array<{ type: number; params?: Record<string, unknown> }>): string {
  return `{"constants":${JSON.stringify({ logEventTypes: TYPES })},"events":[\n${events
    .map((e) => JSON.stringify(e))
    .join(",\n")},\n]}`.replace(",\n]}", "\n]}");
}

const DIRECT = netlog([
  { type: 1, params: { host: "https://a.invalid:443", dns_query_type: "UNSPECIFIED" } },
  { type: 2, params: { host: "https://a.invalid:443", dns_query_types: ["A", "AAAA", "HTTPS"], secure_dns_mode: 1 } },
  { type: 4 },
  { type: 5, params: { nameservers: ["192.0.2.53"] } },
]);

test("a browser that resolves a name itself shows it, with its query types and DoH mode", () => {
  const r = analyzeNetLog(DIRECT) as {
    events: Record<string, number>;
    namesAsked: string[];
    resolvedByTheBrowser: Record<string, unknown>;
  };
  assert.deepEqual(r.namesAsked, ["https://a.invalid"]);
  assert.deepEqual(r.resolvedByTheBrowser, {
    "https://a.invalid": { queryTypes: ["A", "AAAA", "HTTPS"], secureDns: "automatic" },
  });
  assert.equal(r.events.DNS_TRANSACTION_HTTPS_ATTEMPT, 1);
  assert.equal(r.events.SOCKS5_CONNECT, 0);
});

test("this machine's DNS servers stay out of the report", () => {
  assert.ok(!JSON.stringify(analyzeNetLog(DIRECT)).includes("192.0.2.53"));
});

test("a browser behind a proxy resolves nothing for the name, and that reads as such", () => {
  const r = analyzeNetLog(netlog([{ type: 3 }, { type: 3 }])) as {
    events: Record<string, number>;
    resolvedByTheBrowser: Record<string, unknown>;
  };
  assert.equal(r.events.SOCKS5_CONNECT, 2);
  assert.deepEqual(r.resolvedByTheBrowser, {});
});

test("a log cut off mid-event still gives what it got to", () => {
  const whole = netlog([
    { type: 3 },
    { type: 1, params: { host: "https://a.invalid:443" } },
    { type: 3 },
  ]);
  const cut = whole.slice(0, whole.lastIndexOf("{") + 4);
  const r = analyzeNetLog(cut) as { events: Record<string, number>; namesAsked: string[] };
  assert.equal(r.events.SOCKS5_CONNECT, 1);
  assert.deepEqual(r.namesAsked, ["https://a.invalid"]);
});

test("a log with nothing complete in it is an error, for the section to report", () => {
  assert.throws(() => analyzeNetLog('{"constants":'), /no complete event/);
});
