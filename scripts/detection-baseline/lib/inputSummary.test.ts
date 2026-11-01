import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeEvents, type LoggedEvent } from "./inputSummary.ts";

/** Each event as the logger records it: once from `window`, once from `document`. */
const twice = (...events: LoggedEvent[]): LoggedEvent[] => events.flatMap((e) => [e, { ...e }]);

const event = (type: string, timeStamp: number, over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  type,
  trusted: true,
  timeStamp,
  ...over,
});

test("each event counts once, and keys in the same millisecond stay two keys", () => {
  const s = summarizeEvents(
    twice(
      event("keydown", 5, { key: "Shift", code: "ShiftLeft" }),
      event("keydown", 5, { key: "H", code: "KeyH" }),
      event("keyup", 9, { key: "H", code: "KeyH" }),
    ),
  ) as { keyCount: number; keydown: LoggedEvent; timings: { events: number; keyDownToUpMs: number } };
  assert.equal(s.keyCount, 2);
  assert.equal(s.keydown.key, "Shift");
  assert.equal(s.timings.events, 3);
  assert.equal(s.timings.keyDownToUpMs, 4);
});

test("an event only one of the listeners saw stays too", () => {
  const s = summarizeEvents([event("focus", 1), event("blur", 1)]) as { timings: { events: number } };
  assert.equal(s.timings.events, 2);
});

test("the sequence runs moves together and leaves out what fires on its own schedule", () => {
  const s = summarizeEvents(
    twice(
      event("pointermove", 1, { pointerType: "mouse", coalesced: 4, width: 1 }),
      event("pointermove", 2, { pointerType: "mouse", coalesced: 3, width: 1 }),
      event("mousemove", 3),
      event("selectionchange", 3.5),
      event("pointerdown", 4, { pressure: 0.5, pointerType: "mouse", width: 1 }),
      event("mousedown", 4, { button: 0, buttons: 1, detail: 1 }),
      event("mouseup", 54, { button: 0 }),
      event("click", 55, { detail: 1 }),
    ),
  ) as {
    sequence: string[];
    allTrusted: boolean;
    pointermove: Record<string, unknown>;
    timings: { pointerMoves: number; coalescedInFirstMove: number; pressToReleaseMs: number; firstToLastMs: number };
  };
  assert.deepEqual(s.sequence, ["pointermove+", "mousemove+", "pointerdown", "mousedown", "mouseup", "click"]);
  assert.equal(s.allTrusted, true);
  assert.deepEqual(s.pointermove, { width: 1, pointerType: "mouse" });
  assert.equal(s.timings.pointerMoves, 2);
  assert.equal(s.timings.coalescedInFirstMove, 4);
  assert.equal(s.timings.pressToReleaseMs, 50);
  assert.equal(s.timings.firstToLastMs, 54);
});

test("an untrusted event is named: script can tell what a real input isn't", () => {
  const s = summarizeEvents(
    twice(event("input", 1, { trusted: false }), event("change", 2, { trusted: false }), event("click", 3)),
  ) as { allTrusted: boolean; untrusted: string[] };
  assert.equal(s.allTrusted, false);
  assert.deepEqual(s.untrusted, ["input", "change"]);
});

test("no events at all is a summary, not a failure: the section's reader sees nothing arrived", () => {
  const s = summarizeEvents([]) as { sequence: string[]; allTrusted: boolean; pointerdown: null; keyCount: number };
  assert.deepEqual(s.sequence, []);
  assert.equal(s.allTrusted, true);
  assert.equal(s.pointerdown, null);
  assert.equal(s.keyCount, 0);
});
