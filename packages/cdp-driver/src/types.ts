/**
 * Accessibility tree node we pass to LLMs for natural-language target
 * resolution. Trimmed to keep token usage manageable.
 */
export interface AccessibilityNode {
  nodeId: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  /** Backend node id for CDP DOM operations */
  backendNodeId?: number;
}

export interface ExtractContext {
  url: string;
  title: string;
  /** Trimmed accessibility tree, max ~6000 tokens */
  accessibilityTree: AccessibilityNode[];
  /** Raw text content fallback if AX tree is too sparse */
  textContent?: string;
}

/**
 * Implemented by callers that want LLM-powered natural-language target
 * lookups. The CDP driver does not embed any LLM client itself —
 * BYOK is up to the caller (desktop app or MCP server).
 */
export interface NaturalLanguageResolver {
  /**
   * Given a page snapshot and a natural-language description of an
   * element, return the best-matching backendNodeId (or null).
   */
  resolveClickTarget(snapshot: ExtractContext, description: string): Promise<number | null>;
  /**
   * Given a page snapshot and a natural-language extraction query,
   * return structured data.
   */
  extract(snapshot: ExtractContext, query: string): Promise<unknown>;
}
