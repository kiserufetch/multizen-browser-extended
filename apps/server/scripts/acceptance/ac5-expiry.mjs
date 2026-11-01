// AC5, against a harness.mjs started with a short --ttl-ms and --webhook unreachable: a handoff nobody answers,
// and an endpoint nobody hears. Expiry mid-input, what the agent then sees, and the logs. Run it through
// ac5-run.mjs, which says how and starts that harness.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const op = (await j("/token?who=op")).token;
const post = (path, body, cookie) =>
  fetchRetryingConnect(`${origin}/panel/api/${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const login = await post("login", { token: op });
const cookie = login.headers.get("set-cookie").split(";")[0];

const launched = await call("launch_profile");
check("launch", !launched.isError && !launched.failed, JSON.stringify(launched.body ?? launched).slice(0, 160));
await call("navigate", { url: `http://127.0.0.1:${info.fixture.split(":").pop()}/page` });

const started = Date.now();
const req = await call("request_human", { reason: "nobody comes", kind: "login" });
check("request_human returns at once, with an unreachable webhook", Date.now() - started < 2000 && !!req.body.handoff_id, `${Date.now() - started} ms, expires ${req.body.expires_at}`);
const id = req.body.handoff_id;

// A person starts typing, then the time runs out under them.
const typed = await post(`handoffs/${id}/input`, { events: [{ kind: "text", text: "MZMARKER mid-input" }] }, cookie);
check("input during it", typed.status === 200, `status ${typed.status}`);
const blocked = await call("extract");
check("login kind: extract refused meanwhile", codeOf(blocked) === "HUMAN_IN_CONTROL");

const polled = [];
for (let i = 0; i < 80; i++) {
  const r = await call("get_human_status", { handoff_id: id });
  polled.push(r.body.status);
  if (r.body.status !== "pending") break;
  await sleep(250);
}
const kinds = [...new Set(polled)];
check("polling sees it expire", kinds.at(-1) === "expired", `${polled.length} polls: ${kinds.join(",")}`);
const waited = await call("wait_for_human", { handoff_id: id, timeout_ms: 1000 });
check("wait_for_human says expired, not resumed", waited.body.status === "expired" && waited.body.resumed === false, JSON.stringify(waited.body).slice(0, 160));
const late = await post(`handoffs/${id}/input`, { events: [{ kind: "text", text: "too late" }] }, cookie);
check("input after it: 409", late.status === 409, `status ${late.status}`);
const lateResume = await post(`handoffs/${id}/resume`, {}, cookie);
check("Resume after it: 409", lateResume.status === 409, `status ${lateResume.status}`);
check("an agent action works again", codeOf(await call("press_key", { key: "Escape" })) === null);
const unknown = await call("get_human_status", { handoff_id: "00000000-0000-0000-0000-000000000000" });
check("an unknown id: HANDOFF_NOT_FOUND", codeOf(unknown) === "HANDOFF_NOT_FOUND");

const warns = await j("/warns");
const hook = warns.filter((l) => l.includes("handoff webhook"));
check("the unreachable webhook cost a log line", hook.length >= 1, hook[0]);
const secret = await j(`/grep?q=SECRETWEBHOOKKEY`);
check("its URL isn't in the logs", secret.matches === 0, `${secret.total} bytes of logs`);
const marker = await j(`/grep?q=MZMARKER`);
check("what was typed isn't in the logs", marker.matches === 0);
const hooksSeen = await j("/webhooks");
check("nothing arrived anywhere it shouldn't", Array.isArray(hooksSeen) && hooksSeen.length === 0, `${hooksSeen.length} at the local listener`);
console.log("lifecycle", JSON.stringify(await j("/lifecycle")));
console.log(fails.length ? `FAILED: ${fails.join("; ")}` : "ALL PASS");
process.exitCode = fails.length ? 1 : 0;
