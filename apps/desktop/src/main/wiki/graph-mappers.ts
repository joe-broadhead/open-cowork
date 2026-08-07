import type {
  WikiGraph,
  WikiGraphEdge,
  WikiGraphEdgeType,
  WikiGraphNeighbors,
  WikiGraphNode,
} from '@open-cowork/shared'

/** Map an OpenWiki graph node record (CLI JSON or HTTP API) to the shared type. */
export function graphNode(raw: Record<string, unknown>): WikiGraphNode {
  return {
    id: String(raw.id ?? ''),
    recordType: String(raw.record_type ?? ''),
    title: String(raw.title ?? ''),
    ...(raw.path !== undefined && raw.path !== null ? { path: String(raw.path) } : {}),
    ...(raw.status !== undefined && raw.status !== null ? { status: String(raw.status) } : {}),
    ...(raw.summary !== undefined && raw.summary !== null ? { summary: String(raw.summary) } : {}),
  }
}

/** Map an OpenWiki graph edge record to the shared type. */
export function graphEdge(raw: Record<string, unknown>): WikiGraphEdge {
  return {
    fromId: String(raw.from_id ?? ''),
    toId: String(raw.to_id ?? ''),
    edgeType: String(raw.edge_type ?? '') as WikiGraphEdgeType,
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
    ...(raw.path !== undefined && raw.path !== null ? { path: String(raw.path) } : {}),
    ...(raw.anchor !== undefined && raw.anchor !== null ? { anchor: String(raw.anchor) } : {}),
  }
}

/** Map `{ nodes, edges }` (graph index response) to the shared graph type. */
export function mapGraphIndex(raw: unknown): WikiGraph {
  const obj = (raw ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as Array<Record<string, unknown>>).map(graphNode) : []
  const edges = Array.isArray(obj.edges) ? (obj.edges as Array<Record<string, unknown>>).map(graphEdge) : []
  return { nodes, edges }
}

/** Map a neighborhood response (`root_id/depth/direction` + nodes/edges). */
export function mapGraphNeighbors(raw: unknown): WikiGraphNeighbors {
  const obj = (raw ?? {}) as Record<string, unknown>
  return {
    rootId: String(obj.root_id ?? ''),
    depth: typeof obj.depth === 'number' ? obj.depth : 1,
    direction: (String(obj.direction ?? 'both') as WikiGraphNeighbors['direction']),
    nodes: Array.isArray(obj.nodes) ? (obj.nodes as Array<Record<string, unknown>>).map(graphNode) : [],
    edges: Array.isArray(obj.edges) ? (obj.edges as Array<Record<string, unknown>>).map(graphEdge) : [],
  }
}
