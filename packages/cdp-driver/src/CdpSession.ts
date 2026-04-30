import CDP from "chrome-remote-interface";
import type { AccessibilityNode, ExtractContext, NaturalLanguageResolver } from "./types.js";
import { resolveTarget } from "./targetResolver.js";

export interface CdpSessionOptions {
  /** Port the Chromium instance is listening on */
  port: number;
  /** Optional host override, defaults to localhost */
  host?: string;
  /** Optional resolver for natural-language click and extract */
  resolver?: NaturalLanguageResolver;
}

/**
 * Thin wrapper around chrome-remote-interface that exposes the
 * primitives our MCP tools call: navigate, click, type, extract,
 * screenshot. Stays connected per profile so cookies / DOM state
 * survive across calls.
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
    await Promise.all([Page.enable(), DOM.enable(), Runtime.enable(), Accessibility.enable(), Network.enable()]);
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

  async click(target: string): Promise<{ ok: true }> {
    const kind = resolveTarget(target);
    if (kind === "css") {
      await this.clickCss(target);
      return { ok: true };
    }
    return this.clickNatural(target);
  }

  private async clickCss(selector: string): Promise<void> {
    const client = this.require();
    const result = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, reason: "not_found" };
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
        const rect = el.getBoundingClientRect();
        return { ok: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
      })()`,
      returnByValue: true,
    });
    const v = result.result.value as { ok: boolean; reason?: string; x?: number; y?: number };
    if (!v.ok) throw new Error(`Element not found for selector: ${selector}`);
    await this.dispatchMouseClick(v.x ?? 0, v.y ?? 0);
  }

  private async clickNatural(description: string): Promise<{ ok: true }> {
    const resolver = this.opts.resolver;
    if (!resolver) {
      throw new Error(
        `Natural-language click requires a resolver. Configure your Anthropic API key in MultiZen settings, or pass a CSS selector.`,
      );
    }
    const snapshot = await this.snapshot();
    const backendNodeId = await resolver.resolveClickTarget(snapshot, description);
    if (!backendNodeId) {
      throw new Error(`Could not resolve element for description: ${description}`);
    }
    await this.clickByBackendNodeId(backendNodeId);
    return { ok: true };
  }

  private async clickByBackendNodeId(backendNodeId: number): Promise<void> {
    const client = this.require();
    const { DOM } = client;
    const { model } = await DOM.getBoxModel({ backendNodeId });
    const content = model.content as number[];
    if (content.length < 8) {
      throw new Error("Unexpected box model from CDP");
    }
    // CDP returns content as [x1,y1, x2,y2, x3,y3, x4,y4] — top-left to bottom-left
    const x1 = content[0]!;
    const y1 = content[1]!;
    const x3 = content[4]!;
    const y3 = content[5]!;
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    await this.dispatchMouseClick(x, y);
  }

  private async dispatchMouseClick(x: number, y: number): Promise<void> {
    const client = this.require();
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(target: string, text: string): Promise<{ ok: true }> {
    const client = this.require();
    const kind = resolveTarget(target);

    if (kind === "css") {
      // Focus + set value via JS, then dispatch input events for SPA frameworks
      const focused = await client.Runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(target)});
          if (!el) return false;
          el.focus();
          return true;
        })()`,
        returnByValue: true,
      });
      if (!focused.result.value) {
        throw new Error(`Element not found for selector: ${target}`);
      }
    } else if (this.opts.resolver) {
      const snapshot = await this.snapshot();
      const backendNodeId = await this.opts.resolver.resolveClickTarget(snapshot, target);
      if (!backendNodeId) throw new Error(`Could not resolve element: ${target}`);
      await client.DOM.focus({ backendNodeId });
    } else {
      throw new Error(
        `Natural-language type requires a resolver. Configure Anthropic API key in MultiZen settings, or pass a CSS selector.`,
      );
    }

    // Send each character as a key event so input events fire properly
    for (const ch of text) {
      await client.Input.dispatchKeyEvent({ type: "keyDown", text: ch });
      await client.Input.dispatchKeyEvent({ type: "keyUp" });
    }
    return { ok: true };
  }

  async extract(query: string): Promise<{ result: unknown }> {
    const snapshot = await this.snapshot();
    const resolver = this.opts.resolver;
    if (!resolver) {
      // Fall back to raw snapshot — the calling LLM can interpret it
      return {
        result: {
          mode: "raw_snapshot",
          note: "No resolver configured. Returning raw page snapshot for the agent to parse.",
          query,
          snapshot,
        },
      };
    }
    const result = await resolver.extract(snapshot, query);
    return { result };
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

  /**
   * Snapshot the page: URL, title, accessibility tree (trimmed),
   * and text content fallback. Used for both natural-language click
   * resolution and structured extraction.
   */
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

  // Find roots (nodes that aren't a child of anyone)
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

    // Skip noise
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

  return roots
    .map((r) => walk(r, 0))
    .filter((n): n is AccessibilityNode => Boolean(n));
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
