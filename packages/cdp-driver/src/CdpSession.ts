import type { EventEmitter } from "node:events";
import CDP from "chrome-remote-interface";
import {
  DEFAULT_DIALOG_ANSWERS,
  MultizenError,
  type DialogPolicy,
  type DialogResponse,
  type DialogType,
  type ElementTarget,
  type OpenDialog,
} from "@multizen/types";
import type { AccessibilityNode, ExtractContext } from "./types.js";
import {
  describeKey,
  parseChord,
  CDP_MOD_SHIFT,
  type KeyChord,
  type KeyDescriptor,
  type KeyPlatform,
} from "./keyboard.js";
import { TargetRegistry } from "./targetRegistry.js";

/**
 * Send a CDP command to a specific target/session. Returned by
 * {@link CdpSession.bootstrapTargets} so a setup function does not have
 * to track sessionIds itself.
 */
export interface TargetContext {
  /** True for the root (top-level page) session, false for nested iframes. */
  isRoot: boolean;
  /** Target type as reported by Target.attachedToTarget — "page" | "iframe" | etc. */
  type: "page" | "iframe";
}

export type TargetSender = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

function buildSender(client: CDP.Client, sessionId: string | undefined): TargetSender {
  return ((method: string, params?: Record<string, unknown>) => {
    if (sessionId === undefined) {
      // Root session: third arg omitted entirely.
      return (
        client as unknown as {
          send: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
        }
      ).send(method, params);
    }
    return (
      client as unknown as {
        send: (
          m: string,
          p: Record<string, unknown> | undefined,
          sid: string,
        ) => Promise<unknown>;
      }
    ).send(method, params, sessionId);
  }) as TargetSender;
}

export interface CdpSessionOptions {
  /** Port the Chromium instance is listening on */
  port: number;
  /** Optional host override, defaults to localhost */
  host?: string;
  /**
   * Browser engine identifier (e.g. "cloakbrowser"). Lets the safe
   * `cdpSend` layer refuse `*.enable` of DCHECK-sensitive domains on
   * anti-detect forks where enabling — not the paired disable — is what
   * trips the automation tripwire.
   */
  engine?: string;
  /** The persona's platform: on macos, `ControlOrMeta` in a key chord means Command. */
  platform?: KeyPlatform;
}

/**
 * Domains the safe `cdpSend` layer is allowed to enable-then-disable. We use
 * an explicit allowlist (domain → has a paired `*.disable`) instead of a
 * string heuristic on `*.enable` so unknown domains are never touched.
 */
const SAFE_PAIRED_DISABLE_DOMAINS = new Set([
  "Runtime",
  "Network",
  "DOM",
  "Accessibility",
  "Log",
  "Performance",
]);

/**
 * Domains whose `*.enable` trips the DCHECK on anti-detect Chromium forks
 * (CloakBrowser) at enable time. A paired disable cannot undo it, so safe
 * mode refuses these enables outright on such engines.
 */
const CLOAK_RISKY_ENABLE_DOMAINS = new Set(["Runtime", "Network"]);

/**
 * Default ceiling for a single CDP command. A wedged renderer or a stalled
 * transport would otherwise leave a `cdpSend` (and the MCP call built on it)
 * pending forever. Individual waits poll with their own short calls, so this
 * never truncates a legitimate long wait — it only fails a genuinely hung one.
 * Callers can override per call via `opts.timeoutMs` (0 disables).
 */
const DEFAULT_CDP_TIMEOUT_MS = 30_000;

/**
 * How long a new target may spend on its setup before it is resumed anyway. It is
 * paused for the debugger until then, and on a desktop a person may be looking at it.
 */
const TARGET_SETUP_BUDGET_MS = 5_000;

/** How long new_tab waits for the browser to attach the tab it asked for. */
const TAB_ATTACH_BUDGET_MS = 10_000;

/** Per frame: one slow ad frame must not cost the rest of the page. */
const SNAPSHOT_FRAME_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_FRAMES = 30;
const MAX_SNAPSHOT_FRAME_DEPTH = 5;

/** Live refs kept for a browser run. The oldest then read as stale, which is safe. */
const MAX_LIVE_REFS = 100_000;

/** Reads of an element's position until two agree: a scroll can still be settling. */
const POINT_SETTLE_READS = 5;
const POINT_SETTLE_MS = 50;

const FILE_CHOOSER_TIMEOUT_MS = 5_000;

/**
 * Methods the safe `cdpSend` layer refuses outright. These have no legitimate
 * stealth-preserving use and would either break the session or expose
 * automation: disabling the connect-sacred `Page` domain (kills
 * navigate/lifecycle), installing a `Runtime.addBinding` channel, or
 * re-exposing the DevTools protocol to the page. An agent that genuinely needs
 * them must opt into `cdp_send_no_safety`.
 */
const SAFE_DENIED_METHODS = new Set([
  "Page.disable",
  "Runtime.addBinding",
  "Target.exposeDevToolsProtocol",
  "Page.exposeDevToolsProtocol",
]);

/**
 * Sent to the browser unless the caller names a session: page sessions either lack
 * these or see only their own page. `setAutoAttach` stays on the page, because on
 * the browser it could detach every session this class depends on.
 */
const BROWSER_LEVEL_METHOD = /^(Browser|SystemInfo)\.|^Target\.(?!setAutoAttach$)/;

/**
 * Isolated world the input probe lives in. Page script cannot see globals or
 * listeners registered there, but they receive the same DOM events.
 */
const INPUT_PROBE_WORLD = "mz_input_probe";

/** How long to keep re-reading the probe before calling input lost. */
const INPUT_PROBE_GRACE_MS = 300;

/**
 * Installs the probe in the isolated world. Counts trusted presses, releases
 * and keydowns on `window` in the capture phase. Moves are not counted, so a
 * page that gets the moves but loses the presses still reads as lost. Shift
 * keydowns are not counted either: one character is one counted keydown.
 */
const INPUT_PROBE_INSTALL = `(() => {
  const s = { pressed: false, released: false, keys: 0 };
  const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "keydown"];
  const on = (e) => {
    if (!e.isTrusted) return;
    if (e.type === "pointerdown" || e.type === "mousedown") s.pressed = true;
    else if (e.type === "keydown") { if (e.key !== "Shift") s.keys++; }
    else s.released = true;
  };
  for (const t of types) addEventListener(t, on, true);
  s.stop = () => { for (const t of types) removeEventListener(t, on, true); };
  if (globalThis.__mzInputProbe) globalThis.__mzInputProbe.stop();
  globalThis.__mzInputProbe = s;
})()`;

const INPUT_PROBE_READ = `(() => {
  const s = globalThis.__mzInputProbe;
  return JSON.stringify({
    pressed: !!(s && s.pressed),
    released: !!(s && s.released),
    keys: s ? s.keys : 0,
    hidden: document.visibilityState === "hidden",
    painted: performance.getEntriesByType("paint").length > 0,
  });
})()`;

const INPUT_PROBE_STOP = `(() => {
  const s = globalThis.__mzInputProbe;
  if (s) { s.stop(); delete globalThis.__mzInputProbe; }
})()`;

