/** What the input logger keeps of one event. Fields past these depend on the event's type. */
export interface LoggedEvent {
  type: string;
  trusted: boolean;
  timeStamp: number;
  target?: string;
  button?: number;
  buttons?: number;
  detail?: number;
  pressure?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  width?: number;
  height?: number;
  pointerType?: string;
  isPrimary?: boolean;
  pointerId?: number;
  key?: string;
  code?: string;
  keyCode?: number;
  location?: number;
  repeat?: boolean;
  shiftKey?: boolean;
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  inputType?: string;
  coalesced?: number;
  predicted?: number;
}

const MOVES = new Set(["pointermove", "mousemove"]);
/** Fires on its own schedule: where it lands among the rest says nothing about the action. */
const OUT_OF_BAND = new Set(["selectionchange"]);

/**
 * Listeners are on `window` and `document`, so an event comes twice in a row, the same but for
 * nothing. Two different keys can share a millisecond, so a time alone doesn't tell.
 */
function deduplicate(events: readonly LoggedEvent[]): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    out.push(event);
    const next = events[i + 1];
    if (next && JSON.stringify(next) === JSON.stringify(event)) i += 1;
  }
  return out;
}

function pick<T extends object, K extends keyof T>(from: T | undefined, keys: readonly K[]): Partial<T> | null {
  if (!from) return null;
  const out: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

function firstGapBetween(events: readonly LoggedEvent[], from: string, to: string): number | null {
  const start = events.find((e) => e.type === from);
  if (!start) return null;
  const end = events.find((e) => e.type === to && e.timeStamp >= start.timeStamp);
  return end ? round(end.timeStamp - start.timeStamp) : null;
}

/**
 * What a page's script would conclude from an action's events. Timings stay under `timings`,
 * where a comparison treats them as noise and a reader can still find them, and so does what
 * varies with them: how many moves a path took, how many of them a frame coalesced.
 */
export function summarizeEvents(raw: readonly LoggedEvent[]): Record<string, unknown> {
  const events = deduplicate(raw);
  const sequence: string[] = [];
  for (const e of events) {
    if (OUT_OF_BAND.has(e.type)) continue;
    const step = MOVES.has(e.type) ? `${e.type}+` : e.type;
    if (sequence.at(-1) !== step) sequence.push(step);
  }
  const keydowns = events.filter((e) => e.type === "keydown");
  const moves = events.filter((e) => e.type === "pointermove");
  const keyGaps = keydowns.slice(1).map((e, i) => e.timeStamp - keydowns[i]!.timeStamp);
  return {
    sequence,
    allTrusted: events.every((e) => e.trusted),
    untrusted: [...new Set(events.filter((e) => !e.trusted).map((e) => e.type))],
    pointerdown: pick(events.find((e) => e.type === "pointerdown"), [
      "button",
      "buttons",
      "pressure",
      "tangentialPressure",
      "tiltX",
      "tiltY",
      "twist",
      "width",
      "height",
      "pointerType",
      "isPrimary",
    ]),
    pointermove: pick(moves[0], ["pressure", "buttons", "width", "height", "pointerType"]),
    mousedown: pick(events.find((e) => e.type === "mousedown"), ["button", "buttons", "detail"]),
    click: pick(events.find((e) => e.type === "click"), ["button", "buttons", "detail", "pointerType", "pressure"]),
    keydown: pick(keydowns[0], ["key", "code", "keyCode", "location", "repeat", "shiftKey"]),
    keyCount: keydowns.length,
    input: pick(events.find((e) => e.type === "input"), ["inputType"]),
    wheel: pick(events.find((e) => e.type === "wheel"), ["deltaX", "deltaY", "deltaMode"]),
    timings: {
      events: events.length,
      pointerMoves: moves.length,
      coalescedInFirstMove: moves[0]?.coalesced ?? null,
      pressToReleaseMs: firstGapBetween(events, "mousedown", "mouseup"),
      keyDownToUpMs: firstGapBetween(events, "keydown", "keyup"),
      meanKeyGapMs: keyGaps.length > 0 ? round(keyGaps.reduce((a, b) => a + b, 0) / keyGaps.length) : null,
      firstToLastMs: events.length > 1 ? round(events.at(-1)!.timeStamp - events[0]!.timeStamp) : 0,
    },
  };
}
