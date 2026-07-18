import { type GraphIndexResponse, type GraphNodeRecord, type PageRecord, type TopicSummary } from "@openwiki/core";
import { type RecentChangesResponse } from "@openwiki/git";
import {
  escapeHtml,
  navWithPrefix,
  pageRoute,
  recordRoute,
  relativeHref,
  relativePrefix,
  renderBreadcrumb,
  renderPanel,
  renderRecordList,
  renderShell,
  safeDocumentHref,
  type WebAssetManifest,
} from "@openwiki/web";

export function renderStaticShell(options: {
  title: string;
  workspaceTitle: string;
  active: string;
  file: string;
  assets: WebAssetManifest;
  pages: PageRecord[];
  main: string;
  rightRail?: string;
}): string {
  const prefix = relativePrefix(options.file);
  return renderShell({
    title: options.title,
    workspaceTitle: options.workspaceTitle,
    active: options.active,
    assetBase: `${prefix}assets/`,
    assetManifest: options.assets,
    basePrefix: prefix,
    navItems: navWithPrefix(options.active, prefix),
    ...(options.pages.length === 0 ? {} : { sidebar: renderSidebar(options.pages, options.file) }),
    ...(options.rightRail === undefined ? {} : { rightRail: options.rightRail }),
    main: options.main,
    searchIndexHref: `${prefix}search-index.json`,
    graphHref: `${prefix}graph.html`,
    footer: `<a href="${prefix}llms.txt">llms.txt</a><a href="${prefix}llms-full.txt">llms-full.txt</a><a href="${prefix}agents/index.md">Agent Graph Guide</a><a href="${prefix}graph-report.json">Graph Report</a><a href="${prefix}sitemap.xml">Sitemap</a><a href="${prefix}openapi.json">OpenAPI</a><a href="${prefix}mcp-manifest.json">MCP</a>`,
  });
}

export function renderStaticBreadcrumb(fromFile: string, items: Array<{ label: string; href?: string }>): string {
  return renderBreadcrumb(
    items.map((item) => ({
      label: item.label,
      ...(item.href === undefined ? {} : { href: relativeHref(fromFile, item.href) }),
    })),
  );
}

function renderSidebar(pages: PageRecord[], fromFile: string): string {
  const grouped = new Map<string, PageRecord[]>();
  for (const page of pages) {
    const group = page.page_type || "page";
    grouped.set(group, [...(grouped.get(group) ?? []), page]);
  }
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, groupPages]) =>
      `<details class="ow-sidebar-group" data-openwiki-sidebar-group data-group="${escapeHtml(group)}" open>
        <summary>${escapeHtml(group)}</summary>
        ${renderRecordList(
        groupPages
          .sort((left, right) => left.title.localeCompare(right.title))
          .map((page) => ({
            title: page.title,
            href: relativeHref(fromFile, `${pageRoute(page.id)}.html`),
            summary: page.summary ?? page.id,
            status: page.status,
            active: `${pageRoute(page.id)}.html` === fromFile,
          })),
      )}
      </details>`,
    )
    .join("");
  return `<div class="ow-sidebar-tools">
    <label class="ow-sr-only" for="openwiki-sidebar-filter">Filter pages</label>
    <input id="openwiki-sidebar-filter" type="search" placeholder="Filter pages" data-openwiki-sidebar-filter autocomplete="off">
  </div>${groups}`;
}

export function renderStaticPageNavigation(page: PageRecord, pages: PageRecord[], fromFile: string): string {
  const adjacent = adjacentPages(page, pages);
  return renderPanel("Continue Reading", `<nav class="ow-page-nav" aria-label="Page navigation">
    ${adjacent.previous ? pageNavigationLink("Previous", adjacent.previous.title, relativeHref(fromFile, `${pageRoute(adjacent.previous.id)}.html`)) : pageNavigationPlaceholder("Previous")}
    ${pageNavigationLink("Open In Graph", "Focus this page", relativeHref(fromFile, `graph.html?focus=${encodeURIComponent(page.id)}`))}
    ${adjacent.next ? pageNavigationLink("Next", adjacent.next.title, relativeHref(fromFile, `${pageRoute(adjacent.next.id)}.html`)) : pageNavigationPlaceholder("Next")}
  </nav>`);
}

