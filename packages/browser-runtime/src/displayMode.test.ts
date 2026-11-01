import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultizenError, type DisplayMode, type DisplayModeSetting } from "@multizen/types";
import { defaultSettingsPath, SettingsStore } from "@multizen/settings-store";
import {
  displayEnv,
  HEADLESS_CHROMIUM_ARGS,
  resolveDisplayMode,
  type DisplayModeInputs,
} from "./displayMode.ts";

const LINUX_DESKTOP = { platform: "linux", env: { DISPLAY: ":0" }, hasXvfb: () => true } as const;
const LINUX_SERVER = { platform: "linux", env: {}, hasXvfb: () => true } as const;
const LINUX_BARE = { platform: "linux", env: {}, hasXvfb: () => false } as const;
const WINDOWS = { platform: "win32", env: {}, hasXvfb: () => false } as const;
const MACOS = { platform: "darwin", env: {}, hasXvfb: () => false } as const;

function resolve(i: Partial<DisplayModeInputs>): DisplayMode {
  return resolveDisplayMode({ flag: "headed", ...LINUX_DESKTOP, ...i });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MultizenError, `not a MultizenError: ${String(e)}`);
    return e.code;
  }
  return assert.fail("expected a refusal");
}

// ── priority ─────────────────────────────────────────────────────────────────

/** Every level on, then off from the top: each one must win over all those below it. */
test("priority: forced, then explicit, then profile, then setting, then flag", () => {
  const all = {
    forced: "headless",
    explicit: "headless",
    profile: "xvfb",
    setting: "headed",
    flag: "xvfb",
  } as const;
  assert.equal(resolve(all), "headless", "forced");
  assert.equal(resolve({ ...all, forced: undefined }), "headless", "explicit");
  assert.equal(resolve({ ...all, forced: undefined, explicit: undefined }), "xvfb", "profile");
  assert.equal(
    resolve({ ...all, forced: undefined, explicit: undefined, profile: undefined }),
    "headed",
    "setting",
  );
  assert.equal(
    resolve({ ...all, forced: undefined, explicit: undefined, profile: undefined, setting: undefined }),
    "xvfb",
    "flag",
  );
});

/** Each adjacent pair, both ways, across every value: no level leaks past the one above it. */
test("priority: the whole matrix of explicit, profile, setting and flag", () => {
  const modes: Array<DisplayMode | undefined> = [undefined, "headed", "xvfb", "headless"];
  const flags: DisplayModeSetting[] = ["headed", "xvfb", "headless", "auto"];
  for (const explicit of modes) {
    for (const profile of modes) {
      for (const setting of modes) {
        for (const flag of flags) {
          const expected = explicit ?? profile ?? setting ?? (flag === "auto" ? "headed" : flag);
          assert.equal(
            resolve({ explicit, profile, setting, flag }),
            expected,
            JSON.stringify({ explicit, profile, setting, flag }),
          );
        }
      }
    }
  }
});

test("--headless: a profile saved as headed runs headless, and so does every other level", () => {
  const forced = "headless";
  assert.equal(resolve({ forced, profile: "headed" }), "headless");
  assert.equal(resolve({ forced, profile: "xvfb" }), "headless");
  assert.equal(resolve({ forced, setting: "headed" }), "headless");
  assert.equal(resolve({ forced, flag: "headed" }), "headless");
  assert.equal(resolve({ forced, flag: "auto" }), "headless");
  assert.equal(resolve({ forced, ...WINDOWS, profile: "xvfb" }), "headless", "never tries xvfb");
});

test("--headless: an explicit request that contradicts it is INVALID_INPUT", () => {
  for (const explicit of ["headed", "xvfb"] as const) {
    assert.equal(codeOf(() => resolve({ forced: "headless", explicit })), "INVALID_INPUT");
  }
  assert.equal(resolve({ forced: "headless", explicit: "headless" }), "headless");
});

test("the conflict is reported before availability: the fix is the same either way", () => {
  assert.equal(
    codeOf(() => resolve({ forced: "headless", explicit: "xvfb", ...WINDOWS })),
    "INVALID_INPUT",
  );
});

// ── auto ─────────────────────────────────────────────────────────────────────

test("auto: Linux without DISPLAY takes xvfb when it is there, otherwise headless", () => {
  assert.equal(resolve({ flag: "auto", ...LINUX_SERVER }), "xvfb");
  assert.equal(resolve({ flag: "auto", ...LINUX_BARE }), "headless");
});

test("auto: Linux with DISPLAY is headed; Windows and macOS are always headed", () => {
  assert.equal(resolve({ flag: "auto", ...LINUX_DESKTOP }), "headed");
  assert.equal(resolve({ flag: "auto", ...WINDOWS }), "headed");
  assert.equal(resolve({ flag: "auto", ...MACOS }), "headed");
});

test("auto: a Wayland socket alone is no DISPLAY, since Chromium speaks X11 here", () => {
  assert.equal(
    resolve({ flag: "auto", platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, hasXvfb: () => false }),
    "headless",
  );
});

test("auto never asks for a binary it doesn't need", () => {
  const hasXvfb = (): boolean => assert.fail("no need to look");
  assert.equal(resolve({ flag: "auto", ...LINUX_DESKTOP, hasXvfb }), "headed");
  assert.equal(resolve({ flag: "auto", ...WINDOWS, hasXvfb }), "headed");
});

// ── availability ─────────────────────────────────────────────────────────────

