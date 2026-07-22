import {
  applyGraphHeightFromDataset,
  focusGraphSearchMatch as focusGraphSearchMatchImpl,
  handleGraphLegendClick as handleGraphLegendClickImpl,
  parseGraphFilterParam,
  renderGraphControls,
  uniqueGraphValues,
  updateGraphCount,
  updateGraphSearchResults,
  updateGraphUrlState,
  updatePinnedGraphState,
  graphTypeVisible,
} from "./controls.js";
import { updateGraphDetail } from "./detail.js";
import { fetchGraphPayload } from "./fetch.js";
import { layoutNodes, scheduleGraphLayout } from "./layout.js";
import { handleGraphNodeListKeydown, updateGraphNodeList } from "./node-list.js";
import { centerGraphOnNode, drawGraph, fitGraph, nearestNode, resetGraphView, screenToWorld, zoomGraphAt } from "./renderer.js";
import { clamp, graphDegree, recordHref } from "./utils.js";

export function initGraphs() {
  document.querySelectorAll("[data-openwiki-graph]").forEach(async (graph) => {
    if (!(graph instanceof HTMLElement)) return;
    applyGraphHeightFromDataset(graph);
    const canvas = graph.querySelector("canvas");
    if (!canvas) return;
    try {
      const src = graph.dataset.graphSrc;
      const payload = await fetchGraphPayload(src);
      mountGraph(canvas, graph, payload);
      graph.classList.add("is-hydrated");
    } catch {
      graph.classList.remove("is-hydrated");
      const count = graph.querySelector("[data-openwiki-graph-count]");
      if (count) {
        count.textContent = "Graph could not be loaded";
        count.setAttribute("role", "status");
        count.setAttribute("aria-live", "polite");
      }
    }
  });
}


