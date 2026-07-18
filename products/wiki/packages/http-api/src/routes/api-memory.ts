import {
  boundedNumberQuery,
  numberQuery,
  objectBody,
  optionalNumberProperty,
  optionalRequestActor,
  optionalStringArrayProperty,
  optionalStringProperty,
  searchOffsetFromCursor,
  stringBody,
} from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import type { FactRecord, FactStatus, TakeRecord, TakeResolution, TakeStatus } from "@openwiki/core";
import {
  findTrajectory,
  forgetFact,
  listFacts,
  listTakes,
  proposeFact,
  proposeTake,
  readFactWorkflow,
  readTakeWorkflow,
  recallWiki,
  resolveTake,
  takesScorecard,
} from "@openwiki/workflows";
import { authorizeHttp, authorizeHttpPath, httpPolicyContext } from "../auth.ts";
import { HTTP_SEARCH_LIMIT_MAX } from "../constants.ts";
import { pathId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

const MEMORY_LIST_LIMIT_MAX = 500;

export async function routeApiMemoryRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;

  if (method === "POST" && url.pathname === "/api/v1/recall") {
    const auth = authorizeHttp("wiki.recall", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const limit = boundedBodyLimit(params.limit, HTTP_SEARCH_LIMIT_MAX);
    const includeExplain = booleanBody(params, "include_explain");
    const includeHighlights = booleanBody(params, "include_highlights");
    return {
      status: 200,
      body: await recallWiki({
        root,
        query: stringBody(params, "query"),
        ...(limit === undefined ? {} : { limit }),
        ...(includeExplain === undefined ? {} : { includeExplain }),
        ...(includeHighlights === undefined ? {} : { includeHighlights }),
        ...optionalStringArrayProperty(params, "types", "types"),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/facts") {
    const auth = authorizeHttp("wiki.list_facts", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 100, 0, MEMORY_LIST_LIMIT_MAX);
    const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    const result = await listFacts({
      root,
      ...factStatusesFromQuery(url),
      ...stringListQueryProperty(url, "kind", "kinds", "kinds"),
      ...stringListQueryProperty(url, "subject_id", "subject_ids", "subjectIds"),
      ...stringListQueryProperty(url, "page_id", "page_ids", "pageIds"),
      ...stringListQueryProperty(url, "source_id", "source_ids", "sourceIds"),
      ...stringListQueryProperty(url, "claim_id", "claim_ids", "claimIds"),
      limit: Math.min(offset + limit + 1, MEMORY_LIST_LIMIT_MAX),
      policyContext: httpPolicyContext(policy),
    });
    const facts = result.facts.slice(offset, offset + limit);
    return {
      status: 200,
      body: {
        facts,
        total: result.total,
        ...(result.facts.length > offset + facts.length ? { next_cursor: `offset:${offset + facts.length}` } : {}),
      },
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/facts/proposals") {
    const auth = authorizeHttp("wiki.propose_fact", policy);
    if (auth) {
      return auth;
    }
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_fact", policy, "facts/facts.jsonl");
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await proposeFact({
        root,
        ...optionalStringProperty(params, "id", "id"),
        ...optionalStringProperty(params, "kind", "kind"),
        text: stringBody(params, "text"),
        ...optionalStringArrayProperty(params, "subject_ids", "subjectIds"),
        ...optionalStringArrayProperty(params, "page_ids", "pageIds"),
        ...optionalStringArrayProperty(params, "source_ids", "sourceIds"),
        ...optionalStringArrayProperty(params, "claim_ids", "claimIds"),
        ...factConfidenceFromBody(params),
        ...factSensitivityFromBody(params),
        ...factStatusFromBody(params),
        ...optionalStringProperty(params, "valid_from", "validFrom"),
        ...optionalStringProperty(params, "valid_to", "validTo"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  const forgetFactId = actionId(url.pathname, "/api/v1/facts/", "forget");
  if (method === "POST" && forgetFactId !== undefined) {
    const auth = authorizeHttp("wiki.forget_fact", policy);
    if (auth) {
      return auth;
    }
    const pathAuth = await authorizeHttpPath(root, "wiki.forget_fact", policy, "facts/facts.jsonl");
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await forgetFact({
        root,
        id: forgetFactId,
        ...optionalStringProperty(params, "valid_to", "validTo"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  const factId = pathId(url.pathname, "/api/v1/facts/");
  if (method === "GET" && factId !== undefined) {
    const auth = authorizeHttp("wiki.read_fact", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await readFactWorkflow({ root, id: factId, policyContext: httpPolicyContext(policy) }) };
  }

  if (method === "GET" && url.pathname === "/api/v1/takes") {
    const auth = authorizeHttp("wiki.list_takes", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 100, 0, MEMORY_LIST_LIMIT_MAX);
    const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
    const result = await listTakes({
      root,
      ...takeStatusesFromQuery(url),
      ...stringListQueryProperty(url, "page_id", "page_ids", "pageIds"),
      ...stringListQueryProperty(url, "source_id", "source_ids", "sourceIds"),
      ...stringListQueryProperty(url, "claim_id", "claim_ids", "claimIds"),
      limit: Math.min(offset + limit + 1, MEMORY_LIST_LIMIT_MAX),
      policyContext: httpPolicyContext(policy),
    });
    const takes = result.takes.slice(offset, offset + limit);
    return {
      status: 200,
      body: {
        takes,
        total: result.total,
        ...(result.takes.length > offset + takes.length ? { next_cursor: `offset:${offset + takes.length}` } : {}),
      },
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/takes/scorecard") {
    const auth = authorizeHttp("wiki.takes_scorecard", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await takesScorecard({ root, policyContext: httpPolicyContext(policy) }) };
  }

  if (method === "POST" && url.pathname === "/api/v1/takes/proposals") {
    const auth = authorizeHttp("wiki.propose_take", policy);
    if (auth) {
      return auth;
    }
    const pathAuth = await authorizeHttpPath(root, "wiki.propose_take", policy, "takes/takes.jsonl");
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await proposeTake({
        root,
        ...optionalStringProperty(params, "id", "id"),
        statement: stringBody(params, "statement"),
        ...optionalStringProperty(params, "rationale", "rationale"),
        ...optionalNumberProperty(params, "probability", "probability"),
        ...takeConfidenceFromBody(params),
        ...takeStatusFromBody(params),
        ...optionalStringProperty(params, "due_at", "dueAt"),
        ...optionalStringArrayProperty(params, "page_ids", "pageIds"),
        ...optionalStringArrayProperty(params, "source_ids", "sourceIds"),
        ...optionalStringArrayProperty(params, "claim_ids", "claimIds"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "proposal_rationale", "proposalRationale"),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  const resolveTakeId = actionId(url.pathname, "/api/v1/takes/", "resolve");
  if (method === "POST" && resolveTakeId !== undefined) {
    const auth = authorizeHttp("wiki.resolve_take", policy);
    if (auth) {
      return auth;
    }
    const pathAuth = await authorizeHttpPath(root, "wiki.resolve_take", policy, "takes/takes.jsonl");
    if (pathAuth) {
      return pathAuth;
    }
    const params = objectBody(body);
    return {
      status: 201,
      body: await resolveTake({
        root,
        id: resolveTakeId,
        resolution: takeResolutionBody(params, "resolution"),
        ...optionalStringProperty(params, "resolved_at", "resolvedAt"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  const takeId = pathId(url.pathname, "/api/v1/takes/");
  if (method === "GET" && takeId !== undefined) {
    const auth = authorizeHttp("wiki.read_take", policy);
    if (auth) {
      return auth;
    }
    return { status: 200, body: await readTakeWorkflow({ root, id: takeId, policyContext: httpPolicyContext(policy) }) };
  }

  if (method === "GET" && url.pathname === "/api/v1/trajectory") {
    const auth = authorizeHttp("wiki.find_trajectory", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: await findTrajectory({
        root,
        ...queryStringProperty(url, "id", "id"),
        ...queryStringProperty(url, "query", "query"),
        ...trajectoryOrderFromQuery(url),
        limit: boundedNumberQuery(url, "limit", 100, 1, MEMORY_LIST_LIMIT_MAX),
        policyContext: httpPolicyContext(policy),
      }),
    };
  }

  return undefined;
}

function boundedBodyLimit(value: unknown, max: number): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("Expected numeric body field 'limit'");
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function booleanBody(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`Expected boolean body field '${key}'`);
}

function stringListQuery(url: URL, singularKey: string, pluralKey: string): string[] {
  return [...url.searchParams.getAll(singularKey), ...url.searchParams.getAll(pluralKey)]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function stringListQueryProperty<Key extends string>(
  url: URL,
  singularKey: string,
  pluralKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const values = stringListQuery(url, singularKey, pluralKey);
  return values.length === 0 ? {} : ({ [outputKey]: values } as Partial<Record<Key, string[]>>);
}

function queryStringProperty<Key extends string>(url: URL, inputKey: string, outputKey: Key): Partial<Record<Key, string>> {
  const value = url.searchParams.get(inputKey);
  return value === null ? {} : ({ [outputKey]: value } as Partial<Record<Key, string>>);
}

function factStatusesFromQuery(url: URL): { statuses?: FactStatus[] } {
  const values = stringListQuery(url, "status", "statuses");
  return values.length === 0 ? {} : { statuses: values.map(factStatus) };
}

function factStatusFromBody(params: Record<string, unknown>): { status?: FactStatus } {
  const value = params.status;
  if (value === undefined || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error("Expected string body field 'status'");
  }
  return { status: factStatus(value) };
}

function factStatus(value: string): FactStatus {
  if (value === "active" || value === "stale" || value === "disputed" || value === "forgotten" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid fact status '${value}'`);
}

function takeStatusesFromQuery(url: URL): { statuses?: TakeStatus[] } {
  const values = stringListQuery(url, "status", "statuses");
  return values.length === 0 ? {} : { statuses: values.map(takeStatus) };
}

function takeStatusFromBody(params: Record<string, unknown>): { status?: TakeStatus } {
  const value = params.status;
  if (value === undefined || value === "") {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error("Expected string body field 'status'");
  }
  return { status: takeStatus(value) };
}

function takeStatus(value: string): TakeStatus {
  if (value === "open" || value === "resolved" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid take status '${value}'`);
}

function takeResolutionBody(params: Record<string, unknown>, key: string): TakeResolution {
  const value = stringBody(params, key);
  if (value === "correct" || value === "incorrect" || value === "partial" || value === "unresolvable") {
    return value;
  }
  throw new Error(`Invalid take resolution '${value}'`);
}

function factConfidenceFromBody(params: Record<string, unknown>): { confidence?: FactRecord["confidence"] } {
  const value = params.confidence;
  return value === undefined || value === "" ? {} : { confidence: confidenceBody(value) };
}

function takeConfidenceFromBody(params: Record<string, unknown>): { confidence?: TakeRecord["confidence"] } {
  const value = params.confidence;
  return value === undefined || value === "" ? {} : { confidence: confidenceBody(value) };
}

function confidenceBody(value: unknown): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`Invalid confidence '${String(value)}'`);
}

function factSensitivityFromBody(params: Record<string, unknown>): { sensitivity?: FactRecord["sensitivity"] } {
  const value = params.sensitivity;
  if (value === undefined || value === "") {
    return {};
  }
  if (value === "public" || value === "internal" || value === "private") {
    return { sensitivity: value };
  }
  throw new Error(`Invalid fact sensitivity '${String(value)}'`);
}

function trajectoryOrderFromQuery(url: URL): { order?: "asc" | "desc" } {
  const value = url.searchParams.get("order");
  if (value === null) {
    return {};
  }
  if (value === "asc" || value === "desc") {
    return { order: value };
  }
  throw new Error(`Invalid trajectory order '${value}'`);
}

function actionId(pathname: string, prefix: string, action: "forget" | "resolve"): string | undefined {
  const suffix = `/${action}`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined;
  }
  const value = pathname.slice(prefix.length, -suffix.length);
  if (!value || value.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(value);
}
