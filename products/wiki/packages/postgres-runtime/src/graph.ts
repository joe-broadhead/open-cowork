import { parseJsonObject, runtimeRecordFromJson } from "./records.ts";
import { type ClaimRecord, compareGraphNodes, fallbackGraphNode, type GraphEdgeRecord, type GraphIndexResponse, type GraphNeighborhoodResponse, type GraphNodeRecord, type GraphOrphansResponse, graphPathFromIndex, type GraphPathResponse, type GraphStaleResponse, idToUri, type PageRecord } from "@openwiki/core";
import { appendGraphReason } from "@openwiki/repo";
import { postgresRuntimeReadEnabled } from "./config.ts";
import { dateStringField, numberField, stringField } from "./rows.ts";
import { openCurrentPostgresRuntime } from "./sync.ts";
import type { PostgresQuery } from "./types.ts";

export async function readCurrentPostgresGraph(root: string): Promise<GraphIndexResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    return await graphIndexFromPostgres(sql, workspaceId);
  } finally {
    await opened.close();
  }
}

export async function graphCurrentPostgresNeighbors(
  root: string,
  id: string,
  options: { direction?: "in" | "out" | "both"; depth?: number; limit?: number } = {},
): Promise<GraphNeighborhoodResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const direction = options.direction ?? "both";
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const selectedEdges: GraphEdgeRecord[] = [];
    const selectedEdgeIds = new Set<string>();
    const visited = new Set<string>([id]);
    let frontier = new Set<string>([id]);
    for (let level = 0; level < depth && frontier.size > 0 && selectedEdges.length < limit; level += 1) {
      const edgeRows = await boundedEdgeRowsForFrontier(sql, workspaceId, [...frontier], direction, limit - selectedEdges.length);
      const next = new Set<string>();
      for (const edge of edgeRows.map(graphEdgeFromRow)) {
        if (selectedEdgeIds.has(edge.id)) {
          continue;
        }
        selectedEdgeIds.add(edge.id);
        selectedEdges.push(edge);
        const outgoing = frontier.has(edge.from_id);
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
      nodes: await graphNodesById(sql, workspaceId, [...nodeIds]),
      edges: selectedEdges,
    };
  } finally {
    await opened.close();
  }
}

export async function graphCurrentPostgresPath(root: string, fromId: string, toId: string): Promise<GraphPathResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const selectedEdges: GraphEdgeRecord[] = [];
    const selectedEdgeIds = new Set<string>();
    const visited = new Set<string>([fromId]);
    let frontier = new Set<string>([fromId]);
    for (let level = 0; level < 6 && frontier.size > 0 && selectedEdges.length < 2000; level += 1) {
      const edgeRows = await boundedEdgeRowsForFrontier(sql, workspaceId, [...frontier], "both", Math.min(500, 2000 - selectedEdges.length));
      const next = new Set<string>();
      for (const edge of edgeRows.map(graphEdgeFromRow)) {
        if (!selectedEdgeIds.has(edge.id)) {
          selectedEdgeIds.add(edge.id);
          selectedEdges.push(edge);
        }
        const outgoing = frontier.has(edge.from_id);
        const incoming = frontier.has(edge.to_id);
        const candidates = [
          ...(outgoing ? [edge.to_id] : []),
          ...(incoming ? [edge.from_id] : []),
        ];
        for (const candidate of candidates) {
          if (!visited.has(candidate)) {
            visited.add(candidate);
            next.add(candidate);
          }
        }
      }
      frontier = next;
    }
    if (!visited.has(toId)) {
      return { from_id: fromId, to_id: toId, nodes: [], edges: [], found: false };
    }
    const nodeIds = new Set<string>([fromId, toId]);
    for (const edge of selectedEdges) {
      nodeIds.add(edge.from_id);
      nodeIds.add(edge.to_id);
    }
    return graphPathFromIndex({ nodes: await graphNodesById(sql, workspaceId, [...nodeIds]), edges: selectedEdges }, fromId, toId);
  } finally {
    await opened.close();
  }
}

