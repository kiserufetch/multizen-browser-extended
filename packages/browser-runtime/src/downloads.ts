import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import type { DownloadFile, DownloadRecord } from "@multizen/types";

/** Kept next to the files, so a profile's downloads survive a restart of the server. */
const INDEX_FILE = ".multizen-downloads.json";
const MAX_FILE_NAME_CHARS = 200;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
/** On Windows the browser or a scanner can still hold a file just reported complete. */
const RENAME_ATTEMPTS = 8;
const RENAME_RETRY_MS = 250;

/**
 * A safe file name from one a web server suggested: no directories, nothing a
 * filesystem would reinterpret, on any platform. Hostile input is the normal case.
 */
export function sanitizeFilename(suggested: string): string {
  const base = suggested.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  if (!cleaned) return "download";
  const { name, ext } = parse(cleaned);
  // The tail of the extension, the head of the name: what a reader needs of each.
  const keptExt = ext.slice(-20);
  const keptName = name.slice(0, MAX_FILE_NAME_CHARS - keptExt.length).replace(/[. ]+$/, "");
  const result = `${keptName}${keptExt}`;
  return WINDOWS_RESERVED_NAME.test(keptName.split(".")[0]!.trimEnd()) ? `_${result}` : result;
}

interface Entry extends DownloadRecord {
  /** The browser's id, which is also the file's name until it completes. */
  guid: string;
  /** The file's name in the directory, once it has its final name. */
  storedAs?: string;
}

/**
 * The downloads of one profile. The browser writes each to `<dir>/<guid>`
 * (`allowAndName`). On completion it gets the sanitized name the server suggested,
 * unique in the directory. An id is generated here and looks up an entry; a name that
 * came from the web is never used to find a path.
 */
export class DownloadTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly idByGuid = new Map<string, string>();
  /** Renames and index writes, one at a time, in event order. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(readonly dir: string) {}

  /** Reads what an earlier run left. An unfinished download of that run is over. */
  static async open(dir: string): Promise<DownloadTracker> {
    const tracker = new DownloadTracker(dir);
    await mkdir(dir, { recursive: true });
    let stored: Entry[] = [];
    try {
      stored = JSON.parse(await readFile(join(dir, INDEX_FILE), "utf8")) as Entry[];
    } catch {
      // No index yet, or an unreadable one: nothing to list.
    }
    for (const entry of stored) {
      if (entry.state === "in_progress") {
        entry.state = "canceled";
        await rm(join(dir, entry.guid), { force: true }).catch(() => {});
      }
      tracker.entries.set(entry.id, entry);
    }
    return tracker;
  }

  began(event: { guid: string; url: string; suggestedFilename: string }): void {
    const id = randomUUID();
    this.idByGuid.set(event.guid, id);
    this.entries.set(id, {
      id,
      guid: event.guid,
      fileName: sanitizeFilename(event.suggestedFilename),
      url: event.url,
      state: "in_progress",
      bytesReceived: 0,
      bytesTotal: null,
      startedAt: new Date().toISOString(),
    });
    this.enqueue(() => this.save());
  }

  progress(event: {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: "inProgress" | "completed" | "canceled";
  }): void {
    const entry = this.entries.get(this.idByGuid.get(event.guid) ?? "");
    if (!entry || entry.state !== "in_progress") return;
    entry.bytesReceived = event.receivedBytes;
    entry.bytesTotal = event.totalBytes > 0 ? event.totalBytes : null;
    if (event.state === "completed") {
      this.enqueue(async () => {
        await this.finish(entry);
        await this.save();
      });
    } else if (event.state === "canceled") {
      entry.state = "canceled";
      this.enqueue(async () => {
        await rm(join(this.dir, entry.guid), { force: true }).catch(() => {});
        await this.save();
      });
    }
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch(() => {
      // An index that can't be written costs a listing after a restart, not this download.
    });
  }

  /** Reads as completed only after its rename: `path` must point at a finished file. */
  private async finish(entry: Entry): Promise<void> {
    const name = this.uniqueName(entry.fileName);
    let storedAs = entry.guid;
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(join(this.dir, entry.guid), join(this.dir, name));
        storedAs = name;
        break;
      } catch {
        // Still locked, or gone. Out of attempts it keeps its guid name, still reachable.
        if (attempt >= RENAME_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
      }
    }
    entry.storedAs = storedAs;
    if (storedAs === name) entry.fileName = name;
    entry.state = "completed";
  }

  private uniqueName(fileName: string): string {
    const { name, ext } = parse(fileName);
    let candidate = fileName;
    for (let n = 1; existsSync(join(this.dir, candidate)); n++) {
      candidate = `${name} (${n})${ext}`;
    }
    return candidate;
  }

  private async save(): Promise<void> {
    const temp = join(this.dir, `${INDEX_FILE}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify([...this.entries.values()]));
    await rename(temp, join(this.dir, INDEX_FILE));
  }

  /** Resolves when everything reported so far has reached the disk. */
  settled(): Promise<void> {
    return this.queue;
  }

  list(): DownloadRecord[] {
    return [...this.entries.values()].map(publicRecord);
  }

  /** Null for an id it never issued. A file deleted since then has no path. */
  get(id: string): DownloadFile | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const path = entry.storedAs ? join(this.dir, entry.storedAs) : null;
    return { ...publicRecord(entry), path: path && existsSync(path) ? path : null };
  }
}

const sharedTrackers = new Map<string, Promise<DownloadTracker>>();

/**
 * The one tracker of a directory in this process, kept past the browser so a finished
 * download stays reachable after it closes. Both engines' drivers and the router reach
 * it: a profile can change engine, and two trackers would overwrite each other's index.
 * A directory that failed to open is tried again by the next caller.
 */
export function sharedDownloadTracker(dir: string): Promise<DownloadTracker> {
  let tracker = sharedTrackers.get(dir);
  if (!tracker) {
    tracker = DownloadTracker.open(dir);
    sharedTrackers.set(dir, tracker);
    tracker.catch(() => sharedTrackers.delete(dir));
  }
  return tracker;
}

function publicRecord(entry: Entry): DownloadRecord {
  const { guid: _guid, storedAs: _storedAs, ...record } = entry;
  return record;
}
