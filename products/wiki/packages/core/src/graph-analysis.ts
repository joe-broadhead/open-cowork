import type { GraphEdgeRecord, GraphEdgeType, GraphIndexResponse, GraphNodeRecord } from "./graph.ts";
import { uniqueStrings } from "./ids.ts";

export interface GraphAnalysisOptions {
  limit?: number;
  maxPeersPerSharedNode?: number;
}

export interface GraphNodeMetric {
  id: string;
  title: string;
  record_type: string;
  degree: number;
  in_degree: number;
  out_degree: number;
  weighted_degree: number;
  component_id: string;
  hub_rank?: number;
}

export interface GraphHubNode {
  id: string;
  title: string;
  record_type: string;
  degree: number;
  weighted_degree: number;
  reason_codes: string[];
}

export interface GraphComponentSummary {
  id: string;
  node_count: number;
  edge_count: number;
  top_node_ids: string[];
}

export interface GraphOrphanComponent {
  id: string;
  page_ids: string[];
  reason_codes: string[];
}

export interface GraphMissingLinkCandidate {
  from_id: string;
  to_id: string;
  score: number;
  shared_node_ids: string[];
  reason_codes: string[];
}

export interface GraphSurprisingConnection {
  edge_id: string;
  from_id: string;
  to_id: string;
  edge_type: GraphEdgeType;
  score: number;
  reason_codes: string[];
}

export interface GraphStaleHub {
  id: string;
  title: string;
  degree: number;
  stale_claim_ids: string[];
  disputed_claim_ids: string[];
  reason_codes: string[];
}

export interface GraphSourceCoverageGap {
  topic_id: string;
  topic: string;
  page_count: number;
  source_count: number;
  score: number;
  reason_codes: string[];
}

export interface GraphSuggestedQuestion {
  question: string;
  seed_node_ids: string[];
  reason_codes: string[];
}

export interface GraphAnalysisResponse {
  schema_version: "openwiki-graph-analysis-v1";
  node_count: number;
  edge_count: number;
  node_metrics: GraphNodeMetric[];
  hub_nodes: GraphHubNode[];
  components: GraphComponentSummary[];
  orphan_components: GraphOrphanComponent[];
  candidate_missing_links: GraphMissingLinkCandidate[];
  surprising_connections: GraphSurprisingConnection[];
  stale_hubs: GraphStaleHub[];
  source_coverage_gaps: GraphSourceCoverageGap[];
  suggested_questions: GraphSuggestedQuestion[];
}

const DEFAULT_GRAPH_ANALYSIS_LIMIT = 10;
const MAX_GRAPH_ANALYSIS_LIMIT = 100;
const DEFAULT_MAX_PEERS_PER_SHARED_NODE = 40;

