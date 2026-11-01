/**
 * Compares two runs of run.ts: what differs, by section, with what no setup may show on top.
 *
 *   corepack yarn workspace @multizen/detection-baseline compare <A> <B> \
 *     [--fail-on-diff] [--repeat <A's own repeat>]... [--repeat-b <B's own repeat>]... [--out <dir>]
 *
 * <A> and <B> are a run's directory, its result.json, or its directory's name under
 * docs/detection-baselines. Writes compare-<A>-vs-<B>.md next to the runs and prints it.
 *
 * Exit 0, even with differences. --fail-on-diff makes a difference exit 1. HeadlessChrome,
 * webdriver true and pointer: none on a desktop persona always exit 2.
 *
 * --repeat names another run of A's own setup: what differs between those two is noise, and
 * isn't held against B. --repeat-b is the same for B. A Camoufox fingerprint is drawn anew at
 * every launch, for one, and a real desktop has its own unstable values.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareExitCode, compareRuns, comparisonMarkdown, type RunResult } from "./lib/compare.ts";

const BASELINES_DIR = fileURLToPath(new URL("../../docs/detection-baselines/", import.meta.url));

function resultPath(run: string): string {
  const direct = resolve(run);
  if (existsSync(direct)) return statSync(direct).isDirectory() ? join(direct, "result.json") : direct;
  const named = join(BASELINES_DIR, run, "result.json");
  if (existsSync(named)) return named;
  throw new Error(`No run at ${run}: give a run's directory, its result.json, or its name under ${BASELINES_DIR}`);
}

const readRun = (path: string): RunResult => JSON.parse(readFileSync(path, "utf8")) as RunResult;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "fail-on-diff": { type: "boolean" },
    repeat: { type: "string", multiple: true },
    "repeat-b": { type: "string", multiple: true },
    out: { type: "string" },
  },
});
const [runA, runB] = positionals;
if (!runA || !runB) {
  process.stderr.write(
    "usage: compare.ts <A> <B> [--fail-on-diff] [--repeat <run>]... [--repeat-b <run>]... [--out <dir>]\n",
  );
  process.exit(2);
}
const pathA = resultPath(runA);
const pathB = resultPath(runB);
const a = readRun(pathA);
const b = readRun(pathB);
const repeats = (runs: string[] | undefined): RunResult[] => (runs ?? []).map((run) => readRun(resultPath(run)));
const comparison = compareRuns(a, b, { repeats: repeats(values.repeat), repeatsOfB: repeats(values["repeat-b"]) });
const markdown = comparisonMarkdown(a, b, comparison);
const outDir = values.out ? resolve(values.out) : dirname(dirname(pathA));
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `compare-${basename(dirname(pathA))}-vs-${basename(dirname(pathB))}.md`);
writeFileSync(outPath, markdown);
process.stdout.write(`${markdown}\nWritten to ${outPath}\n`);
process.exitCode = compareExitCode(comparison, values["fail-on-diff"] === true);
