import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxInstructions } from "@multizen/browser-runtime";
import {
  preflightProcess,
  preflightUserNamespaces,
  SandboxPreflightError,
  type PreflightDeps,
} from "./sandboxPreflight.ts";

interface Rig extends PreflightDeps {
  calls: Array<{ command: string; args: readonly string[] }>;
  warnings: Array<{ message: string; fields?: Record<string, unknown> }>;
}

function rig(overrides: Partial<PreflightDeps> = {}): Rig {
  const calls: Rig["calls"] = [];
  const warnings: Rig["warnings"] = [];
  return {
    calls,
    warnings,
    platform: "linux",
    getuid: () => 1000,
    pid: 4242,
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    warn: (message, fields) => warnings.push({ message, ...(fields ? { fields } : {}) }),
    instructions: () => "the instructions",
    modeOf: () => 0o700,
    ...overrides,
  };
}

function withDataDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mz-preflight-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uid 0 is a hard error, before anything is written", () => {
  withDataDir((dir) => {
    const deps = rig({ getuid: () => 0 });
    assert.throws(() => preflightProcess(join(dir, "new"), deps), (e: unknown) => {
      assert.ok(e instanceof SandboxPreflightError);
      assert.match(e.message, /root/);
      return true;
    });
    assert.equal(existsSync(join(dir, "new")), false);
    assert.equal(deps.calls.length, 0);
  });
});

test("a usable data dir passes: the probe ran from it, executable, and is gone", () => {
  withDataDir((dir) => {
    const dataDir = join(dir, "created", "here");
    const ran: string[] = [];
    const deps = rig({
      spawnSync: (command) => {
        assert.equal(readFileSync(command, "utf8"), "#!/bin/sh\nexit 0\n");
        ran.push(command);
        return { status: 0 };
      },
    });
    preflightProcess(dataDir, deps);
    assert.equal(ran.length, 1);
    assert.equal(dirname(ran[0]!), dataDir);
    assert.equal(readdirSync(dataDir).length, 0, "the probe was left behind");
  });
});

test("a noexec volume is a hard error that says so, and leaves nothing", () => {
  withDataDir((dir) => {
    const deps = rig({
      spawnSync: () => ({ status: null, error: Object.assign(new Error("spawnSync EACCES"), { code: "EACCES" }) }),
    });
    assert.throws(() => preflightProcess(dir, deps), (e: unknown) => {
      assert.ok(e instanceof SandboxPreflightError);
      assert.match(e.message, /noexec/);
      assert.match(e.message, /EACCES/);
      return true;
    });
    assert.equal(readdirSync(dir).length, 0);
  });
});

test("a data dir that can't be written is a hard error naming the directory and the user", () => {
  withDataDir((dir) => {
    // A file where the directory should be fails on every platform, whoever runs this.
    const notADir = join(dir, "file");
    writeFileSync(notADir, "");
    const dataDir = join(notADir, "data");
    assert.throws(() => preflightProcess(dataDir, rig()), (e: unknown) => {
      assert.ok(e instanceof SandboxPreflightError);
      assert.ok(e.message.includes(dataDir));
      assert.match(e.message, /uid 1000/);
      return true;
    });
  });
});

test("off Linux there is nothing to check: no probe and no write", () => {
  withDataDir((dir) => {
    const deps = rig({ platform: "win32", getuid: () => 0 });
    preflightProcess(join(dir, "new"), deps);
    preflightUserNamespaces(["cloakbrowser"], deps);
    assert.equal(existsSync(join(dir, "new")), false);
    assert.equal(deps.calls.length, 0);
    assert.equal(deps.warnings.length, 0);
  });
});

test("the namespace probe takes the sandbox's own steps, and stays quiet when they work", () => {
  const deps = rig();
  preflightUserNamespaces(["cloakbrowser"], deps);
  assert.deepEqual(deps.calls, [
    { command: "unshare", args: ["--user", "--map-root-user", "--pid", "--net", "--fork", "true"] },
  ]);
  assert.equal(deps.warnings.length, 0);
});

test("a denied probe warns with the instructions and doesn't refuse: AppArmor can be per binary", () => {
  const deps = rig({
    spawnSync: () => ({ status: 1, stderr: "unshare: unshare failed: Operation not permitted\n" }),
  });
  preflightUserNamespaces(["cloakbrowser", "camoufox"], deps);
  assert.equal(deps.warnings.length, 1);
  assert.match(deps.warnings[0]!.message, /SANDBOX_UNAVAILABLE/);
  assert.match(deps.warnings[0]!.message, /the instructions/);
  assert.match(String(deps.warnings[0]!.fields?.detail), /Operation not permitted/);
});

test("no unshare binary can't prove anything either: the same warning", () => {
  const deps = rig({
    spawnSync: () => ({ status: null, error: new Error("spawnSync unshare ENOENT") }),
  });
  preflightUserNamespaces(["cloakbrowser"], deps);
  assert.equal(deps.warnings.length, 1);
  assert.match(String(deps.warnings[0]!.fields?.detail), /ENOENT/);
});

test("when Camoufox is the only engine in use, nothing is probed or warned about", () => {
  const deps = rig({ spawnSync: () => ({ status: 1 }) });
  preflightUserNamespaces(["camoufox", "camoufox"], deps);
  preflightUserNamespaces([], deps);
  assert.equal(deps.warnings.length, 0);
});

test("the instructions name the shipped profile, and the host's own knob when it is the cause", () => {
  assert.match(sandboxInstructions("none"), /seccomp=docker\/seccomp-chromium\.json/);
  assert.doesNotMatch(sandboxInstructions("none"), /sysctl/);
  assert.match(sandboxInstructions("apparmor"), /kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(sandboxInstructions("clone"), /kernel\.unprivileged_userns_clone=1/);
  assert.doesNotMatch(sandboxInstructions("clone"), /--no-sandbox/);
});

test("a data dir others can read is said out loud, and left as it is", () => {
  withDataDir((dir) => {
    const open = rig({ modeOf: () => 0o755 });
    preflightProcess(dir, open);
    assert.equal(open.warnings.length, 1);
    assert.match(open.warnings[0]!.message, /read by other users \(mode 755\)/);

    const closed = rig({ modeOf: () => 0o700 });
    preflightProcess(dir, closed);
    assert.deepEqual(closed.warnings, []);
  });
});
