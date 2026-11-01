import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { MultizenError, type ProxyConfig } from "@multizen/types";
import { EgressPolicy, type EgressLookup } from "./egressPolicy.ts";
import { asEgressBlocked, startBridgeForProfile, stopBridgeForProfile } from "./socks5Bridge.ts";

after(() => {
  mock.restoreAll();
});

const noLookup: EgressLookup = () => {
  throw new Error("this path must not look anything up");
};

const enforcing = (allow: string[] = [], lookup: EgressLookup = noLookup): EgressPolicy =>
  new EgressPolicy({ mode: "block-private", allow, lookup });

/** A real listener that says what it received, and counts who came. */
interface Listener {
  server: Server;
  host: string;
  port: number;
  connections: () => number;
  close(): Promise<void>;
}

async function listener(host = "127.0.0.1", port = 0, onSocket?: (s: Socket) => void): Promise<Listener> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (onSocket) onSocket(socket);
    else socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
  });
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  return {
    server,
    host,
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const CMD = { connect: 1, bind: 2, udpAssociate: 3 };

type SocksTarget =
  | { name: string; port: number }
  | { ipv4: number[]; port: number }
  | { ipv6: number[]; port: number };

function requestBytes(cmd: number, target: SocksTarget): Buffer {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  if ("name" in target) {
    return Buffer.concat([Buffer.from([5, cmd, 0, 3, target.name.length]), Buffer.from(target.name, "ascii"), port]);
  }
  if ("ipv4" in target) return Buffer.concat([Buffer.from([5, cmd, 0, 1, ...target.ipv4]), port]);
  return Buffer.concat([Buffer.from([5, cmd, 0, 4, ...target.ipv6]), port]);
}

/** The SOCKS5 client a browser would be: the status of the reply, and the open socket. */
async function socksRequest(
  bridgeUrl: string,
  target: SocksTarget,
  cmd = CMD.connect,
): Promise<{ status: number; socket: Socket }> {
  const bridgePort = Number(new URL(bridgeUrl).port);
  const socket = connect(bridgePort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  const read = (n: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < n) return;
        socket.off("data", onData);
        socket.off("close", onClose);
        if (buf.length > n) socket.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      };
      const onClose = (): void => reject(new Error("closed before the reply"));
      socket.on("data", onData);
      socket.once("close", onClose);
    });
  socket.write(Buffer.from([5, 1, 0]));
  assert.deepEqual([...(await read(2))], [5, 0]);
  socket.write(requestBytes(cmd, target));
  const reply = await read(10);
  return { status: reply[1]!, socket };
}

/** The bridge's refusal: this reply, and then the end, with nothing behind it. */
async function assertRefused(bridgeUrl: string, target: SocksTarget, reply = NOT_ALLOWED): Promise<void> {
  const { status, socket } = await socksRequest(bridgeUrl, target);
  assert.equal(status, reply, JSON.stringify(target));
  let received = 0;
  socket.on("data", (chunk: Buffer) => (received += chunk.length));
  socket.write("GET / HTTP/1.1\r\n\r\n");
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  assert.equal(received, 0, "something answered");
}

async function roundTrip(socket: Socket, text = "ping"): Promise<string> {
  const answer = new Promise<string>((resolve) => socket.once("data", (chunk) => resolve(chunk.toString())));
  socket.write(text);
  return answer;
}

const OK = 0;
const NOT_ALLOWED = 2;
const HOST_UNREACHABLE = 4;
const CONNECTION_REFUSED = 5;
const COMMAND_NOT_SUPPORTED = 7;

let nextId = 0;
const withBridge = async (
  upstream: ProxyConfig | null,
  policy: EgressPolicy | undefined,
  fn: (url: string, id: string) => Promise<void>,
  opts: { refuseByClosing?: boolean } = {},
): Promise<void> => {
  const id = `bridge-test-${++nextId}`;
  const url = await startBridgeForProfile(id, upstream, policy, opts);
  try {
    await fn(url, id);
  } finally {
    await stopBridgeForProfile(id);
  }
};

const quietWarnings = (): void => {
  mock.method(console, "warn", () => {});
};

const refusedByProxy = new Error("Navigation failed: net::ERR_SOCKS_CONNECTION_FAILED");

// ── direct profiles ──────────────────────────────────────────────────────────

