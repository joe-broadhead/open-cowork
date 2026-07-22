import { updateGraphNodeList } from "./node-list.js";
import { centerGraphOnNode, fitGraph } from "./renderer.js";
import { scheduleGraphLayout } from "./layout.js";
import { colorForEdge, colorForType, escapeAttr, escapeHtml, graphDegree, graphValueLabel, nodeMatchesSearch } from "./utils.js";

/** Apply data-graph-height via CSSOM (CSP-safe; no style= attributes). */
export function applyGraphHeightFromDataset(graph) {
  const height = graph.dataset.graphHeight?.trim();
  if (!height) return;
  graph.style.setProperty("--ow-graph-height", height);
}

export function renderGraphControls(state) {
  renderGraphLegend(state.nodeLegend, "Nodes", "node", state.availableNodeTypes, state.visibleNodeTypes);
  renderGraphLegend(state.edgeLegend, "Edges", "edge", state.availableEdgeTypes, state.visibleEdgeTypes);
  updateGraphScopeControls(state);
  updateGraphSearchResults(state);
  updateGraphNodeList(state);
}

export function updateGraphScopeControls(state) {
  state.scopeControls?.forEach((button) => {
    const scope = button.dataset.openwikiGraphScope === "neighborhood" ? "neighborhood" : "all";
    const active = state.graphScope === scope;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.disabled = state.mode === "local" && scope === "all";
  });
}

export function renderGraphLegend(container, label, kind, values, visibleSet) {
  if (!container) return;
  const allActive = visibleSet === undefined;
  const reset = `<button type="button" class="ow-graph__chip${allActive ? " is-active" : ""}" data-openwiki-graph-chip data-graph-filter-kind="${kind}" data-graph-filter-value="" aria-pressed="${allActive ? "true" : "false"}">All ${escapeHtml(label.toLowerCase())}</button>`;
  container.innerHTML = `<span class="ow-graph__legend-label">${escapeHtml(label)}</span>${reset}${values.map((value) => {
    const active = visibleSet === undefined || visibleSet.has(value);
    const color = kind === "node" ? colorForType(value) : colorForEdge(value);
    // data-chip-color + CSSOM below: avoid style= attributes under style-src 'self' (JOE-980).
    return `<button type="button" class="ow-graph__chip${active ? " is-active" : ""}" data-openwiki-graph-chip data-graph-filter-kind="${kind}" data-graph-filter-value="${escapeAttr(value)}" aria-pressed="${active ? "true" : "false"}"><span class="ow-graph__swatch" data-chip-color="${escapeAttr(color)}"></span>${escapeHtml(graphValueLabel(value))}</button>`;
  }).join("")}`;
  applyChipColorsFromDataset(container);
}

export function applyChipColorsFromDataset(container) {
  container.querySelectorAll("[data-chip-color]").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const color = el.dataset.chipColor?.trim();
    if (color) el.style.setProperty("--ow-chip-color", color);
  });
}

export function handleGraphLegendClick(event, state, expectedKind, render, refreshGraphState) {
  const button = event.target instanceof Element ? event.target.closest("[data-openwiki-graph-chip]") : undefined;
  if (!button || button.dataset.graphFilterKind !== expectedKind) return;
  const kind = button.dataset.graphFilterKind;
  const value = button.dataset.graphFilterValue || "";
  const key = kind === "node" ? "visibleNodeTypes" : "visibleEdgeTypes";
  const available = kind === "node" ? state.availableNodeTypes : state.availableEdgeTypes;
  if (!value) {
    state[key] = undefined;
  } else {
    const next = state[key] === undefined ? new Set(available) : new Set(state[key]);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    state[key] = next.size === available.length ? undefined : next;
  }
  refreshGraphState(state);
  renderGraphControls(state);
  updateGraphUrlState(state);
  fitGraph(state);
  render();
  scheduleGraphLayout(state, render);
}

export function updateGraphSearchResults(state) {
  if (!state.searchResults) return;
  const matches = graphSearchMatches(state, 8);
  if (!state.searchTerm) {
    state.searchResults.hidden = true;
    state.searchResults.innerHTML = "";
    return;
  }
  state.searchResults.hidden = false;
  if (matches.length === 0) {
    state.searchResults.innerHTML = '<p class="ow-muted">No graph nodes match.</p>';
    return;
  }
  state.searchResults.innerHTML = matches.map(({ node }) => `<button type="button" data-openwiki-graph-match data-graph-match-id="${escapeAttr(node.id)}" role="option"><strong>${escapeHtml(node.title || node.id)}</strong><span>${escapeHtml(node.record_type || "record")} · ${escapeHtml(String(node.degree || 0))} links</span></button>`).join("");
}

