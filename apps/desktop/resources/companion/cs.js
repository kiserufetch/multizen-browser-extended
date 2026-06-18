// MultiZen Companion — MAIN-world content script on Chrome Web Store detail
// pages. Replaces the (disabled) "Add to Chrome" button with our own "Add to
// MultiZen" button in the same spot, and hands the extension ID to the host via
// the CDP binding `__multizenAddExtension`. Also hides Google's "Switch to
// Chrome?" promo. The native install path is dead in CloakBrowser, so this is
// the working one.
(function () {
  "use strict";

  function extractId() {
    const m = /\/detail\/[^/]+\/([a-p]{32})/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // Channel to MultiZen: write the id to a DOM attribute on <html>. CloakBrowser
  // puts this content script in an isolated world, but the DOM is shared, so the
  // host (which polls via CDP) reads it. Stamp a nonce so repeats are distinct.
  function signalHost(id) {
    try {
      document.documentElement.setAttribute(
        "data-mz-add-ext",
        JSON.stringify({ id: id, n: Date.now() }),
      );
      return true;
    } catch (e) {
      return false;
    }
  }

  function setState(btn, text, tone) {
    btn.textContent = text;
    btn.style.pointerEvents = "none";
    btn.style.opacity = "0.9";
    if (tone === "ok") btn.style.background = "#16a34a";
    if (tone === "err") btn.style.background = "#b91c1c";
  }

  function makeButton() {
    const btn = document.createElement("button");
    btn.id = "mz-add-to-multizen";
    btn.type = "button";
    btn.textContent = "Add to MultiZen";
    btn.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "height:40px",
      "padding:0 24px",
      "margin:0",
      "border:0",
      "border-radius:20px",
      "font:500 14px 'Google Sans',Roboto,system-ui,-apple-system,sans-serif",
      "letter-spacing:0.2px",
      "color:#fff",
      "cursor:pointer",
      "white-space:nowrap",
      "background:linear-gradient(90deg,#6366f1,#a855f7)",
      "box-shadow:0 1px 2px rgba(60,64,67,0.30),0 1px 3px 1px rgba(60,64,67,0.15)",
      "transition:filter 120ms ease",
    ].join(";");
    btn.addEventListener("mouseenter", function () {
      btn.style.filter = "brightness(1.07)";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.filter = "none";
    });
    btn.addEventListener("click", function () {
      // Read the id at click time — the store is an SPA and may have navigated.
      const id = extractId();
      if (!id) {
        setState(btn, "Couldn't read extension ID", "err");
        return;
      }
      signalHost(id);
      setState(btn, "Adding… (reopening profile)", "ok");
    });
    return btn;
  }

  // Locate the VISIBLE native "Add to Chrome" button so we can sit in its place.
  // Skip ones we've already hidden (left over from a previous SPA page).
  function findNativeAdd() {
    const spans = document.querySelectorAll("span");
    for (let i = 0; i < spans.length; i++) {
      if ((spans[i].textContent || "").trim() !== "Add to Chrome") continue;
      const btn = spans[i].closest("button");
      if (!btn) continue;
      const container = btn.closest("div.OdjmDb") || btn.parentElement || btn;
      if (container.style && container.style.display === "none") continue; // already hidden
      return container;
    }
    return null;
  }

  let placedPath = "";
  function placeButton() {
    if (!extractId()) return;
    // SPA navigated to a different extension → drop our old button and re-place.
    if (placedPath && placedPath !== location.pathname) {
      const old = document.getElementById("mz-add-to-multizen");
      if (old) old.remove();
      placedPath = "";
    }
    if (document.getElementById("mz-add-to-multizen")) return; // already placed here
    const native = findNativeAdd();
    if (!native || !native.parentElement) return; // wait for the native button
    placedPath = location.pathname;
    const btn = makeButton();
    native.parentElement.insertBefore(btn, native);
    native.style.setProperty("display", "none", "important");
  }

  // Hide Google's "Switch to Chrome" / "Install Chrome" promos shown to
  // non-Chrome browsers (they can appear after a delay, and there are several
  // variants). Climb to the promo container but STOP before anything large
  // enough to be the page itself. Marks hidden nodes so it doesn't loop.
  function hideSwitchBanner() {
    const needles = [
      "Switch to Chrome",
      "recommends using Chrome",
      "to install extensions",
    ];
    const nodes = document.querySelectorAll("div,span,section,a,c-wiz");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const text = el.textContent || "";
      if (text.length === 0 || text.length > 200) continue;
      let hit = false;
      for (let j = 0; j < needles.length; j++) if (text.indexOf(needles[j]) !== -1) hit = true;
      if (!hit) continue;
      let node = el;
      for (let up = 0; up < 5 && node.parentElement; up++) {
        const p = node.parentElement;
        const r = p.getBoundingClientRect();
        if (r.height > window.innerHeight * 0.5 || r.width > window.innerWidth * 0.9) break;
        node = p;
      }
      if (node.getAttribute("data-mz-promo-hidden")) continue; // already hidden
      node.setAttribute("data-mz-promo-hidden", "1");
      node.style.setProperty("display", "none", "important");
    }
  }

  function tick() {
    placeButton();
    hideSwitchBanner();
  }

  tick();
  let t = null;
  const schedule = function () {
    if (t) return;
    t = setTimeout(function () {
      t = null;
      tick();
    }, 300);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  // Safety net for SPA history navigations that don't mutate enough to trigger
  // the observer in time.
  setInterval(tick, 1000);
})();
