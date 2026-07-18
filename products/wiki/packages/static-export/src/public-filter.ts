
import type {
  ClaimRecord,
  DecisionRecord,
  EventRecord,
  FactRecord,
  GraphIndexResponse,
  OpenQuestionRecord,
  ProposalRecord,
  RunRecord,
  SourceRecord,
  TakeRecord,
  TopicSummary,
} from "@openwiki/core";
import { openWikiEventVisibilitySubjectPaths, openWikiRunVisibilitySubjectPaths } from "@openwiki/core";
import type { RecentChangesResponse } from "@openwiki/git";
import { publicPathAllowed } from "@openwiki/policy";
import { loadRepository } from "@openwiki/repo";

type StaticRepo = Awaited<ReturnType<typeof loadRepository>>;

export function claimPublicAllowed(repo: StaticRepo, claim: ClaimRecord, publicSources: SourceRecord[]): boolean {
  const page = repo.pages.find((candidate) => candidate.id === claim.page_id);
  const publicSourceIds = new Set(publicSources.map((source) => source.id));
  return page !== undefined && publicPathAllowed(repo.policy, page.path) && claim.source_ids.every((sourceId) => publicSourceIds.has(sourceId));
}

export function factPublicAllowed(repo: StaticRepo, fact: FactRecord, publicSources: SourceRecord[], publicClaims: ClaimRecord[]): boolean {
  if (fact.status === "forgotten" || fact.sensitivity !== "public" || !publicPathAllowed(repo.policy, fact.path)) {
    return false;
  }
  const publicSourceIds = new Set(publicSources.map((source) => source.id));
  const publicClaimIds = new Set(publicClaims.map((claim) => claim.id));
  return (
    fact.page_ids.every((pageId) => {
      const page = repo.pages.find((candidate) => candidate.id === pageId);
      return page !== undefined && publicPathAllowed(repo.policy, page.path);
    }) &&
    fact.source_ids.every((sourceId) => publicSourceIds.has(sourceId)) &&
    fact.claim_ids.every((claimId) => publicClaimIds.has(claimId)) &&
    fact.subject_ids.every((subjectId) => subjectPublicAllowed(repo, subjectId, publicSources, publicClaimIds))
  );
}

export function takePublicAllowed(repo: StaticRepo, take: TakeRecord, publicSources: SourceRecord[], publicClaims: ClaimRecord[]): boolean {
  if (!publicPathAllowed(repo.policy, take.path)) {
    return false;
  }
  const publicSourceIds = new Set(publicSources.map((source) => source.id));
  const publicClaimIds = new Set(publicClaims.map((claim) => claim.id));
  return (
    take.page_ids.every((pageId) => {
      const page = repo.pages.find((candidate) => candidate.id === pageId);
      return page !== undefined && publicPathAllowed(repo.policy, page.path);
    }) &&
    take.source_ids.every((sourceId) => publicSourceIds.has(sourceId)) &&
    take.claim_ids.every((claimId) => publicClaimIds.has(claimId))
  );
}

export function proposalPublicAllowed(repo: StaticRepo, proposal: ProposalRecord, publicSources: SourceRecord[]): boolean {
  if (proposal.target_path && !publicPathAllowed(repo.policy, proposal.target_path)) {
    return false;
  }
  const publicSourceIds = new Set(publicSources.map((source) => source.id));
  return proposal.target_ids.every((targetId) => {
    const page = repo.pages.find((candidate) => candidate.id === targetId);
    if (page) {
      return publicPathAllowed(repo.policy, page.path);
    }
    const source = repo.sources.find((candidate) => candidate.id === targetId);
    if (source) {
      return publicSourceIds.has(source.id);
    }
    return proposal.target_path !== undefined && publicPathAllowed(repo.policy, proposal.target_path);
  });
}

export function publicDecisionAllowed(repo: StaticRepo, decision: DecisionRecord, publicProposalIds: Set<string>): boolean {
  return publicProposalIds.has(decision.proposal_id) || publicPathAllowed(repo.policy, decision.path);
}