test("direct: an allowed target is dialed and the bytes flow both ways", async () => {
  const target = await listener();
  try {
    await withBridge(null, enforcing([`127.0.0.1:${target.port}`]), async (url) => {
      const { status, socket } = await socksRequest(url, { ipv4: [127, 0, 0, 1], port: target.port });
      assert.equal(status, OK);
      assert.equal(await roundTrip(socket), "echo:ping");
      socket.destroy();
    });
  } finally {
    await target.close();
  }
});

test("direct: blocked targets are refused and nothing is dialed", async () => {
  quietWarnings();
  const target = await listener();
  try {
    await withBridge(null, enforcing(), async (url) => {
      const mappedLoopback = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1];
      const nat64Loopback = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 1];
      for (const request of [
        { ipv4: [127, 0, 0, 1], port: target.port },
        { name: "127.0.0.1", port: target.port },
        { name: "localhost", port: target.port },
        { name: "2130706433", port: target.port },
        { name: "0x7f.1", port: target.port },
        { name: "0177.0.0.1", port: target.port },
        { name: "127.0.0.1.", port: target.port },
        { ipv6: mappedLoopback, port: target.port },
        { ipv6: nat64Loopback, port: target.port },
      ]) {
        await assertRefused(url, request);
      }
    });
    assert.equal(target.connections(), 0);
  } finally {
    await target.close();
  }
});

/** Not every machine lets a process connect to ::1, even with something listening there. */
function dialable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("direct: an IPv6 literal goes out unbracketed, to the checked address", async () => {
  const target = await listener("::1").catch(() => null);
  if (!target) return;
  if (!(await dialable("::1", target.port))) {
    await target.close();
    return;
  }
  try {
    await withBridge(null, enforcing([`[::1]:${target.port}`]), async (url) => {
      const loopback = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
      const { status, socket } = await socksRequest(url, { ipv6: loopback, port: target.port });
      assert.equal(status, OK);
      assert.equal(await roundTrip(socket), "echo:ping");
      socket.destroy();
    });
  } finally {
    await target.close();
  }
});

test("direct rebinding: the lookup's second answer is checked, and only checked addresses are dialed", async () => {
  quietWarnings();
  const good = await listener("127.0.0.1");
  const evil = await listener("127.0.0.2", good.port).catch(() => null);
  if (!evil) {
    await good.close();
    return; // No 127.0.0.2 here: Linux and Windows both have it.
  }
  // Public as far as the policy goes: allowed by address. A name nothing else can resolve.
  const answers = ["127.0.0.1", "127.0.0.2"];
  const asked: string[] = [];
  const lookup: EgressLookup = async (host) => {
    asked.push(host);
    return [{ address: answers.shift() ?? "127.0.0.2" }];
  };
  try {
    await withBridge(null, enforcing([`127.0.0.1:${good.port}`], lookup), async (url) => {
      const name = "rebind.invalid";
      const first = await socksRequest(url, { name, port: good.port });
      assert.equal(first.status, OK);
      assert.equal(await roundTrip(first.socket), "echo:ping");
      first.socket.destroy();

      await assertRefused(url, { name, port: good.port });
      assert.deepEqual(asked, [name, name]);
    });
    assert.equal(good.connections(), 1);
    assert.equal(evil.connections(), 0);
  } finally {
    await good.close();
    await evil.close();
  }
});

test("direct: a mixed answer dials only the allowed address, not a blocked one listed first", async () => {
  const good = await listener("127.0.0.1");
  const evil = await listener("127.0.0.2", good.port).catch(() => null);
  const lookup: EgressLookup = async () => [{ address: "127.0.0.2" }, { address: "127.0.0.1" }];
  try {
    await withBridge(null, enforcing([`127.0.0.1:${good.port}`], lookup), async (url) => {
      const { status, socket } = await socksRequest(url, { name: "mixed.invalid", port: good.port });
      assert.equal(status, OK);
      assert.equal(await roundTrip(socket), "echo:ping");
      socket.destroy();
    });
    assert.equal(good.connections(), 1);
    assert.equal(evil?.connections() ?? 0, 0);
  } finally {
    await good.close();
    await evil?.close();
  }
});

