import { escapeAttr, escapeHtml, isTypingTarget } from "./dom-utils.js";

function initPalette() {
  const palette = document.querySelector("[data-openwiki-palette]");
  const input = document.querySelector("[data-openwiki-palette-input]");
  const results = document.querySelector("[data-openwiki-palette-results]");
  const triggers = document.querySelectorAll("[data-openwiki-search-trigger]");
  const forms = document.querySelectorAll("[data-openwiki-palette-form]");
  if (!palette || !input || !results) return;
  let recordsPromise;
  let suggestionsPromise;
  let debounceTimer;
  let searchRun = 0;
  let activeItems = [];
  let activeIndex = 0;
  let activeType = "";
  let activeFacets;
  let nextCursor;
  let previousFocus;
  const open = (initialQuery = "") => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    palette.hidden = false;
    triggers.forEach((trigger) => trigger.setAttribute("aria-expanded", "true"));
    input.setAttribute("aria-expanded", "true");
    input.value = initialQuery;
    input.focus();
    renderResults(initialQuery);
  };
  const close = () => {
    palette.hidden = true;
    input.value = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    triggers.forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
    previousFocus?.focus?.();
  };
  triggers.forEach((trigger) => trigger.addEventListener("click", () => open(trigger.dataset.openwikiPaletteQuery || "")));
  forms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      const data = new FormData(form);
      const query = String(data.get("q") || data.get("query") || "");
      event.preventDefault();
      open(query);
    });
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    } else if (!event.metaKey && !event.ctrlKey && event.key === "/" && !isTypingTarget(event.target)) {
      event.preventDefault();
      open();
    } else if (event.key === "Escape" && !palette.hidden) {
      close();
    }
  });
  palette.addEventListener("click", (event) => {
    if (event.target === palette) close();
  });
  palette.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = focusablePaletteElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  input.addEventListener("input", () => scheduleResults(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectResult(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectResult(activeIndex - 1);
    } else if (event.key === "Enter") {
      const item = activeItems[activeIndex];
      if (item) {
        event.preventDefault();
        activateItem(item);
      }
    }
  });
  results.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-action]");
    if (action) {
      event.preventDefault();
      activateItem({ action: action.dataset.action });
      return;
    }
    const facet = event.target.closest?.("[data-openwiki-palette-facet]");
    if (facet) {
      event.preventDefault();
      activeType = facet.dataset.openwikiPaletteFacet || "";
      renderResults(input.value);
    }
  });

  function scheduleResults(query) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(query), document.body.dataset.searchApi ? 120 : 0);
  }

  async function loadRecords() {
    if (!recordsPromise) {
      const src = document.body.dataset.searchIndex || "search-index.json";
      if (!src) return [];
      recordsPromise = fetch(src).then((response) => response.ok ? response.json() : { records: [] }).catch(() => ({ records: [] }));
    }
    const payload = await recordsPromise;
    return Array.isArray(payload.records) ? payload.records : [];
  }

  async function loadSuggestions() {
    if (!suggestionsPromise) {
      suggestionsPromise = loadPaletteSuggestions();
    }
    return suggestionsPromise;
  }

  async function renderResults(query, options = {}) {
    const run = ++searchRun;
    const queryText = query.trim();
    const commands = [
      { title: "Open graph", href: document.body.dataset.graphHref || "graph.html", type: "command", summary: "Explore the workspace knowledge graph" },
      { title: "Recent changes", href: document.body.dataset.searchApi ? "/api/v1/recent-changes" : "changes.html", type: "command", summary: "Review the latest wiki activity" },
      { title: "Topics", href: document.body.dataset.searchApi ? "/api/v1/topics" : "topics.html", type: "command", summary: "Browse topic clusters" },
      { title: "Toggle theme", action: "theme", type: "command", summary: "Switch between dark and light mode" },
    ];
    const append = options.append === true;
    const search = queryText ? await searchRecords(queryText, append ? nextCursor : undefined) : { items: await loadSuggestions(), nextCursor: undefined };
    if (run !== searchRun) return;
    const items = queryText ? append ? [...activeItems, ...search.items] : search.items : [...commands, ...search.items];
    nextCursor = queryText ? search.nextCursor : undefined;
    activeItems = items;
    activeIndex = 0;
    results.innerHTML = renderPaletteContent(items, queryText, { hasMore: Boolean(nextCursor), selectedType: activeType, facets: activeFacets });
    selectResult(0);
  }

  async function searchRecords(query, cursor) {
    const api = document.body.dataset.searchApi;
    if (api) {
      const url = new URL(api, window.location.href);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "18");
      if (activeType) url.searchParams.set("type", activeType);
      if (cursor) url.searchParams.set("cursor", cursor);
      const payload = await fetch(url).then((response) => response.ok ? response.json() : { results: [] }).catch(() => ({ results: [] }));
      activeFacets = payload.facets;
      return { items: normalizeSearchResults(payload.results || []), nextCursor: payload.next_cursor };
    }
    activeFacets = undefined;
    const records = activeType ? (await loadRecords()).filter((record) => record.type === activeType || record.record_type === activeType) : await loadRecords();
    return { items: rankRecords(records, query).slice(0, 18), nextCursor: undefined };
  }

  function selectResult(index) {
    const optionElements = Array.from(results.querySelectorAll(".ow-palette__result"));
    if (activeItems.length === 0 || optionElements.length === 0) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = (index + activeItems.length) % activeItems.length;
    optionElements.forEach((item, itemIndex) => {
      const optionId = `openwiki-palette-option-${itemIndex}`;
      item.id = optionId;
      item.classList.toggle("is-active", itemIndex === activeIndex);
      item.setAttribute("aria-selected", itemIndex === activeIndex ? "true" : "false");
      if (itemIndex === activeIndex) {
        input.setAttribute("aria-activedescendant", optionId);
      }
    });
  }

  function activateItem(item) {
    if (item.action === "theme") {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
      return;
    }
    if (item.action === "load-more") {
      renderResults(input.value, { append: true });
      return;
    }
    if (item.href) {
      window.location.href = item.href;
    }
  }

  function focusablePaletteElements() {
    return Array.from(palette.querySelectorAll("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])"))
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);
  }
}

