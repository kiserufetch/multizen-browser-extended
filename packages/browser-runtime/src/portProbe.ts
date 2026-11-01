import { createServer } from "node:net";

const MAX_PORT_ATTEMPTS = 64;

/**
 * True when `port` can be bound on the loopback address Chromium's
 * --remote-debugging-port uses. Without this a launch can land on a port another
 * browser already answers, and the readiness check would connect to that browser
 * and drive the wrong profile's cookies. The port is free only at this moment:
 * the identity check after spawn covers the gap.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

/** The first candidate that binds. Throws once the attempts run out. */
export async function firstFreePort(
  nextCandidate: () => number,
  attempts = MAX_PORT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = nextCandidate();
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free CDP port found after ${attempts} attempts`);
}

/** A random free port in [min, max]. The server's default: nothing to collide
 *  with a desktop app on the same machine counting up from 9222. It stays below
 *  the outgoing ports of Linux (from 32768) and Windows (from 49152): any connection
 *  on the machine can take one of those between this probe and the browser's bind,
 *  and Chromium then listens on ::1 alone, where the readiness check never looks. */
export function randomFreePort(
  min = 20000,
  max = 32767,
  random: () => number = Math.random,
): Promise<number> {
  return firstFreePort(() => min + Math.floor(random() * (max - min + 1)));
}
