import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDriver, DriverAction } from "@multizen/types";
import { ensureBundle, rewriteAsset, type AssetLock } from "./assets.ts";
import type { SectionResult } from "./compare.ts";
import { summarizeEvents, type LoggedEvent } from "./inputSummary.ts";
import { describeClientHello, ja4 } from "./ja4.ts";
import type { LocalSite } from "./localServer.ts";
import type { StunResponder } from "./stun.ts";
import type { TlsSite } from "./tlsSite.ts";

export const LOCAL_SECTIONS = ["probe", "headers", "fonts", "input", "webrtc", "tls", "h2"] as const;
export const ALL_SECTIONS = [...LOCAL_SECTIONS, "rebrowser", "creepjs"] as const;

export type BaselineDriver = Pick<
  BrowserDriver,
  "navigate" | "click" | "type" | "clickRef" | "typeRef" | "extract" | "screenshot" | "cdpSend" | "evaluateJs" | "performAction"
>;

export interface BaselineContext {
  driver: BaselineDriver;
  profileId: string;
  /** CDP engines take the certificate through CDP. Camoufox got told at launch. */
  usesCdp: boolean;
  outDir: string;
  site: LocalSite;
  tls: TlsSite;
  stun: StunResponder;
  /** An address of this machine that isn't loopback: WebRTC ignores loopback. */
  stunHost: string;
  assetLock: AssetLock;
  cacheRoot: string;
  fetchFile?: typeof fetch;
  log(message: string): void;
  /** Covers the browser's window for the given time. Absent: that section doesn't run. */
  coverWindow?: (ms: number) => Promise<void>;
}

const PROBE_BUDGET_MS = 30_000;
const WEBRTC_BUDGET_MS = 15_000;
const CREEPJS_BUDGET_MS = 90_000;
const CREEPJS_RENDER_MS = 1_500;
const REBROWSER_SETTLE_MS = 4_000;
const REBROWSER_AFTER_TRIGGER_MS = 1_000;
const POLL_MS = 250;
const INPUT_SETTLE_MS = 300;
const TLS_SETTLE_MS = 1_500;
const ACTION_BUDGET_MS = 35_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Past this a call has hung, and everything after it has a better chance on its own. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(ctx: BaselineContext, expression: string): Promise<unknown> {
  const reply = (await ctx.driver.evaluateJs(ctx.profileId, expression)) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (reply?.exceptionDetails) {
    const details = reply.exceptionDetails;
    throw new Error(`The page threw: ${details.exception?.description ?? details.text ?? "unknown"}`);
  }
  return reply?.result?.value;
}

async function pollString(ctx: BaselineContext, expression: string, budgetMs: number, what: string): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await evaluate(ctx, expression);
    if (typeof value === "string") return value;
    await delay(POLL_MS);
  }
  throw new Error(`${what} didn't report within ${budgetMs} ms`);
}

/**
 * What a page of ours finished with. It's in the DOM, the one thing both engines' evaluate
 * can read: on Camoufox it runs in an isolated world, with none of the page's globals.
 */
function reportOf(ctx: BaselineContext, what: string, budgetMs: number): Promise<string> {
  return pollString(
    ctx,
    "(() => { const el = document.getElementById('mz-report'); return el && el.dataset.done ? el.textContent : null; })()",
    budgetMs,
    what,
  );
}

function saveJson(ctx: BaselineContext, name: string, value: unknown): void {
  writeFileSync(join(ctx.outDir, name), JSON.stringify(value, null, 1));
}

async function saveScreenshot(ctx: BaselineContext, name: string): Promise<void> {
  const { pngBase64 } = await ctx.driver.screenshot(ctx.profileId);
  writeFileSync(join(ctx.outDir, name), Buffer.from(pngBase64, "base64"));
}

/** The screenshot is evidence, not the measurement: one that fails doesn't take the data with it. */
async function tryScreenshot(ctx: BaselineContext, name: string): Promise<void> {
  try {
    await within(saveScreenshot(ctx, name), 15_000, "screenshot");
  } catch (e) {
    ctx.log(`no ${name}: ${message(e)}`);
  }
}

// ── probe, headers, fonts ───────────────────────────────────────────────────

interface ProbeOutcome {
  probe: Record<string, unknown>;
  fonts: Record<string, unknown>;
}

