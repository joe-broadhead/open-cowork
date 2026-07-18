function graphDegree(edges) {
  const degree = new Map();
  edges.forEach((edge) => {
    degree.set(edge.from_id, (degree.get(edge.from_id) || 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) || 0) + 1);
  });
  return degree;
}

function nodeMatchesSearch(node, term) {
  if (!term) return false;
  return `${node.title || ""} ${node.id || ""} ${node.record_type || ""}`.toLowerCase().includes(term);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashNumber(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorForType(type) {
  const styles = getComputedStyle(document.documentElement);
  return styles.getPropertyValue(`--ow-${type}`).trim() || styles.getPropertyValue("--ow-accent").trim() || "#6e8bff";
}

function colorForEdge(type) {
  if (String(type).includes("source")) return "rgba(49,185,112,.65)";
  if (String(type).includes("claim")) return "rgba(241,184,77,.65)";
  if (String(type).includes("proposal") || String(type).includes("decision")) return "rgba(184,143,255,.65)";
  return "rgba(154,167,180,.48)";
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

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function graphValueLabel(value) {
  return String(value || "record").replace(/_/g, " ");
}

export { clamp, colorForEdge, colorForType, escapeAttr, escapeHtml, graphDegree, graphValueLabel, hashNumber, nodeMatchesSearch, recordHref, safeExternalHref, sourceIdFromFragmentId };