export function analyzeGraph(index: GraphIndexResponse, options: GraphAnalysisOptions = {}): GraphAnalysisResponse {
  const limit = boundedAnalysisLimit(options.limit);
  const maxPeersPerSharedNode = boundedPeerLimit(options.maxPeersPerSharedNode);
  const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
  const metricsById = new Map<string, MutableGraphNodeMetric>();
  for (const node of index.nodes) {
    metricsById.set(node.id, {
      id: node.id,
      title: node.title,
      record_type: node.record_type,
      degree: 0,
      in_degree: 0,
      out_degree: 0,
      weighted_degree: 0,
      component_id: "",
    });
  }
  const pageLinkPairs = new Set<string>();
  const canonicalPageLinkPairs = new Set<string>();
  const incidentEdges = new Map<string, GraphEdgeRecord[]>();
  const edgeTypes = new Map<GraphEdgeType, number>();
  for (const edge of index.edges) {
    ensureMetric(metricsById, nodesById, edge.from_id).out_degree += 1;
    ensureMetric(metricsById, nodesById, edge.from_id).degree += 1;
    ensureMetric(metricsById, nodesById, edge.from_id).weighted_degree += edge.weight;
    ensureMetric(metricsById, nodesById, edge.to_id).in_degree += 1;
    ensureMetric(metricsById, nodesById, edge.to_id).degree += 1;
    ensureMetric(metricsById, nodesById, edge.to_id).weighted_degree += edge.weight;
    appendIncidentEdge(incidentEdges, edge.from_id, edge);
    appendIncidentEdge(incidentEdges, edge.to_id, edge);
    edgeTypes.set(edge.edge_type, (edgeTypes.get(edge.edge_type) ?? 0) + 1);
    if (isPageToPageLinkEdge(edge)) {
      pageLinkPairs.add(pairKey(edge.from_id, edge.to_id));
    }
    if (isCanonicalPageToPageLinkEdge(edge)) {
      canonicalPageLinkPairs.add(pairKey(edge.from_id, edge.to_id));
    }
  }

  const components = connectedComponents(index, metricsById);
  for (const component of components) {
    for (const nodeId of component.nodeIds) {
      const metric = metricsById.get(nodeId);
      if (metric) {
        metric.component_id = component.id;
      }
    }
  }

  const rankedMetrics = [...metricsById.values()].sort(compareMetricsForHubRank);
  rankedMetrics.forEach((metric, index) => {
    if (metric.degree > 0) {
      metric.hub_rank = index + 1;
    }
  });
  const nodeMetrics = rankedMetrics
    .slice(0, limit)
    .map((metric): GraphNodeMetric => ({
      ...metric,
      weighted_degree: roundScore(metric.weighted_degree),
    }));
  const hubNodes = rankedMetrics
    .filter((metric) => metric.degree > 0)
    .slice(0, limit)
    .map((metric): GraphHubNode => ({
      id: metric.id,
      title: metric.title,
      record_type: metric.record_type,
      degree: metric.degree,
      weighted_degree: roundScore(metric.weighted_degree),
      reason_codes: hubReasonCodes(metric, incidentEdges.get(metric.id) ?? []),
    }));
  const componentSummaries = components
    .map((component): GraphComponentSummary => ({
      id: component.id,
      node_count: component.nodeIds.length,
      edge_count: component.edgeCount,
      top_node_ids: component.nodeIds
        .map((id) => metricsById.get(id))
        .filter((metric): metric is MutableGraphNodeMetric => metric !== undefined)
        .sort(compareMetricsForHubRank)
        .slice(0, 5)
        .map((metric) => metric.id),
    }))
    .sort(compareComponents)
    .slice(0, limit);
  const orphanComponents = orphanPageComponents(components, metricsById, canonicalPageLinkPairs, limit);
  const candidateMissingLinks = missingLinkCandidates(index, nodesById, pageLinkPairs, limit, maxPeersPerSharedNode);
  const surprisingConnections = surprisingConnectionCandidates(index, nodesById, edgeTypes, limit);
  const staleHubs = staleHubCandidates(index, nodesById, metricsById, limit);
  const sourceCoverageGaps = sourceCoverageGapCandidates(index, nodesById, limit);
  const suggestedQuestions = suggestedGraphQuestions({
    hubNodes,
    orphanComponents,
    candidateMissingLinks,
    staleHubs,
    sourceCoverageGaps,
    nodesById,
    limit,
  });

  return {
    schema_version: "openwiki-graph-analysis-v1",
    node_count: metricsById.size,
    edge_count: index.edges.length,
    node_metrics: nodeMetrics,
    hub_nodes: hubNodes,
    components: componentSummaries,
    orphan_components: orphanComponents,
    candidate_missing_links: candidateMissingLinks,
    surprising_connections: surprisingConnections,
    stale_hubs: staleHubs,
    source_coverage_gaps: sourceCoverageGaps,
    suggested_questions: suggestedQuestions,
  };
}

interface MutableGraphNodeMetric extends GraphNodeMetric {
  component_id: string;
}

interface ComponentBuildState {
  id: string;
  nodeIds: string[];
  edgeCount: number;
}

function boundedAnalysisLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_GRAPH_ANALYSIS_LIMIT;
  }
  return Math.min(Math.max(Math.floor(limit), 1), MAX_GRAPH_ANALYSIS_LIMIT);
}

function boundedPeerLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_MAX_PEERS_PER_SHARED_NODE;
  }
  return Math.min(Math.max(Math.floor(limit), 2), 100);
}

function ensureMetric(
  metricsById: Map<string, MutableGraphNodeMetric>,
  nodesById: Map<string, GraphNodeRecord>,
  id: string,
): MutableGraphNodeMetric {
  const existing = metricsById.get(id);
  if (existing) {
    return existing;
  }
  const fallback = nodesById.get(id) ?? { id, title: id, record_type: id.split(":")[0] ?? "record" };
  const metric: MutableGraphNodeMetric = {
    id,
    title: fallback.title,
    record_type: fallback.record_type,
    degree: 0,
    in_degree: 0,
    out_degree: 0,
    weighted_degree: 0,
    component_id: "",
  };
  metricsById.set(id, metric);
  return metric;
}

function appendIncidentEdge(map: Map<string, GraphEdgeRecord[]>, id: string, edge: GraphEdgeRecord): void {
  const current = map.get(id) ?? [];
  current.push(edge);
  map.set(id, current);
}

function connectedComponents(
  index: GraphIndexResponse,
  metricsById: Map<string, MutableGraphNodeMetric>,
): ComponentBuildState[] {
  const adjacency = new Map<string, Set<string>>();
  for (const id of metricsById.keys()) {
    adjacency.set(id, new Set());
  }
  for (const edge of index.edges) {
    adjacency.set(edge.from_id, (adjacency.get(edge.from_id) ?? new Set()).add(edge.to_id));
    adjacency.set(edge.to_id, (adjacency.get(edge.to_id) ?? new Set()).add(edge.from_id));
  }
  const visited = new Set<string>();
  const components: ComponentBuildState[] = [];
  for (const start of [...metricsById.keys()].sort()) {
    if (visited.has(start)) {
      continue;
    }
    const queue = [start];
    const nodeIds: string[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      nodeIds.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        queue.push(next);
      }
    }
    nodeIds.sort();
    const nodeSet = new Set(nodeIds);
    const edgeCount = index.edges.filter((edge) => nodeSet.has(edge.from_id) && nodeSet.has(edge.to_id)).length;
    components.push({ id: componentId(nodeIds), nodeIds, edgeCount });
  }
  return components.sort(compareComponentBuildState);
}

function componentId(nodeIds: string[]): string {
  const seed = nodeIds.join("|");
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return `component:${hash.toString(16).padStart(8, "0")}`;
}

function hubReasonCodes(metric: GraphNodeMetric, edges: GraphEdgeRecord[]): string[] {
  const reasons = ["high_degree"];
  if (metric.in_degree > 0 && metric.out_degree > 0) {
    reasons.push("bridge_node");
  }
  if (edges.some((edge) => edge.edge_type === "page_source" || edge.edge_type === "claim_source")) {
    reasons.push("source_hub");
  }
  if (edges.some((edge) => edge.edge_type === "page_topic")) {
    reasons.push("topic_hub");
  }
  if (edges.some((edge) => edge.edge_type === "page_claim")) {
    reasons.push("claim_hub");
  }
  return reasons;
}

