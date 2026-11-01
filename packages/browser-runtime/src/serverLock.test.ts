import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireServerLock,
  liveServerLockHolder,
  processIdentity,
  ServerLockHeldError,
  type ProcessIdentity,
  type ServerLockDeps,
  type ServerLockRecord,
} from "./serverLock.ts";

const SELF_PID = 1000;
const HOLDER_PID = 2000;
const SELF: ProcessIdentity = { startTime: "self-start", cmdline: "node cli.js serve" };
const HOLDER: ProcessIdentity = { startTime: "holder-start", cmdline: "node cli.js serve" };

function deps(table: Record<number, ProcessIdentity | null | Error> = {}): ServerLockDeps {
  const processes: Record<number, ProcessIdentity | null | Error> = {
    [SELF_PID]: SELF,
    [HOLDER_PID]: HOLDER,
    ...table,
  };
  return {
    hostname: () => "box",
    pid: SELF_PID,
    processIdentity: async (pid) => {
      const found = processes[pid] ?? null;
      if (found instanceof Error) throw found;
      return found;
    },
  };
}

function record(overrides: Partial<ServerLockRecord> = {}): ServerLockRecord {
  return {
    hostname: "box",
    pid: HOLDER_PID,
    startTime: HOLDER.startTime,
    cmdline: HOLDER.cmdline,
    mode: "serve",
    acquiredAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

async function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-lock-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function plant(dir: string, value: ServerLockRecord | string): void {
  writeFileSync(
    join(dir, "server.lock"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function stored(dir: string): ServerLockRecord {
  return JSON.parse(readFileSync(join(dir, "server.lock"), "utf8")) as ServerLockRecord;
}

test("acquire writes hostname, pid and start time, and release removes the file", async () => {
  await withDir(async (dir) => {
    const lock = await acquireServerLock(
      dir,
      { mode: "serve", url: "http://127.0.0.1:1/mcp", tokenFile: "t" },
      deps(),
    );
    const written = stored(dir);
    assert.equal(written.hostname, "box");
    assert.equal(written.pid, SELF_PID);
    assert.equal(written.startTime, SELF.startTime);
    assert.equal(written.cmdline, SELF.cmdline);
    assert.equal(written.mode, "serve");
    assert.equal(written.url, "http://127.0.0.1:1/mcp");
    assert.equal(written.tokenFile, "t");
    lock.release();
    assert.equal(existsSync(lock.path), false);
    lock.release();
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("acquire creates a missing data dir", async () => {
  await withDir(async (dir) => {
    const nested = join(dir, "a", "b");
    const lock = await acquireServerLock(nested, { mode: "cli" }, deps());
    assert.equal(existsSync(lock.path), true);
    lock.release();
  });
});

test("a live holder is refused and its lock left alone", async () => {
  await withDir(async (dir) => {
    plant(dir, record());
    await assert.rejects(acquireServerLock(dir, { mode: "serve" }, deps()), (e: unknown) => {
      assert.ok(e instanceof ServerLockHeldError);
      assert.equal(e.holder.pid, HOLDER_PID);
      return true;
    });
    assert.equal(stored(dir).pid, HOLDER_PID);
  });
});

const staleCases: Array<[string, ServerLockRecord | string, Record<number, ProcessIdentity | null>?]> =
  [
    ["another hostname", record({ hostname: "other" })],
    ["our own pid, as after a container restart", record({ pid: SELF_PID })],
    ["a dead pid", record(), { [HOLDER_PID]: null }],
    ["a pid reused later (start time differs)", record({ startTime: "older" })],
    ["a pid reused by another program", record({ cmdline: "/usr/bin/other" })],
    ["a file that is not JSON", "not json"],
    ["JSON without the fields", JSON.stringify({ pid: "x" })],
    ["a half-written empty file", ""],
  ];

for (const [name, planted, table] of staleCases) {
  test(`a stale lock is taken over: ${name}`, async () => {
    await withDir(async (dir) => {
      plant(dir, planted);
      const lock = await acquireServerLock(dir, { mode: "serve" }, deps(table));
      assert.equal(stored(dir).pid, SELF_PID);
      lock.release();
    });
  });
}

test("a fixed compose hostname does not make a live holder stale", async () => {
  await withDir(async (dir) => {
    plant(dir, record({ hostname: "multizen" }));
    const fixed = { ...deps(), hostname: () => "multizen" };
    await assert.rejects(acquireServerLock(dir, { mode: "serve" }, fixed), ServerLockHeldError);
  });
});

test("an unreadable holder identity counts as held", async () => {
  await withDir(async (dir) => {
    plant(dir, record());
    const failing = deps({ [HOLDER_PID]: new Error("powershell missing") });
    await assert.rejects(acquireServerLock(dir, { mode: "serve" }, failing), ServerLockHeldError);
  });
});

test("a hidden command line is judged by start time alone", async () => {
  await withDir(async (dir) => {
    plant(dir, record());
    const hidden = deps({ [HOLDER_PID]: { startTime: HOLDER.startTime, cmdline: null } });
    await assert.rejects(acquireServerLock(dir, { mode: "serve" }, hidden), ServerLockHeldError);
  });
});

test("losing a takeover race restores the winner's lock", async () => {
  await withDir(async (dir) => {
    plant(dir, record({ startTime: "older" }));
    // While this process judges the old lock stale, another one takes it over.
    const winner = record({ pid: 3000, startTime: "winner-start" });
    let swapped = false;
    const base = deps({ 3000: { startTime: "winner-start", cmdline: HOLDER.cmdline } });
    const racing: ServerLockDeps = {
      ...base,
      processIdentity: async (pid) => {
        if (pid === HOLDER_PID && !swapped) {
          swapped = true;
          plant(dir, winner);
        }
        return base.processIdentity(pid);
      },
    };
    await assert.rejects(acquireServerLock(dir, { mode: "serve" }, racing), (e: unknown) => {
      assert.ok(e instanceof ServerLockHeldError);
      assert.equal(e.holder.pid, 3000);
      return true;
    });
    assert.equal(stored(dir).pid, 3000);
    assert.deepEqual(readdirSync(dir), ["server.lock"]);
  });
});

test("release leaves a lock that is no longer ours", async () => {
  await withDir(async (dir) => {
    const lock = await acquireServerLock(dir, { mode: "serve" }, deps());
    plant(dir, record());
    lock.release();
    assert.equal(stored(dir).pid, HOLDER_PID);
  });
});

test("acquire fails when this process cannot read its own identity", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      acquireServerLock(dir, { mode: "serve" }, deps({ [SELF_PID]: null })),
      /Cannot read the identity/,
    );
    assert.equal(existsSync(join(dir, "server.lock")), false);
  });
});

test("liveServerLockHolder: null without a file, and it asks the OS nothing", async () => {
  await withDir(async (dir) => {
    const asked: number[] = [];
    const base = deps();
    const counting: ServerLockDeps = {
      ...base,
      processIdentity: async (pid) => {
        asked.push(pid);
        return base.processIdentity(pid);
      },
    };
    assert.equal(await liveServerLockHolder(dir, counting), null);
    assert.deepEqual(asked, []);
  });
});

test("liveServerLockHolder: the record for a live holder, null for a stale one", async () => {
  await withDir(async (dir) => {
    plant(dir, record());
    assert.equal((await liveServerLockHolder(dir, deps()))?.pid, HOLDER_PID);
    assert.equal(await liveServerLockHolder(dir, deps({ [HOLDER_PID]: null })), null);
    // Stale is only reported: the desktop leaves the file where it is.
    assert.equal(existsSync(join(dir, "server.lock")), true);
    plant(dir, "garbage");
    assert.equal(await liveServerLockHolder(dir, deps()), null);
  });
});

test("liveServerLockHolder: an unreadable lock is no holder, not a failure", async () => {
  await withDir(async (dir) => {
    // A directory where the file should be: reading it throws on every platform.
    mkdirSync(join(dir, "server.lock"));
    assert.equal(await liveServerLockHolder(dir, deps()), null);
  });
});

test("processIdentity reads the real current process, stably", async () => {
  const first = await processIdentity(process.pid);
  assert.ok(first);
  assert.ok(first.startTime.length > 0);
  assert.match(first.cmdline ?? "", /node/i);
  assert.deepEqual(await processIdentity(process.pid), first);
});

test("processIdentity: null for a pid that does not exist", async () => {
  // Above any pid the OS hands out by default.
  assert.equal(await processIdentity(2 ** 30), null);
});
