import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jpegSize } from "@multizen/cdp-driver";
import type { MultizenError, ProfileId } from "@multizen/types";
import { EgressPolicy } from "./egressPolicy.ts";
import {
  camoufoxDisplayOptions,
  EGRESS_FIREFOX_PREFS,
  FirefoxBrowserDriver,
  openStartPage,
  persistentContextOptions,
} from "./FirefoxBrowserDriver.ts";
import { startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge.ts";

const ID: ProfileId = "p";

const namedError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name });

/** Answers as Playwright does; each test sets what the page holds. */
class FakeLocator {
  constructor(
    private readonly page: FakePage,
    readonly selector: string,
  ) {}
  first(): FakeLocator {
    return this;
  }
  private name(): string {
    return this.selector.replace(/^aria-ref=/, "");
  }
  async count(): Promise<number> {
    if (this.page.goneFrames.has(this.name().replace(/e\d+$/, ""))) {
      throw new Error(`locator.count: Invalid frame in aria-ref selector "${this.selector}"`);
    }
    return this.page.elements.has(this.name()) ? 1 : 0;
  }
  async evaluate(expression: string): Promise<unknown> {
    assert.equal(expression, "performance.timeOrigin");
    return this.page.documentId;
  }
  private act(what: string, arg?: unknown): Promise<void> {
    this.page.calls.push(arg === undefined ? `${what} ${this.selector}` : `${what} ${this.selector} ${JSON.stringify(arg)}`);
    const failure = this.page.failures.get(what);
    return failure ? failure() : Promise.resolve();
  }
  click(): Promise<void> {
    return this.act("click");
  }
  focus(): Promise<void> {
    return this.act("focus");
  }
  fill(text: string): Promise<void> {
    return this.act("fill", text);
  }
  hover(): Promise<void> {
    return this.act("hover");
  }
  selectOption(choice: unknown): Promise<void> {
    return this.act("select", choice);
  }
  setInputFiles(paths: unknown): Promise<void> {
    return this.act("files", paths);
  }
  scrollIntoViewIfNeeded(): Promise<void> {
    return this.act("intoView");
  }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return { x: 10, y: 20, width: 100, height: 40 };
  }
  async isVisible(): Promise<boolean> {
    return this.page.visible;
  }
}

class FakeDialog {
  answers: unknown[] = [];
  constructor(
    private readonly kind: string,
    private readonly text: string,
    private readonly owner: FakePage,
    private readonly initial = "",
  ) {}
  type(): string {
    return this.kind;
  }
  message(): string {
    return this.text;
  }
  defaultValue(): string {
    return this.initial;
  }
  page(): FakePage {
    return this.owner;
  }
  async accept(text?: string): Promise<void> {
    this.answers.push(["accept", text]);
  }
  async dismiss(): Promise<void> {
    this.answers.push(["dismiss"]);
  }
}

class FakeDownload {
  constructor(
    private readonly saving: () => Promise<string>,
    private readonly name = "../report.txt",
  ) {}
  url(): string {
    return "http://site/file";
  }
  suggestedFilename(): string {
    return this.name;
  }
  async saveAs(path: string): Promise<void> {
    writeFileSync(path, await this.saving());
  }
  deleted = 0;
  async delete(): Promise<void> {
    this.deleted += 1;
  }
}

/** Just the markers a size reader walks: SOI, an APP0, then a baseline start of frame. */
function jpegOf(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  ]);
}

class FakePage extends EventEmitter {
  closed = false;
  currentUrl = "about:blank";
  snapshot = "";
  documentId = "doc-1";
  visible = true;
  elements = new Set<string>();
  goneFrames = new Set<string>();
  failures = new Map<string, () => Promise<void>>();
  calls: string[] = [];
  gotoImpl: (url: string) => Promise<void> = async (url) => {
    this.currentUrl = url;
  };
  keyboard = {
    press: async (key: string): Promise<void> => {
      this.calls.push(`press ${key}`);
      const failure = this.failures.get("press");
      if (failure) await failure();
    },
    insertText: async (text: string): Promise<void> => void this.calls.push(`insert ${text}`),
    type: async (text: string): Promise<void> => void this.calls.push(`key ${text}`),
    down: async (key: string): Promise<void> => {
      if (key === "Process") throw new Error('Unknown key: "Process"');
      this.calls.push(`keydown ${key}`);
    },
    up: async (key: string): Promise<void> => void this.calls.push(`keyup ${key}`),
  };
  mouse = {
    move: async (x: number, y: number): Promise<void> => void this.calls.push(`move ${x},${y}`),
    wheel: async (x: number, y: number): Promise<void> => void this.calls.push(`wheel ${x},${y}`),
    down: async (o: unknown): Promise<void> => void this.calls.push(`down ${JSON.stringify(o)}`),
    up: async (o: unknown): Promise<void> => void this.calls.push(`up ${JSON.stringify(o)}`),
  };
  viewport: { width: number; height: number } | null = null;
  viewportSize(): { width: number; height: number } | null {
    return this.viewport;
  }
  /** Child frames, as boxes on the page. */
  childFrames: Array<{ x: number; y: number; width: number; height: number; name: string }> = [];
  frames(): unknown[] {
    const main = { parentFrame: () => null };
    return [
      main,
      ...this.childFrames.map((box) => ({
        parentFrame: () => main,
        frameElement: async () => ({
          boundingBox: async () => box,
          focus: async () => void this.calls.push(`focus frame ${box.name}`),
        }),
      })),
    ];
  }
  isClosed(): boolean {
    return this.closed;
  }
  url(): string {
    return this.currentUrl;
  }
  async title(): Promise<string> {
    return "A title";
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector);
  }
  async ariaSnapshot(opts: unknown): Promise<string> {
    assert.equal((opts as { mode: string }).mode, "ai");
    return this.snapshot;
  }
  async evaluate(expression: string): Promise<unknown> {
    this.calls.push(`evaluate ${expression}`);
    if (expression.includes("innerWidth")) return { x: 640, y: 360 };
    return "the text";
  }
  goto(url: string): Promise<void> {
    this.calls.push(`goto ${url}`);
    return this.gotoImpl(url);
  }
  async screenshot(opts: unknown): Promise<Buffer> {
    this.calls.push(`screenshot ${JSON.stringify(opts)}`);
    if ((opts as { type: string }).type === "jpeg") return jpegOf(1280, 720);
    return Buffer.from("png");
  }
  async bringToFront(): Promise<void> {
    this.calls.push("bringToFront");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.emit("close");
  }
  async waitForEvent(event: string): Promise<unknown> {
    assert.equal(event, "filechooser");
    return { setFiles: async (paths: string[]): Promise<void> => void this.calls.push(`chooser ${paths[0]}`) };
  }
}

class FakeContext extends EventEmitter {
  open: FakePage[];
  constructor(...pages: FakePage[]) {
    super();
    this.open = pages;
  }
  pages(): FakePage[] {
    return this.open.filter((p) => !p.closed);
  }
  addPage(page = new FakePage()): FakePage {
    this.open.push(page);
    this.emit("page", page);
    return page;
  }
  async newPage(): Promise<FakePage> {
    return this.addPage();
  }
  async close(): Promise<void> {
    this.emit("close");
  }
}

interface Rig {
  driver: FirefoxBrowserDriver;
  context: FakeContext;
  page: FakePage;
  dir: string;
}

