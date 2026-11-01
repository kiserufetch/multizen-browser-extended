import type { DisplayMode, LaunchedProfile, ProfileId } from "./index.js";

/** Under a profile's data dir, next to `engines/`: files agents exchange with its pages. */
export const PROFILE_UPLOADS_DIR = "uploads";
export const PROFILE_DOWNLOADS_DIR = "downloads";
/** Under the uploads dir: files sent as base64, kept until the profile closes. */
export const UPLOAD_INBOX_DIR = ".inbox";

/** An element by the `ref` extract gave it, or by CSS selector. */
export type ElementTarget = { ref: string } | { selector: string };

/** Page actions behind one driver method, which keeps the router and mock small. */
export type DriverAction =
  | { type: "press_key"; key: string; target?: ElementTarget }
  | { type: "hover"; target: ElementTarget }
  | { type: "select_option"; target: ElementTarget; value?: string; label?: string; index?: number }
  | { type: "scroll"; target?: ElementTarget; deltaX?: number; deltaY?: number }
  | { type: "upload_file"; target: ElementTarget; paths: string[] }
  | { type: "bring_to_front" };

export interface DownloadRecord {
  id: string;
  /** Sanitized, for display only: never used to resolve a path. */
  fileName: string;
  url: string;
  state: "in_progress" | "completed" | "canceled";
  bytesReceived: number;
  bytesTotal: number | null;
  startedAt: string;
}

export interface DownloadFile extends DownloadRecord {
  /** Null until complete. A host path: stays on this side of the MCP boundary. */
  path: string | null;
}

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type DialogAction = "accept" | "dismiss";

/** Auto mode's answers: accept what has one outcome, nothing affirmative the agent didn't ask for. */
export const DEFAULT_DIALOG_ANSWERS: Readonly<Record<DialogType, DialogAction>> = {
  alert: "accept",
  beforeunload: "accept",
  confirm: "dismiss",
  prompt: "dismiss",
};

/** `auto` answers each dialog at once; `manual` leaves it open for handleDialog. */
export interface DialogPolicy {
  mode: "auto" | "manual";
  alert?: DialogAction;
  confirm?: DialogAction;
  prompt?: DialogAction;
  beforeunload?: DialogAction;
  promptText?: string;
}

export interface OpenDialog {
  id: string;
  type: DialogType;
  message: string;
  defaultPrompt?: string;
  url?: string;
  openedAt: string;
}

export interface DialogResponse {
  /** Omitted: the oldest open dialog. */
  dialogId?: string;
  action: DialogAction;
  promptText?: string;
}

/** One frame for the handoff panel. */
export interface CapturedFrame {
  jpeg: Uint8Array;
  viewport: { width: number; height: number };
  targetId: string;
  url: string;
}

/** Input from a human in the handoff panel. `x` and `y` are normalized to 0..1. */
export type HumanInputEvent =
  | {
      kind: "mouse";
      action: "move" | "down" | "up";
      x: number;
      y: number;
      button: "left" | "right" | "middle" | "none";
      buttons: number;
      clickCount?: number;
    }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | {
      kind: "key";
      action: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      modifiers: number;
      text?: string;
    }
  | { kind: "text"; text: string };

export interface RunningInfo {
  pid: number;
  startedAt: string;
}

export interface LaunchOptions {
  /** Gives up the wait for a free browser slot. A browser already starting still starts. */
  signal?: AbortSignal;
  /**
   * To the router, what the caller asks for by name, which wins over the saved modes and
   * conflicts with a browser already running in another. To an engine's own driver, the
   * mode the router resolved. Absent there means headed.
   */
  displayMode?: DisplayMode;
}

/**
 * BrowserDriver is the surface that the MCP server delegates real
 * browser work to. The desktop app implements it on top of patched
 * Chromium + CDP. The standalone dev mode implements a mock so the
 * MCP server can be exercised without a browser.
 */
export interface BrowserDriver {
  launch(profileId: ProfileId, opts?: LaunchOptions): Promise<LaunchedProfile>;
  close(profileId: ProfileId): Promise<void>;
  isRunning(profileId: ProfileId): boolean;
  navigate(profileId: ProfileId, url: string): Promise<{ url: string }>;
  click(profileId: ProfileId, selector: string): Promise<{ ok: true }>;
  type(profileId: ProfileId, selector: string, text: string): Promise<{ ok: true }>;
  clickRef(profileId: ProfileId, ref: string): Promise<{ ok: true }>;
  typeRef(profileId: ProfileId, ref: string, text: string): Promise<{ ok: true }>;
  extract(profileId: ProfileId): Promise<{ result: unknown }>;
  screenshot(profileId: ProfileId): Promise<{ pngBase64: string }>;
  /**
   * Send a raw CDP command. `opts.safe` (default true) auto-disables any
   * domain the call had to enable so the stealth baseline is preserved; the
   * convenience CDP tools compose on top of this single primitive.
   */
  cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown>;
  // ── Engine-neutral curated verbs. Chromium implements these via CDP; a
  //    non-CDP engine (Firefox/Camoufox) implements them its own way. The MCP
  //    tool layer calls these instead of composing CDP, so the curated tools
  //    run on every engine. (wait_for_* stay composed on evaluateJs above.)
  evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown>;
  getCookies(profileId: ProfileId, urls?: string[], sessionId?: string): Promise<unknown>;
  setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown>;
  listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown>;
  newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown>;
  activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown>;
  closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown>;
  performAction(profileId: ProfileId, action: DriverAction): Promise<{ ok: true }>;
  listDownloads(profileId: ProfileId): Promise<DownloadRecord[]>;
  /** Null for an id this profile never saw. */
  getDownload(profileId: ProfileId, downloadId: string): Promise<DownloadFile | null>;
  setDialogPolicy(profileId: ProfileId, policy: DialogPolicy): Promise<{ ok: true }>;
  listDialogs(profileId: ProfileId): Promise<OpenDialog[]>;
  handleDialog(profileId: ProfileId, response: DialogResponse): Promise<{ ok: true }>;
  captureFrame(profileId: ProfileId, opts?: { quality?: number }): Promise<CapturedFrame>;
  dispatchInput(profileId: ProfileId, event: HumanInputEvent): Promise<void>;
  hasOpenDialog?(profileId: ProfileId): boolean;
  runningInfo?(profileId: ProfileId): RunningInfo | null;
  /** Null when it isn't running. */
  runningDisplayMode?(profileId: ProfileId): DisplayMode | null;
}