function adjacentPages(page: PageRecord, pages: PageRecord[]): { previous?: PageRecord; next?: PageRecord } {
  const siblings = pages
    .filter((candidate) => candidate.page_type === page.page_type)
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const index = siblings.findIndex((candidate) => candidate.id === page.id);
  return {
    ...(index > 0 && siblings[index - 1] ? { previous: siblings[index - 1] } : {}),
    ...(index >= 0 && siblings[index + 1] ? { next: siblings[index + 1] } : {}),
  };
}

export function pageNavigationLink(label: string, title: string, href: string): string {
  return `<a class="ow-page-nav__item" href="${escapeHtml(href)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(title)}</strong></a>`;
}

export function pageNavigationPlaceholder(label: string): string {
  return `<span class="ow-page-nav__item is-disabled"><span>${escapeHtml(label)}</span><strong>None</strong></span>`;
}

export function renderTopicList(topics: TopicSummary[], fromFile: string): string {
  if (topics.length === 0) {
    return `<p class="ow-muted">No topics found.</p>`;
  }
  return `<div class="ow-chip-list">${topics
    .map((topic) => `<a class="ow-chip" href="${relativeHref(fromFile, "topics.html")}#${topicAnchor(topic.topic)}">${escapeHtml(topic.topic)} · ${topic.page_count}</a>`)
    .join("")}</div>`;
}

export function renderTopicSections(topics: TopicSummary[], pages: PageRecord[], fromFile: string): string {
  if (topics.length === 0) {
    return renderPanel("Pages By Topic", `<p class="ow-muted">No topic sections found.</p>`);
  }
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  return topics
    .slice()
    .sort((left, right) => left.topic.localeCompare(right.topic))
    .map((topic) => {
      const topicPages = topic.page_ids.map((id) => pagesById.get(id)).filter((page): page is PageRecord => page !== undefined);
      const graphHref = relativeHref(fromFile, `graph.html?focus=${encodeURIComponent(`topic:${normalizeWikiTarget(topic.topic)}`)}&types=${encodeURIComponent("page,topic")}`);
      const records = topicPages
        .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
        .map((page) => ({
          title: page.title,
          href: relativeHref(fromFile, `${pageRoute(page.id)}.html`),
          type: page.page_type,
          status: page.status,
          summary: page.summary ?? page.id,
        }));
      return `<section id="${topicAnchor(topic.topic)}" class="ow-topic-section">
        ${renderPanel(
        topic.topic,
        `<p class="ow-muted">${topic.page_count} ${topic.page_count === 1 ? "page" : "pages"} · ${topic.claim_count} ${topic.claim_count === 1 ? "claim" : "claims"} · ${topic.source_count} ${topic.source_count === 1 ? "source" : "sources"}</p>
          <p><a href="${escapeHtml(graphHref)}">View topic in graph</a></p>
          ${renderRecordList(records, "No public pages for this topic.")}`,
        { eyebrow: "Topic" },
      )}
      </section>`;
    })
    .join("");
}

