import type { LaunchedProfile, ProfileId } from "./index.js";

/**
 * BrowserDriver is the surface that the MCP server delegates real
 * browser work to. The desktop app implements it on top of patched
 * Chromium + CDP. The standalone dev mode implements a mock so the
 * MCP server can be exercised without a browser.
 */
export interface BrowserDriver {
  launch(profileId: ProfileId): Promise<LaunchedProfile>;
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
}
