/* =============================================================
   Theory Cloud Docs — ⌘K search palette
   Fetches /search.json once, builds a lunr index in-browser,
   and renders grouped results with keyboard nav.
   ============================================================= */
(function () {
  "use strict";

  const scrim   = document.querySelector("[data-palette]");
  if (!scrim) return;

  const input   = scrim.querySelector("[data-palette-input]");
  const list    = scrim.querySelector("[data-palette-list]");

  let docs    = null;       // raw search.json contents
  let index   = null;       // lunr index
  let loading = false;
  let active  = 0;
  let results = [];

  const open  = () => {
    scrim.hidden = false;
    setTimeout(() => input.focus(), 16);
    ensureIndex();
    render("");
  };
  const close = () => {
    scrim.hidden = true;
    input.value = "";
    list.innerHTML = "";
  };

  window.addEventListener("tt:palette:open", open);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  document.addEventListener("keydown", (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      scrim.hidden ? open() : close();
      return;
    }
    if (e.key === "/" && !scrim.hidden === false) {
      // open with `/` when not already in an input
      const tag = (e.target && e.target.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        open();
      }
    }
    if (!scrim.hidden) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      if (e.key === "ArrowUp")   { e.preventDefault(); move(-1); }
      if (e.key === "Enter")     { e.preventDefault(); commit(); }
    }
  });

  function ensureIndex() {
    if (docs || loading) return;
    loading = true;
    fetch((window.TT && window.TT.searchUrl) || "/search.json")
      .then((r) => r.json())
      .then((data) => {
        docs = data;
        if (typeof lunr === "function") {
          index = lunr(function () {
            this.ref("ref");
            this.field("title", { boost: 8 });
            this.field("headings", { boost: 4 });
            this.field("body");
            this.field("group");
            data.forEach((d, i) => {
              this.add({
                ref: String(i),
                title: d.title,
                headings: (d.headings || []).join(" "),
                body: d.excerpt || "",
                group: d.group || "",
              });
            });
          });
        }
        render(input.value);
      })
      .catch((e) => {
        console.warn("[tt-docs] failed to load search index", e);
      })
      .finally(() => { loading = false; });
  }

  input && input.addEventListener("input", () => render(input.value));

  function render(q) {
    list.innerHTML = "";
    results = [];
    active = 0;

    if (!docs) {
      list.innerHTML = `<div class="palette__empty">Loading index…</div>`;
      return;
    }

    const query = (q || "").trim();
    let hits;
    if (!query) {
      hits = docs.slice(0, 12).map((d, i) => ({ doc: d, score: 1, idx: i }));
    } else if (index) {
      try {
        const lr = index.search(query + (query.endsWith("*") ? "" : "*"));
        hits = lr.slice(0, 30).map((r) => ({ doc: docs[Number(r.ref)], score: r.score, idx: Number(r.ref) }));
      } catch (_) {
        // lunr can throw on syntax-significant chars; fall back to substring
        const lc = query.toLowerCase();
        hits = docs
          .map((d, i) => ({ doc: d, idx: i, hit: (d.title + " " + (d.headings || []).join(" ")).toLowerCase().indexOf(lc) }))
          .filter((x) => x.hit !== -1)
          .slice(0, 20)
          .map((x) => ({ doc: x.doc, score: 1, idx: x.idx }));
      }
    } else {
      const lc = query.toLowerCase();
      hits = docs
        .map((d, i) => ({ doc: d, idx: i }))
        .filter((x) => (x.doc.title + " " + (x.doc.headings || []).join(" ")).toLowerCase().indexOf(lc) !== -1)
        .slice(0, 20)
        .map((x) => ({ doc: x.doc, score: 1, idx: x.idx }));
    }

    if (!hits.length) {
      list.innerHTML = `<div class="palette__empty">No matches for “${escapeHtml(query)}”.</div>`;
      return;
    }

    // Group by `group` field (Overview, Modeling, …)
    const grouped = {};
    hits.forEach((h) => {
      const g = h.doc.group || "Pages";
      (grouped[g] = grouped[g] || []).push(h);
    });

    Object.keys(grouped).forEach((g) => {
      const h = document.createElement("div");
      h.className = "palette__group";
      h.textContent = g;
      list.appendChild(h);
      grouped[g].forEach((hit) => {
        const item = document.createElement("button");
        item.className = "palette__item";
        item.dataset.url = hit.doc.url;
        item.innerHTML = `
          <span class="palette__item__icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="14 3 14 9 20 9"/>
            </svg>
          </span>
          <div class="palette__item__main">
            <div class="palette__item__title">${escapeHtml(hit.doc.title)}</div>
            <div class="palette__item__path">${escapeHtml(hit.doc.url)}</div>
          </div>
          <span class="palette__item__hint">↵</span>
        `;
        item.addEventListener("click", () => { window.location.href = hit.doc.url; });
        item.addEventListener("mouseenter", () => { setActive(results.indexOf(item)); });
        list.appendChild(item);
        results.push(item);
      });
    });

    setActive(0);
  }

  function setActive(n) {
    if (!results.length) return;
    active = (n + results.length) % results.length;
    results.forEach((el, i) => el.classList.toggle("active", i === active));
    const cur = results[active];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function move(d) { setActive(active + d); }
  function commit() {
    const cur = results[active];
    if (cur && cur.dataset.url) window.location.href = cur.dataset.url;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
