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
  /** Short handle (e.g. "e7") for this element, on any tab or frame; use with
   *  click_ref / type_ref. The same while the element lives, never reused for another.
   *  Present only for nodes backed by a real DOM node. */
  ref?: string;
}

export interface ExtractContext {
  url: string;
  title: string;
  /** Trimmed accessibility tree, max ~6000 tokens. A frame's tree hangs under its
   *  owner element, cross-origin frames included. */
  accessibilityTree: AccessibilityNode[];
  /** Raw text content fallback if AX tree is too sparse */
  textContent?: string;
  /** Frames left out: over the limits, or they would not answer. Absent when none. */
  framesSkipped?: number;
}
