/**
 * Heuristic: decide whether `target` is a CSS selector or a natural-language
 * description. Cheap so we can avoid LLM calls when the agent already knows
 * the selector.
 */
export function resolveTarget(target: string): "css" | "natural" {
  const trimmed = target.trim();
  // Obvious selectors
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith(":") ||
    /^[a-z][a-z0-9-]*\s*[\[#.:]/i.test(trimmed) // tag.class, tag#id, tag[attr]
  ) {
    return "css";
  }

  // Single tag selector: "button", "input", etc — also CSS
  if (/^[a-z][a-z0-9-]*$/i.test(trimmed) && trimmed.length < 16) {
    return "css";
  }

  // Anything with spaces or natural-sounding words → natural
  if (/\s/.test(trimmed) || trimmed.length > 40) return "natural";

  // Default: treat as CSS
  return "css";
}
