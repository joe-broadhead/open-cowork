import { parseJsonObject } from "./records.ts";
import { type ClaimRecord, compareGraphNodes, fallbackGraphNode, type GraphEdgeRecord, type GraphIndexResponse, type GraphNeighborhoodResponse, type GraphNodeRecord, type GraphOrphansResponse, graphPathFromIndex, type GraphPathResponse, type GraphStaleResponse, idToUri, type PageRecord } from "@openwiki/core";
import { appendGraphReason } from "@openwiki/repo";
import { DatabaseSync } from "node:sqlite";
import { openCurrentIndexStore, recordsFromIndexStore } from "./queries.ts";
import { numberField, stringField } from "./rows.ts";

export async function readCurrentIndexStoreGraph(root: string): Promise<GraphIndexResponse | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    return graphIndexFromDb(db);
  } finally {
    db.close();
  }
}

export async function graphCurrentIndexStoreNeighbors(
  root: string,
  id: string,
  options: { direction?: "in" | "out" | "both"; depth?: number; limit?: number } = {},
): Promise<GraphNeighborhoodResponse | undefined> {
  const graph = await readCurrentIndexStoreGraph(root);
  return graph === undefined ? undefined : graphNeighborsFromIndex(graph, id, options);
}

export async function graphCurrentIndexStorePath(root: string, fromId: string, toId: string): Promise<GraphPathResponse | undefined> {
  const graph = await readCurrentIndexStoreGraph(root);
  return graph === undefined ? undefined : graphPathFromIndex(graph, fromId, toId);
}

export async function graphCurrentIndexStoreRelated(
  root: string,
  id: string,
  options: { limit?: number } = {},
): Promise<GraphNeighborhoodResponse | undefined> {
  const graph = await readCurrentIndexStoreGraph(root);
  return graph === undefined ? undefined : graphRelatedFromIndex(graph, id, options);
}

export async function graphCurrentIndexStoreOrphans(root: string): Promise<GraphOrphansResponse | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    return graphOrphansFromDb(db);
  } finally {
    db.close();
  }
}

export async function graphCurrentIndexStoreStale(root: string): Promise<GraphStaleResponse | undefined> {
  const db = await openCurrentIndexStore(root);
  if (!db) {
    return undefined;
  }
  try {
    return graphStaleFromDb(db);
  } finally {
    db.close();
  }
}

function graphIndexFromDb(db: DatabaseSync): GraphIndexResponse {
  const nodeRows = db
    .prepare("SELECT record_id, record_type, title, summary, path, status, uri FROM records ORDER BY record_type, record_id")
    .all() as Array<Record<string, unknown>>;
  const edgeRows = db.prepare("SELECT * FROM edges ORDER BY edge_type, from_id, to_id, edge_id").all() as Array<Record<string, unknown>>;
  return {
    nodes: nodeRows.map(graphNodeFromRecordRow),
    edges: edgeRows.map(graphEdgeFromRow),
  };
}

