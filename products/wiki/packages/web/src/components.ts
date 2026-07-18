import { escapeHtml } from "./html.ts";
import { escapeAttribute, cssToken } from "./utils.ts";

export function renderBadge(label: string, variant = "neutral"): string {
  return `<span class="ow-badge ow-badge--${escapeAttribute(cssToken(variant))}">${escapeHtml(label)}</span>`;
}

export interface ArticleMetaItem {
  label: string;
  value: string;
  href?: string | undefined;
  kind?: "text" | "badge" | "link";
  variant?: string | undefined;
}

export interface RecordActionItem {
  label: string;
  href?: string | undefined;
  cite?: string | undefined;
  primary?: boolean | undefined;
}

export function renderArticleMeta(items: ArticleMetaItem[]): string {
  const visibleItems = items.filter((item) => item.value.trim().length > 0);
  if (visibleItems.length === 0) {
    return "";
  }
  return `<dl class="ow-article-meta">${visibleItems
    .map((item) => {
      const value =
        item.kind === "badge"
          ? renderBadge(item.value, item.variant ?? item.value)
          : item.href
            ? `<a href="${escapeAttribute(item.href)}">${escapeHtml(item.value)}</a>`
            : escapeHtml(item.value);
      return `<div class="ow-article-meta__item"><dt>${escapeHtml(item.label)}</dt><dd>${value}</dd></div>`;
    })
    .join("")}</dl>`;
}

export function renderPanel(title: string, body: string, options: { eyebrow?: string; actions?: string; className?: string } = {}): string {
  return `<section class="ow-panel${options.className ? ` ${escapeAttribute(options.className)}` : ""}">
    <div class="ow-panel__head">
      <div>${options.eyebrow ? `<p class="ow-eyebrow">${escapeHtml(options.eyebrow)}</p>` : ""}<h2>${escapeHtml(title)}</h2></div>
      ${options.actions ?? ""}
    </div>
    ${body}
  </section>`;
}

export function renderMetric(label: string, value: string | number, hint?: string): string {
  return `<div class="ow-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span>${hint ? `<p>${escapeHtml(hint)}</p>` : ""}</div>`;
}

