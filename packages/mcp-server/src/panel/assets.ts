/**
 * The handoff panel's page, as strings, so both bundlers embed it with no build step and
 * it needs nothing from outside this server. What a page, an agent or a profile says
 * (reason, names, titles, URLs, dialog text) is untrusted: this code puts it in the DOM
 * with textContent only, which a test keeps true.
 */

export const PANEL_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#7c5cff"/><path d="M8 23V9l8 8 8-8v14" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>MultiZen handoff</title>
<link rel="icon" href="/panel/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/panel/app.css">
</head>
<body>
<div id="app"></div>
<script src="/panel/app.js"></script>
</body>
</html>
`;

export const PANEL_CSS = `:root {
  --bg: #f4f4f7;
  --surface: #ffffff;
  --raised: #eeeef3;
  --line: #d9d9e2;
  --text: #1c1c26;
  --muted: #62626f;
  --accent: #5b3fe0;
  --accent-text: #ffffff;
  --danger: #b3261e;
  --warn: #8a5a00;
  --warn-bg: #fdf3dc;
  --sensitive-bg: #fbe4e2;
  --sensitive-text: #8c1d18;
  --ring: #5b3fe0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101116;
    --surface: #181920;
    --raised: #23242d;
    --line: #2f303b;
    --text: #ececf1;
    --muted: #9d9dab;
    --accent: #8f78ff;
    --accent-text: #0e0e14;
    --danger: #ff8a80;
    --warn: #e6b955;
    --warn-bg: #30270f;
    --sensitive-bg: #3a1c1a;
    --sensitive-text: #ffb4ab;
    --ring: #a895ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); }
#app { height: 100%; min-height: 0; display: flex; flex-direction: column; }
[hidden] { display: none !important; }
h1, h2, p { margin: 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button {
  min-height: 34px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--raised);
  cursor: pointer;
}
button:hover { border-color: var(--muted); }
button:disabled { opacity: 0.55; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.danger { color: var(--danger); background: transparent; border-color: var(--danger); }
button.quiet { background: transparent; border-color: transparent; color: var(--muted); }
button.quiet:hover { color: var(--text); border-color: var(--line); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
input[type="password"], input[type="text"], textarea, select {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
}
textarea { resize: vertical; min-height: 36px; }

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; }
.brand small { font-weight: 400; color: var(--muted); margin-left: 6px; font-size: 13px; }
.spacer { flex: 1; }
.who { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30vw; }

.login {
  width: min(380px, calc(100vw - 32px));
  margin: 12vh auto 24px;
  padding: 24px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.login h1 { font-size: 18px; }
.login p { color: var(--muted); }
.login label { display: flex; flex-direction: column; gap: 4px; font-weight: 500; }
.error { color: var(--danger); min-height: 1.2em; }

.layout { flex: 1; display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; }
.list { border-right: 1px solid var(--line); padding: 12px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.list h2 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-height: 44px;
  text-align: left;
  padding: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.item[aria-current="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.item-head { display: flex; align-items: center; gap: 6px; }
.item-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.item-reason { color: var(--muted); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.chip {
  flex: none;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--raised);
  color: var(--muted);
}
.chip.sensitive { background: var(--sensitive-bg); color: var(--sensitive-text); }
.clock { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.clock.soon { color: var(--warn); font-weight: 600; }

.stage { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 12px 16px 16px; gap: 10px; overflow: auto; }
.stage-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.stage-title { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 2px; }
.stage-title h1 { font-size: 16px; overflow-wrap: anywhere; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stage-title p { color: var(--muted); overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; flex: none; }
.tabs { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tabs label { color: var(--muted); font-size: 13px; flex: none; }
.tabs select { min-width: 0; }
.address { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.viewer {
  position: relative;
  flex: 1 0 240px;
  overflow: hidden;
  background: var(--raised);
  border: 1px solid var(--line);
  border-radius: 10px;
  outline: none;
}
.viewer:focus { border-color: var(--ring); box-shadow: 0 0 0 1px var(--ring); }
.viewer img {
  position: absolute;
  inset: 0 0 auto;
  margin: 0 auto;
  max-width: 100%;
  max-height: 100%;
  cursor: default;
  user-select: none;
  -webkit-user-drag: none;
}
.viewer.blocked img { opacity: 0.35; }
.viewer-note { position: absolute; inset: auto 8px 8px; padding: 6px 10px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); color: var(--muted); font-size: 12px; text-align: center; pointer-events: none; }

.ask { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 10px; border: 1px solid var(--accent); background: var(--surface); }
.ask h2 { font-size: 14px; }
.ask-message { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow: auto; }
.ask-origin { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.ask-row { display: flex; gap: 8px; flex-wrap: wrap; }
.control-note { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); }

.composer { display: flex; gap: 8px; align-items: flex-start; }
.composer textarea { flex: 1; min-width: 0; }
.keys { display: flex; gap: 6px; flex-wrap: wrap; }
.keys button { min-width: 44px; padding: 4px 10px; font-size: 13px; }
.help { color: var(--muted); font-size: 13px; }
.help summary { cursor: pointer; }
.help ul { margin: 6px 0 0; padding-left: 18px; }

.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 32px 16px; text-align: center; color: var(--muted); }
.empty strong { color: var(--text); font-size: 15px; }
.status { padding: 8px 16px; background: var(--raised); color: var(--muted); font-size: 13px; }

@media (max-width: 720px) {
  #app { height: auto; min-height: 100%; }
  .layout { grid-template-columns: minmax(0, 1fr); }
  .list { border-right: 0; border-bottom: 1px solid var(--line); max-height: 30vh; }
  .list.single { display: none; }
  .stage { padding: 10px 12px 76px; overflow: visible; }
  .viewer { flex: none; min-height: 160px; }
  .viewer img { position: static; display: block; max-height: none; width: 100%; }
  .actions {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    padding: 10px 12px;
    background: var(--surface);
    border-top: 1px solid var(--line);
  }
  .actions button { flex: 1; min-height: 48px; }
  .who { display: none; }
}
`;

export const PANEL_JS = String.raw`"use strict";
(function () {
  var KIND_LABEL = { captcha: "CAPTCHA", "2fa": "2FA", login: "Login", confirm: "Confirm", other: "Step" };
  var DIALOG_LABEL = {
    alert: ["Alert", "OK", null],
    confirm: ["Confirm", "OK", "Cancel"],
    prompt: ["Prompt", "OK", "Cancel"],
    beforeunload: ["Leave this page?", "Leave", "Stay"]
  };
  var MIN_FRAME_MS = 200;
  var LIST_POLL_MS = 2000;
  var STATE_POLL_MS = 1000;
  var LINE_PX = 16;

  var app = document.getElementById("app");
  var S = {
    name: null,
    handoffs: [],
    selected: location.hash.length > 1 ? location.hash.slice(1) : null,
    clockOffset: 0,
    detail: null,
    view: 0,
    frameUrl: null,
    frameBlocked: false,
    frameNote: "",
    flash: "",
    queue: [],
    sending: false,
    held: {},
    pressed: 0,
    lastPoint: { x: 0, y: 0 },
    timers: []
  };

  /** Builds an element. Children and every string go in as text, never as markup. */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (key.indexOf("on") === 0) el.addEventListener(key.slice(2), value);
        else if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key === "hidden" || key === "disabled" || key === "multiple" || key === "selected") el[key] = !!value;
        else if (key === "value") el.value = value;
        else el.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function api(path, opts) {
    return fetch("/panel/api/" + path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts));
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function readJson(res) {
    return res.json().catch(function () {
      return {};
    });
  }

  function isSensitive(kind) {
    return kind === "2fa" || kind === "login";
  }

  function kindChip(kind) {
    return h("span", { class: isSensitive(kind) ? "chip sensitive" : "chip", text: KIND_LABEL[kind] || "Step" });
  }

  function clockText(expiresAt) {
    var left = Math.max(0, new Date(expiresAt).getTime() - (Date.now() + S.clockOffset));
    var seconds = Math.ceil(left / 1000);
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ":" + (rest < 10 ? "0" : "") + rest + " left";
  }

  function clockClass(expiresAt) {
    var left = new Date(expiresAt).getTime() - (Date.now() + S.clockOffset);
    return left < 60000 ? "clock soon" : "clock";
  }

  // ── Sign-in ──────────────────────────────────────────────────────────────────

  function showLogin(message) {
    S.view++;
    S.name = null;
    S.detail = null;
    releaseFrame();
    var error = h("p", { class: "error", role: "alert", text: message || "" });
    var token = h("input", { type: "password", autocomplete: "off", spellcheck: "false", required: "required" });
    var submit = h("button", { class: "primary", type: "submit", text: "Sign in" });
    var form = h(
      "form",
      {
        class: "login",
        onsubmit: function (e) {
          e.preventDefault();
          submit.disabled = true;
          signIn(token.value).then(function (problem) {
            token.value = "";
            submit.disabled = false;
            if (problem) error.textContent = problem;
          });
        }
      },
      h("h1", { text: "MultiZen handoff" }),
      h("p", { text: "Sign in with a token that holds the operator group. It stays in this page only long enough to swap it for a session." }),
      h("label", null, "Token", token),
      error,
      submit
    );
    app.replaceChildren(form);
    token.focus();
  }

  function signIn(token) {
    return post("login", { token: token }).then(function (res) {
      if (res.ok) {
        return readJson(res).then(function (me) {
          S.name = me.name;
          startMain();
          return null;
        });
      }
      if (res.status === 403) return "This token has no operator group, so it can't use the panel.";
      if (res.status === 429) return "Too many failed attempts from this address. Wait a minute and try again.";
      return "That token isn't valid, or has ended.";
    }, function () {
      return "Can't reach the server.";
    });
  }

  function signOut() {
    post("logout").then(function () {
      showLogin("");
    }, function () {
      showLogin("");
    });
  }

  // ── Layout ───────────────────────────────────────────────────────────────────

  var dom = {};

  function startMain() {
    S.view++;
    dom.who = h("span", { class: "who", text: S.name || "" });
    dom.list = h("aside", { class: "list", "aria-label": "Waiting handoffs" });
    dom.stage = h("main", { class: "stage" });
    dom.status = h("div", { class: "status", role: "status", hidden: true });
    app.replaceChildren(
      h(
        "header",
        { class: "topbar" },
        h("span", { class: "brand" }, "MultiZen", h("small", { text: "handoff" })),
        h("span", { class: "spacer" }),
        dom.who,
        h("button", { class: "quiet", type: "button", text: "Sign out", onclick: signOut })
      ),
      dom.status,
      h("div", { class: "layout" }, dom.list, dom.stage)
    );
    var view = S.view;
    listLoop(view);
    stateLoop(view);
    frameLoop(view);
    clockLoop(view);
  }

  function flash(text) {
    S.flash = text;
    dom.status.textContent = text;
    dom.status.hidden = !text;
    if (text) {
      setTimeout(function () {
        if (S.flash === text) flash("");
      }, 6000);
    }
  }

  function renderList() {
    dom.list.className = S.handoffs.length < 2 ? "list single" : "list";
    var title = h("h2", { text: S.handoffs.length ? "Waiting for a person" : "Nothing waiting" });
    var items = S.handoffs.map(function (item) {
      return h(
        "button",
        {
          class: "item",
          type: "button",
          "aria-current": item.id === S.selected ? "true" : "false",
          onclick: function () {
            select(item.id);
          }
        },
        h("span", { class: "item-head" }, h("span", { class: "item-name", text: item.profileName }), kindChip(item.kind)),
        h("span", { class: "item-reason", text: item.reason }),
        h("span", { class: clockClass(item.expiresAt), "data-expires": item.expiresAt, text: clockText(item.expiresAt) })
      );
    });
    dom.list.replaceChildren.apply(dom.list, [title].concat(items));
  }

  function select(id) {
    S.selected = id;
    S.detail = null;
    S.queue.length = 0;
    S.held = {};
    S.pressed = 0;
    releaseFrame();
    history.replaceState(null, "", id ? "#" + id : location.pathname);
    renderList();
    renderStage();
  }

  function current() {
    for (var i = 0; i < S.handoffs.length; i++) {
      if (S.handoffs[i].id === S.selected) return S.handoffs[i];
    }
    return null;
  }

  // ── The stage ────────────────────────────────────────────────────────────────

  function renderStage() {
    var item = current();
    if (!item) {
      dom.viewer = null;
      dom.image = null;
      dom.stage.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("strong", { text: "No one is waiting" }),
          h("span", { text: "When an agent asks for a person, it shows up here." })
        )
      );
      return;
    }
    dom.title = h(
      "div",
      { class: "stage-title" },
      h("h1", null, h("span", { text: item.profileName }), kindChip(item.kind)),
      h("p", { text: item.reason }),
      h("span", { class: clockClass(item.expiresAt), "data-expires": item.expiresAt, text: clockText(item.expiresAt) })
    );
    dom.resume = h("button", { class: "primary", type: "button", text: "Resume", onclick: resume });
    dom.abort = h("button", { class: "danger", type: "button", text: "Abort", onclick: abort });
    dom.tabs = h("div", { class: "tabs", hidden: true });
    dom.address = h("div", { class: "address" });
    dom.asks = h("div", { class: "asks" });
    dom.control = h("div", { hidden: true });
    dom.image = h("img", { alt: "The page, as the browser shows it", draggable: "false", hidden: true });
    dom.note = h("div", { class: "viewer-note", text: "Waiting for the first frame…" });
    dom.viewer = h(
      "div",
      {
        class: "viewer",
        tabindex: "0",
        "aria-label": "The page. Click it, then type: the keyboard goes to the page while this has focus.",
        onmousedown: onMouseDown,
        onmousemove: onMouseMove,
        oncontextmenu: function (e) {
          e.preventDefault();
        },
        onwheel: onWheel,
        onkeydown: function (e) {
          onKey(e, "down");
        },
        onkeyup: function (e) {
          onKey(e, "up");
        },
        onblur: releaseKeys
      },
      dom.image,
      dom.note
    );
    dom.text = h("textarea", {
      rows: "1",
      placeholder: "Paste or compose text for the page. Enter sends it.",
      "aria-label": "Text to send to the page",
      autocomplete: "off",
      onkeydown: function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendText();
        }
      }
    });
    dom.stage.replaceChildren(
      h("div", { class: "stage-head" }, dom.title, h("div", { class: "actions" }, dom.resume, dom.abort)),
      dom.tabs,
      dom.address,
      dom.control,
      dom.asks,
      dom.viewer,
      h("div", { class: "composer" }, dom.text, h("button", { type: "button", text: "Send", onclick: sendText })),
      h(
        "div",
        { class: "keys", role: "group", "aria-label": "Keys" },
        keyButton("Tab", "Tab", 9),
        keyButton("Enter", "Enter", 13),
        keyButton("Esc", "Escape", 27),
        keyButton("↑", "ArrowUp", 38),
        keyButton("↓", "ArrowDown", 40),
        keyButton("⌫", "Backspace", 8)
      ),
      h(
        "details",
        { class: "help" },
        h("summary", { text: "What doesn't show here" }),
        h(
          "ul",
          null,
          h("li", { text: "A drop-down list may not appear in this view. Click it anyway, then choose with ↑ ↓ and Enter." }),
          h("li", { text: "File pickers and JavaScript dialogs do: they appear above the page as questions for you. On CloakBrowser, a file picker inside a frame from another site can't be caught." }),
          h("li", { text: "Permission prompts (camera, location, notifications) belong to the browser, not the page. They can't be answered from here." }),
          h("li", { text: "Your clipboard stays yours: paste into the text box above." })
        )
      )
    );
    renderDetail();
  }

  function keyButton(label, key, keyCode) {
    return h("button", {
      type: "button",
      text: label,
      onclick: function () {
        var base = { kind: "key", key: key, code: key, keyCode: keyCode, modifiers: 0 };
        enqueue(Object.assign({ action: "down" }, base, key === "Enter" ? { text: "\r" } : {}));
        enqueue(Object.assign({ action: "up" }, base));
      }
    });
  }

  function renderDetail() {
    var detail = S.detail;
    if (!dom.viewer) return;
    if (!detail) {
      dom.tabs.hidden = true;
      dom.asks.replaceChildren();
      return;
    }
    renderTabs(detail);
    renderAsks(detail);
    if (detail.otherOwner) {
      dom.control.className = "control-note";
      dom.control.hidden = false;
      dom.control.replaceChildren(
        h("span", { text: detail.otherOwner + " is typing in this handoff." }),
        h("button", { type: "button", text: "Take control", onclick: takeControl })
      );
    } else {
      dom.control.hidden = true;
    }
  }

  function renderTabs(detail) {
    var active = detail.tabs.filter(function (t) {
      return t.active;
    })[0];
    dom.address.textContent = active ? active.url : "";
    if (detail.tabs.length < 2) {
      dom.tabs.hidden = true;
      return;
    }
    var key = JSON.stringify(detail.tabs);
    if (dom.tabs.getAttribute("data-key") === key && !dom.tabs.hidden) return;
    dom.tabs.setAttribute("data-key", key);
    var picker = h("select", {
      "aria-label": "Tab",
      onchange: function () {
        post("handoffs/" + encodeURIComponent(S.selected) + "/activate-tab", { target_id: picker.value }).then(function (res) {
          if (res.status === 409) return refreshList();
          if (!res.ok) flash("Couldn't switch tabs.");
        });
      }
    });
    detail.tabs.forEach(function (tab, index) {
      picker.appendChild(
        h("option", { value: tab.targetId, selected: tab.active, text: (tab.title || tab.url || "Tab " + (index + 1)) })
      );
    });
    dom.tabs.hidden = false;
    dom.tabs.replaceChildren(h("label", { text: detail.tabs.length + " tabs" }), picker);
  }

  function renderAsks(detail) {
    var key = JSON.stringify([detail.dialogs, detail.fileChoosers]);
    if (dom.asks.getAttribute("data-key") === key) return;
    dom.asks.setAttribute("data-key", key);
    var children = [];
    detail.dialogs.forEach(function (dialog) {
      children.push(dialogAsk(dialog));
    });
    detail.fileChoosers.forEach(function (chooser) {
      children.push(chooserAsk(chooser));
    });
    dom.asks.replaceChildren.apply(dom.asks, children);
    if (dom.viewer) dom.viewer.classList.toggle("blocked", detail.dialogs.length > 0);
  }

  function dialogAsk(dialog) {
    var labels = DIALOG_LABEL[dialog.type] || DIALOG_LABEL.alert;
    var answer = dialog.type === "prompt"
      ? h("input", { type: "text", value: dialog.defaultPrompt || "", "aria-label": "Answer", autocomplete: "off" })
      : null;
    var send = function (action) {
      var body = { dialog_id: dialog.id, action: action };
      if (answer && action === "accept") body.prompt_text = answer.value;
      post("handoffs/" + encodeURIComponent(S.selected) + "/dialog", body).then(function (res) {
        if (!res.ok && res.status !== 404) flash("Couldn't answer the dialog.");
        refreshState();
      });
    };
    return h(
      "section",
      { class: "ask", role: "alertdialog", "aria-label": labels[0] },
      h("h2", { text: labels[0] }),
      h("div", { class: "ask-message", text: dialog.message }),
      dialog.url ? h("div", { class: "ask-origin", text: dialog.url }) : null,
      answer,
      h(
        "div",
        { class: "ask-row" },
        h("button", { class: "primary", type: "button", text: labels[1], onclick: function () { send("accept"); } }),
        labels[2] ? h("button", { type: "button", text: labels[2], onclick: function () { send("dismiss"); } }) : null
      )
    );
  }

  function chooserAsk(chooser) {
    var picker = h("input", { type: "file", multiple: chooser.multiple, "aria-label": "Files to give the page" });
    var note = h("p", { class: "error" });
    var submit = h("button", {
      class: "primary",
      type: "button",
      text: "Give to the page",
      onclick: function () {
        if (!picker.files || picker.files.length === 0) {
          note.textContent = "Choose a file first.";
          return;
        }
        submit.disabled = true;
        readFiles(picker.files)
          .then(function (files) {
            return post("handoffs/" + encodeURIComponent(S.selected) + "/file-chooser", { chooser_id: chooser.id, files: files });
          })
          .then(function (res) {
            submit.disabled = false;
            if (res.status === 413) note.textContent = "Too large: up to 16 MB in total.";
            else if (!res.ok) note.textContent = "Couldn't give the file to the page.";
            else refreshState();
          }, function () {
            submit.disabled = false;
            note.textContent = "Couldn't read that file.";
          });
      }
    });
    return h(
      "section",
      { class: "ask", role: "dialog", "aria-label": "The page asks for a file" },
      h("h2", { text: chooser.multiple ? "The page asks for files" : "The page asks for a file" }),
      picker,
      note,
      h(
        "div",
        { class: "ask-row" },
        submit,
        h("button", {
          type: "button",
          text: "Cancel",
          onclick: function () {
            post("handoffs/" + encodeURIComponent(S.selected) + "/file-chooser", { chooser_id: chooser.id, cancel: true }).then(refreshState);
          }
        })
      )
    );
  }

  function readFiles(list) {
    return Promise.all(
      Array.prototype.map.call(list, function (file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onerror = function () {
            reject(reader.error);
          };
          reader.onload = function () {
            var url = String(reader.result);
            resolve({ file_name: file.name, data_base64: url.slice(url.indexOf(",") + 1) });
          };
          reader.readAsDataURL(file);
        });
      })
    );
  }

  // ── Resume, abort ────────────────────────────────────────────────────────────

  function resume() {
    var id = S.selected;
    dom.resume.disabled = true;
    post("handoffs/" + encodeURIComponent(id) + "/resume").then(function (res) {
      flash(res.ok ? "Handed back to the agent." : "This handoff had already ended.");
      return refreshList();
    });
  }

  function abort() {
    // A second press, so a stray tap on a phone doesn't throw away someone's work.
    if (dom.abort.getAttribute("data-armed") !== "1") {
      dom.abort.setAttribute("data-armed", "1");
      dom.abort.textContent = "Abort: sure?";
      var button = dom.abort;
      setTimeout(function () {
        if (button.isConnected) {
          button.removeAttribute("data-armed");
          button.textContent = "Abort";
        }
      }, 3000);
      return;
    }
    var id = S.selected;
    dom.abort.disabled = true;
    post("handoffs/" + encodeURIComponent(id) + "/abort").then(function (res) {
      flash(res.ok ? "Aborted. The agent is told the step wasn't done." : "This handoff had already ended.");
      return refreshList();
    });
  }

  function takeControl() {
    post("handoffs/" + encodeURIComponent(S.selected) + "/take-control").then(refreshState);
  }

  // ── Input ────────────────────────────────────────────────────────────────────

  function enqueue(event) {
    var last = S.queue[S.queue.length - 1];
    if (last && last.kind === "mouse" && last.action === "move" && event.kind === "mouse" && event.action === "move") {
      S.queue[S.queue.length - 1] = event;
    } else if (last && last.kind === "wheel" && event.kind === "wheel") {
      last.deltaX += event.deltaX;
      last.deltaY += event.deltaY;
    } else {
      S.queue.push(event);
    }
    pump();
  }

  function pump() {
    if (S.sending || !S.selected) return;
    S.sending = true;
    var view = S.view;
    var run = function () {
      if (view !== S.view || S.queue.length === 0 || !S.selected) {
        S.sending = false;
        return Promise.resolve();
      }
      var events = S.queue.splice(0, 64);
      return post("handoffs/" + encodeURIComponent(S.selected) + "/input", { events: events }).then(function (res) {
        if (res.ok) return run();
        S.queue.length = 0;
        S.sending = false;
        if (res.status === 401) return startOver();
        if (res.status === 409) {
          return readJson(res).then(function (body) {
            if (body.error === "input_owned") refreshState();
            else ended(body.status);
          });
        }
        if (res.status === 423) return refreshState();
        flash("That input didn't reach the page: the browser is busy. Try again.");
      }, function () {
        S.queue.length = 0;
        S.sending = false;
        flash("Can't reach the server.");
      });
    };
    run();
  }

  function pointOf(e) {
    var box = dom.image.getBoundingClientRect();
    if (!box.width || !box.height) return S.lastPoint;
    S.lastPoint = {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
    };
    return S.lastPoint;
  }

  function modifiersOf(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  var BUTTONS = ["left", "middle", "right"];

  function mouseEvent(e, action) {
    var point = pointOf(e);
    return {
      kind: "mouse",
      action: action,
      x: point.x,
      y: point.y,
      button: action === "move" ? "none" : BUTTONS[e.button] || "left",
      buttons: e.buttons,
      clickCount: action === "move" ? 0 : Math.max(1, e.detail),
      modifiers: modifiersOf(e)
    };
  }

  function onMouseDown(e) {
    if (!dom.image || dom.image.hidden || e.target !== dom.image) return;
    e.preventDefault();
    dom.viewer.focus();
    S.pressed |= 1 << e.button;
    enqueue(mouseEvent(e, "down"));
  }

  function onMouseMove(e) {
    if (!dom.image || dom.image.hidden) return;
    enqueue(mouseEvent(e, "move"));
  }

  document.addEventListener("mouseup", function (e) {
    if (!(S.pressed & (1 << e.button))) return;
    S.pressed &= ~(1 << e.button);
    enqueue(mouseEvent(e, "up"));
  });

  function onWheel(e) {
    if (!dom.image || dom.image.hidden) return;
    e.preventDefault();
    var unit = e.deltaMode === 1 ? LINE_PX : 1;
    var point = pointOf(e);
    enqueue({
      kind: "wheel",
      x: point.x,
      y: point.y,
      deltaX: e.deltaX * unit,
      deltaY: e.deltaY * unit,
      modifiers: modifiersOf(e)
    });
  }

  /** What the key types, for keys that type. Control chords and named keys don't. */
  function textOf(e) {
    var altGr = e.getModifierState && e.getModifierState("AltGraph");
    if ((e.ctrlKey || e.metaKey || e.altKey) && !altGr) return undefined;
    if (e.key === "Enter") return "\r";
    return Array.from(e.key).length === 1 ? e.key : undefined;
  }

  function onKey(e, action) {
    if (e.isComposing || e.keyCode === 229) return;
    // The browser here can't read a clipboard for the page, and shouldn't.
    if (action === "down" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      flash("Paste into the text box, then send it.");
      dom.text.focus();
      return;
    }
    e.preventDefault();
    var event = {
      kind: "key",
      action: action,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers: modifiersOf(e),
      location: e.location,
      repeat: e.repeat
    };
    if (action === "down") {
      var text = textOf(e);
      if (text !== undefined) event.text = text;
      S.held[e.code || e.key] = event;
    } else {
      delete S.held[e.code || e.key];
    }
    enqueue(event);
  }

  /** Focus left with keys down: the page would otherwise think they still are. */
  function releaseKeys() {
    Object.keys(S.held).forEach(function (code) {
      var down = S.held[code];
      enqueue({ kind: "key", action: "up", key: down.key, code: down.code, keyCode: down.keyCode, modifiers: 0 });
    });
    S.held = {};
  }

  function sendText() {
    var text = dom.text.value;
    if (!text) return;
    dom.text.value = "";
    enqueue({ kind: "text", text: text });
    dom.text.focus();
  }

  // ── Loops ────────────────────────────────────────────────────────────────────

  function startOver() {
    showLogin("Your session has ended. Sign in again.");
  }

  function ended(status) {
    var text = {
      resumed: "This handoff was resumed.",
      aborted: "This handoff was aborted, or its browser closed.",
      expired: "This handoff ran out of time. The agent has been told."
    }[status];
    if (text) flash(text);
    return refreshList();
  }

  function refreshList() {
    return api("handoffs").then(function (res) {
      if (res.status === 401) return startOver();
      if (!res.ok) return;
      return readJson(res).then(function (body) {
        S.clockOffset = new Date(body.now).getTime() - Date.now();
        S.handoffs = body.handoffs || [];
        var known = current();
        var pick = known ? S.selected : S.handoffs[0] ? S.handoffs[0].id : null;
        if (pick !== S.selected) select(pick);
        else if (pick ? !dom.viewer : !dom.stage.firstChild) renderStage();
        renderList();
      });
    });
  }

  function refreshState() {
    var id = S.selected;
    if (!id) return Promise.resolve();
    return api("handoffs/" + encodeURIComponent(id) + "/state").then(function (res) {
      if (id !== S.selected) return;
      if (res.status === 401) return startOver();
      if (res.status === 409 || res.status === 404) {
        return readJson(res).then(function (body) {
          return ended(body.status);
        });
      }
      if (!res.ok) return;
      return readJson(res).then(function (body) {
        if (id !== S.selected) return;
        S.detail = body;
        renderDetail();
      });
    });
  }

  function listLoop(view) {
    var tick = function () {
      if (view !== S.view) return;
      refreshList()
        .catch(function () {
          flash("Can't reach the server. Retrying…");
        })
        .then(function () {
          setTimeout(tick, LIST_POLL_MS);
        });
    };
    tick();
  }

  function stateLoop(view) {
    var tick = function () {
      if (view !== S.view) return;
      var work = document.hidden ? Promise.resolve() : refreshState();
      work.catch(function () {}).then(function () {
        setTimeout(tick, STATE_POLL_MS);
      });
    };
    tick();
  }

  function clockLoop(view) {
    var tick = function () {
      if (view !== S.view) return;
      document.querySelectorAll("[data-expires]").forEach(function (el) {
        var at = el.getAttribute("data-expires");
        el.textContent = clockText(at);
        el.className = clockClass(at);
      });
      setTimeout(tick, 1000);
    };
    tick();
  }

  function releaseFrame() {
    if (S.frameUrl) URL.revokeObjectURL(S.frameUrl);
    S.frameUrl = null;
  }

  function showFrame(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var image = dom.image;
      if (!image) {
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      image.onload = function () {
        image.hidden = false;
        dom.note.hidden = true;
        if (S.frameUrl && S.frameUrl !== url) URL.revokeObjectURL(S.frameUrl);
        S.frameUrl = url;
        resolve();
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        resolve();
      };
      image.src = url;
    });
  }

  /**
   * One request at a time, at most five a second, and only for a handoff that is pending
   * while this page is showing: the server captures nothing that isn't asked for.
   */
  function frameLoop(view) {
    var once = function () {
      if (view !== S.view) return Promise.resolve();
      var id = S.selected;
      if (!id || !dom.image || document.hidden) return sleep(400);
      var started = Date.now();
      return api("handoffs/" + encodeURIComponent(id) + "/frame")
        .then(function (res) {
          if (id !== S.selected) return null;
          if (res.ok) {
            if (dom.viewer) dom.viewer.classList.remove("blocked");
            return res.blob().then(showFrame);
          }
          if (res.status === 401) return startOver();
          if (res.status === 409 || res.status === 404) {
            return readJson(res).then(function (body) {
              return ended(body.status);
            });
          }
          if (res.status === 423) {
            if (dom.viewer) dom.viewer.classList.add("blocked");
            return refreshState().then(function () {
              return sleep(400);
            });
          }
          if (dom.note) {
            dom.note.hidden = false;
            dom.note.textContent = "The page isn't painting right now. Still trying…";
          }
          return sleep(500);
        })
        .catch(function () {
          return sleep(1000);
        })
        .then(function () {
          return sleep(Math.max(0, MIN_FRAME_MS - (Date.now() - started)));
        });
    };
    var loop = function () {
      if (view !== S.view) return;
      once().then(loop);
    };
    loop();
  }

  // ── Start ────────────────────────────────────────────────────────────────────

  api("me").then(function (res) {
    if (res.ok) {
      return readJson(res).then(function (me) {
        S.name = me.name;
        startMain();
      });
    }
    return readJson(res).then(function (body) {
      if (body.no_login) {
        return signIn("").then(function (problem) {
          if (problem) showLogin(problem);
        });
      }
      showLogin("");
    });
  }, function () {
    showLogin("Can't reach the server.");
  });
})();
`;
