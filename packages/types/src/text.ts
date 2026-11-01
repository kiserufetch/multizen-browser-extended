/**
 * `text` without the run of `chars` at its end, in one pass. A regex like `/[. ]+$/` starts over
 * at every run it meets: on a hostile name of dots that takes seconds, with the event loop stopped.
 */
export function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** What `slice` can leave of a pair is no text: `encodeURIComponent` throws on it. */
export function wellFormed(text: string): string {
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

/** The part of a URL that is safe to log: a path, a query or userinfo can carry a secret. */
export function originOf(url: string): string {
  try {
    const { origin, protocol, hostname } = new URL(url);
    // A URL parser takes `'` and `=` in a name, so with no slash the rest of the text is the host.
    if (!/^[a-z0-9._\-[\]:]*$/i.test(hostname)) return "(not a URL)";
    return origin === "null" ? protocol : origin;
  } catch {
    return "(not a URL)";
  }
}

/**
 * To the next whitespace: `'` is legal in a path, so a quote doesn't end a URL. One slash or a
 * backslash is only taken after a scheme a URL parser repairs that for, or a Windows path would match.
 */
const URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]{0,30}:\/\/|(?:https?|wss?|ftp):[\\/])\S+/gi;
/** What usually closes around a quoted URL, and is no part of it. */
const AFTER_URL = "'\"`<>()[]{},;.";

/** The same, for each URL in a message: an engine's own errors quote them whole. */
export function withOriginsOnly(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => {
    const bare = trimEndChars(url, AFTER_URL);
    return originOf(bare) + url.slice(bare.length);
  });
}
