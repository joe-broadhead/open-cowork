import { clamp, colorForEdge, nodeMatchesSearch } from "./utils.js";

function drawGraph(state) {
  const { canvas } = state;
  ensureGraphThemeCache(state);
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (state.dirtySize || canvas.width !== Math.max(rect.width * dpr, 1) || canvas.height !== Math.max(rect.height * dpr, 1)) {
    canvas.width = Math.max(rect.width * dpr, 1);
    canvas.height = Math.max(rect.height * dpr, 1);
    state.tx = rect.width / 2;
    state.ty = rect.height / 2;
    state.dirtySize = false;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const highlighted = highlightedGraphIds(state);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(state.tx, state.ty);
  ctx.scale(state.scale, state.scale);
  ctx.lineWidth = 1;
  state.edges.forEach((edge) => {
    const from = byId.get(edge.from_id);
    const to = byId.get(edge.to_id);
    if (!from || !to) return;
    const active = highlighted.size === 0 || highlighted.has(edge.from_id) && highlighted.has(edge.to_id);
    ctx.globalAlpha = active ? 0.72 : 0.12;
    ctx.strokeStyle = colorForEdge(edge.edge_type);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  });
  state.nodes.forEach((node) => {
    const r = Math.max(4, Math.min(18, 5 + Math.sqrt(node.degree + 1) * 2));
    const active = highlighted.size === 0 || highlighted.has(node.id);
    ctx.globalAlpha = active ? 1 : 0.22;
    ctx.beginPath();
    ctx.fillStyle = colorForGraphType(state, node.record_type);
    ctx.arc(node.x, node.y, node.id === state.focusId || node.id === state.hoverNode?.id || node.id === state.selectedNodeId ? r * 1.35 : r, 0, Math.PI * 2);
    ctx.fill();
    if (state.pinnedNodeIds.has(node.id)) {
      ctx.globalAlpha = active ? 1 : 0.26;
      ctx.strokeStyle = graphThemeText(state);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r * 1.65, 0, Math.PI * 2);
      ctx.stroke();
    }
    const labelDegree = width < 520 ? Number.POSITIVE_INFINITY : state.nodes.length > 900 ? 12 : state.nodes.length > 300 ? 7 : 1;
    if (node.degree > labelDegree || node.id === state.focusId || node.id === state.hoverNode?.id || node.id === state.selectedNodeId || nodeMatchesSearch(node, state.searchTerm)) {
      ctx.globalAlpha = active ? 1 : 0.18;
      ctx.fillStyle = graphThemeText(state);
      ctx.font = "11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(String(node.title || node.id).slice(0, 28), node.x, node.y + r + 13);
    }
  });
  ctx.restore();
  ctx.globalAlpha = 1;
  if (state.hoverNode) {
    ctx.fillStyle = graphThemeTextMuted(state);
    ctx.font = "12px system-ui";
    ctx.fillText(String(state.hoverNode.title || state.hoverNode.id).slice(0, 80), 14, height - 14);
  }
}

function colorForGraphType(state, type) {
  const key = String(type || "record");
  if (state.themeColors?.has(key)) {
    return state.themeColors.get(key);
  }
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue(`--ow-${key}`).trim() || styles.getPropertyValue("--ow-accent").trim() || "#6e8bff";
  state.themeColors?.set(key, color);
  return color;
}

function ensureGraphThemeCache(state) {
  const themeKey = document.documentElement.dataset.theme || "";
  if (state.themeKey === themeKey) {
    return;
  }
  state.themeKey = themeKey;
  state.themeColors?.clear();
  state.themeText = undefined;
  state.themeTextMuted = undefined;
}

function graphThemeText(state) {
  if (!state.themeText) {
    state.themeText = getComputedStyle(document.documentElement).getPropertyValue("--ow-text").trim() || "#e6edf3";
  }
  return state.themeText;
}

function graphThemeTextMuted(state) {
  if (!state.themeTextMuted) {
    state.themeTextMuted = getComputedStyle(document.documentElement).getPropertyValue("--ow-text-muted").trim() || "#9aa6b2";
  }
  return state.themeTextMuted;
}

function fitGraph(state) {
  const rect = state.canvas.getBoundingClientRect();
  if (!state.nodes.length) {
    state.scale = 1;
    state.tx = rect.width / 2;
    state.ty = rect.height / 2;
    return;
  }
  const xs = state.nodes.map((node) => Number(node.x) || 0);
  const ys = state.nodes.map((node) => Number(node.y) || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const graphWidth = Math.max(maxX - minX, 1);
  const graphHeight = Math.max(maxY - minY, 1);
  const padding = Math.min(96, Math.max(42, Math.min(rect.width, rect.height) * 0.12));
  const scaleX = (rect.width - padding * 2) / graphWidth;
  const scaleY = (rect.height - padding * 2) / graphHeight;
  state.scale = clamp(Math.min(scaleX, scaleY), 0.35, 1.45);
  state.tx = rect.width / 2 - ((minX + maxX) / 2) * state.scale;
  state.ty = rect.height / 2 - ((minY + maxY) / 2) * state.scale;
}

function zoomGraphAt(state, screenX, screenY, factor) {
  const point = screenToWorld(state, screenX, screenY);
  state.scale = clamp(state.scale * factor, 0.35, 3.5);
  state.tx = screenX - point.x * state.scale;
  state.ty = screenY - point.y * state.scale;
}

function resetGraphView(state) {
  const focusId = state.mode === "local" ? state.initialFocusId : undefined;
  state.focusId = focusId;
  state.selectedNodeId = focusId;
  state.hoverNode = undefined;
  state.searchTerm = "";
  state.visibleNodeTypes = undefined;
  state.visibleEdgeTypes = undefined;
  state.depth = 1;
  state.showOrphans = true;
  state.graphScope = state.mode === "local" ? "neighborhood" : "all";
  state.pinnedNodeIds.clear();
  if (state.searchControl) {
    state.searchControl.value = "";
  }
}

function centerGraphOnNode(state, node) {
  const rect = state.canvas.getBoundingClientRect();
  state.tx = rect.width / 2 - node.x * state.scale;
  state.ty = rect.height / 2 - node.y * state.scale;
}

function screenToWorld(state, x, y) {
  return { x: (x - state.tx) / state.scale, y: (y - state.ty) / state.scale };
}

function nearestNode(state, x, y) {
  let best;
  let bestDistance = Infinity;
  for (const node of state.nodes) {
    const r = Math.max(10, 7 + Math.sqrt(node.degree + 1) * 2);
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance < r && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function highlightedGraphIds(state) {
  const seed = state.hoverNode || state.nodes.find((node) => node.id === state.selectedNodeId);
  const searchIds = state.searchTerm ? state.nodes.filter((node) => nodeMatchesSearch(node, state.searchTerm)).map((node) => node.id) : [];
  if (!seed && searchIds.length === 0) return new Set();
  const ids = new Set(seed ? [seed.id] : searchIds);
  for (const edge of state.edges) {
    if (ids.has(edge.from_id)) ids.add(edge.to_id);
    if (ids.has(edge.to_id)) ids.add(edge.from_id);
  }
  return ids;
}

export { centerGraphOnNode, drawGraph, fitGraph, highlightedGraphIds, nearestNode, resetGraphView, screenToWorld, zoomGraphAt };
