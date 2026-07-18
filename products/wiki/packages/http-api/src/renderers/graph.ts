import { boundedNumberQuery } from "../request.ts";
import { type GraphEdgeRecord, type GraphIndexResponse, type GraphNeighborhoodResponse, type GraphNodeRecord, humanLabel, type PageRecord } from "@openwiki/core";
import type { SourceContentRead } from "@openwiki/repo";
import { escapeHtml, renderBadge, renderGraphMount } from "@openwiki/web";

export function renderGraphPanel(recordId: string, backlinks: GraphNeighborhoodResponse, related: GraphNeighborhoodResponse): string {
  const backlinkNodes = graphNeighborNodes(recordId, backlinks)
    .filter((item) => item.direction === "incoming" && item.edge_type === "page_link")
    .slice(0, 6);
  const relatedNodes = graphNeighborNodes(recordId, related).slice(0, 8);
  const localGraph = mergeGraphIndexes(backlinks, related);
  const visual = renderGraphVisualization(localGraph, {
    focusId: recordId,
    width: 320,
    height: 240,
    maxNodes: 18,
    compact: true,
  });
  return [
    `<details class="ow-local-graph"><summary>Local Graph</summary>${renderGraphMount({
      src: "/api/v1/graph/" + encodeURIComponent(recordId) + "/neighbors",
      mode: "local",
      focusId: recordId,
      height: "260px",
      fallback: visual.svg,
    })}</details>`,
    backlinkNodes.length === 0 ? '<p class="ow-muted">No page backlinks yet.</p>' : '<h3>Backlinks</h3>' + renderGraphNodeList(backlinkNodes),
    relatedNodes.length === 0 ? '<p class="ow-muted">No related graph nodes.</p>' : '<h3>Related</h3>' + renderGraphNodeList(relatedNodes),
    '<p><a href="/graph?focus=' + encodeURIComponent(recordId) + '">Open workspace graph</a> / <a href="/api/v1/graph/' + encodeURIComponent(recordId) + '/neighbors">Graph JSON</a></p>',
  ].join("");
}

interface GraphNeighborListItem {
  id: string;
  title: string;
  record_type: string;
  edge_type: string;
  direction: "incoming" | "outgoing";
}