export function eventPublicAllowed(
  repo: StaticRepo,
  event: EventRecord,
  publicProposalIds: Set<string>,
  publicSources: SourceRecord[],
): boolean {
  const fallbackPaths = (event.subject_paths?.length ?? 0) > 0 ? [] : openWikiEventVisibilitySubjectPaths({ data: event.data });
  if ((event.subject_ids?.length ?? 0) > 0 || (event.subject_paths?.length ?? 0) > 0) {
    return (
      (event.subject_ids ?? []).every((id) => recordPublicAllowed(repo, id, publicProposalIds, publicSources)) &&
      [...(event.subject_paths ?? []), ...fallbackPaths].every((repoPath) => publicPathAllowed(repo.policy, repoPath))
    );
  }
  if (event.record_id) {
    const page = repo.pages.find((candidate) => candidate.id === event.record_id);
    if (page) {
      return publicPathAllowed(repo.policy, page.path) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
    if (repo.sources.some((source) => source.id === event.record_id)) {
      return publicSources.some((source) => source.id === event.record_id) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
    const claim = repo.claims.find((candidate) => candidate.id === event.record_id);
    if (claim) {
      return claimPublicAllowed(repo, claim, publicSources) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
    const fact = repo.facts.find((candidate) => candidate.id === event.record_id);
    if (fact) {
      const publicClaims = repo.claims.filter((candidate) => claimPublicAllowed(repo, candidate, publicSources));
      return factPublicAllowed(repo, fact, publicSources, publicClaims) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
    const take = repo.takes.find((candidate) => candidate.id === event.record_id);
    if (take) {
      const publicClaims = repo.claims.filter((candidate) => claimPublicAllowed(repo, candidate, publicSources));
      return takePublicAllowed(repo, take, publicSources, publicClaims) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
    if (repo.proposals.some((proposal) => proposal.id === event.record_id)) {
      return publicProposalIds.has(event.record_id) && fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
    }
  }
  if (fallbackPaths.length > 0) {
    return fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
  }
  return publicPathAllowed(repo.policy, event.path);
}

function recordPublicAllowed(
  repo: StaticRepo,
  id: string,
  publicProposalIds: Set<string>,
  publicSources: SourceRecord[],
  publicClaimIds = new Set<string>(),
  publicTakeIds = new Set<string>(),
): boolean {
  if (id.startsWith("workspace:")) {
    return true;
  }
  const page = repo.pages.find((candidate) => candidate.id === id);
  if (page) {
    return publicPathAllowed(repo.policy, page.path);
  }
  if (repo.sources.some((source) => source.id === id)) {
    return publicSources.some((source) => source.id === id);
  }
  const claim = repo.claims.find((candidate) => candidate.id === id);
  if (claim) {
    return publicClaimIds.size > 0 ? publicClaimIds.has(id) : claimPublicAllowed(repo, claim, publicSources);
  }
  const fact = repo.facts.find((candidate) => candidate.id === id);
  if (fact) {
    const publicClaims = repo.claims.filter((candidate) => publicClaimIds.has(candidate.id) || claimPublicAllowed(repo, candidate, publicSources));
    return factPublicAllowed(repo, fact, publicSources, publicClaims);
  }
  const take = repo.takes.find((candidate) => candidate.id === id);
  if (take) {
    return publicTakeIds.size > 0 ? publicTakeIds.has(id) : takePublicAllowed(repo, take, publicSources, repo.claims.filter((candidate) => claimPublicAllowed(repo, candidate, publicSources)));
  }
  if (repo.proposals.some((proposal) => proposal.id === id)) {
    return publicProposalIds.has(id);
  }
  const decision = repo.decisions.find((candidate) => candidate.id === id);
  if (decision) {
    return publicDecisionAllowed(repo, decision, publicProposalIds);
  }
  return false;
}

function subjectPublicAllowed(
  repo: StaticRepo,
  id: string,
  publicSources: SourceRecord[],
  publicClaimIds: Set<string>,
): boolean {
  if (id.startsWith("workspace:")) {
    return true;
  }
  const page = repo.pages.find((candidate) => candidate.id === id);
  if (page) {
    return publicPathAllowed(repo.policy, page.path);
  }
  if (repo.sources.some((source) => source.id === id)) {
    return publicSources.some((source) => source.id === id);
  }
  if (repo.claims.some((claim) => claim.id === id)) {
    return publicClaimIds.has(id);
  }
  const proposal = repo.proposals.find((candidate) => candidate.id === id);
  if (proposal) {
    return proposal.target_path ? publicPathAllowed(repo.policy, proposal.target_path) : publicPathAllowed(repo.policy, proposal.path);
  }
  const decision = repo.decisions.find((candidate) => candidate.id === id);
  return decision === undefined ? false : publicPathAllowed(repo.policy, decision.path);
}

export function runPublicAllowed(repo: StaticRepo, run: RunRecord): boolean {
  const fallbackPaths = (run.subject_paths?.length ?? 0) > 0 ? [] : openWikiRunVisibilitySubjectPaths({ input: run.input, output: run.output });
  if ((run.subject_ids?.length ?? 0) > 0 || (run.subject_paths?.length ?? 0) > 0) {
    return (
      (run.subject_ids ?? []).every((id) => recordPublicAllowed(repo, id, new Set(), [])) &&
      [...(run.subject_paths ?? []), ...fallbackPaths].every((repoPath) => publicPathAllowed(repo.policy, repoPath))
    );
  }
  if (fallbackPaths.length > 0) {
    return fallbackPaths.every((repoPath) => publicPathAllowed(repo.policy, repoPath));
  }
  return publicPathAllowed(repo.policy, run.path);
}

export function publicTopicSummaries(
  response: { topics: TopicSummary[] },
  publicPages: StaticRepo["pages"],
  publicSources: SourceRecord[],
  publicClaims: ClaimRecord[],
): { topics: TopicSummary[] } {
  const pageIds = new Set(publicPages.map((page) => page.id));
  const sourceIds = new Set(publicSources.map((source) => source.id));
  const claimIds = new Set(publicClaims.map((claim) => claim.id));
  return {
    topics: response.topics
      .map((topic) => {
        const visiblePages = topic.page_ids.filter((pageId) => pageIds.has(pageId));
        const visibleSources = topic.source_ids.filter((sourceId) => sourceIds.has(sourceId));
        const visibleClaimCount = publicPages
          .filter((page) => visiblePages.includes(page.id))
          .reduce((count, page) => count + page.claim_ids.filter((claimId) => claimIds.has(claimId)).length, 0);
        const updatedAt = publicPages
          .filter((page) => visiblePages.includes(page.id))
          .reduce((latest, page) => (page.updated_at > latest ? page.updated_at : latest), "");
        return {
          ...topic,
          page_count: visiblePages.length,
          page_ids: visiblePages,
          claim_count: visibleClaimCount,
          source_count: visibleSources.length,
          source_ids: visibleSources,
          updated_at: updatedAt,
        };
      })
      .filter((topic) => topic.page_count > 0),
  };
}

export function publicOpenQuestionRecords(
  response: { open_questions: OpenQuestionRecord[] },
  publicPages: StaticRepo["pages"],
): { open_questions: OpenQuestionRecord[] } {
  const pageIds = new Set(publicPages.map((page) => page.id));
  return { open_questions: response.open_questions.filter((question) => pageIds.has(question.page_id)) };
}

export function publicGraphIndex(
  repo: StaticRepo,
  graph: GraphIndexResponse,
  publicProposalIds: Set<string>,
  publicSources: SourceRecord[],
  publicClaimIds = new Set<string>(),
  publicTakeIds = new Set<string>(),
): GraphIndexResponse {
  const edges = graph.edges.filter(
    (edge) =>
      graphEndpointPublicAllowed(repo, edge.from_id, publicProposalIds, publicSources, publicClaimIds, publicTakeIds) &&
      graphEndpointPublicAllowed(repo, edge.to_id, publicProposalIds, publicSources, publicClaimIds, publicTakeIds),
  );
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.from_id);
    nodeIds.add(edge.to_id);
  }
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id) || (!graphSyntheticNode(node.id) && recordPublicAllowed(repo, node.id, publicProposalIds, publicSources, publicClaimIds, publicTakeIds)));
  return { nodes, edges };
}

function graphEndpointPublicAllowed(
  repo: StaticRepo,
  id: string,
  publicProposalIds: Set<string>,
  publicSources: SourceRecord[],
  publicClaimIds: Set<string>,
  publicTakeIds: Set<string>,
): boolean {
  return graphSyntheticNode(id) || recordPublicAllowed(repo, id, publicProposalIds, publicSources, publicClaimIds, publicTakeIds);
}

function graphSyntheticNode(id: string): boolean {
  return id.startsWith("topic:") || id.startsWith("section:");
}

export function publicRecentChangesResponse(repo: StaticRepo, response: RecentChangesResponse): RecentChangesResponse {
  return {
    ...response,
    changes: response.changes.filter((change) =>
      change.files.length === 0 || change.files.every((file) => publicPathAllowed(repo.policy, file.path)),
    ),
  };
}

export function sourcePublicAllowed(source: SourceRecord): boolean {
  const sensitivity = typeof source.trust?.sensitivity === "string" ? source.trust.sensitivity.toLowerCase() : undefined;
  return sensitivity !== "private" && sensitivity !== "restricted" && sensitivity !== "confidential";
}
