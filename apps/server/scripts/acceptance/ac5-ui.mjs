// AC5, the panel's real page in a real browser (a bare headless CloakBrowser of its own, driven over CDP from
// here, whose binary CHROME names), against a running harness.mjs: sign in, see the handoff, a live frame, a click
// in the frame, text in the box, Resume. Run it through ac5-run.mjs, which says how.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRetryingConnect, freePort, getJsonRetrying, IS_WINDOWS } from "./flow.mjs";

const CTRL = process.env.CTRL || 18980;
const CHROME = process.env.CHROME;
if (!CHROME) throw new Error("CHROME must name a CloakBrowser binary for the panel's page to run in");
const j = async (path, init) =>
  init ? (await fetchRetryingConnect(`http://127.0.0.1:${CTRL}${path}`, init)).json() : getJsonRetrying(`http://127.0.0.1:${CTRL}${path}`);
const info = await j("/info");
const fails = [];
function check(name, ok, detail = "") {
  if (!ok) fails.push(name);
  console.log(ok ? "PASS" : "FAIL", name, detail);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (tool, args = {}, who = "agent") => j("/call", { method: "POST", body: JSON.stringify({ tool, args, who }) });

const launched = await call("launch_profile");
check("launch", !launched.isError && !launched.failed, JSON.stringify(launched.body ?? launched).slice(0, 160));
const loaded = await call("navigate", { url: `http://127.0.0.1:${info.fixture.split(":").pop()}/page` });
// Everything below reads this page, and would otherwise fail without saying why.
if (loaded.isError || loaded.failed) throw new Error(`navigate: ${JSON.stringify(loaded).slice(0, 300)}`);
await j("/clear");
await sleep(600);
const positions = (await call("evaluate_js", { expression: `JSON.stringify(Object.fromEntries(["btn", "text"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, [r.left + r.width / 2, r.top + r.height / 2]]; })).valueOf()) + "|" + innerWidth + "|" + innerHeight` })).body.result?.value;
const [positionJson, vwText, vhText] = positions.split("|");
const POS = JSON.parse(positionJson);
const vw = Number(vwText);
const vh = Number(vhText);
const req = await call("request_human", { reason: 'Solve <img src=x onerror="window.__xss=1"> it', kind: "captcha" });
const id = req.body.handoff_id;

const dir = mkdtempSync(join(tmpdir(), "mzui"));
const port = await freePort();
const browser = spawn(CHROME, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--headless=new", "--no-first-run", "--window-size=1400,1000", "about:blank"], { stdio: "ignore", windowsHide: true, cwd: dir });
try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])).find((t) => t.type === "page");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method) events.push(d);
  };
  const send = (method, params = {}) => new Promise((done) => { const i = ++seq; pending.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${info.base}/panel#${id}` });
  await sleep(1500);
  const blocked = events.filter((e) => e.method === "Runtime.exceptionThrown");
  check("the page loads with no script error under its CSP", blocked.length === 0, blocked[0]?.params?.exceptionDetails?.text ?? "");

  // Sign in as a person would: the field, then the button.
  const op = (await j("/token?who=op")).token;
  await evaluate(`document.querySelector('input[type=password]').focus()`);
  await send("Input.insertText", { text: op });
  await evaluate(`document.querySelector('form.login button[type=submit]').click()`);
  await sleep(1500);
  const text = await evaluate(`document.body.innerText`);
  check("signed in, the handoff listed with its reason as text", text.includes('Solve <img src=x onerror="window.__xss=1"> it'), text.slice(0, 200).replace(/\n/g, " | "));
  check("the agent's text didn't run as markup", (await evaluate(`window.__xss === undefined && document.querySelectorAll("img[src='x']").length === 0`)) === true);
  check("the token isn't in the page", !(await evaluate(`document.documentElement.outerHTML`)).includes(op));
  check("the cookie isn't readable from script", (await evaluate(`document.cookie`)) === "");

  // A live frame.
  let image = null;
  for (let i = 0; i < 20; i++) {
    image = await evaluate(`(() => { const i = document.querySelector(".viewer img"); return i ? [i.hidden, i.naturalWidth, i.naturalHeight] : null; })()`);
    if (image && image[1] > 100) break;
    await sleep(250);
  }
  check("it shows a live frame", !!image && image[0] === false && image[1] > 100, JSON.stringify(image));

  // A real click in the frame, on the fixture's "Click me" button, through the panel.
  const [bx, by] = POS.btn;
  const rect = await evaluate(`(() => { const r = document.querySelector(".viewer img").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const x = rect[0] + (bx / vw) * rect[2];
  const y = rect[1] + (by / vh) * rect[3];
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", pointerType: "mouse" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  await sleep(1000);
  let seen = await j("/reports");
  check("a click in the panel's frame reached the page", seen.some((r) => r.ev === "click" && r.target === "btn" && r.trusted), JSON.stringify(seen.filter((r) => r.ev === "click")).slice(0, 160));

  // Text through its box, into the page's field the person clicks first.
  const [fx, fy] = POS.text;
  const px = rect[0] + (fx / vw) * rect[2];
  const py = rect[1] + (fy / vh) * rect[3];
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  await sleep(500);
  await evaluate(`document.querySelector('textarea').focus()`);
  await send("Input.insertText", { text: "MZMARKER из панели" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(1000);
  seen = await j("/reports");
  check("text from the panel's box reached the page", seen.some((r) => r.ev === "input" && r.value === "MZMARKER из панели"), seen.filter((r) => r.ev === "input").at(-1)?.value);

  const waiting = call("wait_for_human", { handoff_id: id, timeout_ms: 30_000 });
  await sleep(200);
  await evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Resume").click()`);
  const res = await waiting;
  check("the panel's Resume button releases the agent", res.body.status === "resumed" && res.body.resumed === true, JSON.stringify(res.body).slice(0, 140));
  await sleep(800);
  const after = await evaluate(`document.body.innerText`);
  check("the panel moved on", !after.includes("Solve <img"), after.slice(0, 120).replace(/\n/g, " | "));
  const grep = await j(`/grep?q=MZMARKER`);
  check("nothing typed in the logs", grep.matches === 0);
  ws.close();
} catch (e) {
  fails.push(String(e));
  console.log("ERROR", e.stack ?? e);
} finally {
  await call("close_profile").catch(() => {});
  if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { windowsHide: true });
  else browser.kill("SIGKILL");
  await sleep(800);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
process.exitCode = fails.length ? 1 : 0;
