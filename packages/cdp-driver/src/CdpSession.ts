import CDP from "chrome-remote-interface";
import type { AccessibilityNode, ExtractContext } from "./types.js";

export interface CdpSessionOptions {
  /** Port the Chromium instance is listening on */
  port: number;
  /** Optional host override, defaults to localhost */
  host?: string;
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
 */
export class CdpSession {
  private client: CDP.Client | null = null;
  private readonly opts: CdpSessionOptions;

  constructor(opts: CdpSessionOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const host = this.opts.host ?? "localhost";
    this.client = await CDP({ host, port: this.opts.port });
    const { Page, DOM, Runtime, Accessibility, Network } = this.client;
    await Promise.all([
      Page.enable(),
      DOM.enable(),
      Runtime.enable(),
      Accessibility.enable(),
      Network.enable(),
    ]);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
  }

  private require(): CDP.Client {
    if (!this.client) throw new Error("CDP session not connected. Call connect() first.");
    return this.client;
  }

  async navigate(url: string, opts: { timeoutMs?: number } = {}): Promise<{ url: string; title: string }> {
    const client = this.require();
    const { Page } = client;
    const timeoutMs = opts.timeoutMs ?? 30000;

    const navigated = Page.loadEventFired();
    await Page.navigate({ url });
    await withTimeout(navigated, timeoutMs, `Navigation to ${url} timed out after ${timeoutMs}ms`);

    const result = await client.Runtime.evaluate({
      expression: "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const value = result.result.value as string;
    return JSON.parse(value) as { url: string; title: string };
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
    const client = this.require();
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false };
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { ok: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
      })()`,
      returnByValue: true,
    });
    const v = result.result.value as { ok: boolean; x?: number; y?: number };
    if (!v.ok) throw new Error(`Element not found for selector: ${selector}`);
    await this.dispatchMouseClick(v.x ?? 0, v.y ?? 0);
    return { ok: true };
  }

  private async dispatchMouseClick(x: number, y: number): Promise<void> {
    const client = this.require();
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /**
   * Type text into an element selected by CSS selector.
   */
  async type(selector: string, text: string): Promise<{ ok: true }> {
    const client = this.require();

    const focused = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!focused.result.value) {
      throw new Error(`Element not found for selector: ${selector}`);
    }

    for (const ch of text) {
      await client.Input.dispatchKeyEvent({ type: "keyDown", text: ch });
      await client.Input.dispatchKeyEvent({ type: "keyUp" });
    }
    return { ok: true };
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
    const client = this.require();
    const { data } = await client.Page.captureScreenshot({ format: "png" });
    return { pngBase64: data };
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const client = this.require();
    const result = await client.Runtime.evaluate({ expression, returnByValue: true });
    return result.result.value as T;
  }

  async snapshot(): Promise<ExtractContext> {
    const client = this.require();
    const { Accessibility, Runtime } = client;

    const meta = await Runtime.evaluate({
      expression: "JSON.stringify({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const { url, title } = JSON.parse(meta.result.value as string) as { url: string; title: string };

    const fullTree = await Accessibility.getFullAXTree();
    const accessibilityTree = trimAccessibilityTree(fullTree.nodes as unknown as RawAxNode[]);

    let textContent: string | undefined;
    if (accessibilityTree.length === 0) {
      const text = await Runtime.evaluate({
        expression: "document.body && document.body.innerText.slice(0, 8000)",
        returnByValue: true,
      });
      textContent = (text.result.value as string) ?? undefined;
    }

    return { url, title, accessibilityTree, textContent };
  }
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

function trimAccessibilityTree(rawNodes: RawAxNode[]): AccessibilityNode[] {
  const byId = new Map<string, RawAxNode>();
  for (const node of rawNodes) byId.set(node.nodeId, node);

  const childIds = new Set<string>();
  for (const node of rawNodes) {
    for (const c of node.childIds ?? []) childIds.add(c);
  }
  const roots = rawNodes.filter((n) => !childIds.has(n.nodeId) && !n.ignored);

  function walk(node: RawAxNode, depth: number): AccessibilityNode | null {
    if (node.ignored) return null;
    if (depth > 12) return null;

    const role = node.role?.value ?? "generic";
    const name = node.name?.value;
    const value = node.value?.value;
    const description = node.description?.value;

    const isInteresting =
      role !== "generic" &&
      role !== "presentation" &&
      role !== "none" &&
      role !== "InlineTextBox" &&
      (name || value || description || ["link", "button", "textbox", "checkbox", "combobox", "option"].includes(role));

    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((n): n is RawAxNode => Boolean(n))
      .map((n) => walk(n, depth + 1))
      .filter((n): n is AccessibilityNode => Boolean(n));

    if (!isInteresting && children.length === 0) return null;

    return {
      nodeId: node.nodeId,
      role,
      name,
      value,
      description,
      backendNodeId: node.backendDOMNodeId,
      children: children.length > 0 ? children : undefined,
    };
  }

  return roots.map((r) => walk(r, 0)).filter((n): n is AccessibilityNode => Boolean(n));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
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