function graphNeighborNodes(rootId: string, graph: GraphNeighborhoodResponse): GraphNeighborListItem[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const byId = new Map<string, GraphNeighborListItem>();
  for (const edge of graph.edges) {
    const neighborId = edge.from_id === rootId ? edge.to_id : edge.to_id === rootId ? edge.from_id : undefined;
    if (neighborId === undefined) {
      continue;
    }
    const node = nodesById.get(neighborId);
    if (node === undefined) {
      continue;
    }
    const item: GraphNeighborListItem = {
      id: node.id,
      title: node.title,
      record_type: node.record_type,
      edge_type: edge.edge_type,
      direction: edge.to_id === rootId ? "incoming" : "outgoing",
    };
    const current = byId.get(item.id);
    if (current === undefined || graphNeighborPriority(item) < graphNeighborPriority(current)) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((left, right) => graphNeighborPriority(left) - graphNeighborPriority(right) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function graphNeighborPriority(item: GraphNeighborListItem): number {
  if (item.edge_type === "page_link" && item.direction === "incoming" && item.record_type === "page") return 0;
  if (item.record_type === "page") return 1;
  if (item.record_type === "source") return 2;
  if (item.record_type === "claim") return 3;
  if (item.record_type === "topic" || item.record_type === "section") return 4;
  if (item.record_type === "proposal" || item.record_type === "decision") return 5;
  return 9;
}

function renderGraphNodeList(nodes: GraphNeighborListItem[]): string {
  return '<ul class="ow-record-list">' + nodes.map((node) => '<li><div class="ow-record-list__title">' + renderGraphNodeLink(node) + '</div><p>' + escapeHtml(humanLabel(node.record_type)) + ' / ' + escapeHtml(humanLabel(node.edge_type)) + '</p></li>').join("") + '</ul>';
}

export function renderGraphVisibleNodeList(nodes: Array<{ id: string; title: string; record_type: string }>): string {
  return '<ul class="ow-record-list">' + nodes.map((node) => '<li><div class="ow-record-list__title">' + renderGraphNodeLink(node) + '</div><p>' + escapeHtml(humanLabel(node.record_type)) + '</p></li>').join("") + '</ul>';
}

function renderGraphNodeLink(node: { id: string; title: string; record_type: string }): string {
  const href = graphNodeHref(node);
  const label = escapeHtml(node.title || node.id);
  return href === undefined ? '<span>' + label + '</span>' : '<a href="' + href + '">' + label + '</a>';
}

function graphNodeHref(node: { id: string; record_type: string }): string | undefined {
  if (node.record_type === "page") return '/pages/' + encodeURIComponent(node.id);
  if (node.record_type === "source") return '/sources/' + encodeURIComponent(node.id);
  if (node.record_type === "claim") return '/claims/' + encodeURIComponent(node.id);
  if (node.record_type === "proposal") return '/proposals/' + encodeURIComponent(node.id);
  if (node.record_type === "decision") return '/decisions/' + encodeURIComponent(node.id);
  return undefined;
}

interface GraphVisualOptions {
  focusId?: string;
  width: number;
  height: number;
  maxNodes: number;
  compact?: boolean;
}

interface GraphVisualResult {
  svg: string;
  nodes: GraphNodeRecord[];
  renderedNodes: number;
  renderedEdges: number;
}

export function renderGraphVisualization(graph: GraphIndexResponse, options: GraphVisualOptions): GraphVisualResult {
  const nodes = selectGraphVisualNodes(graph, options);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id));
  const positioned = positionGraphNodes(nodes, options);
  const positions = new Map(positioned.map((node) => [node.id, node]));
  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from_id);
      const to = positions.get(edge.to_id);
      if (!from || !to) {
        return "";
      }
      return `<line class="ow-graph-edge ow-graph-edge-${escapeHtml(cssClassToken(edge.edge_type))}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"><title>${escapeHtml(edge.edge_type)}</title></line>`;
    })
    .join("");
  const nodeSvg = positioned
    .map((node) => {
      const href = graphNodeHref(node);
      const radius = node.id === options.focusId ? 13 : options.compact ? 8 : 10;
      const label = truncateGraphLabel(node.title || node.id, options.compact ? 18 : 24);
      const circle = `<circle class="ow-graph-node ow-graph-node-${escapeHtml(cssClassToken(node.record_type))}${node.id === options.focusId ? " is-focus" : ""}" cx="${node.x}" cy="${node.y}" r="${radius}"><title>${escapeHtml(node.title || node.id)} / ${escapeHtml(node.record_type)}</title></circle><text class="ow-graph-label" x="${node.x}" y="${node.y + radius + 13}">${escapeHtml(label)}</text>`;
      return href === undefined ? `<g>${circle}</g>` : `<a href="${href}">${circle}</a>`;
    })
    .join("");
  const empty = nodes.length === 0 ? `<text class="ow-graph-empty" x="${options.width / 2}" y="${options.height / 2}">No visible graph nodes</text>` : "";
  return {
    svg: `<svg class="ow-graph-visual${options.compact ? " compact" : ""}" role="img" aria-label="Permission-filtered OpenWiki graph" viewBox="0 0 ${options.width} ${options.height}" preserveAspectRatio="xMidYMid meet">${edgeSvg}${nodeSvg}${empty}</svg>`,
    nodes,
    renderedNodes: nodes.length,
    renderedEdges: edges.length,
  };
}