/** Sets a <select>'s option and sends the events a person's choice would. */
const SELECT_OPTION_FUNCTION = `function (c) {
  if (this.localName !== "select") return "not-select";
  const options = [...this.options];
  const i = c.index !== undefined
    ? c.index
    : options.findIndex((o) =>
        c.value !== undefined ? o.value === c.value : o.label === c.label || o.text.trim() === c.label);
  const option = options[i];
  if (!option) return "no-option";
  if (this.multiple) option.selected = true;
  else this.selectedIndex = i;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;

/** The probe's context is gone: the document was replaced mid-input. */
const PROBE_CONTEXT_GONE =
  /Cannot find context|execution context was destroyed|No execution context|Session with given id not found/i;

/** The node's document is gone, or the node left it. */
const NODE_GONE =
  /No node with given id|Could not find node|detached from document|Session with given id not found|does not belong to the target/i;

/** The node exists but has no box to act on. */
const NODE_NOT_RENDERED = /layout object|Could not compute (content )?quads|box model/i;

const NO_SUCH_TARGET = /No target with given id|Target closed|Could not find target/i;

interface InputProbeState {
  pressed: boolean;
  released: boolean;
  keys: number;
  hidden: boolean;
  painted: boolean;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url?: string;
  /** Set on a page that is not a tab: "prerender", for one. */
  subtype?: string;
}

/** An out-of-process iframe: its own session, under the tab that embeds it. */
interface OopifSession {
  targetId: string;
  frameId: string;
  /** Where its owner element lives, and where its attach event came from. */
  parentSessionId: string;
}

interface TabSession {
  targetId: string;
  sessionId: string;
  /** By session. Includes nested ones. */
  oopifs: Map<string, OopifSession>;
  /** Setup is over and the target is running. */
  ready: boolean;
  /** Settles when `ready` is set, with whether the session can be used. */
  setup: Promise<boolean>;
}

interface FrameAddress {
  sessionId: string;
  frameId: string;
}

interface RefEntry extends FrameAddress {
  targetId: string;
  backendNodeId: number;
  /** Which document of the frame the node belongs to. */
  loaderId?: string;
}

/** An element a verb is about to act on. */
interface ResolvedElement extends FrameAddress {
  tab: TabSession;
  backendNodeId: number;
  /** For messages: 'ref "e7"' or a selector. */
  label: string;
  ref?: string;
}

interface SnapshotFrame extends FrameAddress {
  loaderId?: string;
  depth: number;
  /** The session that can name this frame's owner element. None for a tab's main frame. */
  ownerSessionId?: string;
}

interface FrameTreeNode {
  frame: { id: string; loaderId?: string };
  childFrames?: FrameTreeNode[];
}

interface ArmedProbe {
  sessionId: string;
  contextId: number;
}

interface TrackedDialog extends OpenDialog {
  sessionId: string;
  targetId: string;
}

/** Browser download events, as {@link CdpSession.enableDownloads} passes them on. */
export interface DownloadEventSink {
  began(event: { guid: string; url: string; suggestedFilename: string }): void;
  progress(event: {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: "inProgress" | "completed" | "canceled";
  }): void;
}

/**
 * Thrown when Chromium accepted an Input.dispatch* command but the page
 * received no matching event. The MCP layer surfaces the message as a tool
 * error, so it names the likely cause and what to do next.
 */
export class InputNotDeliveredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputNotDeliveredError";
  }
}

function inputLostHint(st: InputProbeState): string {
  if (st.hidden) {
    return (
      ' The page is hidden (document.visibilityState is "hidden")' +
      (st.painted
        ? ""
        : " and has not painted since it loaded, and Chromium drops input to such a page") +
      ". Bring its window to the front (cdp_send Page.bringToFront), then retry."
    );
  }
  return " The page is visible. Take a screenshot to check whether something covers the target, then retry.";
}

function staleRef(ref: string): MultizenError {
  return new MultizenError(
    "STALE_REF",
    `Element ref "${ref}" is stale: its element or document is gone since extract.`,
    { hint: "Call extract and use the refs it gives." },
  );
}

function tabNotFound(targetId: string): MultizenError {
  return new MultizenError("TAB_NOT_FOUND", `No tab with target id ${targetId}`, {
    hint: "Call list_tabs for the open tabs.",
  });
}

/**
 * Thin wrapper around chrome-remote-interface that exposes the
 * primitives our MCP tools call: navigate, click, type, extract,
 * screenshot. Stays connected per profile so cookies / DOM state
 * survive across calls.
 *
 * `click` and `type` require a CSS selector. We do not embed any LLM
 * for natural-language target resolution — the calling MCP client
 * (Claude in Cursor, Claude Desktop, Cline, etc.) does that on its
 * own side, then sends us a concrete selector.
 *
 * `extract` returns the page's URL, title, and trimmed accessibility
 * tree. The calling LLM is expected to parse it. We intentionally do
 * not call any external API.
 *
 * One websocket to the browser carries every session. Page verbs act on the active
 * tab; a ref carries its own tab, frame and session.
 */
export class CdpSession {
  private client: CDP.Client | null = null;
  private readonly opts: CdpSessionOptions;
  /** Cleanups (e.g. polling intervals) to run on close(). */
  private readonly teardowns: Array<() => void> = [];
  /**
   * Domains enabled by {@link connect}. These are part of the stealth-minimal
   * baseline (currently just `Page`) and must NEVER be disabled by the safe
   * `cdpSend` layer — `navigate`/`Page.loadEventFired` depend on `Page`.
   */
  private readonly connectEnabledDomains = new Set<string>(["Page"]);
  /**
   * Per-domain refcount of enables performed by the safe `cdpSend` layer.
   * Parallel safe calls share the count so they don't clobber each other's
   * in-flight enable; the paired disable runs only when a domain's count
   * falls back to 0.
   */
  private readonly safeEnableRefcount = new Map<string, number>();

  /** The page targets, and which one is active: what page verbs act on. */
  private readonly targets = new TargetRegistry();
  private readonly tabs = new Map<string, TabSession>();
  /** Every page and OOPIF session held here, to find the tab an event belongs to. */
  private readonly sessionTabs = new Map<string, TabSession>();
  /** Set by `bootstrapTargets`; runs once per target, before it resumes. */
  private targetSetup: ((send: TargetSender, ctx: TargetContext) => Promise<void>) | null = null;
  private readonly setupDone = new Set<string>();
  /** Targets an agent is attaching to through cdp_send: those sessions are its own. */
  private readonly agentAttaches = new Set<string>();
  /** The active tab was closed from outside, so the browser may be showing another. */
  private activeNeedsRaise = false;

  /**
   * ref (e.g. "e7") → the element it names. Lets agents act on elements by a short
   * handle instead of synthesizing a CSS selector. A ref is issued once per browser
   * run and stays valid while its node lives, so a later snapshot gives the same node
   * the same ref. An entry leaves here when its document does, and then the ref reads
   * as stale: it can never come to mean another element.
   */
  private readonly refs = new Map<string, RefEntry>();
  /** `${sessionId}:${backendNodeId}` → ref, so a snapshot can reuse live refs. */
  private readonly refByNode = new Map<string, string>();
  private refSeq = 0;
  /** Per session: snapshots in flight holding Accessibility enabled there. */
  private readonly axUsers = new Map<string, number>();

  private dialogPolicy: DialogPolicy = { mode: "auto" };
  private readonly openDialogs = new Map<string, TrackedDialog>();
  private dialogSeq = 0;
  /** Operations that can't finish while a dialog blocks their tab's renderer. */
  private readonly dialogWatchers = new Set<{ targetId: string; fire: () => void }>();
  private downloadSink: DownloadEventSink | null = null;

  /** Flipped true when the underlying websocket drops (browser exited). Actions
   *  then fail loud with a clear message instead of hanging on a dead socket or
   *  returning stale state. */
  private disconnected = false;

  constructor(opts: CdpSessionOptions) {
    this.opts = opts;
  }

  /**
   * Attach to the browser itself rather than to one tab, so closing a tab can't
   * kill the session. Atomic: `client` is set only once a tab is attached, otherwise
   * the socket is closed and connect() can run again, which the readiness ladder
   * relies on.
   *
   * Stealth-minimal. Anti-detect Chromium forks (CloakBrowser, BotBrowser, Camoufox)
   * DCHECK on most CDP enable commands because they're automation-presence signals.
   * Page sessions get Page.enable (needed for navigate/lifecycle/dialog events) and
   * nothing else stays enabled. OOPIF sessions get no enable at all. Runtime and DOM
   * are never enabled: Runtime.evaluate, DOM.getContentQuads and friends work without
   * it. Accessibility is enabled only for the duration of a snapshot, on page sessions.
   *
   * The big wins from this: (a) Cloudflare/DataDome can't fingerprint our CDP
   * presence via Runtime.enable, (b) CloakBrowser doesn't SIGTRAP on connect.
   */
  async connect(): Promise<void> {
    if (this.client) return;
    const client = await this.openBrowserSocket();
    try {
      this.disconnected = false;
      // The websocket drops when the browser exits. Mark the session dead so
      // subsequent actions fail loud (see require()) rather than hanging on a dead
      // socket.
      client.on("disconnect", () => {
        this.disconnected = true;
      });
      this.listenForTargets(client);
      await sendTo(client, "Target.setDiscoverTargets", { discover: true });
      // Pages only. Each page session asks for its own iframes, and nothing else
      // (service workers, extension background pages) is ever paused here.
      await sendTo(client, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "page" }],
      });
      const { targetInfos } = await sendTo<{ targetInfos: TargetInfo[] }>(
        client,
        "Target.getTargets",
      );
      for (const info of targetInfos) {
        if (isTabTarget(info) && !this.tabs.has(info.targetId)) {
          // The attach event registers it. Failing is fine: it just closed.
          await sendTo(client, "Target.attachToTarget", {
            targetId: info.targetId,
            flatten: true,
          }).catch(() => {});
        }
      }
      const attached = await Promise.all([...this.tabs.values()].map((tab) => tab.setup));
      if (!attached.includes(true)) throw new Error("No page target could be attached");
      await this.pickVisibleTab(client);
    } catch (e) {
      this.forgetTargets();
      await client.close().catch(() => {});
      throw e;
    }
    this.client = client;
  }

  private async openBrowserSocket(): Promise<CDP.Client> {
    const host = this.opts.host ?? "localhost";
    const { webSocketDebuggerUrl } = await CDP.Version({ host, port: this.opts.port });
    return CDP({ target: webSocketDebuggerUrl, local: true });
  }

  /** With session-restored tabs: the one the browser shows, not whichever came first. */
  private async pickVisibleTab(client: CDP.Client): Promise<void> {
    if (this.tabs.size < 2) return;
    for (const tab of this.tabs.values()) {
      const visible = await sendTo<{ result?: { value?: unknown } }>(
        client,
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        tab.sessionId,
        1_000,
      ).catch(() => null);
      if (visible?.result?.value === "visible") {
        this.targets.setActive(tab.targetId);
        return;
      }
    }
  }

  private listenForTargets(client: CDP.Client): void {
    client.on(
      "Target.attachedToTarget",
      (p: { sessionId: string; targetInfo: TargetInfo }, parentSessionId?: string) =>
        this.onAttachedToTarget(client, p.sessionId, p.targetInfo, parentSessionId),
    );
    client.on("Target.detachedFromTarget", (p: { sessionId: string }) =>
      this.onDetachedFromTarget(p.sessionId),
    );
    client.on("Target.targetDestroyed", (p: { targetId: string }) => this.dropTab(p.targetId));
    client.on("Target.targetCrashed", (p: { targetId: string }) =>
      this.invalidateRefs((e) => e.targetId === p.targetId),
    );
    client.on(
      "Page.frameNavigated",
      (p: { frame: { id: string; parentId?: string } }, sessionId?: string) => {
        const tab = sessionId ? this.sessionTabs.get(sessionId) : undefined;
        if (!tab) return;
        // A main frame's navigation takes every frame under it along.
        if (p.frame.parentId === undefined && sessionId === tab.sessionId) {
          this.invalidateRefs((e) => e.targetId === tab.targetId);
        } else {
          this.invalidateRefs((e) => e.sessionId === sessionId && e.frameId === p.frame.id);
        }
      },
    );
    client.on("Page.frameDetached", (p: { frameId: string }, sessionId?: string) =>
      this.invalidateRefs((e) => e.sessionId === sessionId && e.frameId === p.frameId),
    );
    client.on(
      "Page.javascriptDialogOpening",
      (
        p: { type: DialogType; message: string; url?: string; defaultPrompt?: string },
        sessionId?: string,
      ) => this.onDialogOpening(client, p, sessionId),
    );
    client.on("Page.javascriptDialogClosed", (_p: object, sessionId?: string) => {
      for (const [id, dialog] of this.openDialogs) {
        if (dialog.sessionId === sessionId) this.openDialogs.delete(id);
      }
    });
    client.on(
      "Browser.downloadWillBegin",
      (p: { guid: string; url: string; suggestedFilename: string }) => this.downloadSink?.began(p),
    );
    client.on(
      "Browser.downloadProgress",
      (p: Parameters<DownloadEventSink["progress"]>[0]) => this.downloadSink?.progress(p),
    );
  }

  /**
   * Every page the browser opens lands here, and each page or OOPIF session then asks
   * for the iframes under it, because nested OOPIFs attach only from their parent's
   * session. The first session for a target wins: a second one (auto-attach racing an
   * explicit attach) is resumed and dropped, so setup runs once per target. Sessions
   * an agent attached itself through cdp_send stay its own, untouched.
   */
  private onAttachedToTarget(
    client: CDP.Client,
    sessionId: string,
    info: TargetInfo,
    parentSessionId: string | undefined,
  ): void {
    if (this.agentAttaches.has(info.targetId)) return;
    if (isTabTarget(info) && !this.tabs.has(info.targetId)) {
      const tab: TabSession = {
        targetId: info.targetId,
        sessionId,
        oopifs: new Map(),
        ready: false,
        setup: Promise.resolve(false),
      };
      this.tabs.set(info.targetId, tab);
      this.sessionTabs.set(sessionId, tab);
      // A popup or a tab the operator opened: it does not take the active tab.
      this.targets.addIdle({ targetId: info.targetId, type: info.type, url: info.url });
      tab.setup = this.initTargetSession(client, info.targetId, sessionId, "page").finally(() => {
        tab.ready = true;
      });
      return;
    }
    if (info.type === "iframe" && parentSessionId) {
      const tab = this.sessionTabs.get(parentSessionId);
      if (tab && ![...tab.oopifs.values()].some((o) => o.targetId === info.targetId)) {
        tab.oopifs.set(sessionId, {
          targetId: info.targetId,
          // A frame target's id is its frame's id.
          frameId: info.targetId,
          parentSessionId,
        });
        this.sessionTabs.set(sessionId, tab);
        void this.initTargetSession(client, info.targetId, sessionId, "iframe");
        return;
      }
    }
    void (async () => {
      await resumeTarget(client, sessionId);
      await sendTo(client, "Target.detachFromTarget", { sessionId }).catch(() => {});
    })();
  }

  /**
   * Whatever goes wrong here, the target gets resumed: it is paused until then, and
   * a tab stuck loading forever is worse than one missing an override.
   */
  private async initTargetSession(
    client: CDP.Client,
    targetId: string,
    sessionId: string,
    type: "page" | "iframe",
  ): Promise<boolean> {
    const steps = (async () => {
      if (type === "page") await sendTo(client, "Page.enable", undefined, sessionId);
      await sendTo(
        client,
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "iframe" }],
        },
        sessionId,
      );
      await this.runTargetSetup(client, targetId, sessionId, type);
    })();
    try {
      await withTimeout(steps, TARGET_SETUP_BUDGET_MS, `Setting up target ${targetId} timed out`);
      return true;
    } catch {
      return false;
    } finally {
      await resumeTarget(client, sessionId);
    }
  }

  private async runTargetSetup(
    client: CDP.Client,
    targetId: string,
    sessionId: string,
    type: "page" | "iframe",
  ): Promise<void> {
    if (!this.targetSetup || this.setupDone.has(targetId)) return;
    this.setupDone.add(targetId);
    await this.targetSetup(buildSender(client, sessionId), {
      isRoot: type === "page",
      type,
    }).catch(() => {});
  }

  private onDetachedFromTarget(sessionId: string): void {
    const tab = this.sessionTabs.get(sessionId);
    if (!tab) return;
    if (tab.sessionId === sessionId) {
      this.dropTab(tab.targetId);
      return;
    }
    const oopif = tab.oopifs.get(sessionId);
    tab.oopifs.delete(sessionId);
    this.sessionTabs.delete(sessionId);
    if (oopif) this.setupDone.delete(oopif.targetId);
    this.invalidateRefs((e) => e.sessionId === sessionId);
  }

  private dropTab(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (!tab) return;
    this.tabs.delete(targetId);
    this.sessionTabs.delete(tab.sessionId);
    this.setupDone.delete(targetId);
    for (const [sessionId, oopif] of tab.oopifs) {
      this.sessionTabs.delete(sessionId);
      this.setupDone.delete(oopif.targetId);
    }
    this.invalidateRefs((e) => e.targetId === targetId);
    for (const [id, dialog] of this.openDialogs) {
      if (dialog.targetId === targetId) this.openDialogs.delete(id);
    }
    const wasActive = this.targets.active() === targetId;
    this.targets.remove(targetId);
    if (wasActive && this.targets.active()) this.activeNeedsRaise = true;
  }

  private forgetTargets(): void {
    this.tabs.clear();
    this.sessionTabs.clear();
    this.targets.clear();
    this.setupDone.clear();
    this.refs.clear();
    this.refByNode.clear();
    this.openDialogs.clear();
  }

  async close(): Promise<void> {
    for (const t of this.teardowns.splice(0)) {
      try {
        t();
      } catch {
        // ignore
      }
    }
    if (!this.client) return;
    await this.client.close();
    this.client = null;
  }

  /**
   * Canonical graceful Chromium shutdown via CDP `Browser.close`. This is
   * the macOS ⌘Q equivalent: it walks Chromium through its full quit
   * sequence so `Default/Sessions/Tabs_*` and `Last Session` are flushed
   * to disk before the process exits — which is what makes the next
   * launch's "Continue where you left off" actually restore tabs.
   *
   * SIGINT/SIGTERM alone are not reliable: SIGTERM kills too fast (lost
   * tabs), SIGINT works on Linux Chrome but on macOS Chromium often
   * exits via a path that skips the session-state writer.
   *
   * The websocket disconnects mid-call, so we don't await — we just fire
   * the command and rely on the caller to wait for `child.on("exit")`.
   */
  async closeBrowser(): Promise<void> {
    if (!this.client) throw new Error("CDP session not connected");
    const send = (
      this.client as unknown as {
        send: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
      }
    ).send;
    await send.call(this.client, "Browser.close").catch(() => {
      // Connection drops as Chromium shuts down — expected.
    });
  }

  /**
   * The browser process's PID, as the browser itself reports it. Null when it
   * won't say. A launch compares this with the child it spawned, because something
   * else may already answer on the port.
   */
  async browserPid(): Promise<number | null> {
    const info = await this.send<{ processInfo?: Array<{ id: number; type: string }> }>(
      "SystemInfo.getProcessInfo",
    ).catch(() => null);
    return info?.processInfo?.find((p) => p.type === "browser")?.id ?? null;
  }

  /**
   * Apply a setup function to every page and iframe target the browser has now and
   * to every one it opens later. Used to wire Emulation overrides (timezone, locale,
   * Sec-CH-UA via userAgentMetadata) and preload scripts (WebRTC handler) so a fresh
   * tab is never un-cloaked even for a single navigation.
   *
   * `setup` receives a `send` function pre-bound to the right session. It runs once
   * per target: on those attached already (e.g. session-restored tabs), and on future
   * ones before they resume, which wins the race against the page's first script.
   * "iframe" covers OOPIFs (cross-origin iframes that live in a separate process,
   * common for ad networks and 3rd-party fingerprint services like browserscan's IP
   * probe). Without iframe coverage, RTCPeerConnection inside a cross-origin iframe
   * goes un-spoofed and leaks the real IP via STUN even when the parent page is patched.
   */
  async bootstrapTargets(
    setup: (send: TargetSender, ctx: TargetContext) => Promise<void>,
  ): Promise<void> {
    const client = this.require();
    this.targetSetup = setup;
    const jobs: Array<Promise<void>> = [];
    for (const tab of this.tabs.values()) {
      jobs.push(this.runTargetSetup(client, tab.targetId, tab.sessionId, "page"));
      for (const [sessionId, oopif] of tab.oopifs) {
        jobs.push(this.runTargetSetup(client, oopif.targetId, sessionId, "iframe"));
      }
    }
    await Promise.all(jobs);
  }

  /**
   * Watch for a companion signal on page targets whose URL contains
   * `urlIncludes`. Channel: the content script writes the payload to
   * `<html data-mz-add-ext="…">` and the host polls it via Runtime.evaluate.
   *
   * Why DOM, not a CDP binding/console: CloakBrowser puts content scripts in an
   * ISOLATED world (it ignores manifest `world:MAIN`) and suppresses console
   * CDP events, so neither bindings nor console reach the host. The DOM is
   * shared across worlds and Runtime.evaluate works, so this is the reliable
   * path. Polling is scoped to matching page targets only (never the user's
   * normal browsing) and torn down on close().
   */
  async watchUrlForBinding(opts: {
    urlIncludes: string;
    onPayload: (payload: string) => void;
  }): Promise<void> {
    const client = this.require();
    const { Target } = client;
    const ATTR = "data-mz-add-ext";
    const armed = new Map<string, NodeJS.Timeout>();
    this.teardowns.push(() => {
      for (const iv of armed.values()) clearInterval(iv);
      armed.clear();
    });

    const poll = async (sessionId: string): Promise<void> => {
      try {
        const r = (await client.send(
          "Runtime.evaluate",
          {
            expression: `(function(){var e=document.documentElement,v=e.getAttribute('${ATTR}');if(v)e.removeAttribute('${ATTR}');return v;})()`,
            returnByValue: true,
          },
          sessionId,
        )) as { result?: { value?: unknown } };
        const v = r?.result?.value;
        if (typeof v === "string" && v) {
          opts.onPayload(v);
        }
      } catch {
        // session gone / navigating — ignore
      }
    };

    const arm = (targetId: string, sessionId: string): void => {
      if (armed.has(targetId)) return;
      const interval = setInterval(() => void poll(sessionId), 600);
      armed.set(targetId, interval);
    };
    const disarm = (targetId: string): void => {
      const interval = armed.get(targetId);
      if (interval) {
        clearInterval(interval);
        armed.delete(targetId);
      }
    };

    const evaluate = async (
      targetInfo: { targetId: string; type?: string; url?: string },
      sessionId?: string,
    ): Promise<void> => {
      const isPage = targetInfo.type === undefined || targetInfo.type === "page";
      const matches = isPage && !!targetInfo.url?.includes(opts.urlIncludes);
      if (matches) {
        if (armed.has(targetInfo.targetId)) return;
        // Every page has a session here. One still attaching comes by the event below.
        const sid = sessionId ?? this.tabs.get(targetInfo.targetId)?.sessionId;
        if (sid) arm(targetInfo.targetId, sid);
      } else {
        disarm(targetInfo.targetId);
      }
    };

    await Target.setDiscoverTargets({ discover: true });
    client.on(
      "Target.targetInfoChanged",
      (p: { targetInfo: { targetId: string; url?: string } }) => {
        void evaluate(p.targetInfo);
      },
    );
    client.on(
      "Target.attachedToTarget",
      (p: { sessionId: string; targetInfo: { targetId: string; url?: string } }) => {
        void evaluate(p.targetInfo, p.sessionId);
      },
    );
    client.on("Target.targetDestroyed", (p: { targetId: string }) => {
      disarm(p.targetId);
    });
    try {
      const { targetInfos } = await Target.getTargets();
      for (const t of targetInfos) await evaluate(t);
    } catch {
      // best-effort
    }
  }

  private require(): CDP.Client {
    if (this.disconnected) {
      throw new Error(
        "CDP connection lost — the browser exited. Relaunch the profile and retry.",
      );
    }
    if (!this.client) throw new Error("CDP session not connected. Call connect() first.");
    return this.client;
  }

  /** A command on one session, bounded like cdpSend's. */
  private send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    return sendTo<T>(this.require(), method, params, sessionId, timeoutMs);
  }

  /** The active tab, for verbs that act on the page. */
  private activeTab(): TabSession {
    this.require();
    const id = this.targets.active();
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) {
      throw new MultizenError("TAB_NOT_FOUND", "This browser has no open tab.", {
        hint: "Call new_tab.",
      });
    }
    return tab;
  }

  /**
   * Single primitive every CDP tool composes on top of.
   *
   * - `safe: false` — pure passthrough. No accounting, no auto-disable. The
   *   caller owns the stealth consequences (used by `cdp_send_no_safety`).
   * - `safe: true` (default) — stealth-preserving. If the command is an
   *   allowlisted `*.enable` for a domain that was NOT enabled at connect, the
   *   domain is refcounted and a paired `<domain>.disable` is fired once the
   *   refcount returns to 0. Domains enabled at connect (e.g. `Page`) are
   *   never disabled. On anti-detect engines, enabling a DCHECK-sensitive
   *   domain is refused outright (a paired disable cannot undo the enable).
   *
   * A `sessionId` wins. Without one the command goes to the active tab, or to the
   * browser for the methods that belong there.
   *
   * The convenience wrappers (evaluate_js, cookies, tabs, …) deliberately do
   * NOT enable any domain — `Runtime.evaluate`, `Network.getCookies`, and the
   * `Target.*` methods all work without one — so they never touch this path's
   * accounting branch.
   */
  async cdpSend(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts: { safe?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const client = this.require();
    const routed =
      sessionId ??
      (BROWSER_LEVEL_METHOD.test(method)
        ? undefined
        : this.tabs.get(this.targets.active() ?? "")?.sessionId);
    const rawSend = buildSender(client, routed);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    // Bound every command so a wedged renderer / stalled transport can't hang
    // the call forever. timeoutMs <= 0 opts out.
    const send: TargetSender = ((m: string, p?: Record<string, unknown>) => {
      const agentAttach = m === "Target.attachToTarget" ? String(p?.targetId) : null;
      if (agentAttach) this.agentAttaches.add(agentAttach);
      const promise = rawSend(m, p).finally(() => {
        if (agentAttach) this.agentAttaches.delete(agentAttach);
      });
      return timeoutMs > 0
        ? withTimeout(promise, timeoutMs, `CDP ${m} timed out after ${timeoutMs}ms`)
        : promise;
    }) as TargetSender;
    const safe = opts.safe ?? true;

    if (!safe) {
      return send(method, params);
    }

    if (SAFE_DENIED_METHODS.has(method)) {
      throw new Error(
        `Refusing ${method} in safe mode: it would break the session or expose ` +
          `automation. Use cdp_send_no_safety if you accept the consequences.`,
      );
    }

    const dot = method.indexOf(".");
    const domain = dot > 0 ? method.slice(0, dot) : "";
    const isEnable = dot > 0 && method.slice(dot + 1) === "enable";
    // A "tracked" enable is one the safe layer is responsible for undoing:
    // an allowlisted domain that wasn't already enabled at connect.
    const tracked =
      isEnable && SAFE_PAIRED_DISABLE_DOMAINS.has(domain) && !this.connectEnabledDomains.has(domain);

    if (tracked && this.opts.engine === "cloakbrowser" && CLOAK_RISKY_ENABLE_DOMAINS.has(domain)) {
      throw new Error(
        `Refusing ${method} in safe mode: enabling ${domain} trips the anti-detect ` +
          `DCHECK on this engine at enable time, and a paired disable cannot undo it. ` +
          `Use cdp_send_no_safety if you accept the stealth/crash risk.`,
      );
    }

    if (tracked) {
      // Increment BEFORE the call so a concurrent safe cdpSend sees the
      // in-flight enable and won't issue its own redundant disable.
      this.safeEnableRefcount.set(domain, (this.safeEnableRefcount.get(domain) ?? 0) + 1);
    }

    try {
      return await send(method, params);
    } finally {
      // Decrement in finally so an exception thrown after a successful enable
      // doesn't strand the domain enabled.
      if (tracked) {
        const next = (this.safeEnableRefcount.get(domain) ?? 1) - 1;
        if (next <= 0) {
          this.safeEnableRefcount.delete(domain);
          await rawSend(`${domain}.disable`).catch(() => {
            // Domain may already be disabled / session gone — best effort.
          });
        } else {
          this.safeEnableRefcount.set(domain, next);
        }
      }
    }
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  async listTabs(sessionId?: string): Promise<unknown> {
    const targets = (await this.cdpSend("Target.getTargets", {}, sessionId, {
      safe: true,
    })) as Record<string, unknown>;
    return { ...targets, activeTargetId: this.targets.active() };
  }

  /**
   * Opens a tab and makes it the active one. Returns once its session is attached,
   * so the next verb can't land on the old tab or on a target still paused. Active
   * also means visible: Chromium drops input to a background tab that never showed.
   */
  async newTab(url?: string, sessionId?: string): Promise<unknown> {
    const created = (await this.cdpSend(
      "Target.createTarget",
      { url: url ?? "about:blank" },
      sessionId,
      { safe: true },
    )) as { targetId: string };
    const deadline = Date.now() + TAB_ATTACH_BUDGET_MS;
    while (!this.tabs.get(created.targetId)?.ready) {
      if (Date.now() >= deadline) {
        throw new MultizenError(
          "TIMEOUT",
          `New tab ${created.targetId} did not attach within ${TAB_ATTACH_BUDGET_MS}ms.`,
        );
      }
      await delay(10);
    }
    await this.activateTab(created.targetId);
    return created;
  }

  /** Makes a tab the target of page verbs, and brings it to the foreground. */
  async activateTab(targetId: string, sessionId?: string): Promise<unknown> {
    this.require();
    if (!this.tabs.has(targetId)) throw tabNotFound(targetId);
    const result = await this.cdpSend("Target.activateTarget", { targetId }, sessionId, {
      safe: true,
    }).catch((e: unknown) => {
      throw NO_SUCH_TARGET.test((e as Error).message) ? tabNotFound(targetId) : e;
    });
    // Moves it to most recent, which is what re-selection goes by.
    this.targets.upsert({ targetId, type: "page" });
    this.targets.setActive(targetId);
    this.activeNeedsRaise = false;
    return result;
  }

  /**
   * Closing the active tab makes the most recently used remaining tab active. The
   * browser picks its own neighbour to show, so this raises the one chosen here.
   */
  async closeTab(targetId: string, sessionId?: string): Promise<unknown> {
    const result = await this.cdpSend("Target.closeTarget", { targetId }, sessionId, {
      safe: true,
    }).catch((e: unknown) => {
      throw NO_SUCH_TARGET.test((e as Error).message) ? tabNotFound(targetId) : e;
    });
    this.dropTab(targetId);
    await this.raiseActive();
    return result;
  }

  private async raiseActive(): Promise<void> {
    const targetId = this.targets.active();
    if (!this.activeNeedsRaise || !targetId) return;
    this.activeNeedsRaise = false;
    await this.send("Target.activateTarget", { targetId }).catch(() => {});
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────────

  /**
   * A dialog blocks its renderer, and with it every command that needs that renderer,
   * until someone answers. In auto mode that is us, at once. In manual mode the
   * dialog waits for handleDialog, and operations on its tab report DIALOG_OPEN
   * instead of hanging. An OOPIF's dialog arrives here too, on the page session.
   */
  private onDialogOpening(
    client: CDP.Client,
    p: { type: DialogType; message: string; url?: string; defaultPrompt?: string },
    sessionId: string | undefined,
  ): void {
    const tab = sessionId ? this.sessionTabs.get(sessionId) : undefined;
    // A session an agent attached and enabled sees the same dialog; this one answers.
    if (!tab || !sessionId || tab.sessionId !== sessionId) return;
    if (this.dialogPolicy.mode === "auto") {
      void this.answerDialog(client, sessionId, p.type, this.dialogPolicy);
      return;
    }
    const id = `d${++this.dialogSeq}`;
    this.openDialogs.set(id, {
      id,
      type: p.type,
      message: p.message,
      ...(p.defaultPrompt !== undefined ? { defaultPrompt: p.defaultPrompt } : {}),
      ...(p.url !== undefined ? { url: p.url } : {}),
      openedAt: new Date().toISOString(),
      sessionId,
      targetId: tab.targetId,
    });
    for (const watcher of [...this.dialogWatchers]) {
      if (watcher.targetId === tab.targetId) watcher.fire();
    }
  }

  private answerDialog(
    client: CDP.Client,
    sessionId: string,
    type: DialogType,
    policy: DialogPolicy,
  ): Promise<unknown> {
    const accept = (policy[type] ?? DEFAULT_DIALOG_ANSWERS[type]) === "accept";
    return sendTo(
      client,
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(accept && type === "prompt" && policy.promptText !== undefined
          ? { promptText: policy.promptText }
          : {}),
      },
      sessionId,
    ).catch(() => {
      // The dialog may already be gone (navigated away / page closed).
    });
  }

  /** Dialogs left open under manual mode are answered by the new policy if it is auto. */
  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    const client = this.require();
    this.dialogPolicy = policy;
    if (policy.mode !== "auto") return;
    const open = [...this.openDialogs.values()];
    this.openDialogs.clear();
    await Promise.all(open.map((d) => this.answerDialog(client, d.sessionId, d.type, policy)));
  }

  listDialogs(): OpenDialog[] {
    return [...this.openDialogs.values()].map(
      ({ sessionId: _sessionId, targetId: _targetId, ...dialog }) => dialog,
    );
  }

  hasOpenDialog(): boolean {
    return this.openDialogs.size > 0;
  }

  async handleDialog(response: DialogResponse): Promise<void> {
    const dialog = response.dialogId
      ? this.openDialogs.get(response.dialogId)
      : this.openDialogs.values().next().value;
    if (!dialog) {
      throw new MultizenError(
        "INVALID_INPUT",
        response.dialogId ? `No open dialog ${response.dialogId}` : "No dialog is open",
        { hint: "Call list_dialogs for the open dialogs." },
      );
    }
    this.openDialogs.delete(dialog.id);
    await this.send(
      "Page.handleJavaScriptDialog",
      {
        accept: response.action === "accept",
        ...(response.promptText !== undefined ? { promptText: response.promptText } : {}),
      },
      dialog.sessionId,
    );
  }

  private assertNoDialog(tab: TabSession): void {
    for (const dialog of this.openDialogs.values()) {
      if (dialog.targetId === tab.targetId) {
        throw new MultizenError(
          "DIALOG_OPEN",
          `A ${dialog.type} dialog is open on this tab: "${dialog.message.slice(0, 200)}"`,
          {
            hint: "Answer it with handle_dialog, then retry.",
            details: { dialog_id: dialog.id, type: dialog.type, message: dialog.message },
          },
        );
      }
    }
  }

  /**
   * Settles with `work`, or as soon as a dialog is left open on this tab: `work` may
   * then not finish until someone answers it, so it is left to run on its own.
   */
  private async untilDialog<T>(
    tab: TabSession,
    work: Promise<T>,
  ): Promise<{ dialog: false; value: T } | { dialog: true }> {
    let watcher: { targetId: string; fire: () => void } | undefined;
    const opened = new Promise<{ dialog: true }>((resolve) => {
      watcher = { targetId: tab.targetId, fire: () => resolve({ dialog: true }) };
      this.dialogWatchers.add(watcher);
      // It may have opened during whatever came just before this.
      for (const dialog of this.openDialogs.values()) {
        if (dialog.targetId === tab.targetId) watcher.fire();
      }
    });
    work.catch(() => {});
    try {
      return await Promise.race([
        work.then((value) => ({ dialog: false as const, value })),
        opened,
      ]);
    } finally {
      this.dialogWatchers.delete(watcher!);
    }
  }

  /** An operation on a tab's page. Refuses, or stops waiting, when a dialog is in the way. */
  private async pageOp<T>(tab: TabSession, work: () => Promise<T>): Promise<T> {
    this.assertNoDialog(tab);
    const outcome = await this.untilDialog(tab, work());
    if (outcome.dialog) {
      this.assertNoDialog(tab);
      throw new MultizenError("DIALOG_OPEN", "A dialog opened on this tab.");
    }
    return outcome.value;
  }

  // ── Downloads ───────────────────────────────────────────────────────────────

  /** `allowAndName`: the browser writes `<dir>/<guid>`, and the sink learns the real name. */
  async enableDownloads(dir: string, sink: DownloadEventSink): Promise<void> {
    this.downloadSink = sink;
    await this.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: dir,
      eventsEnabled: true,
    });
  }

  // ── Page verbs ──────────────────────────────────────────────────────────────

  async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    const tab = this.activeTab();
    const client = this.require();
    const timeoutMs = opts.timeoutMs ?? 30000;
    return this.pageOp(tab, async () => {
      const loaded = onceEvent(client, "Page.loadEventFired", tab.sessionId);
      try {
        const nav = await this.send<{ loaderId?: string; errorText?: string }>(
          "Page.navigate",
          { url },
          tab.sessionId,
          timeoutMs,
        );
        if (nav.errorText) {
          throw new MultizenError(
            "NAVIGATION_FAILED",
            `Navigation to ${url} failed: ${nav.errorText}`,
            {
              details: { error_text: nav.errorText },
              // What a URL that serves a file reports, having started a download.
              ...(nav.errorText === "net::ERR_ABORTED"
                ? { hint: "If this URL serves a file, list_downloads shows it." }
                : {}),
            },
          );
        }
        // No loader: the same document, so no load event is coming.
        if (nav.loaderId) {
          await withTimeout(
            loaded.promise,
            timeoutMs,
            `Navigation to ${url} timed out after ${timeoutMs}ms`,
          );
        }
      } finally {
        loaded.cancel();
      }
      const result = await this.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify({ url: location.href, title: document.title })",
          returnByValue: true,
        },
        tab.sessionId,
      );
      return JSON.parse(result.result.value) as { url: string; title: string };
    });
  }

  /**
   * Click an element by CSS selector.
   *
   * The selector must be precise — we do NOT resolve natural-language
   * descriptions. If you're driving via MCP from Cursor / Claude
   * Desktop, the LLM should produce a selector from the snapshot
   * returned by `extract`.
   */
  async click(selector: string): Promise<{ ok: true }> {
    const tab = this.activeTab();
    await this.raiseActive();
    const v = await this.pageOp(tab, async () => {
      const result = await this.send<{
        result: { value: { ok: boolean; x?: number; y?: number } };
      }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { ok: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
      })()`,
          returnByValue: true,
        },
        tab.sessionId,
      );
      return result.result.value;
    });
    if (!v.ok) {
      throw new MultizenError("ELEMENT_NOT_FOUND", `Element not found for selector: ${selector}`);
    }
    const frames = [await this.mainFrame(tab)];
    await this.clickVerified(tab, frames, v.x ?? 0, v.y ?? 0, `Click on ${selector}`);
    return { ok: true };
  }

  private async mainFrame(tab: TabSession): Promise<FrameAddress> {
    const { frameTree } = await this.send<{ frameTree: FrameTreeNode }>(
      "Page.getFrameTree",
      undefined,
      tab.sessionId,
    );
    return { sessionId: tab.sessionId, frameId: frameTree.frame.id };
  }

  /**
   * Arm the input probe in each of these frames and return where it lives.
   *
   * Chromium answers Input.dispatch* with success even when the renderer drops
   * the event. A page that has been hidden since it loaded (a background tab
   * that was never shown, for one) has not painted, and Chromium drops every
   * press and key sent to it. The CDP result alone cannot tell, so the input
   * methods read the probe after dispatching. See
   * docs/input-delivery-hidden-page.md.
   *
   * It listens in the frame's own isolated world, on that frame's session: a capture
   * listener on the main frame's window sees nothing of what goes to a child frame,
   * same-process or not.
   */
  private async armInputProbe(frames: readonly FrameAddress[]): Promise<ArmedProbe[]> {
    const probes: ArmedProbe[] = [];
    for (const { sessionId, frameId } of frames) {
      const { executionContextId } = await this.send<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        { frameId, worldName: INPUT_PROBE_WORLD },
        sessionId,
      );
      await this.send(
        "Runtime.evaluate",
        { expression: INPUT_PROBE_INSTALL, contextId: executionContextId },
        sessionId,
      );
      probes.push({ sessionId, contextId: executionContextId });
    }
    return probes;
  }

  /**
   * Read the probes until `done` holds or the grace period ends. Returns null
   * when a document was replaced since its probe was armed: the input caused a
   * navigation, so it was delivered. Visibility comes from the first frame.
   */
  private async readInputProbe(
    probes: readonly ArmedProbe[],
    done: (s: InputProbeState) => boolean,
  ): Promise<InputProbeState | null> {
    const deadline = Date.now() + INPUT_PROBE_GRACE_MS;
    for (;;) {
      const states: InputProbeState[] = [];
      for (const { sessionId, contextId } of probes) {
        try {
          const r = await this.send<{ result: { value: string } }>(
            "Runtime.evaluate",
            { expression: INPUT_PROBE_READ, contextId, returnByValue: true },
            sessionId,
          );
          states.push(JSON.parse(r.result.value) as InputProbeState);
        } catch (e) {
          if (PROBE_CONTEXT_GONE.test((e as Error).message)) return null;
          throw e;
        }
      }
      const merged = states.reduce((all, st) => ({
        ...all,
        pressed: all.pressed || st.pressed,
        released: all.released || st.released,
        keys: all.keys + st.keys,
      }));
      if (done(merged) || Date.now() >= deadline) return merged;
      await delay(50);
    }
  }

  private async stopInputProbe(probes: readonly ArmedProbe[]): Promise<void> {
    await Promise.all(
      probes.map(({ sessionId, contextId }) =>
        this.send("Runtime.evaluate", { expression: INPUT_PROBE_STOP, contextId }, sessionId).catch(
          () => {
            // Context gone with the old document, or the session dropped. Runs in a
            // finally, so it must not replace the error that got us here.
          },
        ),
      ),
    );
  }

  /** Click at (x, y) and throw unless the page saw both the press and the release.
   *  A dialog the click left open counts as delivered: it blocks the very page that
   *  would have to confirm, and only a click could have opened it. */
  private async clickVerified(
    tab: TabSession,
    frames: readonly FrameAddress[],
    x: number,
    y: number,
    what: string,
  ): Promise<void> {
    this.assertNoDialog(tab);
    const probes = await this.armInputProbe(frames);
    let blocked = false;
    try {
      const outcome = await this.untilDialog(
        tab,
        (async () => {
          await this.dispatchMouseClick(tab.sessionId, x, y);
          const st = await this.readInputProbe(probes, (s) => s.pressed && s.released);
          if (st && !(st.pressed && st.released)) {
            throw new InputNotDeliveredError(
              `${what} was not delivered: Chromium accepted the click but the page received ` +
                (st.pressed ? "the press and no release." : "no pointer events.") +
                inputLostHint(st),
            );
          }
        })(),
      );
      blocked = outcome.dialog;
    } finally {
      const stopping = this.stopInputProbe(probes);
      if (!blocked) await stopping;
    }
  }

  /** Type into the focused element and throw unless the page saw a keydown
   *  for every character. A dialog opened by the last character counts as delivered;
   *  one opened earlier stops the typing and reports DIALOG_OPEN. */
  private async typeVerified(
    tab: TabSession,
    frames: readonly FrameAddress[],
    text: string,
    what: string,
  ): Promise<void> {
    const expected = [...text].length;
    if (expected === 0) return;
    this.assertNoDialog(tab);
    const probes = await this.armInputProbe(frames);
    const progress = { sent: 0, stopped: false };
    let blocked = false;
    try {
      const outcome = await this.untilDialog(
        tab,
        (async () => {
          await this.typeText(tab.sessionId, text, progress);
          const st = await this.readInputProbe(probes, (s) => s.keys >= expected);
          if (st && st.keys < expected) {
            throw new InputNotDeliveredError(
              (st.keys === 0
                ? `Typing into ${what} was not delivered: Chromium accepted the keys but the page received none of them.`
                : `Typing into ${what} was only partly delivered: the page received ${st.keys} of ${expected} keys, ` +
                  `so the field may hold part of the text.`) + inputLostHint(st),
            );
          }
        })(),
      );
      blocked = outcome.dialog;
      if (blocked) {
        progress.stopped = true;
        if (progress.sent < expected) this.assertNoDialog(tab);
      }
    } finally {
      const stopping = this.stopInputProbe(probes);
      if (!blocked) await stopping;
    }
  }

  private async dispatchMouseClick(sessionId: string, x: number, y: number): Promise<void> {
    // Emit a real pointer sequence: move (no buttons), press (left button bit
    // set, pointer pressure 0.5 like a physical mouse), a short hold, then
    // release (buttons cleared, pressure 0). The old version omitted the
    // `buttons` mask and `force`, so PointerEvent.pressure was 0 and
    // PointerEvent.buttons was 0 during the click — a synthetic-input tell.
    await this.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      },
      sessionId,
    );
    await this.send(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        force: 0.5,
        pointerType: "mouse",
      },
      sessionId,
    );
    await delay(randIn(40, 110));
    await this.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        force: 0,
        pointerType: "mouse",
      },
      sessionId,
    );
  }

  /**
   * Type text into an element selected by CSS selector.
   */
  async type(selector: string, text: string): Promise<{ ok: true }> {
    const tab = this.activeTab();
    await this.raiseActive();
    const focused = await this.pageOp(tab, () =>
      this.send<{ result: { value: boolean } }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`,
          returnByValue: true,
        },
        tab.sessionId,
      ),
    );
    if (!focused.result.value) {
      throw new MultizenError("ELEMENT_NOT_FOUND", `Element not found for selector: ${selector}`);
    }

    await this.typeVerified(tab, [await this.mainFrame(tab)], text, selector);
    return { ok: true };
  }

  private keyEvent(
    sessionId: string,
    type: "keyDown" | "rawKeyDown" | "keyUp",
    d: Pick<KeyDescriptor, "key" | "code" | "keyCode" | "text">,
    modifiers: number,
  ): Promise<unknown> {
    return this.send(
      "Input.dispatchKeyEvent",
      {
        type,
        key: d.key,
        code: d.code,
        windowsVirtualKeyCode: d.keyCode,
        nativeVirtualKeyCode: d.keyCode,
        ...(type !== "keyUp" && d.text ? { text: d.text, unmodifiedText: d.text } : {}),
        modifiers,
      },
      sessionId,
    );
  }

  /** Emit a humanized key sequence into whatever element currently has focus.
   *  Shared by selector-based `type` and ref-based `typeRef`. */
  private async typeText(
    sessionId: string,
    text: string,
    progress: { sent: number; stopped: boolean },
  ): Promise<void> {
    const shiftKey = { key: "Shift", code: "ShiftLeft", keyCode: 16 };
    for (const ch of text) {
      if (progress.stopped) return;
      const d = describeKey(ch);
      const modifiers = d.shift ? CDP_MOD_SHIFT : 0;
      if (d.shift) await this.keyEvent(sessionId, "rawKeyDown", shiftKey, 0);
      // keyDown carries the full descriptor; `text` makes Chromium also emit
      // keypress + input (and insert the character). A pure control key (Tab)
      // has no text.
      progress.sent++;
      await this.keyEvent(sessionId, d.text ? "keyDown" : "rawKeyDown", d, modifiers);
      await delay(randIn(12, 45));
      await this.keyEvent(sessionId, "keyUp", d, modifiers);
      if (d.shift) await this.keyEvent(sessionId, "keyUp", shiftKey, 0);
      await delay(randIn(8, 30));
    }
  }

  /** Modifiers down, the key, modifiers up in reverse. */
  private async dispatchChord(sessionId: string, chord: KeyChord): Promise<void> {
    let held = 0;
    for (const m of chord.modifiers) {
      held |= m.mask;
      await this.keyEvent(sessionId, "rawKeyDown", m, held);
    }
    await this.keyEvent(sessionId, chord.key.text ? "keyDown" : "rawKeyDown", chord.key, chord.mask);
    await delay(randIn(12, 45));
    await this.keyEvent(sessionId, "keyUp", chord.key, chord.mask);
    for (const m of [...chord.modifiers].reverse()) {
      held &= ~m.mask;
      await this.keyEvent(sessionId, "keyUp", m, held);
    }
  }

  // ── Elements ────────────────────────────────────────────────────────────────

  /** The element a ref names, on its tab, which becomes the active one first. */
  private async resolveRef(ref: string): Promise<ResolvedElement> {
    this.require();
    const entry = this.refs.get(ref);
    if (!entry) {
      const n = /^e(\d+)$/.exec(ref);
      if (n && Number(n[1]) >= 1 && Number(n[1]) <= this.refSeq) throw staleRef(ref);
      throw new MultizenError("ELEMENT_NOT_FOUND", `Unknown element ref "${ref}".`, {
        hint: "Call extract and use the refs it gives.",
      });
    }
    const tab = this.tabs.get(entry.targetId);
    if (!tab) throw staleRef(ref);
    this.assertNoDialog(tab);
    if (this.targets.active() !== tab.targetId) await this.activateTab(tab.targetId);
    else await this.raiseActive();
    await this.assertSameDocument(ref, entry, tab);
    return {
      tab,
      sessionId: entry.sessionId,
      frameId: entry.frameId,
      backendNodeId: entry.backendNodeId,
      label: `ref "${ref}"`,
      ref,
    };
  }

  /**
   * The frame still holds the document this ref came from. Events alone can't say:
   * an OOPIF session gets no Page events, and a new renderer process numbers its
   * nodes from the start, so an old backendNodeId could name a new, unrelated element.
   */
  private async assertSameDocument(
    ref: string,
    entry: RefEntry,
    tab: TabSession,
  ): Promise<void> {
    const tree = await this.pageOp(tab, () =>
      this.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree", undefined, entry.sessionId),
    ).catch((e: unknown) => {
      if (NODE_GONE.test((e as Error).message)) return null;
      throw e;
    });
    const frame = tree ? findFrame(tree.frameTree, entry.frameId) : null;
    if (!frame || frame.frame.loaderId !== entry.loaderId) {
      this.forgetRef(ref);
      throw staleRef(ref);
    }
  }

  /** A selector looks up in an isolated world, so the page's own code can't see it. */
  private async resolveSelector(selector: string): Promise<ResolvedElement> {
    const tab = this.activeTab();
    await this.raiseActive();
    return this.pageOp(tab, async () => {
      const frame = await this.mainFrame(tab);
      const { executionContextId } = await this.send<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        { frameId: frame.frameId, worldName: INPUT_PROBE_WORLD },
        tab.sessionId,
      );
      const found = await this.send<{
        result: { objectId?: string };
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        { expression: `document.querySelector(${JSON.stringify(selector)})`, contextId: executionContextId },
        tab.sessionId,
      );
      if (found.exceptionDetails) {
        throw new MultizenError("INVALID_INPUT", `Invalid CSS selector: ${selector}`);
      }
      const objectId = found.result.objectId;
      if (!objectId) {
        throw new MultizenError("ELEMENT_NOT_FOUND", `Element not found for selector: ${selector}`);
      }
      try {
        const { node } = await this.send<{ node: { backendNodeId: number } }>(
          "DOM.describeNode",
          { objectId },
          tab.sessionId,
        );
        return {
          tab,
          ...frame,
          backendNodeId: node.backendNodeId,
          label: `selector ${selector}`,
        };
      } finally {
        await this.send("Runtime.releaseObject", { objectId }, tab.sessionId).catch(() => {});
      }
    });
  }

  private resolveTarget(target: ElementTarget): Promise<ResolvedElement> {
    return "ref" in target ? this.resolveRef(target.ref) : this.resolveSelector(target.selector);
  }

  /** A DOM command on an element, its failures named for the agent. */
  private async domCall<T>(
    el: ResolvedElement,
    method: string,
    params: Record<string, unknown>,
    sessionId: string = el.sessionId,
  ): Promise<T> {
    try {
      return await this.send<T>(method, params, sessionId);
    } catch (e) {
      const message = (e as Error).message;
      if (NODE_GONE.test(message)) {
        if (el.ref) {
          this.forgetRef(el.ref);
          throw staleRef(el.ref);
        }
        throw new MultizenError("ELEMENT_NOT_FOUND", `The element for ${el.label} is gone.`);
      }
      if (NODE_NOT_RENDERED.test(message)) throw notVisible(el);
      throw e;
    }
  }

  /**
   * Where to aim at an element, in root-viewport CSS pixels, scrolled into view. No
   * JS in the page: quads are the browser's own layout. They ignore nothing that
   * scrolled, unlike DOM.getBoxModel.
   */
  private async pointOf(el: ResolvedElement): Promise<{ x: number; y: number }> {
    await this.domCall(el, "DOM.scrollIntoViewIfNeeded", { backendNodeId: el.backendNodeId });
    let point = await this.readPoint(el);
    for (let i = 1; i < POINT_SETTLE_READS; i++) {
      await delay(POINT_SETTLE_MS);
      const next = await this.readPoint(el);
      if (point && next && Math.abs(point.x - next.x) < 0.5 && Math.abs(point.y - next.y) < 0.5) {
        return next;
      }
      point = next;
    }
    if (!point) throw notVisible(el);
    return point;
  }

  private async readPoint(el: ResolvedElement): Promise<{ x: number; y: number } | null> {
    const { quads } = await this.domCall<{ quads: number[][] }>(el, "DOM.getContentQuads", {
      backendNodeId: el.backendNodeId,
    });
    const quad = firstNonEmptyQuad(quads);
    if (!quad) return null;
    const origin = await this.sessionOrigin(el, el.sessionId);
    return {
      x: origin.x + (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: origin.y + (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  /**
   * Where a session's viewport starts in the tab's root viewport. A page session and
   * its same-process frames report quads in the root viewport already. Each OOPIF
   * adds where its owner element's content starts, which its parent's session knows:
   * the quads give the owner's border box, and they follow scrolling, which box-model
   * quads don't. So the box model only supplies how far inside it the content starts.
   */
  private async sessionOrigin(
    el: ResolvedElement,
    sessionId: string,
  ): Promise<{ x: number; y: number }> {
    if (sessionId === el.tab.sessionId) return { x: 0, y: 0 };
    const oopif = el.tab.oopifs.get(sessionId);
    if (!oopif) {
      if (el.ref) this.forgetRef(el.ref);
      throw el.ref ? staleRef(el.ref) : notVisible(el);
    }
    const { backendNodeId } = await this.domCall<{ backendNodeId: number }>(
      el,
      "DOM.getFrameOwner",
      { frameId: oopif.frameId },
      oopif.parentSessionId,
    );
    const { quads } = await this.domCall<{ quads: number[][] }>(
      el,
      "DOM.getContentQuads",
      { backendNodeId },
      oopif.parentSessionId,
    );
    const owner = firstNonEmptyQuad(quads);
    if (!owner) throw notVisible(el);
    const { model } = await this.domCall<{ model: { border: number[]; content: number[] } }>(
      el,
      "DOM.getBoxModel",
      { backendNodeId },
      oopif.parentSessionId,
    );
    const parent = await this.sessionOrigin(el, oopif.parentSessionId);
    return {
      x: parent.x + owner[0]! + model.content[0]! - model.border[0]!,
      y: parent.y + owner[1]! + model.content[1]! - model.border[1]!,
    };
  }

  /** Click the element addressed by a snapshot `ref`. */
  async clickRef(ref: string): Promise<{ ok: true }> {
    const el = await this.resolveRef(ref);
    const { x, y } = await this.pageOp(el.tab, () => this.pointOf(el));
    await this.clickVerified(el.tab, [el], x, y, `Click on ref "${ref}"`);
    return { ok: true };
  }

  /** Focus the element addressed by a snapshot `ref` (via a real click) and type into it.
   *  A lost focusing click throws before any key is sent, so the text never
   *  lands in whatever element had focus. */
  async typeRef(ref: string, text: string): Promise<{ ok: true }> {
    const el = await this.resolveRef(ref);
    const { x, y } = await this.pageOp(el.tab, () => this.pointOf(el));
    await this.clickVerified(el.tab, [el], x, y, `Focusing click on ref "${ref}"`);
    await this.typeVerified(el.tab, [el], text, `ref "${ref}"`);
    return { ok: true };
  }

  /**
   * Press a key or chord. With a target, a click focuses it first. Without one the
   * key goes to whatever has focus, possibly in a child frame, so every frame gets a
   * probe. A chord of Shift alone has nothing the probe counts.
   */
  async pressKey(key: string, target?: ElementTarget): Promise<void> {
    const chord = parseChord(key, this.opts.platform);
    let tab: TabSession;
    let frames: readonly FrameAddress[];
    if (target) {
      const el = await this.resolveTarget(target);
      const { x, y } = await this.pageOp(el.tab, () => this.pointOf(el));
      await this.clickVerified(el.tab, [el], x, y, `Focusing click on ${el.label}`);
      tab = el.tab;
      frames = [el];
    } else {
      tab = this.activeTab();
      await this.raiseActive();
      frames = await this.pageOp(tab, async () => (await this.collectFrames(tab)).frames);
    }
    this.assertNoDialog(tab);
    const probes = await this.armInputProbe(frames);
    let blocked = false;
    try {
      const outcome = await this.untilDialog(
        tab,
        (async () => {
          await this.dispatchChord(tab.sessionId, chord);
          if (chord.countedKeydowns === 0) return;
          const st = await this.readInputProbe(probes, (s) => s.keys >= chord.countedKeydowns);
          if (st && st.keys === 0) {
            throw new InputNotDeliveredError(
              `Pressing ${key} was not delivered: Chromium accepted the key but the page received nothing.` +
                inputLostHint(st),
            );
          }
        })(),
      );
      blocked = outcome.dialog;
    } finally {
      const stopping = this.stopInputProbe(probes);
      if (!blocked) await stopping;
    }
  }

  /** Mouse moves reach even a page dropping presses, so there is nothing to verify. */
  async hover(target: ElementTarget): Promise<void> {
    const el = await this.resolveTarget(target);
    const { x, y } = await this.pageOp(el.tab, () => this.pointOf(el));
    await this.untilDialog(el.tab, this.moveMouse(el.tab.sessionId, x, y));
  }

  private moveMouse(sessionId: string, x: number, y: number): Promise<unknown> {
    return this.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" },
      sessionId,
    );
  }

  /**
   * Wheel over the element or, with none, the middle of the viewport. An element with
   * no deltas is scrolled into view instead. Wheel events aren't delivery-checked: a
   * page need not listen to scroll, and nothing a probe counts comes of them.
   */
  async scroll(opts: { target?: ElementTarget; deltaX?: number; deltaY?: number }): Promise<void> {
    const { target, deltaX, deltaY } = opts;
    let tab: TabSession;
    let point: { x: number; y: number };
    if (target) {
      const el = await this.resolveTarget(target);
      tab = el.tab;
      if (deltaX === undefined && deltaY === undefined) {
        await this.pageOp(tab, () =>
          this.domCall(el, "DOM.scrollIntoViewIfNeeded", { backendNodeId: el.backendNodeId }),
        );
        return;
      }
      point = await this.pageOp(tab, () => this.pointOf(el));
    } else {
      tab = this.activeTab();
      await this.raiseActive();
      const { cssVisualViewport: view } = await this.pageOp(tab, () =>
        this.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(
          "Page.getLayoutMetrics",
          undefined,
          tab.sessionId,
        ),
      );
      point = { x: view.clientWidth / 2, y: view.clientHeight / 2 };
    }
    await this.untilDialog(
      tab,
      (async () => {
        await this.moveMouse(tab.sessionId, point.x, point.y);
        await this.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: point.x,
            y: point.y,
            deltaX: deltaX ?? 0,
            deltaY: deltaY ?? 0,
            pointerType: "mouse",
          },
          tab.sessionId,
        );
      })(),
    );
  }

  /**
   * Sets a <select>'s value directly: its popup is not a target and not in any frame
   * capture, so there's nothing to click. The input and change events are untrusted.
   * Runs in an isolated world, so page code can't see the call, only the events.
   */
  async selectOption(
    target: ElementTarget,
    choice: { value?: string; label?: string; index?: number },
  ): Promise<void> {
    const el = await this.resolveTarget(target);
    const outcome = await this.pageOp(el.tab, async () => {
      const { executionContextId } = await this.send<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        { frameId: el.frameId, worldName: INPUT_PROBE_WORLD },
        el.sessionId,
      );
      const { object } = await this.domCall<{ object: { objectId?: string } }>(
        el,
        "DOM.resolveNode",
        { backendNodeId: el.backendNodeId, executionContextId },
      );
      if (!object.objectId) throw notVisible(el);
      try {
        const r = await this.send<{ result: { value?: string } }>(
          "Runtime.callFunctionOn",
          {
            objectId: object.objectId,
            functionDeclaration: SELECT_OPTION_FUNCTION,
            arguments: [{ value: choice }],
            returnByValue: true,
          },
          el.sessionId,
        );
        return r.result.value;
      } finally {
        await this.send("Runtime.releaseObject", { objectId: object.objectId }, el.sessionId).catch(
          () => {},
        );
      }
    });
    if (outcome === "not-select") {
      throw new MultizenError("INVALID_INPUT", `${el.label} is not a <select> element`);
    }
    if (outcome === "no-option") {
      throw new MultizenError(
        "ELEMENT_NOT_FOUND",
        `${el.label} has no option matching ${JSON.stringify(choice)}`,
      );
    }
  }

  /** Files for a file input, or for the chooser an element opens when clicked. */
  async uploadFile(target: ElementTarget, paths: readonly string[]): Promise<void> {
    const el = await this.resolveTarget(target);
    const { node } = await this.pageOp(el.tab, () =>
      this.domCall<{ node: { nodeName?: string; attributes?: string[] } }>(el, "DOM.describeNode", {
        backendNodeId: el.backendNodeId,
      }),
    );
    if (isFileInput(node)) {
      await this.pageOp(el.tab, () =>
        this.domCall(el, "DOM.setFileInputFiles", {
          files: [...paths],
          backendNodeId: el.backendNodeId,
        }),
      );
      return;
    }
    // The chooser event needs Page enabled on the session of the frame that opened it,
    // which an OOPIF session never gets. Clicking anyway could open a real file dialog.
    if (el.sessionId !== el.tab.sessionId) {
      throw new MultizenError(
        "INVALID_INPUT",
        `${el.label} is in a cross-origin iframe and is not a file input, so its file chooser can't be caught.`,
        { hint: "Target the <input type=file> itself." },
      );
    }
    const client = this.require();
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true }, el.sessionId);
    const opened = onceEvent<{ backendNodeId?: number }>(
      client,
      "Page.fileChooserOpened",
      el.sessionId,
    );
    try {
      const { x, y } = await this.pageOp(el.tab, () => this.pointOf(el));
      await this.clickVerified(el.tab, [el], x, y, `Click on ${el.label}`);
      const chooser = await withTimeout(
        opened.promise,
        FILE_CHOOSER_TIMEOUT_MS,
        `${el.label} did not open a file chooser within ${FILE_CHOOSER_TIMEOUT_MS}ms`,
      );
      await this.send(
        "DOM.setFileInputFiles",
        { files: [...paths], backendNodeId: chooser.backendNodeId },
        el.sessionId,
      );
    } finally {
      opened.cancel();
      await this.send("Page.setInterceptFileChooserDialog", { enabled: false }, el.sessionId).catch(
        () => {},
      );
    }
  }

  async bringToFront(): Promise<void> {
    const tab = this.activeTab();
    await this.send("Page.bringToFront", undefined, tab.sessionId);
  }

  /**
   * Snapshot the page: URL, title, accessibility tree, text fallback.
   * The calling LLM is expected to parse this into whatever structured
   * shape it needs. MultiZen does not call any external API here.
   */
  async extract(): Promise<{ result: ExtractContext }> {
    const snapshot = await this.snapshot();
    return { result: snapshot };
  }

  async screenshot(): Promise<{ pngBase64: string }> {
    const tab = this.activeTab();
    const { data } = await this.pageOp(tab, () =>
      this.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, tab.sessionId),
    );
    return { pngBase64: data };
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const tab = this.activeTab();
    const result = await this.pageOp(tab, () =>
      this.send<{ result: { value: T } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        tab.sessionId,
      ),
    );
    return result.result.value;
  }

  /** evaluate_js: on a session the agent named, or on the active tab. */
  async evaluateJs(expression: string, sessionId?: string): Promise<unknown> {
    const tab = sessionId ? this.sessionTabs.get(sessionId) : this.activeTab();
    const run = (): Promise<unknown> =>
      this.cdpSend("Runtime.evaluate", { expression, returnByValue: true }, sessionId, {
        safe: true,
      });
    return tab ? this.pageOp(tab, run) : run();
  }

  /** Every frame of a tab in depth order, up to the snapshot limits. */
  private async collectFrames(
    tab: TabSession,
  ): Promise<{ frames: SnapshotFrame[]; skipped: number }> {
    const roots: Array<Pick<SnapshotFrame, "sessionId" | "depth" | "ownerSessionId">> = [
      { sessionId: tab.sessionId, depth: 0 },
    ];
    const depthOf = (sessionId: string): number => {
      const parent = tab.oopifs.get(sessionId)?.parentSessionId;
      return parent ? depthOf(parent) + 1 : 0;
    };
    for (const [sessionId, oopif] of tab.oopifs) {
      roots.push({
        sessionId,
        depth: depthOf(sessionId),
        ownerSessionId: oopif.parentSessionId,
      });
    }

    const all: SnapshotFrame[] = [];
    let skipped = 0;
    for (const root of roots) {
      const tree = await this.send<{ frameTree: FrameTreeNode }>(
        "Page.getFrameTree",
        undefined,
        root.sessionId,
        root.sessionId === tab.sessionId ? undefined : SNAPSHOT_FRAME_TIMEOUT_MS,
      ).catch((e: unknown) => {
        // The tab itself not answering fails the snapshot; one of its frames doesn't.
        if (root.sessionId === tab.sessionId) throw e;
        return null;
      });
      if (!tree) {
        skipped++;
        continue;
      }
      const add = (node: FrameTreeNode, depth: number, ownerSessionId?: string): void => {
        all.push({
          sessionId: root.sessionId,
          frameId: node.frame.id,
          ...(node.frame.loaderId !== undefined ? { loaderId: node.frame.loaderId } : {}),
          depth,
          ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
        });
        for (const child of node.childFrames ?? []) add(child, depth + 1, root.sessionId);
      };
      add(tree.frameTree, root.depth, root.ownerSessionId);
    }

    const inDepthOrder = [...all].sort((a, b) => a.depth - b.depth);
    const frames = inDepthOrder
      .filter((f) => f.depth <= MAX_SNAPSHOT_FRAME_DEPTH)
      .slice(0, MAX_SNAPSHOT_FRAMES);
    return { frames, skipped: skipped + all.length - frames.length };
  }

  /** Enable Accessibility only for the duration of this work, and only on the page
   *  session: keeping it enabled globally is a stealth-build DCHECK trigger, and an
   *  iframe session answers getFullAXTree without it. */
  private async withAccessibility<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const users = this.axUsers.get(sessionId) ?? 0;
    this.axUsers.set(sessionId, users + 1);
    try {
      if (users === 0) await this.send("Accessibility.enable", undefined, sessionId);
      return await work();
    } finally {
      const left = (this.axUsers.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        this.axUsers.set(sessionId, left);
      } else {
        this.axUsers.delete(sessionId);
        await this.send("Accessibility.disable", undefined, sessionId).catch(() => {});
      }
    }
  }

  async snapshot(): Promise<ExtractContext> {
    const tab = this.activeTab();
    return this.pageOp(tab, async () => {
      const meta = await this.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify({ url: location.href, title: document.title })",
          returnByValue: true,
        },
        tab.sessionId,
      );
      const { url, title } = JSON.parse(meta.result.value) as { url: string; title: string };

      const { frames, skipped } = await this.collectFrames(tab);
      let framesSkipped = skipped;
      const axTrees = new Map<string, RawAxNode[]>();
      /** `${sessionId}:${owner's backendNodeId}` → the frame inside that element. */
      const framesByOwner = new Map<string, SnapshotFrame>();
      await this.withAccessibility(tab.sessionId, async () => {
        for (const frame of frames) {
          try {
            const { nodes } = await this.send<{ nodes: RawAxNode[] }>(
              "Accessibility.getFullAXTree",
              { frameId: frame.frameId },
              frame.sessionId,
              frame.ownerSessionId === undefined ? undefined : SNAPSHOT_FRAME_TIMEOUT_MS,
            );
            axTrees.set(frame.frameId, nodes);
            if (frame.ownerSessionId !== undefined) {
              const owner = await this.send<{ backendNodeId: number }>(
                "DOM.getFrameOwner",
                { frameId: frame.frameId },
                frame.ownerSessionId,
                SNAPSHOT_FRAME_TIMEOUT_MS,
              );
              framesByOwner.set(`${frame.ownerSessionId}:${owner.backendNodeId}`, frame);
            }
          } catch (e) {
            // A page that won't answer is an error. A frame of it is just left out.
            if (frame.ownerSessionId === undefined) throw e;
            if (!axTrees.has(frame.frameId)) framesSkipped++;
          }
        }
      });

      // The tree stops at an iframe's owner element: each frame's tree goes under it.
      // One budget for all of them, spent from the top of the page down.
      const budget = { emitted: 0 };
      const emitted = new Set<string>();
      const emitFrame = (frame: SnapshotFrame): AccessibilityNode[] => {
        emitted.add(frame.frameId);
        return trimAccessibilityTree(axTrees.get(frame.frameId) ?? [], {
          budget,
          framesInside: (backendNodeId) => {
            const child = framesByOwner.get(`${frame.sessionId}:${backendNodeId}`);
            return child && !emitted.has(child.frameId) ? emitFrame(child) : [];
          },
          refFor: (backendNodeId) => this.refFor(tab, frame, backendNodeId),
        });
      };
      const accessibilityTree = frames[0] ? emitFrame(frames[0]) : [];
      // No owner to hang it under (hidden from the tree, say): keep it, at the end.
      for (const frame of frames) {
        if (!emitted.has(frame.frameId)) accessibilityTree.push(...emitFrame(frame));
      }

      let textContent: string | undefined;
      if (accessibilityTree.length === 0) {
        const text = await this.send<{ result: { value?: string } }>(
          "Runtime.evaluate",
          {
            expression: "document.body && document.body.innerText.slice(0, 8000)",
            returnByValue: true,
          },
          tab.sessionId,
        );
        textContent = text.result.value ?? undefined;
      }

      return {
        url,
        title,
        accessibilityTree,
        textContent,
        ...(framesSkipped > 0 ? { framesSkipped } : {}),
      };
    });
  }

  /** The node's ref: the one it already has while its document lives, else a new one. */
  private refFor(tab: TabSession, frame: SnapshotFrame, backendNodeId: number): string {
    const key = `${frame.sessionId}:${backendNodeId}`;
    const known = this.refByNode.get(key);
    if (known) {
      const entry = this.refs.get(known);
      if (entry?.frameId === frame.frameId && entry.loaderId === frame.loaderId) return known;
      this.forgetRef(known);
    }
    const ref = `e${++this.refSeq}`;
    this.refs.set(ref, {
      targetId: tab.targetId,
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      backendNodeId,
      ...(frame.loaderId !== undefined ? { loaderId: frame.loaderId } : {}),
    });
    this.refByNode.set(key, ref);
    while (this.refs.size > MAX_LIVE_REFS) {
      const oldest = this.refs.keys().next().value;
      if (oldest === undefined) break;
      this.forgetRef(oldest);
    }
    return ref;
  }

  private forgetRef(ref: string): void {
    const entry = this.refs.get(ref);
    if (!entry) return;
    this.refs.delete(ref);
    this.refByNode.delete(`${entry.sessionId}:${entry.backendNodeId}`);
  }

  private invalidateRefs(matches: (entry: RefEntry) => boolean): void {
    for (const [ref, entry] of this.refs) {
      if (matches(entry)) this.forgetRef(ref);
    }
  }
}

