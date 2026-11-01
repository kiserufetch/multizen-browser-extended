import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, parse } from "node:path";
import { trimEndChars, wellFormed, type DownloadFile, type DownloadRecord } from "@multizen/types";

/** Kept next to the files, so a profile's downloads survive a restart of the server. */
const INDEX_FILE = ".multizen-downloads.json";
const MAX_FILE_NAME_CHARS = 200;
/** A page can suggest any length: past this nobody reads it, and no regex should. */
const MAX_SUGGESTED_NAME_CHARS = 4_096;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
/** What a name can hold to mislead a reader or a log: bidi overrides, zero-width marks, line breaks. */
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** On Windows the browser or a scanner can still hold a file just reported complete. */
const RENAME_ATTEMPTS = 8;
const RENAME_RETRY_MS = 250;
/** What a server lets one profile's downloads take. */
export const DOWNLOAD_QUOTA_BYTES = 2 * 1024 ** 3;
/** Each one is a line in an index rewritten on every change, and a page can start them by the thousand. */
const MAX_DOWNLOAD_ENTRIES = 1_000;
const MAX_DOWNLOAD_URL_CHARS = 2_048;

/**
 * A safe file name from one a web server suggested: no directories, nothing a
 * filesystem would reinterpret, on any platform. Hostile input is the normal case.
 * `stripInvisible` also takes out what only a person reading the name can be fooled by.
 */
export function sanitizeFilename(suggested: string, opts: { stripInvisible?: boolean } = {}): string {
  // The tail, as the name is what follows the last separator.
  const capped = suggested.slice(-MAX_SUGGESTED_NAME_CHARS);
  const visible = opts.stripInvisible ? capped.replace(INVISIBLE_CHARS, "") : capped;
  const base = visible.split(/[\\/]/).pop() ?? "";
  const cleaned = trimEndChars(base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^[. ]+/, ""), ". ");
  if (!cleaned) return "download";
  const { name, ext } = parse(cleaned);
  // The tail of the extension, the head of the name: what a reader needs of each.
  const keptExt = ext.slice(-20);
  const keptName = trimEndChars(name.slice(0, MAX_FILE_NAME_CHARS - keptExt.length), ". ");
  const result = wellFormed(`${keptName}${keptExt}`);
  return WINDOWS_RESERVED_NAME.test(keptName.split(".")[0]!.trimEnd()) ? `_${result}` : result;
}

/**
 * A plain file in this directory. The index can come from an imported archive, whoever made
 * it, and `guid` and `storedAs` get read and deleted: `../../../owner-token` must be neither.
 */
function isStoredFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "" &&
    name === basename(name) &&
    !/[\\/:\0]|[. ]$/.test(name) &&
    !name.startsWith(INDEX_FILE)
  );
}