function mountGraph(canvas, graphElement, graph) {
  const state = createGraphState(canvas, graphElement, graph);
  const search = graphElement.querySelector("[data-openwiki-graph-search]");
  const searchResults = graphElement.querySelector("[data-openwiki-graph-search-results]");
  const depthControl = graphElement.querySelector("[data-openwiki-graph-depth]");
  const nodeLegend = graphElement.querySelector("[data-openwiki-graph-node-legend]");
  const edgeLegend = graphElement.querySelector("[data-openwiki-graph-edge-legend]");
  const orphanToggle = graphElement.querySelector("[data-openwiki-graph-orphans]");
  const scopeControls = graphElement.querySelectorAll("[data-openwiki-graph-scope]");
  const zoomControls = graphElement.querySelectorAll("[data-openwiki-graph-zoom]");
  const fit = graphElement.querySelector("[data-openwiki-graph-fit]");
  const reset = graphElement.querySelector("[data-openwiki-graph-reset]");
  const fullscreen = graphElement.querySelector("[data-openwiki-graph-fullscreen]");
  const detail = graphElement.querySelector("[data-openwiki-graph-detail]");
  const nodeList = graphElement.querySelector("[data-openwiki-graph-node-list]");
  state.detail = detail;
  state.searchControl = search;
  state.searchResults = searchResults;
  state.nodeLegend = nodeLegend;
  state.edgeLegend = edgeLegend;
  state.scopeControls = scopeControls;
  state.nodeList = nodeList;
  graphElement.__openWikiGraphState = state;
  canvas.__openWikiGraphState = state;
  if (search) search.value = state.searchTerm;
  if (depthControl) depthControl.value = String(state.depth);
  if (orphanToggle) orphanToggle.checked = state.showOrphans;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Interactive OpenWiki knowledge graph");
  renderGraphControls(state);
  const render = () => {
    drawGraph(state);
    updateGraphDetail(state);
    updateGraphNodeList(state);
    updateGraphCount(state);
  };
  fitGraph(state);
  render();
  scheduleGraphLayout(state, render);
  const resize = () => {
    state.dirtySize = true;
    render();
  };
  window.addEventListener("resize", resize);
  window.addEventListener("openwiki:themechange", render);
  search?.addEventListener("input", () => {
    state.searchTerm = search.value.trim().toLowerCase();
    updateGraphUrlState(state);
    updateGraphSearchResults(state);
    render();
  });
  search?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = searchResults?.querySelector("[data-openwiki-graph-match]");
      if (first) {
        event.preventDefault();
        focusGraphSearchMatch(state, first.dataset.graphMatchId, render);
      }
    } else if (event.key === "ArrowDown") {
      const first = searchResults?.querySelector("[data-openwiki-graph-match]");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  searchResults?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-openwiki-graph-match]") : undefined;
    if (!button) return;
    focusGraphSearchMatch(state, button.dataset.graphMatchId, render);
  });
  searchResults?.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const buttons = Array.from(searchResults.querySelectorAll("[data-openwiki-graph-match]"));
    const index = buttons.indexOf(event.target.closest("[data-openwiki-graph-match]"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === "Escape") {
      search?.focus();
      searchResults.hidden = true;
    }
  });
  depthControl?.addEventListener("change", () => {
    state.depth = clamp(Number(depthControl.value) || 1, 1, 3);
    refreshGraphState(state);
    renderGraphControls(state);
    updateGraphUrlState(state);
    render();
    scheduleGraphLayout(state, render);
  });
  nodeLegend?.addEventListener("click", (event) => handleGraphLegendClick(event, state, "node", render));
  edgeLegend?.addEventListener("click", (event) => handleGraphLegendClick(event, state, "edge", render));
  orphanToggle?.addEventListener("change", () => {
    state.showOrphans = orphanToggle.checked;
    refreshGraphState(state);
    renderGraphControls(state);
    updateGraphUrlState(state);
    fitGraph(state);
    render();
    scheduleGraphLayout(state, render);
  });
  scopeControls.forEach((button) => {
    button.addEventListener("click", () => {
      const requestedScope = button.dataset.openwikiGraphScope === "neighborhood" ? "neighborhood" : "all";
      if (state.mode === "local" && requestedScope === "all") {
        return;
      }
      state.graphScope = requestedScope;
      if (state.graphScope === "neighborhood" && !state.focusId) {
        const firstNode = state.nodes[0] || state.rawGraph.nodes?.[0];
        if (firstNode) {
          selectGraphNode(state, firstNode);
        }
      }
      refreshGraphState(state);
      renderGraphControls(state);
      updateGraphUrlState(state);
      fitGraph(state);
      render();
      scheduleGraphLayout(state, render);
    });
  });
  zoomControls.forEach((button) => {
    button.addEventListener("click", () => {
      const rect = state.canvas.getBoundingClientRect();
      zoomGraphAt(state, rect.width / 2, rect.height / 2, button.dataset.openwikiGraphZoom === "out" ? 0.85 : 1.18);
      render();
    });
  });
  fit?.addEventListener("click", () => {
    fitGraph(state);
    render();
  });
  reset?.addEventListener("click", () => {
    resetGraphView(state);
    refreshGraphState(state);
    if (depthControl) depthControl.value = String(state.depth);
    if (orphanToggle) orphanToggle.checked = state.showOrphans;
    renderGraphControls(state);
    updateGraphUrlState(state);
    fitGraph(state);
    render();
    scheduleGraphLayout(state, render);
  });
  fullscreen?.addEventListener("click", () => {
    if (document.fullscreenElement === graphElement) {
      document.exitFullscreen?.();
    } else {
      graphElement.requestFullscreen?.();
    }
  });
  detail?.addEventListener("click", (event) => {
    const action = event.target instanceof Element ? event.target.closest("[data-openwiki-graph-action]") : undefined;
    if (!action) return;
    if (action.tagName !== "A") {
      event.preventDefault();
    }
    handleGraphDetailAction(state, action.dataset.openwikiGraphAction, action.dataset.graphNodeId, render);
  });
  nodeList?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-openwiki-graph-node-option]") : undefined;
    if (!button) return;
    const node = state.nodes.find((candidate) => candidate.id === button.dataset.graphNodeId);
    if (!node) return;
    selectGraphNode(state, node);
    centerGraphOnNode(state, node);
    updateGraphUrlState(state);
    render();
  });
  nodeList?.addEventListener("keydown", (event) => {
    handleGraphNodeListKeydown(event, state, (node) => {
      selectGraphNode(state, node);
      centerGraphOnNode(state, node);
      updateGraphUrlState(state);
      render();
    });
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.9;
    zoomGraphAt(state, event.offsetX, event.offsetY, factor);
    render();
  }, { passive: false });
  canvas.addEventListener("pointermove", (event) => {
    const pointer = screenToWorld(state, event.offsetX, event.offsetY);
    if (state.dragNode) {
      state.dragNode.x = pointer.x;
      state.dragNode.y = pointer.y;
      render();
      return;
    }
    if (state.panning) {
      state.tx += event.clientX - state.lastX;
      state.ty += event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      render();
      return;
    }
    const hover = nearestNode(state, pointer.x, pointer.y);
    if (hover?.id !== state.hoverNode?.id) {
      state.hoverNode = hover;
      canvas.style.cursor = hover ? "pointer" : "grab";
      render();
    }
  });
  canvas.addEventListener("pointerdown", (event) => {
    const pointer = screenToWorld(state, event.offsetX, event.offsetY);
    const node = nearestNode(state, pointer.x, pointer.y);
    canvas.setPointerCapture(event.pointerId);
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.pointerDownX = event.clientX;
    state.pointerDownY = event.clientY;
    if (node) {
      state.dragNode = node;
      state.hoverNode = node;
      canvas.style.cursor = "grabbing";
    } else {
      state.panning = true;
      canvas.style.cursor = "grabbing";
    }
  });
  canvas.addEventListener("pointerup", (event) => {
    canvas.releasePointerCapture?.(event.pointerId);
    const dragged = state.dragNode;
    const moved = Math.hypot(event.clientX - state.pointerDownX, event.clientY - state.pointerDownY);
    state.dragNode = undefined;
    state.panning = false;
    canvas.style.cursor = state.hoverNode ? "pointer" : "grab";
    if (dragged && moved >= 3) {
      state.pinnedNodeIds.add(dragged.id);
      updatePinnedGraphState(state);
      render();
      scheduleGraphLayout(state, render);
      return;
    }
    if (dragged && moved < 3) {
      const href = recordHref(dragged);
      if ((event.metaKey || event.ctrlKey) && href && href !== "#") {
        window.location.href = href;
        return;
      }
      if (state.mode === "global") {
        const keepViewport = state.selectedNodeId === dragged.id || state.pinnedNodeIds.has(dragged.id);
        state.graphScope = "neighborhood";
        state.focusId = dragged.id;
        state.selectedNodeId = dragged.id;
        refreshGraphState(state);
        renderGraphControls(state);
        if (!keepViewport) {
          centerGraphOnNode(state, state.nodes.find((node) => node.id === dragged.id) || dragged);
        }
        updateGraphUrlState(state);
        scheduleGraphLayout(state, render);
        expandGraphNode(state, dragged.id, render);
      } else {
        if (href && href !== "#") window.location.href = href;
      }
    }
    render();
  });
  canvas.addEventListener("pointerleave", () => {
    state.hoverNode = undefined;
    state.dragNode = undefined;
    state.panning = false;
    canvas.style.cursor = "grab";
    render();
  });
  canvas.addEventListener("click", (event) => {
    if (event.detail >= 2) {
      handleGraphDoubleClick(state, event, render);
    }
  });
  canvas.addEventListener("dblclick", (event) => {
    handleGraphDoubleClick(state, event, render);
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "f") {
      event.preventDefault();
      fitGraph(state);
      render();
    } else if (event.key === "r") {
      event.preventDefault();
      scheduleGraphLayout(state, render);
    } else if (event.key === "Escape") {
      state.hoverNode = undefined;
      state.selectedNodeId = undefined;
      render();
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      state.scale = clamp(state.scale * (event.key === "-" ? 0.9 : 1.12), 0.35, 3.5);
      render();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 80 : 32;
      if (event.key === "ArrowLeft") state.tx += step;
      if (event.key === "ArrowRight") state.tx -= step;
      if (event.key === "ArrowUp") state.ty += step;
      if (event.key === "ArrowDown") state.ty -= step;
      render();
    }
  });
}