async function takeProbe(ctx: BaselineContext): Promise<ProbeOutcome> {
  await ctx.driver.navigate(ctx.profileId, ctx.site.url("/p/probe.html"));
  const report = JSON.parse(await reportOf(ctx, "The probe page", PROBE_BUDGET_MS)) as Record<string, unknown>;
  if (report.pageError) throw new Error(`The probe page failed: ${String(report.pageError)}`);
  await tryScreenshot(ctx, "probe.png");
  const { fonts, ...probe } = report as { fonts: { present: Record<string, string[]> } } & Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const [family, names] of Object.entries(fonts.present)) counts[family] = names.length;
  return { probe, fonts: { ...fonts, counts } };
}

function headerReport(request: { httpVersion: string; headers: Array<[string, string]> } | undefined): unknown {
  if (!request) return null;
  return {
    httpVersion: request.httpVersion,
    order: request.headers.map(([name]) => name),
    values: Object.fromEntries(request.headers.map(([name, value]) => [name.toLowerCase(), value])),
  };
}

function takeHeaders(ctx: BaselineContext): Record<string, unknown> {
  const navigation = ctx.site.requestsFor("/p/probe.html")[0];
  if (!navigation) throw new Error("The probe page's request never reached the server");
  return {
    navigation: headerReport(navigation),
    subresourceAfterAcceptCh: headerReport(ctx.site.requestsFor("/p/probe-sub")[0]),
  };
}

// ── input ───────────────────────────────────────────────────────────────────

/** A ref from either engine's extract: an accessibility tree, or Playwright's text form. */
export function findRef(extracted: unknown, role: string, name: string): string | null {
  const result = extracted as { accessibilityTree?: unknown[]; ariaSnapshot?: string };
  if (typeof result?.ariaSnapshot === "string") {
    for (const line of result.ariaSnapshot.split("\n")) {
      if (line.includes(`${role} "${name}"`)) {
        const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
        if (ref) return ref;
      }
    }
    return null;
  }
  const walk = (nodes: unknown[]): string | null => {
    for (const node of nodes as Array<{ role?: string; name?: string; ref?: string; children?: unknown[] }>) {
      if (node.role === role && node.name === name && node.ref) return node.ref;
      const below = walk(node.children ?? []);
      if (below) return below;
    }
    return null;
  };
  return walk(result?.accessibilityTree ?? []);
}

async function refFor(ctx: BaselineContext, role: string, name: string): Promise<string> {
  const { result } = await ctx.driver.extract(ctx.profileId);
  const ref = findRef(result, role, name);
  if (!ref) throw new Error(`extract gave no ref for ${role} "${name}"`);
  return ref;
}

const TAKE_INPUT_LOG =
  "(() => { const el = document.getElementById('mz-log'); const text = el.textContent; el.textContent = ''; return text; })()";
const INPUT_PAGE_STATE = `JSON.stringify({
  txt: document.getElementById('txt').value,
  txt2: document.getElementById('txt2').value,
  sel: document.getElementById('sel').value,
  scrollY,
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
})`;

async function takeInput(ctx: BaselineContext): Promise<Record<string, unknown>> {
  const { driver, profileId } = ctx;
  await driver.navigate(profileId, ctx.site.url("/p/input-logger.html"));
  const act = (action: DriverAction) => driver.performAction(profileId, action);
  const actions: Array<[string, () => Promise<unknown>]> = [
    ["click", () => driver.click(profileId, "#btn")],
    ["click_ref", async () => driver.clickRef(profileId, await refFor(ctx, "button", "Ref button"))],
    ["type", () => driver.type(profileId, "#txt", "Hello, World 1")],
    ["type_ref", async () => driver.typeRef(profileId, await refFor(ctx, "textbox", "Ref text"), "Abc 2")],
    ["press_key", () => act({ type: "press_key", key: "Tab" })],
    ["hover", () => act({ type: "hover", target: { selector: "#hov" } })],
    ["scroll", () => act({ type: "scroll", deltaY: 300 })],
    ["select_option", () => act({ type: "select_option", target: { selector: "#sel" }, label: "Two" })],
  ];
  const report: Record<string, unknown> = {};
  const rawLog: Record<string, unknown> = {};
  let anyWorked = false;
  for (const [name, run] of actions) {
    let error: string | null = null;
    try {
      await within(run(), ACTION_BUDGET_MS, name);
      anyWorked = true;
    } catch (e) {
      error = message(e);
      ctx.log(`input ${name}: ${error}`);
    }
    await delay(INPUT_SETTLE_MS);
    let events: LoggedEvent[] = [];
    try {
      events = String(await evaluate(ctx, TAKE_INPUT_LOG))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoggedEvent);
    } catch (e) {
      error ??= `reading the log: ${message(e)}`;
    }
    rawLog[name] = events;
    report[name] = { error, ...summarizeEvents(events) };
  }
  saveJson(ctx, "input-events.json", rawLog);
  if (!anyWorked) throw new Error(`No input action worked: ${JSON.stringify(report.click)}`);
  try {
    report.pageState = JSON.parse(String(await evaluate(ctx, INPUT_PAGE_STATE)));
  } catch (e) {
    report.pageState = { error: message(e) };
  }
  return report;
}

