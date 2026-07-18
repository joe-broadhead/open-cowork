import { boundedNumberQuery, numberQuery, objectBody, optionalBooleanBody, optionalGraphDirectionQuery, optionalLimitObject, optionalNumberProperty, optionalObjectProperty, optionalRequestActor, optionalStringProperty, requiredQuery, stringBody } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import { analyzeGraph, OpenWikiPolicyDeniedError, redactOpenWikiRunRecord } from "@openwiki/core";
import { graphCurrentIndexStoreNeighbors, graphCurrentIndexStoreOrphans, graphCurrentIndexStorePath, graphCurrentIndexStoreRelated, graphCurrentIndexStoreStale, readCurrentIndexStoreGraph } from "@openwiki/index-store";
import { createRun, runLocalJob } from "@openwiki/jobs";
import { canReadRecordId, canReadSourceRecord } from "@openwiki/policy";
import { graphCurrentPostgresNeighbors, graphCurrentPostgresOrphans, graphCurrentPostgresPath, graphCurrentPostgresRelated, graphCurrentPostgresStale, listCurrentPostgresSources, readCurrentPostgresGraph } from "@openwiki/postgres-runtime";
import { graphBacklinks, graphNeighbors, graphOrphans, graphPath, graphRelated, graphStale, listGraphEdges, loadRepository } from "@openwiki/repo";
import { assertSourceFetchBudgetForRoot, ingestSource, proposeSource } from "@openwiki/workflows";
import { authorizeHttp, authorizeHttpPath, httpCanSeeUnfilteredIndex, httpPolicyContext, httpRouteErrorMessage, policyDeniedHttpResult } from "../auth.ts";
import { HTTP_GRAPH_LIST_LIMIT_MAX } from "../constants.ts";
import { filterGraphIndexByPolicy, filterGraphNeighborhoodByPolicy, filterGraphPathByPolicy, filterGraphStaleByPolicy } from "../data-access.ts";
import { graphIndexForQuery } from "../renderers/graph.ts";
import { graphActionId } from "../route-utils.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

const SOURCE_FETCH_AUTH_PATHS = ["sources/manifests", "sources/raw"] as const;