test("direct: of several allowed addresses, one that refuses gives way to the next", async () => {
  const free = await listener();
  const freePort = free.port;
  await free.close();
  const good = await listener("127.0.0.1", 0);
  // Both on loopback, but the first on a port-less address: 127.0.0.2 has nothing there.
  const lookup: EgressLookup = async () => [{ address: "127.0.0.2" }, { address: "127.0.0.1" }];
  try {
    await withBridge(null, enforcing(["127.0.0.0/8"], lookup), async (url) => {
      const { status, socket } = await socksRequest(url, { name: "two.invalid", port: good.port });
      assert.equal(status, OK);
      assert.equal(await roundTrip(socket), "echo:ping");
      socket.destroy();

      await assertRefused(url, { name: "two.invalid", port: freePort }, CONNECTION_REFUSED);
    });
  } finally {
    await good.close();
  }
});

test("direct: a name that doesn't resolve is host unreachable, and no block to report", async () => {
  const lookup: EgressLookup = async () => {
    throw new Error("ENOTFOUND");
  };
  await withBridge(null, enforcing([], lookup), async (url, id) => {
    await assertRefused(url, { name: "gone.invalid", port: 80 }, HOST_UNREACHABLE);
    assert.equal(asEgressBlocked(id, refusedByProxy), refusedByProxy);
    const failed = new MultizenError("NAVIGATION_FAILED", "Navigation failed: net::ERR_SOCKET_NOT_CONNECTED");
    const told = asEgressBlocked(id, failed) as MultizenError;
    assert.equal(told.code, "NAVIGATION_FAILED");
    assert.match(told.message, /gone\.invalid:80.*did not resolve: ENOTFOUND/);
  });
});

test("direct: a target that refuses the connection is no block either", async () => {
  const free = await listener();
  const port = free.port;
  await free.close();
  const warn = mock.method(console, "warn", () => {});
  await withBridge(null, enforcing([`127.0.0.1:${port}`]), async (url, id) => {
    await assertRefused(url, { ipv4: [127, 0, 0, 1], port }, CONNECTION_REFUSED);
    assert.equal(asEgressBlocked(id, refusedByProxy), refusedByProxy, "refused isn't blocked");
  });
  warn.mock.restore();
});

test("refuseByClosing, for Chromium: every refusal is connected-then-closed, and nothing is dialed", async () => {
  quietWarnings();
  const closed = await listener();
  const deadPort = closed.port;
  await closed.close();
  const target = await listener();
  const lookup: EgressLookup = async () => {
    throw new Error("ENOTFOUND");
  };
  const chromiumSays = new MultizenError("NAVIGATION_FAILED", "Navigation failed: net::ERR_SOCKET_NOT_CONNECTED");
  try {
    await withBridge(
      null,
      enforcing([`127.0.0.1:${deadPort}`], lookup),
      async (url, id) => {
        await assertRefused(url, { ipv4: [127, 0, 0, 1], port: target.port }, OK);
        assert.equal((asEgressBlocked(id, chromiumSays) as MultizenError).code, "EGRESS_BLOCKED");

        await assertRefused(url, { name: "gone.invalid", port: 80 }, OK);
        const unresolved = asEgressBlocked(id, chromiumSays) as MultizenError;
        assert.equal(unresolved.code, "NAVIGATION_FAILED");
        assert.match(unresolved.message, /did not resolve/);

        await assertRefused(url, { ipv4: [127, 0, 0, 1], port: deadPort }, OK);
        const refused = asEgressBlocked(id, chromiumSays) as MultizenError;
        assert.equal(refused.code, "NAVIGATION_FAILED");
        assert.match(refused.message, /ECONNREFUSED/);
      },
      { refuseByClosing: true },
    );
    assert.equal(target.connections(), 0);
  } finally {
    await target.close();
  }
});

test("refuseByClosing takes no effect without a policy, as on the desktop", async () => {
  const dead = await listener();
  const port = dead.port;
  await dead.close();
  const warn = mock.method(console, "warn", () => {});
  await withBridge(
    { type: "socks5", host: "127.0.0.1", port },
    undefined,
    async (url) => {
      await assertRefused(url, { name: "example.com", port: 80 }, CONNECTION_REFUSED);
    },
    { refuseByClosing: true },
  );
  warn.mock.restore();
});

// ── proxied profiles ─────────────────────────────────────────────────────────

