/* =============================================================
   Theory Cloud Docs — Tweaks panel
   Persists surface/density/width/toc preferences in localStorage
   and reflects them as data-attributes on .docs-app + .docs-body.
   ============================================================= */
(function () {
  "use strict";

  const KEY     = "tc-docs-tweaks";
  const scrim   = document.querySelector("[data-tweaks]");
  const app     = document.querySelector(".docs-app");
  const body    = document.querySelector(".docs-body");
  if (!scrim || !app || !body) return;

  const open  = () => { scrim.hidden = false; refreshActive(); };
  const close = () => { scrim.hidden = true; };

  window.addEventListener("tt:tweaks:open", open);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  document.addEventListener("keydown", (e) => {
    if (!scrim.hidden && e.key === "Escape") { e.preventDefault(); close(); }
  });

  // Default preferences
  const defaults = {
    surface: "auto",          // auto | core | mcp | auth
    density: "default",       // compact | default | spacious
    width:   "default",       // narrow | default | wide
    toc:     "visible",       // visible | hidden
  };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return Object.assign({}, defaults);
      return Object.assign({}, defaults, JSON.parse(raw));
    } catch (_) { return Object.assign({}, defaults); }
  }
  function save(prefs) {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  function apply(prefs) {
    // Surface
    if (prefs.surface === "auto") {
      const pageSurface = (window.TT && window.TT.surface) || "core";
      app.dataset.surface = pageSurface;
    } else {
      app.dataset.surface = prefs.surface;
    }
    // Density + width go on both .docs-app and .docs-body (theme.css reads
    // them via the descendant selector .docs-body[data-density="…"]).
    body.dataset.density = prefs.density;
    body.dataset.width   = prefs.width;
    app.dataset.density  = prefs.density;
    app.dataset.width    = prefs.width;

    // TOC visibility
    document.querySelectorAll(".docs-toc").forEach((el) => {
      el.style.display = prefs.toc === "hidden" ? "none" : "";
    });
  }

  function refreshActive() {
    const prefs = load();
    scrim.querySelectorAll("[data-tweak-group]").forEach((grp) => {
      const key = grp.dataset.tweakGroup;
      const cur = prefs[key];
      grp.querySelectorAll("[data-tweak-value]").forEach((btn) => {
        const isActive = btn.dataset.tweakValue === cur;
        btn.style.background = isActive ? "var(--tc-surface-3)" : "var(--tc-surface-2)";
        btn.style.borderColor = isActive ? "var(--tc-accent)" : "var(--tc-outline-variant)";
        btn.style.color = isActive ? "var(--tc-fg)" : "var(--tc-fg-muted)";
      });
    });
  }

  scrim.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tweak-value]");
    if (btn) {
      const grp = btn.closest("[data-tweak-group]");
      if (!grp) return;
      const prefs = load();
      prefs[grp.dataset.tweakGroup] = btn.dataset.tweakValue;
      save(prefs);
      apply(prefs);
      refreshActive();
    }
    if (ev.target.closest("[data-tweak-reset]")) {
      save(Object.assign({}, defaults));
      apply(defaults);
      refreshActive();
    }
  });

  // Initial application on boot
  apply(load());
})();
