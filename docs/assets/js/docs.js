/* =============================================================
   Theory Cloud Docs — Core hydration
   - Sidebar group collapse
   - Sidebar filter
   - TOC scroll-spy + auto-population from .prose headings
   - Code-block head injection (lang label + copy button)
   - Header palette/tweaks button wiring
   ============================================================= */
(function () {
  "use strict";

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  // ---- Sidebar group collapse -------------------------------------------------
  $$(".sidebar-group__head").forEach((head) => {
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      if (!body) return;
      const collapsed = head.classList.toggle("collapsed");
      body.classList.toggle("collapsed", collapsed);
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  });

  // ---- Sidebar filter ---------------------------------------------------------
  const filterInput = $("[data-action='filter-sidebar']");
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      $$(".sidebar-group").forEach((group) => {
        let visible = 0;
        $$(".sidebar-link", group).forEach((link) => {
          const text = link.textContent.toLowerCase();
          const match = !q || text.indexOf(q) !== -1;
          link.style.display = match ? "" : "none";
          if (match) visible++;
        });
        group.style.display = visible === 0 && q ? "none" : "";
      });
    });
  }

  // ---- TOC scroll-spy ---------------------------------------------------------
  const tocList = $("[data-toc-list]");
  const headings = $$(".prose h2[id], .prose h3[id], .prose h4[id]");
  if (tocList && headings.length) {
    const items = headings.map((h) => {
      const lvl = h.tagName === "H2" ? 2 : h.tagName === "H3" ? 3 : 4;
      const a = document.createElement("a");
      a.className = "docs-toc__item";
      a.dataset.level = String(lvl);
      a.href = "#" + h.id;
      a.textContent = h.textContent.trim();
      tocList.appendChild(a);

      // Add an inline anchor link to the heading itself
      const anchor = document.createElement("a");
      anchor.className = "anchor";
      anchor.href = "#" + h.id;
      anchor.setAttribute("aria-label", "Anchor");
      anchor.textContent = "#";
      h.appendChild(anchor);

      return { heading: h, link: a };
    });

    const setActive = (id) => {
      items.forEach((it) => {
        it.link.classList.toggle("active", it.heading.id === id);
      });
    };

    if ("IntersectionObserver" in window) {
      const obs = new IntersectionObserver(
        (entries) => {
          // Pick the entry closest to the top that's currently intersecting.
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible.length) setActive(visible[0].target.id);
        },
        { rootMargin: "-80px 0px -70% 0px", threshold: [0, 1] }
      );
      items.forEach((it) => obs.observe(it.heading));
    } else {
      // Fallback: tag the first heading on load.
      setActive(items[0].heading.id);
    }
  } else if (tocList) {
    // No headings on this page (e.g. landing) — drop the section entirely.
    const aside = tocList.closest(".docs-toc");
    if (aside) aside.style.display = "none";
  }

  // ---- Code blocks: head + copy button ----------------------------------------
  const detectLang = (fig) => {
    const cls = (fig.className || "") + " " + (fig.querySelector("code") ? fig.querySelector("code").className : "");
    const m = cls.match(/language-([a-z0-9+\-_]+)/i);
    if (m) return m[1];
    // Rouge often emits `<div class="highlight"><pre class="language-go">`
    const pre = fig.querySelector("pre");
    if (pre) {
      const m2 = (pre.className || "").match(/language-([a-z0-9+\-_]+)/i);
      if (m2) return m2[1];
    }
    return "code";
  };

  const copyIconSVG = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2"/>
      <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
    </svg>`;

  const decorateBlock = (fig) => {
    if (fig.dataset.tcDecorated) return;
    fig.dataset.tcDecorated = "1";

    const lang = detectLang(fig);
    const head = document.createElement("div");
    head.className = "code-block__head";
    head.innerHTML = `
      <span class="code-block__lang">${lang}</span>
      <span class="code-block__spacer"></span>
      <div class="code-block__actions">
        <button class="code-block__btn" type="button" data-action="copy">
          ${copyIconSVG}<span>Copy</span>
        </button>
      </div>
    `;
    fig.insertBefore(head, fig.firstChild);

    const btn = head.querySelector("[data-action='copy']");
    btn.addEventListener("click", async () => {
      const code = fig.querySelector("pre code, pre");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.classList.add("copied");
        const labelSpan = btn.querySelector("span");
        const original = labelSpan.textContent;
        labelSpan.textContent = "Copied";
        setTimeout(() => {
          btn.classList.remove("copied");
          labelSpan.textContent = original;
        }, 1400);
      } catch (e) {
        console.warn("[tt-docs] clipboard copy failed", e);
      }
    });
  };

  // Decorate Rouge-produced <figure class="highlight"> blocks.
  $$("figure.highlight").forEach(decorateBlock);
  // Some kramdown configs emit a plain <div class="highlight"> instead.
  $$("div.highlight").forEach((div) => {
    if (div.closest("figure.highlight")) return;
    div.classList.add("tt-bare-highlight");
    // Wrap into the same shell visually
    const wrap = document.createElement("figure");
    wrap.className = "highlight";
    div.parentNode.insertBefore(wrap, div);
    wrap.appendChild(div);
    decorateBlock(wrap);
  });

  // ---- Header buttons → modals ------------------------------------------------
  document.addEventListener("click", (ev) => {
    const open = ev.target.closest("[data-action='open-palette']");
    if (open) {
      ev.preventDefault();
      window.dispatchEvent(new CustomEvent("tt:palette:open"));
    }
    const tweaks = ev.target.closest("[data-action='open-tweaks']");
    if (tweaks) {
      ev.preventDefault();
      window.dispatchEvent(new CustomEvent("tt:tweaks:open"));
    }
  });
})();