export function graphNodeFromRecordRow(row: Record<string, unknown>): GraphNodeRecord {
  const id = stringField(row, "record_id") ?? "";
  const pathValue = stringField(row, "path");
  const status = stringField(row, "status");
  const summary = stringField(row, "summary");
  return {
    id,
    uri: stringField(row, "uri") ?? idToUri(id),
    record_type: stringField(row, "record_type") ?? "record",
    title: stringField(row, "title") ?? id,
    ...(pathValue === undefined ? {} : { path: pathValue }),
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export function graphEdgeFromRow(row: Record<string, unknown>): GraphEdgeRecord {
  const edgeId = stringField(row, "edge_id") ?? "edge:unknown";
  const rowPath = stringField(row, "path");
  const anchor = stringField(row, "anchor");
  return {
    id: edgeId,
    uri: idToUri(edgeId),
    type: "edge",
    workspace_id: stringField(row, "workspace_id") ?? "workspace:unknown",
    from_id: stringField(row, "from_id") ?? "",
    to_id: stringField(row, "to_id") ?? "",
    edge_type: stringField(row, "edge_type") as GraphEdgeRecord["edge_type"],
    ...(rowPath === undefined ? {} : { path: rowPath }),
    ...(anchor === undefined ? {} : { anchor }),
    weight: numberField(row, "weight"),
    source_commit: stringField(row, "source_commit") ?? "",
    created_at: stringField(row, "created_at") ?? "",
    metadata: parseJsonObject(stringField(row, "metadata")),
  };
}

export function graphNeighborsFromIndex(
  index: GraphIndexResponse,
  id: string,
  options: { direction?: "in" | "out" | "both"; depth?: number; limit?: number } = {},
): GraphNeighborhoodResponse {
  const direction = options.direction ?? "both";
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
  const selectedEdges: GraphEdgeRecord[] = [];
  const selectedEdgeIds = new Set<string>();
  const visited = new Set<string>([id]);
  let frontier = new Set<string>([id]);
  for (let level = 0; level < depth && frontier.size > 0 && selectedEdges.length < limit; level += 1) {
    const next = new Set<string>();
    for (const edge of index.edges) {
      const outgoing = direction !== "in" && frontier.has(edge.from_id);
      const incoming = direction !== "out" && frontier.has(edge.to_id);
      if (!outgoing && !incoming) {
        continue;
      }
      if (selectedEdgeIds.has(edge.id)) {
        continue;
      }
      selectedEdgeIds.add(edge.id);
      selectedEdges.push(edge);
      const otherId = outgoing ? edge.to_id : edge.from_id;
      if (!visited.has(otherId)) {
        visited.add(otherId);
        next.add(otherId);
      }
      if (selectedEdges.length >= limit) {
        break;
      }
    }
    frontier = next;
  }
  const nodeIds = new Set<string>([id]);
  for (const edge of selectedEdges) {
    nodeIds.add(edge.from_id);
    nodeIds.add(edge.to_id);
  }
  return {
    root_id: id,
    depth,
    direction,
    nodes: [...nodeIds].map((nodeId) => nodesById.get(nodeId) ?? fallbackGraphNode(nodeId)).sort(compareGraphNodes),
    edges: selectedEdges,
  };
}

export function graphRelatedFromIndex(index: GraphIndexResponse, id: string, options: { limit?: number } = {}): GraphNeighborhoodResponse {
  const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const direct = index.edges.filter((edge) => edge.from_id === id || edge.to_id === id);
  const sharedHubs = new Set(
    direct
      .filter((edge) => edge.edge_type === "page_topic" || edge.edge_type === "page_source" || edge.edge_type === "page_claim")
      .map((edge) => (edge.from_id === id ? edge.to_id : edge.from_id)),
  );
  const relatedEdges = index.edges
    .filter((edge) => direct.includes(edge) || sharedHubs.has(edge.from_id) || sharedHubs.has(edge.to_id))
    .slice(0, limit);
  const nodeIds = new Set<string>([id]);
  for (const edge of relatedEdges) {
    nodeIds.add(edge.from_id);
    nodeIds.add(edge.to_id);
  }
  return {
    root_id: id,
    depth: 2,
    direction: "both",
    nodes: [...nodeIds].map((nodeId) => nodesById.get(nodeId) ?? fallbackGraphNode(nodeId)).sort(compareGraphNodes),
    edges: relatedEdges,
  };
}

function graphOrphansFromDb(db: DatabaseSync): GraphOrphansResponse {
  const graph = graphIndexFromDb(db);
  const linkedPageIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!isCanonicalPageToPageLinkEdge(edge)) {
      continue;
    }
    linkedPageIds.add(edge.from_id);
    linkedPageIds.add(edge.to_id);
  }
  const pages = graph.nodes
    .filter((node) => node.record_type === "page" && !linkedPageIds.has(node.id))
    .sort(compareGraphNodes);
  return { pages, total: pages.length };
}

function isCanonicalPageToPageLinkEdge(edge: GraphEdgeRecord): boolean {
  return edge.edge_type === "page_link" && edge.from_id.startsWith("page:") && edge.to_id.startsWith("page:");
}

function graphStaleFromDb(db: DatabaseSync): GraphStaleResponse {
  const graph = graphIndexFromDb(db);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pages = recordsFromIndexStore<PageRecord>(db, "page");
  const claims = recordsFromIndexStore<ClaimRecord>(db, "claim");
  const staleClaims = claims.filter((claim) => claim.status === "stale" || claim.status === "disputed");
  const claimsByPage = new Map<string, ClaimRecord[]>();
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  for (const claim of claims) {
    const current = claimsByPage.get(claim.page_id) ?? [];
    current.push(claim);
    claimsByPage.set(claim.page_id, current);
  }
  for (const page of pages) {
    for (const claimId of page.claim_ids) {
      const claim = claimsById.get(claimId);
      if (claim === undefined || claim.page_id === page.id) {
        continue;
      }
      const current = claimsByPage.get(page.id) ?? [];
      current.push(claim);
      claimsByPage.set(page.id, current);
    }
  }
  const stalePageReasons = new Map<string, string[]>();
  for (const page of pages) {
    if (page.source_ids.length === 0) {
      appendGraphReason(stalePageReasons, page.id, "missing_sources");
    }
    const pageClaims = claimsByPage.get(page.id) ?? [];
    if (pageClaims.some((claim) => claim.status === "stale")) {
      appendGraphReason(stalePageReasons, page.id, "stale_claim");
    }
    if (pageClaims.some((claim) => claim.status === "disputed")) {
      appendGraphReason(stalePageReasons, page.id, "disputed_claim");
    }
  }
  const stalePages = [...stalePageReasons.entries()]
    .map(([pageId, reasons]) => ({ ...(nodesById.get(pageId) ?? fallbackGraphNode(pageId)), reasons }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { pages: stalePages, claims: staleClaims, total: stalePages.length + staleClaims.length };
}
