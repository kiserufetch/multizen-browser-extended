// What the acceptance scripts share, and the full agent flow of AC3 and AC4, with a real SDK client.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pinnedCloakBrowserManifest } from "@multizen/browser-runtime";

export const IS_WINDOWS = process.platform === "win32";
export const HERE = import.meta.dirname;
export const REPO = resolve(HERE, "../../../..");
export const CLI = join(REPO, "apps/server/bin/multizen-server.cjs");

export const freePort = () =>
  new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

function link(target, path) {
  if (existsSync(path)) return;
  if (IS_WINDOWS) spawnSync("cmd", ["/c", "mklink", "/J", path, target], { stdio: "ignore" });
  else symlinkSync(target, path);
}

/**
 * Links installed engines into a data dir, on the version directory only, so nothing the server does
 * to its own cache reaches the original. It runs a CloakBrowser only with the pin's hash in current.json,
 * and would otherwise download over the link. The Camoufox install has to be the pinned one, for the same reason.
 */
export function seedEngines(dataDir, { engineVersionDir, camoufoxInstall }) {
  if (engineVersionDir) {
    const pin = pinnedCloakBrowserManifest();
    const version = basename(engineVersionDir);
    if (version !== pin.version) throw new Error(`--engine-version-dir is ${version}, and a server only runs ${pin.version}`);
    const cache = join(dataDir, "chromium", "cloakbrowser");
    mkdirSync(cache, { recursive: true });
    link(resolve(engineVersionDir), join(cache, version));
    writeFileSync(join(cache, "current.json"), JSON.stringify({ version, binaryRelative: IS_WINDOWS ? "chrome.exe" : "chrome", sha256: pin.sha256 }));
  }
  if (camoufoxInstall) {
    mkdirSync(dataDir, { recursive: true });
    link(resolve(camoufoxInstall), join(dataDir, "camoufox"));
  }
}

/** Before deleting a data dir, so the deletion can't follow the links. */
export function unseedEngines(dataDir, { engineVersionDir, camoufoxInstall }) {
  const links = [
    ...(engineVersionDir ? [join(dataDir, "chromium", "cloakbrowser", basename(engineVersionDir))] : []),
    ...(camoufoxInstall ? [join(dataDir, "camoufox")] : []),
  ];
  for (const path of links) {
    if (!existsSync(path)) continue;
    if (IS_WINDOWS) spawnSync("cmd", ["/c", "rmdir", path], { stdio: "ignore" });
    else if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  }
}

