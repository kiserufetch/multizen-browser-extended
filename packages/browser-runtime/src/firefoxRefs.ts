import type { KeyChord } from "@multizen/cdp-driver";

/**
 * Element refs on the Firefox engine as an agent sees them: `p3.e17`, on tab 3.
 *
 * Playwright's own refs (`e5`, or `f2e5` inside a frame) mean something only until
 * their document goes: its counter starts over with each document, so `e5` of the
 * next page is a different element. Refs here are numbered by {@link TabRefs}, never
 * reused, and remember the document they came from, so an old one fails as stale
 * instead of reaching something new.
 */

const SNAPSHOT_REF = /\[ref=((?:f\d+)?e\d+)\]/y;

/**
 * Replaces the refs of an aria snapshot. Only a line's own `[ref=…]` counts: names and
 * text come from the page, which can write "[ref=e1]" in them to pass for a real ref.
 * A line reads `- role "name" [attr] [ref=e5]: text`, its key single-quoted as a whole
 * when YAML requires, and a name is a JSON string.
 */
export function mapSnapshotRefs(snapshot: string, rename: (ref: string) => string): string {
  return snapshot
    .split("\n")
    .map((line) => mapLineRefs(line, rename))
    .join("\n");
}

function mapLineRefs(line: string, rename: (ref: string) => string): string {
  const start = /^\s*- /.exec(line)?.[0].length;
  if (start === undefined) return line;
  const quotedKey = line[start] === "'";
  let i = quotedKey ? start + 1 : start;
  let out = line.slice(0, i);
  let inName = false;
  while (i < line.length) {
    const c = line[i]!;
    if (inName) {
      if (c === "\\") {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') inName = false;
    } else if (c === '"') {
      inName = true;
    } else if (quotedKey ? c === "'" : c === ":" && (i + 1 === line.length || line[i + 1] === " ")) {
      break;
    } else {
      SNAPSHOT_REF.lastIndex = i;
      const ref = SNAPSHOT_REF.exec(line);
      if (ref) {
        out += `[ref=${rename(ref[1]!)}]`;
        i += ref[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out + line.slice(i);
}

/** Playwright's refs in a snapshot, in order. */
export function snapshotRefs(snapshot: string): string[] {
  const refs: string[] = [];
  mapSnapshotRefs(snapshot, (ref) => {
    refs.push(ref);
    return ref;
  });
  return refs;
}

/** The frame a Playwright ref belongs to: `f2` of `f2e5`, "" for the main frame. */
export function frameOfRef(ref: string): string {
  return /^f\d+/.exec(ref)?.[0] ?? "";
}

/** The tab a public ref names, or null when it doesn't have the shape of one. */
export function tabOfRef(ref: string): string | null {
  return /^p(\d+)\.e\d+$/.exec(ref)?.[1] ?? null;
}

export interface RefEntry {
  /** Playwright's name for the element, for `aria-ref=`. */
  inner: string;
  /** Identifies the document the element was in. */
  document: string;
}

/**
 * The refs of one tab. Playwright resolves only what its latest snapshot contains, so
 * each snapshot replaces the table. An element still there in the same document keeps
 * its ref.
 */
export class TabRefs {
  private entries = new Map<string, RefEntry>();
  private issued = 0;

  constructor(private readonly tabId: string) {}

  /**
   * The snapshot under public refs. `documents` maps a frame (see {@link frameOfRef}) to
   * the document it holds right now.
   */
  publish(snapshot: string, documents: ReadonlyMap<string, string>): string {
    const known = new Map<string, string>();
    for (const [ref, entry] of this.entries) known.set(`${entry.document}\n${entry.inner}`, ref);
    this.entries = new Map();
    return mapSnapshotRefs(snapshot, (inner) => {
      const document = documents.get(frameOfRef(inner)) ?? "";
      const ref = known.get(`${document}\n${inner}`) ?? `p${this.tabId}.e${++this.issued}`;
      this.entries.set(ref, { inner, document });
      return ref;
    });
  }

  /** `stale`: this table issued it once. `unknown`: it never did. */
  lookup(ref: string): RefEntry | "stale" | "unknown" {
    const entry = this.entries.get(ref);
    if (entry) return entry;
    const n = Number(/\.e(\d+)$/.exec(ref)?.[1]);
    return n >= 1 && n <= this.issued ? "stale" : "unknown";
  }
}

/**
 * A chord, parsed as on the other engine, in Playwright's syntax. By physical key:
 * Playwright then gives `Control+KeyA` the key "a" and `Shift+KeyB` the key "B", which
 * is what a keyboard does. Under the name "A" it would send "A" with Control.
 */
export function playwrightChord(chord: KeyChord): string {
  return [...chord.modifiers.map((m) => m.key), chord.key.code || chord.key.key].join("+");
}