function createGraphState(canvas, graphElement, graph) {
  const params = new URLSearchParams(window.location.search);
  const mode = graphElement.dataset.graphMode || "global";
  const focusId = graphElement.dataset.focusId || (mode === "global" ? params.get("focus") || undefined : undefined);
  const depth = clamp(Number(params.get("depth")) || 1, 1, 3);
  const showOrphans = params.get("orphans") !== "0";
  const graphScope = graphScopeFromParams(mode, focusId, params);
  const baseGraph = graphForMode(graph, mode, focusId, depth, graphScope);
  const visibleNodeTypes = parseGraphFilterParam(params, "types", "node_type");
  const visibleEdgeTypes = parseGraphFilterParam(params, "edge_types", "edge_type");
  const configuredMaxNodes = Number(graphElement.dataset.maxNodes);
  const state = {
    canvas,
    rawGraph: graph,
    baseGraph,
    nodes: [],
    edges: [],
    mode,
    graphScope,
    initialFocusId: focusId,
    focusId,
    scale: 1,
    tx: 0,
    ty: 0,
    dirtySize: true,
    hoverNode: undefined,
    selectedNodeId: focusId,
    dragNode: undefined,
    panning: false,
    lastX: 0,
    lastY: 0,
    pointerDownX: 0,
    pointerDownY: 0,
    pinnedNodeIds: new Set(),
    layoutRun: 0,
    layoutWorker: undefined,
    layoutWorkerUrl: undefined,
    themeKey: undefined,
    themeColors: new Map(),
    themeText: undefined,
    themeTextMuted: undefined,
    detail: undefined,
    searchControl: undefined,
    searchResults: undefined,
    nodeLegend: undefined,
    edgeLegend: undefined,
    scopeControls: [],
    nodeList: undefined,
    count: graphElement.querySelector("[data-openwiki-graph-count]"),
    neighborSrcTemplate: graphElement.dataset.graphNeighborSrc || "",
    expandedNodeIds: new Set(),
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
    depth,
    showOrphans,
    searchTerm: params.get("q")?.trim().toLowerCase() || "",
    visibleNodeTypes,
    visibleEdgeTypes,
    availableNodeTypes: uniqueGraphValues(baseGraph.nodes, "record_type"),
    availableEdgeTypes: uniqueGraphValues(baseGraph.edges, "edge_type"),
    maxNodes: Number.isFinite(configuredMaxNodes) && configuredMaxNodes > 0 ? configuredMaxNodes : defaultGraphMaxNodes(mode),
  };
  refreshGraphState(state);
  return state;
}

