import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";
import type { ProfileId, ProxyConfig } from "@multizen/types";

/**
 * Chromium's `--proxy-server=` flag does not accept `user:pass@host:port`
 * — when the upstream proxy requires auth, Chromium pops a "Sign in"
 * dialog on every navigation. Workaround: spin up a local HTTP CONNECT
 * relay that forwards every request upstream with the credentials
 * attached, and point Chromium at the local relay (no auth needed).
 *
 * Side benefit: the upstream URL with creds never appears in the
 * Chromium command line, so it does not leak via `ps aux` or crash dumps.
 */

interface Anonymized {
  url: string;
}

const byProfile = new Map<ProfileId, Anonymized>();

export async function anonymizeForProfile(
  profileId: ProfileId,
  proxy: ProxyConfig,
): Promise<string> {
  const existing = byProfile.get(profileId);
  if (existing) return existing.url;

  const upstream = buildUpstreamUrl(proxy);
  // proxy-chain accepts http://, https://, and socks://… URLs as upstream;
  // the returned URL is always an http://localhost:RANDOMPORT relay.
  const local = await anonymizeProxy(upstream);
  byProfile.set(profileId, { url: local });
  return local;
}

export async function releaseForProfile(profileId: ProfileId): Promise<void> {
  const entry = byProfile.get(profileId);
  if (!entry) return;
  byProfile.delete(profileId);
  try {
    await closeAnonymizedProxy(entry.url, true);
  } catch {
    // Already closed or never opened. Don't propagate — the profile
    // is being torn down regardless.
  }
}

export async function releaseAll(): Promise<void> {
  const ids = [...byProfile.keys()];
  await Promise.all(ids.map((id) => releaseForProfile(id)));
}

function buildUpstreamUrl(p: ProxyConfig): string {
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : p.username
        ? `${encodeURIComponent(p.username)}@`
        : "";
  // proxy-chain v2 accepts socks5:// upstream and frontends it as an
  // http relay so Chromium's --proxy-server can stay http://.
  const scheme = p.type === "socks5" ? "socks5" : "http";
  return `${scheme}://${auth}${p.host}:${p.port}`;
}
