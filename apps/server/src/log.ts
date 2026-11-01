import { Writable } from "node:stream";
import { format } from "node:util";

/**
 * JSON-lines logging for the server. This module must load, and installLogging
 * must run, before anything else: moved driver code and camoufox-js write to
 * console.log, and one stray line on stdout corrupts a stdio client's JSON-RPC
 * stream. So it imports nothing but Node builtins, and cli.ts loads every other
 * module dynamically afterwards.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);

let writeLine: (line: string) => unknown = writeStdout;

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const configuredLevel = process.env.MULTIZEN_LOG_LEVEL?.toLowerCase();
const knownLevel = configuredLevel !== undefined && Object.hasOwn(LEVELS, configuredLevel);
/** MULTIZEN_LOG_LEVEL: nothing below it is written. Default `info`: a browser's stderr is `debug`. */
const minimumLevel = knownLevel ? LEVELS[configuredLevel as LogLevel] : LEVELS.info;

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < minimumLevel) return;
  const ts = new Date().toISOString();
  let line: string;
  try {
    line = JSON.stringify({ ts, level, msg, ...fields });
  } catch {
    // A cyclic or BigInt field must not take the message down with it.
    line = JSON.stringify({ ts, level, msg });
  }
  writeLine(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: LogFields): void => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};

export function errorFields(e: unknown): LogFields {
  return e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) };
}

/** Wraps whatever a library writes directly to a stream as one JSON line each. */
function strayWriter(level: LogLevel, source: string): typeof process.stdout.write {
  return ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) emit(level, line, { source });
    }
    const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    done?.();
    return true;
  }) as typeof process.stdout.write;
}

/**
 * Rebinds console.* and both process streams so that everything leaves as a JSON
 * line on `target`: stdout normally, stderr in stdio mode, where stdout belongs to
 * the protocol and only {@link protocolStdout} may touch it.
 */
export function installLogging(target: "stdout" | "stderr"): void {
  writeLine = target === "stderr" ? writeStderr : writeStdout;
  if (configuredLevel !== undefined && !knownLevel) {
    emit("warn", "MULTIZEN_LOG_LEVEL is not debug, info, warn or error: using info", {
      value: process.env.MULTIZEN_LOG_LEVEL,
    });
  }

  console.debug = (...args: unknown[]) => emit("debug", format(...args));
  console.log = (...args: unknown[]) => emit("info", format(...args));
  console.info = (...args: unknown[]) => emit("info", format(...args));
  console.warn = (...args: unknown[]) => emit("warn", format(...args));
  console.error = (...args: unknown[]) => emit("error", format(...args));

  process.stdout.write = strayWriter("info", "stdout");
  process.stderr.write = strayWriter("warn", "stderr");

  // A client that went away closes our pipes. That must not surface as an
  // uncaught exception: stdin EOF already runs the shutdown.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") throw e;
    });
  }
}

/** The real stdout, for the stdio protocol transport only. */
export const protocolStdout = new Writable({
  write(chunk: Buffer, _encoding, done) {
    writeStdout(chunk, () => done());
  },
});

/**
 * Resolves once buffered output has reached the OS. On Windows, writes to a pipe
 * are asynchronous, so process.exit() right after a log call can lose the line:
 * for a refused start that line is the whole point.
 */
export function flushLogs(timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    let pending = 2;
    const drained = (): void => {
      pending -= 1;
      if (pending === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    writeStdout("", drained);
    writeStderr("", drained);
  });
}
