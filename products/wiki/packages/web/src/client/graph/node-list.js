import { escapeAttr, escapeHtml, graphDegree, graphValueLabel } from "./utils.js";

export function updateGraphNodeList(state) {
  if (!state.nodeList) return;
  if (state.nodes.length === 0) {
    state.nodeList.innerHTML = '<p class="ow-muted">No visible graph nodes.</p>';
    return;
  }
  const degree = graphDegree(state.edges);
  state.nodeList.innerHTML = state.nodes
    .slice()
    .sort((left, right) => String(left.title || left.id).localeCompare(String(right.title || right.id)))
    .map((node, index) => {
      const selected = node.id === state.selectedNodeId || node.id === state.focusId;
      return `<button type="button" data-openwiki-graph-node-option data-graph-node-id="${escapeAttr(node.id)}" role="option" aria-selected="${selected ? "true" : "false"}" tabindex="${selected || (!state.selectedNodeId && index === 0) ? "0" : "-1"}"><strong>${escapeHtml(node.title || node.id)}</strong><span>${escapeHtml(graphValueLabel(node.record_type || "record"))} · ${escapeHtml(String(degree.get(node.id) || 0))} links</span></button>`;
    })
    .join("");
}

export function handleGraphNodeListKeydown(event, state, selectNode) {
  if (!(event.target instanceof Element)) return;
  const buttons = Array.from(state.nodeList?.querySelectorAll("[data-openwiki-graph-node-option]") || []);
  if (buttons.length === 0) return;
  const current = event.target.closest("[data-openwiki-graph-node-option]");
  const index = Math.max(0, buttons.indexOf(current));
  let nextIndex;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % buttons.length;
  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = buttons.length - 1;
  else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const node = state.nodes.find((candidate) => candidate.id === current?.dataset.graphNodeId);
    if (!node) return;
    selectNode(node);
    return;
  } else return;
  event.preventDefault();
  const next = buttons[nextIndex];
  buttons.forEach((button) => button.setAttribute("tabindex", button === next ? "0" : "-1"));
  next?.focus();
}