export async function routeApiGraphSourceRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/api/v1/graph") {
    const auth = authorizeHttp("wiki.graph_neighbors", policy);
    if (auth) {
      return auth;
    }
    const graph = await filterGraphIndexByPolicy(root, policy, (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root)));
    return { status: 200, body: graphIndexForQuery(graph, url, { defaultLimit: HTTP_GRAPH_LIST_LIMIT_MAX, maxLimit: HTTP_GRAPH_LIST_LIMIT_MAX }) };
  }

  if (method === "GET" && url.pathname === "/api/v1/graph/report") {
    const auth = authorizeHttp("wiki.graph_report", policy);
    if (auth) {
      return auth;
    }
    const graph = await filterGraphIndexByPolicy(root, policy, (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root)));
    const limit = boundedNumberQuery(url, "limit", 10, 1, HTTP_GRAPH_LIST_LIMIT_MAX);
    return { status: 200, body: analyzeGraph(graph, { limit }) };
  }

  const graphNeighborsId = graphActionId(url.pathname, "neighbors");
  if (method === "GET" && graphNeighborsId) {
    const auth = authorizeHttp("wiki.graph_neighbors", policy);
    if (auth) {
      return auth;
    }
    const depth = numberQuery(url, "depth");
    const limit = numberQuery(url, "limit");
    return {
      status: 200,
      body: await filterGraphNeighborhoodByPolicy(
        root,
        policy,
        (await graphCurrentPostgresNeighbors(root, graphNeighborsId, {
          ...optionalGraphDirectionQuery(url),
          ...(depth === undefined ? {} : { depth }),
          ...(limit === undefined ? {} : { limit }),
        })) ??
          (await graphCurrentIndexStoreNeighbors(root, graphNeighborsId, {
            ...optionalGraphDirectionQuery(url),
            ...(depth === undefined ? {} : { depth }),
            ...(limit === undefined ? {} : { limit }),
          })) ??
          (await graphNeighbors(root, graphNeighborsId, {
            ...optionalGraphDirectionQuery(url),
            ...(depth === undefined ? {} : { depth }),
            ...(limit === undefined ? {} : { limit }),
          })),
      ),
    };
  }

  const graphBacklinksId = graphActionId(url.pathname, "backlinks");
  if (method === "GET" && graphBacklinksId) {
    const auth = authorizeHttp("wiki.graph_backlinks", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: await filterGraphNeighborhoodByPolicy(root, policy, (await graphCurrentPostgresNeighbors(root, graphBacklinksId, { direction: "in", depth: 1, ...optionalLimitObject(url) })) ?? (await graphCurrentIndexStoreNeighbors(root, graphBacklinksId, { direction: "in", depth: 1, ...optionalLimitObject(url) })) ?? (await graphBacklinks(root, graphBacklinksId, optionalLimitObject(url)))),
    };
  }

  const graphRelatedId = graphActionId(url.pathname, "related");
  if (method === "GET" && graphRelatedId) {
    const auth = authorizeHttp("wiki.graph_related", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: await filterGraphNeighborhoodByPolicy(root, policy, (await graphCurrentPostgresRelated(root, graphRelatedId, optionalLimitObject(url))) ?? (await graphCurrentIndexStoreRelated(root, graphRelatedId, optionalLimitObject(url))) ?? (await graphRelated(root, graphRelatedId, optionalLimitObject(url)))),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/graph/path") {
    const auth = authorizeHttp("wiki.graph_path", policy);
    if (auth) {
      return auth;
    }
    return {
      status: 200,
      body: await filterGraphPathByPolicy(
        root,
        policy,
        (await graphCurrentPostgresPath(root, requiredQuery(url, "from_id", "from"), requiredQuery(url, "to_id", "to"))) ?? (await graphCurrentIndexStorePath(root, requiredQuery(url, "from_id", "from"), requiredQuery(url, "to_id", "to"))) ?? (await graphPath(root, requiredQuery(url, "from_id", "from"), requiredQuery(url, "to_id", "to"))),
      ),
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/graph/orphans") {
    const auth = authorizeHttp("wiki.graph_orphans", policy);
    if (auth) {
      return auth;
    }
    const repo = await loadRepository(root);
    const context = httpPolicyContext(policy);
    const limit = boundedNumberQuery(url, "limit", HTTP_GRAPH_LIST_LIMIT_MAX, 1, HTTP_GRAPH_LIST_LIMIT_MAX);
    const response = (await graphCurrentPostgresOrphans(root)) ?? (await graphCurrentIndexStoreOrphans(root)) ?? (await graphOrphans(root));
    const pages = response.pages.filter((page) => canReadRecordId(repo, context, page.id));
    return { status: 200, body: { pages: pages.slice(0, limit), total: pages.length } };
  }

  if (method === "GET" && url.pathname === "/api/v1/graph/stale") {
    const auth = authorizeHttp("wiki.graph_stale", policy);
    if (auth) {
      return auth;
    }
    const stale = await filterGraphStaleByPolicy(root, policy, (await graphCurrentPostgresStale(root)) ?? (await graphCurrentIndexStoreStale(root)) ?? (await graphStale(root)));
    const limit = boundedNumberQuery(url, "limit", HTTP_GRAPH_LIST_LIMIT_MAX, 1, HTTP_GRAPH_LIST_LIMIT_MAX);
    return { status: 200, body: { pages: stale.pages.slice(0, limit), claims: stale.claims.slice(0, limit), total: stale.total } };
  }

  if (method === "GET" && url.pathname === "/api/v1/sources") {
    const auth = authorizeHttp("wiki.read_source", policy);
    if (auth) {
      return auth;
    }
    const limit = boundedNumberQuery(url, "limit", 100, 1, 1000);
    const repo = await loadRepository(root);
    const response = (await listCurrentPostgresSources(root, limit)) ?? {
      source: "repo",
      sources: repo.sources.slice(0, Math.min(Math.max(limit, 0), 1000)),
      total: repo.sources.length,
    };
    const context = httpPolicyContext(policy);
    const sources = response.sources.filter((source) => canReadSourceRecord(repo, context, source));
    return { status: 200, body: { ...response, sources, total: sources.length } };
  }

  if (method === "POST" && url.pathname === "/api/v1/sources/fetch") {
    const auth = authorizeHttp("wiki.fetch_source", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    const runInput = {
      root,
      runType: "source.fetch",
      ...optionalRequestActor(policy, params),
      input: {
        title: stringBody(params, "title"),
        ...optionalStringProperty(params, "url", "url"),
        ...optionalStringProperty(params, "source_type", "source_type"),
        ...optionalStringProperty(params, "connector_kind", "connector_kind"),
        ...optionalStringProperty(params, "connector_id", "connector_id"),
        ...optionalStringProperty(params, "credential_ref", "credential_ref"),
        ...optionalStringProperty(params, "github_owner", "github_owner"),
        ...optionalStringProperty(params, "github_repo", "github_repo"),
        ...optionalStringProperty(params, "gitlab_project", "gitlab_project"),
        ...optionalStringProperty(params, "source_path", "source_path"),
        ...optionalStringProperty(params, "ref", "ref"),
        ...optionalNumberProperty(params, "max_bytes", "max_bytes"),
        ...optionalNumberProperty(params, "timeout_ms", "timeout_ms"),
      },
    };
    for (const repoPath of SOURCE_FETCH_AUTH_PATHS) {
      const pathAuth = await authorizeHttpPath(root, "wiki.fetch_source", policy, repoPath);
      if (pathAuth) {
        return pathAuth;
      }
    }
    await assertSourceFetchBudgetForRoot(root, {
      ...optionalNumberProperty(params, "max_bytes", "maxBytes"),
      ...optionalNumberProperty(params, "timeout_ms", "timeoutMs"),
    });
    if (optionalBooleanBody(params, "wait") === true) {
      const result = await runLocalJob(runInput);
      return {
        status: 201,
        body: { ...result, run: redactOpenWikiRunRecord(result.run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
      };
    }
    const run = await createRun(runInput);
    return {
      status: 202,
      body: { run: redactOpenWikiRunRecord(run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }) },
    };
  }

  if (method === "POST" && url.pathname === "/api/v1/sources/ingest") {
    const auth = authorizeHttp("wiki.ingest_source", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    try {
      const source = await ingestSource({
        root,
        title: stringBody(params, "title"),
        ...optionalStringProperty(params, "source_type", "sourceType"),
        ...optionalStringProperty(params, "url", "url"),
        ...optionalStringProperty(params, "content", "content"),
        ...optionalRequestActor(policy, params),
        authorizePaths: async ({ manifestPath, rawPath }) => {
          for (const repoPath of [manifestPath, rawPath].filter((candidate): candidate is string => candidate !== undefined)) {
            const sourcePathAuth = await authorizeHttpPath(root, "wiki.ingest_source", policy, repoPath);
            if (sourcePathAuth) {
              throw new OpenWikiPolicyDeniedError(httpRouteErrorMessage(sourcePathAuth));
            }
          }
        },
      });
      return { status: 201, body: source };
    } catch (error) {
      return policyDeniedHttpResult(error);
    }
  }

  if (method === "POST" && url.pathname === "/api/v1/sources/propose") {
    const auth = authorizeHttp("wiki.propose_source", policy);
    if (auth) {
      return auth;
    }
    const params = objectBody(body);
    try {
      const proposal = await proposeSource({
        root,
        title: stringBody(params, "title"),
        ...optionalStringProperty(params, "source_type", "sourceType"),
        ...optionalStringProperty(params, "url", "url"),
        ...optionalStringProperty(params, "content_hash", "contentHash"),
        ...optionalRequestActor(policy, params),
        ...optionalStringProperty(params, "rationale", "rationale"),
        ...optionalStringProperty(params, "retrieved_at", "retrievedAt"),
        ...optionalObjectProperty(params, "trust", "trust"),
        authorizePaths: async ({ manifestPath }) => {
          const sourcePathAuth = await authorizeHttpPath(root, "wiki.propose_source", policy, manifestPath);
          if (sourcePathAuth) {
            throw new OpenWikiPolicyDeniedError(httpRouteErrorMessage(sourcePathAuth));
          }
        },
      });
      return { status: 201, body: proposal };
    } catch (error) {
      return policyDeniedHttpResult(error);
    }
  }
  return undefined;
}
