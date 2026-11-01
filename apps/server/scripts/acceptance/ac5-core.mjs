// AC5, the handoff's core, against a running harness.mjs, through the panel's own HTTP API: what the
// page sends. The real engine answers; the fixture says what it really received. CloakBrowser and Camoufox,
// on Windows and in Docker. Run it through ac5-run.mjs, which says how.
import { fetchRetryingConnect, getJsonRetrying } from "./flow.mjs";

const CTRL = process.env.CTRL || 18980;
const j = async (path, init) =>
  init ? (await fetchRetryingConnect(`http://127.0.0.1:${CTRL}${path}`, init)).json() : getJsonRetrying(`http://127.0.0.1:${CTRL}${path}`);
const info = await j("/info");
const origin = info.base;
const fails = [];
function check(name, ok, detail = "") {
  if (!ok) fails.push(name);
  console.log(ok ? "PASS" : "FAIL", name, detail);
}
const call = (tool, args = {}, who = "agent") => j("/call", { method: "POST", body: JSON.stringify({ tool, args, who }) });
const codeOf = (res) => (res.isError ? res.body.error.code : null);
const op = (await j("/token?who=op")).token;
const post = (path, body, cookie) =>
  fetchRetryingConnect(`${origin}/panel/api/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const login = await post("login", { token: op });
check("login with the operator token", login.status === 200);
const setCookie = login.headers.get("set-cookie");
check("cookie flags", /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\/panel/.test(setCookie));
const cookie = setCookie.split(";")[0];
const get = (path) => fetchRetryingConnect(`${origin}/panel/api/${path}`, { headers: { cookie } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reports = () => j("/reports");

console.log("launch", JSON.stringify((await call("launch_profile")).body).slice(0, 120));
await call("navigate", { url: `http://127.0.0.1:${info.fixture.split(":").pop()}/page` });
await sleep(800);
const rects = (
  await call("evaluate_js", {
    expression: `JSON.stringify(Object.fromEntries(["text","btn","alert","prompt","pick","popup","sel","fr"].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [id,[r.left+r.width/2,r.top+r.height/2,r.left,r.top]]})).valueOf())+"|"+innerWidth+"|"+innerHeight`,
  })
).body.result?.value ?? "";
const [rectJson, vw, vh] = rects.split("|");
const R = JSON.parse(rectJson);
const at = (id) => ({ x: R[id][0] / +vw, y: R[id][1] / +vh });
const frameInput = { x: (R.fr[2] + 200) / +vw, y: (R.fr[3] + 16) / +vh };
console.log("viewport", vw, vh);

// What the README says about login flows: a listener left before the handoff reads what the person types. Kept in
// the DOM, which evaluate_js on Camoufox and the page share.
await call("evaluate_js", { expression: `(() => { document.addEventListener("keydown", (e) => { document.documentElement.dataset.mzSeen = (document.documentElement.dataset.mzSeen ?? "") + e.key; }, true); return 1; })()` });

const pixelOk = (buf) => buf[0] === 0xff && buf[1] === 0xd8;
const req = await call("request_human", { reason: "Docker core: please do it", kind: "captcha" });
check("request_human returns at once with an id", req.body.status === "waiting_for_human" && !!req.body.handoff_id);
const id = req.body.handoff_id;
// An agent that polls instead of waiting, for this whole handoff.
const polled = [];
let polling = true;
const poller = (async () => {
  while (polling) {
    const r = await call("get_human_status", { handoff_id: id });
    polled.push(r.isError ? r.body.error.code : r.body.status);
    await sleep(250);
  }
})();
await sleep(500);
const hooks = await j("/webhooks");
check(
  "webhook arrived, with no token",
  hooks.length >= 1 && hooks.at(-1).body.id === id && !/mz_t_/.test(JSON.stringify(hooks.at(-1).body)),
  hooks.at(-1)?.body.panelUrl,
);
const list = await (await get("handoffs")).json();
check("the panel lists it", list.handoffs.some((h) => h.id === id && h.kind === "captcha"));

const fr = await get(`handoffs/${id}/frame`);
const jpeg = Buffer.from(await fr.arrayBuffer());
check("a frame is a JPEG of a real size", fr.status === 200 && pixelOk(jpeg) && +fr.headers.get("x-frame-width") > 300, `${jpeg.length} bytes, ${fr.headers.get("x-frame-width")}x${fr.headers.get("x-frame-height")}`);
if (process.env.FRAME_OUT) (await import("node:fs")).writeFileSync(process.env.FRAME_OUT, jpeg);

const send = async (...events) => (await post(`handoffs/${id}/input`, { events }, cookie)).status;
const click = (p) => [
  { kind: "mouse", action: "move", ...p, button: "none", buttons: 0 },
  { kind: "mouse", action: "down", ...p, button: "left", buttons: 1, clickCount: 1 },
  { kind: "mouse", action: "up", ...p, button: "left", buttons: 0, clickCount: 1 },
];
const key = (k, code, keyCode, text) => [
  { kind: "key", action: "down", key: k, code, keyCode, modifiers: 0, ...(text ? { text } : {}) },
  { kind: "key", action: "up", key: k, code, keyCode, modifiers: 0 },
];
await send(...click(at("text")));
await send(...key("a", "KeyA", 65, "a"), ...key("b", "KeyB", 66, "b"));
await send({ kind: "text", text: "MZMARKER Привет 日本語 🎉" });
await send(...key("Tab", "Tab", 9));
await send(...key("Enter", "Enter", 13, "\r"));
await sleep(500);
let seen = await reports();
const mainValue = seen.filter((r) => r.frame === "main" && r.ev === "input").at(-1)?.value;
check("typed and non-ASCII text reached the page", mainValue === "abMZMARKER Привет 日本語 🎉", mainValue);
check("Tab then Enter pressed the button", seen.some((r) => r.ev === "click" && r.target === "btn" && r.trusted));

await send(...click(frameInput));
await send(...key("x", "KeyX", 88, "x"), ...key("y", "KeyY", 89, "y"));
await sleep(400);
seen = await reports();
const frameValue = seen.filter((r) => r.frame === "oopif" && r.ev === "input").at(-1)?.value;
check("keys reached the cross-origin iframe", frameValue === "xy", `${frameValue}`);

await send({ kind: "wheel", x: 0.5, y: 0.7, deltaX: 0, deltaY: 120 });
await sleep(400);
seen = await reports();
check("the wheel reached the page", seen.some((r) => r.ev === "wheel" && r.dy > 0 && r.trusted));
await send({ kind: "wheel", x: 0.5, y: 0.7, deltaX: 0, deltaY: -600 });
await sleep(800);

check("agent click is refused", codeOf(await call("click", { selector: "#btn" })) === "HUMAN_IN_CONTROL");
check("agent extract passes for captcha", codeOf(await call("extract")) === null);
check("resume_human needs operator", codeOf(await call("resume_human")) === "FORBIDDEN");

// A dialog: frames say so, the agent doesn't hang, the panel answers.
await send(...click(at("prompt")));
await sleep(400);
const during = await get(`handoffs/${id}/frame`);
const dialogs = await during.json();
check("a frame during a dialog is 423 with the dialog", during.status === 423 && dialogs.dialogs?.[0]?.type === "prompt");
const started = Date.now();
check("agent read during a dialog says DIALOG_OPEN", codeOf(await call("extract")) === "DIALOG_OPEN", `${Date.now() - started} ms`);
await post(`handoffs/${id}/dialog`, { dialog_id: dialogs.dialogs[0].id, action: "accept", prompt_text: "MZMARKER answer" }, cookie);
await sleep(400);
seen = await reports();
check("the panel's answer reached the page", seen.some((r) => r.ev === "prompt" && r.result === "MZMARKER answer"));

// A file chooser.
await send(...click(at("pick")));
await sleep(500);
const state = await (await get(`handoffs/${id}/state`)).json();
check("the chooser shows in the panel's state", state.fileChoosers?.length === 1);
const chooserRes = await post(`handoffs/${id}/file-chooser`, { chooser_id: state.fileChoosers[0]?.id, files: [{ file_name: "докер.txt", data_base64: Buffer.from("docker body").toString("base64") }] }, cookie);
await sleep(500);
seen = await reports();
check("the file reached the page", chooserRes.status === 200 && seen.some((r) => r.ev === "file" && r.name === "докер.txt" && r.body === "docker body"));

// A popup, by the tab list.
await send(...click(at("popup")));
await sleep(1500);
let tabs = (await (await get(`handoffs/${id}/state`)).json()).tabs;
const popup = tabs.find((t) => /popup/.test(t.url));
check("the popup is in the tab list", !!popup);
await post(`handoffs/${id}/activate-tab`, { target_id: popup?.targetId }, cookie);
await sleep(400);
const popupFrame = await get(`handoffs/${id}/frame`);
await popupFrame.arrayBuffer();
check("a frame of the popup", popupFrame.status === 200);
tabs = (await (await get(`handoffs/${id}/state`)).json()).tabs;
check("the popup is active", tabs.find((t) => t.targetId === popup?.targetId)?.active === true);

// Resume releases the agent.
const waiting = call("wait_for_human", { timeout_ms: 30000 });
await sleep(300);
const resumed = await post(`handoffs/${id}/resume`, {}, cookie);
const res = await waiting;
check("Resume releases wait_for_human as resumed", resumed.status === 200 && res.body.resumed === true && res.body.status === "resumed");
await sleep(600);
polling = false;
await poller;
const kinds = [...new Set(polled)];
check("an agent polling get_human_status saw pending, then resumed, never blocked", kinds.join(",") === "pending,resumed", `${polled.length} polls: ${kinds.join(",")}`);
const listed = (await call("list_tabs")).body;
const mainTab = listed.targetInfos.find((t) => t.type === "page" && new URL(t.url).pathname === "/page");
await call("activate_tab", { target_id: mainTab.targetId });
const leaked = (await call("evaluate_js", { expression: `document.documentElement.dataset.mzSeen ?? ""` })).body.result?.value ?? "";
check("a documented hole: a listener evaluate_js left before the handoff read what the person typed", leaked.startsWith("ab"), leaked.slice(0, 20));
const status = await call("get_human_status", { handoff_id: id });
check("the actor is recorded", status.body.settled_by === "op");
const after = await post(`handoffs/${id}/input`, { events: key("a", "KeyA", 65, "a") }, cookie);
check("input after the end is 409", after.status === 409);
check("an agent action works again", codeOf(await call("press_key", { key: "Escape" })) === null);

// 2fa: reads refused. Abort: not resumed.
const second = await call("request_human", { reason: "code", kind: "2fa" });
for (const tool of ["extract", "screenshot", "get_cookies"]) {
  check(`${tool} is refused during 2fa`, codeOf(await call(tool)) === "HUMAN_IN_CONTROL");
}
const waiting2 = call("wait_for_human", { timeout_ms: 30000 });
await sleep(200);
await post(`handoffs/${second.body.handoff_id}/abort`, {}, cookie);
const res2 = await waiting2;
check("Abort: status aborted, not resumed", res2.body.status === "aborted" && res2.body.resumed === false);

// Crash.
const launched = await call("launch_profile", {}, "owner");
const third = await call("request_human", { reason: "crash", kind: "login" });
const waiting3 = call("wait_for_human", { timeout_ms: 30000 });
await sleep(200);
const kill = await j(`/kill-pid?pid=${launched.body.pid}`, { method: "POST" });
const res3 = await waiting3;
check("a crashed browser aborts the handoff", res3.body.status === "aborted" && res3.body.resumed === false, JSON.stringify(kill));
const crashStatus = await call("get_human_status", { handoff_id: third.body.handoff_id });
check("and says so", crashStatus.body.settled_by === "browser exited", crashStatus.body.settled_by);

const grep = await j(`/grep?q=MZMARKER`);
check("no typed text in the logs", grep.matches === 0, `${grep.total} bytes of logs`);
const grep2 = await j(`/grep?q=${encodeURIComponent("Привет")}`);
check("no non-ASCII typed text in the logs", grep2.matches === 0);
const grep3 = await j(`/grep?q=${encodeURIComponent("/9j/")}`);
check("no frame data in the logs", grep3.matches === 0);
console.log("lifecycle", JSON.stringify(await j("/lifecycle")));
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
process.exitCode = fails.length ? 1 : 0;
