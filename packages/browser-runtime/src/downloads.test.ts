import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadTracker, sanitizeFilename, sharedDownloadTracker } from "./downloads.ts";

/** Reviewer's measure of the old regex: 6 s at 80,000 characters, and quadratic. */
const LONG_INPUT_BUDGET_MS = 500;

const DIRS: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-dl-"));
  DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a directory has one shared tracker, tried again if it failed to open", async () => {
  const dir = tempDir();
  assert.equal(await sharedDownloadTracker(dir), await sharedDownloadTracker(dir));
  assert.notEqual(await sharedDownloadTracker(tempDir()), await sharedDownloadTracker(dir));

  const blocked = join(tempDir(), "file");
  writeFileSync(blocked, "not a directory");
  await assert.rejects(sharedDownloadTracker(blocked));
  rmSync(blocked);
  assert.ok(await sharedDownloadTracker(blocked));
});

/** As the browser does: the file exists under the guid by the time it completes. */
async function complete(
  tracker: DownloadTracker,
  guid: string,
  suggestedFilename: string,
  content = "bytes",
): Promise<void> {
  tracker.began({ guid, url: `http://t/${guid}`, suggestedFilename });
  writeFileSync(join(tracker.dir, guid), content);
  tracker.progress({ guid, totalBytes: content.length, receivedBytes: content.length, state: "completed" });
  await tracker.settled();
}

test("sanitizeFilename leaves a plain name alone", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("отчёт 2026.txt"), "отчёт 2026.txt");
});

test("sanitizeFilename keeps a hostile name in the directory, on every platform", () => {
  for (const [input, expected] of [
    ["../../../evil.exe", "evil.exe"],
    ["..\\..\\evil.exe", "evil.exe"],
    ["C:\\Windows\\system32\\x.dll", "x.dll"],
    ["/etc/passwd", "passwd"],
    ["a:b.txt", "a_b.txt"],
    ["..", "download"],
    ["", "download"],
    ["...hidden.", "hidden"],
    ["bad\u0000name?.txt", "bad_name_.txt"],
    ["NUL", "_NUL"],
    ["con.txt", "_con.txt"],
    ["COM1", "_COM1"],
  ] as const) {
    assert.equal(sanitizeFilename(input), expected, input);
  }
});

test("sanitizeFilename caps the length and keeps the extension", () => {
  const long = sanitizeFilename(`${"a".repeat(500)}.tar.gz`);
  assert.ok(long.length <= 200, String(long.length));
  assert.ok(long.endsWith(".gz"));
});

test("a completed download gets its sanitized name, under an id the server made", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  await complete(tracker, "guid-1", "../../report.txt", "hello");

  const [record] = tracker.list();
  assert.equal(record?.fileName, "report.txt");
  assert.equal(record?.state, "completed");
  assert.equal(record?.bytesReceived, 5);
  assert.equal(record?.bytesTotal, 5);
  assert.notEqual(record?.id, "guid-1");
  assert.equal("guid" in record!, false);
  assert.equal("path" in record!, false, "a listing never carries a host path");

  const file = tracker.get(record!.id)!;
  assert.equal(file.path, join(tracker.dir, "report.txt"));
  assert.equal(readFileSync(file.path!, "utf8"), "hello");
  assert.equal(existsSync(join(tracker.dir, "guid-1")), false);
});

test("an id it never issued, a guid and a file name all find nothing", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  await complete(tracker, "guid-1", "a.txt");
  for (const id of ["nope", "guid-1", "a.txt", "../a.txt"]) assert.equal(tracker.get(id), null, id);
});

test("a second file of the same name doesn't overwrite the first", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  await complete(tracker, "g1", "a.txt", "first");
  await complete(tracker, "g2", "a.txt", "second");
  await complete(tracker, "g3", "a.txt", "third");
  assert.deepEqual(
    tracker.list().map((d) => d.fileName),
    ["a.txt", "a (1).txt", "a (2).txt"],
  );
  const [, second] = tracker.list();
  assert.equal(readFileSync(tracker.get(second!.id)!.path!, "utf8"), "second");
});

test("in progress there is no path yet, and an unknown total reads as null", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.began({ guid: "g", url: "http://t/", suggestedFilename: "a.bin" });
  tracker.progress({ guid: "g", totalBytes: 0, receivedBytes: 10, state: "inProgress" });
  const [record] = tracker.list();
  assert.equal(record?.state, "in_progress");
  assert.equal(record?.bytesReceived, 10);
  assert.equal(record?.bytesTotal, null);
  assert.equal(tracker.get(record!.id)?.path, null);
});