// ── WebRTC ──────────────────────────────────────────────────────────────────

async function takeWebrtc(ctx: BaselineContext): Promise<Record<string, unknown>> {
  const before = ctx.stun.requests();
  const stun = `${ctx.stunHost}:${ctx.stun.port}`;
  await ctx.driver.navigate(ctx.profileId, ctx.site.url(`/p/webrtc.html?stun=${encodeURIComponent(stun)}`));
  const report = JSON.parse(await reportOf(ctx, "The WebRTC page", WEBRTC_BUDGET_MS)) as Record<string, unknown>;
  if (report.pageError) throw new Error(`The WebRTC page failed: ${String(report.pageError)}`);
  return { ...report, stunRequestsSeen: ctx.stun.requests() - before };
}

// ── TLS and HTTP/2 ──────────────────────────────────────────────────────────

/** A self-signed site, for this one page load. Only ever from here, never reachable by MCP. */
async function withCertificatesIgnored(ctx: BaselineContext, work: () => Promise<void>): Promise<void> {
  const set = (ignore: boolean): Promise<unknown> =>
    ctx.driver.cdpSend(ctx.profileId, "Security.setIgnoreCertificateErrors", { ignore }, undefined, { safe: true });
  if (ctx.usesCdp) await set(true);
  try {
    await work();
  } finally {
    if (ctx.usesCdp) await set(false).catch(() => {});
  }
}

async function takeTls(ctx: BaselineContext): Promise<{ tls: Record<string, unknown>; h2: Record<string, unknown> | string }> {
  let navigateError: string | null = null;
  await withCertificatesIgnored(ctx, async () => {
    try {
      await ctx.driver.navigate(ctx.profileId, ctx.tls.url);
    } catch (e) {
      navigateError = message(e);
    }
    await delay(TLS_SETTLE_MS);
  });
  const hellos = ctx.tls.connections().filter((c) => c.hello);
  const first = hellos[0];
  if (!first?.hello) {
    throw new Error(`No ClientHello reached the site${navigateError ? `: ${navigateError}` : ""}`);
  }
  await tryScreenshot(ctx, "tls.png");
  // Chromium's first try ends on the certificate, and it comes back for the page once told
  // to take it: the hello is the first connection's, what it negotiated the one served's.
  const served = hellos.find((c) => c.alpn) ?? first;
  const tls = {
    navigateError,
    negotiatedAlpn: served.alpn,
    connections: hellos.length,
    ja4PerConnection: hellos.map((c) => ja4(c.hello!).ja4),
    ...describeClientHello(first.hello),
  };
  const fingerprint = ctx.tls.h2();
  const withRequest = hellos.find((c) => c.alpn === "h2" && c.requestHeaders.length > 0);
  if (!fingerprint || !withRequest) {
    const why = navigateError ? `, and ${navigateError}` : "";
    return { tls, h2: `No HTTP/2 request: the browser negotiated ${String(served.alpn)}${why}` };
  }
  return {
    tls,
    h2: {
      ...fingerprint,
      headerOrder: withRequest.requestHeaders.map(([name]) => name),
      headerValues: Object.fromEntries(
        withRequest.requestHeaders
          .filter(([name]) => !name.startsWith(":"))
          .map(([name, value]) => [name, value.split(String(ctx.tls.port)).join("<port>")]),
      ),
    },
  };
}

// ── rebrowser-bot-detector ─────────────────────────────────────────────────

const REBROWSER_REWRITES = [
  // Its latest-Chrome lookup and its CSP test's script are the page's only requests off this
  // machine. The first comes back "unavailable", which the page reports as neutral. The second
  // only tests whether CSP blocks it, so a name that can't resolve tests the same.
  {
    from: "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1&offset=0",
    to: "/__baseline/unavailable",
  },
  { from: "https://www.w3schools.com/js/myScript.js", to: "http://csp-probe.invalid/js/myScript.js" },
];

