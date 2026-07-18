import { numberQuery } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import { OpenWikiPolicyDeniedError, type ClaimRecord, type DecisionRecord, type FactRecord, type PageRecord, type ProposalRecord, type TakeRecord } from "@openwiki/core";
import { readCurrentPostgresRecord, readCurrentPostgresSource } from "@openwiki/postgres-runtime";
import { loadRepository, readClaim, readDecision, readFact, readPage, readProposal, readProposalDetailWithOptions, readSource, readSourceContent, readTake, traceClaim, type ProposalDetail } from "@openwiki/repo";
import { pathAllowedByContextBounds } from "@openwiki/policy";
import { authorizeHttp, authorizeHttpPath, forbidden, httpPolicyContext, httpRouteErrorMessage, policyDeniedHttpResult } from "../auth.ts";
import { authorizeHttpVisibleRecord, diffVersionsRouteResult, filterClaimTraceByPolicy, pagedHistory } from "../data-access.ts";
import { pathId, proposalActionId, recordActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeApiRecordRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const policy = input.policy;
  const pageId = pathId(url.pathname, "/api/v1/pages/");
  const pageHistoryId = recordActionId(url.pathname, "/api/v1/pages/", "history");
  if (method === "GET" && pageHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, pageHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, pageHistoryId, url) };
  }

  const pageDiffId = recordActionId(url.pathname, "/api/v1/pages/", "diff");
  if (method === "GET" && pageDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, pageDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, pageDiffId, url);
  }

  const sourceHistoryId = recordActionId(url.pathname, "/api/v1/sources/", "history");
  if (method === "GET" && sourceHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, sourceHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, sourceHistoryId, url) };
  }

  const sourceDiffId = recordActionId(url.pathname, "/api/v1/sources/", "diff");
  if (method === "GET" && sourceDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, sourceDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, sourceDiffId, url);
  }

  const sourceContentId = recordActionId(url.pathname, "/api/v1/sources/", "content");
  if (method === "GET" && sourceContentId) {
    const auth = authorizeHttp("wiki.read_source", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, sourceContentId);
    if (recordAuth) {
      return recordAuth;
    }
    const maxBytes = numberQuery(url, "max_bytes");
    try {
      return {
        status: 200,
        body: await readSourceContent(root, sourceContentId, {
          ...(maxBytes === undefined ? {} : { maxBytes }),
          authorizePath: async (repoPath) => {
            const artifactAuth = await authorizeHttpPath(root, "wiki.read_source", policy, repoPath);
            if (artifactAuth) {
              throw new OpenWikiPolicyDeniedError(httpRouteErrorMessage(artifactAuth));
            }
          },
        }),
      };
    } catch (error) {
      return policyDeniedHttpResult(error);
    }
  }

  const claimHistoryId = recordActionId(url.pathname, "/api/v1/claims/", "history");
  if (method === "GET" && claimHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, claimHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, claimHistoryId, url) };
  }

  const claimDiffId = recordActionId(url.pathname, "/api/v1/claims/", "diff");
  if (method === "GET" && claimDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, claimDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, claimDiffId, url);
  }

  const claimTraceId = recordActionId(url.pathname, "/api/v1/claims/", "trace");
  if (method === "GET" && claimTraceId) {
    const auth = authorizeHttp("wiki.trace_claim", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, claimTraceId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await filterClaimTraceByPolicy(root, policy, await traceClaim(root, claimTraceId)) };
  }

  const factHistoryId = recordActionId(url.pathname, "/api/v1/facts/", "history");
  if (method === "GET" && factHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, factHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, factHistoryId, url) };
  }

  const factDiffId = recordActionId(url.pathname, "/api/v1/facts/", "diff");
  if (method === "GET" && factDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, factDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, factDiffId, url);
  }

  const takeHistoryId = recordActionId(url.pathname, "/api/v1/takes/", "history");
  if (method === "GET" && takeHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, takeHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, takeHistoryId, url) };
  }

  const takeDiffId = recordActionId(url.pathname, "/api/v1/takes/", "diff");
  if (method === "GET" && takeDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, takeDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, takeDiffId, url);
  }

  const decisionHistoryId = recordActionId(url.pathname, "/api/v1/decisions/", "history");
  if (method === "GET" && decisionHistoryId) {
    const auth = authorizeHttp("wiki.get_history", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, decisionHistoryId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await pagedHistory(root, decisionHistoryId, url) };
  }

  const decisionDiffId = recordActionId(url.pathname, "/api/v1/decisions/", "diff");
  if (method === "GET" && decisionDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, decisionDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return diffVersionsRouteResult(root, decisionDiffId, url);
  }

  if (method === "GET" && pageId) {
    const page = (await readCurrentPostgresRecord<PageRecord>(root, pageId, "page")) ?? (await readPage(root, pageId));
    const auth = await authorizeHttpPath(root, "wiki.read_page", policy, page.path);
    if (auth) {
      return auth;
    }
    return { status: 200, body: page };
  }

  const sourceId = pathId(url.pathname, "/api/v1/sources/");
  if (method === "GET" && sourceId) {
    const auth = authorizeHttp("wiki.read_source", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, sourceId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresSource(root, sourceId)) ?? (await readSource(root, sourceId)) };
  }

  const claimId = pathId(url.pathname, "/api/v1/claims/");
  if (method === "GET" && claimId) {
    const auth = authorizeHttp("wiki.read_claim", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, claimId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresRecord<ClaimRecord>(root, claimId, "claim")) ?? (await readClaim(root, claimId)) };
  }

  const factId = pathId(url.pathname, "/api/v1/facts/");
  if (method === "GET" && factId) {
    const auth = authorizeHttp("wiki.read_fact", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, factId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresRecord<FactRecord>(root, factId, "fact")) ?? (await readFact(root, factId)) };
  }

  const takeId = pathId(url.pathname, "/api/v1/takes/");
  if (method === "GET" && takeId) {
    const auth = authorizeHttp("wiki.read_take", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, takeId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresRecord<TakeRecord>(root, takeId, "take")) ?? (await readTake(root, takeId)) };
  }

  const proposalDetailId = proposalActionId(url.pathname, "detail");
  if (method === "GET" && proposalDetailId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalDetailId);
    if (recordAuth) {
      return recordAuth;
    }
    return proposalDetailRouteResult(root, policy, proposalDetailId);
  }

  const proposalDiffId = proposalActionId(url.pathname, "diff");
  if (method === "GET" && proposalDiffId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    const detailResult = await proposalDetailForHttp(root, policy, proposalDiffId);
    if (detailResult.failure) {
      return detailResult.failure;
    }
    const detail = detailResult.detail;
    return { status: 200, body: { proposal_id: detail.proposal.id, diff: detail.diff } };
  }

  const proposalSnapshotId = proposalActionId(url.pathname, "snapshot");
  if (method === "GET" && proposalSnapshotId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalSnapshotId);
    if (recordAuth) {
      return recordAuth;
    }
    const detailResult = await proposalDetailForHttp(root, policy, proposalSnapshotId);
    if (detailResult.failure) {
      return detailResult.failure;
    }
    const detail = detailResult.detail;
    return { status: 200, body: { proposal_id: detail.proposal.id, snapshot: detail.snapshot, snapshots: detail.snapshots } };
  }

  const proposalValidationId = proposalActionId(url.pathname, "validation");
  if (method === "GET" && proposalValidationId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalValidationId);
    if (recordAuth) {
      return recordAuth;
    }
    const detailResult = await proposalDetailForHttp(root, policy, proposalValidationId);
    if (detailResult.failure) {
      return detailResult.failure;
    }
    const detail = detailResult.detail;
    return { status: 200, body: { proposal_id: detail.proposal.id, validation_report: detail.validation_report } };
  }

  const proposalId = pathId(url.pathname, "/api/v1/proposals/");
  if (method === "GET" && proposalId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresRecord<ProposalRecord>(root, proposalId, "proposal")) ?? (await readProposal(root, proposalId)) };
  }

  const decisionId = pathId(url.pathname, "/api/v1/decisions/");
  if (method === "GET" && decisionId) {
    const auth = authorizeHttp("wiki.read_decision", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, decisionId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresRecord<DecisionRecord>(root, decisionId, "decision")) ?? (await readDecision(root, decisionId)) };
  }
  return undefined;
}