/** An upstream SOCKS5 proxy, no auth, recording each CONNECT and answering it itself. */
async function socksUpstream(): Promise<Listener & { connects: string[] }> {
  const connects: string[] = [];
  const server = await listener("127.0.0.1", 0, (client) => {
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      client.once("data", (request) => {
        const type = request[3];
        const nameLength = request[4]!;
        const host =
          type === 3
            ? request.subarray(5, 5 + nameLength).toString()
            : type === 1
              ? request.subarray(4, 8).join(".")
              : request.subarray(4, 20).toString("hex");
        const portAt = type === 3 ? 5 + nameLength : type === 1 ? 8 : 20;
        connects.push(`${host}:${request.readUInt16BE(portAt)}`);
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.on("data", (chunk) => client.write(`upstream:${chunk.toString()}`));
      });
    });
  });
  return Object.assign(server, { connects });
}

/** An upstream HTTP proxy: records each CONNECT line, says 200, and echoes. */
async function httpUpstream(): Promise<Listener & { connects: string[] }> {
  const connects: string[] = [];
  const server = await listener("127.0.0.1", 0, (client) => {
    client.once("data", (head) => {
      connects.push(head.toString().split("\r\n")[0]!);
      client.write("HTTP/1.1 200 OK\r\n\r\n");
      client.on("data", (chunk) => client.write(`upstream:${chunk.toString()}`));
    });
  });
  return Object.assign(server, { connects });
}

test("proxied: a name goes to the upstream as a name, with no lookup here", async () => {
  const upstream = await socksUpstream();
  const proxy: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: upstream.port };
  try {
    await withBridge(proxy, enforcing([`127.0.0.1:${upstream.port}`], noLookup), async (url) => {
      const { status, socket } = await socksRequest(url, { name: "example.com", port: 443 });
      assert.equal(status, OK);
      assert.equal(await roundTrip(socket), "upstream:ping");
      socket.destroy();
    });
    assert.deepEqual(upstream.connects, ["example.com:443"]);
  } finally {
    await upstream.close();
  }
});

test("proxied: literal private addresses, loopback and metadata names never reach the upstream", async () => {
  quietWarnings();
  const upstream = await socksUpstream();
  const proxy: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: upstream.port };
  try {
    await withBridge(proxy, enforcing([`127.0.0.1:${upstream.port}`], noLookup), async (url) => {
      for (const request of [
        { ipv4: [169, 254, 169, 254], port: 80 },
        { ipv4: [10, 0, 0, 1], port: 80 },
        { name: "2852039166", port: 80 },
        { name: "localhost", port: 80 },
        { name: "foo.localhost", port: 80 },
        { name: "metadata.google.internal", port: 80 },
      ]) {
        await assertRefused(url, request);
      }
    });
    assert.deepEqual(upstream.connects, []);
  } finally {
    await upstream.close();
  }
});

test("proxied: --egress-allow lets a private target through to the upstream", async () => {
  const upstream = await socksUpstream();
  const proxy: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: upstream.port };
  try {
    await withBridge(proxy, enforcing([`127.0.0.1:${upstream.port}`, "10.0.0.1:80"], noLookup), async (url) => {
      const { status, socket } = await socksRequest(url, { ipv4: [10, 0, 0, 1], port: 80 });
      assert.equal(status, OK);
      socket.destroy();
    });
    assert.deepEqual(upstream.connects, ["10.0.0.1:80"]);
  } finally {
    await upstream.close();
  }
});

for (const kind of ["socks5", "http"] as const) {
  test(`proxied over ${kind}: a blocked upstream gets no connection, at each CONNECT`, async () => {
    quietWarnings();
    const upstream = kind === "socks5" ? await socksUpstream() : await httpUpstream();
    const proxy: ProxyConfig = { type: kind, host: "127.0.0.1", port: upstream.port };
    try {
      await withBridge(proxy, enforcing([], noLookup), async (url, id) => {
        await assertRefused(url, { name: "example.com", port: 80 });
        assert.equal((asEgressBlocked(id, refusedByProxy) as MultizenError).code, "EGRESS_BLOCKED");
      });
      assert.equal(upstream.connections(), 0);
    } finally {
      await upstream.close();
    }
  });

  test(`proxied over ${kind}: an upstream by name goes to the address checked, and a rebind is caught`, async () => {
    quietWarnings();
    const upstream = kind === "socks5" ? await socksUpstream() : await httpUpstream();
    const proxy: ProxyConfig = { type: kind, host: "proxy.invalid", port: upstream.port };
    const answers = ["127.0.0.1", "169.254.169.254"];
    const asked: string[] = [];
    const lookup: EgressLookup = async (host) => {
      asked.push(host);
      return [{ address: answers.shift()! }];
    };
    try {
      await withBridge(proxy, enforcing([`127.0.0.1:${upstream.port}`], lookup), async (url) => {
        const first = await socksRequest(url, { name: "example.com", port: 80 });
        assert.equal(first.status, OK);
        first.socket.destroy();
        await assertRefused(url, { name: "example.com", port: 80 });
      });
      assert.deepEqual(asked, ["proxy.invalid", "proxy.invalid"], "the proxy's name, never the target's");
      assert.equal(upstream.connections(), 1);
    } finally {
      await upstream.close();
    }
  });
}