function orphanPageComponents(
  components: ComponentBuildState[],
  metricsById: Map<string, MutableGraphNodeMetric>,
  pageLinkPairs: Set<string>,
  limit: number,
): GraphOrphanComponent[] {
  return components
    .map((component): GraphOrphanComponent | undefined => {
      const pageIds = component.nodeIds
        .filter((id) => metricsById.get(id)?.record_type === "page")
        .filter((id) => !hasPageLink(id, pageLinkPairs))
        .sort();
      if (pageIds.length === 0) {
        return undefined;
      }
      return {
        id: component.id,
        page_ids: pageIds,
        reason_codes: ["no_page_links"],
      };
    })
    .filter((component): component is GraphOrphanComponent => component !== undefined)
    .sort((left, right) => right.page_ids.length - left.page_ids.length || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function hasPageLink(id: string, pageLinkPairs: Set<string>): boolean {
  for (const key of pageLinkPairs) {
    if (key.startsWith(`${id}\u0000`) || key.endsWith(`\u0000${id}`)) {
      return true;
    }
  }
  return false;
}

function isPageToPageLinkEdge(edge: GraphEdgeRecord): boolean {
  return (edge.edge_type === "page_link" || edge.edge_type === "page_typed_link") && edge.from_id.startsWith("page:") && edge.to_id.startsWith("page:");
}

function isCanonicalPageToPageLinkEdge(edge: GraphEdgeRecord): boolean {
  return edge.edge_type === "page_link" && edge.from_id.startsWith("page:") && edge.to_id.startsWith("page:");
}

function missingLinkCandidates(
  index: GraphIndexResponse,
  nodesById: Map<string, GraphNodeRecord>,
  pageLinkPairs: Set<string>,
  limit: number,
  maxPeersPerSharedNode: number,
): GraphMissingLinkCandidate[] {
  const pageIds = new Set([...nodesById.values()].filter((node) => node.record_type === "page").map((node) => node.id));
  const shared = new Map<string, { score: number; sharedNodeIds: string[]; reasonCodes: string[] }>();
  const sharedEdgeTypes: Array<{ edgeType: GraphEdgeType; reason: string; weight: number }> = [
    { edgeType: "page_topic", reason: "shared_topic", weight: 0.9 },
    { edgeType: "page_source", reason: "shared_source", weight: 0.8 },
    { edgeType: "page_claim", reason: "shared_claim", weight: 0.7 },
  ];
  for (const item of sharedEdgeTypes) {
    const pagesBySharedNode = new Map<string, string[]>();
    for (const edge of index.edges) {
      if (edge.edge_type !== item.edgeType || !pageIds.has(edge.from_id)) {
        continue;
      }
      pagesBySharedNode.set(edge.to_id, [...(pagesBySharedNode.get(edge.to_id) ?? []), edge.from_id]);
    }
    for (const [sharedNodeId, ids] of pagesBySharedNode.entries()) {
      const sorted = uniqueStrings(ids).sort().slice(0, maxPeersPerSharedNode);
      for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
        const left = sorted[leftIndex];
        if (left === undefined) {
          continue;
        }
        for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
          const right = sorted[rightIndex];
          if (right === undefined || pageLinkPairs.has(pairKey(left, right))) {
            continue;
          }
          const key = pairKey(left, right);
          const current = shared.get(key) ?? { score: 0, sharedNodeIds: [], reasonCodes: [] };
          current.score += item.weight;
          current.sharedNodeIds.push(sharedNodeId);
          current.reasonCodes.push(item.reason);
          shared.set(key, current);
        }
      }
    }
  }
  return [...shared.entries()]
    .map(([key, value]): GraphMissingLinkCandidate => {
      const [fromId, toId] = key.split("\u0000");
      return {
        from_id: fromId ?? "",
        to_id: toId ?? "",
        score: roundScore(value.score),
        shared_node_ids: uniqueStrings(value.sharedNodeIds).sort(),
        reason_codes: uniqueStrings(value.reasonCodes).sort(),
      };
    })
    .sort(compareMissingLinkCandidates)
    .slice(0, limit);
}