export function graphSearchMatches(state, limit = 8) {
  if (!state.searchTerm) return [];
  const term = state.searchTerm;
  const searchGraph = state.rawGraph || state.baseGraph;
  const degree = graphDegree(searchGraph.edges || []);
  const visibleEdgeNodeIds = state.visibleEdgeTypes
    ? new Set((searchGraph.edges || []).filter((edge) => graphTypeVisible(state.visibleEdgeTypes, edge.edge_type)).flatMap((edge) => [edge.from_id, edge.to_id]))
    : undefined;
  return (searchGraph.nodes || [])
    .filter((node) => graphTypeVisible(state.visibleNodeTypes, node.record_type))
    .filter((node) => state.showOrphans || (degree.get(node.id) || 0) > 0)
    .filter((node) => visibleEdgeNodeIds === undefined || visibleEdgeNodeIds.has(node.id) || node.id === state.focusId)
    .filter((node) => nodeMatchesSearch(node, term))
    .map((node) => ({ node: { ...node, degree: degree.get(node.id) || 0 }, score: graphSearchScore(node, term, degree.get(node.id) || 0) }))
    .sort((left, right) => right.score - left.score || String(left.node.title).localeCompare(String(right.node.title)))
    .slice(0, limit);
}

function graphSearchScore(node, term, degree) {
  const title = String(node.title || "").toLowerCase();
  const id = String(node.id || "").toLowerCase();
  const type = String(node.record_type || "").toLowerCase();
  let score = Math.min(degree, 20);
  if (title === term) score += 120;
  if (title.startsWith(term)) score += 80;
  if (title.includes(term)) score += 50;
  if (id.includes(term)) score += 20;
  if (type.includes(term)) score += 8;
  return score;
}

export function focusGraphSearchMatch(state, id, render, selectGraphNode, refreshGraphState) {
  const node = (state.rawGraph.nodes || state.baseGraph.nodes || []).find((candidate) => candidate.id === id);
  if (!node) return;
  if (state.mode !== "local") {
    state.graphScope = "neighborhood";
  }
  selectGraphNode(state, node);
  refreshGraphState(state);
  renderGraphControls(state);
  centerGraphOnNode(state, state.nodes.find((candidate) => candidate.id === node.id) || node);
  updateGraphUrlState(state);
  render();
  scheduleGraphLayout(state, render);
}

export function updateGraphCount(state) {
  const total = state.rawGraph.nodes?.length || state.baseGraph.nodes?.length || 0;
  const scopeLabel = state.graphScope === "neighborhood" ? "focus" : "all";
  if (state.count) {
    state.count.textContent = `${state.nodes.length} of ${total} nodes · ${scopeLabel}`;
  }
  updateGraphAccessibleLabel(state, total);
}

function updateGraphAccessibleLabel(state, totalNodes) {
  const modeLabel = state.mode === "local" ? "local neighborhood graph" : state.mode === "preview" ? "knowledge graph preview" : "workspace knowledge graph";
  const selected = state.nodes.find((node) => node.id === state.selectedNodeId || node.id === state.focusId);
  const selectedText = selected ? ` Focused on ${selected.title || selected.id}.` : "";
  const scopeText = state.graphScope === "neighborhood" ? " Focus scope is active." : "";
  const filterText = state.visibleNodeTypes || state.visibleEdgeTypes || !state.showOrphans ? " Filters are active." : "";
  state.canvas.setAttribute(
    "aria-label",
    `OpenWiki ${modeLabel} showing ${state.nodes.length} of ${totalNodes} nodes and ${state.edges.length} edges.${selectedText}${scopeText}${filterText} Use arrow keys to pan, plus and minus to zoom, F to fit, R to refresh layout, and Escape to clear selection. The graph detail panel lists the selected node and visible neighbors.`,
  );
}

export function updatePinnedGraphState(state) {
  state.canvas.dataset.pinnedCount = String(state.pinnedNodeIds.size);
}

export function uniqueGraphValues(records, key) {
  return Array.from(new Set((records || []).map((record) => record[key]).filter(Boolean))).sort((left, right) => String(left).localeCompare(String(right)));
}

export function parseGraphFilterParam(params, key, legacyKey) {
  const raw = params.get(key) || params.get(legacyKey) || "";
  if (!raw) return undefined;
  if (raw === "none") return new Set();
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

export function serializeGraphFilter(filter) {
  if (filter === undefined) return "";
  return filter.size === 0 ? "none" : Array.from(filter).sort().join(",");
}

export function graphTypeVisible(filter, value) {
  return filter === undefined || filter.has(value);
}

export function updateGraphUrlState(state) {
  if (!window.history?.replaceState) return;
  const url = new URL(window.location.href);
  setOptionalParam(url, "focus", state.focusId || "");
  setOptionalParam(url, "scope", state.mode === "local" || state.graphScope === "all" ? "" : state.graphScope);
  setOptionalParam(url, "depth", state.depth === 1 ? "" : String(state.depth));
  setOptionalParam(url, "q", state.searchTerm);
  setOptionalParam(url, "types", serializeGraphFilter(state.visibleNodeTypes));
  setOptionalParam(url, "edge_types", serializeGraphFilter(state.visibleEdgeTypes));
  url.searchParams.delete("node_type");
  url.searchParams.delete("edge_type");
  setOptionalParam(url, "orphans", state.showOrphans ? "" : "0");
  window.history.replaceState(null, "", url);
}

export function setOptionalParam(url, key, value) {
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
}
