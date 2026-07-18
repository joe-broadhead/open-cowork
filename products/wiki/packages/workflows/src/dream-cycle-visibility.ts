import { uniqueStrings, type ProposalRecord, type ValidationIssue } from "@openwiki/core";
import { assertPathAuthorized, canReadPathExpression, canReadRecordId, pathVisibility, type PolicyContext } from "@openwiki/policy";
import type { LoadedOpenWikiRepo } from "@openwiki/repo";

interface DreamVisibilityContext {
  policyContext?: PolicyContext;
}

export function visiblePages(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo): LoadedOpenWikiRepo["pages"] {
  return context.policyContext === undefined ? repo.pages : repo.pages.filter((page) => canSeeRecord(context, repo, page.id));
}

export function visibleRepositoryCounts(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo): Record<"pages" | "sources" | "claims" | "proposals", number> {
  return {
    pages: repo.pages.filter((page) => canSeeRecord(context, repo, page.id)).length,
    sources: repo.sources.filter((source) => canSeeRecord(context, repo, source.id)).length,
    claims: repo.claims.filter((claim) => canSeeRecord(context, repo, claim.id)).length,
    proposals: repo.proposals.filter((proposal) => canSeeRecord(context, repo, proposal.id)).length,
  };
}

export function dreamAggregateSubjectPaths(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo): string[] {
  return uniqueStrings([
    ...repo.pages.filter((page) => canSeeRecord(context, repo, page.id)).map((page) => page.path),
    ...repo.sources.filter((source) => canSeeRecord(context, repo, source.id)).map((source) => source.path),
    ...repo.claims.filter((claim) => canSeeRecord(context, repo, claim.id)).flatMap((claim) => visibilityPathForRecordId(repo, claim.id) ?? []),
    ...repo.proposals.filter((proposal) => canSeeRecord(context, repo, proposal.id)).flatMap((proposal) => proposalVisibilityPaths(repo, proposal)),
  ], { omitEmpty: true });
}

export function canSeeRecord(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo, id: string): boolean {
  return context.policyContext === undefined || canReadRecordId(repo, context.policyContext, id);
}

export function canSeePath(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo, repoPath: string): boolean {
  return context.policyContext === undefined || canReadPathExpression(repo.policy, context.policyContext, repoPath);
}

export function canSeeValidationIssue(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo, issue: ValidationIssue): boolean {
  return issue.path === undefined || canSeePath(context, repo, issue.path);
}

export function canProposeDreamPage(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo, repoPath: string): boolean {
  if (context.policyContext === undefined) {
    return true;
  }
  try {
    assertPathAuthorized("wiki.propose_edit", context.policyContext, repo.policy, repoPath);
    return true;
  } catch {
    return false;
  }
}

export function assertCanProposeDreamPage(context: DreamVisibilityContext, repo: LoadedOpenWikiRepo, repoPath: string): void {
  if (context.policyContext !== undefined) {
    assertPathAuthorized("wiki.propose_edit", context.policyContext, repo.policy, repoPath);
  }
}

export function candidateVisibleFromPage(repo: LoadedOpenWikiRepo, fromPath: string, candidateId: string): boolean {
  const candidatePath = visibilityPathForRecordId(repo, candidateId);
  return candidatePath === undefined || visibilityRank(pathVisibility(repo.policy, candidatePath)) <= visibilityRank(pathVisibility(repo.policy, fromPath));
}

export function knownDreamRecord(repo: LoadedOpenWikiRepo, id: string): boolean {
  return repo.pages.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.sources.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.claims.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.proposals.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.decisions.some((candidate) => candidate.id === id || candidate.uri === id);
}

function proposalVisibilityPaths(repo: LoadedOpenWikiRepo, proposal: ProposalRecord): string[] {
  if (proposal.target_path !== undefined) {
    return [proposal.target_path];
  }
  const targetPaths = proposal.target_ids.flatMap((targetId) => visibilityPathForRecordId(repo, targetId) ?? []);
  return targetPaths.length > 0 ? targetPaths : [proposal.path];
}

function visibilityPathForRecordId(repo: LoadedOpenWikiRepo, id: string): string | undefined {
  const page = repo.pages.find((candidate) => candidate.id === id || candidate.uri === id);
  if (page !== undefined) {
    return page.path;
  }
  const source = repo.sources.find((candidate) => candidate.id === id || candidate.uri === id);
  if (source !== undefined) {
    return source.path;
  }
  const claim = repo.claims.find((candidate) => candidate.id === id || candidate.uri === id);
  if (claim !== undefined) {
    return repo.pages.find((page) => page.id === claim.page_id || page.uri === claim.page_id)?.path;
  }
  return undefined;
}

function visibilityRank(visibility: "public" | "internal" | "private"): number {
  return visibility === "public" ? 0 : visibility === "internal" ? 1 : 2;
}
