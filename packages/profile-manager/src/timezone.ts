/**
 * IANA time zone identity across spellings.
 *
 * The persona catalog uses current IANA names (America/Argentina/Buenos_Aires,
 * Asia/Kolkata, Europe/Kyiv, Asia/Ho_Chi_Minh), but V8/ICU canonicalizes a
 * zone to CLDR's legacy spelling, so a Chromium page with that zone reports
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` as America/Buenos_Aires,
 * Asia/Calcutta, Europe/Kiev or Asia/Saigon. Firefox reports the IANA name, and
 * IP-geo services return either form. A string comparison treats both forms as
 * different zones; compare through ICU's canonical ID instead.
 */

/** ICU's canonical ID for a zone, or null when ICU does not know it. */
export function canonicalTimeZone(id: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: id }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** True when `a` and `b` name the same zone (identical, or alias links). */
export function sameTimeZone(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = canonicalTimeZone(a);
  return ca !== null && ca === canonicalTimeZone(b);
}

/** The entry of `candidates` that names the same zone as `id`, if any. */
export function findSameTimeZone(id: string, candidates: readonly string[]): string | undefined {
  return candidates.find((c) => sameTimeZone(c, id));
}