/** Only what this file wrote passes, with nothing added: the index isn't trusted. */
function storedEntry(value: unknown): Entry | null {
  const e = value as Partial<Entry> | null;
  if (
    typeof e?.id !== "string" ||
    !isStoredFileName(e.guid) ||
    (e.storedAs !== undefined && !isStoredFileName(e.storedAs)) ||
    (e.state !== "in_progress" && e.state !== "completed" && e.state !== "canceled") ||
    typeof e.bytesReceived !== "number" ||
    !(e.bytesReceived >= 0) ||
    (e.bytesTotal !== null && typeof e.bytesTotal !== "number") ||
    typeof e.fileName !== "string" ||
    typeof e.url !== "string" ||
    typeof e.startedAt !== "string"
  ) {
    return null;
  }
  return {
    id: e.id,
    guid: e.guid,
    fileName: sanitizeFilename(e.fileName),
    url: e.url,
    state: e.state,
    bytesReceived: e.bytesReceived,
    bytesTotal: e.bytesTotal ?? null,
    startedAt: e.startedAt,
    ...(e.storedAs !== undefined ? { storedAs: e.storedAs } : {}),
    ...(e.canceledBy === "quota" ? { canceledBy: e.canceledBy } : {}),
  };
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
  /**
   * What this profile's downloads may take. Over it a download is stopped and deleted.
   * Default none: a person's downloads on a desktop aren't ours to stop.
   */
  quotaBytes = Infinity;
  /** Stops a download in the browser, by its guid. Set by the driver that runs it. */
  stopDownload: ((guid: string) => void) | null = null;
  /** See {@link limitTo}. */
  private limited = false;
  /** A save waiting in the queue writes whatever has changed by then. */
  private saveQueued = false;

  private constructor(readonly dir: string) {}

  /** Reads what an earlier run left. An unfinished download of that run is over. */
  static async open(dir: string): Promise<DownloadTracker> {
    const tracker = new DownloadTracker(dir);
    await mkdir(dir, { recursive: true });
    let stored: unknown = [];
    try {
      stored = JSON.parse(await readFile(join(dir, INDEX_FILE), "utf8"));
    } catch {
      // No index yet, or an unreadable one: nothing to list.
    }
    for (const value of Array.isArray(stored) ? (stored as unknown[]) : []) {
      const entry = storedEntry(value);
      if (!entry) continue;
      if (entry.state === "in_progress") {
        entry.state = "canceled";
        await rm(join(dir, entry.guid), { force: true }).catch(() => {});
      }
      tracker.entries.set(entry.id, entry);
    }
    return tracker;
  }

  /**
   * A server's terms, for pages it has no reason to trust: a quota, a bound on how much of a
   * page's input it keeps, and names with nothing invisible in them. A desktop sets none of it.
   */
  limitTo(quotaBytes: number): void {
    this.quotaBytes = quotaBytes;
    this.limited = true;
  }

  /** False when it won't be kept: the caller's download has to go, as nothing will track it. */
  began(event: { guid: string; url: string; suggestedFilename: string }): boolean {
    if (this.limited && !this.makeRoomForEntry()) {
      console.warn(`[multizen] downloads of ${this.dir} are at their limit of ${MAX_DOWNLOAD_ENTRIES}: refusing one`);
      this.stopDownload?.(event.guid);
      return false;
    }
    const id = randomUUID();
    this.idByGuid.set(event.guid, id);
    this.entries.set(id, {
      id,
      guid: event.guid,
      fileName: sanitizeFilename(event.suggestedFilename, { stripInvisible: this.limited }),
      url: this.limited ? event.url.slice(0, MAX_DOWNLOAD_URL_CHARS) : event.url,
      state: "in_progress",
      bytesReceived: 0,
      bytesTotal: null,
      startedAt: new Date().toISOString(),
    });
    this.enqueueSave();
    return true;
  }

  /** The oldest canceled one goes. One that holds a file stays until delete_download. */
  private makeRoomForEntry(): boolean {
    if (this.entries.size < MAX_DOWNLOAD_ENTRIES) return true;
    for (const entry of this.entries.values()) {
      if (entry.state !== "canceled") continue;
      this.entries.delete(entry.id);
      this.idByGuid.delete(entry.guid);
      return true;
    }
    return false;
  }

  progress(event: {
    guid: string;
    totalBytes: number;
    receivedBytes: number;
    state: "inProgress" | "completed" | "canceled";
  }): void {
    const entry = this.entries.get(this.idByGuid.get(event.guid) ?? "");
    if (!entry) {
      // Refused or deleted, and the browser got to finish anyway: nothing would ever count this file.
      if (this.limited && event.state === "completed" && isStoredFileName(event.guid)) {
        this.enqueue(() => rm(join(this.dir, event.guid), { force: true }));
      }
      return;
    }
    if (entry.state !== "in_progress") return;
    entry.bytesReceived = event.receivedBytes;
    entry.bytesTotal = event.totalBytes > 0 ? event.totalBytes : null;
    if (event.state !== "canceled" && this.usedBytes() > this.quotaBytes) {
      this.refuseOverQuota(entry);
      return;
    }
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

  /**
   * For an engine whose downloads report no progress: the bytes all of them have on disk so
   * far. Past the quota every one under way is stopped, since which is at fault can't be told.
   */
  reportBytesUnderWay(bytes: number): void {
    if (this.completedBytes() + bytes <= this.quotaBytes) return;
    for (const entry of this.entries.values()) {
      if (entry.state === "in_progress") this.refuseOverQuota(entry);
    }
  }

  private completedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "completed") total += entry.bytesReceived;
    }
    return total;
  }

  /** A download of known size counts in full from its first report: why fetch what can't stay. */
  private usedBytes(): number {
    let total = this.completedBytes();
    for (const entry of this.entries.values()) {
      if (entry.state === "in_progress") total += Math.max(entry.bytesReceived, entry.bytesTotal ?? 0);
    }
    return total;
  }

  private refuseOverQuota(entry: Entry): void {
    entry.state = "canceled";
    entry.canceledBy = "quota";
    this.stopDownload?.(entry.guid);
    this.enqueue(async () => {
      await rm(join(this.dir, entry.guid), {
        force: true,
        maxRetries: RENAME_ATTEMPTS,
        retryDelay: RENAME_RETRY_MS,
      }).catch(() => {});
      await this.save();
    });
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

  private enqueueSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.enqueue(async () => {
      this.saveQueued = false;
      await this.save();
    });
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

  /**
   * Stops it if it is under way, removes its file and forgets it, which is what gives its bytes
   * back to the quota. False for an id it never issued. Resolves once that is on disk.
   */
  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this.idByGuid.delete(entry.guid);
    if (entry.state === "in_progress") this.stopDownload?.(entry.guid);
    this.enqueue(async () => {
      // `storedAs` read here: a rename ahead of this in the queue may just have set it.
      for (const name of [entry.guid, entry.storedAs]) {
        if (name === undefined) continue;
        await rm(join(this.dir, name), {
          force: true,
          maxRetries: RENAME_ATTEMPTS,
          retryDelay: RENAME_RETRY_MS,
        }).catch(() => {});
      }
      await this.save();
    });
    await this.settled();
    return true;
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