// A connect that timed out reached nothing, and a machine with a TUN VPN loses some by itself: see
// "Local connections time out by themselves" in apps/server/README.md.
export const fetchRetryingConnect = async (input, init) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (e) {
      const code = e?.cause?.code;
      if (attempt >= 20 || (code !== "ETIMEDOUT" && code !== "UND_ERR_CONNECT_TIMEOUT")) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

/** A read of the rig's own, which any failure can retry: nothing it says about the product is lost. */
export async function getJsonRetrying(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await (await fetchRetryingConnect(url)).json();
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const fails = [];
export function check(name, ok, detail = "") {
  if (!ok) fails.push(name);
  log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
}

export async function connect(url, token, name = "acceptance") {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchRetryingConnect }));
  const raw = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
    const first = res.content?.[0];
    if (first?.type === "image") return { isError: false, image: first.data };
    let parsed = first?.text ?? "";
    try { parsed = JSON.parse(parsed); } catch {}
    return { isError: res.isError === true, parsed };
  };
  const call = async (tool, args = {}) => {
    const r = await raw(tool, args);
    if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.parsed).slice(0, 500)}`);
    return r.parsed ?? r;
  };
  return { client, raw, call, close: () => client.close() };
}

/** Retries while the engine downloads: says how many times it was told to. */
export async function launchWaiting(c, args, budgetMs = 20 * 60_000) {
  const deadline = Date.now() + budgetMs;
  let notReady = 0;
  const started = Date.now();
  for (;;) {
    const r = await c.raw("launch_profile", args);
    if (!r.isError) return { launched: r.parsed, notReady, waitedMs: Date.now() - started };
    if (r.parsed?.error?.code !== "ENGINE_NOT_READY" || Date.now() > deadline) {
      throw new Error(`launch_profile: ${JSON.stringify(r.parsed).slice(0, 500)}`);
    }
    notReady += 1;
    await sleep(r.parsed.error.details?.retry_after_ms ?? 3000);
  }
}

/**
 * The bridge names a dial that timed out. To a local fixture that is this machine's loopback, and retrying
 * it hides nothing about the product. Anything else fails, as does a retry that keeps failing.
 */
export async function navigate(c, args) {
  for (let attempt = 1; ; attempt += 1) {
    const r = await c.raw("navigate", args);
    if (!r.isError) return r.parsed;
    if (attempt >= 5 || !/connect ETIMEDOUT/.test(r.parsed?.error?.message ?? "")) {
      throw new Error(`navigate: ${JSON.stringify(r.parsed).slice(0, 500)}`);
    }
    log("note: the fixture's port timed out, which is loopback: navigating again");
    await sleep(1000);
  }
}

function findByName(nodes, name) {
  for (const node of nodes) {
    if (node.name === name) return node;
    const inChild = findByName(node.children ?? [], name);
    if (inChild) return inChild;
  }
  return null;
}

export function refOf(result, name) {
  if (result.ariaSnapshot) {
    const line = result.ariaSnapshot.split("\n").find((l) => l.includes(`"${name}"`));
    return /\[ref=([^\]]+)\]/.exec(line ?? "")?.[1];
  }
  return findByName(result.accessibilityTree ?? [], name)?.ref;
}

export async function tabsOf(c, id) {
  const listed = await c.call("list_tabs", { profile_id: id });
  return (listed.tabs ?? listed.targetInfos ?? []).filter((t) => (t.type ?? "page") === "page").map((t) => String(t.url));
}

/**
 * Create, launch, navigate, read, click by ref, probe, screenshot, download, cookie, second tab, close,
 * relaunch with the cookie and the tabs, close. `what` labels the checks. Returns the profile's id.
 */
export async function fullFlow(c, { what, engine, mode, origin, launchBudgetMs }) {
  const created = await c.call("create_profile", { name: `ac ${what}`, engine });
  const id = created.id;
  const args = mode ? { profile_id: id, display_mode: mode } : { profile_id: id };
  const first = await launchWaiting(c, args, launchBudgetMs);
  check(`${what}: launch`, !mode || first.launched.displayMode === mode, `pid ${first.launched.pid}, ${first.launched.displayMode}, ENGINE_NOT_READY ${first.notReady} times over ${first.waitedMs} ms`);

  await navigate(c, { profile_id: id, url: `${origin}/page` });
  const page = (await c.call("extract", { profile_id: id })).result;
  check(`${what}: extract`, page.title === "AC page", page.title);

  const buttonRef = refOf(page, "Press me");
  await c.call("click_ref", { profile_id: id, ref: buttonRef });
  const clicked = (await c.call("extract", { profile_id: id })).result;
  check(`${what}: click_ref ran the page's handler`, clicked.title === "clicked", `${buttonRef}, title ${clicked.title}`);

  const probe = await c.call("probe_fingerprint", { profile_id: id });
  check(`${what}: probe_fingerprint.ok`, probe.ok === true, { drift: probe.drift, webgl: probe.live?.webgl?.renderer, platform: probe.live?.platform });

  const shot = await c.raw("screenshot", { profile_id: id });
  check(`${what}: screenshot`, shot.image && Buffer.from(shot.image, "base64").subarray(1, 4).toString() === "PNG");

  await c.call("click_ref", { profile_id: id, ref: refOf(clicked, "Download report") });
  let download;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    download = (await c.call("list_downloads", { profile_id: id })).downloads[0];
    if (download?.state === "completed") break;
    await sleep(200);
  }
  const got = download ? await c.call("get_download", { profile_id: id, download_id: download.id }) : {};
  const bytes = Buffer.from(got.data_base64 ?? "", "base64").toString();
  check(`${what}: file downloaded`, download?.state === "completed" && bytes === "downloaded-bytes", `${download?.fileName}, "${bytes}"`);

  await c.call("set_cookies", {
    profile_id: id,
    cookies: [{ name: "mz_ac", value: "kept", domain: new URL(origin).hostname, path: "/", expires: Math.floor(Date.now() / 1000) + 86_400 }],
  });
  await c.call("new_tab", { profile_id: id, url: `${origin}/page?tab=two` });
  await sleep(600);
  const openTabs = await tabsOf(c, id);
  await c.call("close_profile", { profile_id: id });
  const stopped = (await c.call("list_profiles")).profiles.find((p) => p.id === id);
  check(`${what}: close_profile`, stopped?.isRunning === false, `tabs before closing: ${openTabs.length}`);

  await launchWaiting(c, args);
  await sleep(600);
  const restored = await tabsOf(c, id);
  if (engine === "camoufox") {
    check(`${what}: tab restore`, restored.length >= 1, `none on Camoufox by design: ${JSON.stringify(restored)}`);
  } else {
    check(`${what}: tabs restored`, restored.some((u) => u.includes("tab=two")), JSON.stringify(restored));
  }
  await navigate(c, { profile_id: id, url: `${origin}/echo` });
  const echo = (await c.call("extract", { profile_id: id })).result;
  check(`${what}: the cookie came back from disk`, echo.title.includes("mz_ac=kept"), echo.title);
  await c.call("close_profile", { profile_id: id });
  return id;
}
