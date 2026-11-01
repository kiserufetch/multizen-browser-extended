interface NetLogEvent {
  type: number;
  params?: Record<string, unknown>;
}

interface NetLogFile {
  constants?: { logEventTypes?: Record<string, number> };
  events?: NetLogEvent[];
}

/** A browser that was killed leaves its log cut off mid-list: the lines it did write still count. */
function parseNetLog(text: string): NetLogFile {
  try {
    return JSON.parse(text) as NetLogFile;
  } catch {
    const end = text.lastIndexOf("},");
    if (end === -1) throw new Error("The NetLog has no complete event in it");
    return JSON.parse(`${text.slice(0, end + 1)}]}`) as NetLogFile;
  }
}

const COUNTED = [
  "HOST_RESOLVER_MANAGER_REQUEST",
  "HOST_RESOLVER_MANAGER_JOB",
  "HOST_RESOLVER_SYSTEM_TASK",
  "HOST_RESOLVER_DNS_TASK",
  "DNS_TRANSACTION",
  "DNS_TRANSACTION_HTTPS_ATTEMPT",
  "DNS_TRANSACTION_UDP_ATTEMPT",
  "SOCKS5_CONNECT",
  "SSL_CONNECT",
  "HTTP2_SESSION",
  "QUIC_SESSION",
  "QUIC_SESSION_POOL_JOB",
];

/** Chromium's net::SecureDnsMode. */
const SECURE_DNS_MODES: Readonly<Record<number, string>> = { 0: "off", 1: "automatic", 2: "secure" };

const withoutPort = (host: string): string => host.replace(/:\d+$/, "");

/**
 * What a browser did about names on its own: whether it resolved them itself, with DoH or
 * not, whether it asked for HTTPS records (where ECH keys and HTTP/3 come from), and how much
 * went through a proxy instead. Counts, names and query types only: a NetLog also holds this
 * machine's DNS servers and addresses, which stay out of here and out of the report.
 */
export function analyzeNetLog(text: string): Record<string, unknown> {
  const log = parseNetLog(text);
  const nameOf = new Map(Object.entries(log.constants?.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const counts = new Map<string, number>();
  const namesAsked = new Set<string>();
  const jobs = new Map<string, { queryTypes: string[]; secureDns: string }>();
  for (const event of log.events ?? []) {
    const name = nameOf.get(event.type);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const params = event.params ?? {};
    if (name === "HOST_RESOLVER_MANAGER_REQUEST" && typeof params.host === "string") {
      namesAsked.add(withoutPort(params.host));
    }
    if (name === "HOST_RESOLVER_MANAGER_JOB" && typeof params.host === "string") {
      const mode = typeof params.secure_dns_mode === "number" ? params.secure_dns_mode : -1;
      jobs.set(withoutPort(params.host), {
        queryTypes: Array.isArray(params.dns_query_types) ? (params.dns_query_types as string[]) : [],
        secureDns: SECURE_DNS_MODES[mode] ?? "unknown",
      });
    }
  }
  return {
    events: Object.fromEntries(COUNTED.map((name) => [name, counts.get(name) ?? 0])),
    namesAsked: [...namesAsked].sort(),
    resolvedByTheBrowser: Object.fromEntries([...jobs.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}
