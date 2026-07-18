import { createHash } from "node:crypto";
import path from "node:path";
import {
  compareGraphNodes,
  fallbackGraphNode,
  graphPathFromIndex,
  idToUri,
  isoNow,
  openWikiPathPatternMatches,
  slugify,
  uriToId,
  type ClaimRecord,
  type DecisionRecord,
  type FactRecord,
  type GraphEdgeRecord,
  type GraphEdgeType,
  type GraphIndexResponse,
  type GraphNeighborhoodResponse,
  type GraphNodeRecord,
  type GraphOrphansResponse,
  type GraphPathResponse,
  type GraphStaleResponse,
  type OpenQuestionRecord,
  type OpenWikiPolicyBundle,
  type OpenWikiSectionRecord,
  type PageRecord,
  type ProposalRecord,
  type SourceRecord,
  type TakeRecord,
  type TopicSummary,
} from "@openwiki/core";
import { buildOpenWikiLinkGazetteer, extractOpenWikiTypedLinks, prepareOpenWikiLinkGazetteer, type OpenWikiLinkGazetteer, type OpenWikiPreparedLinkGazetteer } from "@openwiki/skills";
import { loadRepository } from "./workspace.ts";
import { normalizeRepoPath } from "./io.ts";
import { openQuestionsFromPage } from "./normalizers.ts";
import type { LoadedOpenWikiRepo } from "./types.ts";

export async function listTopics(root: string): Promise<{ topics: TopicSummary[] }> {
  const repo = await loadRepository(root);
  const topics = new Map<string, TopicSummary>();

  for (const page of repo.pages) {
    for (const topic of page.topics) {
      const current =
        topics.get(topic) ??
        ({
          topic,
          page_count: 0,
          page_ids: [],
          claim_count: 0,
          source_count: 0,
          source_ids: [],
          updated_at: "",
        } satisfies TopicSummary);
      current.page_count += 1;
      current.page_ids.push(page.id);
      current.claim_count += page.claim_ids.length;
      for (const sourceId of page.source_ids) {
        if (!current.source_ids.includes(sourceId)) {
          current.source_ids.push(sourceId);
        }
      }
      current.source_count = current.source_ids.length;
      if (page.updated_at > current.updated_at) {
        current.updated_at = page.updated_at;
      }
      topics.set(topic, current);
    }
  }

  return {
    topics: [...topics.values()].sort(
      (left, right) => right.page_count - left.page_count || left.topic.localeCompare(right.topic),
    ),
  };
}

export async function listOpenQuestions(root: string): Promise<{ open_questions: OpenQuestionRecord[] }> {
  const repo = await loadRepository(root);
  return {
    open_questions: repo.pages.flatMap((page) => openQuestionsFromPage(page)),
  };
}

export async function listGraphEdges(root: string): Promise<GraphIndexResponse> {
  return graphIndexFromRepository(await loadRepository(root));
}

