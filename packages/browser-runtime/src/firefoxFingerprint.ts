import { createHash } from "node:crypto";
import { availScreenFor } from "@multizen/profile-manager";
import type { FingerprintConfig, Profile } from "@multizen/types";

export function osForDevice(device: string): "windows" | "macos" | "linux" {
  if (device.startsWith("mac") || device.startsWith("imac")) return "macos";
  if (device.startsWith("windows")) return "windows";
  if (device.startsWith("linux")) return "linux";
  // Fall back to the host OS if the device family is somehow unset.
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export interface CamoufoxWebglPair {
  vendor: string;
  renderer: string;
}

/** What the installed Camoufox can apply, which the persona mapping needs. */
export interface CamoufoxEnv {
  /** Firefox major version of the installed Camoufox build, e.g. "152". */
  firefoxMajor: string;
  /** The WebGL pairs camoufox-js has parameter data for, by its OS key (win, mac, lin). */
  webglPairs: Readonly<Record<string, readonly CamoufoxWebglPair[]>>;
}

let webglPairs: Promise<CamoufoxEnv["webglPairs"]> | undefined;

/**
 * Read the installed Camoufox's version and camoufox-js's WebGL pairs. Loaded
 * lazily, like the Firefox driver: Chromium-only sessions never touch camoufox-js.
 * The version is read each time (an engine update changes it); the pair list
 * only changes with the camoufox-js package, so it is read once.
 */
export async function installedCamoufoxEnv(): Promise<CamoufoxEnv> {
  const [{ installedVerStr }, { getPossiblePairs }] = await Promise.all([
    import("camoufox-js/dist/pkgman.js"),
    import("camoufox-js/dist/webgl/sample.js"),
  ]);
  webglPairs ??= getPossiblePairs().catch((e: unknown) => {
    webglPairs = undefined;
    throw e;
  });
  return { firefoxMajor: installedVerStr().split(".")[0]!, webglPairs: await webglPairs };
}

/** The persona mapping for the installed Camoufox. See {@link camoufoxConfigFor}. */
export async function camoufoxConfigForProfile(
  profile: Profile,
  env?: CamoufoxEnv,
): Promise<Record<string, unknown>> {
  return camoufoxConfigFor(profile, env ?? (await installedCamoufoxEnv()));
}

/**
 * Map a profile's ENGINE-NEUTRAL persona attributes to a Camoufox
 * `launchOptions` config, so that the same profile reads the same at every
 * launch. Chrome-specific fields (userAgent, clientHints / Sec-CH-UA) are
 * deliberately NOT mapped: Camoufox is Firefox, and a Chrome UA on Firefox
 * would be an obvious tell (camoufox-js rejects non-Firefox fingerprints).
 *
 * Why everything is pinned: camoufox-js draws a fresh BrowserForge fingerprint
 * at every launchOptions() call and only fills keys the config leaves unset.
 * Pinning just screen size and timezone left the rest new at every launch —
 * 2 to 32 threads, an Intel, AMD or NVIDIA GPU, availWidth 1355 one time and
 * 5120 the next on a 1920 screen (wider than the screen), new canvas, audio and
 * font-metric noise — so each visit looked like a different device. So:
 *
 *   os, locale       ← device family, the persona's primary locale
 *   screen.*         ← the persona's screen and available area
 *   window.*         ← a maximized window on that area, see windowGeometry()
 *   timezone         ← the persona's IANA zone
 *   hardwareConcurrency ← the persona's thread count, as CloakBrowser reports it
 *   userAgent, appVersion ← the installed Firefox, with the OS token BrowserForge
 *                      gives most often (on Linux it sometimes adds "Ubuntu;")
 *   maxTouchPoints   ← 0: every persona is a desktop or laptop
 *   noise seeds      ← canvas, audio and font-spacing seeds and the canvas
 *                      anti-aliasing offset, derived from the profile's seed
 *   webgl_config     ← one of camoufox-js's pairs for that OS, of the persona's
 *                      GPU vendor, chosen per profile (pickCamoufoxWebgl)
 *
 * What still varies per launch is per-session state, not identity:
 * window.history.length, and WebRTC ports and mDNS names.
 *
 * The real window must match the reported one, or CSS media queries and
 * clientWidth give the true size away: the driver launches with
 * `viewport: null`, and Camoufox then sizes the content area to window.inner*.
 *
 * `locale` is passed as a SINGLE region-qualified string, not the languages
 * array: camoufox-js's handleLocales routes a bare language like "en" (≤3 chars)
 * through a territory lookup whose async unicode data (`SELECTOR.loadUnicodeInfo`)
 * launchOptions never awaits, so it crashes on `this.root`. A >3-char locale
 * takes the safe normalizeLocale path instead.
 *
 * i_know_what_im_doing accepts camoufox's manual-override warnings: the persona
 * is already coherent. The seed keys exist since Camoufox 2.0 (the pinned
 * 152.0.4-beta.30 has them); Camoufox refuses unknown keys at launch, so a
 * downgrade below that fails loudly instead of silently.
 */
export function camoufoxConfigFor(profile: Profile, env: CamoufoxEnv): Record<string, unknown> {
  const fp: FingerprintConfig = profile.fingerprint;
  const os = osForDevice(fp.device);
  const seed = fp.seed ?? profile.id;
  const webgl = pickCamoufoxWebgl(env.webglPairs[CAMOUFOX_OS[os]] ?? [], os, fp.webgl, seed);
  return {
    os,
    locale: fp.locale,
    i_know_what_im_doing: true,
    ...(webgl ? { webgl_config: [webgl.vendor, webgl.renderer] } : {}),
    config: {
      ...windowGeometry(fp, os),
      timezone: fp.timezone,
      "navigator.hardwareConcurrency": fp.hardwareConcurrency,
      "navigator.maxTouchPoints": 0,
      ...firefoxNavigator(os, env.firefoxMajor),
      "fonts:spacing_seed": seedUint32(seed, "fonts:spacing_seed"),
      "audio:seed": seedUint32(seed, "audio:seed"),
      "canvas:seed": seedUint32(seed, "canvas:seed"),
      "canvas:aaOffset": (seedUint32(seed, "canvas:aaOffset") % 101) - 50,
    },
  };
}

const CAMOUFOX_OS = { windows: "win", macos: "mac", linux: "lin" } as const;

/** Height of Firefox's tab strip + toolbar at 100% scale, title bar hidden. */
const FIREFOX_TOOLBARS = { windows: 79, macos: 80, linux: 85 } as const;
/** macOS menu bar: the available area starts below it. */
const MACOS_MENU_BAR = 25;
/** A maximized window on Windows extends this far past each edge of the work area. */
const WINDOWS_FRAME = 8;

/**
 * Screen and a maximized browser window on the persona's available area: the
 * shape BrowserForge's Firefox data shows most (outer size equal to the work
 * area). On Windows a maximized window overhangs the work area by its frame, so
 * outer is 16 px larger and screenX/Y is -8, with the content the full width.
 */
export function windowGeometry(
  fp: FingerprintConfig,
  os: ReturnType<typeof osForDevice>,
): Record<string, number> {
  const screen = fp.screen;
  const avail = availScreenFor(fp);
  const availTop = os === "macos" ? Math.min(MACOS_MENU_BAR, screen.height - avail.height) : 0;
  const frame = os === "windows" ? WINDOWS_FRAME : 0;
  return {
    "screen.width": screen.width,
    "screen.height": screen.height,
    "screen.availWidth": avail.width,
    "screen.availHeight": avail.height,
    "screen.availLeft": 0,
    "screen.availTop": availTop,
    "window.outerWidth": avail.width + 2 * frame,
    "window.outerHeight": avail.height + 2 * frame,
    "window.innerWidth": avail.width,
    "window.innerHeight": avail.height - FIREFOX_TOOLBARS[os],
    "window.screenX": -frame,
    "window.screenY": availTop - frame,
  };
}

/** The navigator strings BrowserForge gives Firefox on each OS, for this version. */
function firefoxNavigator(os: ReturnType<typeof osForDevice>, major: string): Record<string, string> {
  const token = {
    windows: "Windows NT 10.0; Win64; x64",
    macos: "Macintosh; Intel Mac OS X 10.15",
    linux: "X11; Linux x86_64",
  }[os];
  const appVersion = { windows: "5.0 (Windows)", macos: "5.0 (Macintosh)", linux: "5.0 (X11)" }[os];
  return {
    "navigator.userAgent": `Mozilla/5.0 (${token}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`,
    "navigator.appVersion": appVersion,
  };
}

/** A value in 1..2^32-1 (0 turns Camoufox's noise off) from the profile seed. */
function seedUint32(seed: string, label: string): number {
  const n = createHash("sha256").update(`${label}\0${seed}`).digest().readUInt32BE(0);
  return n === 0 ? 1 : n;
}

type GpuVendor = "nvidia" | "amd" | "intel" | "apple";

function gpuVendor(text: string): GpuVendor | null {
  if (/nvidia|geforce|quadro/i.test(text)) return "nvidia";
  if (/\bamd\b|radeon|\bati\b/i.test(text)) return "amd";
  if (/intel/i.test(text)) return "intel";
  if (/apple/i.test(text)) return "apple";
  return null;
}

/**
 * The WebGL pair a profile shows on Camoufox: among camoufox-js's pairs for the
 * OS, those Firefox reports today (sanitized, ", or similar"), not a software
 * renderer, not a Direct3D one on macOS, and from the persona's GPU vendor when
 * there is one (an NVIDIA persona keeps an NVIDIA GPU; the Mesa nouveau entry
 * doesn't count as one). Then rendezvous hashing on the profile seed: each
 * profile keeps its pick when other pairs come and go with a camoufox-js update.
 * Null only when camoufox-js has no usable pair at all (it then draws its own).
 */
export function pickCamoufoxWebgl(
  pairs: readonly CamoufoxWebglPair[],
  os: ReturnType<typeof osForDevice>,
  persona: { vendor: string; renderer: string } | undefined,
  seed: string,
): CamoufoxWebglPair | null {
  const usable = pairs.filter(
    (p) =>
      p.renderer.endsWith(", or similar") &&
      !/llvmpipe|swiftshader|basic render/i.test(`${p.vendor} ${p.renderer}`) &&
      !(os === "macos" && /Direct3D/.test(p.renderer)),
  );
  const want = persona ? gpuVendor(`${persona.vendor} ${persona.renderer}`) : null;
  const sameVendor = want ? usable.filter((p) => gpuVendor(p.vendor) === want) : [];
  const candidates = sameVendor.length > 0 ? sameVendor : usable;
  let best: CamoufoxWebglPair | null = null;
  let bestScore = -1;
  for (const p of candidates) {
    const score = seedUint32(seed, `webgl\0${p.vendor}\0${p.renderer}`);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}