function rig(t: TestContext, platform = "windows"): Rig {
  const dir = mkdtempSync(join(tmpdir(), "mz-ff-"));
  const page = new FakePage();
  const context = new FakeContext(page);
  const driver = new FirefoxBrowserDriver({
    profileManager: {
      get: (id: ProfileId) => (id === ID ? { id, dataDir: dir } : null),
    } as never,
    browserDataDir: () => "unused",
    refBase: 0,
  });
  (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(ID, context, false, platform);
  t.after(async () => {
    await context.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { driver, context, page, dir };
}

const hasCode =
  (code: string) =>
  (e: unknown): boolean => {
    assert.equal((e as MultizenError).code, code, (e as Error).message);
    return true;
  };

/** Extract on the active tab, handing back what the agent reads. */
async function extract(driver: FirefoxBrowserDriver): Promise<string> {
  const { result } = (await driver.extract(ID)) as { result: { ariaSnapshot: string } };
  return result.ariaSnapshot;
}

function withButton(page: FakePage, inner = "e1"): void {
  page.snapshot = `- button "Press" [ref=${inner}]`;
  page.elements = new Set([inner]);
}

test("extract keeps url, title and text, and adds the snapshot under tab-scoped refs", async (t) => {
  const { driver, page } = rig(t);
  page.currentUrl = "http://site/";
  page.snapshot = '- button "Main" [ref=e3]\n- iframe [ref=e4]:\n  - button "In" [ref=f1e2]';
  page.elements = new Set(["e3", "e4", "f1e2"]);
  const { result } = (await driver.extract(ID)) as { result: Record<string, unknown> };
  assert.equal(result.url, "http://site/");
  assert.equal(result.title, "A title");
  assert.equal(result.text, "the text");
  assert.equal(
    result.ariaSnapshot,
    '- button "Main" [ref=p1.e1]\n- iframe [ref=p1.e2]:\n  - button "In" [ref=p1.e3]',
  );
});

test("click_ref reaches Playwright's name for the element; a re-extract keeps the ref", async (t) => {
  const { driver, page } = rig(t);
  withButton(page, "f2e7");
  const first = await extract(driver);
  assert.equal(await extract(driver), first);
  await driver.clickRef(ID, "p1.e1");
  assert.deepEqual(page.calls.filter((c) => c.startsWith("click")), ["click aria-ref=f2e7"]);
});

test("a ref whose element is gone is STALE_REF, and nothing is clicked", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  page.elements.clear();
  await assert.rejects(driver.clickRef(ID, "p1.e1"), hasCode("STALE_REF"));
  await assert.rejects(driver.typeRef(ID, "p1.e1", "x"), hasCode("STALE_REF"));
  assert.ok(!page.calls.some((c) => c.startsWith("click")));
});

test("a ref into a frame that went away is STALE_REF", async (t) => {
  const { driver, page } = rig(t);
  withButton(page, "f2e1");
  await extract(driver);
  page.goneFrames.add("f2");
  await assert.rejects(driver.clickRef(ID, "p1.e1"), hasCode("STALE_REF"));
});

test("Playwright reusing a name in a new document doesn't revive an old ref", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  // Reloaded, not re-extracted: `e1` could already name something else there.
  page.documentId = "doc-2";
  await assert.rejects(driver.clickRef(ID, "p1.e1"), hasCode("STALE_REF"));
  const fresh = await extract(driver);
  assert.match(fresh, /\[ref=p1\.e2\]/);
  await assert.rejects(driver.clickRef(ID, "p1.e1"), hasCode("STALE_REF"));
  await driver.clickRef(ID, "p1.e2");
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, 1);
});

test("refs that were never issued, and tabs that never were", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  await assert.rejects(driver.clickRef(ID, "p1.e99"), hasCode("ELEMENT_NOT_FOUND"));
  await assert.rejects(driver.clickRef(ID, "e1"), hasCode("ELEMENT_NOT_FOUND"));
  await assert.rejects(driver.clickRef(ID, "p7.e1"), hasCode("TAB_NOT_FOUND"));
});

test("a closed tab's ref is STALE_REF", async (t) => {
  const { driver, context, page } = rig(t);
  const second = context.addPage();
  withButton(second);
  await driver.activateTab(ID, "2");
  await extract(driver);
  await driver.closeTab(ID, "2");
  await assert.rejects(driver.clickRef(ID, "p2.e1"), hasCode("STALE_REF"));
  assert.equal(page.closed, false);
});

test("a ref on a background tab activates that tab before acting", async (t) => {
  const { driver, context, page } = rig(t);
  withButton(page);
  await extract(driver);
  const second = await driver.newTab(ID);
  assert.deepEqual(second, { targetId: "2" });
  page.calls.length = 0;
  await driver.clickRef(ID, "p1.e1");
  assert.deepEqual(page.calls, ["bringToFront", "click aria-ref=e1"]);
  const tabs = (await driver.listTabs(ID)) as { activeTargetId: string };
  assert.equal(tabs.activeTargetId, "1");
  assert.equal(context.pages().length, 2);
});

test("page verbs follow the active tab: new_tab and activate_tab move it", async (t) => {
  const { driver, context, page } = rig(t);
  await driver.newTab(ID);
  const second = context.pages()[1]!;
  await driver.navigate(ID, "http://site/two");
  assert.equal(second.currentUrl, "http://site/two");
  assert.equal(page.currentUrl, "about:blank");
  await driver.activateTab(ID, "1");
  await driver.navigate(ID, "http://site/one");
  assert.equal(page.currentUrl, "http://site/one");
  assert.deepEqual(await driver.listTabs(ID), {
    targetInfos: [
      { targetId: "1", type: "page", url: "http://site/one" },
      { targetId: "2", type: "page", url: "http://site/two" },
    ],
    activeTargetId: "1",
  });
  await assert.rejects(driver.activateTab(ID, "9"), hasCode("TAB_NOT_FOUND"));
  await assert.rejects(driver.closeTab(ID, "9"), hasCode("TAB_NOT_FOUND"));
});

test("a popup doesn't take the active tab", async (t) => {
  const { driver, context, page } = rig(t);
  context.addPage();
  assert.equal(((await driver.listTabs(ID)) as { activeTargetId: string }).activeTargetId, "1");
  await driver.navigate(ID, "http://site/");
  assert.equal(page.currentUrl, "http://site/");
});

test("closing the active tab falls back to the most recently used, and raises it", async (t) => {
  const { driver, context, page } = rig(t);
  const popup = context.addPage();
  await driver.newTab(ID);
  const third = context.pages()[2]!;
  page.calls.length = 0;
  await driver.closeTab(ID, "3");
  assert.equal(third.closed, true);
  assert.equal(((await driver.listTabs(ID)) as { activeTargetId: string }).activeTargetId, "1");
  assert.deepEqual(page.calls, ["bringToFront"], "the popup ranks below a page in use");
  assert.deepEqual(popup.calls, []);
});

test("a tab closed from outside: the next verb acts on the fallback and raises it", async (t) => {
  const { driver, context, page } = rig(t);
  await driver.newTab(ID);
  page.calls.length = 0;
  await context.pages()[1]!.close();
  assert.deepEqual(page.calls, []);
  await driver.navigate(ID, "http://site/");
  assert.deepEqual(page.calls, ["bringToFront", "goto http://site/"]);
});

test("with every tab closed, verbs report TAB_NOT_FOUND", async (t) => {
  const { driver, page } = rig(t);
  await page.close();
  await assert.rejects(driver.screenshot(ID), hasCode("TAB_NOT_FOUND"));
});

test("new_tab with a url waits for the commit at most, and a failed load stays quiet", async (t) => {
  const { driver, context } = rig(t);
  const page = new FakePage();
  page.gotoImpl = () => Promise.reject(new Error("page.goto: NS_ERROR_CONNECTION_REFUSED"));
  context.newPage = async () => context.addPage(page);
  assert.deepEqual(await driver.newTab(ID, "http://127.0.0.1:1/"), { targetId: "2" });
  assert.deepEqual(page.calls, ["bringToFront", "goto http://127.0.0.1:1/"]);
});

test("auto policy: the same default answers as the CDP path", async (t) => {
  const { page } = rig(t);
  const answered = async (kind: string): Promise<unknown> => {
    const dialog = new FakeDialog(kind, "m", page);
    page.emit("dialog", dialog);
    await new Promise((resolve) => setImmediate(resolve));
    return dialog.answers[0];
  };
  assert.deepEqual(await answered("alert"), ["accept", undefined]);
  assert.deepEqual(await answered("beforeunload"), ["accept", undefined]);
  assert.deepEqual(await answered("confirm"), ["dismiss"]);
  assert.deepEqual(await answered("prompt"), ["dismiss"]);
});

