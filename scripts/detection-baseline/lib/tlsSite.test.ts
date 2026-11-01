import { test } from "node:test";
import assert from "node:assert/strict";
import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { ja4 } from "./ja4.ts";
import { startTlsSite } from "./tlsSite.ts";

function h2Get(url: string): Promise<{ session: ClientHttp2Session; body: string }> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(url, { rejectUnauthorized: false, servername: "localhost" });
    session.on("error", reject);
    const stream = session.request({ ":method": "GET", ":path": "/", "x-order-probe": "1" });
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => (body += chunk));
    stream.on("end", () => resolve({ session, body }));
    stream.on("error", reject);
    stream.end();
  });
}

test("an HTTP/2 client is served, and its hello and connection preface are both read", async () => {
  const site = await startTlsSite();
  try {
    const { session, body } = await h2Get(site.url);
    session.close();
    assert.match(body, /MultiZen baseline TLS/);
    const [connection] = site.connections();
    assert.equal(connection?.alpn, "h2");
    assert.equal(connection?.hello?.sni, "localhost");
    assert.deepEqual(connection?.hello?.alpn, ["h2"]);
    assert.match(ja4(connection!.hello!).ja4, /^t13d\d{4}h2_[0-9a-f]{12}_[0-9a-f]{12}$/);
    const h2 = site.h2();
    assert.equal(h2?.preface, true);
    assert.ok(h2?.firstHeaders?.pseudoOrder.includes(":method"));
    assert.ok(h2?.frameOrder.includes("SETTINGS"), "Node's client sends a SETTINGS frame");
    assert.ok(
      connection?.requestHeaders.some(([name]) => name === "x-order-probe"),
      "the regular headers come from the HTTP/2 server's own decoder",
    );
  } finally {
    await site.close();
  }
});

test("an HTTP/1.1 client gets the same page, and its headers in its own order", async () => {
  const site = await startTlsSite();
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        site.url,
        {
          rejectUnauthorized: false,
          ALPNProtocols: ["http/1.1"],
          headers: { "x-first": "1", "x-second": "2" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.match(body, /MultiZen baseline TLS/);
    const [connection] = site.connections();
    assert.equal(connection?.alpn, "http/1.1");
    assert.equal(site.h2(), null);
    const names = connection?.requestHeaders.map(([name]) => name.toLowerCase()) ?? [];
    assert.ok(names.includes("x-first"));
    assert.ok(names.indexOf("x-first") < names.indexOf("x-second"));
  } finally {
    await site.close();
  }
});

test("a client that isn't speaking TLS is recorded and cut off, and the site stays up", async () => {
  const site = await startTlsSite();
  try {
    await new Promise<void>((resolve, reject) => {
      const plain = netConnect(site.port, "127.0.0.1", () => plain.write("GET / HTTP/1.1\r\n\r\n"));
      plain.on("error", reject);
      plain.on("close", () => resolve());
    });
    assert.equal(site.connections()[0]?.error, "not a TLS handshake");
    const { session, body } = await h2Get(site.url);
    session.close();
    assert.match(body, /MultiZen baseline TLS/);
  } finally {
    await site.close();
  }
});