export async function graphNeighbors(
  root: string,
  id: string,
  options: { direction?: "in" | "out" | "both"; depth?: number; limit?: number } = {},
): Promise<GraphNeighborhoodResponse> {
  const index = await listGraphEdges(root);
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

export async function graphBacklinks(root: string, id: string, options: { limit?: number } = {}): Promise<GraphNeighborhoodResponse> {
  return graphNeighbors(root, id, { direction: "in", depth: 1, ...(options.limit === undefined ? {} : { limit: options.limit }) });
}

export async function graphRelated(root: string, id: string, options: { limit?: number } = {}): Promise<GraphNeighborhoodResponse> {
  const index = await listGraphEdges(root);
  const nodesById = new Map(index.nodes.map((node) => [node.id, node]));
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const direct = index.edges.filter((edge) => edge.from_id === id || edge.to_id === id);
  const sharedHubs = new Set(
    direct
      .filter((edge) => edge.edge_type === "page_topic" || edge.edge_type === "page_source" || edge.edge_type === "page_claim" || edge.edge_type === "fact_page" || edge.edge_type === "take_page")
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

export async function graphPath(root: string, fromId: string, toId: string): Promise<GraphPathResponse> {
  const index = await listGraphEdges(root);
  return graphPathFromIndex(index, fromId, toId);
}

export async function graphOrphans(root: string): Promise<GraphOrphansResponse> {
  const repo = await loadRepository(root);
  const index = graphIndexFromRepository(repo);
  const linkedPageIds = new Set<string>();
  for (const edge of index.edges) {
    if (!isCanonicalPageToPageLinkEdge(edge)) {
      continue;
    }
    linkedPageIds.add(edge.from_id);
    linkedPageIds.add(edge.to_id);
  }
  const pages = repo.pages
    .filter((page) => !linkedPageIds.has(page.id))
    .map(graphNodeFromPage)
    .sort(compareGraphNodes);
  return { pages, total: pages.length };
}

export async function graphStale(root: string): Promise<GraphStaleResponse> {
  const repo = await loadRepository(root);
  const staleClaims = repo.claims.filter((claim) => claim.status === "stale" || claim.status === "disputed");
  const claimsByPage = new Map<string, ClaimRecord[]>();
  const claimsById = new Map(repo.claims.map((claim) => [claim.id, claim]));
  for (const claim of repo.claims) {
    const current = claimsByPage.get(claim.page_id) ?? [];
    current.push(claim);
    claimsByPage.set(claim.page_id, current);
  }
  for (const page of repo.pages) {
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
  for (const page of repo.pages) {
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
  const pages = [...stalePageReasons.entries()]
    .map(([pageId, reasons]) => ({ ...(graphNodeForId(repo, pageId) ?? fallbackGraphNode(pageId)), reasons }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { pages, claims: staleClaims, total: pages.length + staleClaims.length };
}

function graphIndexFromRepository(repo: LoadedOpenWikiRepo): GraphIndexResponse {
  const nodes = new Map<string, GraphNodeRecord>();
  const edges = new Map<string, GraphEdgeRecord>();
  const addNode = (node: GraphNodeRecord): void => {
    nodes.set(node.id, node);
  };
  const addEdge = (edge: Omit<GraphEdgeRecord, "id" | "uri" | "type" | "workspace_id" | "created_at" | "weight"> & { created_at?: string; weight?: number; id_discriminator?: string }): void => {
    const id = graphEdgeId(edge.edge_type, edge.from_id, edge.to_id, edge.path, edge.anchor, edge.id_discriminator);
    edges.set(id, {
      id,
      uri: idToUri(id),
      type: "edge",
      workspace_id: repo.config.workspace_id,
      from_id: edge.from_id,
      to_id: edge.to_id,
      edge_type: edge.edge_type,
      weight: edge.weight ?? 1,
      created_at: edge.created_at ?? isoNow(),
      ...(edge.path === undefined ? {} : { path: edge.path }),
      ...(edge.anchor === undefined ? {} : { anchor: edge.anchor }),
      ...(edge.source_commit === undefined ? {} : { source_commit: edge.source_commit }),
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    });
  };

  for (const page of repo.pages) {
    addNode(graphNodeFromPage(page));
  }
  for (const source of repo.sources) {
    addNode(graphNodeFromSource(source));
  }
  for (const claim of repo.claims) {
    addNode(graphNodeFromClaim(claim));
  }
  for (const fact of repo.facts) {
    addNode(graphNodeFromFact(fact));
  }
  for (const take of repo.takes) {
    addNode(graphNodeFromTake(take));
  }
  for (const proposal of repo.proposals) {
    addNode(graphNodeFromProposal(proposal));
  }
  for (const decision of repo.decisions) {
    addNode(graphNodeFromDecision(decision));
  }
  for (const section of repo.policy.sections) {
    addNode({ id: section.id, uri: idToUri(section.id), record_type: "section", title: section.title, ...(section.description === undefined ? {} : { summary: section.description }) });
  }

  const linkGazetteer = graphLinkGazetteer(repo);
  const preparedLinkGazetteer = prepareOpenWikiLinkGazetteer(linkGazetteer);
  for (const page of repo.pages) {
    const explicitTargets = pageLinkTargets(repo, page);
    for (const target of explicitTargets) {
      addEdge({ from_id: page.id, to_id: target.id, edge_type: "page_link", path: page.path, ...(target.anchor === undefined ? {} : { anchor: target.anchor }), metadata: { ...(target.label === undefined ? {} : { label: target.label }) } });
    }
    for (const candidate of pageTypedLinkTargets(page, linkGazetteer, preparedLinkGazetteer, explicitTargets)) {
      addEdge({
        from_id: candidate.from_id,
        to_id: candidate.to_id,
        edge_type: "page_typed_link",
        path: candidate.path,
        id_discriminator: [candidate.relation, candidate.rule, candidate.span.start, candidate.span.end].join(":"),
        ...(candidate.anchor === undefined ? {} : { anchor: candidate.anchor }),
        weight: candidate.confidence,
        metadata: {
          relation: candidate.relation,
          extraction_rule: candidate.rule,
          confidence: candidate.confidence,
          link_kind: candidate.already_present ? "explicit" : "derived",
          already_present: candidate.already_present,
          span: candidate.span,
          ...(candidate.label === undefined ? {} : { label: candidate.label }),
          ...(candidate.context === undefined ? {} : { context: candidate.context }),
        },
      });
    }
    for (const sourceId of page.source_ids) {
      addEdge({ from_id: page.id, to_id: sourceId, edge_type: "page_source", path: page.path });
    }
    for (const claimId of page.claim_ids) {
      addEdge({ from_id: page.id, to_id: claimId, edge_type: "page_claim", path: page.path });
    }
    for (const topic of page.topics) {
      const topicId = topicGraphId(topic);
      addNode({ id: topicId, uri: idToUri(topicId), record_type: "topic", title: topic });
      addEdge({ from_id: page.id, to_id: topicId, edge_type: "page_topic", path: page.path, metadata: { topic } });
    }
    for (const section of sectionsForGraphPath(repo.policy, page.path)) {
      addEdge({ from_id: page.id, to_id: section.id, edge_type: "page_section", path: page.path });
    }
  }

  for (const claim of repo.claims) {
    for (const sourceId of claim.source_ids) {
      addEdge({ from_id: claim.id, to_id: sourceId, edge_type: "claim_source", path: "claims/claim-index.jsonl" });
    }
  }
  for (const fact of repo.facts) {
    for (const subjectId of fact.subject_ids) {
      addEdge({ from_id: fact.id, to_id: subjectId, edge_type: "fact_subject", path: fact.path });
    }
    for (const pageId of fact.page_ids) {
      addEdge({ from_id: fact.id, to_id: pageId, edge_type: "fact_page", path: fact.path });
    }
    for (const sourceId of fact.source_ids) {
      addEdge({ from_id: fact.id, to_id: sourceId, edge_type: "fact_source", path: fact.path });
    }
    for (const claimId of fact.claim_ids) {
      addEdge({ from_id: fact.id, to_id: claimId, edge_type: "fact_claim", path: fact.path });
    }
  }
  for (const take of repo.takes) {
    for (const pageId of take.page_ids) {
      addEdge({ from_id: take.id, to_id: pageId, edge_type: "take_page", path: take.path });
    }
    for (const sourceId of take.source_ids) {
      addEdge({ from_id: take.id, to_id: sourceId, edge_type: "take_source", path: take.path });
    }
    for (const claimId of take.claim_ids) {
      addEdge({ from_id: take.id, to_id: claimId, edge_type: "take_claim", path: take.path });
    }
  }
  for (const proposal of repo.proposals) {
    for (const targetId of proposal.target_ids) {
      addEdge({ from_id: proposal.id, to_id: targetId, edge_type: "proposal_target", path: proposal.path });
    }
  }
  for (const decision of repo.decisions) {
    addEdge({ from_id: decision.id, to_id: decision.proposal_id, edge_type: "decision_proposal", path: decision.path });
  }

  return {
    nodes: [...nodes.values()].sort(compareGraphNodes),
    edges: [...edges.values()].sort(compareGraphEdges),
  };
}

function graphNodeForId(repo: LoadedOpenWikiRepo, id: string): GraphNodeRecord | undefined {
  const page = repo.pages.find((candidate) => candidate.id === id || candidate.uri === id);
  if (page) return graphNodeFromPage(page);
  const source = repo.sources.find((candidate) => candidate.id === id || candidate.uri === id);
  if (source) return graphNodeFromSource(source);
  const claim = repo.claims.find((candidate) => candidate.id === id || candidate.uri === id);
  if (claim) return graphNodeFromClaim(claim);
  const fact = repo.facts.find((candidate) => candidate.id === id || candidate.uri === id);
  if (fact) return graphNodeFromFact(fact);
  const take = repo.takes.find((candidate) => candidate.id === id || candidate.uri === id);
  if (take) return graphNodeFromTake(take);
  const proposal = repo.proposals.find((candidate) => candidate.id === id || candidate.uri === id);
  if (proposal) return graphNodeFromProposal(proposal);
  const decision = repo.decisions.find((candidate) => candidate.id === id || candidate.uri === id);
  if (decision) return graphNodeFromDecision(decision);
  const section = repo.policy.sections.find((candidate) => candidate.id === id);
  if (section) return { id: section.id, uri: idToUri(section.id), record_type: "section", title: section.title, ...(section.description === undefined ? {} : { summary: section.description }) };
  return undefined;
}

function graphNodeFromPage(page: PageRecord): GraphNodeRecord {
  return {
    id: page.id,
    uri: page.uri,
    record_type: "page",
    title: page.title,
    path: page.path,
    status: page.status,
    ...(page.summary === undefined ? {} : { summary: page.summary }),
  };
}

function graphNodeFromSource(source: SourceRecord): GraphNodeRecord {
  return { id: source.id, uri: source.uri, record_type: "source", title: source.title, path: source.path, status: "active" };
}

function graphNodeFromClaim(claim: ClaimRecord): GraphNodeRecord {
  return { id: claim.id, uri: claim.uri, record_type: "claim", title: claim.text, path: "claims/claim-index.jsonl", status: claim.status };
}

function graphNodeFromFact(fact: FactRecord): GraphNodeRecord {
  return { id: fact.id, uri: fact.uri, record_type: "fact", title: fact.text, path: fact.path, status: fact.status, summary: fact.kind };
}

function graphNodeFromTake(take: TakeRecord): GraphNodeRecord {
  return { id: take.id, uri: take.uri, record_type: "take", title: take.statement, path: take.path, status: take.status, summary: take.resolution ?? `${Math.round(take.probability * 100)}%` };
}

function graphNodeFromProposal(proposal: ProposalRecord): GraphNodeRecord {
  return { id: proposal.id, uri: proposal.uri, record_type: "proposal", title: proposal.title, path: proposal.path, status: proposal.status };
}

function graphNodeFromDecision(decision: DecisionRecord): GraphNodeRecord {
  return { id: decision.id, uri: decision.uri, record_type: "decision", title: decision.decision + ": " + decision.proposal_id, path: decision.path, status: decision.decision };
}

function pageLinkTargets(repo: LoadedOpenWikiRepo, page: PageRecord): Array<{ id: string; label?: string; anchor?: string }> {
  const targets: Array<{ id: string; label?: string; anchor?: string }> = [];
  for (const link of markdownLinks(page.body)) {
    const resolved = resolvePageReference(repo.pages, page, link.target);
    if (resolved !== undefined && resolved !== page.id) {
      targets.push({ id: resolved, label: link.label, anchor: link.target });
    }
  }
  for (const link of wikiLinks(page.body)) {
    const resolved = resolvePageReference(repo.pages, page, link.target);
    if (resolved !== undefined && resolved !== page.id) {
      targets.push({ id: resolved, label: link.label, anchor: link.target });
    }
  }
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.id + "" + (target.anchor ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pageTypedLinkTargets(
  page: PageRecord,
  gazetteer: OpenWikiLinkGazetteer,
  preparedGazetteer: OpenWikiPreparedLinkGazetteer,
  explicitTargets: Array<{ id: string }>,
): ReturnType<typeof extractOpenWikiTypedLinks>["candidates"] {
  return extractOpenWikiTypedLinks({
    from_id: page.id,
    path: page.path,
    body: page.body,
    gazetteer,
    existing_edges: explicitTargets.map((target) => ({ from_id: page.id, to_id: target.id })),
  }, preparedGazetteer).candidates;
}

function graphLinkGazetteer(repo: LoadedOpenWikiRepo): OpenWikiLinkGazetteer {
  return buildOpenWikiLinkGazetteer({
    pages: repo.pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: page.path,
      page_type: page.page_type,
      topics: page.topics,
    })),
    sources: repo.sources.map((source) => ({
      id: source.id,
      title: source.title,
      path: source.path,
      source_type: source.source_type,
    })),
    claims: repo.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
    })),
  });
}

function markdownLinks(body: string): Array<{ label: string; target: string }> {
  const links: Array<{ label: string; target: string }> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const label = (match[1] ?? "").trim();
    const target = stripLinkFragment((match[2] ?? "").trim());
    if (target) {
      links.push({ label, target });
    }
  }
  return links;
}

function wikiLinks(body: string): Array<{ label: string; target: string }> {
  const links: Array<{ label: string; target: string }> = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = stripLinkFragment((match[1] ?? "").trim());
    const label = ((match[2] ?? match[1]) ?? "").trim();
    if (target) {
      links.push({ label, target });
    }
  }
  return links;
}

function stripLinkFragment(value: string): string {
  return value.split("#")[0]?.trim() ?? "";
}

function resolvePageReference(pages: PageRecord[], fromPage: PageRecord, rawTarget: string): string | undefined {
  let target = rawTarget.trim();
  if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) {
    return undefined;
  }
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the raw target when it is not URI-encoded.
  }
  if (target.startsWith("openwiki://")) {
    try {
      const id = uriToId(target);
      return pages.some((page) => page.id === id) ? id : undefined;
    } catch {
      return undefined;
    }
  }
  if (target.startsWith("page:")) {
    return pages.some((page) => page.id === target) ? target : undefined;
  }
  if (target.endsWith(".md")) {
    const normalized = normalizeRepoPath(target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(fromPage.path), target)));
    const direct = pages.find((page) => page.path === normalized || page.path.endsWith("/" + normalized));
    if (direct) {
      return direct.id;
    }
  }
  const targetSlug = slugify(target.replace(/.md$/, ""));
  const page = pages.find(
    (candidate) =>
      candidate.id.endsWith(":" + targetSlug) ||
      slugify(candidate.title) === targetSlug ||
      slugify(path.basename(candidate.path, path.extname(candidate.path))) === targetSlug,
  );
  return page?.id;
}