test("auto policy with overrides, and a prompt's answer", async (t) => {
  const { driver, page } = rig(t);
  await driver.setDialogPolicy(ID, { mode: "auto", prompt: "accept", alert: "dismiss", promptText: "Ann" });
  const prompt = new FakeDialog("prompt", "Name?", page);
  const alert = new FakeDialog("alert", "hi", page);
  page.emit("dialog", prompt);
  page.emit("dialog", alert);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompt.answers, [["accept", "Ann"]]);
  assert.deepEqual(alert.answers, [["dismiss"]]);
});

test("manual: a dialog stays open, and every page operation reports DIALOG_OPEN", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  page.currentUrl = "http://site/";
  page.emit("dialog", new FakeDialog("prompt", "Name?", page, "nobody"));
  const listed = await driver.listDialogs(ID);
  assert.equal(listed.length, 1);
  const { openedAt: _openedAt, ...dialog } = listed[0]!;
  assert.deepEqual(dialog, {
    id: "d1",
    type: "prompt",
    message: "Name?",
    defaultPrompt: "nobody",
    url: "http://site/",
  });
  assert.equal(driver.hasOpenDialog(ID), true);
  page.calls.length = 0;
  for (const call of [
    () => driver.screenshot(ID),
    () => driver.extract(ID),
    () => driver.navigate(ID, "http://site/x"),
    () => driver.evaluateJs(ID, "1"),
    () => driver.click(ID, "button"),
    () => driver.type(ID, "input", "x"),
    () => driver.clickRef(ID, "p1.e1"),
    () => driver.typeRef(ID, "p1.e1", "x"),
    () => driver.performAction(ID, { type: "press_key", key: "Enter" }),
    () => driver.performAction(ID, { type: "hover", target: { ref: "p1.e1" } }),
    () => driver.performAction(ID, { type: "scroll", deltaY: 5 }),
    () => driver.performAction(ID, { type: "select_option", target: { selector: "s" }, index: 0 }),
    () => driver.performAction(ID, { type: "upload_file", target: { selector: "i" }, paths: ["a"] }),
  ]) {
    await assert.rejects(call(), hasCode("DIALOG_OPEN"));
  }
  assert.deepEqual(page.calls, [], "none of them touched the page");
});

test("manual: a click that opens a dialog returns, with the click still pending", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  page.failures.set("click", () => {
    page.emit("dialog", new FakeDialog("confirm", "Sure?", page));
    return new Promise(() => {});
  });
  await driver.clickRef(ID, "p1.e1");
  assert.equal((await driver.listDialogs(ID))[0]?.message, "Sure?");
});

test("manual: an operation already waiting when the dialog opens stops with DIALOG_OPEN", async (t) => {
  const { driver, page } = rig(t);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  page.gotoImpl = () => {
    page.emit("dialog", new FakeDialog("alert", "loading", page));
    return new Promise(() => {});
  };
  await assert.rejects(driver.navigate(ID, "http://site/"), hasCode("DIALOG_OPEN"));
});

test("handle_dialog answers the oldest or the named one", async (t) => {
  const { driver, page } = rig(t);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  const first = new FakeDialog("confirm", "one", page);
  const second = new FakeDialog("prompt", "two", page);
  const third = new FakeDialog("confirm", "three", page);
  page.emit("dialog", first);
  page.emit("dialog", second);
  page.emit("dialog", third);
  await driver.handleDialog(ID, { dialogId: "d2", action: "accept", promptText: "Ann" });
  assert.deepEqual(second.answers, [["accept", "Ann"]]);
  await driver.handleDialog(ID, { action: "dismiss" });
  assert.deepEqual(first.answers, [["dismiss"]]);
  assert.deepEqual((await driver.listDialogs(ID)).map((d) => d.id), ["d3"]);
  await assert.rejects(
    driver.handleDialog(ID, { dialogId: "d9", action: "accept" }),
    hasCode("INVALID_INPUT"),
  );
});

test("back to auto: dialogs left open are answered by the new policy", async (t) => {
  const { driver, page } = rig(t);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  const open = new FakeDialog("confirm", "left", page);
  page.emit("dialog", open);
  await driver.setDialogPolicy(ID, { mode: "auto" });
  assert.deepEqual(open.answers, [["dismiss"]]);
  assert.equal(driver.hasOpenDialog(ID), false);
  await driver.screenshot(ID);
});

test("a dialog blocks its own tab only, and closes with it", async (t) => {
  const { driver, context, page } = rig(t);
  await driver.setDialogPolicy(ID, { mode: "manual" });
  page.emit("dialog", new FakeDialog("alert", "here", page));
  const second = context.addPage();
  await driver.activateTab(ID, "2");
  await driver.screenshot(ID);
  assert.ok(second.calls.some((c) => c.startsWith("screenshot")));
  await driver.activateTab(ID, "1");
  await assert.rejects(driver.screenshot(ID), hasCode("DIALOG_OPEN"));
  await driver.closeTab(ID, "1");
  assert.equal(driver.hasOpenDialog(ID), false);
});

test("navigate: a failed load is NAVIGATION_FAILED, in its own words", async (t) => {
  const { driver, page } = rig(t);
  page.gotoImpl = () =>
    Promise.reject(new Error("page.goto: NS_ERROR_CONNECTION_REFUSED\nCall log:\n  - navigating"));
  const failed = await driver.navigate(ID, "http://127.0.0.1:1/").catch((e: MultizenError) => e);
  assert.equal((failed as MultizenError).code, "NAVIGATION_FAILED");
  assert.equal(
    (failed as MultizenError).message,
    "Navigation to http://127.0.0.1:1/ failed: NS_ERROR_CONNECTION_REFUSED",
  );
  assert.deepEqual((failed as MultizenError).details, { error_text: "NS_ERROR_CONNECTION_REFUSED" });
});

test("the egress prefs are the nine of the plan, and win over a caller's", () => {
  assert.deepEqual(EGRESS_FIREFOX_PREFS, {
    "network.proxy.allow_hijacking_localhost": true,
    "network.proxy.no_proxies_on": "",
    "network.proxy.socks_remote_dns": true,
    "network.trr.mode": 5,
    "network.dns.disablePrefetch": true,
    "network.prefetch-next": false,
    "network.http.speculative-parallel-limit": 0,
    "network.http.http3.enable": false,
    "network.webtransport.enabled": false,
  });
  const options = persistentContextOptions(
    { firefoxUserPrefs: { "network.trr.mode": 2, kept: true } },
    { downloadsPath: "d", proxy: { server: "socks5://127.0.0.1:1" }, extraPrefs: EGRESS_FIREFOX_PREFS },
  );
  assert.equal(options.firefoxUserPrefs?.["network.trr.mode"], 5);
  assert.equal(options.firefoxUserPrefs?.kept, true);
  assert.deepEqual(options.proxy, { server: "socks5://127.0.0.1:1" });
});

test("navigate: a load the bridge refused is EGRESS_BLOCKED, whatever Firefox calls it", async (t) => {
  const { driver, page } = rig(t);
  const url = await startBridgeForProfile(ID, null, new EgressPolicy({ mode: "block-private" }));
  t.after(() => stopBridgeForProfile(ID));
  t.mock.method(console, "warn", () => {});

  page.gotoImpl = () => Promise.reject(new Error("page.goto: NS_ERROR_CONNECTION_REFUSED"));
  const before = (await driver.navigate(ID, "http://x/").catch((e) => e)) as MultizenError;
  assert.equal(before.code, "NAVIGATION_FAILED", "no block recorded yet");

  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  await new Promise<void>((resolve) => {
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.once("data", () => {
      socket.write(Buffer.from([5, 1, 0, 1, 169, 254, 169, 254, 0, 80]));
      socket.once("data", () => resolve());
    });
  });
  socket.destroy();

  const typed = (await driver.navigate(ID, "http://x/").catch((e) => e)) as MultizenError;
  assert.equal(typed.code, "EGRESS_BLOCKED");
  assert.match(typed.message, /169\.254\.169\.254:80/);

  page.gotoImpl = () => Promise.reject(new Error("page.goto: NS_ERROR_NET_TIMEOUT"));
  const other = (await driver.navigate(ID, "http://x/").catch((e) => e)) as MultizenError;
  assert.equal(other.code, "NAVIGATION_FAILED", "not the proxy's refusal");
});