export async function graphCurrentPostgresRelated(
  root: string,
  id: string,
  options: { limit?: number } = {},
): Promise<GraphNeighborhoodResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const directRows = await boundedEdgeRowsForFrontier(sql, workspaceId, [id], "both", limit);
    const directEdges = directRows.map(graphEdgeFromRow);
    const sharedHubs = directEdges
      .filter((edge) => edge.edge_type === "page_topic" || edge.edge_type === "page_source" || edge.edge_type === "page_claim")
      .map((edge) => (edge.from_id === id ? edge.to_id : edge.from_id));
    const hubRows = sharedHubs.length === 0
      ? []
      : await boundedEdgeRowsForFrontier(sql, workspaceId, sharedHubs, "both", Math.max(limit - directEdges.length, 0));
    const edgesById = new Map<string, GraphEdgeRecord>();
    for (const edge of [...directEdges, ...hubRows.map(graphEdgeFromRow)]) {
      if (edgesById.size >= limit) {
        break;
      }
      edgesById.set(edge.id, edge);
    }
    const edges = [...edgesById.values()];
    const nodeIds = new Set<string>([id]);
    for (const edge of edges) {
      nodeIds.add(edge.from_id);
      nodeIds.add(edge.to_id);
    }
    return {
      root_id: id,
      depth: 2,
      direction: "both",
      nodes: await graphNodesById(sql, workspaceId, [...nodeIds]),
      edges,
    };
  } finally {
    await opened.close();
  }
}