function notVisible(el: ResolvedElement): MultizenError {
  return new MultizenError(
    "ELEMENT_NOT_VISIBLE",
    `The element for ${el.label} has no box on the page: it is hidden or not rendered.`,
  );
}

/** A real tab: a prerender, say, is a page too, but nothing a person or agent uses. */
function isTabTarget(info: TargetInfo): boolean {
  return info.type === "page" && !info.subtype;
}

function isFileInput(node: { nodeName?: string; attributes?: string[] }): boolean {
  if (node.nodeName?.toUpperCase() !== "INPUT") return false;
  const attributes = node.attributes ?? [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i]?.toLowerCase() === "type") return attributes[i + 1]?.toLowerCase() === "file";
  }
  return false;
}

function findFrame(node: FrameTreeNode, frameId: string): FrameTreeNode | null {
  if (node.frame.id === frameId) return node;
  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, frameId);
    if (found) return found;
  }
  return null;
}

/** The first quad covering more than a sliver. Inline elements can have several. */
function firstNonEmptyQuad(quads: readonly number[][] | undefined): number[] | null {
  for (const quad of quads ?? []) {
    if (quad.length < 8) continue;
    let doubledArea = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      doubledArea += quad[2 * i]! * quad[2 * j + 1]! - quad[2 * j]! * quad[2 * i + 1]!;
    }
    if (Math.abs(doubledArea) / 2 > 0.99) return quad;
  }
  return null;
}