function graphScopeFromParams(mode, focusId, params) {
  if (mode === "local") {
    return "neighborhood";
  }
  const requested = params.get("scope");
  if (requested === "neighborhood" && focusId) {
    return "neighborhood";
  }
  if (requested === "all") {
    return "all";
  }
  return focusId ? "neighborhood" : "all";
}

function graphForMode(graph, mode, focusId, depth = 1, scope = "all") {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const shouldFilter = Boolean(focusId) && (mode === "local" || scope === "neighborhood");
  if (!shouldFilter) {
    return { nodes, edges };
  }
  const ids = new Set([focusId]);
  const localEdges = [];
  const localEdgeIds = new Set();
  let frontier = new Set([focusId]);
  for (let hop = 0; hop < depth; hop += 1) {
    const next = new Set();
    for (const edge of edges) {
      const touchesFrontier = frontier.has(edge.from_id) || frontier.has(edge.to_id);
      if (!touchesFrontier) continue;
      const edgeId = edge.id || `${edge.from_id}->${edge.to_id}:${edge.edge_type || ""}`;
      if (!localEdgeIds.has(edgeId)) {
        localEdgeIds.add(edgeId);
        localEdges.push(edge);
      }
      if (!ids.has(edge.from_id)) {
        ids.add(edge.from_id);
        next.add(edge.from_id);
      }
      if (!ids.has(edge.to_id)) {
        ids.add(edge.to_id);
        next.add(edge.to_id);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return { nodes: nodes.filter((node) => ids.has(node.id)), edges: localEdges };
}

function handleGraphDoubleClick(state, event, render) {
  event.preventDefault();
  const pointer = screenToWorld(state, event.offsetX, event.offsetY);
  const node = nearestNode(state, pointer.x, pointer.y);
  if (node) {
    if (state.pinnedNodeIds.has(node.id)) {
      state.pinnedNodeIds.delete(node.id);
      updatePinnedGraphState(state);
      scheduleGraphLayout(state, render);
    }
    selectGraphNode(state, node);
    updateGraphUrlState(state);
  } else {
    fitGraph(state);
  }
  render();
}

function handleGraphDetailAction(state, action, nodeId, render) {
  if (action === "focus") {
    const node = (state.rawGraph.nodes || []).find((candidate) => candidate.id === nodeId) || state.nodes.find((candidate) => candidate.id === nodeId);
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
    expandGraphNode(state, node.id, render);
  } else if (action === "all" && state.mode !== "local") {
    state.graphScope = "all";
    refreshGraphState(state);
    renderGraphControls(state);
    updateGraphUrlState(state);
    fitGraph(state);
    render();
    scheduleGraphLayout(state, render);
  }
}

async function expandGraphNode(state, nodeId, render) {
  if (!state.neighborSrcTemplate || state.mode === "local" || !nodeId || state.expandedNodeIds.has(nodeId)) {
    return;
  }
  state.expandedNodeIds.add(nodeId);
  try {
    const src = state.neighborSrcTemplate.replace("{id}", encodeURIComponent(nodeId));
    const payload = await fetchGraphPayload(src);
    mergeGraphPayload(state.rawGraph, payload);
    refreshGraphState(state);
    renderGraphControls(state);
    render();
    scheduleGraphLayout(state, render);
  } catch {
    state.expandedNodeIds.delete(nodeId);
  }
}

function mergeGraphPayload(target, payload) {
  const nodes = Array.isArray(target.nodes) ? target.nodes : [];
  const edges = Array.isArray(target.edges) ? target.edges : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id || `${edge.from_id}->${edge.to_id}:${edge.edge_type || ""}`));
  for (const node of payload.nodes || []) {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  }
  for (const edge of payload.edges || []) {
    const edgeId = edge.id || `${edge.from_id}->${edge.to_id}:${edge.edge_type || ""}`;
    if (!edgeIds.has(edgeId)) {
      edgeIds.add(edgeId);
      edges.push(edge);
    }
  }
  target.nodes = nodes;
  target.edges = edges;
}

function refreshGraphState(state) {
  if (state.mode === "local") {
    state.graphScope = "neighborhood";
  }
  state.baseGraph = graphForMode(state.rawGraph, state.mode, state.focusId, state.depth, state.graphScope);
  state.availableNodeTypes = uniqueGraphValues(state.baseGraph.nodes, "record_type");
  state.availableEdgeTypes = uniqueGraphValues(state.baseGraph.edges, "edge_type");
  const previousPositions = new Map(state.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  const baseDegree = graphDegree(state.baseGraph.edges);
  const nodeFiltered = state.baseGraph.nodes.filter((node) => {
    if (!state.showOrphans && (baseDegree.get(node.id) || 0) === 0) {
      return false;
    }
    return graphTypeVisible(state.visibleNodeTypes, node.record_type);
  });
  const nodeIds = new Set(nodeFiltered.map((node) => node.id));
  let edges = state.baseGraph.edges.filter((edge) => nodeIds.has(edge.from_id) && nodeIds.has(edge.to_id));
  if (state.visibleEdgeTypes) {
    edges = edges.filter((edge) => graphTypeVisible(state.visibleEdgeTypes, edge.edge_type));
  }
  const edgeIds = new Set(edges.flatMap((edge) => [edge.from_id, edge.to_id]));
  const visibleNodes = state.visibleEdgeTypes
    ? nodeFiltered.filter((node) => edgeIds.has(node.id) || node.id === state.focusId)
    : nodeFiltered;
  const limit = state.maxNodes;
  const limitedNodes = selectGraphNodes(visibleNodes, edges, state.focusId, limit);
  const limitedIds = new Set(limitedNodes.map((node) => node.id));
  state.nodes = layoutNodes({ nodes: limitedNodes, edges }, state.focusId, previousPositions);
  state.edges = edges.filter((edge) => limitedIds.has(edge.from_id) && limitedIds.has(edge.to_id));
  if (state.selectedNodeId && !limitedIds.has(state.selectedNodeId)) {
    state.selectedNodeId = state.focusId;
  }
  for (const pinnedId of Array.from(state.pinnedNodeIds)) {
    if (!limitedIds.has(pinnedId)) {
      state.pinnedNodeIds.delete(pinnedId);
    }
  }
  updatePinnedGraphState(state);
}

function selectGraphNodes(nodes, edges, focusId, limit) {
  const degree = graphDegree(edges);
  const sorted = nodes.slice().sort((left, right) => (degree.get(right.id) || 0) - (degree.get(left.id) || 0) || String(left.title).localeCompare(String(right.title)));
  const selected = sorted.slice(0, limit);
  if (focusId && !selected.some((node) => node.id === focusId)) {
    const focus = nodes.find((node) => node.id === focusId);
    if (focus) {
      selected.pop();
      selected.unshift(focus);
    }
  }
  return selected;
}

function defaultGraphMaxNodes(mode) {
  if (mode === "local") return 60;
  if (mode === "preview") return 180;
  return 1500;
}



function selectGraphNode(state, node) {
  state.focusId = node.id;
  state.selectedNodeId = node.id;
  if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
    centerGraphOnNode(state, node);
  }
}

function handleGraphLegendClick(event, state, expectedKind, render) {
  return handleGraphLegendClickImpl(event, state, expectedKind, render, refreshGraphState);
}

function focusGraphSearchMatch(state, id, render) {
  return focusGraphSearchMatchImpl(state, id, render, selectGraphNode, refreshGraphState);
}