export function renderRecordList(
  records: Array<{ title: string; href?: string | undefined; summary?: string; type?: string; meta?: string; status?: string; active?: boolean }>,
  empty = "No records found.",
): string {
  if (records.length === 0) {
    return `<p class="ow-muted">${escapeHtml(empty)}</p>`;
  }
  return `<ul class="ow-record-list">${records
    .map((record) => {
      const title = record.href
        ? `<a${record.active ? ` aria-current="page"` : ""} href="${escapeAttribute(record.href)}">${escapeHtml(record.title)}</a>`
        : `<span>${escapeHtml(record.title)}</span>`;
      return `<li${record.active ? ` class="is-active"` : ""}>
        <div class="ow-record-list__title">${record.type ? renderBadge(record.type, record.type) : ""}${record.status ? renderBadge(record.status, record.status) : ""}${title}</div>
        ${record.summary ? `<p>${escapeHtml(record.summary)}</p>` : ""}
        ${record.meta ? `<small>${escapeHtml(record.meta)}</small>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

export function renderBreadcrumb(items: Array<{ label: string; href?: string }>, label = "Breadcrumb"): string {
  if (items.length === 0) {
    return "";
  }
  return `<nav class="ow-breadcrumb" aria-label="${escapeAttribute(label)}"><ol>${items
    .map((item, index) => {
      const current = index === items.length - 1;
      const text = escapeHtml(item.label);
      const body = item.href && !current ? `<a href="${escapeAttribute(item.href)}">${text}</a>` : `<span${current ? ` aria-current="page"` : ""}>${text}</span>`;
      return `<li>${body}</li>`;
    })
    .join("")}</ol></nav>`;
}

export function renderButtonLink(label: string, href: string, variant = "secondary"): string {
  return `<a class="button ${escapeAttribute(variant)}" href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`;
}

export function renderRecordActions(actions: RecordActionItem[]): string {
  const visible = actions.filter((action) => action.href || action.cite);
  if (visible.length === 0) {
    return "";
  }
  return `<nav class="ow-record-actions" aria-label="Record actions">${visible
    .map((action) =>
      action.cite
        ? `<button type="button" class="secondary" data-openwiki-copy-citation="${escapeAttribute(action.cite)}">${escapeHtml(action.label)}</button>`
        : `<a class="button ${action.primary ? "primary" : "secondary"}" href="${escapeAttribute(action.href ?? "#")}">${escapeHtml(action.label)}</a>`,
    )
    .join("")}</nav>`;
}

function renderField(
  label: string,
  control: string,
  options: { hint?: string; className?: string } = {},
): string {
  return `<label class="ow-field${options.className ? ` ${escapeAttribute(options.className)}` : ""}">
    <span>${escapeHtml(label)}</span>
    ${control}
    ${options.hint ? `<small>${escapeHtml(options.hint)}</small>` : ""}
  </label>`;
}

export function renderTextInput(
  name: string,
  label: string,
  value = "",
  options: { type?: string; placeholder?: string; required?: boolean; autocomplete?: string; className?: string; hint?: string } = {},
): string {
  return renderField(label, `<input name="${escapeAttribute(name)}" type="${escapeAttribute(options.type ?? "text")}" value="${escapeAttribute(value)}"${options.placeholder ? ` placeholder="${escapeAttribute(options.placeholder)}"` : ""}${options.required ? " required" : ""}${options.autocomplete ? ` autocomplete="${escapeAttribute(options.autocomplete)}"` : ""}>`, {
    ...(options.className === undefined ? {} : { className: options.className }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
  });
}

export function renderTextarea(
  name: string,
  label: string,
  value = "",
  options: { rows?: number; required?: boolean; placeholder?: string; className?: string; controlClassName?: string; hint?: string } = {},
): string {
  return renderField(label, `<textarea name="${escapeAttribute(name)}"${options.rows ? ` rows="${options.rows}"` : ""}${options.required ? " required" : ""}${options.placeholder ? ` placeholder="${escapeAttribute(options.placeholder)}"` : ""}${options.controlClassName ? ` class="${escapeAttribute(options.controlClassName)}"` : ""}>${escapeHtml(value)}</textarea>`, {
    ...(options.className === undefined ? {} : { className: options.className }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
  });
}

export function renderSelect(
  name: string,
  label: string,
  choices: Array<{ value: string; label: string; selected?: boolean }>,
  options: { required?: boolean; className?: string; hint?: string } = {},
): string {
  const control = `<select name="${escapeAttribute(name)}"${options.required ? " required" : ""}>${choices
    .map((choice) => `<option value="${escapeAttribute(choice.value)}"${choice.selected ? " selected" : ""}>${escapeHtml(choice.label)}</option>`)
    .join("")}</select>`;
  return renderField(label, control, {
    ...(options.className === undefined ? {} : { className: options.className }),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
  });
}

export function renderFormActions(primaryLabel: string): string {
  return `<div class="ow-form-actions"><button type="submit">${escapeHtml(primaryLabel)}</button></div>`;
}

export { renderDiff } from "./diff.ts";

export function renderGraphMount(options: {
  src: string;
  mode: "global" | "local" | "preview";
  focusId?: string;
  maxNodes?: number;
  fallback?: string;
  height?: string;
  title?: string;
  neighborSrcTemplate?: string;
}): string {
  const attrs = [
    `data-openwiki-graph`,
    `data-graph-src="${escapeAttribute(options.src)}"`,
    `data-graph-mode="${escapeAttribute(options.mode)}"`,
    options.focusId ? `data-focus-id="${escapeAttribute(options.focusId)}"` : "",
    options.maxNodes === undefined ? "" : `data-max-nodes="${escapeAttribute(String(options.maxNodes))}"`,
    options.neighborSrcTemplate === undefined ? "" : `data-graph-neighbor-src="${escapeAttribute(options.neighborSrcTemplate)}"`,
  ].filter(Boolean).join(" ");
  return `<div class="ow-graph" ${attrs} style="${options.height ? `--ow-graph-height:${escapeAttribute(options.height)}` : ""}">
    <div class="ow-graph__head">
      <div>${options.title ? `<h2>${escapeHtml(options.title)}</h2>` : ""}<span data-openwiki-graph-count>Loading graph</span></div>
      <div class="ow-graph__controls">
        <div class="ow-graph__search">
          <input data-openwiki-graph-search aria-label="Search graph nodes" placeholder="Find node" autocomplete="off">
          <div class="ow-graph__matches" data-openwiki-graph-search-results role="listbox" aria-label="Graph search matches" hidden></div>
        </div>
        <div class="ow-graph__scope" role="group" aria-label="Graph scope">
          <button type="button" data-openwiki-graph-scope="all" aria-pressed="true">All</button>
          <button type="button" data-openwiki-graph-scope="neighborhood" aria-pressed="false">Focus</button>
        </div>
        <select data-openwiki-graph-depth aria-label="Graph depth"><option value="1">1 hop</option><option value="2">2 hops</option><option value="3">3 hops</option></select>
        <div class="ow-graph__legend" data-openwiki-graph-node-legend aria-label="Filter graph node types"><span class="ow-graph__legend-label">Nodes</span><button type="button" class="ow-graph__chip is-active" disabled>All nodes</button></div>
        <div class="ow-graph__legend" data-openwiki-graph-edge-legend aria-label="Filter graph edge types"><span class="ow-graph__legend-label">Edges</span><button type="button" class="ow-graph__chip is-active" disabled>All edges</button></div>
        <label class="ow-graph__toggle"><input data-openwiki-graph-orphans type="checkbox" checked> Orphans</label>
        <div class="ow-graph__zoom" role="group" aria-label="Graph zoom">
          <button type="button" data-openwiki-graph-zoom="out" aria-label="Zoom out">-</button>
          <button type="button" data-openwiki-graph-zoom="in" aria-label="Zoom in">+</button>
        </div>
        <button type="button" data-openwiki-graph-fit>Fit</button>
        <button type="button" data-openwiki-graph-reset>Reset</button>
        <button type="button" data-openwiki-graph-fullscreen>Full</button>
      </div>
    </div>
    <canvas class="ow-graph__canvas" data-openwiki-graph-canvas role="img" tabindex="0" aria-label="OpenWiki loading graph visualization."></canvas>
    <aside class="ow-graph__detail" data-openwiki-graph-detail aria-live="polite">
      <h3>Graph Detail</h3>
      <p class="ow-muted">Select or hover a node to inspect its neighborhood.</p>
    </aside>
    <div class="ow-graph__node-list" data-openwiki-graph-node-list role="listbox" aria-label="Visible graph nodes"></div>
    <div class="ow-graph__fallback">${options.fallback ?? ""}</div>
  </div>`;
}