function selectGraphVisualNodes(graph: GraphIndexResponse, options: GraphVisualOptions): GraphNodeRecord[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const degree = graphDegree(graph.edges);
  let selectedIds: string[];
  if (options.focusId && byId.has(options.focusId)) {
    const neighbors = new Set<string>([options.focusId]);
    for (const edge of graph.edges) {
      if (edge.from_id === options.focusId) {
        neighbors.add(edge.to_id);
      }
      if (edge.to_id === options.focusId) {
        neighbors.add(edge.from_id);
      }
    }
    selectedIds = [...neighbors].sort((left, right) => (right === options.focusId ? 1 : 0) - (left === options.focusId ? 1 : 0) || (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right));
  } else {
    selectedIds = graph.nodes
      .map((node) => node.id)
      .sort((left, right) => (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right));
  }
  return selectedIds
    .slice(0, Math.max(options.maxNodes, 1))
    .map((id) => byId.get(id))
    .filter((node): node is GraphNodeRecord => node !== undefined);
}

export function graphIndexForQuery(
  graph: GraphIndexResponse,
  url: URL,
  options: { defaultLimit?: number; maxLimit?: number } = {},
): GraphIndexResponse {
  const seed = url.searchParams.get("seed");
  const focusId = url.searchParams.get("focus") ?? url.searchParams.get("id") ?? undefined;
  if (seed !== null && seed !== "top") {
    throw new Error("Invalid graph seed");
  }
  const maxLimit = Math.max(Math.trunc(options.maxLimit ?? 5000), 1);
  const defaultLimit = Math.min(Math.max(Math.trunc(options.defaultLimit ?? 500), 1), maxLimit);
  const limit = boundedNumberQuery(url, "limit", defaultLimit, 1, maxLimit);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const degree = graphDegree(graph.edges);
  let selectedIds: string[];
  if (focusId !== undefined && byId.has(focusId)) {
    const ids = new Set<string>([focusId]);
    for (const edge of graph.edges) {
      if (edge.from_id === focusId) ids.add(edge.to_id);
      if (edge.to_id === focusId) ids.add(edge.from_id);
    }
    selectedIds = [...ids].sort((left, right) => (left === focusId ? -1 : right === focusId ? 1 : 0) || (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right));
  } else {
    selectedIds = graph.nodes
      .map((node) => node.id)
      .sort((left, right) => (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right));
  }
  const selected = new Set(selectedIds.slice(0, limit));
  return {
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter((edge) => selected.has(edge.from_id) && selected.has(edge.to_id)),
  };
}

export function graphDegree(edges: GraphEdgeRecord[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1);
  }
  return degree;
}

export function positionGraphNodes(nodes: GraphNodeRecord[], options: GraphVisualOptions): Array<GraphNodeRecord & { x: number; y: number }> {
  if (nodes.length === 0) {
    return [];
  }
  const centerX = options.width / 2;
  const centerY = options.height / 2;
  const radiusX = Math.max(options.width / 2 - (options.compact ? 48 : 90), 40);
  const radiusY = Math.max(options.height / 2 - (options.compact ? 44 : 72), 36);
  const focusIndex = options.focusId === undefined ? -1 : nodes.findIndex((node) => node.id === options.focusId);
  const positioned: Array<GraphNodeRecord & { x: number; y: number }> = [];
  const ringNodes = focusIndex >= 0 ? nodes.filter((_, index) => index !== focusIndex) : nodes;
  if (focusIndex >= 0) {
    positioned.push({ ...nodes[focusIndex]!, x: roundCoordinate(centerX), y: roundCoordinate(centerY) });
  }
  ringNodes.forEach((node, index) => {
    const angle = ringNodes.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index / ringNodes.length) * Math.PI * 2;
    positioned.push({
      ...node,
      x: roundCoordinate(centerX + Math.cos(angle) * radiusX),
      y: roundCoordinate(centerY + Math.sin(angle) * radiusY),
    });
  });
  return positioned;
}

function mergeGraphIndexes(...graphs: GraphIndexResponse[]): GraphIndexResponse {
  const nodes = new Map<string, GraphNodeRecord>();
  const edges = new Map<string, GraphEdgeRecord>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      nodes.set(node.id, node);
    }
    for (const edge of graph.edges) {
      edges.set(edge.id, edge);
    }
  }
  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function graphSummary(graph: GraphIndexResponse): { nodeTypes: Record<string, number>; edgeTypes: Record<string, number> } {
  return {
    nodeTypes: countBy(graph.nodes.map((node) => node.record_type)),
    edgeTypes: countBy(graph.edges.map((edge) => edge.edge_type)),
  };
}

