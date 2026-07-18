import { escapeAttr, escapeHtml, graphValueLabel, recordHref } from "./utils.js";

function updateGraphDetail(state) {
  if (!state.detail) return;
  const node = state.hoverNode || state.nodes.find((candidate) => candidate.id === state.selectedNodeId) || state.nodes.find((candidate) => candidate.id === state.focusId);
  if (!node) {
    state.detail.innerHTML = '<h3>Graph Detail</h3><p class="ow-muted">Select or hover a node to inspect its neighborhood.</p>';
    return;
  }
  const neighbors = [];
  for (const edge of state.edges) {
    const neighborId = edge.from_id === node.id ? edge.to_id : edge.to_id === node.id ? edge.from_id : undefined;
    if (!neighborId) continue;
    const neighbor = state.nodes.find((candidate) => candidate.id === neighborId);
    if (neighbor) {
      neighbors.push({ node: neighbor, edgeType: edge.edge_type });
    }
  }
  const href = recordHref(node);
  const groupedNeighbors = neighbors.reduce((groups, entry) => {
    const key = entry.edgeType || "related";
    const values = groups.get(key) || [];
    values.push(entry.node);
    groups.set(key, values);
    return groups;
  }, new Map());
  const neighborList = neighbors.length === 0
    ? '<p class="ow-muted">No visible neighbors in the current filter.</p>'
    : Array.from(groupedNeighbors.entries()).slice(0, 5).map(([edgeType, entries]) => `<h4>${escapeHtml(graphValueLabel(edgeType))}</h4><ul>${entries.slice(0, 6).map((entry) => {
      const neighborHref = recordHref(entry);
      const label = escapeHtml(entry.title || entry.id);
      return `<li><span class="ow-graph__node-type">${escapeHtml(graphValueLabel(entry.record_type || "record"))}</span> ${neighborHref && neighborHref !== "#" ? `<a href="${escapeAttr(neighborHref)}">${label}</a>` : label}</li>`;
    }).join("")}</ul>`).join("");
  state.detail.innerHTML = `<div class="ow-graph__detail-head">
      <div>
        <span class="ow-graph__node-type">${escapeHtml(graphValueLabel(node.record_type || "record"))}</span>
        <h3>${escapeHtml(node.title || node.id)}</h3>
      </div>
      <span>${escapeHtml(String(node.degree || neighbors.length))} links</span>
    </div>
    <div class="ow-graph__detail-actions">
      ${href && href !== "#" ? `<a class="button secondary" href="${escapeAttr(href)}" data-openwiki-graph-action="open" data-graph-node-id="${escapeAttr(node.id)}">Open record</a>` : ""}
      <button type="button" class="secondary" data-openwiki-graph-action="focus" data-graph-node-id="${escapeAttr(node.id)}">Focus neighborhood</button>
      ${state.mode !== "local" && state.graphScope === "neighborhood" ? '<button type="button" class="secondary" data-openwiki-graph-action="all">Show all</button>' : ""}
    </div>
    ${neighborList}`;
}

export { updateGraphDetail };