test("a canceled download is marked and its partial file removed", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.began({ guid: "g", url: "http://t/", suggestedFilename: "a.bin" });
  writeFileSync(join(tracker.dir, "g"), "part");
  tracker.progress({ guid: "g", totalBytes: 9, receivedBytes: 4, state: "canceled" });
  await tracker.settled();
  assert.equal(tracker.list()[0]?.state, "canceled");
  assert.equal(existsSync(join(tracker.dir, "g")), false);
});

test("progress for a download it never saw is ignored", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.progress({ guid: "ghost", totalBytes: 1, receivedBytes: 1, state: "completed" });
  await tracker.settled();
  assert.deepEqual(tracker.list(), []);
});

test("downloads survive a restart; one unfinished at the time reads as canceled", async () => {
  const dir = tempDir();
  const first = await DownloadTracker.open(dir);
  await complete(first, "g1", "kept.txt", "kept");
  first.began({ guid: "g2", url: "http://t/", suggestedFilename: "lost.bin" });
  writeFileSync(join(dir, "g2"), "part");
  await first.settled();

  const second = await DownloadTracker.open(dir);
  const [kept, lost] = second.list();
  assert.equal(kept?.state, "completed");
  assert.equal(readFileSync(second.get(kept!.id)!.path!, "utf8"), "kept");
  assert.equal(lost?.state, "canceled");
  assert.equal(second.get(lost!.id)?.path, null);
  assert.equal(existsSync(join(dir, "g2")), false);
});

test("a file deleted from the directory has no path, and the record stays", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  await complete(tracker, "g", "gone.txt");
  const { id } = tracker.list()[0]!;
  rmSync(join(tracker.dir, "gone.txt"));
  assert.equal(tracker.get(id)?.path, null);
  assert.equal(tracker.get(id)?.state, "completed");
});

test("an unreadable index starts empty and doesn't stop anything", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, ".multizen-downloads.json"), "{not json");
  const tracker = await DownloadTracker.open(dir);
  assert.deepEqual(tracker.list(), []);
  await complete(tracker, "g", "a.txt");
  assert.ok(readdirSync(dir).includes("a.txt"));
});

// ── the quota ────────────────────────────────────────────────────────────────

test("with no quota set, the desktop's way, any size goes", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.began({ guid: "g", url: "http://t/", suggestedFilename: "huge.bin" });
  tracker.progress({ guid: "g", totalBytes: 1e12, receivedBytes: 1e11, state: "inProgress" });
  assert.equal(tracker.list()[0]?.state, "in_progress");
});

test("a download that would go past the quota is stopped and deleted, saying why", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.quotaBytes = 100;
  const stopped: string[] = [];
  tracker.stopDownload = (guid) => stopped.push(guid);
  await complete(tracker, "kept", "kept.bin", "x".repeat(40));

  tracker.began({ guid: "big", url: "http://t/big", suggestedFilename: "big.bin" });
  writeFileSync(join(tracker.dir, "big"), "partial");
  tracker.progress({ guid: "big", totalBytes: 0, receivedBytes: 50, state: "inProgress" });
  assert.equal(tracker.list().find((d) => d.fileName === "big.bin")?.state, "in_progress", "still fits");
  tracker.progress({ guid: "big", totalBytes: 0, receivedBytes: 61, state: "inProgress" });
  await tracker.settled();

  const refused = tracker.list().find((d) => d.fileName === "big.bin")!;
  assert.equal(refused.state, "canceled");
  assert.equal(refused.canceledBy, "quota");
  assert.deepEqual(stopped, ["big"]);
  assert.equal(existsSync(join(tracker.dir, "big")), false);
  assert.equal(tracker.get(refused.id)?.path, null);

  // Later reports about it change nothing.
  tracker.progress({ guid: "big", totalBytes: 61, receivedBytes: 61, state: "completed" });
  await tracker.settled();
  assert.equal(tracker.get(refused.id)?.state, "canceled");
});

test("a known size counts in full from the first report: why fetch what can't stay", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.quotaBytes = 100;
  const stopped: string[] = [];
  tracker.stopDownload = (guid) => stopped.push(guid);
  tracker.began({ guid: "g", url: "http://t/", suggestedFilename: "big.bin" });
  tracker.progress({ guid: "g", totalBytes: 101, receivedBytes: 1, state: "inProgress" });
  assert.deepEqual(stopped, ["g"]);
});

test("a download that only reveals its size at the end still counts", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.quotaBytes = 100;
  tracker.began({ guid: "g", url: "http://t/", suggestedFilename: "big.bin" });
  writeFileSync(join(tracker.dir, "g"), "x".repeat(200));
  tracker.progress({ guid: "g", totalBytes: 200, receivedBytes: 200, state: "completed" });
  await tracker.settled();
  assert.equal(tracker.list()[0]?.state, "canceled");
  assert.equal(tracker.list()[0]?.canceledBy, "quota");
  assert.deepEqual(readdirSync(tracker.dir).filter((f) => !f.startsWith(".")), []);
});

