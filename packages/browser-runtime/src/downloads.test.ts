import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadTracker, sanitizeFilename } from "./downloads.ts";

const DIRS: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mz-dl-"));
  DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
