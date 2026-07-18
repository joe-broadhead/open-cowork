import { escapeAttr, escapeHtml, safeLocalStorageGet, safeLocalStorageSet } from "./dom-utils.js";

function initSidebar() {
  const toggle = document.querySelector("[data-openwiki-sidebar-toggle]");
  const closeTargets = document.querySelectorAll("[data-openwiki-sidebar-close]");
  const closeSidebar = () => {
    document.documentElement.classList.remove("is-sidebar-open");
    toggle?.setAttribute("aria-expanded", "false");
  };
  toggle?.addEventListener("click", () => {
    const isOpen = document.documentElement.classList.toggle("is-sidebar-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });
  closeTargets.forEach((target) => target.addEventListener("click", closeSidebar));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
  document.querySelectorAll("[data-openwiki-sidebar]").forEach((sidebar) => {
    const filter = sidebar.querySelector("[data-openwiki-sidebar-filter]");
    const lazy = sidebar.querySelector("[data-openwiki-lazy-sidebar]");
    const bindGroups = () => {
      Array.from(sidebar.querySelectorAll("[data-openwiki-sidebar-group]")).forEach((group) => {
        if (group.dataset.openwikiSidebarBound === "1") return;
        group.dataset.openwikiSidebarBound = "1";
        const key = sidebarGroupKey(group);
        const stored = safeLocalStorageGet(key);
        if (stored === "closed") group.open = false;
        if (stored === "open") group.open = true;
        group.addEventListener("toggle", () => {
          safeLocalStorageSet(key, group.open ? "open" : "closed");
          if (group.open) loadLazySidebarGroup(group);
        });
        if (group.open) loadLazySidebarGroup(group);
      });
    };
    bindGroups();
    if (lazy) {
      hydrateLazySidebar(lazy).then(bindGroups);
    }
    filter?.addEventListener("input", () => {
      const term = filter.value.trim().toLowerCase();
      Array.from(sidebar.querySelectorAll("[data-openwiki-sidebar-group]")).forEach((group) => {
        let visibleCount = 0;
        group.querySelectorAll(".ow-record-list > li").forEach((item) => {
          const visible = !term || item.textContent.toLowerCase().includes(term);
          item.hidden = !visible;
          if (visible) visibleCount += 1;
        });
        group.hidden = visibleCount === 0;
        if (term) group.open = true;
      });
    });
    sidebar.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeSidebar));
  });
}

async function hydrateLazySidebar(container) {
  if (container.dataset.openwikiLazyLoaded === "1") return;
  container.dataset.openwikiLazyLoaded = "1";
  const groupsSrc = container.dataset.openwikiSidebarGroupsSrc;
  if (!groupsSrc) return;
  try {
    const payload = await fetch(groupsSrc).then((response) => response.ok ? response.json() : undefined);
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    if (groups.length === 0) {
      container.innerHTML = '<p class="ow-muted">No page sections found.</p>';
      return;
    }
    container.innerHTML = groups.map((group, index) => renderLazySidebarGroup(container, group, index === 0)).join("");
  } catch {
    container.innerHTML = '<p class="ow-muted">Page sections could not be loaded.</p>';
  }
}

function renderLazySidebarGroup(container, group, open) {
  const id = String(group.id || "");
  const label = String(group.label || id || "Section");
  const count = Number(group.count) || 0;
  const recordsSrc = container.dataset.openwikiSidebarRecordsSrc || "/api/v1/records?type=page&limit=40";
  const url = new URL(recordsSrc, window.location.href);
  url.searchParams.set("group", id);
  return `<details class="ow-sidebar-group" data-openwiki-sidebar-group data-group="${escapeAttr(id)}"${open ? " open" : ""}>
    <summary>${escapeHtml(label)} <span>${count}</span></summary>
    <ul class="ow-record-list" data-openwiki-sidebar-records data-records-src="${escapeAttr(url.pathname + url.search)}"><li><p class="ow-muted">Loading...</p></li></ul>
  </details>`;
}

async function loadLazySidebarGroup(group, cursor) {
  const list = group.querySelector("[data-openwiki-sidebar-records]");
  if (!list || list.dataset.openwikiLoading === "1") return;
  if (!cursor && list.dataset.openwikiLoaded === "1") return;
  const src = list.dataset.recordsSrc;
  if (!src) return;
  list.dataset.openwikiLoading = "1";
  try {
    const url = new URL(src, window.location.href);
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await fetch(url).then((response) => response.ok ? response.json() : undefined);
    const records = Array.isArray(payload?.records) ? payload.records : [];
    const items = records.map(renderLazySidebarRecord).join("") || '<li><p class="ow-muted">No pages in this section.</p></li>';
    const more = payload?.next_cursor ? `<li><button class="ow-sidebar-more" type="button" data-openwiki-sidebar-more data-cursor="${escapeAttr(payload.next_cursor)}">Load more</button></li>` : "";
    if (cursor) {
      list.querySelector("[data-openwiki-sidebar-more]")?.closest("li")?.remove();
      list.insertAdjacentHTML("beforeend", items + more);
    } else {
      list.innerHTML = items + more;
      list.dataset.openwikiLoaded = "1";
    }
    list.querySelectorAll("[data-openwiki-sidebar-more]").forEach((button) => {
      if (button.dataset.openwikiMoreBound === "1") return;
      button.dataset.openwikiMoreBound = "1";
      button.addEventListener("click", () => loadLazySidebarGroup(group, button.dataset.cursor || ""));
    });
  } catch {
    list.innerHTML = '<li><p class="ow-muted">Pages could not be loaded.</p></li>';
  } finally {
    delete list.dataset.openwikiLoading;
  }
}

function renderLazySidebarRecord(record) {
  const href = record.href || "#";
  const title = record.title || record.id || "Untitled";
  const summary = record.summary || record.id || "";
  const status = record.status ? `<span class="ow-badge ow-badge--${escapeAttr(cssToken(record.status))}">${escapeHtml(record.status)}</span>` : "";
  return `<li>
    <div class="ow-record-list__title">${status}<a href="${escapeAttr(href)}">${escapeHtml(title)}</a></div>
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
  </li>`;
}

function sidebarGroupKey(group) {
  return "openwiki-sidebar:" + (group.dataset.group || group.querySelector("summary")?.textContent || "group");
}

function cssToken(value) {
  return String(value || "record").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "record";
}

export { initSidebar };