function surprisingConnectionCandidates(
  index: GraphIndexResponse,
  nodesById: Map<string, GraphNodeRecord>,
  edgeTypes: Map<GraphEdgeType, number>,
  limit: number,
): GraphSurprisingConnection[] {
  return index.edges
    .map((edge): GraphSurprisingConnection => {
      const from = nodesById.get(edge.from_id);
      const to = nodesById.get(edge.to_id);
      const typeFrequency = edgeTypes.get(edge.edge_type) ?? index.edges.length;
      const reasonCodes = [];
      let score = 0;
      if (typeFrequency <= 2) {
        reasonCodes.push("rare_edge_type");
        score += 0.75;
      }
      if (from?.record_type !== undefined && to?.record_type !== undefined && from.record_type !== to.record_type) {
        reasonCodes.push("cross_record_type_bridge");
        score += 0.5;
      }
      if (edge.edge_type === "source_relation") {
        reasonCodes.push("source_bridge");
        score += 0.4;
      }
      if (edge.weight > 1) {
        reasonCodes.push("weighted_edge");
        score += Math.min(edge.weight / 10, 0.5);
      }
      return {
        edge_id: edge.id,
        from_id: edge.from_id,
        to_id: edge.to_id,
        edge_type: edge.edge_type,
        score: roundScore(score),
        reason_codes: reasonCodes.length === 0 ? ["explicit_bridge"] : reasonCodes,
      };
    })
    .filter((edge) => edge.score > 0)
    .sort((left, right) => right.score - left.score || left.edge_type.localeCompare(right.edge_type) || left.edge_id.localeCompare(right.edge_id))
    .slice(0, limit);
}

