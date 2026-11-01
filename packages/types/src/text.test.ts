import { test } from "node:test";
import assert from "node:assert/strict";
import { originOf, trimEndChars, wellFormed, withOriginsOnly } from "./index.js";

test("trimEndChars removes only the run at the end", () => {
  assert.equal(trimEndChars("a.b. .", ". "), "a.b");
  assert.equal(trimEndChars("abc", ". "), "abc");
  assert.equal(trimEndChars("...", "."), "");
  assert.equal(trimEndChars("", "."), "");
});

test("trimEndChars stays linear on what makes a regex quadratic", () => {
  const hostile = `x${".".repeat(4_000_000)}y`;
  const started = performance.now();
  assert.equal(trimEndChars(hostile, "."), hostile);
  assert.equal(trimEndChars(hostile.slice(0, -1), "."), "x");
  assert.ok(performance.now() - started < 500);
});

test("wellFormed replaces half a pair and keeps whole ones", () => {
  const half = "😀".slice(0, 1);
  assert.throws(() => encodeURIComponent(half), URIError);
  assert.equal(encodeURIComponent(wellFormed(half)), encodeURIComponent("�"));
  assert.equal(wellFormed("a😀"), "a😀");
});

test("originOf keeps no path, query, or userinfo", () => {
  assert.equal(originOf("https://user:hunter2@example.test:8443/a/b?token=abc#f"), "https://example.test:8443");
  assert.equal(originOf("about:blank"), "about:");
  assert.equal(originOf("not a url"), "(not a URL)");
});

test("withOriginsOnly cuts every URL in a message down to its origin", () => {
  assert.equal(
    withOriginsOnly('navigating to "http://u:p@a.test/x?token=1", then https://b.test/y?k=2 failed'),
    'navigating to "http://a.test", then https://b.test failed',
  );
  assert.equal(withOriginsOnly("no url here: net::ERR_FAILED"), "no url here: net::ERR_FAILED");
});

test("withOriginsOnly leaves nothing of a URL a quote or one slash would have cut short", () => {
  for (const [text, expected] of [
    ["navigating to https://h.example/a'token=abc123", "navigating to https://h.example"],
    ["failed at http:/h.example/?token=abc123 next", "failed at http://h.example next"],
    [String.raw`failed at https:\h.example\?t=abc123`, "failed at https://h.example"],
    ["'https://h.example/a?t=abc123'", "'https://h.example'"],
    ['loaded "https://h.example/a?t=abc123", then stopped', 'loaded "https://h.example", then stopped'],
    ["https://h.example'token=abc123", "(not a URL)"],
    ["x_https://h.example/?token=abc123", "x_https://h.example"],
  ] as const) {
    assert.equal(withOriginsOnly(text), expected);
  }
  // Not URLs, and an operator's log needs them.
  assert.equal(withOriginsOnly(String.raw`open 'C:\data\x y.db'`), String.raw`open 'C:\data\x y.db'`);
  assert.equal(withOriginsOnly("net::ERR_FAILED at 10:30:00 /a/b"), "net::ERR_FAILED at 10:30:00 /a/b");
});

test("withOriginsOnly stays linear on a long run of slashes and of quotes", () => {
  const started = performance.now();
  assert.equal(withOriginsOnly(`http:${"/".repeat(2_000_000)} `), "(not a URL) ");
  withOriginsOnly(`http://a/${"'".repeat(2_000_000)}`);
  assert.ok(performance.now() - started < 2_000);
});

test("withOriginsOnly stays fast on a long run of dotted words", () => {
  const started = performance.now();
  withOriginsOnly("a.".repeat(500_000));
  assert.ok(performance.now() - started < 1_000);
});