test("an HTTP upstream gets an IPv6 target in brackets", async () => {
  const upstream = await httpUpstream();
  const proxy: ProxyConfig = { type: "http", host: "127.0.0.1", port: upstream.port };
  const publicV6 = [0x26, 0x06, 0x47, 0, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11];
  try {
    await withBridge(proxy, undefined, async (url) => {
      const { status, socket } = await socksRequest(url, { ipv6: publicV6, port: 443 });
      assert.equal(status, OK);
      socket.destroy();
    });
    assert.deepEqual(upstream.connects, ["CONNECT [2606:4700:4700:0:0:0:0:1111]:443 HTTP/1.1"]);
  } finally {
    await upstream.close();
  }
});

test("no policy, as on the desktop: every target goes to the upstream, unjudged", async () => {
  const upstream = await socksUpstream();
  const proxy: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: upstream.port };
  try {
    await withBridge(proxy, undefined, async (url) => {
      for (const request of [
        { ipv4: [169, 254, 169, 254], port: 80 },
        { name: "localhost", port: 80 },
      ]) {
        const { status, socket } = await socksRequest(url, request);
        assert.equal(status, OK, JSON.stringify(request));
        socket.destroy();
      }
    });
    assert.deepEqual(upstream.connects, ["169.254.169.254:80", "localhost:80"]);
  } finally {
    await upstream.close();
  }
});

test("no policy, as on the desktop: a dead upstream still gets the connection-refused reply", async () => {
  const dead = await listener();
  const port = dead.port;
  await dead.close();
  const warn = mock.method(console, "warn", () => {});
  await withBridge({ type: "socks5", host: "127.0.0.1", port }, undefined, async (url) => {
    const { status, socket } = await socksRequest(url, { name: "example.com", port: 80 });
    assert.equal(status, CONNECTION_REFUSED);
    socket.destroy();
  });
  warn.mock.restore();
});

test("allow-all is the same: the bridge doesn't consult it", async () => {
  const upstream = await socksUpstream();
  const proxy: ProxyConfig = { type: "socks5", host: "127.0.0.1", port: upstream.port };
  const policy = new EgressPolicy({ mode: "allow-all", lookup: noLookup });
  try {
    await withBridge(proxy, policy, async (url) => {
      const { status, socket } = await socksRequest(url, { ipv4: [10, 0, 0, 1], port: 80 });
      assert.equal(status, OK);
      socket.destroy();
    });
    assert.deepEqual(upstream.connects, ["10.0.0.1:80"]);
  } finally {
    await upstream.close();
  }
});

// ── what no policy can open ──────────────────────────────────────────────────

for (const [name, cmd] of [
  ["BIND", CMD.bind],
  ["UDP ASSOCIATE", CMD.udpAssociate],
] as const) {
  for (const [path, upstreamOf] of [
    ["direct", (): ProxyConfig | null => null],
    ["proxied", (): ProxyConfig | null => ({ type: "socks5", host: "127.0.0.1", port: 1 })],
  ] as const) {
    test(`${name} stays refused on a ${path} bridge, under the policy and without it`, async () => {
      for (const policy of [enforcing(["0.0.0.0/0"]), undefined]) {
        await withBridge(upstreamOf(), policy, async (url) => {
          const { status, socket } = await socksRequest(url, { ipv4: [8, 8, 8, 8], port: 53 }, cmd);
          assert.equal(status, COMMAND_NOT_SUPPORTED);
          socket.destroy();
        });
      }
    });
  }
}

// ── the typed result of a navigation ─────────────────────────────────────────

