import type { JSX } from "react";
import { cn } from "../../lib/cn";

/**
 * Small country flag chip backed by the flag-icons CSS library.
 * Pass a 2-letter ISO country code (lowercase) — e.g. "us", "gb", "de".
 */
export function Flag({ cc, large, className }: { cc?: string; large?: boolean; className?: string }): JSX.Element | null {
  if (!cc) return null;
  return <span className={cn(`fi fi-${cc.toLowerCase()}`, large && "fi-lg", className)} aria-hidden="true" />;
}

/**
 * Map common timezone strings to a country code so we can render a flag
 * next to a profile's locale / proxy. Best-effort, not exhaustive.
 */
const TZ_TO_CC: Record<string, string> = {
  "America/New_York": "us",
  "America/Chicago": "us",
  "America/Los_Angeles": "us",
  "America/Denver": "us",
  "America/Toronto": "ca",
  "Europe/London": "gb",
  "Europe/Paris": "fr",
  "Europe/Berlin": "de",
  "Europe/Madrid": "es",
  "Europe/Rome": "it",
  "Europe/Amsterdam": "nl",
  "Europe/Stockholm": "se",
  "Europe/Moscow": "ru",
  "Asia/Tokyo": "jp",
  "Asia/Shanghai": "cn",
  "Asia/Singapore": "sg",
  "Asia/Hong_Kong": "hk",
  "Asia/Seoul": "kr",
  "Asia/Dubai": "ae",
  "Australia/Sydney": "au",
};

export function ccFromTimezone(tz?: string): string | undefined {
  if (!tz) return undefined;
  return TZ_TO_CC[tz];
}