test("an engine with no progress reports its bytes under way, and every download stops at the quota", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.quotaBytes = 100;
  const stopped: string[] = [];
  tracker.stopDownload = (guid) => stopped.push(guid);
  await complete(tracker, "kept", "kept.bin", "x".repeat(40));
  tracker.began({ guid: "a", url: "http://t/a", suggestedFilename: "a.bin" });
  tracker.began({ guid: "b", url: "http://t/b", suggestedFilename: "b.bin" });
  tracker.reportBytesUnderWay(60);
  assert.deepEqual(stopped, [], "exactly the quota still fits");
  tracker.reportBytesUnderWay(61);
  assert.deepEqual(stopped.sort(), ["a", "b"]);
  await tracker.settled();
  assert.equal(tracker.list().find((d) => d.fileName === "kept.bin")?.state, "completed", "what's kept stays");
});

test("a canceled download doesn't count against the quota", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.quotaBytes = 100;
  tracker.began({ guid: "a", url: "http://t/a", suggestedFilename: "a.bin" });
  tracker.progress({ guid: "a", totalBytes: 0, receivedBytes: 90, state: "canceled" });
  await tracker.settled();
  await complete(tracker, "b", "b.bin", "x".repeat(90));
  assert.equal(tracker.list().find((d) => d.fileName === "b.bin")?.state, "completed");
});

test("a name that was quadratic costs next to nothing, and is stored capped", () => {
  for (const hostile of [`x${".".repeat(80_000)}y`, `x${" ".repeat(80_000)}y`, ".".repeat(80_000), "a".repeat(5_000_000)]) {
    const started = performance.now();
    const name = sanitizeFilename(hostile);
    assert.ok(performance.now() - started < LONG_INPUT_BUDGET_MS, `took ${performance.now() - started} ms`);
    assert.ok(name.length <= 200, `${name.length} characters`);
  }
});

test("the name is what follows the last separator, however long what comes first", () => {
  assert.equal(sanitizeFilename(`${"a/".repeat(100_000)}report.pdf`), "report.pdf");
});

test("cut in the middle of a pair, a name is still text, and fit for a header", () => {
  const name = sanitizeFilename(`${"a".repeat(180)}${"😀".repeat(30)}.bin`);
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.ok(name.endsWith(".bin"));
});

async function withIndex(entries: unknown): Promise<{ dir: string; victim: string; open: () => Promise<DownloadTracker> }> {
  const root = tempDir();
  const dir = join(root, "profiles", "p", "downloads");
  mkdirSync(dir, { recursive: true });
  const victim = join(root, "owner-token");
  writeFileSync(victim, "the secret");
  writeFileSync(join(dir, ".multizen-downloads.json"), JSON.stringify(entries));
  return { dir, victim, open: () => DownloadTracker.open(dir) };
}

const stored = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: "d1",
  guid: "guid-1",
  fileName: "report.txt",
  url: "http://t/x",
  state: "completed",
  bytesReceived: 5,
  bytesTotal: 5,
  startedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

test("an index from an archive can't read a file outside its directory", async () => {
  for (const escape of ["../../../owner-token", "..\\..\\..\\owner-token", "..", ".", "a/b", "C:evil", "name::$DATA", "x. "]) {
    const { victim, open } = await withIndex([stored({ storedAs: escape })]);
    const tracker = await open();
    assert.equal(tracker.get("d1"), null, `storedAs ${escape}`);
    assert.deepEqual(tracker.list(), []);
    assert.equal(readFileSync(victim, "utf8"), "the secret");
  }
});

test("an index from an archive can't delete a file outside its directory", async () => {
  for (const escape of ["../../../owner-token", "..\\..\\..\\owner-token"]) {
    const { victim, open } = await withIndex([stored({ guid: escape, state: "in_progress" })]);
    await open();
    assert.equal(readFileSync(victim, "utf8"), "the secret", `guid ${escape}`);
  }
});

test("an index can't name itself, and a broken entry or index costs only itself", async () => {
  const { open } = await withIndex([
    stored({ id: "self", storedAs: ".multizen-downloads.json" }),
    stored({ id: "negative", bytesReceived: -1e15 }),
    stored({ id: "extra", storedAs: "report.txt", sneaked: "field" }),
    "not an entry",
    null,
  ]);
  const tracker = await open();
  assert.deepEqual(tracker.list().map((d) => d.id), ["extra"]);
  assert.equal("sneaked" in tracker.list()[0]!, false);
  const notAList = await withIndex({ not: "a list" });
  assert.deepEqual((await notAList.open()).list(), []);
});

test("what this file wrote still loads", async () => {
  const dir = tempDir();
  const first = await DownloadTracker.open(dir);
  await complete(first, "guid-a", "a.txt");
  const { id } = first.list()[0]!;
  const again = await DownloadTracker.open(dir);
  assert.equal(readFileSync(again.get(id)!.path!, "utf8"), "bytes");
});