test("navigate: a failed load comes back only once its error page has committed", async (t) => {
  const { driver, page } = rig(t);
  const order: string[] = [];
  page.gotoImpl = async () => {
    // A child frame's commit says nothing about the page's.
    setTimeout(() => page.emit("framenavigated", { parentFrame: () => ({}) }), 5);
    setTimeout(() => {
      order.push("error page committed");
      page.emit("framenavigated", { parentFrame: () => null });
    }, 40);
    throw new Error("page.goto: NS_ERROR_CONNECTION_REFUSED");
  };
  await driver.navigate(ID, "http://x/").catch(() => order.push("navigate failed"));
  assert.deepEqual(order, ["error page committed", "navigate failed"]);
  assert.equal(page.listenerCount("framenavigated"), 0);
});

test("navigate: the wait for an error page that never commits is bounded", async (t) => {
  const { driver, page } = rig(t);
  page.gotoImpl = () => Promise.reject(new Error("page.goto: NS_ERROR_CONNECTION_REFUSED"));
  const startedAt = Date.now();
  await assert.rejects(driver.navigate(ID, "http://x/"), hasCode("NAVIGATION_FAILED"));
  const waited = Date.now() - startedAt;
  assert.ok(waited >= 900 && waited < 3_000, `${waited} ms`);
});

test("navigate: a timeout or a download has no error page to wait for", async (t) => {
  const { driver, page } = rig(t);
  const startedAt = Date.now();
  page.gotoImpl = () => Promise.reject(namedError("TimeoutError", "page.goto: Timeout 30000ms exceeded."));
  await assert.rejects(driver.navigate(ID, "http://x/"), hasCode("TIMEOUT"));
  page.gotoImpl = () => Promise.reject(new Error("page.goto: Download is starting"));
  await assert.rejects(driver.navigate(ID, "http://x/"), hasCode("NAVIGATION_FAILED"));
  assert.ok(Date.now() - startedAt < 500, `${Date.now() - startedAt} ms`);
});

test("navigate to a URL serving a file says where the file went", async (t) => {
  const { driver, page } = rig(t);
  page.gotoImpl = () => Promise.reject(new Error("page.goto: Download is starting"));
  const failed = (await driver.navigate(ID, "http://site/file").catch((e) => e)) as MultizenError;
  assert.equal(failed.code, "NAVIGATION_FAILED");
  assert.match(failed.hint ?? "", /list_downloads/);
});

test("navigate that times out is a retryable TIMEOUT", async (t) => {
  const { driver, page } = rig(t);
  page.gotoImpl = () => Promise.reject(namedError("TimeoutError", "page.goto: Timeout 30000ms exceeded."));
  const failed = (await driver.navigate(ID, "http://site/").catch((e) => e)) as MultizenError;
  assert.equal(failed.code, "TIMEOUT");
  assert.equal(failed.retryable, true);
});

test("press_key goes to Playwright by physical key, with the persona's ControlOrMeta", async (t) => {
  const { driver, page } = rig(t);
  await driver.performAction(ID, { type: "press_key", key: "Control+A" });
  await driver.performAction(ID, { type: "press_key", key: "ControlOrMeta+B" });
  assert.deepEqual(page.calls, ["press Control+KeyA", "press Control+KeyB"]);
  await assert.rejects(
    driver.performAction(ID, { type: "press_key", key: "Nope+A" }),
    hasCode("INVALID_INPUT"),
  );
  assert.equal(page.calls.length, 2, "a bad chord presses nothing");
});

test("press_key: ControlOrMeta is Command on a macOS persona; a target is clicked first", async (t) => {
  const { driver, page } = rig(t, "macos");
  withButton(page);
  await extract(driver);
  page.calls.length = 0;
  await driver.performAction(ID, {
    type: "press_key",
    key: "ControlOrMeta+A",
    target: { ref: "p1.e1" },
  });
  assert.deepEqual(page.calls, ["click aria-ref=e1", "focus aria-ref=e1", "press Meta+KeyA"]);
});

test("press_key: a glyph with no physical key is inserted", async (t) => {
  const { driver, page } = rig(t);
  await driver.performAction(ID, { type: "press_key", key: "é" });
  assert.deepEqual(page.calls, ["insert é"]);
});

test("type_ref clicks, then sends real keys one by one", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  page.calls.length = 0;
  await driver.typeRef(ID, "p1.e1", "Hi");
  assert.deepEqual(page.calls, ["click aria-ref=e1", "focus aria-ref=e1", "key H", "key i"]);
});

test("type by selector stays fill", async (t) => {
  const { driver, page } = rig(t);
  await driver.type(ID, "#a", "text");
  assert.deepEqual(page.calls, ['fill #a "text"']);
});

test("select_option: choice passed through; a missing option and a non-select are typed", async (t) => {
  const { driver, page } = rig(t);
  await driver.performAction(ID, { type: "select_option", target: { selector: "s" }, label: "Two" });
  assert.deepEqual(page.calls, ['select s {"label":"Two"}']);
  page.failures.set("select", () =>
    Promise.reject(
      namedError("TimeoutError", "locator.selectOption: Timeout.\nCall log:\n  - did not find some options"),
    ),
  );
  await assert.rejects(
    driver.performAction(ID, { type: "select_option", target: { selector: "s" }, value: "z" }),
    hasCode("ELEMENT_NOT_FOUND"),
  );
  page.failures.set("select", () =>
    Promise.reject(new Error("locator.selectOption: Error: Element is not a <select> element")),
  );
  await assert.rejects(
    driver.performAction(ID, { type: "select_option", target: { selector: "b" }, index: 0 }),
    hasCode("INVALID_INPUT"),
  );
});

test("scroll: over the element, in the middle of the viewport, or into view", async (t) => {
  const { driver, page } = rig(t);
  await driver.performAction(ID, { type: "scroll", target: { selector: "#a" }, deltaY: 90 });
  assert.deepEqual(page.calls, ["intoView #a", "move 60,40", "wheel 0,90"]);
  page.calls.length = 0;
  await driver.performAction(ID, { type: "scroll", deltaX: 5 });
  assert.deepEqual(page.calls.slice(1), ["move 640,360", "wheel 5,0"]);
  page.calls.length = 0;
  await driver.performAction(ID, { type: "scroll", target: { selector: "#a" } });
  assert.deepEqual(page.calls, ["intoView #a"]);
});

test("upload_file: a file input takes the files; another element opens a chooser", async (t) => {
  const { driver, page } = rig(t);
  await driver.performAction(ID, { type: "upload_file", target: { selector: "input" }, paths: ["a"] });
  assert.deepEqual(page.calls, ['files input ["a"]']);
  page.calls.length = 0;
  page.failures.set("files", () =>
    Promise.reject(new Error("locator.setInputFiles: Error: Node is not an HTMLInputElement")),
  );
  await driver.performAction(ID, { type: "upload_file", target: { selector: "button" }, paths: ["a"] });
  assert.deepEqual(page.calls, ['files button ["a"]', "click button", "chooser a"]);
  page.failures.set("files", () =>
    Promise.reject(new Error("locator.setInputFiles: Error: Non-multiple file input can only accept single file")),
  );
  await assert.rejects(
    driver.performAction(ID, { type: "upload_file", target: { selector: "input" }, paths: ["a", "b"] }),
    hasCode("INVALID_INPUT"),
  );
});

test("an action that times out says why, by the element's state", async (t) => {
  const { driver, page } = rig(t);
  const timedOut = (): Promise<void> =>
    Promise.reject(
      namedError("TimeoutError", "locator.click: Timeout.\nCall log:\n  - <div> intercepts pointer events"),
    );
  page.failures.set("click", timedOut);
  await assert.rejects(driver.click(ID, "#missing"), hasCode("ELEMENT_NOT_FOUND"));

  page.elements.add("#hidden");
  page.visible = false;
  await assert.rejects(driver.click(ID, "#hidden"), hasCode("ELEMENT_NOT_VISIBLE"));

  page.visible = true;
  const covered = (await driver.click(ID, "#hidden").catch((e) => e)) as MultizenError;
  assert.equal(covered.code, "TIMEOUT");
  assert.match(covered.message, /intercepts pointer events/);
});

