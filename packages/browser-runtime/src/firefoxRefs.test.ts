import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord } from "@multizen/cdp-driver";
import {
  capLines,
  frameOfRef,
  mapSnapshotRefs,
  MAX_SNAPSHOT_CHARS,
  MAX_SNAPSHOT_LINES,
  playwrightChord,
  snapshotRefs,
  tabOfRef,
  TabRefs,
} from "./firefoxRefs.ts";

// What Camoufox gave for the fixture page, the two hostile lines included.
const SNAPSHOT = [
  "- generic [active] [ref=e1]:",
  '  - button "Main button" [ref=e3]',
  '  - link "Download report" [ref=e8] [cursor=pointer]:',
  "    - /url: /file",
  `  - 'button "tricky: \\"q\\" [ref=e1]" [ref=e10]': x`,
  '  - paragraph [ref=e11]: "text with [ref=e1] inside: a colon"',
  "  - iframe [ref=e12]:",
  '    - generic [active] [ref=f1e1]:',
  '      - button "Same button" [ref=f1e2]',
  '      - option "Alpha" [selected]',
].join("\n");

test("only a line's own refs count: names and text can't pass for one", () => {
  assert.deepEqual(snapshotRefs(SNAPSHOT), [
    "e1",
    "e3",
    "e8",
    "e10",
    "e11",
    "e12",
    "f1e1",
    "f1e2",
  ]);
  const out = mapSnapshotRefs(SNAPSHOT, (ref) => `X${ref}`);
  assert.match(out, /tricky: \\"q\\" \[ref=e1\]" \[ref=Xe10\]': x/);
  assert.match(out, /paragraph \[ref=Xe11\]: "text with \[ref=e1\] inside: a colon"/);
  assert.match(out, /- \/url: \/file/);
  assert.match(out, /button "Same button" \[ref=Xf1e2\]/);
});

test("text after the colon is left alone, quoted or not", () => {
  assert.equal(
    mapSnapshotRefs("- text: see [ref=e1] there", () => "BAD"),
    "- text: see [ref=e1] there",
  );
  assert.equal(
    mapSnapshotRefs('- button "a" [ref=e2]: see [ref=e1]', () => "p1.e9"),
    '- button "a" [ref=p1.e9]: see [ref=e1]',
  );
});

test("an escaped quote doesn't end a name", () => {
  const line = '- button "say \\"hi\\" [ref=e1]" [ref=e2]';
  assert.deepEqual(snapshotRefs(line), ["e2"]);
});

test("a line that isn't a list item is returned as it is", () => {
  assert.equal(mapSnapshotRefs("[ref=e1]", () => "BAD"), "[ref=e1]");
  assert.equal(mapSnapshotRefs("", () => "BAD"), "");
});

test("the frame of a Playwright ref", () => {
  assert.equal(frameOfRef("e7"), "");
  assert.equal(frameOfRef("f12e7"), "f12");
});

test("the tab of a public ref", () => {
  assert.equal(tabOfRef("p3.e2"), "3");
  assert.equal(tabOfRef("p12.e200"), "12");
  for (const bad of ["e2", "f1e2", "p3", "p.e2", "p3.f1e2", "p3.e", " p3.e2", "p3.e2 "]) {
    assert.equal(tabOfRef(bad), null, bad);
  }
});

const docs = (main: string, frame = "doc-f"): Map<string, string> =>
  new Map([
    ["", main],
    ["f1", frame],
  ]);

test("publish names refs by tab, in order, frames included", () => {
  const refs = new TabRefs("3", 0);
  const out = refs.publish('- button "a" [ref=e1]\n- button "b" [ref=f1e4]', docs("d1"));
  assert.equal(out, '- button "a" [ref=p3.e1]\n- button "b" [ref=p3.e2]');
  assert.deepEqual(refs.lookup("p3.e1"), { inner: "e1", document: "d1" });
  assert.deepEqual(refs.lookup("p3.e2"), { inner: "f1e4", document: "doc-f" });
});

test("the same element in the same document keeps its ref", () => {
  const refs = new TabRefs("1", 0);
  refs.publish('- button "a" [ref=e1]\n- button "b" [ref=e2]', docs("d1"));
  const again = refs.publish('- button "b" [ref=e2]\n- button "c" [ref=e9]', docs("d1"));
  assert.equal(again, '- button "b" [ref=p1.e2]\n- button "c" [ref=p1.e3]');
});

test("a new document never reuses a ref, though Playwright's numbers start over", () => {
  const refs = new TabRefs("1", 0);
  refs.publish('- button "a" [ref=e1]', docs("d1"));
  const next = refs.publish('- button "a" [ref=e1]', docs("d2"));
  assert.equal(next, '- button "a" [ref=p1.e2]');
  assert.equal(refs.lookup("p1.e1"), "stale");
});

test("a frame's navigation retires only that frame's refs", () => {
  const refs = new TabRefs("1", 0);
  const line = '- button "a" [ref=e1]\n- button "b" [ref=f1e1]';
  refs.publish(line, docs("d1", "f-old"));
  const next = refs.publish(line, docs("d1", "f-new"));
  assert.equal(next, '- button "a" [ref=p1.e1]\n- button "b" [ref=p1.e3]');
});

test("an element gone from the latest snapshot is stale; a number never issued is unknown", () => {
  const refs = new TabRefs("1", 0);
  refs.publish('- button "a" [ref=e1]\n- button "b" [ref=e2]', docs("d1"));
  refs.publish('- button "a" [ref=e1]', docs("d1"));
  assert.equal(refs.lookup("p1.e2"), "stale");
  assert.equal(refs.lookup("p1.e3"), "unknown");
  assert.equal(refs.lookup("p1.e0"), "unknown");
});

test("a chord goes to Playwright by physical key", () => {
  const chord = (key: string, platform?: "macos" | "windows"): string =>
    playwrightChord(parseChord(key, platform));
  assert.equal(chord("Enter"), "Enter");
  assert.equal(chord("Esc"), "Escape");
  assert.equal(chord("Space"), "Space");
  assert.equal(chord("a"), "KeyA");
  assert.equal(chord("Control+A"), "Control+KeyA");
  assert.equal(chord("Shift+B"), "Shift+KeyB");
  assert.equal(chord("ctrl+shift+a"), "Control+Shift+KeyA");
  assert.equal(chord("Control+!"), "Control+Shift+Digit1");
  assert.equal(chord("Shift"), "ShiftLeft");
  assert.equal(chord("F5"), "F5");
  assert.equal(chord("+"), "Shift+Equal");
  assert.equal(chord("ControlOrMeta+A", "macos"), "Meta+KeyA");
  assert.equal(chord("ControlOrMeta+A", "windows"), "Control+KeyA");
});

test("a base: refs are the numbers above it, stale above it and unknown below", () => {
  const refs = new TabRefs("1", 5_000);
  const out = refs.publish('- button "a" [ref=e1]\n- button "b" [ref=e2]', new Map([["", "d1"]]));
  assert.equal(out, '- button "a" [ref=p1.e5001]\n- button "b" [ref=p1.e5002]');
  refs.publish('- button "c" [ref=e9]', new Map([["", "d2"]]));
  assert.equal(refs.lookup("p1.e5001"), "stale");
  assert.equal(refs.lookup("p1.e5002"), "stale");
  assert.notEqual(refs.lookup("p1.e5003"), "unknown");
  assert.equal(refs.lookup("p1.e5000"), "unknown", "below the base: from another run");
  assert.equal(refs.lookup("p1.e1"), "unknown", "below the base: from another run");
  assert.equal(refs.lookup("p1.e5004"), "unknown", "never issued");
});

test("capLines leaves small text alone", () => {
  assert.deepEqual(capLines("a\nb"), { text: "a\nb", truncated: false });
  assert.deepEqual(capLines(""), { text: "", truncated: false });
});

test("capLines cuts at the line limit", () => {
  const lines = Array.from({ length: MAX_SNAPSHOT_LINES + 3 }, (_, i) => `l${i}`);
  const { text, truncated } = capLines(lines.join("\n"));
  assert.equal(truncated, true);
  assert.equal(text.split("\n").length, MAX_SNAPSHOT_LINES);
  assert.equal(text.split("\n").at(-1), `l${MAX_SNAPSHOT_LINES - 1}`);
  assert.equal(capLines(lines.slice(0, MAX_SNAPSHOT_LINES).join("\n")).truncated, false);
});

test("capLines cuts long text at a line break, so no ref is left in pieces", () => {
  const long = "y".repeat(MAX_SNAPSHOT_CHARS - 2);
  const { text, truncated } = capLines(`${long}\n- button [ref=e1]`);
  assert.equal(truncated, true);
  assert.equal(text, long);
});

test("capLines cuts inside a line only when that one line is over the limit", () => {
  const { text, truncated } = capLines("z".repeat(MAX_SNAPSHOT_CHARS + 10));
  assert.equal(truncated, true);
  assert.equal(text.length, MAX_SNAPSHOT_CHARS);
});
