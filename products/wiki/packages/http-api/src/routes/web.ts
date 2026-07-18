import { decisionBody, objectBody, optionalAuditActor, optionalBooleanBody, optionalNonEmptyStringProperty, optionalPolicyActor, optionalRequestActor, optionalStringProperty, policyFileBody, redirect, stringBody, stringListBody, visibilityBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import type { PageRecord } from "@openwiki/core";
import { readCurrentPostgresRecordEntry, readCurrentPostgresSource } from "@openwiki/postgres-runtime";
import { readClaim, readDecision, readPage, readProposal, readSource } from "@openwiki/repo";
import { applyProposal, closeProposal, commentOnProposal, ignoreInboxItem, processInboxItem, proposeEdit, proposePolicyChange, proposeSectionPolicy, retryInboxItem, reviewProposal, revokeServiceAccountToken } from "@openwiki/workflows";
import { authorizeHttp, authorizeHttpPath, authorizeHttpReview, httpCanReadPostgresRecordEntry, httpCanSeeUnfilteredIndex, httpPolicyContext } from "../auth.ts";
import { authorizeHttpInboxAction, authorizeHttpInboxProcess, authorizeHttpVisibleRecord } from "../data-access.ts";
import { renderInboxPage, renderInboxView, renderProposalQueuePage, renderProposalView, renderRunsPage, renderRunView } from "../renderers/activity.ts";
import { renderAdminPage, renderServiceAccountsPage, renderSpacesPage, renderSpacesPreviewPage } from "../renderers/admin.ts";
import { renderClaimView, renderDashboardPage, renderDecisionView, renderPageEditForm, renderPageView, renderProposalDiffPage, renderRecordDiffRouteResult, renderSourceView, renderWorkspaceGraphPage } from "../renderers/content.ts";
import { adjacentJsonId, adjacentPageId, pageRepresentation, pathId, publicPageRoute, webActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeWebCoreRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/") {
    const auth = authorizeHttp("wiki.read_page", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderDashboardPage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && url.pathname === "/admin") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderAdminPage(root, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && url.pathname === "/admin/service-accounts") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderServiceAccountsPage(root, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "POST" && url.pathname === "/admin/service-accounts/revoke") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    await revokeServiceAccountToken({
      root,
      id: stringBody(params, "id"),
      ...optionalNonEmptyStringProperty(params, "token_id", "tokenId"),
      ...optionalNonEmptyStringProperty(params, "reason", "reason"),
      ...optionalAuditActor(policy),
    });
    return redirect("/admin/service-accounts?revoked=1");
  }

  if (method === "GET" && url.pathname === "/graph") {
    const auth = authorizeHttp("wiki.graph_neighbors", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderWorkspaceGraphPage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && url.pathname === "/inbox") {
    const auth = authorizeHttp("wiki.inbox_list", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderInboxPage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  const inboxProcessId = webActionId(url.pathname, "/inbox/", "process");
  if (method === "POST" && inboxProcessId) {
    const auth = authorizeHttp("wiki.inbox_process", policy);
    if (auth) {
      return auth;
    }
    const inboxProcessAuth = await authorizeHttpInboxProcess(root, policy, inboxProcessId);
    if (inboxProcessAuth) {
      return inboxProcessAuth;
    }
    await processInboxItem({ root, id: inboxProcessId, ...optionalPolicyActor(policy), policyContext: httpPolicyContext(policy) });
    return redirect(`/inbox/${encodeURIComponent(inboxProcessId)}`);
  }

  const inboxIgnoreId = webActionId(url.pathname, "/inbox/", "ignore");
  if (method === "POST" && inboxIgnoreId) {
    const auth = authorizeHttp("wiki.inbox_ignore", policy);
    if (auth) {
      return auth;
    }
    const inboxIgnoreAuth = await authorizeHttpInboxAction(root, "wiki.inbox_ignore", policy, inboxIgnoreId);
    if (inboxIgnoreAuth) {
      return inboxIgnoreAuth;
    }
    const params = objectBody(body);
    await ignoreInboxItem({
      root,
      id: inboxIgnoreId,
      ...optionalPolicyActor(policy),
      ...optionalNonEmptyStringProperty(params, "reason", "reason"),
    });
    return redirect(`/inbox/${encodeURIComponent(inboxIgnoreId)}`);
  }

  const inboxRetryId = webActionId(url.pathname, "/inbox/", "retry");
  if (method === "POST" && inboxRetryId) {
    const auth = authorizeHttp("wiki.inbox_retry", policy);
    if (auth) {
      return auth;
    }
    const inboxRetryAuth = await authorizeHttpInboxAction(root, "wiki.inbox_retry", policy, inboxRetryId);
    if (inboxRetryAuth) {
      return inboxRetryAuth;
    }
    await retryInboxItem({ root, id: inboxRetryId, ...optionalPolicyActor(policy) });
    return redirect(`/inbox/${encodeURIComponent(inboxRetryId)}`);
  }

  const inboxId = pathId(url.pathname, "/inbox/");
  if (method === "GET" && inboxId) {
    const auth = authorizeHttp("wiki.inbox_read", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, inboxId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderInboxView(root, inboxId, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && url.pathname === "/spaces/preview") {
    const auth = authorizeHttp("wiki.preview_permissions", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderSpacesPreviewPage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && (url.pathname === "/spaces" || url.pathname === "/policy")) {
    const auth = authorizeHttp("wiki.read_policy", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderSpacesPage(root, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "POST" && url.pathname === "/policy/propose") {
    const auth = authorizeHttp("wiki.propose_policy", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const result = await proposePolicyChange({
      root,
      policyFile: policyFileBody(params, "policy_file"),
      body: stringBody(params, "body"),
      ...optionalRequestActor(policy, params),
      ...optionalNonEmptyStringProperty(params, "rationale", "rationale"),
    });
    return redirect(`/proposals/${encodeURIComponent(result.proposal.id)}`);
  }

  if (method === "POST" && url.pathname === "/policy/sections/propose") {
    const auth = authorizeHttp("wiki.propose_section_policy", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const result = await proposeSectionPolicy({
      root,
      sectionId: stringBody(params, "section_id"),
      title: stringBody(params, "title"),
      paths: stringListBody(params, "paths"),
      visibility: visibilityBody(params, "visibility"),
      ...optionalNonEmptyStringProperty(params, "owner_principal", "ownerPrincipal"),
      viewerPrincipals: stringListBody(params, "viewer_principals"),
      contributorPrincipals: stringListBody(params, "contributor_principals"),
      researcherPrincipals: stringListBody(params, "researcher_principals"),
      reviewerPrincipals: stringListBody(params, "reviewer_principals"),
      maintainerPrincipals: stringListBody(params, "maintainer_principals"),
      adminPrincipals: stringListBody(params, "admin_principals"),
      requiredReviewerPrincipals: stringListBody(params, "required_reviewer_principals"),
      ...(optionalBooleanBody(params, "replace_grants") === true ? { replaceGrants: true } : {}),
      ...optionalRequestActor(policy, params),
      ...optionalNonEmptyStringProperty(params, "rationale", "rationale"),
    });
    return redirect(`/proposals/${encodeURIComponent(result.proposal.id)}`);
  }
  const adjacentPage = adjacentPageId(url.pathname, "/pages/");
  if (method === "GET" && adjacentPage) {
    const auth = authorizeHttp("wiki.read_page", policy);
    if (auth) {
      return auth;
    }
    const page = await readPage(root, adjacentPage.id);
    const pathAuth = await authorizeHttpPath(root, "wiki.read_page", policy, page.path);
    if (pathAuth) {
      return pathAuth;
    }
    return pageRepresentation(page, adjacentPage.format);
  }

  const publicPage = await publicPageRoute(root, url.pathname);
  if (method === "GET" && publicPage) {
    const auth = authorizeHttp("wiki.read_page", policy);
    if (auth) {
      return auth;
    }
    const pathAuth = await authorizeHttpPath(root, "wiki.read_page", policy, publicPage.page.path);
    if (pathAuth) {
      return pathAuth;
    }
    return pageRepresentation(publicPage.page, publicPage.format);
  }

  const adjacentSource = adjacentJsonId(url.pathname, "/sources/");
  if (method === "GET" && adjacentSource) {
    const auth = authorizeHttp("wiki.read_source", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, adjacentSource);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: (await readCurrentPostgresSource(root, adjacentSource)) ?? (await readSource(root, adjacentSource)) };
  }

  const adjacentClaim = adjacentJsonId(url.pathname, "/claims/");
  if (method === "GET" && adjacentClaim) {
    const auth = authorizeHttp("wiki.read_claim", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, adjacentClaim);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await readClaim(root, adjacentClaim) };
  }

  const adjacentDecision = adjacentJsonId(url.pathname, "/decisions/");
  if (method === "GET" && adjacentDecision) {
    const auth = authorizeHttp("wiki.read_decision", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, adjacentDecision);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await readDecision(root, adjacentDecision) };
  }

  const webPageEditId = webActionId(url.pathname, "/pages/", "edit");
  if (method === "GET" && webPageEditId) {
    const auth = authorizeHttp("wiki.propose_edit", policy);
    if (auth) {
      return auth;
    }
    const page = await readPage(root, webPageEditId);
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_edit", policy, page.path);
    if (pathAuth) {
      return pathAuth;
    }
    return { status: 200, body: await renderPageEditForm(root, webPageEditId, policy), contentType: "text/html; charset=utf-8" };
  }

  const webPageProposeId = webActionId(url.pathname, "/pages/", "propose");
  if (method === "POST" && webPageProposeId) {
    const auth = authorizeHttp("wiki.propose_edit", policy);
    if (auth) {
      return auth;
    }
    const page = await readPage(root, webPageProposeId);
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_edit", policy, page.path);
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    const result = await proposeEdit({
      root,
      pageId: webPageProposeId,
      body: stringBody(params, "body"),
      ...optionalNonEmptyStringProperty(params, "title", "title"),
      ...optionalStringProperty(params, "summary", "summary"),
      ...optionalRequestActor(policy, params),
      ...optionalNonEmptyStringProperty(params, "rationale", "rationale"),
    });
    return redirect(`/proposals/${encodeURIComponent(result.proposal.id)}`);
  }

  const webPageDiffId = webActionId(url.pathname, "/pages/", "diff");
  if (method === "GET" && webPageDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webPageDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return renderRecordDiffRouteResult(root, webPageDiffId, "/pages/" + encodeURIComponent(webPageDiffId), url, policy);
  }

  const webPageId = pathId(url.pathname, "/pages/");
  if (method === "GET" && webPageId) {
    if (!httpCanSeeUnfilteredIndex(policy)) {
      const postgresPage = await readCurrentPostgresRecordEntry<PageRecord>(root, webPageId, "page");
      if (postgresPage === undefined || !httpCanReadPostgresRecordEntry(policy, postgresPage)) {
        const page = await readPage(root, webPageId);
        const auth = await authorizeHttpPath(root, "wiki.read_page", policy, page.path);
        if (auth) {
          return auth;
        }
      }
    }
    return { status: 200, body: await renderPageView(root, webPageId, policy), contentType: "text/html; charset=utf-8" };
  }
  return undefined;
}

export async function routeWebRecordRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/proposals") {
    const auth = authorizeHttp("wiki.list_proposals", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderProposalQueuePage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  if (method === "GET" && url.pathname === "/runs") {
    const auth = authorizeHttp("wiki.list_runs", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderRunsPage(root, url, policy), contentType: "text/html; charset=utf-8" };
  }

  const webRunId = pathId(url.pathname, "/runs/");
  if (method === "GET" && webRunId) {
    const auth = authorizeHttp("wiki.list_runs", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await renderRunView(root, webRunId, policy), contentType: "text/html; charset=utf-8" };
  }

  const adjacentProposal = adjacentJsonId(url.pathname, "/proposals/");
  if (method === "GET" && adjacentProposal) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, adjacentProposal);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await readProposal(root, adjacentProposal) };
  }

  const webProposalReviewId = webActionId(url.pathname, "/proposals/", "review");
  if (method === "POST" && webProposalReviewId) {
    const proposal = await readProposal(root, webProposalReviewId);
    const auth = await authorizeHttpReview(root, policy, proposal);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    await reviewProposal({
      root,
      proposalId: webProposalReviewId,
      decision: decisionBody(params, "decision"),
      rationale: stringBody(params, "rationale"),
      ...optionalRequestActor(policy, params),
    });
    return redirect(`/proposals/${encodeURIComponent(webProposalReviewId)}`);
  }

  const webProposalCloseId = webActionId(url.pathname, "/proposals/", "close");
  if (method === "POST" && webProposalCloseId) {
    const proposal = await readProposal(root, webProposalCloseId);
    const auth = await authorizeHttpReview(root, policy, proposal);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    await closeProposal({
      root,
      proposalId: webProposalCloseId,
      rationale: stringBody(params, "rationale"),
      ...optionalRequestActor(policy, params),
      ...optionalNonEmptyStringProperty(params, "superseded_by", "supersededBy"),
      ...(typeof params.superseded_by === "string" && params.superseded_by.trim() ? { resolution: "superseded" as const } : {}),
    });
    return redirect(`/proposals/${encodeURIComponent(webProposalCloseId)}`);
  }

  const webProposalApplyId = webActionId(url.pathname, "/proposals/", "apply");
  if (method === "POST" && webProposalApplyId) {
    const proposal = await readProposal(root, webProposalApplyId);
    const auth = await authorizeHttpPath(root, "wiki.apply_proposal", policy, proposal.target_path ?? proposal.path);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    await applyProposal({
      root,
      proposalId: webProposalApplyId,
      ...optionalRequestActor(policy, params),
    });
    return redirect(`/proposals/${encodeURIComponent(webProposalApplyId)}`);
  }

  const webProposalCommentId = webActionId(url.pathname, "/proposals/", "comment");
  if (method === "POST" && webProposalCommentId) {
    const auth = authorizeHttp("wiki.comment_on_proposal", policy);
    if (auth) {
      return auth;
    }
    const proposal = await readProposal(root, webProposalCommentId);
    const pathAuth = await authorizeHttpPath(root, "wiki.comment_on_proposal", policy, proposal.target_path ?? proposal.path);
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    await commentOnProposal({
      root,
      proposalId: webProposalCommentId,
      body: stringBody(params, "body"),
      ...optionalRequestActor(policy, params),
    });
    return redirect(`/proposals/${encodeURIComponent(webProposalCommentId)}`);
  }

  const webProposalDiffId = webActionId(url.pathname, "/proposals/", "diff");
  if (method === "GET" && webProposalDiffId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webProposalDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderProposalDiffPage(root, webProposalDiffId, policy), contentType: "text/html; charset=utf-8" };
  }

  const webProposalId = pathId(url.pathname, "/proposals/");
  if (method === "GET" && webProposalId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webProposalId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderProposalView(root, webProposalId, policy), contentType: "text/html; charset=utf-8" };
  }

  const webSourceDiffId = webActionId(url.pathname, "/sources/", "diff");
  if (method === "GET" && webSourceDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webSourceDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return renderRecordDiffRouteResult(root, webSourceDiffId, "/sources/" + encodeURIComponent(webSourceDiffId), url, policy);
  }

  const webSourceId = pathId(url.pathname, "/sources/");
  if (method === "GET" && webSourceId) {
    const auth = authorizeHttp("wiki.read_source", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webSourceId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderSourceView(root, webSourceId, policy), contentType: "text/html; charset=utf-8" };
  }

  const webClaimDiffId = webActionId(url.pathname, "/claims/", "diff");
  if (method === "GET" && webClaimDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webClaimDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return renderRecordDiffRouteResult(root, webClaimDiffId, "/claims/" + encodeURIComponent(webClaimDiffId), url, policy);
  }

  const webClaimId = pathId(url.pathname, "/claims/");
  if (method === "GET" && webClaimId) {
    const auth = authorizeHttp("wiki.read_claim", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webClaimId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderClaimView(root, webClaimId, policy), contentType: "text/html; charset=utf-8" };
  }

  const webDecisionDiffId = webActionId(url.pathname, "/decisions/", "diff");
  if (method === "GET" && webDecisionDiffId) {
    const auth = authorizeHttp("wiki.diff_versions", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webDecisionDiffId);
    if (recordAuth) {
      return recordAuth;
    }
    return renderRecordDiffRouteResult(root, webDecisionDiffId, "/decisions/" + encodeURIComponent(webDecisionDiffId), url, policy);
  }

  const webDecisionId = pathId(url.pathname, "/decisions/");
  if (method === "GET" && webDecisionId) {
    const auth = authorizeHttp("wiki.read_decision", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, webDecisionId);
    if (recordAuth) {
      return recordAuth;
    }
    return { status: 200, body: await renderDecisionView(root, webDecisionId, policy), contentType: "text/html; charset=utf-8" };
  }
  return undefined;
}
