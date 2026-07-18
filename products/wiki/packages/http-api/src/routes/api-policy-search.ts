import { boundedNumberQuery, boundedOffset, numberQuery, objectBody, optionalAuditActor, optionalBooleanBody, optionalNumberBody, optionalRequestActor, optionalSearchBoolean, optionalSearchFilters, optionalSearchMode, optionalSearchPersona, optionalSearchTypes, optionalStringProperty, paginateOffsetItems, policyBody, policyFileBody, searchOffsetFromCursor, serviceAccountTokenCreateParams, stringBody, stringListBody, visibilityBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import type { SearchRequest } from "@openwiki/core";
import { listRecentChanges } from "@openwiki/git";
import { previewPermissions, summarizePolicyIdentities } from "@openwiki/policy";
import { listCurrentPostgresIdentities } from "@openwiki/postgres-runtime";
import { loadRepository } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { askWithCitations, createServiceAccountToken, inspectServiceAccountToken, listServiceAccountTokens, proposePolicyChange, proposeSectionPolicy, redactThinkSearchExplainForPolicy, revokeServiceAccountToken, rotateServiceAccountToken, thinkWithCitations } from "@openwiki/workflows";
import { authorizeHttp, httpPolicyContext, permissionPreviewContextFromUrl, permissionPreviewOperationsFromUrl, permissionPreviewPathsFromUrl, permissionPreviewRecordsFromUrl } from "../auth.ts";
import { HTTP_OFFSET_MAX, HTTP_SEARCH_LIMIT_MAX } from "../constants.ts";
import { filterRecentChangesByPolicy, listRecordsForHttp } from "../data-access.ts";
import { searchBackendForMetrics } from "../health-metrics.ts";
import { recordSearchLatencyMetric } from "../operational.ts";
import { pathId, webActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeApiPolicySearchRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/api/v1/policy/preview") {
    const auth = authorizeHttp("wiki.preview_permissions", policy);
    if (auth) {
      return auth;
    }
    const repo = await loadRepository(root);
    return {
      status: 200,
      body: {
        preview: previewPermissions(repo.policy, permissionPreviewContextFromUrl(url), {
          repo,
          paths: permissionPreviewPathsFromUrl(url),
          recordIds: permissionPreviewRecordsFromUrl(url),
          operations: permissionPreviewOperationsFromUrl(url),
        }),
      },
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/auth/service-accounts") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await listServiceAccountTokens({ root }) };
  }

  const serviceAccountId = pathId(url.pathname, "/api/v1/auth/service-accounts/");
  if (method === "GET" && serviceAccountId !== undefined && !serviceAccountId.includes("/")) {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await inspectServiceAccountToken({ root, id: serviceAccountId }) };
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/service-accounts") {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await createServiceAccountToken({
        root,
        ...serviceAccountTokenCreateParams(params),
        ...optionalAuditActor(policy),
      }),
    };
  }

  const serviceAccountRevokeId = webActionId(url.pathname, "/api/v1/auth/service-accounts/", "revoke");
  if (method === "POST" && serviceAccountRevokeId !== undefined) {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await revokeServiceAccountToken({
        root,
        id: serviceAccountRevokeId,
        ...optionalStringProperty(params, "token_id", "tokenId"),
        ...optionalStringProperty(params, "reason", "reason"),
        ...optionalAuditActor(policy),
      }),
    };
  }

  const serviceAccountRotateId = webActionId(url.pathname, "/api/v1/auth/service-accounts/", "rotate");
  if (method === "POST" && serviceAccountRotateId !== undefined) {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await rotateServiceAccountToken({
        root,
        id: serviceAccountRotateId,
        ...serviceAccountTokenCreateParams(params),
        ...optionalStringProperty(params, "token_id", "tokenId"),
        ...optionalAuditActor(policy),
      }),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/policy/identities") {
    const auth = authorizeHttp("wiki.read_policy", policy);
    if (auth) {
      return auth;
    }
    const repo = await loadRepository(root);
    const identities = (await listCurrentPostgresIdentities(root)) ?? {
      workspace_id: repo.config.workspace_id,
      ...summarizePolicyIdentities(repo.config, repo.policy),
    };
    return { status: 200, body: { identities } };
  }

  if (method === "GET" && url.pathname === "/api/v1/policy") {
    const auth = authorizeHttp("wiki.read_policy", policy);
    if (auth) {
      return auth;
    }
    const repo = await loadRepository(root);
    return { status: 200, body: { policy: repo.policy } };
  }

  if (method === "POST" && url.pathname === "/api/v1/policy/proposals") {
    const auth = authorizeHttp("wiki.propose_policy", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await proposePolicyChange({
        root,
        policyFile: policyFileBody(params, "policy_file"),
        body: policyBody(params),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
      }),
    };
  }
  if (method === "POST" && url.pathname === "/api/v1/policy/sections/proposals") {
    const auth = authorizeHttp("wiki.propose_section_policy", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await proposeSectionPolicy({
        root,
        sectionId: stringBody(params, "section_id"),
        title: stringBody(params, "title"),
        paths: stringListBody(params, "paths"),
        visibility: visibilityBody(params, "visibility"),
        ...optionalStringProperty(params, "owner_principal", "ownerPrincipal"),
        viewerPrincipals: stringListBody(params, "viewer_principals"),
        contributorPrincipals: stringListBody(params, "contributor_principals"),
        researcherPrincipals: stringListBody(params, "researcher_principals"),
        reviewerPrincipals: stringListBody(params, "reviewer_principals"),
        maintainerPrincipals: stringListBody(params, "maintainer_principals"),
        adminPrincipals: stringListBody(params, "admin_principals"),
        requiredReviewerPrincipals: stringListBody(params, "required_reviewer_principals"),
        ...(optionalBooleanBody(params, "replace_grants") === true ? { replaceGrants: true } : {}),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
      }),
    };
  }
  if (method === "GET" && url.pathname === "/api/v1/search") {
    const auth = authorizeHttp("wiki.search", policy);
    if (auth) {
      return auth;
    }
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
    const offsetRaw = url.searchParams.get("offset");
    const cursorOffset = offsetRaw === null ? searchOffsetFromCursor(url.searchParams.get("cursor")) : undefined;
    const offset = boundedOffset(offsetRaw === null ? cursorOffset : numberQuery(url, "offset"), HTTP_OFFSET_MAX);
    const searchRequest: SearchRequest = {
      query,
      limit: boundedNumberQuery(url, "limit", 20, 1, HTTP_SEARCH_LIMIT_MAX),
      ...(offset === undefined ? {} : { offset }),
      include_explain: url.searchParams.get("explain") === "true",
      include_highlights: url.searchParams.get("highlights") === "true" || url.searchParams.get("highlight") === "true",
      ...optionalSearchPersona(url),
      ...optionalSearchMode(url),
      ...optionalSearchBoolean(url, "fuzzy", "fuzzy"),
      ...optionalSearchTypes(url),
      ...optionalSearchFilters(url),
    };
    const searchStartedAt = Date.now();
    let searchStatus = "success";
    try {
      const responseBody = await searchWiki(
        root,
        searchRequest,
        { policyContext: httpPolicyContext(policy) },
      );
      recordSearchLatencyMetric(searchBackendForMetrics(responseBody), searchRequest.mode ?? "hybrid", searchStatus, Date.now() - searchStartedAt);
      return { status: 200, body: responseBody };
    } catch (error) {
      searchStatus = "error";
      recordSearchLatencyMetric("unknown", searchRequest.mode ?? "hybrid", searchStatus, Date.now() - searchStartedAt);
      throw error;
    }
  }

  if (method === "GET" && url.pathname === "/api/v1/records") {
    const auth = authorizeHttp("wiki.search", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await listRecordsForHttp(root, policy, url) };
  }

  if (method === "POST" && url.pathname === "/api/v1/ask") {
    const auth = authorizeHttp("wiki.ask", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const limit = optionalNumberBody(params, "limit");
    return {
      status: 200,
      body: await askWithCitations({
        root,
        question: stringBody(params, "question"),
        includeExplain: optionalBooleanBody(params, "include_explain") ?? false,
        policyContext: httpPolicyContext(policy),
        ...(limit === undefined ? {} : { limit }),
      }),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/think") {
    const auth = authorizeHttp("wiki.think", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const limit = optionalNumberBody(params, "limit");
    const response = await thinkWithCitations({
      root,
      question: stringBody(params, "question"),
      includeExplain: optionalBooleanBody(params, "include_explain") ?? false,
      policyContext: httpPolicyContext(policy),
      ...(limit === undefined ? {} : { limit }),
    });
    return {
      status: 200,
      body: redactThinkSearchExplainForPolicy(response),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/recent-changes") {
    const auth = authorizeHttp("wiki.list_recent_changes", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 20, 1, 100);
    const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    const visible = await filterRecentChangesByPolicy(root, policy, await listRecentChanges(root, Math.min(offset + limit + 1, 100)));
    const page = paginateOffsetItems(visible.changes, limit, offset);
    return {
      status: 200,
      body: {
        ...visible,
        changes: page.items,
        ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
      },
    };
  }

  return undefined;
}