function topicGraphId(topic: string): string {
  return "topic:" + slugify(topic);
}

function graphEdgeId(edgeType: GraphEdgeType, fromId: string, toId: string, repoPath?: string, anchor?: string, discriminator?: string): string {
  const identity = [edgeType, fromId, toId, repoPath ?? "", anchor ?? ""].join("");
  const hash = createHash("sha1").update(discriminator === undefined ? identity : identity + "\u0000" + discriminator).digest("hex").slice(0, 16);
  return "edge:" + hash;
}

export function appendGraphReason(map: Map<string, string[]>, pageId: string, reason: string): void {
  const current = map.get(pageId) ?? [];
  if (!current.includes(reason)) {
    current.push(reason);
  }
  map.set(pageId, current);
}

function sectionsForGraphPath(policy: OpenWikiPolicyBundle, repoPath: string): OpenWikiSectionRecord[] {
  return policy.sections.filter((section) => section.paths.some((pattern) => graphPathMatches(pattern, repoPath)));
}

function graphPathMatches(pattern: string, repoPath: string): boolean {
  return openWikiPathPatternMatches(pattern, repoPath);
}

function compareGraphEdges(left: GraphEdgeRecord, right: GraphEdgeRecord): number {
  return left.edge_type.localeCompare(right.edge_type) || left.from_id.localeCompare(right.from_id) || left.to_id.localeCompare(right.to_id) || left.id.localeCompare(right.id);
}

function isCanonicalPageToPageLinkEdge(edge: GraphEdgeRecord): boolean {
  return edge.edge_type === "page_link" && edge.from_id.startsWith("page:") && edge.to_id.startsWith("page:");
}