export async function graphCurrentPostgresOrphans(root: string): Promise<GraphOrphansResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT r.record_id, r.record_type, r.title, r.summary, r.path, r.status, r.uri
      FROM records r
      WHERE r.workspace_id = ${workspaceId}
        AND r.record_type = 'page'
        AND NOT EXISTS (
          SELECT 1
          FROM edges e
          WHERE e.workspace_id = r.workspace_id
            AND e.edge_type = 'page_link'
            AND e.from_id LIKE 'page:%'
            AND e.to_id LIKE 'page:%'
            AND (e.from_id = r.record_id OR e.to_id = r.record_id)
        )
      ORDER BY r.title ASC, r.record_id ASC
      LIMIT 1000
    `;
    const pages = rows.map(graphNodeFromRecordRow).sort(compareGraphNodes);
    return { pages, total: pages.length };
  } finally {
    await opened.close();
  }
}

export async function graphCurrentPostgresStale(root: string): Promise<GraphStaleResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const claimRows = await sql<Array<Record<string, unknown>>>`
      SELECT json
      FROM records
      WHERE workspace_id = ${workspaceId}
        AND record_type = 'claim'
        AND status IN ('stale', 'disputed')
      ORDER BY updated_at DESC, record_id ASC
      LIMIT 1000
    `;
    const staleClaims = claimRows.map((row) => runtimeRecordFromJson<ClaimRecord>(row.json, "claim"));
    const staleClaimsById = new Map(staleClaims.map((claim) => [claim.id, claim]));
    const stalePageReasons = new Map<string, string[]>();
    const nodesById = new Map<string, GraphNodeRecord>();
    const missingSourceRows = await sql<Array<Record<string, unknown>>>`
      SELECT record_id, record_type, title, summary, path, status, uri
      FROM records
      WHERE workspace_id = ${workspaceId}
        AND record_type = 'page'
        AND jsonb_array_length(COALESCE(json->'source_ids', '[]'::jsonb)) = 0
      ORDER BY title ASC, record_id ASC
      LIMIT 1000
    `;
    for (const row of missingSourceRows) {
      const node = graphNodeFromRecordRow(row);
      nodesById.set(node.id, node);
      appendGraphReason(stalePageReasons, node.id, "missing_sources");
    }
    const claimPageIds = [...new Set(staleClaims.map((claim) => claim.page_id).filter((id) => id.trim().length > 0))].sort();
    if (claimPageIds.length > 0) {
      const pageRows = await sql<Array<Record<string, unknown>>>`
        SELECT record_id, record_type, title, summary, path, status, uri
        FROM records
        WHERE workspace_id = ${workspaceId}
          AND record_type = 'page'
          AND record_id IN ${sql(claimPageIds)}
        ORDER BY title ASC, record_id ASC
        LIMIT 1000
      `;
      for (const row of pageRows) {
        const node = graphNodeFromRecordRow(row);
        nodesById.set(node.id, node);
      }
    }
    const staleClaimIds = [...new Set(staleClaims.map((claim) => claim.id).filter((id) => id.trim().length > 0))].sort();
    if (staleClaimIds.length > 0) {
      const pageRows = await sql<Array<Record<string, unknown>>>`
        SELECT record_id, record_type, title, summary, path, status, uri, json
        FROM records AS r
        WHERE r.workspace_id = ${workspaceId}
          AND r.record_type = 'page'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(r.json->'claim_ids', '[]'::jsonb)) AS claim_id(value)
            WHERE claim_id.value IN ${sql(staleClaimIds)}
          )
        ORDER BY r.title ASC, r.record_id ASC
        LIMIT 1000
      `;
      for (const row of pageRows) {
        const node = graphNodeFromRecordRow(row);
        const page = runtimeRecordFromJson<PageRecord>(row.json, "page");
        nodesById.set(node.id, node);
        for (const claimId of page.claim_ids) {
          const claim = staleClaimsById.get(claimId);
          if (claim?.status === "stale") {
            appendGraphReason(stalePageReasons, page.id, "stale_claim");
          }
          if (claim?.status === "disputed") {
            appendGraphReason(stalePageReasons, page.id, "disputed_claim");
          }
        }
      }
    }
    for (const claim of staleClaims) {
      if (claim.status === "stale") {
        appendGraphReason(stalePageReasons, claim.page_id, "stale_claim");
      }
      if (claim.status === "disputed") {
        appendGraphReason(stalePageReasons, claim.page_id, "disputed_claim");
      }
    }
    const stalePages = [...stalePageReasons.entries()]
      .map(([pageId, reasons]) => ({ ...(nodesById.get(pageId) ?? fallbackGraphNode(pageId)), reasons }))
      .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    return { pages: stalePages, claims: staleClaims, total: stalePages.length + staleClaims.length };
  } finally {
    await opened.close();
  }
}

async function graphIndexFromPostgres(sql: PostgresQuery, workspaceId: string): Promise<GraphIndexResponse> {
  const nodeRows = await sql<Array<Record<string, unknown>>>`
    SELECT record_id, record_type, title, summary, path, status, uri
    FROM records
    WHERE workspace_id = ${workspaceId}
    ORDER BY record_type, record_id
  `;
  const edgeRows = await sql<Array<Record<string, unknown>>>`
    SELECT *
    FROM edges
    WHERE workspace_id = ${workspaceId}
    ORDER BY edge_type, from_id, to_id, edge_id
  `;
  return {
    nodes: nodeRows.map(graphNodeFromRecordRow),
    edges: edgeRows.map(graphEdgeFromRow),
  };
}

async function boundedEdgeRowsForFrontier(
  sql: PostgresQuery,
  workspaceId: string,
  frontierIds: string[],
  direction: "in" | "out" | "both",
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const ids = [...new Set(frontierIds.filter((id) => id.trim().length > 0))].sort();
  if (ids.length === 0 || limit <= 0) {
    return [];
  }
  if (direction === "out") {
    return sql<Array<Record<string, unknown>>>`
      SELECT *
      FROM edges
      WHERE workspace_id = ${workspaceId} AND from_id IN ${sql(ids)}
      ORDER BY edge_type, from_id, to_id, edge_id
      LIMIT ${limit}
    `;
  }
  if (direction === "in") {
    return sql<Array<Record<string, unknown>>>`
      SELECT *
      FROM edges
      WHERE workspace_id = ${workspaceId} AND to_id IN ${sql(ids)}
      ORDER BY edge_type, from_id, to_id, edge_id
      LIMIT ${limit}
    `;
  }
  return sql<Array<Record<string, unknown>>>`
    SELECT *
    FROM edges
    WHERE workspace_id = ${workspaceId} AND (from_id IN ${sql(ids)} OR to_id IN ${sql(ids)})
    ORDER BY edge_type, from_id, to_id, edge_id
    LIMIT ${limit}
  `;
}

async function graphNodesById(sql: PostgresQuery, workspaceId: string, ids: string[]): Promise<GraphNodeRecord[]> {
  const nodeIds = [...new Set(ids.filter((id) => id.trim().length > 0))].sort();
  if (nodeIds.length === 0) {
    return [];
  }
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT record_id, record_type, title, summary, path, status, uri
    FROM records
    WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(nodeIds)}
    ORDER BY record_type, title, record_id
  `;
  const nodesById = new Map(rows.map((row) => {
    const node = graphNodeFromRecordRow(row);
    return [node.id, node] as const;
  }));
  return nodeIds.map((nodeId) => nodesById.get(nodeId) ?? fallbackGraphNode(nodeId)).sort(compareGraphNodes);
}

export function graphNodeFromRecordRow(row: Record<string, unknown>): GraphNodeRecord {
  const id = stringField(row, "record_id") ?? "";
  const rowPath = stringField(row, "path");
  const status = stringField(row, "status");
  const summary = stringField(row, "summary");
  return {
    id,
    uri: stringField(row, "uri") ?? idToUri(id),
    record_type: stringField(row, "record_type") ?? "record",
    title: stringField(row, "title") ?? id,
    ...(rowPath === undefined ? {} : { path: rowPath }),
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
    created_at: dateStringField(row, "created_at") ?? "",
    metadata: parseJsonObject(row.metadata),
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
