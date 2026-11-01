import type { JSX } from "react";
import { AppWindow, EyeOff, Monitor } from "lucide-react";
import type { DisplayMode } from "../../types";

/** Short display name per mode (matches the display picker labels). */
export function displayModeLabel(mode: DisplayMode): string {
  if (mode === "headless") return "Headless";
  return mode === "xvfb" ? "Xvfb" : "Window";
}

/** The one line a running profile with no window on this screen needs: where did it go. */
export function displayModeRunningNote(mode: DisplayMode): string {
  return mode === "xvfb"
    ? "Running on a private display, with no window here. Agents reach it over MCP; if one asks for a person, its panel opens. Stop closes it."
    : "Running with no window. Agents reach it over MCP; if one asks for a person, its panel opens. Stop closes it.";
}

const ICON = { headed: Monitor, headless: EyeOff, xvfb: AppWindow } as const;

export function DisplayModeIcon({
  mode,
  size = 14,
  className,
}: {
  mode: DisplayMode;
  size?: number;
  className?: string;
}): JSX.Element {
  const Icon = ICON[mode];
  return <Icon size={size} strokeWidth={1.75} className={className} aria-label={displayModeLabel(mode)} />;
}
