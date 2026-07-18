import path from "node:path";
import type { GraphIndexResponse, GraphNodeRecord } from "@openwiki/core";

import { renderRecordList } from "./components.ts";

export function safeExternalHref(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function pageRoute(id: string): string {
  const [, pageType, ...slugParts] = id.split(":");
  const slug = slugParts.join(":") || id;
  return [pluralizeRoutePart(pageType ?? "page"), slug].join("/");
}

export function recordRoute(id: string): string {
  const [kind = "record", ...parts] = id.split(":");
  return [pluralizeRoutePart(kind), parts.join(":") || id].join("/");
}

function htmlRouteForRecord(id: string): string {
  return `${id.startsWith("page:") ? pageRoute(id) : recordRoute(id)}.html`;
}

export function relativePrefix(fromFile: string): string {
  const dir = path.posix.dirname(fromFile);
  if (dir === "." || dir === "") {
    return "";
  }
  return dir.split("/").map(() => "../").join("");
}

export function relativeHref(fromFile: string, targetFile: string): string {
  return `${relativePrefix(fromFile)}${targetFile}`.replace(/^\.\//, "");
}

export function graphTextFallback(graph: GraphIndexResponse, limit = 12): string {
  const degree = graphDegree(graph);
  const nodes = [...graph.nodes]
    .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.title.localeCompare(right.title))
    .slice(0, limit);
  return renderRecordList(nodes.map((node) => ({ title: node.title, href: recordHrefForGraphNode(node), type: node.record_type, summary: node.summary ?? node.id })), "No graph nodes found.");
}

function recordHrefForGraphNode(node: GraphNodeRecord): string | undefined {
  if (["page", "source", "claim", "proposal", "decision"].includes(node.record_type)) {
    return htmlRouteForRecord(node.id);
  }
  return undefined;
}

function graphDegree(graph: GraphIndexResponse): Map<string, number> {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1);
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1);
  }
  return degree;
}

function pluralizeRoutePart(value: string): string {
  if (value === "entity") return "entities";
  return value.endsWith("s") ? value : `${value}s`;
}
