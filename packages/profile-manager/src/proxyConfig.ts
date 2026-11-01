import { isIP } from "node:net";
import type { ProxyConfig } from "@multizen/types";

const MAX_HOST_CHARS = 253;

/**
 * An address or a plain name, nothing a URL built from it could read otherwise: this host goes
 * in a proxy URL, and `169.254.169.254:80/#` would make that URL's host the part before the `:`.
 */
export function isProxyHost(host: string): boolean {
  return isIP(host.replace(/^\[(.*)\]$/, "$1")) !== 0 || /^[\p{L}\p{M}\p{N}._-]+$/u.test(host);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** For a proxy that has been through no schema: an archive's. */
export function isProxyConfig(value: unknown): value is ProxyConfig {
  if (typeof value !== "object" || value === null) return false;
  const { type, host, port, username, password } = value as Record<string, unknown>;
  return (
    (type === "http" || type === "socks5") &&
    typeof host === "string" &&
    host.length >= 1 &&
    host.length <= MAX_HOST_CHARS &&
    isProxyHost(host) &&
    Number.isInteger(port) &&
    (port as number) >= 1 &&
    (port as number) <= 65535 &&
    isOptionalText(username) &&
    isOptionalText(password)
  );
}