class ProposalArtifactAuthorizationError extends Error {
  readonly result: HttpRouteResult;

  constructor(result: HttpRouteResult) {
    super(httpRouteErrorMessage(result));
    this.name = "ProposalArtifactAuthorizationError";
    this.result = result;
  }
}

async function proposalDetailRouteResult(root: string, policy: HttpRouteHandlerContext["policy"], id: string): Promise<HttpRouteResult> {
  const result = await proposalDetailForHttp(root, policy, id);
  if (result.failure) {
    return result.failure;
  }
  return { status: 200, body: result.detail };
}

async function proposalDetailForHttp(
  root: string,
  policy: HttpRouteHandlerContext["policy"],
  id: string,
): Promise<{ detail: ProposalDetail; failure?: never } | { failure: HttpRouteResult }> {
  try {
    const repo = await loadRepository(root);
    const context = httpPolicyContext(policy);
    const proposal = repo.proposals.find((candidate) => candidate.id === id || candidate.uri === id);
    return {
      detail: await readProposalDetailWithOptions(root, id, {
        authorizePath(repoPath) {
          if (proposal !== undefined && !proposalArtifactBelongsToProposal(proposal, repoPath)) {
            throw new ProposalArtifactAuthorizationError(forbidden(`OpenWiki proposal artifact path is not bound to proposal ${proposal.id}: ${repoPath}`));
          }
          if (!pathAllowedByContextBounds(repo.policy, context, repoPath)) {
            throw new ProposalArtifactAuthorizationError(forbidden(`OpenWiki policy bounds do not allow proposal artifact path ${repoPath}`));
          }
        },
      }),
    };
  } catch (error) {
    if (error instanceof ProposalArtifactAuthorizationError) {
      return { failure: error.result };
    }
    throw error;
  }
}

function proposalArtifactBelongsToProposal(proposal: ProposalRecord, repoPath: string): boolean {
  const stem = proposal.id.replace(/:/g, "_").replace(/-/g, "_");
  return (
    repoPath === `proposals/diffs/${stem}.diff` ||
    repoPath === `proposals/reports/${stem}.json` ||
    repoPath === `proposals/validation/${stem}.json` ||
    repoPath.startsWith(`proposals/snapshots/${stem}/`)
  );
}
