import type { BrowserDriver } from "./server.js";
import type {
  CapturedFrame,
  DialogPolicy,
  DialogResponse,
  DownloadFile,
  DownloadRecord,
  DriverAction,
  HumanInputEvent,
  LaunchedProfile,
  OpenDialog,
  ProfileId,
  RunningInfo,
} from "@multizen/types";

/** A 1x1 JPEG, so a frame consumer has real bytes to decode. */
const MOCK_FRAME_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/**
 * In-memory browser driver for development. Returns plausible mock data
 * so MCP clients can be tested end-to-end before the real Chromium driver
 * is hooked up.
 */
export class MockBrowserDriver implements BrowserDriver {
  private readonly running = new Map<
    ProfileId,
    { url: string; pid: number; port: number; startedAt: string }
  >();
  private port = 9222;
  /** What reached the driver, in order, so a client can check it end to end. */
  readonly actions: Array<{ profileId: ProfileId; action: DriverAction }> = [];
  readonly humanInput: Array<{ profileId: ProfileId; event: HumanInputEvent }> = [];
  readonly dialogPolicies = new Map<ProfileId, DialogPolicy>();
  /** Filled by whoever is exercising the tools: nothing downloads in a mock. */
  readonly downloads = new Map<ProfileId, DownloadFile[]>();
  /** Filled by whoever is exercising the tools: nothing opens a dialog in a mock. */
  readonly openDialogs = new Map<ProfileId, OpenDialog[]>();

  async launch(profileId: ProfileId): Promise<LaunchedProfile> {
    const existing = this.running.get(profileId);
    if (existing) {
      return {
        id: profileId,
        cdpEndpoint: `ws://localhost:${existing.port}/devtools/browser/mock-${profileId}`,
        pid: existing.pid,
        startedAt: new Date().toISOString(),
      };
    }
    this.port += 1;
    const pid = Math.floor(Math.random() * 100000) + 1000;
    const startedAt = new Date().toISOString();
    this.running.set(profileId, { url: "about:blank", pid, port: this.port, startedAt });
    return {
      id: profileId,
      cdpEndpoint: `ws://localhost:${this.port}/devtools/browser/mock-${profileId}`,
      pid,
      startedAt,
    };
  }

  async close(profileId: ProfileId): Promise<void> {
    this.running.delete(profileId);
  }

  isRunning(profileId: ProfileId): boolean {
    return this.running.has(profileId);
  }

  async navigate(profileId: ProfileId, url: string): Promise<{ url: string }> {
    const r = this.running.get(profileId);
    if (!r) throw new Error("not running");
    r.url = url;
    return { url };
  }

  async click(_profileId: ProfileId, _selector: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  async type(
    _profileId: ProfileId,
    _selector: string,
    _text: string,
  ): Promise<{ ok: true }> {
    return { ok: true };
  }

  async clickRef(_profileId: ProfileId, _ref: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  async typeRef(_profileId: ProfileId, _ref: string, _text: string): Promise<{ ok: true }> {
    return { ok: true };
  }

  async extract(_profileId: ProfileId): Promise<{ result: unknown }> {
    return {
      result: {
        note: "mock extraction — real implementation returns the page accessibility tree",
        url: "about:blank",
        title: "",
      },
    };
  }

  async screenshot(_profileId: ProfileId): Promise<{ pngBase64: string }> {
    return {
      pngBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    };
  }

  async cdpSend(
    profileId: ProfileId,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    opts?: { safe?: boolean },
  ): Promise<unknown> {
    const r = this.running.get(profileId);
    if (!r) throw new Error("not running");
    // Echo the request back so MCP clients can exercise the CDP tool surfaces
    // end-to-end against the mock without a real browser.
    return {
      mock: true,
      method,
      params: params ?? {},
      sessionId: sessionId ?? null,
      safe: opts?.safe ?? true,
    };
  }

  // Engine-neutral curated verbs — echo through the mock cdpSend so MCP clients
  // can exercise them without a real browser.
  async evaluateJs(profileId: ProfileId, expression: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
      { safe: true },
    );
  }

  async getCookies(profileId: ProfileId, urls?: string[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.getCookies", urls ? { urls } : {}, sessionId, {
      safe: true,
    });
  }

  async setCookies(profileId: ProfileId, cookies: unknown[], sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Network.setCookies", { cookies }, sessionId, { safe: true });
  }

  async listTabs(profileId: ProfileId, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.getTargets", {}, sessionId, { safe: true });
  }

  async newTab(profileId: ProfileId, url?: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(
      profileId,
      "Target.createTarget",
      { url: url ?? "about:blank" },
      sessionId,
      { safe: true },
    );
  }

  async activateTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.activateTarget", { targetId }, sessionId, { safe: true });
  }

  async closeTab(profileId: ProfileId, targetId: string, sessionId?: string): Promise<unknown> {
    return this.cdpSend(profileId, "Target.closeTarget", { targetId }, sessionId, { safe: true });
  }

  async performAction(profileId: ProfileId, action: DriverAction): Promise<{ ok: true }> {
    if (!this.running.has(profileId)) throw new Error("not running");
    this.actions.push({ profileId, action });
    return { ok: true };
  }

  async listDownloads(profileId: ProfileId): Promise<DownloadRecord[]> {
    return (this.downloads.get(profileId) ?? []).map(({ path: _path, ...record }) => record);
  }

  async getDownload(profileId: ProfileId, downloadId: string): Promise<DownloadFile | null> {
    return this.downloads.get(profileId)?.find((d) => d.id === downloadId) ?? null;
  }

  async setDialogPolicy(profileId: ProfileId, policy: DialogPolicy): Promise<{ ok: true }> {
    this.dialogPolicies.set(profileId, policy);
    return { ok: true };
  }

  async listDialogs(profileId: ProfileId): Promise<OpenDialog[]> {
    return this.openDialogs.get(profileId) ?? [];
  }

  async handleDialog(profileId: ProfileId, response: DialogResponse): Promise<{ ok: true }> {
    const open = this.openDialogs.get(profileId) ?? [];
    const index = response.dialogId ? open.findIndex((d) => d.id === response.dialogId) : 0;
    if (index < 0 || !open[index]) throw new Error("no such dialog");
    open.splice(index, 1);
    return { ok: true };
  }

  hasOpenDialog(profileId: ProfileId): boolean {
    return (this.openDialogs.get(profileId) ?? []).length > 0;
  }

  async captureFrame(profileId: ProfileId): Promise<CapturedFrame> {
    const r = this.running.get(profileId);
    if (!r) throw new Error("not running");
    return {
      jpeg: MOCK_FRAME_JPEG,
      viewport: { width: 1, height: 1 },
      targetId: `mock-${profileId}`,
      url: r.url,
    };
  }

  async dispatchInput(profileId: ProfileId, event: HumanInputEvent): Promise<void> {
    if (!this.running.has(profileId)) throw new Error("not running");
    this.humanInput.push({ profileId, event });
  }

  runningInfo(profileId: ProfileId): RunningInfo | null {
    const r = this.running.get(profileId);
    return r ? { pid: r.pid, startedAt: r.startedAt } : null;
  }
}