function rankRecords(records, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return records
    .map((record) => {
      const title = String(record.title || record.id || "");
      const summary = String(record.summary || "");
      const text = String(record.search_text || "");
      const haystack = `${title} ${summary} ${text}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return undefined;
      let score = 0;
      for (const term of terms) {
        if (title.toLowerCase().startsWith(term)) score += 20;
        if (title.toLowerCase().includes(term)) score += 10;
        if (summary.toLowerCase().includes(term)) score += 4;
        if (text.toLowerCase().includes(term)) score += 1;
      }
      return { title, summary: summary || record.id, type: record.type || "record", href: recordHref(record), score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

function normalizeSearchResults(records) {
  return records.map((record) => ({
    title: record.title || record.id || "Untitled",
    summary: record.summary || record.uri || record.id,
    type: record.type || "record",
    href: recordHref(record),
    score: record.score || 0,
  }));
}

function renderPaletteContent(items, query, options = {}) {
  const queryText = query.trim();
  if (!queryText) {
    return `<div class="ow-palette__empty">
      <p class="ow-eyebrow">Start here</p>
      <p class="ow-muted">Search the wiki or jump to recent pages, topic clusters, and graph views.</p>
    </div>${groupedResultItems(items, queryText)}`;
  }
  const facets = renderPaletteFacets(options.selectedType || "", options.facets);
  const body = items.length === 0 ? `<p class="ow-muted">No results found. Try a broader query or another type.</p>` : groupedResultItems(items, queryText);
  const more = options.hasMore ? `<button class="ow-palette__more" type="button" data-action="load-more">Load more results</button>` : "";
  return `${facets}${body}${more}`;
}

function renderPaletteFacets(selectedType, facetData) {
  const facetItems = [
    ["", "All"],
    ["page", "Pages"],
    ["source", "Sources"],
    ["claim", "Claims"],
    ["proposal", "Proposals"],
    ["decision", "Decisions"],
  ];
  const typeCounts = facetData?.types || {};
  return `<div class="ow-palette__facets" aria-label="Search result types">${facetItems
    .map(([type, label]) => {
      const count = type ? typeCounts[type] : Object.values(typeCounts).reduce((sum, value) => sum + Number(value || 0), 0);
      const countLabel = count ? ` <span>${escapeHtml(String(count))}</span>` : "";
      return `<button type="button" data-openwiki-palette-facet="${escapeAttr(type)}" class="${type === selectedType ? "is-active" : ""}" aria-pressed="${type === selectedType ? "true" : "false"}">${escapeHtml(label)}${countLabel}</button>`;
    })
    .join("")}</div>`;
}

async function loadPaletteSuggestions() {
  const records = await loadPaletteSuggestionRecords();
  if (records.length > 0) {
    return records;
  }
  const staticRecords = await loadStaticSuggestionRecords();
  return staticRecords;
}

async function loadPaletteSuggestionRecords() {
  const scripts = document.querySelectorAll("template[data-openwiki-palette-suggestions], script[type='application/json'][data-openwiki-palette-suggestions]");
  const items = [];
  scripts.forEach((script) => {
    try {
      const parsed = JSON.parse(script.textContent || "[]");
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => items.push(item));
      }
    } catch {}
  });
  return items.map((item) => ({
    title: item.title || item.id || "Untitled",
    summary: item.summary || "",
    type: item.type || "suggestion",
    href: safePaletteHref(item.href),
  })).filter((item) => item.href !== "#").slice(0, 12);
}

async function loadStaticSuggestionRecords() {
  const records = await (async () => {
    const src = document.body.dataset.searchIndex;
    if (!src) return [];
    try {
      const payload = await fetch(src).then((response) => response.ok ? response.json() : { records: [] });
      return Array.isArray(payload.records) ? payload.records : [];
    } catch {
      return [];
    }
  })();
  const pages = records.filter((record) => record.type === "page").slice(0, 5).map((record) => ({
    title: record.title || record.id,
    summary: record.summary || record.id,
    type: "recent page",
    href: recordHref(record),
  }));
  const topics = new Map();
  records.forEach((record) => {
    (record.topics || []).forEach((topic) => topics.set(topic, (topics.get(topic) || 0) + 1));
  });
  const topicItems = [...topics.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([topic, count]) => ({
      title: topic,
      summary: `${count} linked records`,
      type: "top topic",
      href: `${document.body.dataset.openwikiBase || ""}topics.html#topic-${slugifyTopic(topic)}`,
    }));
  return [...pages, ...topicItems];
}