test("a proxy-type failure right after a block is EGRESS_BLOCKED, naming the blocked target", async () => {
  quietWarnings();
  await withBridge(null, enforcing(), async (url, id) => {
    await assertRefused(url, { ipv4: [169, 254, 169, 254], port: 80 });
    for (const text of [
      "Navigation to http://x/ failed: net::ERR_SOCKET_NOT_CONNECTED",
      "Navigation to https://x/ failed: net::ERR_CONNECTION_CLOSED",
      "Navigation to http://x/ failed: net::ERR_CONNECTION_RESET",
      "Navigation to http://x/ failed: net::ERR_SOCKS_CONNECTION_FAILED",
      "Navigation to http://x/ failed: net::ERR_PROXY_CONNECTION_FAILED",
      "Navigation to http://x/ failed: NS_ERROR_PROXY_CONNECTION_REFUSED",
      "Navigation to http://x/ failed: NS_ERROR_UNKNOWN_PROXY_HOST",
      "Navigation to http://x/ failed: NS_ERROR_CONNECTION_REFUSED",
      'Navigation to http://x/ failed: Navigation to "http://x/" is interrupted by another navigation to "http://y/"',
    ]) {
      const typed = asEgressBlocked(id, new Error(text)) as MultizenError;
      assert.ok(typed instanceof MultizenError, text);
      assert.equal(typed.code, "EGRESS_BLOCKED");
      assert.match(typed.message, /169\.254\.169\.254:80/);
      assert.equal(typed.retryable, false);
    }
  });
});

test("any other failure stays what it was, block or no block", async () => {
  quietWarnings();
  await withBridge(null, enforcing(), async (url, id) => {
    const before = new Error("net::ERR_SOCKS_CONNECTION_FAILED");
    assert.equal(asEgressBlocked(id, before), before, "no block recorded yet");

    await assertRefused(url, { ipv4: [10, 0, 0, 1], port: 80 });
    for (const text of ["net::ERR_CONNECTION_REFUSED", "net::ERR_TIMED_OUT", "NS_ERROR_NET_TIMEOUT", "NS_ERROR_NET_RESET", "net::ERR_ABORTED", "TIMEOUT"]) {
      const other = new Error(text);
      assert.equal(asEgressBlocked(id, other), other, text);
    }
  });
});

test("an allowed connection that fails after a block is what a failed load is about", async () => {
  quietWarnings();
  const closed = await listener();
  const port = closed.port;
  await closed.close();
  const firefoxSays = new Error("Navigation to http://x/ failed: NS_ERROR_CONNECTION_REFUSED");
  await withBridge(null, enforcing([`127.0.0.1:${port}`]), async (url, id) => {
    // A page script runs into the policy...
    await assertRefused(url, { ipv4: [10, 0, 0, 1], port: 80 });
    assert.equal((asEgressBlocked(id, firefoxSays) as MultizenError).code, "EGRESS_BLOCKED");
    // ...and the navigation goes to a port nothing listens on.
    await assertRefused(url, { ipv4: [127, 0, 0, 1], port }, CONNECTION_REFUSED);
    assert.equal(asEgressBlocked(id, firefoxSays), firefoxSays);
  });
});

test("a block older than two seconds says nothing about this failure, nor one from another profile", async () => {
  quietWarnings();
  const realNow = Date.now;
  await withBridge(null, enforcing(), async (url, id) => {
    await assertRefused(url, { ipv4: [10, 0, 0, 1], port: 80 });
    assert.equal(asEgressBlocked("another-profile", refusedByProxy), refusedByProxy);
    assert.equal((asEgressBlocked(id, refusedByProxy) as MultizenError).code, "EGRESS_BLOCKED");
    const later = realNow() + 2_100;
    const clock = mock.method(Date, "now", () => later);
    try {
      assert.equal(asEgressBlocked(id, refusedByProxy), refusedByProxy);
    } finally {
      clock.mock.restore();
    }
  });
});

test("stopping the bridge forgets its blocks", async () => {
  quietWarnings();
  const id = `bridge-test-${++nextId}`;
  const url = await startBridgeForProfile(id, null, enforcing());
  await assertRefused(url, { ipv4: [10, 0, 0, 1], port: 80 });
  assert.equal((asEgressBlocked(id, refusedByProxy) as MultizenError).code, "EGRESS_BLOCKED");
  await stopBridgeForProfile(id);
  assert.equal(asEgressBlocked(id, refusedByProxy), refusedByProxy);
});