/** Says whether this got at the page's own globals: it doesn't on Camoufox, by its design. */
const REBROWSER_TRIGGERS = `(() => {
  let reached = false;
  try {
    window.dummyFn();
    reached = true;
  } catch {}
  document.getElementById('detections-json');
  document.getElementsByClassName('div');
  return reached;
})()`;

interface RebrowserRow {
  type: string;
  rating: number;
  note?: string;
}

function ratingTable(rows: readonly RebrowserRow[]): Record<string, unknown> {
  const types = (rating: number): string[] => rows.filter((r) => r.rating === rating).map((r) => r.type).sort();
  const plain = (note: string | undefined): string =>
    (note ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    red: types(1),
    yellow: types(0.5),
    neutral: types(0),
    green: types(-1),
    notes: Object.fromEntries(rows.filter((r) => r.rating > 0).map((r) => [r.type, plain(r.note)])),
  };
}

async function takeRebrowser(ctx: BaselineContext): Promise<Record<string, unknown>> {
  const bundle = ctx.assetLock["rebrowser-bot-detector"];
  if (!bundle) throw new Error("assets.lock.json has no rebrowser-bot-detector");
  const dir = await ensureBundle("rebrowser-bot-detector", bundle, ctx.cacheRoot, ctx.fetchFile);
  ctx.site.mount({
    prefix: "/",
    dir,
    rewrite: (file, text) => (file === "index.js" ? rewriteAsset(text, REBROWSER_REWRITES) : text),
  });
  await ctx.driver.navigate(ctx.profileId, ctx.site.url("/"));
  await delay(REBROWSER_SETTLE_MS);
  // querySelector, as it's one the page doesn't watch: this read alone triggers nothing.
  const read = async (): Promise<RebrowserRow[]> =>
    JSON.parse(String(await evaluate(ctx, "document.querySelector('#detections-json').value") || "[]")) as RebrowserRow[];
  const passive = await read();
  if (passive.length === 0) throw new Error("The page reported no tests");
  // What the page's "how to run" asks a client to do, through the only ways this one has.
  await ctx.driver.extract(ctx.profileId);
  const reachedMainWorld = await evaluate(ctx, REBROWSER_TRIGGERS);
  await delay(REBROWSER_AFTER_TRIGGER_MS);
  const afterAgentCalls = await read();
  await tryScreenshot(ctx, "rebrowser.png");
  saveJson(ctx, "rebrowser.json", afterAgentCalls);
  return {
    passive: ratingTable(passive),
    afterAgentCalls: ratingTable(afterAgentCalls),
    evaluateReachesPageGlobals: reachedMainWorld === true,
  };
}

// ── CreepJS ─────────────────────────────────────────────────────────────────

const CREEP_EXPOSES = "window.Fingerprint = JSON.parse(JSON.stringify(fp));";

/**
 * Its STUN servers become ours, the only thing it would have reached off this machine. And its
 * report also goes in the DOM once it's done measuring, for either engine's evaluate to read.
 */