export function renderGraphSummaryList(values: Record<string, number>): string {
  const entries = Object.entries(values).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (entries.length === 0) {
    return `<p class="ow-muted">No visible records.</p>`;
  }
  return `<ul class="ow-link-list">${entries.map(([key, value]) => `<li><span>${escapeHtml(key)}</span> <span class="ow-muted">${value}</span></li>`).join("")}</ul>`;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function cssClassToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "record";
}

function truncateGraphLabel(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, Math.max(maxLength - 1, 1)) + "...";
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(2));
}

export function renderJsonPanel(title: string, value: unknown): string {
  if (value === undefined) {
    return "";
  }
  return `<section class="ow-panel"><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></section>`;
}

export function renderSourceContentPanel(sourceContent: SourceContentRead): string {
  if (sourceContent.content === null) {
    return "";
  }
  const content = sourceContent.content;
  return `<section class="ow-panel">
    <div class="ow-panel__head"><h2>Captured Content</h2><a href="/api/v1/sources/${encodeURIComponent(sourceContent.source.id)}/content">JSON</a></div>
    <dl class="ow-meta-list">
      <dt>Path</dt><dd>${escapeHtml(content.path)}</dd>
      <dt>Bytes</dt><dd>${content.bytes}</dd>
      ${content.hash_verified === undefined ? "" : `<dt>Hash</dt><dd>${content.hash_verified ? "verified" : "mismatch"}</dd>`}
    </dl>
    <pre>${escapeHtml(content.body)}</pre>
    ${content.truncated ? `<p class="ow-muted">Content truncated for display.</p>` : ""}
  </section>`;
}

export function renderExternalLink(url: string): string {
  const href = safeExternalHref(url);
  if (href === undefined) {
    return escapeHtml(url);
  }
  return `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
}

export function safeExternalHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function webHrefForRecord(type: string, id: string): string | undefined {
  if (type === "page") {
    return `/pages/${encodeURIComponent(id)}`;
  }
  if (type === "source") {
    return `/sources/${encodeURIComponent(id)}`;
  }
  if (type === "source_fragment") {
    const sourceId = sourceIdFromFragmentId(id);
    return sourceId === undefined ? undefined : `/sources/${encodeURIComponent(sourceId)}`;
  }
  if (type === "claim") {
    return `/claims/${encodeURIComponent(id)}`;
  }
  if (type === "proposal") {
    return `/proposals/${encodeURIComponent(id)}`;
  }
  if (type === "decision") {
    return `/decisions/${encodeURIComponent(id)}`;
  }
  if (type === "event") {
    return "/api/v1/events";
  }
  if (type === "recent_change") {
    return "/api/v1/recent-changes";
  }
  return undefined;
}

export function sourceIdFromFragmentId(id: string): string | undefined {
  const parts = id.split(":");
  if (parts[0] !== "fragment" || parts.length < 4) {
    return undefined;
  }
  return parts.slice(1, -1).join(":");
}

export function pagePublicRoute(page: PageRecord): string {
  return `/${pluralizePageType(page.page_type)}/${slugFromPageId(page.id)}`;
}

export function pageLegacyRoute(id: string): string {
  const [, pageType, slug] = id.split(":");
  return [pageType ?? "page", slug ?? id].join("/");
}

export function slugFromPageId(id: string): string {
  return id.split(":").slice(2).join(":") || id;
}

export function pluralizePageType(pageType: string): string {
  if (pageType === "entity") {
    return "entities";
  }
  if (pageType === "person") {
    return "people";
  }
  if (pageType.endsWith("s")) {
    return pageType;
  }
  return `${pageType}s`;
}

export function statusBadge(status: string): string {
  return renderBadge(status, status);
}
