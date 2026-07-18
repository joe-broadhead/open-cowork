import { boundedNumberQuery, numberQuery, objectBody, optionalPolicyActor, optionalStringProperty, searchOffsetFromCursor, stringBody, visibilityBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import type { InboxItemStatus } from "@openwiki/core";
import { createRun } from "@openwiki/jobs";
import { ignoreInboxItem, processInboxItem, readInboxWorkflow, retryInboxItem, submitInboxItem } from "@openwiki/workflows";
import { authorizeHttp, httpPolicyContext } from "../auth.ts";
import { authorizeHttpInboxAction, authorizeHttpInboxProcess, authorizeHttpInboxSubmit, authorizeHttpVisibleRecord, listVisibleInboxItems } from "../data-access.ts";
import { pathId, webActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeApiInboxRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const policy = input.policy;
  const body = input.body;

  if (method === "GET" && url.pathname === "/api/v1/inbox/items") {
    const auth = authorizeHttp("wiki.inbox_list", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 50, 1, 200);
    const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    const statuses = inboxStatusesFromUrl(url);
    const ownerActorId = url.searchParams.get("owner_actor_id") ?? undefined;
    const provider = url.searchParams.get("provider") ?? undefined;
    const inboxKind = url.searchParams.get("kind") ?? undefined;
    const targetSpaceId = url.searchParams.get("target_space_id") ?? undefined;
    return {
      status: 200,
      body: await listVisibleInboxItems(root, policy, {
        ...(statuses === undefined ? {} : { statuses }),
        ...(ownerActorId === undefined ? {} : { ownerActorId }),
        ...(provider === undefined ? {} : { provider }),
        ...(inboxKind === undefined ? {} : { inboxKind }),
        ...(targetSpaceId === undefined ? {} : { targetSpaceId }),
        limit,
        offset,
      }),
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/inbox/items") {
    const auth = authorizeHttp("wiki.inbox_submit", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const ownerActorId = typeof params.owner_actor_id === "string" ? params.owner_actor_id : policy.actorId;
    const submittedBy = policy.actorId;
    const targetSpace = optionalStringProperty(params, "target_space_id", "targetSpaceId");
    const targetPathInput = optionalStringProperty(params, "target_path", "targetPath");
    const targetSpaceId = targetSpace.targetSpaceId;
    const targetPath = targetPathInput.targetPath;
    const inboxSubmitAuth = await authorizeHttpInboxSubmit(root, policy, {
      ...(ownerActorId === undefined ? {} : { ownerActorId }),
      ...(targetSpaceId === undefined ? {} : { targetSpaceId }),
      ...(targetPath === undefined ? {} : { targetPath }),
    });
    if (inboxSubmitAuth) {
      return inboxSubmitAuth;
    }
    const sensitivity = visibilityBody(params, "sensitivity");
    return {
      status: 201,
      body: await submitInboxItem({
        root,
        title: stringBody(params, "title"),
        ...optionalStringProperty(params, "content", "content"),
        ...optionalStringProperty(params, "kind", "inboxKind"),
        ...optionalStringProperty(params, "provider", "provider"),
        ...optionalStringProperty(params, "adapter", "adapter"),
        ...(ownerActorId === undefined ? {} : { ownerActorId }),
        ...(submittedBy === undefined ? {} : { submittedBy }),
        ...targetSpace,
        ...targetPathInput,
        ...optionalStringProperty(params, "external_id", "externalId"),
        ...optionalStringProperty(params, "origin", "origin"),
        ...optionalStringProperty(params, "source_url", "sourceUrl"),
        ...optionalStringProperty(params, "idempotency_key", "idempotencyKey"),
        ...optionalStringProperty(params, "media_type", "mediaType"),
        ...(sensitivity === undefined ? {} : { sensitivity }),
        ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata) ? { metadata: params.metadata as Record<string, unknown> } : {}),
      }),
    };
  }

  const detailId = pathId(url.pathname, "/api/v1/inbox/items/");
  if (method === "GET" && detailId) {
    const auth = authorizeHttp("wiki.inbox_read", policy);
    if (auth) {
      return auth;
    }
    const recordAuth = await authorizeHttpVisibleRecord(root, policy, detailId);
    if (recordAuth) {
      return recordAuth;
    }
    return {
      status: 200,
      body: await readInboxWorkflow({
        root,
        id: detailId,
        includeContent: url.searchParams.get("include_content") === "true",
        maxBytes: boundedNumberQuery(url, "max_bytes", 128 * 1024, 0, 1024 * 1024),
      }),
    };
  }

  const processId = webActionId(url.pathname, "/api/v1/inbox/items/", "process");
  if (method === "POST" && processId) {
    const auth = authorizeHttp("wiki.inbox_process", policy);
    if (auth) {
      return auth;
    }
    const inboxProcessAuth = await authorizeHttpInboxProcess(root, policy, processId);
    if (inboxProcessAuth) {
      return inboxProcessAuth;
    }
    const params = objectBody(body);
    if (params.enqueue === true) {
      return {
        status: 202,
        body: {
          run: await createRun({
            root,
            runType: "inbox.process",
            ...optionalPolicyActor(policy),
            input: {
              id: processId,
              ...(params.dry_run === true ? { dry_run: true } : {}),
            },
          }),
        },
      };
    }
    return {
      status: 200,
      body: await processInboxItem({
        root,
        id: processId,
        ...optionalPolicyActor(policy),
        policyContext: httpPolicyContext(policy),
        dryRun: params.dry_run === true,
      }),
    };
  }

  const ignoreId = webActionId(url.pathname, "/api/v1/inbox/items/", "ignore");
  if (method === "POST" && ignoreId) {
    const auth = authorizeHttp("wiki.inbox_ignore", policy);
    if (auth) {
      return auth;
    }
    const inboxIgnoreAuth = await authorizeHttpInboxAction(root, "wiki.inbox_ignore", policy, ignoreId);
    if (inboxIgnoreAuth) {
      return inboxIgnoreAuth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await ignoreInboxItem({
        root,
        id: ignoreId,
        ...optionalPolicyActor(policy),
        ...optionalStringProperty(params, "reason", "reason"),
      }),
    };
  }

  const retryId = webActionId(url.pathname, "/api/v1/inbox/items/", "retry");
  if (method === "POST" && retryId) {
    const auth = authorizeHttp("wiki.inbox_retry", policy);
    if (auth) {
      return auth;
    }
    const inboxRetryAuth = await authorizeHttpInboxAction(root, "wiki.inbox_retry", policy, retryId);
    if (inboxRetryAuth) {
      return inboxRetryAuth;
    }
    const params = objectBody(body);
    return {
      status: 200,
      body: await retryInboxItem({
        root,
        id: retryId,
        ...optionalPolicyActor(policy),
        ...optionalStringProperty(params, "reason", "reason"),
      }),
    };
  }

  return undefined;
}

function inboxStatusesFromUrl(url: URL): InboxItemStatus[] | undefined {
  const values = [...url.searchParams.getAll("status"), ...url.searchParams.getAll("statuses").flatMap((value) => value.split(/[,\s]+/))]
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  return values.map((value) => {
    if (
      value === "received" ||
      value === "queued" ||
      value === "processing" ||
      value === "proposed" ||
      value === "applied" ||
      value === "ignored" ||
      value === "failed" ||
      value === "superseded"
    ) {
      return value;
    }
    throw new Error(`Invalid inbox status '${value}'`);
  });
}