function creepRewrites(stun: string): Array<{ from: string; to: string }> {
  return [
    ...["stun:stun4.l.google.com:19302", "stun:stun3.l.google.com:19302"].map((from) => ({
      from,
      to: `stun:${stun}`,
    })),
    {
      from: CREEP_EXPOSES,
      to: `${CREEP_EXPOSES} (() => { const out = document.createElement("pre"); out.id = "mz-report"; out.hidden = true; out.textContent = JSON.stringify(fp); out.dataset.done = "1"; document.body.appendChild(out); })();`,
    },
  ];
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function pickFields(from: Json | undefined, keys: readonly string[]): Json | null {
  if (!from) return null;
  return Object.fromEntries(keys.filter((key) => key in from).map((key) => [key, from[key]]));
}

/**
 * What a comparison looks at of CreepJS's report: its verdicts, the values behind what
 * detectors read, and every section's hash. Images and long key lists stay in creepjs.json.
 */
export function creepSummary(fp: Json): Record<string, unknown> {
  const hashes: Record<string, unknown> = {};
  for (const [name, section] of Object.entries(fp)) {
    if (section && typeof section === "object" && "$hash" in section) hashes[name] = (section as Json).$hash;
  }
  return {
    headless: pickFields(fp.headless, [
      "chromium",
      "likeHeadlessRating",
      "headlessRating",
      "stealthRating",
      "platformEstimate",
      "systemFonts",
      "likeHeadless",
      "headless",
      "stealth",
    ]),
    lies: {
      total: fp.lies?.totalLies ?? null,
      sources: Object.keys(fp.lies?.data ?? {}).sort(),
      detail: fp.lies?.data ?? null,
    },
    trash: { count: fp.trash?.trashBin?.length ?? null, items: fp.trash?.trashBin ?? null },
    errors: { count: fp.capturedErrors?.data?.length ?? null, items: fp.capturedErrors?.data ?? null },
    worker: pickFields(fp.workerScope, [
      "lied",
      "locale",
      "timezoneLocation",
      "deviceMemory",
      "hardwareConcurrency",
      "language",
      "languages",
      "platform",
      "userAgent",
      "webglRenderer",
      "webglVendor",
      "userAgentData",
      "system",
      "device",
      "gpu",
    ]),
    navigator: pickFields(fp.navigator, [
      "platform",
      "system",
      "device",
      "userAgent",
      "deviceMemory",
      "hardwareConcurrency",
      "language",
      "maxTouchPoints",
      "vendor",
      "mimeTypes",
      "lied",
    ]),
    screen: fp.screen ?? null,
    cssMedia: fp.cssMedia?.mediaCSS ?? null,
    timezone: pickFields(fp.timezone, ["zone", "location", "locationMeasured", "offset", "lied"]),
    intl: pickFields(fp.intl, ["locale", "lied"]),
    voices: fp.voices ?? null,
    fonts: fp.fonts ?? null,
    canvas: pickFields(fp.canvas2d, ["mods", "textMetricsSystemSum", "lied"]),
    webgl: { gpu: fp.canvasWebgl?.gpu ?? null, lied: fp.canvasWebgl?.lied ?? null },
    audio: pickFields(fp.offlineAudioContext, [
      "totalUniqueSamples",
      "compressorGainReduction",
      "floatFrequencyDataSum",
      "floatTimeDomainDataSum",
      "sampleSum",
      "noise",
      "lied",
    ]),
    clientRects: pickFields(fp.clientRects, ["domrectSystemSum", "lied"]),
    svg: pickFields(fp.svg, ["svgrectSystemSum", "lied"]),
    versions: pickFields(fp.features, ["version", "cssVersion", "windowVersion", "jsVersion"]),
    resistance: fp.resistance ?? null,
    hashes,
  };
}

async function takeCreepjs(ctx: BaselineContext): Promise<Record<string, unknown>> {
  const bundle = ctx.assetLock.creepjs;
  if (!bundle) throw new Error("assets.lock.json has no creepjs");
  const dir = await ensureBundle("creepjs", bundle, ctx.cacheRoot, ctx.fetchFile);
  const rewrites = creepRewrites(`${ctx.stunHost}:${ctx.stun.port}`);
  ctx.site.mount({
    prefix: "/creepjs/",
    dir,
    rewrite: (file, text) => (file === "creep.js" ? rewriteAsset(text, rewrites) : text),
  });
  await ctx.driver.navigate(ctx.profileId, ctx.site.url("/creepjs/"));
  const fp = JSON.parse(await reportOf(ctx, "CreepJS", CREEPJS_BUDGET_MS)) as Json;
  await delay(CREEPJS_RENDER_MS);
  const page = await evaluate(
    ctx,
    "(() => { const el = document.querySelector('#fingerprint-data .fingerprint-header'); return el ? el.innerText : null; })()",
  );
  await tryScreenshot(ctx, "creepjs.png");
  saveJson(ctx, "creepjs.json", fp);
  return { fingerprintId: String(page ?? "").split("\n")[0] ?? null, ...creepSummary(fp) };
}

// ── a covered window ────────────────────────────────────────────────────────

const VISIBILITY_SAMPLE = `JSON.stringify({
  ...JSON.parse(document.getElementById('mz-report').textContent),
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
})`;
const COVER_MS = 12_000;
const COVERED_CLICK_BUDGET_MS = 7_000;

/**
 * Whether a page can tell its window is covered, and whether its input still works then: what
 * occlusion handling is for. Only on Windows, only when asked: this puts a window over the
 * whole desktop for a few seconds.
 */
async function takeCovered(ctx: BaselineContext): Promise<Record<string, unknown>> {
  if (!ctx.coverWindow) throw new Error("not asked for");
  await ctx.driver.navigate(ctx.profileId, ctx.site.url("/p/visibility.html"));
  await delay(1_500);
  let framesSoFar = 0;
  const sample = async (): Promise<unknown> => {
    const raw = await evaluate(ctx, VISIBILITY_SAMPLE);
    const { frames, ...rest } = JSON.parse(String(raw)) as { frames: number; visibility: string; hasFocus: boolean };
    const framesSinceLast = frames - framesSoFar;
    framesSoFar = frames;
    return { ...rest, gettingFrames: framesSinceLast > 0, timings: { framesSinceLast } };
  };
  const before = await sample();
  const covering = ctx.coverWindow(COVER_MS);
  await delay(3_000);
  const covered1 = await sample();
  await delay(2_000);
  const covered2 = await sample();
  const started = Date.now();
  let clickWhileCovered: string;
  try {
    await within(ctx.driver.click(ctx.profileId, "#b"), COVERED_CLICK_BUDGET_MS, "click");
    clickWhileCovered = "delivered";
  } catch (e) {
    clickWhileCovered = message(e).split("\n")[0]!.slice(0, 160);
  }
  const clickMs = Date.now() - started;
  await covering;
  await delay(2_000);
  const after = await sample();
  return { before, covered1, covered2, clickWhileCovered, timings: { clickMs }, after };
}

// ── a name, for a NetLog to have something to say ───────────────────────────

/** Reserved by RFC 6761: it resolves nowhere, so asking leaves nothing behind but the question. */
export const NAME_PROBE_HOST = "mz-name-probe.multizen-baseline.invalid";
const NAME_PROBE_SETTLE_MS = 3_000;

/** A page asks for a name a NetLog can then be read for. Failing to reach it is the point. */
export async function askForAName(driver: BaselineDriver, profileId: string, pageUrl: string): Promise<void> {
  await driver.navigate(profileId, pageUrl);
  await driver.evaluateJs(profileId, `fetch("https://${NAME_PROBE_HOST}/").catch(() => {}); 0`);
  await delay(NAME_PROBE_SETTLE_MS);
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Every section with the same reason: the browser never came up, or the like. */
export function allUnavailable(reason: string): Record<string, SectionResult> {
  return Object.fromEntries(ALL_SECTIONS.map((name) => [name, { status: "unavailable", reason }]));
}

/** AC9: losing a detector page is a note, and losing every local probe is a failed run. */
export function runExitCode(sections: Record<string, SectionResult>): number {
  return LOCAL_SECTIONS.some((name) => sections[name]?.status === "ok") ? 0 : 1;
}

/**
 * Takes each section in turn. Whatever one can't do becomes its `unavailable`, with the
 * reason, and the next one starts: a page that broke the last one must not cost the rest.
 */
export async function collectSections(ctx: BaselineContext): Promise<Record<string, SectionResult>> {
  const sections: Record<string, SectionResult> = {};
  const ok = (data: unknown): SectionResult => ({ status: "ok", data });
  const lost = (e: unknown): SectionResult => ({ status: "unavailable", reason: message(e) });
  const take = async (names: readonly string[], work: () => Promise<Record<string, unknown>>): Promise<void> => {
    ctx.log(`section: ${names.join(", ")}`);
    try {
      const results = await work();
      for (const name of names) {
        const value = results[name];
        sections[name] = typeof value === "string" ? lost(value) : ok(value);
      }
    } catch (e) {
      ctx.log(`${names.join(", ")} unavailable: ${message(e)}`);
      for (const name of names) sections[name] = lost(e);
    }
  };

  await take(["probe", "fonts"], async () => ({ ...(await takeProbe(ctx)) }));
  await take(["headers"], async () => ({ headers: takeHeaders(ctx) }));
  await take(["input"], async () => ({ input: await takeInput(ctx) }));
  await take(["webrtc"], async () => ({ webrtc: await takeWebrtc(ctx) }));
  await take(["tls", "h2"], async () => ({ ...(await takeTls(ctx)) }));
  await take(["rebrowser"], async () => ({ rebrowser: await takeRebrowser(ctx) }));
  await take(["creepjs"], async () => ({ creepjs: await takeCreepjs(ctx) }));
  if (ctx.coverWindow) await take(["covered"], async () => ({ covered: await takeCovered(ctx) }));
  return sections;
}
