/**
 * Minimal US-layout keyboard model for synthesizing *correct* CDP key events.
 *
 * The previous `type()` sent `Input.dispatchKeyEvent({ type: "keyDown", text })`
 * with an empty `keyUp` — so `KeyboardEvent.key`, `.code` and `.keyCode` were
 * all empty/0 on the page. Real keystrokes always carry them, and site logic
 * like `if (e.key === "Enter")` or `e.code === "KeyA"` never fired. This maps a
 * character to the descriptor a real US keyboard would produce, including
 * whether Shift is held, so the emitted event sequence matches a genuine press.
 *
 * Non-US layouts (where the same glyph sits on a different physical key) are a
 * later, per-locale concern; this is the correct baseline for the common case.
 */
export interface KeyDescriptor {
  /** KeyboardEvent.key — the produced character or a named key ("Enter"). */
  key: string;
  /** KeyboardEvent.code — the physical key ("KeyA", "Digit1", "Enter"). */
  code: string;
  /** Virtual key code (windows/native), e.g. 65 for A. 0 when unknown. */
  keyCode: number;
  /** Inserted text for printable keys; undefined for pure control keys. */
  text?: string;
  /** Whether a real press of this glyph requires Shift held. */
  shift: boolean;
}

/** CDP modifier bitmask value for Shift. */
export const CDP_MOD_SHIFT = 8;

// Characters reachable WITHOUT Shift on a US layout → [code, keyCode].
const UNSHIFTED: Record<string, [string, number]> = {
  "`": ["Backquote", 192],
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
};

// Shifted glyph → the unshifted glyph on the same physical key.
const SHIFTED_TO_BASE: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

function baseDescriptor(base: string): { code: string; keyCode: number } | null {
  if (base >= "a" && base <= "z") {
    return { code: `Key${base.toUpperCase()}`, keyCode: base.toUpperCase().charCodeAt(0) };
  }
  if (base >= "0" && base <= "9") {
    return { code: `Digit${base}`, keyCode: base.charCodeAt(0) };
  }
  const u = UNSHIFTED[base];
  return u ? { code: u[0], keyCode: u[1] } : null;
}

/**
 * Describe the key event for a single character. Returns a best-effort
 * descriptor for anything outside the US map (key + text still set, so the
 * character is typed; code/keyCode are left blank rather than faked wrong).
 */
export function describeKey(ch: string): KeyDescriptor {
  if (ch === "\n" || ch === "\r") {
    return { key: "Enter", code: "Enter", keyCode: 13, text: "\r", shift: false };
  }
  if (ch === "\t") {
    return { key: "Tab", code: "Tab", keyCode: 9, shift: false };
  }
  if (ch === " ") {
    return { key: " ", code: "Space", keyCode: 32, text: " ", shift: false };
  }
  // Uppercase letters: shifted base letter.
  if (ch >= "A" && ch <= "Z") {
    return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  }
  // Lowercase letters.
  if (ch >= "a" && ch <= "z") {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  }
  // Digits.
  if (ch >= "0" && ch <= "9") {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  }
  // Unshifted punctuation.
  const u = UNSHIFTED[ch];
  if (u) {
    return { key: ch, code: u[0], keyCode: u[1], text: ch, shift: false };
  }
  // Shifted punctuation / symbols.
  const base = SHIFTED_TO_BASE[ch];
  if (base) {
    const d = baseDescriptor(base);
    if (d) return { key: ch, code: d.code, keyCode: d.keyCode, text: ch, shift: true };
  }
  // Unknown (e.g. emoji, CJK): still insert the character, no physical key.
  return { key: ch, code: "", keyCode: 0, text: ch, shift: false };
}