test("a bad selector is INVALID_INPUT, a tab closing mid-call TAB_NOT_FOUND", async (t) => {
  const { driver, page } = rig(t);
  page.failures.set("click", () =>
    Promise.reject(new Error('locator.click: Unexpected token "$" while parsing css selector "$$$".')),
  );
  await assert.rejects(driver.click(ID, "$$$"), hasCode("INVALID_INPUT"));
  page.failures.set("click", () =>
    Promise.reject(namedError("TargetClosedError", "locator.click: Target page has been closed")),
  );
  await assert.rejects(driver.click(ID, "#a"), hasCode("TAB_NOT_FOUND"));
});

test("screenshot leaves the caret alone: the default injects a style into the DOM", async (t) => {
  const { driver, page } = rig(t);
  const { pngBase64 } = await driver.screenshot(ID);
  assert.equal(Buffer.from(pngBase64, "base64").toString(), "png");
  assert.deepEqual(page.calls, ['screenshot {"type":"png","caret":"initial"}']);
});

test("cdp_send refuses by code; nothing else does", async (t) => {
  const { driver } = rig(t);
  await assert.rejects(driver.cdpSend(), hasCode("UNSUPPORTED_ON_ENGINE"));
  assert.deepEqual(await driver.listDownloads(ID), []);
  assert.deepEqual(await driver.listDialogs(ID), []);
  assert.deepEqual(await driver.setDialogPolicy(ID, { mode: "auto" }), { ok: true });
});

test("verbs of a stopped profile report PROFILE_NOT_RUNNING", async (t) => {
  const { driver, context } = rig(t);
  await context.close();
  await assert.rejects(driver.extract(ID), hasCode("PROFILE_NOT_RUNNING"));
  await assert.rejects(driver.listDialogs(ID), hasCode("PROFILE_NOT_RUNNING"));
  await assert.rejects(
    driver.performAction(ID, { type: "hover", target: { ref: "p1.e1" } }),
    hasCode("PROFILE_NOT_RUNNING"),
  );
  assert.equal(driver.hasOpenDialog(ID), false);
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a download lands in the profile's downloads dir, by its sanitized name", async (t) => {
  const { driver, page, dir } = rig(t);
  page.emit("download", new FakeDownload(async () => "the-bytes"));
  await waitUntil(async () => (await driver.listDownloads(ID))[0]?.state === "completed");
  const [record] = await driver.listDownloads(ID);
  assert.equal(record?.fileName, "report.txt");
  assert.equal(record?.url, "http://site/file");
  assert.equal(record?.bytesReceived, 9);
  assert.equal(record?.bytesTotal, 9);
  const file = await driver.getDownload(ID, record!.id);
  assert.equal(file?.path, join(dir, "downloads", "report.txt"));
  assert.equal(readFileSync(file!.path!, "utf8"), "the-bytes");
});

test("a download on a tab opened later is caught too; one that fails reads as canceled", async (t) => {
  const { driver, context } = rig(t);
  const popup = context.addPage();
  popup.emit("download", new FakeDownload(() => Promise.reject(new Error("Download failed"))));
  await waitUntil(async () => (await driver.listDownloads(ID))[0]?.state === "canceled");
  const [record] = await driver.listDownloads(ID);
  assert.equal((await driver.getDownload(ID, record!.id))?.path, null);
});

test("close waits for a finished download's copy; a stopped profile still reaches it", async (t) => {
  const { driver, page } = rig(t);
  let release = (_bytes: string): void => {};
  const finished = new Promise<string>((resolve) => (release = resolve));
  page.emit("download", new FakeDownload(() => finished));
  await waitUntil(async () => (await driver.listDownloads(ID)).length === 1);
  const closing = driver.close(ID);
  release("late-bytes");
  await closing;
  assert.equal(driver.isRunning(ID), false);
  const [record] = await driver.listDownloads(ID);
  assert.equal(record?.state, "completed");
  const file = await driver.getDownload(ID, record!.id);
  assert.equal(readFileSync(file!.path!, "utf8"), "late-bytes");
  assert.equal(await driver.getDownload(ID, "nope"), null);
  assert.ok(existsSync(file!.path!));
});

test("launch options: camoufox's prefs stay under ours, and the caller's extras come last", () => {
  const options = persistentContextOptions(
    {
      headless: false,
      firefoxUserPrefs: { "from.camoufox": 1, "both": "camoufox" },
      proxy: { server: "from-camoufox" },
    },
    {
      downloadsPath: "dir",
      proxy: { server: "socks5://bridge" },
      extraPrefs: { both: "ours", "from.us": true },
      launchExtras: { handleSIGINT: false },
    },
  );
  assert.deepEqual(options, {
    headless: false,
    firefoxUserPrefs: { "from.camoufox": 1, both: "ours", "from.us": true },
    proxy: { server: "socks5://bridge" },
    downloadsPath: "dir",
    handleSIGINT: false,
  });
  assert.deepEqual(persistentContextOptions({ proxy: { server: "kept" } }, { downloadsPath: "d" }).proxy, {
    server: "kept",
  });
});

test("an action found ready that never happens points at a covered window", async (t) => {
  const { driver, page } = rig(t);
  page.elements.add("#a");
  page.failures.set("click", () =>
    Promise.reject(
      namedError(
        "TimeoutError",
        "locator.click: Timeout.\nCall log:\n  - attempting click action\n\u001b[2m    - performing click action\u001b[22m\n",
      ),
    ),
  );
  const failed = (await driver.click(ID, "#a").catch((e) => e)) as MultizenError;
  assert.equal(failed.code, "TIMEOUT");
  assert.match(failed.message, /did not take the action: performing click action$/);
  assert.match(failed.hint ?? "", /covered/);
});

// ── concurrency ──────────────────────────────────────────────────────────────

