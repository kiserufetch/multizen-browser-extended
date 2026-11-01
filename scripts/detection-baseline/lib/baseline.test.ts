import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allUnavailable,
  ALL_SECTIONS,
  collectSections,
  findRef,
  LOCAL_SECTIONS,
  runExitCode,
  type BaselineContext,
  type BaselineDriver,
} from "./baseline.ts";
import type { SectionResult } from "./compare.ts";
import { startLocalSite } from "./localServer.ts";
import { startStunResponder } from "./stun.ts";
import { startTlsSite } from "./tlsSite.ts";

const UNREACHABLE_LOCK = {
  creepjs: {
    repository: "https://example.invalid/creepjs",
    commit: "0".repeat(40),
    urlTemplate: "https://example.invalid/{commit}/{file}",
    files: { "creep.js": "0".repeat(64) },
  },
  "rebrowser-bot-detector": {
    repository: "https://example.invalid/rebrowser",
    commit: "1".repeat(40),
    urlTemplate: "https://example.invalid/{commit}/{file}",
    files: { "index.js": "0".repeat(64) },
  },
};

const unreachableFetch = (async () => {
  throw new TypeError("fetch failed: example.invalid");
}) as unknown as typeof fetch;

async function withSites(
  driver: BaselineDriver,
  check: (sections: Record<string, SectionResult>, ctx: BaselineContext) => void | Promise<void>,
): Promise<void> {
  const site = await startLocalSite();
  const tls = await startTlsSite();
  const stun = await startStunResponder();
  const outDir = mkdtempSync(join(tmpdir(), "mzb-out-"));
  const cacheRoot = mkdtempSync(join(tmpdir(), "mzb-cache-"));
  try {
    const ctx: BaselineContext = {
      driver,
      profileId: "p",
      usesCdp: false,
      outDir,
      site,
      tls,
      stun,
      stunHost: "127.0.0.1",
      assetLock: UNREACHABLE_LOCK,
      cacheRoot,
      fetchFile: unreachableFetch,
      log: () => {},
    };
    await check(await collectSections(ctx), ctx);
  } finally {
    await site.close();
    await tls.close();
    await stun.close();
    rmSync(outDir, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

const gone = async (): Promise<never> => {
  throw new Error("browser gone");
};

/** A browser that isn't there: every call fails. */
const deadDriver: BaselineDriver = {
  navigate: gone,
  click: gone,
  type: gone,
  clickRef: gone,
  typeRef: gone,
  extract: gone,
  screenshot: gone,
  cdpSend: gone,
  evaluateJs: gone,
  performAction: gone,
};

const STUB_PNG = Buffer.from("x").toString("base64");

/** Answers the probe, the logger and WebRTC as a page would. Its navigate fetches for real. */
function workingDriver(): BaselineDriver & { visits: string[] } {
  const visits: string[] = [];
  let log: unknown[] = [];
  const reply = (value: unknown): unknown => ({ result: { value } });
  return {
    visits,
    navigate: async (_id, url) => {
      visits.push(url);
      await fetch(url.replace("localhost", "127.0.0.1"), { signal: AbortSignal.timeout(3000) }).catch(() => {});
      return { url };
    },
    click: async () => {
      log = [
        { type: "pointerdown", trusted: true, timeStamp: 1, pressure: 0.5, pointerType: "mouse" },
        { type: "mousedown", trusted: true, timeStamp: 1, button: 0, buttons: 1, detail: 1 },
        { type: "mouseup", trusted: true, timeStamp: 40, button: 0 },
        { type: "click", trusted: true, timeStamp: 41, detail: 1 },
      ];
      return { ok: true };
    },
    type: async () => {
      log = [{ type: "keydown", trusted: true, timeStamp: 1, key: "H", code: "KeyH", keyCode: 72 }];
      return { ok: true };
    },
    clickRef: async () => ({ ok: true }),
    typeRef: async () => ({ ok: true }),
    extract: async () => ({
      result: {
        accessibilityTree: [
          { role: "button", name: "Ref button", ref: "e1" },
          { role: "group", children: [{ role: "textbox", name: "Ref text", ref: "e2" }] },
        ],
      },
    }),
    screenshot: async () => ({ pngBase64: STUB_PNG }),
    cdpSend: async () => ({}),
    performAction: async () => ({ ok: true }),
    evaluateJs: async (_id, expression) => {
      if (expression.includes("mz-report")) {
        const page = visits.at(-1) ?? "";
        if (page.includes("/p/probe.html")) {
          return reply(
            JSON.stringify({
              userAgent: "Chrome/146",
              webdriver: false,
              fonts: { present: { windows: ["Arial"], linux: [], mac: [] }, widths: {} },
            }),
          );
        }
        if (page.includes("/p/webrtc.html")) return reply(JSON.stringify({ candidates: [], srflx: 0 }));
        return reply(null);
      }
      if (expression.includes("mz-log")) {
        const taken = log;
        log = [];
        return reply(taken.map((e) => JSON.stringify(e)).join("\n"));
      }
      if (expression.includes("txt2")) return reply(JSON.stringify({ visibility: "visible" }));
      return reply(null);
    },
  };
}

test("with no browser every local probe is unavailable, each with its reason, and the run fails", async () => {
  await withSites(deadDriver, (sections) => {
    for (const name of LOCAL_SECTIONS) {
      const section = sections[name] as { status: string; reason: string };
      assert.equal(section.status, "unavailable", name);
      assert.ok(section.reason.length > 0, name);
    }
    assert.equal(runExitCode(sections), 1);
  });
});

test("allUnavailable covers every section, so a browser that never came up fails the run", () => {
  const sections = allUnavailable("no browser");
  assert.deepEqual(Object.keys(sections).sort(), [...ALL_SECTIONS].sort());
  assert.equal(runExitCode(sections), 1);
  assert.deepEqual(sections.tls, { status: "unavailable", reason: "no browser" });
});

test("one local probe is enough for the run to pass", () => {
  const sections = allUnavailable("no");
  sections.probe = { status: "ok", data: {} };
  assert.equal(runExitCode(sections), 0);
});

test("a detector page alone doesn't make a run: it isn't a local probe", () => {
  const sections = allUnavailable("no");
  sections.creepjs = { status: "ok", data: {} };
  sections.rebrowser = { status: "ok", data: {} };
  assert.equal(runExitCode(sections), 1);
});

test("an unreachable asset URL makes its section unavailable, and the local probes still run", async () => {
  const driver = workingDriver();
  await withSites(driver, (sections, ctx) => {
    assert.equal(sections.probe?.status, "ok");
    assert.equal(sections.fonts?.status, "ok");
    assert.equal(sections.input?.status, "ok");
    assert.equal(sections.webrtc?.status, "ok");
    for (const name of ["creepjs", "rebrowser"]) {
      const section = sections[name] as { status: string; reason: string };
      assert.equal(section.status, "unavailable", name);
      assert.match(section.reason, /example\.invalid/);
    }
    assert.equal(runExitCode(sections), 0);
    assert.ok(driver.visits.some((url) => url.includes("/p/probe.html")));
    assert.equal(readFileSync(join(ctx.outDir, "probe.png"), "utf8"), "x");
  });
});

test("the probe's own request is what the headers section reports, and without its port", async () => {
  await withSites(workingDriver(), (sections, ctx) => {
    assert.equal(sections.headers?.status, "ok");
    const data = (sections.headers as { data: { navigation: { values: Record<string, string> } } }).data;
    assert.equal(data.navigation.values.host, "127.0.0.1:<port>");
    assert.ok(!JSON.stringify(data).includes(String(ctx.site.port)));
  });
});

test("the input section reports each action, and a failure on one stays on that one", async () => {
  const failing: BaselineDriver = {
    ...workingDriver(),
    performAction: async (_id, action) => {
      if (action.type === "hover") throw new Error("no hover today");
      return { ok: true };
    },
  };
  await withSites(failing, (sections) => {
    assert.equal(sections.input?.status, "ok");
    const data = (
      sections.input as { data: Record<string, { error: string | null; allTrusted?: boolean; sequence?: string[] }> }
    ).data;
    assert.equal(data.hover?.error, "no hover today");
    assert.equal(data.click?.error, null);
    assert.equal(data.click?.allTrusted, true);
    assert.deepEqual(data.click?.sequence, ["pointerdown", "mousedown", "mouseup", "click"]);
    assert.equal(data.scroll?.error, null);
  });
});

test("no input action working at all makes the section unavailable", async () => {
  const failing: BaselineDriver = {
    ...workingDriver(),
    click: gone,
    type: gone,
    clickRef: gone,
    typeRef: gone,
    performAction: gone,
  };
  await withSites(failing, (sections) => {
    assert.equal(sections.input?.status, "unavailable");
    assert.equal(sections.probe?.status, "ok");
  });
});

test("the covered-window section only runs when there's something to cover it with", async () => {
  await withSites(workingDriver(), (sections) => assert.equal(sections.covered, undefined));
});

test("findRef reads both engines' forms", () => {
  const tree = {
    accessibilityTree: [{ role: "group", children: [{ role: "button", name: "Ref button", ref: "e7" }] }],
  };
  assert.equal(findRef(tree, "button", "Ref button"), "e7");
  assert.equal(findRef(tree, "button", "Other"), null);
  const snapshot = {
    ariaSnapshot: '- generic:\n  - button "Selector button" [ref=f1e2]\n  - button "Ref button" [ref=f1e3]',
  };
  assert.equal(findRef(snapshot, "button", "Ref button"), "f1e3");
  assert.equal(findRef(snapshot, "textbox", "Ref button"), null);
  assert.equal(findRef(null, "button", "x"), null);
});