test("headed with no display is DISPLAY_UNAVAILABLE, at every level that can ask for it", () => {
  assert.equal(codeOf(() => resolve({ explicit: "headed", ...LINUX_SERVER })), "DISPLAY_UNAVAILABLE");
  assert.equal(codeOf(() => resolve({ profile: "headed", ...LINUX_SERVER })), "DISPLAY_UNAVAILABLE");
  assert.equal(codeOf(() => resolve({ setting: "headed", ...LINUX_SERVER })), "DISPLAY_UNAVAILABLE");
  assert.equal(codeOf(() => resolve({ flag: "headed", ...LINUX_SERVER })), "DISPLAY_UNAVAILABLE");
});

test("headed on a Wayland-only session goes through, as it does today", () => {
  assert.equal(
    resolve({ explicit: "headed", platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, hasXvfb: () => false }),
    "headed",
  );
});

test("headed on Windows and macOS needs no display variables", () => {
  assert.equal(resolve({ explicit: "headed", ...WINDOWS }), "headed");
  assert.equal(resolve({ explicit: "headed", ...MACOS }), "headed");
});

test("xvfb off Linux is DISPLAY_UNAVAILABLE, with the way out in the hint", () => {
  for (const platform of [WINDOWS, MACOS]) {
    assert.equal(codeOf(() => resolve({ explicit: "xvfb", ...platform })), "DISPLAY_UNAVAILABLE");
    assert.equal(codeOf(() => resolve({ profile: "xvfb", ...platform })), "DISPLAY_UNAVAILABLE");
    assert.equal(codeOf(() => resolve({ flag: "xvfb", ...platform })), "DISPLAY_UNAVAILABLE");
  }
  assert.throws(
    () => resolve({ explicit: "xvfb", ...WINDOWS }),
    (e: MultizenError) => /headless/.test(e.hint ?? ""),
  );
});

test("xvfb with no Xvfb installed is DISPLAY_UNAVAILABLE, not a failed launch later", () => {
  assert.equal(codeOf(() => resolve({ explicit: "xvfb", ...LINUX_BARE })), "DISPLAY_UNAVAILABLE");
  assert.equal(resolve({ explicit: "xvfb", ...LINUX_SERVER }), "xvfb");
});

test("headless needs nothing from the machine", () => {
  for (const platform of [LINUX_BARE, WINDOWS, MACOS]) {
    assert.equal(resolve({ explicit: "headless", ...platform }), "headless");
  }
});

test("desktop defaults: nothing set and a headed flag stays headed, as it always was", () => {
  assert.equal(resolve({ flag: "headed", ...WINDOWS }), "headed");
  assert.equal(resolve({ flag: "headed", ...MACOS }), "headed");
  assert.equal(resolve({ flag: "headed", ...LINUX_DESKTOP }), "headed");
});

// ── the browser's environment and flags ──────────────────────────────────────

const SESSION = {
  PATH: "/bin",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  XAUTHORITY: "/home/u/.Xauthority",
};

test("headed keeps the session's display: the very object it was given", () => {
  assert.equal(displayEnv(SESSION, "headed"), SESSION);
});

test("headless drops every display variable and nothing else", () => {
  assert.deepEqual(displayEnv(SESSION, "headless"), { PATH: "/bin" });
});

test("xvfb overrides the existing display and auth, and drops Wayland", () => {
  assert.deepEqual(displayEnv(SESSION, "xvfb", { display: ":7", authFile: "/run/a" }), {
    PATH: "/bin",
    DISPLAY: ":7",
    XAUTHORITY: "/run/a",
  });
});

test("the original environment is left alone", () => {
  const env = { ...SESSION };
  displayEnv(env, "headless");
  assert.deepEqual(env, SESSION);
});

test("the headless flags: exactly the mode and the pointer settings", () => {
  assert.deepEqual(HEADLESS_CHROMIUM_ARGS, [
    "--headless=new",
    "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
  ]);
});

// ── the global setting ───────────────────────────────────────────────────────

function withStore<T>(raw: string | null, fn: (store: SettingsStore, path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mz-settings-"));
  const path = defaultSettingsPath(dir);
  if (raw !== null) writeFileSync(path, raw);
  return fn(new SettingsStore(path), path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("settings: unset by default, and stays unset on disk", async () => {
  await withStore(null, async (store, path) => {
    assert.equal((await store.load()).defaultDisplayMode, undefined);
    await store.update({ autoUpdate: false });
    assert.equal("defaultDisplayMode" in JSON.parse(readFileSync(path, "utf8")), false);
  });
});

test("settings: every mode loads as stored", async () => {
  for (const mode of ["headed", "xvfb", "headless"]) {
    await withStore(JSON.stringify({ defaultDisplayMode: mode }), async (store) => {
      assert.equal((await store.load()).defaultDisplayMode, mode);
    });
  }
});

test("settings: a value this build can't run is dropped at load, other settings kept", async () => {
  for (const bad of ["auto", "HEADLESS", "", 3, true, null, { mode: "headless" }]) {
    await withStore(JSON.stringify({ defaultDisplayMode: bad, autoUpdate: false }), async (store) => {
      const settings = await store.load();
      assert.equal("defaultDisplayMode" in settings, false, JSON.stringify(bad));
      assert.equal(settings.autoUpdate, false);
    });
  }
});

test("settings: an update persists a mode, undefined clears it, nonsense is refused", async () => {
  await withStore(null, async (store, path) => {
    await store.update({ defaultDisplayMode: "headless" });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).defaultDisplayMode, "headless");
    assert.equal(existsSync(path), true);

    await assert.rejects(
      store.update({ defaultDisplayMode: "auto" as unknown as DisplayMode }),
      /Unknown display mode "auto"/,
    );
    assert.equal((await store.load()).defaultDisplayMode, "headless", "a refused update changes nothing");

    await store.update({ defaultDisplayMode: undefined });
    assert.equal((await store.load()).defaultDisplayMode, undefined);
    assert.equal("defaultDisplayMode" in JSON.parse(readFileSync(path, "utf8")), false);
  });
});
