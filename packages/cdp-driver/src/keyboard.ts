import { MultizenError } from "@multizen/types";

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

/** CDP modifier bitmask values, as Input.dispatchKeyEvent's `modifiers` adds them. */
const CDP_MOD_ALT = 1;
const CDP_MOD_CTRL = 2;
const CDP_MOD_META = 4;

interface ModifierKey extends KeyDescriptor {
  mask: number;
}

const ALT: ModifierKey = { key: "Alt", code: "AltLeft", keyCode: 18, shift: false, mask: CDP_MOD_ALT };
const CTRL: ModifierKey = {
  key: "Control",
  code: "ControlLeft",
  keyCode: 17,
  shift: false,
  mask: CDP_MOD_CTRL,
};
const META: ModifierKey = {
  key: "Meta",
  code: "MetaLeft",
  keyCode: 91,
  shift: false,
  mask: CDP_MOD_META,
};
const SHIFT: ModifierKey = {
  key: "Shift",
  code: "ShiftLeft",
  keyCode: 16,
  shift: false,
  mask: CDP_MOD_SHIFT,
};

const MODIFIERS: Readonly<Record<string, ModifierKey>> = {
  alt: ALT,
  option: ALT,
  control: CTRL,
  ctrl: CTRL,
  meta: META,
  command: META,
  cmd: META,
  shift: SHIFT,
};

// Keys with a name rather than a glyph, lowercased → [key, code, keyCode, text].
const NAMED_KEYS: Readonly<Record<string, [string, string, number, string?]>> = {
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
  contextmenu: ["ContextMenu", "ContextMenu", 93],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i): [string, [string, string, number]] => [
      `f${i + 1}`,
      [`F${i + 1}`, `F${i + 1}`, 112 + i],
    ]),
  ),
};

/** The descriptor of a key by name ("Enter", "ArrowUp", "F5"), or null if it has none. */
export function describeNamedKey(name: string): KeyDescriptor | null {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) {
    const [key, code, keyCode, text] = named;
    return { key, code, keyCode, shift: false, ...(text ? { text } : {}) };
  }
  const modifier = MODIFIERS[name.toLowerCase()];
  if (modifier) {
    const { mask: _mask, ...key } = modifier;
    return key;
  }
  return null;
}

export interface KeyChord {
  /** Held around `key`, in press order. */
  modifiers: ModifierKey[];
  /** The bitmask `key`'s own events carry. */
  mask: number;
  key: KeyDescriptor;
  /** Key presses a page listening for keydown sees, not counting Shift. */
  countedKeydowns: number;
}

/** The persona platforms {@link parseChord} resolves `ControlOrMeta` for. */
export type KeyPlatform = "macos" | "windows" | "linux";

/**
 * Parse "Control+Shift+A", "Enter" or "+" into what to press. `ControlOrMeta`
 * means Command on a macOS persona and Control otherwise. A chord with a modifier
 * other than Shift inserts no text, as on a real keyboard.
 */
export function parseChord(chord: string, platform: KeyPlatform = "windows"): KeyChord {
  const parts = chord.split("+");
  // "Control++" and "+" name the plus key, which split() turned into empty parts.
  if (parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const keyName = parts.pop() ?? "";
  const modifiers: ModifierKey[] = [];
  const hold = (m: ModifierKey): void => {
    if (!modifiers.includes(m)) modifiers.push(m);
  };
  for (const part of parts) {
    const name = part.trim().toLowerCase();
    const modifier = name === "controlormeta" ? (platform === "macos" ? META : CTRL) : MODIFIERS[name];
    if (!modifier) throw unknownKey(chord, part);
    hold(modifier);
  }

  let key = keyFor(keyName, chord, platform);
  const commanded = modifiers.some((m) => m !== SHIFT);
  if (key.shift) {
    // "Control+A" is the A key with Control, not with Shift. Other shifted glyphs
    // have no other way to be pressed: "Control+!" holds Shift too.
    if (commanded && !modifiers.includes(SHIFT) && /^[A-Z]$/.test(key.key)) {
      key = describeKey(key.key.toLowerCase());
    } else {
      hold(SHIFT);
    }
  } else if (modifiers.includes(SHIFT)) {
    key = shiftedGlyph(key);
  }
  const { text, ...withoutText } = key;
  return {
    modifiers,
    mask: modifiers.reduce((sum, m) => sum | m.mask, 0),
    key: { ...withoutText, ...(text && !commanded ? { text } : {}), shift: false },
    countedKeydowns: modifiers.filter((m) => m !== SHIFT).length + (key.key === "Shift" ? 0 : 1),
  };
}

function keyFor(name: string, chord: string, platform: KeyPlatform): KeyDescriptor {
  if (name.toLowerCase() === "controlormeta") return platform === "macos" ? META : CTRL;
  const named = describeNamedKey(name);
  if (named) return named;
  if ([...name].length === 1) return describeKey(name);
  throw unknownKey(chord, name);
}

/** The glyph Shift gives on the same physical key: "a" → "A", "1" → "!". */
function shiftedGlyph(key: KeyDescriptor): KeyDescriptor {
  if (!key.text || key.text.length !== 1) return key;
  if (key.text >= "a" && key.text <= "z") {
    const upper = key.text.toUpperCase();
    return { ...key, key: upper, text: upper };
  }
  const glyph = Object.keys(SHIFTED_TO_BASE).find((g) => SHIFTED_TO_BASE[g] === key.text);
  return glyph ? { ...key, key: glyph, text: glyph } : key;
}

function unknownKey(chord: string, part: string): MultizenError {
  return new MultizenError("INVALID_INPUT", `Unknown key "${part}" in "${chord}"`, {
    hint: "Use a single character or a key name such as Enter, Tab, Escape, Backspace, ArrowDown, F5, joined with + to modifiers Control, Shift, Alt, Meta or ControlOrMeta.",
  });
}