function staleHubCandidates(
  index: GraphIndexResponse,
  nodesById: Map<string, GraphNodeRecord>,
  metricsById: Map<string, MutableGraphNodeMetric>,
  limit: number,
): GraphStaleHub[] {
  const claimStatus = new Map(
    [...nodesById.values()]
      .filter((node) => node.record_type === "claim" && (node.status === "stale" || node.status === "disputed"))
      .map((node) => [node.id, node.status]),
  );
  const linkedClaims = new Map<string, { stale: string[]; disputed: string[] }>();
  for (const edge of index.edges) {
    if (edge.edge_type !== "page_claim") {
      continue;
    }
    const status = claimStatus.get(edge.to_id);
    if (status !== "stale" && status !== "disputed") {
      continue;
    }
    const current = linkedClaims.get(edge.from_id) ?? { stale: [], disputed: [] };
    if (status === "stale") {
      current.stale.push(edge.to_id);
    } else {
      current.disputed.push(edge.to_id);
    }
    linkedClaims.set(edge.from_id, current);
  }
  return [...linkedClaims.entries()]
    .map(([pageId, claims]): GraphStaleHub | undefined => {
      const node = nodesById.get(pageId);
      const metric = metricsById.get(pageId);
      if (node?.record_type !== "page" || metric === undefined) {
        return undefined;
      }
      return {
        id: pageId,
        title: node.title,
        degree: metric.degree,
        stale_claim_ids: uniqueStrings(claims.stale).sort(),
        disputed_claim_ids: uniqueStrings(claims.disputed).sort(),
        reason_codes: uniqueStrings([
          ...(claims.stale.length > 0 ? ["stale_claim"] : []),
          ...(claims.disputed.length > 0 ? ["disputed_claim"] : []),
          metric.degree >= 3 ? "high_degree" : "connected_page",
        ]).sort(),
      };
    })
    .filter((hub): hub is GraphStaleHub => hub !== undefined)
    .sort((left, right) => right.degree - left.degree || left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function sourceCoverageGapCandidates(
  index: GraphIndexResponse,
  nodesById: Map<string, GraphNodeRecord>,
  limit: number,
): GraphSourceCoverageGap[] {
  const pagesByTopic = new Map<string, string[]>();
  const sourcesByPage = new Map<string, string[]>();
  for (const edge of index.edges) {
    if (edge.edge_type === "page_topic") {
      pagesByTopic.set(edge.to_id, [...(pagesByTopic.get(edge.to_id) ?? []), edge.from_id]);
    } else if (edge.edge_type === "page_source") {
      sourcesByPage.set(edge.from_id, [...(sourcesByPage.get(edge.from_id) ?? []), edge.to_id]);
    }
  }
  return [...pagesByTopic.entries()]
    .map(([topicId, pageIds]): GraphSourceCoverageGap | undefined => {
      const pages = uniqueStrings(pageIds).sort();
      const sources = uniqueStrings(pages.flatMap((pageId) => sourcesByPage.get(pageId) ?? [])).sort();
      if (pages.length < 2 || sources.length >= pages.length) {
        return undefined;
      }
      const topic = nodesById.get(topicId)?.title ?? topicId.replace(/^topic:/u, "");
      return {
        topic_id: topicId,
        topic,
        page_count: pages.length,
        source_count: sources.length,
        score: roundScore((pages.length - sources.length) / pages.length),
        reason_codes: sources.length === 0 ? ["topic_without_sources"] : ["low_source_coverage"],
      };
    })
    .filter((gap): gap is GraphSourceCoverageGap => gap !== undefined)
    .sort((left, right) => right.score - left.score || right.page_count - left.page_count || left.topic.localeCompare(right.topic))
    .slice(0, limit);
}

function suggestedGraphQuestions(input: {
  hubNodes: GraphHubNode[];
  orphanComponents: GraphOrphanComponent[];
  candidateMissingLinks: GraphMissingLinkCandidate[];
  staleHubs: GraphStaleHub[];
  sourceCoverageGaps: GraphSourceCoverageGap[];
  nodesById: Map<string, GraphNodeRecord>;
  limit: number;
}): GraphSuggestedQuestion[] {
  const questions: GraphSuggestedQuestion[] = [];
  const firstHub = input.hubNodes[0];
  if (firstHub) {
    questions.push({
      question: `Why is ${firstHub.title} central to this wiki?`,
      seed_node_ids: [firstHub.id],
      reason_codes: ["hub_node"],
    });
  }
  const firstMissing = input.candidateMissingLinks[0];
  if (firstMissing) {
    questions.push({
      question: `Should ${nodeTitle(input.nodesById, firstMissing.from_id)} link to ${nodeTitle(input.nodesById, firstMissing.to_id)}?`,
      seed_node_ids: [firstMissing.from_id, firstMissing.to_id, ...firstMissing.shared_node_ids.slice(0, 2)],
      reason_codes: firstMissing.reason_codes,
    });
  }
  const firstOrphan = input.orphanComponents[0];
  if (firstOrphan) {
    questions.push({
      question: "Which orphaned pages should be connected to the main knowledge map?",
      seed_node_ids: firstOrphan.page_ids.slice(0, 5),
      reason_codes: firstOrphan.reason_codes,
    });
  }
  const firstStale = input.staleHubs[0];
  if (firstStale) {
    questions.push({
      question: `Which claims should be refreshed for ${firstStale.title}?`,
      seed_node_ids: [firstStale.id, ...firstStale.stale_claim_ids.slice(0, 3), ...firstStale.disputed_claim_ids.slice(0, 3)],
      reason_codes: firstStale.reason_codes,
    });
  }
  const firstCoverageGap = input.sourceCoverageGaps[0];
  if (firstCoverageGap) {
    questions.push({
      question: `Which public sources should support the ${firstCoverageGap.topic} topic?`,
      seed_node_ids: [firstCoverageGap.topic_id],
      reason_codes: firstCoverageGap.reason_codes,
    });
  }
  return questions.slice(0, input.limit);
}

function nodeTitle(nodesById: Map<string, GraphNodeRecord>, id: string): string {
  return nodesById.get(id)?.title ?? id;
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function compareMetricsForHubRank(left: GraphNodeMetric, right: GraphNodeMetric): number {
  return (
    right.weighted_degree - left.weighted_degree ||
    right.degree - left.degree ||
    left.record_type.localeCompare(right.record_type) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  );
}

function compareComponentBuildState(left: ComponentBuildState, right: ComponentBuildState): number {
  return right.nodeIds.length - left.nodeIds.length || right.edgeCount - left.edgeCount || left.id.localeCompare(right.id);
}

function compareComponents(left: GraphComponentSummary, right: GraphComponentSummary): number {
  return right.node_count - left.node_count || right.edge_count - left.edge_count || left.id.localeCompare(right.id);
}

function compareMissingLinkCandidates(left: GraphMissingLinkCandidate, right: GraphMissingLinkCandidate): number {
  return (
    right.score - left.score ||
    right.reason_codes.length - left.reason_codes.length ||
    left.from_id.localeCompare(right.from_id) ||
    left.to_id.localeCompare(right.to_id)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
