import { useEffect, useState, type JSX } from "react";
import { displayModeLabel } from "../atoms";
import type { BrowserEngine, DisplayMode } from "../../types";

/**
 * Browser engine, display mode + start-page controls, shared by the create and edit sheets.
 * Self-contained (own labels/inputs) so both sheets can drop it into their own
 * "Browser" group.
 *
 * NOTE: a per-profile default-search-engine control lived here too, but ungoogled
 * CloakBrowser ignores both pref-seeding and extension `search_provider` overrides
 * (verified on the real binary — see specs/profile-startpage-search). It needs a
 * Chromium source patch, so search is deferred to the patched-Chromium build and
 * intentionally not surfaced here yet.
 */

/** Prefilled into the Start page input for new profiles (a real, editable
 *  value — the user can select/clear it, not just a placeholder). Defaults to
 *  `about:blank` so a new profile's first navigation isn't a fleet-wide marker
 *  (every MultiZen profile hitting the same search engine on first run); the
 *  user can type any http(s) URL. Keep in sync with startPage.ts. */
export const DEFAULT_START_URL = "about:blank";

/** Engines a user can assign to a profile. CFT is intentionally not offered. */
export const ENGINE_ROSTER: ReadonlyArray<{
  value: BrowserEngine;
  label: string;
  description: string;
}> = [
  {
    value: "cloakbrowser",
    label: "CloakBrowser",
    description: "Source-patched Chromium. Full anti-detect + agent tools.",
  },
  {
    value: "camoufox",
    label: "Camoufox",
    description: "Firefox-based anti-detect. A non-Chrome TLS/JS fingerprint.",
  },
];

const DISPLAY_MODE_ROSTER: ReadonlyArray<{ value: DisplayMode; description: string }> = [
  { value: "headed", description: "A normal browser window on this computer." },
  { value: "headless", description: "No window. Runs in the background, for agents over MCP." },
  { value: "xvfb", description: "A real window on a private virtual display you can't see." },
];

/**
 * The modes worth offering here. Xvfb only exists on Linux; a profile that already has
 * it (say, imported from a Linux machine) still shows it, or its saved mode would be
 * invisible while a launch fails over it.
 */
export function displayModeChoices(
  platform: string,
  current?: DisplayMode,
): ReadonlyArray<{ value: DisplayMode; description: string }> {
  return DISPLAY_MODE_ROSTER.filter(
    (mode) => mode.value !== "xvfb" || platform === "linux" || current === "xvfb",
  );
}

export function BrowserSection({
  startUrl,
  onStartUrl,
  engine,
  onEngine,
  engineDisabled = false,
  engineDisabledReason,
  displayMode,
  onDisplayMode,
  displayModeDisabled = false,
  displayModeDisabledReason,
}: {
  startUrl: string;
  onStartUrl: (v: string) => void;
  engine: BrowserEngine;
  onEngine: (v: BrowserEngine) => void;
  /** When true the engine cannot be changed (e.g. the profile is running). */
  engineDisabled?: boolean;
  /** Shown under the picker to explain why it's locked. */
  engineDisabledReason?: string;
  /** Undefined follows the app default (Settings). */
  displayMode: DisplayMode | undefined;
  onDisplayMode: (v: DisplayMode | undefined) => void;
  /** When true the mode cannot be changed (a running browser keeps its mode). */
  displayModeDisabled?: boolean;
  displayModeDisabledReason?: string;
}): JSX.Element {
  const [appDefaultMode, setAppDefaultMode] = useState<DisplayMode>("headed");
  const [platform, setPlatform] = useState("");
  useEffect(() => {
    if (!window.multizen) return;
    void window.multizen.settings.get().then((s) => setAppDefaultMode(s.defaultDisplayMode ?? "headed"));
    void window.multizen.system.info().then((info) => setPlatform(info.platform));
  }, []);
  const displayCards: ReadonlyArray<{
    value: DisplayMode | undefined;
    label: string;
    description: string;
  }> = [
    {
      value: undefined,
      label: `Default (${displayModeLabel(appDefaultMode).toLowerCase()})`,
      description: "Follows the setting in Settings.",
    },
    ...displayModeChoices(platform, displayMode).map((mode) => ({
      ...mode,
      label: displayModeLabel(mode.value),
    })),
  ];

  return (
    <div className="space-y-2.5">
      <SectionField label="Engine">
        <div className="grid gap-2 sm:grid-cols-2">
          {ENGINE_ROSTER.map((opt) => {
            const selected = engine === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={engineDisabled}
                onClick={() => onEngine(opt.value)}
                className="text-left p-2.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  boxShadow: selected
                    ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.08)",
                  background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                }}
              >
                <div className="text-[12px] font-medium text-slate-200">{opt.label}</div>
                <div className="text-[10px] text-slate-500 leading-snug mt-0.5">
                  {opt.description}
                </div>
              </button>
            );
          })}
        </div>
        {engineDisabled && engineDisabledReason ? (
          <p className="text-[10px] text-slate-600 leading-relaxed">{engineDisabledReason}</p>
        ) : null}
        {engine === "camoufox" ? (
          <p className="text-[10px] text-amber-400/80 leading-relaxed">
            Camoufox is Firefox-based, so Chrome extensions aren't supported — the
            Extensions section is hidden for this engine.
          </p>
        ) : null}
      </SectionField>

      <SectionField label="Display">
        <div className="grid gap-2 sm:grid-cols-2">
          {displayCards.map((card) => {
            const selected = displayMode === card.value;
            return (
              <button
                key={card.value ?? "default"}
                type="button"
                disabled={displayModeDisabled}
                onClick={() => onDisplayMode(card.value)}
                className="text-left p-2.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                style={{
                  boxShadow: selected
                    ? "inset 0 0 0 1px rgba(168,85,247,0.45)"
                    : "inset 0 0 0 1px rgba(255,255,255,0.08)",
                  background: selected ? "rgba(168,85,247,0.08)" : "rgba(255,255,255,0.025)",
                }}
              >
                <div className="text-[12px] font-medium text-slate-200">{card.label}</div>
                <div className="text-[10px] text-slate-500 leading-snug mt-0.5">
                  {card.description}
                </div>
              </button>
            );
          })}
        </div>
        {displayModeDisabled && displayModeDisabledReason ? (
          <p className="text-[10px] text-slate-600 leading-relaxed">{displayModeDisabledReason}</p>
        ) : null}
      </SectionField>

      <SectionField label="Start page">
        <input
          type="text"
          value={startUrl}
          onChange={(e) => onStartUrl(e.target.value)}
          placeholder={DEFAULT_START_URL}
          className="w-full px-2.5 h-9 rounded-lg bg-white/[0.03] text-[12px] text-slate-200 outline-none placeholder:text-slate-600"
          style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
        />
      </SectionField>

      <p className="text-[10px] text-slate-600 leading-relaxed">
        {engine === "camoufox"
          ? "Opens on each launch (Camoufox doesn't restore previous tabs)"
          : "Opens on a profile's first launch (later launches restore your tabs)"}
        . Leave the default or set your own — any http(s) URL, or{" "}
        <code className="text-slate-500">about:blank</code>.
      </p>
    </div>
  );
}

function SectionField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      {children}
    </div>
  );
}