interface RawAxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
}

interface TrimContext {
  /** Shared across a page's frames, so all of them together stay under the cap. */
  budget: { emitted: number };
  /** The trimmed tree of a frame whose owner element is this node, if there is one. */
  framesInside: (backendNodeId: number) => AccessibilityNode[];
  refFor: (backendNodeId: number) => string;
}

function trimAccessibilityTree(rawNodes: RawAxNode[], ctx: TrimContext): AccessibilityNode[] {
  const byId = new Map<string, RawAxNode>();
  for (const node of rawNodes) byId.set(node.nodeId, node);

  // Roots = nodes with no parent in the returned set. Include ignored roots:
  // Chrome routinely makes RootWebArea's only child an `ignored` role="none"
  // wrapper (the <body>), with the entire page hanging below it.
  const childIds = new Set<string>();
  for (const node of rawNodes) {
    for (const c of node.childIds ?? []) childIds.add(c);
  }
  const roots = rawNodes.filter((n) => !childIds.has(n.nodeId));

  // Chrome's real AX output is a strict tree, so neither guard below fires in
  // practice — they harden `extract` against a future malformed/cyclic CDP
  // source (a node reachable via two parents would recurse forever) and cap the
  // payload on pathologically large pages so a single call can't return
  // megabytes of tree.
  const visited = new Set<string>();
  const MAX_EMITTED_NODES = 5000;

  // Returns a LIST so structural noise is spliced out rather than pruned: an
  // `ignored` node (that <body> wrapper) or a generic/presentational container
  // is dropped, but its meaningful descendants are hoisted to its parent. The
  // previous version returned null for `ignored` nodes, which discarded the
  // whole subtree — so a single ignored ancestor silently dropped ALL page text
  // (e.g. extract returned only RootWebArea for pages whose <body> is ignored).
  function walk(node: RawAxNode, depth: number): AccessibilityNode[] {
    if (depth > 40) return []; // guard against pathological nesting only
    if (ctx.budget.emitted >= MAX_EMITTED_NODES) return []; // payload cap on huge pages
    if (visited.has(node.nodeId)) return []; // cycle guard (strict tree ⇒ never in practice)
    visited.add(node.nodeId);

    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is RawAxNode => Boolean(n))
      .flatMap((n) => walk(n, depth + 1));
    const backendNodeId = node.backendDOMNodeId;
    const frameContent = backendNodeId !== undefined ? ctx.framesInside(backendNodeId) : [];
    children.push(...frameContent);

    if (node.ignored) return children; // splice out ignored wrapper, keep its content

    const role = node.role?.value ?? "generic";
    const name = node.name?.value;
    const value = node.value?.value;
    const description = node.description?.value;

    const isInteresting =
      frameContent.length > 0 ||
      (role !== "generic" &&
        role !== "presentation" &&
        role !== "none" &&
        role !== "InlineTextBox" &&
        (name ||
          value ||
          description ||
          ["link", "button", "textbox", "checkbox", "combobox", "option"].includes(role)));

    if (!isInteresting) return children; // drop the generic wrapper, hoist its content

    ctx.budget.emitted += 1;
    return [
      {
        nodeId: node.nodeId,
        role,
        name,
        value,
        description,
        backendNodeId,
        // Every node backed by a real DOM node gets a ref, so clickRef/typeRef can act on it.
        ...(backendNodeId !== undefined ? { ref: ctx.refFor(backendNodeId) } : {}),
        children: children.length > 0 ? children : undefined,
      },
    ];
  }

  return roots.flatMap((r) => walk(r, 0));
}

