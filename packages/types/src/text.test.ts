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

test("withOriginsOnly stays fast on a long run of dotted words", () => {
  const started = performance.now();
  withOriginsOnly("a.".repeat(500_000));
  assert.ok(performance.now() - started < 1_000);
});