function launchRig(t: TestContext, launches: { count: number; release: () => void }): FirefoxBrowserDriver {
  const dir = mkdtempSync(join(tmpdir(), "mz-ff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const driver = new FirefoxBrowserDriver({
    profileManager: {
      get: (id: ProfileId) => (id === ID ? { id, dataDir: dir } : null),
    } as never,
    browserDataDir: () => "unused",
    refBase: 0,
  });
  (driver as unknown as { doLaunch: unknown }).doLaunch = async (id: ProfileId) => {
    launches.count += 1;
    await new Promise<void>((resolve) => {
      launches.release = resolve;
    });
    const context = new FakeContext(new FakePage());
    t.after(() => context.close());
    (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(id, context, false, "windows");
    return { id, cdpEndpoint: "", pid: 0, startedAt: "now" };
  };
  return driver;
}

const turn = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("two parallel launches run doLaunch once; launching a running profile answers as it is", async (t) => {
  const launches = { count: 0, release: () => {} };
  const driver = launchRig(t, launches);
  const both = [driver.launch(ID), driver.launch(ID)];
  await turn();
  assert.equal(launches.count, 1);
  launches.release();
  await Promise.all(both);
  assert.equal(driver.isRunning(ID), true);
  await driver.launch(ID);
  assert.equal(launches.count, 1);
});

test("close during a launch waits for it and closes what came up", async (t) => {
  const launches = { count: 0, release: () => {} };
  const driver = launchRig(t, launches);
  const launching = driver.launch(ID);
  await turn();
  let closed = false;
  const closing = driver.close(ID).then(() => {
    closed = true;
  });
  await turn();
  assert.equal(closed, false);
  launches.release();
  await launching;
  await closing;
  assert.equal(driver.isRunning(ID), false);
});

test("closeAll covers a launch under way", async (t) => {
  const launches = { count: 0, release: () => {} };
  const driver = launchRig(t, launches);
  const launching = driver.launch(ID);
  await turn();
  const closingAll = driver.closeAll();
  await turn();
  launches.release();
  await launching;
  await closingAll;
  assert.equal(driver.isRunning(ID), false);
});

/** A rig whose verbs give up quickly. */
function hurriedRig(t: TestContext, opts: { operationDeadlineMs?: number; closeDeadlineMs?: number }): Rig {
  const dir = mkdtempSync(join(tmpdir(), "mz-ff-"));
  const page = new FakePage();
  const context = new FakeContext(page);
  const driver = new FirefoxBrowserDriver({
    profileManager: { get: (id: ProfileId) => (id === ID ? { id, dataDir: dir } : null) } as never,
    browserDataDir: () => "unused",
    refBase: 0,
    ...opts,
  });
  (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(ID, context, false, "windows");
  t.after(async () => {
    await context.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { driver, context, page, dir };
}

const hangs = (): Promise<never> => new Promise(() => {});

test("a verb on a stuck page ends at its deadline", async (t) => {
  const { driver, page } = hurriedRig(t, { operationDeadlineMs: 30 });
  page.evaluate = hangs;
  const startedAt = Date.now();
  await assert.rejects(driver.evaluateJs(ID, "1"), (e: MultizenError) => {
    assert.equal(e.code, "TIMEOUT");
    assert.equal(e.retryable, true);
    assert.match(e.message, /evaluateJs did not finish within 30 ms/);
    return true;
  });
  assert.ok(Date.now() - startedAt < 5_000);
});

test("every verb is bounded, the unbounded Playwright calls included", async (t) => {
  const { driver, page, context } = hurriedRig(t, { operationDeadlineMs: 20 });
  withButton(page);
  await extract(driver);
  page.bringToFront = hangs;
  page.title = hangs;
  page.evaluate = hangs;
  page.screenshot = hangs;
  page.goto = hangs;
  page.keyboard.press = hangs;
  page.close = hangs;
  context.newPage = hangs;
  (context as unknown as { cookies: unknown }).cookies = hangs;
  (context as unknown as { addCookies: unknown }).addCookies = hangs;
  const isTimeout = hasCode("TIMEOUT");
  await assert.rejects(driver.navigate(ID, "http://x/"), isTimeout);
  await assert.rejects(driver.extract(ID), isTimeout);
  await assert.rejects(driver.screenshot(ID), isTimeout);
  await assert.rejects(driver.evaluateJs(ID, "1"), isTimeout);
  await assert.rejects(driver.getCookies(ID), isTimeout);
  await assert.rejects(driver.setCookies(ID, []), isTimeout);
  await assert.rejects(driver.newTab(ID), isTimeout);
  await assert.rejects(driver.activateTab(ID, "1"), isTimeout);
  await assert.rejects(driver.closeTab(ID, "1"), isTimeout);
  await assert.rejects(driver.performAction(ID, { type: "press_key", key: "Enter" }), isTimeout);
});

test("a verb given up on sends no more input, though Playwright's call can't be taken back", async (t) => {
  const { driver, page } = hurriedRig(t, { operationDeadlineMs: 60 });
  withButton(page);
  await extract(driver);
  let release = (): void => {};
  page.failures.set(
    "click",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(driver.typeRef(ID, "p1.e1", "secret"), hasCode("TIMEOUT"));
  page.failures.delete("click");
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(page.calls.filter((c) => c.startsWith("key ")).length, 0);
});

test("a verb that types gets more time per key", async (t) => {
  const { driver, page } = hurriedRig(t, { operationDeadlineMs: 150 });
  withButton(page);
  await extract(driver);
  (driver as unknown as { operationDeadlineMs: number }).operationDeadlineMs = 1;
  page.keyboard.type = hangs;
  const startedAt = Date.now();
  await assert.rejects(driver.typeRef(ID, "p1.e1", "12345"), hasCode("TIMEOUT"));
  assert.ok(Date.now() - startedAt >= 450, `gave up after ${Date.now() - startedAt} ms`);
});

test("close ends a call stuck on the browser right away", async (t) => {
  const { driver, page } = rig(t);
  page.evaluate = hangs;
  const stuck = driver.evaluateJs(ID, "1");
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = Date.now();
  await driver.close(ID);
  await assert.rejects(stuck, hasCode("PROFILE_NOT_RUNNING"));
  assert.ok(Date.now() - startedAt < 5_000);
});

test("a browser that goes by itself ends the calls on it too", async (t) => {
  const { driver, page, context } = rig(t);
  page.evaluate = hangs;
  const stuck = driver.evaluateJs(ID, "1");
  await new Promise((resolve) => setImmediate(resolve));
  context.emit("close");
  await assert.rejects(stuck, hasCode("PROFILE_NOT_RUNNING"));
});

function journalRig(t: TestContext, findPids: (dir: string) => Promise<number[]>) {
  const dir = mkdtempSync(join(tmpdir(), "mz-ff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const page = new FakePage();
  const context = new FakeContext(page);
  const journal: Array<[string, unknown]> = [];
  const driver = new FirefoxBrowserDriver({
    profileManager: { get: (id: ProfileId) => (id === ID ? { id, dataDir: dir } : null) } as never,
    browserDataDir: () => "the-data-dir",
    refBase: 0,
    closeDeadlineMs: 20,
    findPids,
    processJournal: {
      add: (entry) => journal.push(["add", entry]),
      remove: (pid) => journal.push(["remove", pid]),
    },
  });
  const record = (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(ID, context, false, "windows");
  const learn = (): Promise<void> =>
    (driver as unknown as { learnPid: (...a: unknown[]) => Promise<void> }).learnPid(ID, record, "the-data-dir");
  t.after(() => context.close());
  return { driver, context, journal, learn };
}

test("the PID comes from the data dir, into the launch's answer and the journal", async (t) => {
  const asked: string[] = [];
  const { driver, journal, learn } = journalRig(t, async (dir) => {
    asked.push(dir);
    return [4242];
  });
  await learn();
  assert.deepEqual(asked, ["the-data-dir"]);
  assert.equal((await driver.launch(ID)).pid, 4242);
  assert.equal(journal.length, 1);
  const [verb, entry] = journal[0] as [string, Record<string, unknown>];
  assert.equal(verb, "add");
  assert.equal(entry.kind, "browser");
  assert.equal(entry.engine, "camoufox");
  assert.equal(entry.profileId, ID);
  assert.equal(entry.pid, 4242);
  assert.equal(entry.userDataDir, "the-data-dir");
});

test("no PID to be found, or no way to ask: the launch goes on with none, as it always did", async (t) => {
  for (const findPids of [async () => [], () => Promise.reject(new Error("no powershell"))]) {
    const { driver, journal, learn } = journalRig(t, findPids);
    await learn();
    assert.equal((await driver.launch(ID)).pid, 0);
    assert.deepEqual(journal, []);
  }
});

test("a browser gone during the search leaves no entry behind", async (t) => {
  let answer = (_pids: number[]): void => {};
  const { context, journal, learn } = journalRig(
    t,
    () => new Promise((resolve) => (answer = resolve)),
  );
  const learning = learn();
  await new Promise((resolve) => setImmediate(resolve));
  context.emit("close");
  answer([4242]);
  await learning;
  assert.deepEqual(journal.filter(([verb]) => verb === "add"), []);
});

test("the journal entry goes when the browser does", async (t) => {
  const { driver, journal, learn } = journalRig(t, async () => [4242]);
  await learn();
  await driver.close(ID);
  assert.deepEqual(journal.at(-1), ["remove", 4242]);
});

test("a browser that won't close: its slot goes free, its entry stays until it really exits", async (t) => {
  const { driver, context, journal, learn } = journalRig(t, async () => [4242]);
  await learn();
  const realClose = context.close.bind(context);
  context.close = hangs;
  await driver.close(ID);
  assert.equal(driver.isRunning(ID), false, "the slot is free");
  assert.deepEqual(journal.map(([verb]) => verb), ["add"], "the process is still there");
  context.close = realClose;
  context.emit("close");
  assert.deepEqual(journal.at(-1), ["remove", 4242]);
});

test("a browser that won't close is given up on, once, as closed", async (t) => {
  const { driver, context } = hurriedRig(t, { closeDeadlineMs: 20 });
  const realClose = context.close.bind(context);
  context.close = hangs;
  const changes: Array<{ kind: string; reason?: string }> = [];
  driver.on("running-changed", (c) => changes.push(c));
  await driver.close(ID);
  assert.equal(driver.isRunning(ID), false);
  assert.deepEqual(changes, [{ kind: "closed", profileId: ID, reason: "user-close" }]);
  // And if Firefox does answer later, nothing is reported twice.
  context.close = realClose;
  context.emit("close");
  assert.equal(changes.length, 1);
});

// ── refs across browser runs, and extract's size ─────────────────────────────

test("refs are numbered from a base of their own per browser run", async (t) => {
  const runs: string[] = [];
  for (const dirName of ["a", "b"]) {
    const page = new FakePage();
    const context = new FakeContext(page);
    const driver = new FirefoxBrowserDriver({
      profileManager: { get: () => ({ id: ID, dataDir: dirName }) } as never,
      browserDataDir: () => "unused",
    });
    (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(ID, context, false, "windows");
    t.after(() => context.close());
    withButton(page);
    const snapshot = await extract(driver);
    const n = Number(/\[ref=p1\.e(\d+)\]/.exec(snapshot)?.[1]);
    assert.ok(n > 1_000 && n <= 900_000, snapshot);
    runs.push(snapshot);
  }
  assert.notEqual(runs[0], runs[1]);
});

test("an old ref in a new run is not an element: it fails instead of hitting another one", async (t) => {
  const page = new FakePage();
  const context = new FakeContext(page);
  const driver = new FirefoxBrowserDriver({
    profileManager: { get: () => ({ id: ID, dataDir: "unused" }) } as never,
    browserDataDir: () => "unused",
    refBase: 5_000,
  });
  (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(ID, context, false, "windows");
  t.after(() => context.close());
  withButton(page);
  assert.match(await extract(driver), /\[ref=p1\.e5001\]/);
  await assert.rejects(driver.clickRef(ID, "p1.e7"), hasCode("ELEMENT_NOT_FOUND"));
  await driver.clickRef(ID, "p1.e5001");
  page.documentId = "doc-2";
  await assert.rejects(driver.clickRef(ID, "p1.e5001"), hasCode("STALE_REF"));
});

test("extract caps a huge page and says so; a normal page has no flag", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  const { result: normal } = (await driver.extract(ID)) as { result: Record<string, unknown> };
  assert.equal("truncated" in normal, false);

  const lines = Array.from({ length: 6_000 }, (_, i) => `- button "b${i}" [ref=e${i + 1}]`);
  page.snapshot = lines.join("\n");
  page.elements = new Set(lines.map((_, i) => `e${i + 1}`));
  const { result } = (await driver.extract(ID)) as {
    result: { ariaSnapshot: string; truncated?: boolean };
  };
  assert.equal(result.truncated, true);
  const kept = result.ariaSnapshot.split("\n");
  assert.equal(kept.length, 5_000);
  assert.match(kept.at(-1)!, /"b4999" \[ref=p1\.e\d+\]$/);
  await assert.rejects(driver.clickRef(ID, "p1.e99999"), hasCode("ELEMENT_NOT_FOUND"));
});

test("extract caps the page text too", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  const huge = "x".repeat(3 * 1024 * 1024);
  page.evaluate = async () => huge;
  const { result } = (await driver.extract(ID)) as {
    result: { text: string; truncated?: boolean };
  };
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, 1024 * 1024);
});

// ── display modes ────────────────────────────────────────────────────────────

function withDisplayVars(t: TestContext): void {
  const before = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
  Object.assign(process.env, { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "session-auth" });
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("camoufox's headless option follows the mode, and only headless means headless", () => {
  assert.equal(camoufoxDisplayOptions("headed").headless, false);
  assert.equal(camoufoxDisplayOptions("xvfb").headless, false, "xvfb is a real window");
  assert.equal(camoufoxDisplayOptions("headless").headless, true);
});

test("headed passes the session's display through the allowlist, as it did before", (t) => {
  withDisplayVars(t);
  const { env } = camoufoxDisplayOptions("headed");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(env.XAUTHORITY, "session-auth");
});

test("headless takes every display variable away", (t) => {
  withDisplayVars(t);
  const { env } = camoufoxDisplayOptions("headless");
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.equal(env.XAUTHORITY, undefined);
  assert.equal(env.PATH, process.env.PATH, "the rest of the allowlist stays");
});

test("xvfb's own display overrides what the allowlist forwarded", (t) => {
  withDisplayVars(t);
  const { env } = camoufoxDisplayOptions("xvfb", {
    display: ":7",
    authFile: "own-auth",
    pid: 1,
    stop: async () => {},
  });
  assert.equal(env.DISPLAY, ":7");
  assert.equal(env.XAUTHORITY, "own-auth");
  assert.equal(env.WAYLAND_DISPLAY, undefined);
});

function displayRig(t: TestContext, displayMode: string, stop?: () => void): { driver: FirefoxBrowserDriver; context: FakeContext } {
  const dir = mkdtempSync(join(tmpdir(), "mz-ff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = new FakeContext(new FakePage());
  const driver = new FirefoxBrowserDriver({
    profileManager: { get: () => ({ id: ID, dataDir: dir }) } as never,
    browserDataDir: () => dir,
  });
  (driver as unknown as { adopt: (...a: unknown[]) => unknown }).adopt(
    ID,
    context,
    false,
    "windows",
    displayMode,
    stop ? { display: ":7", authFile: "a", pid: 1, stop: async () => stop() } : undefined,
  );
  t.after(() => driver.closeAll());
  return { driver, context };
}

test("a running browser's mode reads back, and launch answers with it", async (t) => {
  const { driver } = displayRig(t, "headless");
  assert.equal(driver.runningDisplayMode(ID), "headless");
  assert.equal((await driver.launch(ID)).displayMode, "headless");
  await driver.close(ID);
  assert.equal(driver.runningDisplayMode(ID), null);
});

test("xvfb: the display stops when close_profile closes the browser", async (t) => {
  let stops = 0;
  const { driver } = displayRig(t, "xvfb", () => void stops++);
  await driver.close(ID);
  assert.ok(stops >= 1);
});

test("xvfb: the display stops when the browser goes by itself", async (t) => {
  let stops = 0;
  const { context } = displayRig(t, "xvfb", () => void stops++);
  context.emit("close");
  assert.equal(stops, 1);
});

test("the start page: launch waits for its commit, so a navigate right after can't be aborted by it", async () => {
  const order: string[] = [];
  let commit = (): void => {};
  const page = Object.assign(new EventEmitter(), {
    goto: (url: string, opts: { waitUntil: string }) => {
      order.push(`goto ${url} ${opts.waitUntil}`);
      return new Promise<null>((resolve) => {
        commit = () => {
          order.push("committed");
          resolve(null);
        };
      });
    },
  });
  const opening = openStartPage(page as never, "about:blank").then(() => order.push("returned"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["goto about:blank commit"]);
  commit();
  await opening;
  assert.deepEqual(order, ["goto about:blank commit", "committed", "returned"]);
});

test("the start page: a slow one doesn't hold up the launch, and a failed one doesn't fail it", async () => {
  const never = Object.assign(new EventEmitter(), { goto: () => new Promise<null>(() => {}) });
  const startedAt = Date.now();
  await openStartPage(never as never, "http://slow/", 30);
  assert.ok(Date.now() - startedAt < 2_000);

  const broken = Object.assign(new EventEmitter(), {
    goto: () => Promise.reject(new Error("net::ERR_PROXY_CONNECTION_FAILED")),
  });
  await openStartPage(broken as never, "http://down/");
});

// ── the handoff panel: frames, input, handoff mode ───────────────────────────

test("jpegSize reads a start of frame, past other markers and not fooled by the rest", () => {
  assert.deepEqual(jpegSize(jpegOf(1280, 720)), { width: 1280, height: 720 });
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8])), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88])), null);
});

test("a frame leaves the DOM alone, and takes its size from the image, not from the page", async (t) => {
  const { driver, page } = rig(t);
  page.currentUrl = "http://t/page";
  const frame = await driver.captureFrame(ID);
  assert.deepEqual(frame.viewport, { width: 1280, height: 720 });
  assert.equal(frame.url, "http://t/page");
  assert.equal(frame.targetId, "1");
  assert.deepEqual(page.calls, [
    'screenshot {"type":"jpeg","quality":60,"caret":"initial","animations":"allow","scale":"css","timeout":5000}',
  ]);
  await driver.captureFrame(ID, { quality: 30 });
  assert.match(page.calls[1]!, /"quality":30/);
});

test("a frame with a dialog open says DIALOG_OPEN, with the dialog", async (t) => {
  const { driver, page } = rig(t);
  await driver.setHandoffMode(ID, true);
  page.emit("dialog", new FakeDialog("confirm", "Sure?", page));
  await assert.rejects(driver.captureFrame(ID), (e: MultizenError) => {
    assert.equal(e.code, "DIALOG_OPEN");
    assert.equal(e.details?.message, "Sure?");
    return true;
  });
  assert.deepEqual(page.calls, [], "the page is never asked");
});

test("human mouse input lands at the fraction of the last frame's size", async (t) => {
  const { driver, page } = rig(t);
  await driver.captureFrame(ID);
  page.calls.length = 0;
  await driver.dispatchInput(ID, { kind: "mouse", action: "move", x: 0.5, y: 0.25, button: "none", buttons: 0 });
  await driver.dispatchInput(ID, { kind: "mouse", action: "down", x: 0.5, y: 0.25, button: "left", buttons: 1, clickCount: 2 });
  await driver.dispatchInput(ID, { kind: "mouse", action: "up", x: 0.5, y: 0.25, button: "left", buttons: 0, clickCount: 2 });
  await driver.dispatchInput(ID, { kind: "wheel", x: 0, y: 1, deltaX: 3, deltaY: 120 });
  assert.deepEqual(page.calls, [
    "move 640,180",
    "move 640,180",
    'down {"button":"left","clickCount":2}',
    "move 640,180",
    'up {"button":"left","clickCount":2}',
    "move 0,720",
    "wheel 3,120",
  ]);
});

test("human keys press what Playwright knows, insert what it doesn't, and skip what means nothing", async (t) => {
  const { driver, page } = rig(t);
  const key = (action: "down" | "up", name: string, text?: string) =>
    driver.dispatchInput(ID, { kind: "key", action, key: name, code: "", keyCode: 0, modifiers: 0, ...(text ? { text } : {}) });
  await key("down", "a", "a");
  await key("up", "a");
  await key("down", "Enter", "\r");
  await key("up", "Enter");
  await key("down", "ф", "ф");
  await key("up", "ф");
  await key("down", "😀", "😀");
  await key("down", "Process");
  await driver.dispatchInput(ID, { kind: "text", text: "你好 🎉" });
  assert.deepEqual(page.calls, [
    "keydown a",
    "keyup a",
    "keydown Enter",
    "keyup Enter",
    "insert ф",
    "insert 😀",
    "insert 你好 🎉",
  ]);
});

test("handoff mode holds a dialog open whatever the policy, and gives it back to the policy after", async (t) => {
  const { driver, page } = rig(t);
  await driver.setHandoffMode(ID, true);
  const held = new FakeDialog("confirm", "Sure?", page);
  page.emit("dialog", held);
  assert.deepEqual(held.answers, [], "auto mode would have answered it");
  assert.equal((await driver.listDialogs(ID))[0]?.message, "Sure?");
  await driver.setDialogPolicy(ID, { mode: "auto", confirm: "accept" });
  assert.deepEqual(held.answers, [], "a policy set meanwhile waits for the end");
  await driver.setHandoffMode(ID, false);
  assert.deepEqual(held.answers, [["accept", undefined]]);
  assert.deepEqual(await driver.listDialogs(ID), []);

  const after = new FakeDialog("alert", "after", page);
  page.emit("dialog", after);
  assert.deepEqual(after.answers, [["accept", undefined]], "back to auto");
});

test("handoff mode catches choosers on every page, popups included, and stops when it ends", async (t) => {
  const { driver, page, context } = rig(t);
  assert.equal(page.listenerCount("filechooser"), 0, "no handoff, no listener: the browser's own dialog");
  await driver.setHandoffMode(ID, true);
  assert.equal(page.listenerCount("filechooser"), 1);
  const popup = context.addPage();
  assert.equal(popup.listenerCount("filechooser"), 1);

  const files: string[][] = [];
  const chooser = (multiple: boolean) => ({
    isMultiple: () => multiple,
    setFiles: async (paths: string[]): Promise<void> => void files.push(paths),
  });
  page.emit("filechooser", chooser(false));
  popup.emit("filechooser", chooser(true));
  const open = await driver.listFileChoosers(ID);
  assert.deepEqual(open.map((c) => [c.targetId, c.multiple]), [["1", false], ["2", true]]);
  assert.equal("chooser" in open[0]!, false);

  page.emit("filechooser", chooser(true));
  assert.equal((await driver.listFileChoosers(ID)).length, 2, "clicking again replaces it");

  const [first, second] = await driver.listFileChoosers(ID);
  await driver.respondFileChooser(ID, second!.id, ["C:/inbox/a.txt"]);
  assert.deepEqual(files, [["C:/inbox/a.txt"]]);
  await assert.rejects(driver.respondFileChooser(ID, second!.id, ["x"]), hasCode("INVALID_INPUT"));
  await driver.dismissFileChooser(ID, first!.id);
  assert.deepEqual(await driver.listFileChoosers(ID), []);

  page.emit("filechooser", chooser(false));
  await driver.setHandoffMode(ID, false);
  assert.deepEqual(await driver.listFileChoosers(ID), []);
  assert.equal(page.listenerCount("filechooser"), 0);
  assert.equal(popup.listenerCount("filechooser"), 0);
});

test("the panel's verbs on a stopped profile report PROFILE_NOT_RUNNING", async (t) => {
  const { driver, context } = rig(t);
  await context.close();
  await assert.rejects(driver.captureFrame(ID), hasCode("PROFILE_NOT_RUNNING"));
  await assert.rejects(driver.dispatchInput(ID, { kind: "text", text: "x" }), hasCode("PROFILE_NOT_RUNNING"));
  await assert.rejects(driver.setHandoffMode(ID, true), hasCode("PROFILE_NOT_RUNNING"));
});

test("a press over a frame gives its owner focus first, or the press only focuses the frame", async (t) => {
  const { driver, page } = rig(t);
  await driver.captureFrame(ID);
  page.childFrames = [
    { name: "outer", x: 100, y: 100, width: 400, height: 200 },
    { name: "inner", x: 150, y: 150, width: 100, height: 50 },
  ];
  page.calls.length = 0;
  const press = (x: number, y: number) =>
    driver.dispatchInput(ID, { kind: "mouse", action: "down", x: x / 1280, y: y / 720, button: "left", buttons: 1 });

  await press(160, 160);
  assert.deepEqual(page.calls.slice(0, 2), ["focus frame inner", "move 160,160"], "the deepest, before the press");
  page.calls.length = 0;
  await press(110, 110);
  assert.equal(page.calls[0], "focus frame outer");
  page.calls.length = 0;
  await press(10, 10);
  assert.equal(page.calls[0], "move 10,10", "over the page itself, nothing moves focus early");
  page.calls.length = 0;
  await driver.dispatchInput(ID, { kind: "mouse", action: "move", x: 160 / 1280, y: 160 / 720, button: "none", buttons: 0 });
  await driver.dispatchInput(ID, { kind: "mouse", action: "up", x: 160 / 1280, y: 160 / 720, button: "left", buttons: 0 });
  assert.ok(!page.calls.some((c) => c.startsWith("focus")), "only a press moves it");
});

test("keys after a click make sure the element has focus: a frame may only have taken it", async (t) => {
  const { driver, page } = rig(t);
  withButton(page);
  await extract(driver);
  page.calls.length = 0;
  await driver.typeRef(ID, "p1.e1", "x");
  assert.deepEqual(page.calls, ["click aria-ref=e1", "focus aria-ref=e1", "key x"]);
  page.calls.length = 0;
  await driver.performAction(ID, { type: "press_key", key: "Enter", target: { ref: "p1.e1" } });
  assert.deepEqual(page.calls.slice(0, 2), ["click aria-ref=e1", "focus aria-ref=e1"]);
});
