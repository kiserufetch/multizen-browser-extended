// MultiZen Companion — runs in the MAIN world on Chrome Web Store detail pages.
// It injects an "Add to MultiZen" button and hands the extension ID back to the
// MultiZen app via the CDP binding `__multizenAddExtension` (registered by the
// driver on every page target). The native store "Add to Chrome" is dead in
// CloakBrowser, so this is the working install path.
(function () {
  "use strict";

  function extractId() {
    // /detail/<slug>/<id>  — id is 32 chars a–p
    const m = /\/detail\/[^/]+\/([a-p]{32})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function alreadyInjected() {
    return !!document.getElementById("mz-add-to-multizen");
  }

  function callHost(id) {
    const fn = window.__multizenAddExtension;
    if (typeof fn === "function") {
      fn(JSON.stringify({ id }));
      return true;
    }
    return false;
  }

  function makeButton(id) {
    const btn = document.createElement("button");
    btn.id = "mz-add-to-multizen";
    btn.type = "button";
    btn.textContent = "Add to MultiZen";
    btn.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "padding:10px 16px",
      "border:0",
      "border-radius:10px",
      "font:600 13px system-ui,-apple-system,sans-serif",
      "color:#fff",
      "cursor:pointer",
      "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
      "background:linear-gradient(90deg,#6366f1,#a855f7)",
    ].join(";");

    btn.addEventListener("click", function () {
      if (!id) {
        setState(btn, "Couldn't read extension ID", true);
        return;
      }
      const ok = callHost(id);
      if (ok) {
        setState(btn, "Installing… (active next launch)", false);
      } else {
        setState(btn, "Open this profile from MultiZen", true);
      }
    });
    return btn;
  }

  function setState(btn, text, isError) {
    btn.textContent = text;
    btn.disabled = true;
    btn.style.opacity = "0.85";
    btn.style.background = isError ? "#b91c1c" : "#16a34a";
  }

  function inject() {
    if (alreadyInjected()) return;
    const id = extractId();
    if (!id) return;
    document.documentElement.appendChild(makeButton(id));
  }

  // The store is an SPA — re-check on navigation + DOM mutations, debounced.
  inject();
  let t = null;
  const reinject = function () {
    if (t) return;
    t = setTimeout(function () {
      t = null;
      inject();
    }, 400);
  };
  const mo = new MutationObserver(reinject);
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