test("under a server's terms a name loses what only a reader can be fooled by; a desktop's doesn't", async () => {
  const hostile = "‮gpj.exe​x\u0085y z.txt";
  const limited = await DownloadTracker.open(tempDir());
  limited.limitTo(1_000_000);
  limited.began({ guid: "g", url: "http://t/", suggestedFilename: hostile });
  assert.equal(limited.list()[0]!.fileName, "gpj.exexyz.txt");

  const desktop = await DownloadTracker.open(tempDir());
  desktop.began({ guid: "g", url: "http://t/", suggestedFilename: "‮a​b.txt" });
  assert.equal(desktop.list()[0]!.fileName, "‮a​b.txt");
});

test("delete removes the file, gives its bytes back to the quota, and is on disk when it resolves", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.limitTo(10);
  await complete(tracker, "g1", "a.bin", "12345678");
  const { id } = tracker.list()[0]!;
  const path = tracker.get(id)!.path!;

  // No room for this one.
  tracker.began({ guid: "g2", url: "http://t/", suggestedFilename: "b.bin" });
  tracker.progress({ guid: "g2", totalBytes: 8, receivedBytes: 1, state: "inProgress" });
  assert.equal(tracker.list()[1]!.canceledBy, "quota");

  assert.equal(await tracker.delete(id), true);
  assert.equal(existsSync(path), false);
  assert.equal(tracker.get(id), null);
  assert.equal(await tracker.delete(id), false);
  assert.equal(await tracker.delete("never"), false);

  // And now there is.
  await complete(tracker, "g3", "c.bin", "12345678");
  assert.equal(tracker.list().at(-1)!.state, "completed");
  const reopened = await DownloadTracker.open(tracker.dir);
  assert.equal(reopened.get(id), null);
});

test("delete stops a download under way, and what the browser finishes anyway doesn't stay", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.limitTo(1_000);
  const stopped: string[] = [];
  tracker.stopDownload = (guid) => stopped.push(guid);
  tracker.began({ guid: "g1", url: "http://t/", suggestedFilename: "a.bin" });
  const { id } = tracker.list()[0]!;
  assert.equal(await tracker.delete(id), true);
  assert.deepEqual(stopped, ["g1"]);

  writeFileSync(join(tracker.dir, "g1"), "late");
  tracker.progress({ guid: "g1", totalBytes: 4, receivedBytes: 4, state: "completed" });
  await tracker.settled();
  assert.equal(existsSync(join(tracker.dir, "g1")), false);
});

test("under a server's terms a URL is capped, and entries stop at their limit", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  tracker.limitTo(1e12);
  const stopped: string[] = [];
  tracker.stopDownload = (guid) => stopped.push(guid);

  tracker.began({ guid: "first", url: `http://t/${"x".repeat(5_000)}`, suggestedFilename: "a" });
  assert.equal(tracker.list()[0]!.url.length, 2_048);
  const { id: canceledId } = tracker.list()[0]!;
  tracker.progress({ guid: "first", totalBytes: 0, receivedBytes: 0, state: "canceled" });

  for (let i = 0; i < 999; i++) {
    assert.equal(tracker.began({ guid: `g${i}`, url: "http://t/", suggestedFilename: "a" }), true);
  }
  assert.equal(tracker.list().length, 1_000);
  // Full: the canceled one makes way, then there is nothing left to forget.
  assert.equal(tracker.began({ guid: "one-more", url: "http://t/", suggestedFilename: "a" }), true);
  assert.equal(tracker.get(canceledId), null);
  assert.equal(tracker.began({ guid: "too-many", url: "http://t/", suggestedFilename: "a" }), false);
  assert.deepEqual(stopped, ["too-many"]);
  assert.equal(tracker.list().length, 1_000);
  await tracker.settled();
});

test("a desktop's tracker keeps every entry and the whole URL", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  const url = `http://t/${"x".repeat(5_000)}`;
  for (let i = 0; i < 1_001; i++) tracker.began({ guid: `g${i}`, url, suggestedFilename: "a" });
  assert.equal(tracker.list().length, 1_001);
  assert.equal(tracker.list()[0]!.url, url);
  await tracker.settled();
});

test("a burst of downloads doesn't queue a write of the whole index for each", async () => {
  const tracker = await DownloadTracker.open(tempDir());
  for (let i = 0; i < 2_000; i++) tracker.began({ guid: `g${i}`, url: "http://t/", suggestedFilename: "a" });
  const started = performance.now();
  await tracker.settled();
  assert.ok(performance.now() - started < 5_000);
  const index = JSON.parse(readFileSync(join(tracker.dir, ".multizen-downloads.json"), "utf8")) as unknown[];
  assert.equal(index.length, 2_000);
});
