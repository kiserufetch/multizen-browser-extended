import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import { firstFreePort, isPortFree, randomFreePort } from "./portProbe.ts";

function listen(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("isPortFree: false while something listens, true after it stops", async () => {
  const server = await listen();
  const port = portOf(server);
  assert.equal(await isPortFree(port), false);
  await close(server);
  assert.equal(await isPortFree(port), true);
});

test("firstFreePort skips an occupied candidate", async () => {
  const server = await listen();
  const taken = portOf(server);
  const spare = await listen();
  const free = portOf(spare);
  await close(spare);
  try {
    const candidates = [taken, free];
    assert.equal(await firstFreePort(() => candidates.shift()!), free);
  } finally {
    await close(server);
  }
});

test("firstFreePort gives up rather than loop forever", async () => {
  const server = await listen();
  try {
    await assert.rejects(firstFreePort(() => portOf(server), 3), /No free CDP port/);
  } finally {
    await close(server);
  }
});

test("randomFreePort stays in the server's range and avoids a taken port", async () => {
  const server = await listen();
  const taken = portOf(server);
  try {
    for (let i = 0; i < 20; i++) {
      const port = await randomFreePort();
      assert.ok(port >= 20000 && port <= 32767, `out of range, or among outgoing ports: ${port}`);
      assert.notEqual(port, taken);
    }
  } finally {
    await close(server);
  }
});

test("randomFreePort maps the extremes of random() onto both ends of the range", async () => {
  assert.equal(await randomFreePort(30000, 30010, () => 0), 30000);
  assert.equal(await randomFreePort(30000, 30010, () => 0.9999), 30010);
});
