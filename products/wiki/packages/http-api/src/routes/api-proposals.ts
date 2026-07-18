import { boundedNumberQuery, decisionBody, numberQuery, objectBody, optionalBooleanProperty, optionalRequestActor, optionalStringArrayProperty, optionalStringProperty, paginateOffsetItems, proposalStatusesQuery, searchOffsetFromCursor, stringBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import { synthesisTargetPath } from "@openwiki/core";
import { listProposalComments, readPage, readProposal } from "@openwiki/repo";
import { applyProposal, closeProposal, commentOnProposal, createSynthesis, proposeEdit, proposeSynthesis, reviewProposal } from "@openwiki/workflows";
import { authorizeHttp, authorizeHttpPath, authorizeHttpReview } from "../auth.ts";
import { HTTP_PROPOSAL_LIMIT_MAX } from "../constants.ts";
import { authorizeHttpVisibleRecord, listVisibleProposals } from "../data-access.ts";
import { proposalActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeApiProposalMutationRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/api/v1/proposals") {
    const auth = authorizeHttp("wiki.list_proposals", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 50, 1, HTTP_PROPOSAL_LIMIT_MAX);
    const actorId = url.searchParams.get("actor_id") ?? undefined;
    const targetId = url.searchParams.get("target_id") ?? undefined;
    const targetPath = url.searchParams.get("target_path") ?? undefined;
    const sectionId = url.searchParams.get("section_id") ?? undefined;
    const updatedAfter = url.searchParams.get("updated_after") ?? undefined;
    const statuses = proposalStatusesQuery(url);
    const cursorOffset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    return {
      status: 200,
      body: await listVisibleProposals(root, policy, {
        ...(statuses === undefined ? {} : { statuses }),
        limit,
        offset: cursorOffset,
        ...(actorId === undefined ? {} : { actorId }),
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetPath === undefined ? {} : { targetPath }),
        ...(sectionId === undefined ? {} : { sectionId }),
        ...(updatedAfter === undefined ? {} : { updatedAfter }),
      }),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/proposals") {
    const auth = authorizeHttp("wiki.propose_edit", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const page = await readPage(root, stringBody(params, "page_id"));
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_edit", policy, page.path);
    if (pathAuth) {
      return pathAuth;
    }
    return {
      status: 201,
      body: await proposeEdit({
        root,
        pageId: page.id,
        body: stringBody(params, "body"),
        ...optionalStringProperty(params, "title", "title"),
        ...optionalStringProperty(params, "summary", "summary"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
      }),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/synthesis/create") {
    const auth = authorizeHttp("wiki.create_synthesis", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const synthesisPath = synthesisTargetPath(stringBody(params, "title"), typeof params.page_type === "string" && params.page_type.trim() ? params.page_type.trim() : "concept");
    const pathAuth = await authorizeHttpPath(root, "wiki.create_synthesis", policy, synthesisPath);
    if (pathAuth) {
      return pathAuth;
    }
    return {
      status: 201,
      body: await createSynthesis({
        root,
        title: stringBody(params, "title"),
        body: stringBody(params, "body"),
        ...optionalStringProperty(params, "page_type", "pageType"),
        ...optionalStringProperty(params, "summary", "summary"),
        ...optionalStringArrayProperty(params, "topics", "topics"),
        ...optionalStringArrayProperty(params, "source_ids", "sourceIds"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
        ...optionalStringProperty(params, "decision_rationale", "decisionRationale"),
        ...optionalBooleanProperty(params, "commit", "commit"),
        ...optionalStringProperty(params, "message", "message"),
      }),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/synthesis") {
    const auth = authorizeHttp("wiki.propose_synthesis", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const synthesisPath = synthesisTargetPath(stringBody(params, "title"), typeof params.page_type === "string" && params.page_type.trim() ? params.page_type.trim() : "concept");
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_synthesis", policy, synthesisPath);
    if (pathAuth) {
      return pathAuth;
    }
    return {
      status: 201,
      body: await proposeSynthesis({
        root,
        title: stringBody(params, "title"),
        body: stringBody(params, "body"),
        ...optionalStringProperty(params, "page_type", "pageType"),
        ...optionalStringProperty(params, "summary", "summary"),
        ...optionalStringArrayProperty(params, "topics", "topics"),
        ...optionalStringArrayProperty(params, "source_ids", "sourceIds"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
      }),
    };
  }

  const proposalReviewId = proposalActionId(url.pathname, "review");
  if (method === "POST" && proposalReviewId) {
    const proposal = await readProposal(root, proposalReviewId);
    const auth = await authorizeHttpReview(root, policy, proposal);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await reviewProposal({
        root,
        proposalId: proposalReviewId,
        decision: decisionBody(params, "decision"),
        rationale: stringBody(params, "rationale"),
        ...optionalRequestActor(policy, params),
      }),
    };
  }

  const proposalCloseId = proposalActionId(url.pathname, "close");
  if (method === "POST" && proposalCloseId) {
    const proposal = await readProposal(root, proposalCloseId);
    const auth = await authorizeHttpReview(root, policy, proposal);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await closeProposal({
        root,
        proposalId: proposalCloseId,
        rationale: stringBody(params, "rationale"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "superseded_by", "supersededBy"),
        ...(typeof params.superseded_by === "string" && params.superseded_by.trim() ? { resolution: "superseded" as const } : {}),
      }),
    };
  }

  const proposalApplyId = proposalActionId(url.pathname, "apply");
  if (method === "POST" && proposalApplyId) {
    const proposal = await readProposal(root, proposalApplyId);
    const auth = await authorizeHttpPath(root, "wiki.apply_proposal", policy, proposal.target_path ?? proposal.path);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await applyProposal({
        root,
        proposalId: proposalApplyId,
        ...optionalRequestActor(policy, params),
        ...optionalBooleanProperty(params, "commit", "commit"),
        ...optionalStringProperty(params, "message", "message"),
      }),
    };
  }

  const proposalCommentsId = proposalActionId(url.pathname, "comments");
  if (method === "GET" && proposalCommentsId) {
    const auth = authorizeHttp("wiki.read_proposal", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, proposalCommentsId);
    if (recordAuth) {
      return recordAuth;
    }
    const limit = boundedNumberQuery(url, "limit", 50, 1, 100);
    const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    const response = await listProposalComments(root, proposalCommentsId);
    const page = paginateOffsetItems(response.comments, limit, offset);
    return {
      status: 200,
      body: {
        comments: page.items,
        total: response.total,
        ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
      },
    };
  }

  if (method === "POST" && proposalCommentsId) {
    const auth = authorizeHttp("wiki.comment_on_proposal", policy);
    if (auth) {
      return auth;
    }
    const proposal = await readProposal(root, proposalCommentsId);
    const pathAuth = await authorizeHttpPath(root, "wiki.comment_on_proposal", policy, proposal.target_path ?? proposal.path);
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await commentOnProposal({
        root,
        proposalId: proposalCommentsId,
        body: stringBody(params, "body"),
        ...optionalRequestActor(policy, params),
      }),
    };
  }
  return undefined;
}
