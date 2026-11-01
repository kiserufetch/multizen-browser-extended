/** One section of a run: what it saw, or why it couldn't look. */
export type SectionResult = { status: "ok"; data: unknown } | { status: "unavailable"; reason: string };

export interface RunResult {
  meta: Record<string, unknown>;
  sections: Record<string, SectionResult>;
}

type Primitive = string | number | boolean | null;
export type FlatValue = Primitive | readonly Primitive[];

const isPrimitive = (v: unknown): v is Primitive =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * `a.b[0].c`-style paths to values. An array of plain values stays one value: a list of
 * fonts or ciphers differs as a whole, and the table says what's only on each side.
 */
export function flatten(value: unknown, prefix = "", out = new Map<string, FlatValue>()): Map<string, FlatValue> {
  if (isPrimitive(value)) {
    out.set(prefix, value);
  } else if (Array.isArray(value)) {
    if (value.every(isPrimitive)) out.set(prefix, value as Primitive[]);
    else value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

/** A run's sections as flat paths: `probe.webdriver`, not `sections.probe.data.webdriver`. */
export function flattenSections(run: RunResult): Map<string, FlatValue> {
  const out = new Map<string, FlatValue>();
  for (const [name, section] of Object.entries(run.sections)) {
    if (section.status === "ok") flatten(section.data, name, out);
    else flatten({ status: section.status, reason: section.reason }, name, out);
  }
  return out;
}

/** Varies between two loads of one page on one browser: not a difference between setups. */
const NOISE_PATHS: readonly RegExp[] = [
  /(^|\.)connection\.downlink$/,
  /(^|\.)(timestamp|timeStamp|capturedAt|startedAt|timeOrigin|msSinceLoad|durationMs|elapsedMs)$/,
  /(^|\.)timings(\.|$)/,
  // Chrome shuffles these per connection, which is why JA4 sorts them.
  /(^|\.)extensionsWire$/,
];

/** Only noise when the seeds differ: the same seed is meant to draw the same canvas. */
const CANVAS_PATHS = /canvas/i;

/** Sections in the order a reader wants them. Others follow, by name. */
const SECTION_ORDER = ["probe", "headers", "fonts", "input", "tls", "h2", "webrtc", "netlog", "creepjs", "rebrowser"];

export interface Difference {
  section: string;
  path: string;
  a: FlatValue | undefined;
  b: FlatValue | undefined;
}

const sameValue = (a: FlatValue | undefined, b: FlatValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function sectionOf(path: string): string {
  return /^[^.[]+/.exec(path)?.[0] ?? path;
}

/** Every path where the two differ. No noise rules: those are up to the caller. */
export function differences(a: Map<string, FlatValue>, b: Map<string, FlatValue>): Difference[] {
  const out: Difference[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (!sameValue(a.get(path), b.get(path))) {
      out.push({ section: sectionOf(path), path, a: a.get(path), b: b.get(path) });
    }
  }
  return out;
}

export interface CompareOptions {
  /** Other runs of A's own setup: whatever differs between A and them is that setup's noise. */
  repeats?: readonly RunResult[];
  /** The same for B. */
  repeatsOfB?: readonly RunResult[];
}

export interface Comparison {
  differences: Difference[];
  /** Dropped by the rules. */
  noiseCount: number;
  /** Dropped because A or B differs from its own repeat there too. */
  repeatNoiseCount: number;
  thresholds: { a: string[]; b: string[] };
}

export function compareRuns(a: RunResult, b: RunResult, opts: CompareOptions = {}): Comparison {
  const flatA = flattenSections(a);
  const flatB = flattenSections(b);
  const seedsDiffer = a.meta.seed !== b.meta.seed;
  const unstable = new Set<string>();
  for (const repeat of opts.repeats ?? []) {
    for (const d of differences(flatA, flattenSections(repeat))) unstable.add(d.path);
  }
  for (const repeat of opts.repeatsOfB ?? []) {
    for (const d of differences(flatB, flattenSections(repeat))) unstable.add(d.path);
  }
  const all = differences(flatA, flatB);
  const isNoise = (path: string): boolean =>
    NOISE_PATHS.some((rule) => rule.test(path)) || (seedsDiffer && CANVAS_PATHS.test(path));
  const afterRules = all.filter((d) => !isNoise(d.path));
  const kept = afterRules.filter((d) => !unstable.has(d.path));
  return {
    differences: kept,
    noiseCount: all.length - afterRules.length,
    repeatNoiseCount: afterRules.length - kept.length,
    thresholds: { a: thresholdFailures(a), b: thresholdFailures(b) },
  };
}

function isDesktopPersona(run: RunResult): boolean {
  const persona = run.meta.persona as { device?: unknown } | undefined;
  return !/iphone|ipad|android|mobile/i.test(String(persona?.device ?? ""));
}

const WEBDRIVER_PATH = /(^|\.)(webdriver|webDriverIsOn)$/;

/**
 * What no setup may show, with or without anything to compare it to. Real pages'
 * keys and notes don't count as values here unless they fire: the scan covers values,
 * and rebrowser's `HeadlessChrome` note only appears when its check does.
 */
export function thresholdFailures(run: RunResult): string[] {
  const failures: string[] = [];
  for (const [path, value] of flattenSections(run)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === "string" && v.includes("HeadlessChrome"))) {
      failures.push(`HeadlessChrome at ${path}`);
    }
    if (WEBDRIVER_PATH.test(path) && value === true) failures.push(`webdriver is true at ${path}`);
    if (path.endsWith("media.(pointer: none)") && value === true && isDesktopPersona(run)) {
      failures.push(`pointer: none on a desktop persona at ${path}`);
    }
  }
  return failures;
}

const MAX_CELL_LENGTH = 300;
const LIST_DIFF_AT = 6;

function cell(value: FlatValue | undefined): string {
  if (value === undefined) return "(absent)";
  const text = Array.isArray(value) ? value.join(", ") : JSON.stringify(value);
  const clipped = text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH)}...` : text;
  return clipped.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** For long lists the row says what only one side has, which is what the reader is after. */
function cellPair(a: FlatValue | undefined, b: FlatValue | undefined): [string, string] {
  if (!Array.isArray(a) || !Array.isArray(b) || Math.max(a.length, b.length) < LIST_DIFF_AT) {
    return [cell(a), cell(b)];
  }
  const onlyA = a.filter((v) => !b.includes(v));
  const onlyB = b.filter((v) => !a.includes(v));
  if (onlyA.length === 0 && onlyB.length === 0) return [`${cell(a)} (other order)`, cell(b)];
  return [
    `only here (${onlyA.length} of ${a.length}): ${cell(onlyA)}`,
    `only here (${onlyB.length} of ${b.length}): ${cell(onlyB)}`,
  ];
}

const META_ROWS = ["label", "date", "engine", "engineVersion", "mode", "displayMode", "egress", "seed", "platform"];

function personaOf(run: RunResult): string {
  const persona = run.meta.persona as { device?: unknown } | undefined;
  return String(persona?.device ?? "");
}

/** The report: which runs, then what no setup may show, then the differences by section. */
export function comparisonMarkdown(a: RunResult, b: RunResult, comparison: Comparison): string {
  const lines: string[] = [];
  const nameOf = (run: RunResult): string => String(run.meta.label ?? "?");
  lines.push(`# ${nameOf(a)} vs ${nameOf(b)}`, "");
  lines.push("| | A | B |", "| --- | --- | --- |");
  for (const key of META_ROWS) {
    lines.push(`| ${key} | ${cell(a.meta[key] as FlatValue)} | ${cell(b.meta[key] as FlatValue)} |`);
  }
  lines.push(`| persona | ${personaOf(a)} | ${personaOf(b)} |`, "");

  const failures = [
    ...comparison.thresholds.a.map((f) => `A: ${f}`),
    ...comparison.thresholds.b.map((f) => `B: ${f}`),
  ];
  lines.push("## Thresholds", "");
  if (failures.length === 0) lines.push("None fired: no `HeadlessChrome`, no `webdriver: true`, no `pointer: none`.", "");
  else lines.push(...failures.map((f) => `- **${f}**`), "");

  const dropped = [`${comparison.noiseCount} by the noise rules`];
  if (comparison.repeatNoiseCount > 0) {
    dropped.push(`${comparison.repeatNoiseCount} that also differ between a setup and its own repeat`);
  }
  lines.push(`${comparison.differences.length} differences; left out: ${dropped.join(", ")}.`, "");

  const bySection = new Map<string, Difference[]>();
  for (const d of comparison.differences) {
    bySection.set(d.section, [...(bySection.get(d.section) ?? []), d]);
  }
  const rank = (name: string): number => {
    const known = SECTION_ORDER.indexOf(name);
    return known === -1 ? SECTION_ORDER.length : known;
  };
  const names = [...new Set([...Object.keys(a.sections), ...Object.keys(b.sections)])].sort(
    (x, y) => rank(x) - rank(y) || x.localeCompare(y),
  );
  for (const name of names) {
    const rows = bySection.get(name) ?? [];
    lines.push(`## ${name} (${rows.length})`, "");
    if (rows.length === 0) {
      lines.push("No differences.", "");
      continue;
    }
    lines.push("| path | A | B |", "| --- | --- | --- |");
    for (const d of rows.sort((x, y) => x.path.localeCompare(y.path))) {
      const [left, right] = cellPair(d.a, d.b);
      lines.push(`| \`${d.path.replace(/\|/g, "\\|")}\` | ${left} | ${right} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 0 unless told to care. What no setup may show fails regardless. */
export function compareExitCode(comparison: Comparison, failOnDiff: boolean): number {
  if (comparison.thresholds.a.length > 0 || comparison.thresholds.b.length > 0) return 2;
  return failOnDiff && comparison.differences.length > 0 ? 1 : 0;
}