export function renderRecentChangeList(changes: RecentChangesResponse, fromFile: string): string {
  if (!changes.is_git_repo) {
    return `<p class="ow-muted">This export was not built from a Git repository.</p>`;
  }
  if (changes.changes.length === 0) {
    return `<p class="ow-muted">No recent changes found.</p>`;
  }
  const grouped = new Map<string, RecentChangesResponse["changes"]>();
  for (const change of changes.changes.slice(0, 24)) {
    const day = change.date.slice(0, 10) || "Unknown date";
    grouped.set(day, [...(grouped.get(day) ?? []), change]);
  }
  return `<div class="ow-timeline">${[...grouped.entries()]
    .map(
      ([day, dayChanges]) => `<section class="ow-timeline__day">
        <h3><time datetime="${escapeHtml(day)}">${escapeHtml(day)}</time></h3>
        <ul class="ow-record-list">${dayChanges
          .map(
            (change) => `<li>
              <div class="ow-record-list__title"><span>${escapeHtml(change.subject)}</span></div>
              <p><code>${escapeHtml(change.short_sha)}</code> · ${escapeHtml(change.author_name)} · ${escapeHtml(change.date)}</p>
              <small>${renderRecentChangeFiles(change.files, fromFile)}</small>
            </li>`,
          )
          .join("")}</ul>
      </section>`,
    )
    .join("")}</div>`;
}

function renderRecentChangeFiles(files: Array<{ status: string; path: string }>, fromFile: string): string {
  const visibleFiles = files.slice(0, 5).map((file) => {
    const label = `${file.status} ${file.path}`;
    const href = hrefForRecentChangePath(file.path, fromFile);
    return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
  });
  const remaining = files.length - visibleFiles.length;
  if (remaining > 0) {
    visibleFiles.push(`${remaining} more ${remaining === 1 ? "file" : "files"}`);
  }
  return visibleFiles.join(" · ");
}

function hrefForRecentChangePath(filePath: string, fromFile: string): string | undefined {
  if (!filePath.startsWith("wiki/") || !filePath.endsWith(".md")) {
    return undefined;
  }
  return relativeHref(fromFile, `${filePath.slice("wiki/".length, filePath.length - ".md".length)}.html`);
}

function topicAnchor(topic: string): string {
  return `topic-${normalizeWikiTarget(topic)}`;
}

export function renderDefinitionList(entries: Array<[string, string]>, valuesMayContainHtml = false): string {
  const rows = entries
    .filter(([, value]) => value.trim().length > 0)
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${valuesMayContainHtml ? value : escapeHtml(value)}</dd></div>`)
    .join("");
  return rows.length === 0 ? `<p class="ow-muted">No metadata found.</p>` : `<dl class="ow-meta-list">${rows}</dl>`;
}

export function wikiResolver(pages: PageRecord[], fromFile: string): (target: string) => string | undefined {
  const byKey = new Map<string, PageRecord>();
  for (const page of pages) {
    byKey.set(normalizeWikiTarget(page.id), page);
    byKey.set(normalizeWikiTarget(page.title), page);
    byKey.set(normalizeWikiTarget(slugFromPageId(page.id)), page);
  }
  return (target) => {
    const page = byKey.get(normalizeWikiTarget(target));
    return page === undefined ? undefined : relativeHref(fromFile, `${pageRoute(page.id)}.html`);
  };
}

export function resolveMarkdownHref(href: string, fromFile: string, pages: PageRecord[]): string | undefined {
  const safeHref = safeDocumentHref(href);
  if (safeHref === undefined) {
    return undefined;
  }
  if (/^(https?:|mailto:|#)/i.test(safeHref)) {
    return safeHref;
  }
  const withoutHash = safeHref.split("#")[0] ?? safeHref;
  if (withoutHash.endsWith(".md")) {
    const slug = withoutHash.split("/").pop()?.replace(/\.md$/, "");
    const page = pages.find((candidate) => slugFromPageId(candidate.id) === slug);
    if (page) {
      const hash = safeHref.includes("#") ? `#${safeHref.split("#").slice(1).join("#")}` : "";
      return `${relativeHref(fromFile, `${pageRoute(page.id)}.html`)}${hash}`;
    }
  }
  return safeHref;
}

function normalizeWikiTarget(value: string): string {
  return value.toLowerCase().trim().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function slugFromPageId(id: string): string {
  return id.split(":").slice(2).join(":") || id;
}

export function localGraphForRecord(graph: GraphIndexResponse, id: string): GraphIndexResponse {
  const nodeIds = new Set<string>([id]);
  const edges = graph.edges.filter((edge) => {
    if (edge.from_id === id || edge.to_id === id) {
      nodeIds.add(edge.from_id);
      nodeIds.add(edge.to_id);
      return true;
    }
    return false;
  });
  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges,
  };
}

