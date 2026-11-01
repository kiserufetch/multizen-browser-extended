import { MultizenError, type DisplayMode, type DisplayModeSetting } from "@multizen/types";

export interface DisplayModeInputs {
  /** A launch call's own display_mode. */
  explicit?: DisplayMode;
  /** The profile's saved mode. */
  profile?: DisplayMode;
  /** The global setting. */
  setting?: DisplayMode;
  /** The lowest priority: a server's --display-mode, headed on the desktop. */
  flag: DisplayModeSetting;
  /** A server's --headless: above everything, and an explicit request can't contradict it. */
  forced?: DisplayMode;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasXvfb: () => boolean;
}

/** A Linux browser needs one of these. A Wayland-only session runs Camoufox fine. */
function hasDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform !== "linux" || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Without DISPLAY a Linux server has no desktop, and an X server of its own is what a
 * real browser window expects. Chromium only speaks X11 here unless told otherwise, so
 * a Wayland socket alone doesn't count.
 */
function autoMode(i: DisplayModeInputs): DisplayMode {
  if (i.platform !== "linux" || i.env.DISPLAY) return "headed";
  return i.hasXvfb() ? "xvfb" : "headless";
}

function assertAvailable(mode: DisplayMode, i: DisplayModeInputs): void {
  if (mode === "headed" && !hasDisplay(i.platform, i.env)) {
    throw new MultizenError(
      "DISPLAY_UNAVAILABLE",
      "A headed browser needs a display, and this machine has none (neither DISPLAY nor WAYLAND_DISPLAY is set).",
      { hint: 'Use display_mode "headless", or "xvfb" if Xvfb is installed.' },
    );
  }
  if (mode !== "xvfb") return;
  if (i.platform !== "linux") {
    throw new MultizenError("DISPLAY_UNAVAILABLE", `Xvfb only exists on Linux, not on ${i.platform}.`, {
      hint: 'Use display_mode "headless" or "headed".',
    });
  }
  if (!i.hasXvfb()) {
    throw new MultizenError("DISPLAY_UNAVAILABLE", "Xvfb is not installed on this machine.", {
      hint: 'Install it, or use display_mode "headless".',
    });
  }
}

/**
 * The one place a launch's mode is decided. Priority: forced, explicit, the profile's,
 * the setting, the flag.
 */
export function resolveDisplayMode(i: DisplayModeInputs): DisplayMode {
  if (i.forced && i.explicit && i.explicit !== i.forced) {
    throw new MultizenError(
      "INVALID_INPUT",
      `This server runs with --headless, so it can't open a profile in display_mode "${i.explicit}".`,
      { hint: 'Omit display_mode, or pass "headless".' },
    );
  }
  const chosen = i.forced ?? i.explicit ?? i.profile ?? i.setting ?? i.flag;
  const mode = chosen === "auto" ? autoMode(i) : chosen;
  assertAvailable(mode, i);
  return mode;
}

/**
 * Only in headless. Without the blink settings a headless page reports no fine pointer and
 * no hover on Linux, a real tell; these make it report what a mouse-driven desktop does.
 */
export const HEADLESS_CHROMIUM_ARGS: readonly string[] = [
  "--headless=new",
  "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2",
];

/**
 * A browser's environment for this mode. Headed takes the session's as it is. The others
 * must not reach the session's display: one window on it would defeat the point, and an
 * inherited XAUTHORITY would not open the private one.
 */
export function displayEnv<T extends Record<string, string | undefined>>(
  env: T,
  mode: DisplayMode,
  xvfb?: { display: string; authFile: string },
): T {
  if (mode === "headed") return env;
  const { DISPLAY: _d, WAYLAND_DISPLAY: _w, XAUTHORITY: _x, ...rest } = env;
  return (xvfb ? { ...rest, DISPLAY: xvfb.display, XAUTHORITY: xvfb.authFile } : rest) as T;
}
