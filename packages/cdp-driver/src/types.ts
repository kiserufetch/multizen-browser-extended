/**
 * Accessibility tree node returned by `CdpSession.snapshot()`.
 * The MCP `extract` tool returns this as-is; the calling LLM (in Cursor /
 * Claude Desktop / wherever) is responsible for parsing it.
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
  /** Short stable handle (e.g. "e7") for this snapshot; use with click_ref /
   *  type_ref. Present only for nodes backed by a real DOM node. */
  ref?: string;
}

export interface ExtractContext {
  url: string;
  title: string;
  /** Trimmed accessibility tree, max ~6000 tokens */
  accessibilityTree: AccessibilityNode[];
  /** Raw text content fallback if AX tree is too sparse */
  textContent?: string;
}
