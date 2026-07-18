import type { ClaimRecord } from "./records.ts";
import { idToUri } from "./ids.ts";

export type GraphEdgeType =
  | "page_link"
  | "page_typed_link"
  | "page_source"
  | "page_claim"
  | "claim_source"
  | "fact_subject"
  | "fact_page"
  | "fact_source"
  | "fact_claim"
  | "take_page"
  | "take_source"
  | "take_claim"
  | "proposal_target"
  | "decision_proposal"
  | "page_topic"
  | "page_section"
  | "source_relation";

export interface GraphEdgeRecord {
  id: string;
  uri: string;
  type: "edge";
  workspace_id: string;
  from_id: string;
  to_id: string;
  edge_type: GraphEdgeType;
  path?: string;
  anchor?: string;
  weight: number;
  source_commit?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface GraphNodeRecord {
  id: string;
  uri: string;
  record_type: string;
  title: string;
  path?: string;
  status?: string;
  summary?: string;
}

export interface GraphIndexResponse {
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

export interface GraphNeighborhoodResponse extends GraphIndexResponse {
  root_id: string;
  depth: number;
  direction: "in" | "out" | "both";
}

export interface GraphPathResponse {
  from_id: string;
  to_id: string;
  found: boolean;
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

export interface GraphOrphansResponse {
  pages: GraphNodeRecord[];
  total: number;
}

export interface GraphStaleResponse {
  pages: Array<GraphNodeRecord & { reasons: string[] }>;
  claims: ClaimRecord[];
  total: number;
}

function appendGraphMap(map: Map<string, GraphEdgeRecord[]>, id: string, edge: GraphEdgeRecord): void {
  const edges = map.get(id) ?? [];
  edges.push(edge);
  map.set(id, edges);
}

export function compareGraphNodes(left: GraphNodeRecord, right: GraphNodeRecord): number {
  return left.record_type.localeCompare(right.record_type) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

export function fallbackGraphNode(id: string): GraphNodeRecord {
  return { id, uri: idToUri(id), record_type: id.split(":")[0] ?? "record", title: id };
}

export function graphPathFromIndex(index: GraphIndexResponse, fromId: string, toId: string): GraphPathResponse {
  const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphEdgeRecord[]>();
  for (const edge of index.edges) {
    appendGraphMap(adjacency, edge.from_id, edge);
    appendGraphMap(adjacency, edge.to_id, edge);
  }
  const queue = [fromId];
  const previous = new Map<string, { node: string; edge: GraphEdgeRecord }>();
  const visited = new Set<string>([fromId]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === toId) {
      break;
    }
    for (const edge of adjacency.get(current) ?? []) {
      const next = edge.from_id === current ? edge.to_id : edge.from_id;
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      previous.set(next, { node: current, edge });
      queue.push(next);
    }
  }
  if (!visited.has(toId)) {
    return { from_id: fromId, to_id: toId, found: false, nodes: [], edges: [] };
  }
  const edgePath: GraphEdgeRecord[] = [];
  const nodePath: string[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = previous.get(cursor);
    if (!step) {
      break;
    }
    edgePath.push(step.edge);
    cursor = step.node;
    nodePath.push(cursor);
  }
  nodePath.reverse();
  edgePath.reverse();
  return {
    from_id: fromId,
    to_id: toId,
    found: true,
    nodes: nodePath.map((nodeId) => nodesById.get(nodeId) ?? fallbackGraphNode(nodeId)),
    edges: edgePath,
  };
}