function safePaletteHref(value) {
  if (!value) return "#";
  const external = safeExternalHref(value);
  if (external) return external;
  const text = String(value).trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text) || text.startsWith("//") || text.startsWith("\\") || text.startsWith("/\\")) return "#";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return "#";
  if (text.startsWith("/") || text.startsWith("./") || text.startsWith("../") || /^[A-Za-z0-9._~!$&'()*+,;=:@/%?#-]+$/.test(text)) {
    return text;
  }
  return "#";
}

function slugifyTopic(value) {
  return String(value || "").toLowerCase().trim().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

function groupedResultItems(items, query) {
  const groups = new Map();
  for (const item of items) {
    const key = item.type || "record";
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return Array.from(groups.entries()).map(([type, typeItems]) => `<section class="ow-palette__group" role="group" aria-label="${escapeAttr(paletteTypeLabel(type))}">
    <h3 class="ow-palette__group-title">${escapeHtml(paletteTypeLabel(type))}</h3>
    ${typeItems.map((item) => resultItem(item, query)).join("")}
  </section>`).join("");
}

function resultItem(item, query = "") {
  const attrs = item.action ? `href="#" data-action="${item.action}"` : `href="${escapeAttr(item.href || "#")}"`;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return `<a class="ow-palette__result" role="option" ${attrs}><strong>${highlightText(item.title, terms)}</strong><p class="ow-muted"><span class="ow-palette__type">${escapeHtml(item.type || "record")}</span>${item.summary ? " · " + highlightText(item.summary, terms) : ""}</p></a>`;
}

function paletteTypeLabel(type) {
  return String(type || "record").replace(/_/g, " ");
}

function highlightText(value, terms) {
  const text = String(value || "");
  if (terms.length === 0 || text.length === 0) return escapeHtml(text);
  const lower = text.toLowerCase();
  let index = 0;
  let html = "";
  while (index < text.length) {
    let bestIndex = -1;
    let bestTerm = "";
    for (const term of terms) {
      const found = lower.indexOf(term, index);
      if (found !== -1 && (bestIndex === -1 || found < bestIndex || (found === bestIndex && term.length > bestTerm.length))) {
        bestIndex = found;
        bestTerm = term;
      }
    }
    if (bestIndex === -1) {
      html += escapeHtml(text.slice(index));
      break;
    }
    html += escapeHtml(text.slice(index, bestIndex));
    html += `<mark>${escapeHtml(text.slice(bestIndex, bestIndex + bestTerm.length))}</mark>`;
    index = bestIndex + bestTerm.length;
  }
  return html;
}

function recordHref(record) {
  const base = document.body.dataset.openwikiBase || "";
  const id = String(record.id || "");
  const type = record.type || record.record_type;
  const sourceFragmentId = sourceIdFromFragmentId(id);
  if (document.body.dataset.searchApi) {
    if (type === "page" && id.startsWith("page:")) return `/pages/${encodeURIComponent(id)}`;
    if (type === "source" && id.startsWith("source:")) return `/sources/${encodeURIComponent(id)}`;
    if (type === "source_fragment" && sourceFragmentId) return `/sources/${encodeURIComponent(sourceFragmentId)}`;
    if (type === "claim" && id.startsWith("claim:")) return `/claims/${encodeURIComponent(id)}`;
    if (type === "proposal" && id.startsWith("proposal:")) return `/proposals/${encodeURIComponent(id)}`;
    if (type === "decision" && id.startsWith("decision:")) return `/decisions/${encodeURIComponent(id)}`;
    if (type === "event") return "/api/v1/events";
    if (type === "recent_change") return "/api/v1/recent-changes";
    if (type === "topic" && id.startsWith("topic:")) return `/graph?focus=${encodeURIComponent(id)}&types=${encodeURIComponent("page,topic")}`;
    if (type === "section" && id.startsWith("section:")) return "/policy";
    return safeExternalHref(record.url) || "#";
  }
  if (type === "page" && id.startsWith("page:")) {
    const parts = id.split(":");
    const kind = parts[1] === "entity" ? "entities" : `${parts[1] || "page"}s`;
    return `${base}${kind}/${parts.slice(2).join(":") || id}.html`;
  }
  if (type === "source" && id.startsWith("source:")) return `${base}sources/${id.slice("source:".length)}.html`;
  if (type === "source_fragment" && sourceFragmentId) return `${base}sources/${sourceFragmentId.slice("source:".length)}.html`;
  if (type === "claim" && id.startsWith("claim:")) return `${base}claims/${id.slice("claim:".length)}.html`;
  if (type === "proposal" && id.startsWith("proposal:")) return `${base}proposals/${id.slice("proposal:".length)}.html`;
  if (type === "decision" && id.startsWith("decision:")) return `${base}decisions/${id.slice("decision:".length)}.html`;
  if (type === "event" || type === "recent_change") return `${base}changes.html`;
  if (type === "topic" && id.startsWith("topic:")) return `${base}topics.html#topic-${id.slice("topic:".length)}`;
  return safeExternalHref(record.url) || "#";
}

function sourceIdFromFragmentId(id) {
  const parts = String(id || "").split(":");
  if (parts[0] !== "fragment" || parts.length < 4) {
    return undefined;
  }
  return parts.slice(1, -1).join(":");
}

function safeExternalHref(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export { initPalette };
