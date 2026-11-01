import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareExitCode,
  compareRuns,
  comparisonMarkdown,
  flatten,
  thresholdFailures,
  type RunResult,
} from "./compare.ts";

function run(data: Record<string, unknown>, meta: Record<string, unknown> = {}): RunResult {
  return {
    meta: { label: "x", seed: "s", persona: { device: "windows-desktop-nvidia" }, ...meta },
    sections: Object.fromEntries(
      Object.entries(data).map(([name, value]) => [name, { status: "ok" as const, data: value }]),
    ),
  };
}

test("flatten writes paths and keeps a list of plain values whole", () => {
  const flat = flatten({ a: { b: 1, c: [1, 2] }, d: [{ e: "x" }, { e: null }], f: [] });
  assert.deepEqual(
    [...flat.entries()],
    [
      ["a.b", 1],
      ["a.c", [1, 2]],
      ["d[0].e", "x"],
      ["d[1].e", null],
      ["f", []],
    ],
  );
});

test("the noise rules drop downlink, timestamps and timings, and nothing else", () => {
  const a = run({ probe: { connection: { downlink: 10, rtt: 50 }, timeStamp: 1, timings: { x: 1 }, keep: 1 } });
  const b = run({ probe: { connection: { downlink: 1.5, rtt: 50 }, timeStamp: 2, timings: { x: 2 }, keep: 2 } });
  const c = compareRuns(a, b);
  assert.deepEqual(c.differences.map((d) => d.path), ["probe.keep"]);
  assert.equal(c.noiseCount, 3);
});

test("a canvas is noise across seeds and a real difference with the same seed", () => {
  const a = run({ probe: { canvasHash: 1 } });
  const sameSeed = compareRuns(a, run({ probe: { canvasHash: 2 } }));
  assert.equal(sameSeed.differences.length, 1);
  const otherSeed = compareRuns(a, run({ probe: { canvasHash: 2 } }, { seed: "other" }));
  assert.equal(otherSeed.differences.length, 0);
  assert.equal(otherSeed.noiseCount, 1);
});

test("what differs between A and its own repeat isn't held against B", () => {
  const a = run({ probe: { flaky: 1, real: 1 } });
  const repeat = run({ probe: { flaky: 2, real: 1 } });
  const b = run({ probe: { flaky: 3, real: 2 } });
  const c = compareRuns(a, b, { repeats: [repeat] });
  assert.deepEqual(c.differences.map((d) => d.path), ["probe.real"]);
  assert.equal(c.repeatNoiseCount, 1);
});

test("the same goes for B and its repeat", () => {
  const a = run({ probe: { flaky: 1, real: 1 } });
  const b = run({ probe: { flaky: 3, real: 2 } });
  const repeatOfB = run({ probe: { flaky: 4, real: 2 } });
  const c = compareRuns(a, b, { repeatsOfB: [repeatOfB] });
  assert.deepEqual(c.differences.map((d) => d.path), ["probe.real"]);
});

test("a section one run couldn't take is a difference, with the reason", () => {
  const a = run({ tls: { ja4: "x" } });
  const b: RunResult = { meta: a.meta, sections: { tls: { status: "unavailable", reason: "no page" } } };
  const c = compareRuns(a, b);
  const paths = c.differences.map((d) => d.path).sort();
  assert.deepEqual(paths, ["tls.ja4", "tls.reason", "tls.status"]);
});

test("thresholds fire on HeadlessChrome anywhere, webdriver true, pointer none", () => {
  assert.deepEqual(thresholdFailures(run({ probe: { ua: "Chrome/146", webdriver: false } })), []);
  assert.deepEqual(thresholdFailures(run({ probe: { ua: "HeadlessChrome/146" } })), [
    "HeadlessChrome at probe.ua",
  ]);
  assert.deepEqual(thresholdFailures(run({ creepjs: { list: ["a", "x HeadlessChrome y"] } })), [
    "HeadlessChrome at creepjs.list",
  ]);
  assert.deepEqual(thresholdFailures(run({ probe: { webdriver: true } })), ["webdriver is true at probe.webdriver"]);
  assert.deepEqual(thresholdFailures(run({ creepjs: { headless: { webDriverIsOn: true } } })), [
    "webdriver is true at creepjs.headless.webDriverIsOn",
  ]);
  assert.deepEqual(thresholdFailures(run({ probe: { media: { "(pointer: none)": true } } })), [
    "pointer: none on a desktop persona at probe.media.(pointer: none)",
  ]);
  assert.deepEqual(thresholdFailures(run({ probe: { media: { "(pointer: none)": false } } })), []);
});

test("pointer none is no finding on a persona that isn't a desktop", () => {
  const phone = run({ probe: { media: { "(pointer: none)": true } } }, { persona: { device: "android-phone" } });
  assert.deepEqual(thresholdFailures(phone), []);
});

test("exit code: thresholds always fail, differences only when asked", () => {
  const clean = compareRuns(run({ probe: { a: 1 } }), run({ probe: { a: 1 } }));
  const differing = compareRuns(run({ probe: { a: 1 } }), run({ probe: { a: 2 } }));
  const fired = compareRuns(run({ probe: { webdriver: true } }), run({ probe: { webdriver: true } }));
  assert.equal(compareExitCode(clean, true), 0);
  assert.equal(compareExitCode(differing, false), 0);
  assert.equal(compareExitCode(differing, true), 1);
  assert.equal(compareExitCode(fired, false), 2);
  assert.equal(compareExitCode(fired, true), 2);
});

test("the report names the runs, groups by section in reading order and escapes cells", () => {
  const a = run(
    {
      probe: { ua: "a|b" },
      tls: { ja4: "t13" },
      creepjs: { same: 1 },
      fonts: { present: ["Arial", "Calibri", "Cambria", "Consolas", "Georgia", "Segoe UI"] },
    },
    { label: "win", engine: "cloakbrowser", mode: "headed" },
  );
  const b = run(
    {
      probe: { ua: "c" },
      tls: { ja4: "t12" },
      creepjs: { same: 1 },
      fonts: { present: ["Arial", "DejaVu Sans", "Cambria", "Consolas", "Georgia"] },
    },
    { label: "lin", engine: "cloakbrowser", mode: "xvfb" },
  );
  const text = comparisonMarkdown(a, b, compareRuns(a, b));
  assert.match(text, /^# win vs lin/);
  assert.ok(text.indexOf("## probe") < text.indexOf("## fonts"));
  assert.ok(text.indexOf("## fonts") < text.indexOf("## tls"));
  assert.ok(text.indexOf("## tls") < text.indexOf("## creepjs"));
  assert.match(text, /a\\\|b/);
  assert.match(text, /## creepjs \(0\)\s+No differences\./);
  assert.match(text, /only here \(2 of 6\): "?Calibri, Segoe UI/);
  assert.match(text, /only here \(1 of 5\): "?DejaVu Sans/);
  assert.match(text, /None fired/);
});

test("the report puts a fired threshold where it can't be missed", () => {
  const a = run({ probe: { webdriver: true } }, { label: "a" });
  const b = run({ probe: { webdriver: false } }, { label: "b" });
  const text = comparisonMarkdown(a, b, compareRuns(a, b));
  assert.match(text, /\*\*A: webdriver is true at probe\.webdriver\*\*/);
});