export function graphTextFallbackForStatic(graph: GraphIndexResponse, fromFile: string, limit = 12): string {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1);
  }
  const records = graph.nodes
    .slice()
    .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.title.localeCompare(right.title))
    .slice(0, limit)
    .map((node) => ({
      title: node.title,
      href: graphNodeStaticHref(node.id, node.record_type, fromFile),
      type: node.record_type,
      summary: node.summary ?? node.id,
    }));
  return renderRecordList(records, "No graph nodes found.");
}

export function staticBacklinkRecords(graph: GraphIndexResponse, id: string, fromFile: string): Array<{ title: string; href?: string; type?: string; summary?: string }> {
  return staticGraphRecords(
    graph,
    graph.edges
      .filter((edge) => edge.edge_type === "page_link" && edge.to_id === id)
      .map((edge) => edge.from_id),
    fromFile,
    (node) => node.summary ?? node.id,
  );
}

export function staticRelatedRecords(graph: GraphIndexResponse, id: string, fromFile: string): Array<{ title: string; href?: string; type?: string; summary?: string }> {
  const entries = graph.edges
    .filter((edge) => (edge.from_id === id || edge.to_id === id) && !(edge.edge_type === "page_link" && edge.to_id === id))
    .map((edge) => ({
      id: edge.from_id === id ? edge.to_id : edge.from_id,
      edgeType: edge.edge_type,
    }));
  const edgeByNode = new Map<string, string>();
  for (const entry of entries) {
    edgeByNode.set(entry.id, edgeByNode.get(entry.id) ?? entry.edgeType);
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const orderedIds = [...edgeByNode.keys()].sort((left, right) => {
    const leftNode = nodesById.get(left);
    const rightNode = nodesById.get(right);
    return staticRelatedPriority(edgeByNode.get(left), leftNode?.record_type) - staticRelatedPriority(edgeByNode.get(right), rightNode?.record_type) || (leftNode?.title ?? left).localeCompare(rightNode?.title ?? right) || left.localeCompare(right);
  });
  return staticGraphRecords(graph, orderedIds, fromFile, (node) => `${edgeByNode.get(node.id) ?? "related"} / ${node.summary ?? node.id}`);
}

function staticRelatedPriority(edgeType: string | undefined, recordType: string | undefined): number {
  if (edgeType === "page_link" && recordType === "page") return 0;
  if (recordType === "page") return 1;
  if (recordType === "source") return 2;
  if (recordType === "claim") return 3;
  if (recordType === "topic" || recordType === "section") return 4;
  if (recordType === "proposal" || recordType === "decision") return 5;
  return 9;
}

function staticGraphRecords(
  graph: GraphIndexResponse,
  ids: string[],
  fromFile: string,
  summary: (node: GraphNodeRecord) => string,
): Array<{ title: string; href?: string; type?: string; summary?: string }> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const order = new Map(ids.map((id, index) => [id, index]));
  const seen = new Set<string>();
  return ids
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => nodesById.get(id))
    .filter((node): node is GraphNodeRecord => node !== undefined)
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0) || left.title.localeCompare(right.title))
    .slice(0, 12)
    .map((node) => {
      const href = graphNodeStaticHref(node.id, node.record_type, fromFile);
      return {
        title: node.title,
        ...(href === undefined ? {} : { href }),
        type: node.record_type,
        summary: summary(node),
      };
    });
}

function graphNodeStaticHref(id: string, recordType: string, fromFile: string): string | undefined {
  if (["page", "source", "claim", "proposal", "decision"].includes(recordType)) {
    return relativeHref(fromFile, `${id.startsWith("page:") ? pageRoute(id) : recordRoute(id)}.html`);
  }
  return undefined;
}
