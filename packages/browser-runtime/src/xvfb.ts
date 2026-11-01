import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { MultizenError, type ProfileId } from "@multizen/types";
import type { ProcessJournal } from "./runState.ts";

const READY_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_048;
const COOKIE_NAME = "MIT-MAGIC-COOKIE-1";
const FAMILY_WILD = 0xffff;
const INSTALL_HINT = 'Check that Xvfb runs on this machine, or use display_mode "headless".';

export interface XvfbHandle {
  display: string;
  pid: number;
  authFile: string;
  /** Ends the server and removes its auth file. Safe to call on every exit path. */
  stop(): Promise<void>;
}

export interface StartXvfbOptions {
  width: number;
  height: number;
  /** Each server's auth file goes in a private directory created under this. */
  runDir: string;
  /** Told about the server as soon as it exists, and when it exits. */
  journal?: { processJournal: ProcessJournal; profileId: ProfileId };
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

/** Whether `Xvfb` is on the PATH and can be executed. */
export function hasXvfbBinary(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "Xvfb"), fsConstants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

function lengthPrefixed(bytes: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * One Xauthority record: FamilyWild, so it matches whatever address the client asks
 * for, with an empty address and display. Written directly, so nothing depends on an
 * `xauth` binary, and so the server never has to run open with `-ac`.
 */
export function xauthorityRecord(cookie: Buffer): Buffer {
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([
    family,
    lengthPrefixed(Buffer.alloc(0)),
    lengthPrefixed(Buffer.alloc(0)),
    lengthPrefixed(Buffer.from(COOKIE_NAME, "latin1")),
    lengthPrefixed(cookie),
  ]);
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM, then SIGKILL if it doesn't take. Bounded: a stuck child can't hold up a close. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const within = (): Promise<void> =>
    Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref())]);
  child.kill("SIGTERM");
  await within();
  if (exited(child)) return;
  child.kill("SIGKILL");
  await within();
}

/**
 * A private X server for one browser. It picks its own free display and reports it on
 * fd 3 once it accepts connections, so there is no port race and no polling. It listens
 * on a local socket only, takes clients by its own auth file only, and sees none of this
 * process's environment.
 */
export async function startXvfb(o: StartXvfbOptions): Promise<XvfbHandle> {
  const spawnFn = o.spawnFn ?? spawn;
  const timeoutMs = o.timeoutMs ?? READY_TIMEOUT_MS;
  await mkdir(o.runDir, { recursive: true });
  const dir = await mkdtemp(join(o.runDir, "mz-xvfb-"));
  const removeDir = (): Promise<void> => rm(dir, { recursive: true, force: true }).catch(() => {});
  const authFile = join(dir, "Xauthority");
  await writeFile(authFile, xauthorityRecord(randomBytes(16)), { mode: 0o600 });

  let child: ChildProcess;
  try {
    child = spawnFn(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        `${o.width}x${o.height}x24`,
        "-nolisten",
        "tcp",
        "-auth",
        authFile,
        "-noreset",
      ],
      {
        // Its own session: a terminal's Ctrl+C reaches this process, which then stops it.
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
    );
  } catch (e) {
    await removeDir();
    throw new MultizenError("DISPLAY_UNAVAILABLE", `Xvfb failed to start: ${(e as Error).message}`, {
      hint: INSTALL_HINT,
    });
  }

  const { pid } = child;
  if (o.journal && pid) {
    const { processJournal, profileId } = o.journal;
    processJournal.add({ kind: "xvfb", profileId, pid, authFile, startedAt: new Date().toISOString() });
    child.once("exit", () => processJournal.remove(pid));
  }

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  return new Promise<XvfbHandle>((resolve, reject) => {
    let settled = false;
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = stderrTail.trim();
      void stopChild(child)
        .then(removeDir)
        .then(() =>
          reject(
            new MultizenError("DISPLAY_UNAVAILABLE", `Xvfb ${why}${tail ? `: ${tail}` : ""}`, {
              hint: INSTALL_HINT,
            }),
          ),
        );
    };
    const timer = setTimeout(
      () => fail(`did not report a display within ${timeoutMs} ms`),
      timeoutMs,
    );
    // A failed spawn arrives here, and with no listener it would end the process.
    child.on("error", (e) => fail(`failed to start: ${e.message}`));
    child.on("exit", (code, signal) => fail(`exited at once (${signal ?? code})`));

    const announcements = child.stdio[3] as Readable | null | undefined;
    if (!announcements) {
      fail("gave no way to report its display");
      return;
    }
    announcements.on("error", (e) => fail(`could not report its display: ${e.message}`));
    let announced = "";
    announcements.on("data", (chunk: Buffer) => {
      if (settled) return;
      announced += chunk.toString("latin1");
      const end = announced.indexOf("\n");
      if (end === -1) return;
      const number = announced.slice(0, end).trim();
      if (!/^\d+$/.test(number)) {
        fail(`reported "${number}" as its display`);
        return;
      }
      settled = true;
      clearTimeout(timer);
      announcements.destroy();
      let stopping: Promise<void> | null = null;
      resolve({
        display: `:${number}`,
        pid: child.pid ?? 0,
        authFile,
        stop: () => (stopping ??= stopChild(child).then(removeDir)),
      });
    });
  });
}