function sendTo<T = unknown>(
  client: CDP.Client,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  timeoutMs: number = DEFAULT_CDP_TIMEOUT_MS,
): Promise<T> {
  return withTimeout(
    buildSender(client, sessionId)<T>(method, params),
    timeoutMs,
    `CDP ${method} timed out after ${timeoutMs}ms`,
  );
}

function resumeTarget(client: CDP.Client, sessionId: string): Promise<unknown> {
  return sendTo(client, "Runtime.runIfWaitingForDebugger", undefined, sessionId).catch(() => {
    // Already detached.
  });
}

/** The next event of a kind on a session. `cancel` when no longer interested. */
function onceEvent<T = unknown>(
  client: CDP.Client,
  method: string,
  sessionId: string,
): { promise: Promise<T>; cancel: () => void } {
  const emitter = client as unknown as EventEmitter;
  const name = `${method}.${sessionId}`;
  let listener: (params: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    listener = resolve;
    emitter.once(name, listener);
  });
  return { promise, cancel: () => emitter.removeListener(name, listener) };
}

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A random integer in [min, max]. Used to vary key-hold / inter-key timing so
 *  synthetic input does not land on a single constant interval. */
function randIn(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new MultizenError("TIMEOUT", message)), ms);
    // A bound on the work, not work itself: it must not keep a finished process alive.
    t.unref?.();
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