test("a page asking for names nobody answers holds up only its own bridge", async () => {
  const target = await listener();
  const hung = new Set(["hang.test"]);
  let started = 0;
  const policy = new EgressPolicy({
    mode: "block-private",
    allow: [`${target.host}:${target.port}`, `fine.test:${target.port}`],
    lookupTimeoutMs: 1_000,
    lookup: (host) => {
      if (hung.has(host)) {
        started += 1;
        return new Promise(() => {});
      }
      return Promise.resolve([{ address: target.host }]);
    },
  });
  const hostileUrl = await startBridgeForProfile("hostile", null, policy);
  const otherUrl = await startBridgeForProfile("other", null, policy);
  try {
    const flood = Array.from({ length: 40 }, () =>
      socksRequest(hostileUrl, { name: "hang.test", port: 80 }).catch(() => null),
    );
    const startedAt = performance.now();
    const fine = await socksRequest(otherUrl, { name: "fine.test", port: target.port });
    assert.equal(fine.status, OK);
    assert.ok(performance.now() - startedAt < 800, "the other profile waited for the hostile one");
    fine.socket.destroy();
    for (const result of await Promise.all(flood)) {
      assert.equal(result?.status, HOST_UNREACHABLE);
      result?.socket.destroy();
    }
    // The real lookups, each holding a thread until the resolver gives up: never the whole flood.
    assert.ok(started <= 8, `${started} lookups running`);
  } finally {
    await stopBridgeForProfile("hostile");
    await stopBridgeForProfile("other");
    await target.close();
  }
});

test("a proxy that accepts and then says nothing fails the connection, instead of holding it", async () => {
  const silent = await listener("127.0.0.1", 0, (socket) => socket.resume());
  const proxy = { type: "http", host: "127.0.0.1", port: silent.port } as unknown as ProxyConfig;
  const policy = enforcing([`127.0.0.1:${silent.port}`]);
  const warn = mock.method(console, "warn", () => {});
  const url = await startBridgeForProfile("silent", proxy, policy, { connectTimeoutMs: 100 });
  try {
    const started = performance.now();
    const { status, socket } = await socksRequest(url, { name: "example.test", port: 443 });
    assert.equal(status, CONNECTION_REFUSED);
    assert.ok(performance.now() - started < 1_000);
    socket.destroy();
  } finally {
    warn.mock.restore();
    await stopBridgeForProfile("silent");
    await silent.close();
  }
});

test("without a policy a bridge sets no time limit of its own: the desktop", async () => {
  const silent = await listener("127.0.0.1", 0, (socket) => socket.resume());
  const proxy = { type: "http", host: "127.0.0.1", port: silent.port } as unknown as ProxyConfig;
  const url = await startBridgeForProfile("desk", proxy, undefined, { connectTimeoutMs: 50 });
  try {
    const pending = socksRequest(url, { name: "example.test", port: 443 });
    const outcome = await Promise.race([
      pending.then(
        () => "answered",
        () => "answered",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 300)),
    ]);
    assert.equal(outcome, "still waiting");
  } finally {
    await stopBridgeForProfile("desk");
    await silent.close();
  }
});

test("a page naming a new host each time can't fill the log", async () => {
  const warn = mock.method(console, "warn", () => {});
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  const url = await startBridgeForProfile("noisy", null, enforcing());
  try {
    for (let i = 0; i < 200; i++) {
      const { socket } = await socksRequest(url, { name: `host${i}.internal`, port: 80 });
      socket.destroy();
    }
    const targetsNamed = (): string[] =>
      warn.mock.calls.map((call) => call.arguments.join(" ")).filter((line) => /\.internal/.test(line));
    const logged = targetsNamed().length;
    assert.ok(logged > 0 && logged <= 20, `${logged} lines for 200 targets`);
    // The next window says how many it didn't show.
    mock.timers.tick(31_000);
    const { socket } = await socksRequest(url, { name: "later.internal", port: 80 });
    socket.destroy();
    const lines = warn.mock.calls.map((call) => call.arguments.join(" "));
    assert.ok(lines.some((line) => /\d+ more messages in the last 30s not shown/.test(line)), lines.at(-2));
    assert.ok(lines.some((line) => line.includes("later.internal")));
  } finally {
    mock.timers.reset();
    warn.mock.restore();
    await stopBridgeForProfile("noisy");
  }
});
