import { objectBody, optionalPolicyActor, optionalStringProperty } from "../request.ts";
import type { HttpRouteResult } from "../types.ts";
import { openWikiRuntimeModeFromEnvOrProfile, openWikiWorkspaceSummary, type OpenWikiConfig } from "@openwiki/core";
import { configureGitRemote } from "@openwiki/git";
import { readCurrentIndexStoreWorkspaceIndex, readCurrentIndexStoreWorkspaceRegistry } from "@openwiki/index-store";
import { visibleRepositoryView } from "@openwiki/policy";
import { postgresRuntimeConfigured, postgresRuntimeReadEnabled, postgresRuntimeSearchEnabled, readCurrentPostgresWorkspaceIndex, readCurrentPostgresWorkspaceRegistry } from "@openwiki/postgres-runtime";
import { loadRepository, readWorkspaceRegistry } from "@openwiki/repo";
import { resolveWriteCoordinatorBackendFromEnvOrConfig, withWriteCoordination } from "@openwiki/workflows";
import { authorizeHttp, httpCanSeeUnfilteredIndex, httpPolicyContext } from "../auth.ts";
import { operationalStateBackendFromEnvOrConfig } from "../operational.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routeApiWorkspaceRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  if (method === "GET" && url.pathname === "/api/v1/index") {
    const auth = authorizeHttp("wiki.read_page", policy);
    if (auth) {
      return auth;
    }
    const indexed = (await readCurrentPostgresWorkspaceIndex(root)) ?? (await readCurrentIndexStoreWorkspaceIndex(root));
    if (indexed && httpCanSeeUnfilteredIndex(policy)) {
      return { status: 200, body: { workspace: indexed.workspace, counts: indexed.counts, serving_layer: indexed.source, runtime: effectiveRuntimeSummary(indexed.workspace as unknown as OpenWikiConfig) } };
    }
    const repo = await loadRepository(root);
    const visible = visibleRepositoryView(repo, httpPolicyContext(policy));
    return {
      status: 200,
      body: {
        workspace: httpCanSeeUnfilteredIndex(policy) ? repo.config : openWikiWorkspaceSummary(repo.config),
        counts: {
          pages: visible.pages.length,
          sources: visible.sources.length,
          claims: visible.claims.length,
          proposals: visible.proposals.length,
          comments: visible.comments.length,
          decisions: visible.decisions.length,
          events: visible.events.length,
          runs: visible.runs.length,
        },
        serving_layer: "parser",
        ...(httpCanSeeUnfilteredIndex(policy) ? { runtime: effectiveRuntimeSummary(repo.config) } : {}),
      },
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/workspaces") {
    const auth = authorizeHttp("wiki.list_workspaces", policy);
    if (auth) {
      return auth;
    }
    const registry =
      (await readCurrentPostgresWorkspaceRegistry(root)) ??
      (await readCurrentIndexStoreWorkspaceRegistry(root)) ??
      (await readWorkspaceRegistry(root));
    return { status: 200, body: { registry } };
  }

  if (method === "POST" && url.pathname === "/api/v1/workspaces/connect") {
    const auth = authorizeHttp("wiki.connect_workspace", policy);
    if (auth) {
      return auth;
    }
    const params = body === undefined ? {} : objectBody(body);
    const connection = await withWriteCoordination(
      {
        root,
        operation: "wiki.connect_workspace",
        ...optionalPolicyActor(policy),
        metadata: {
          ...optionalStringProperty(params, "remote", "remote"),
          ...optionalStringProperty(params, "branch", "branch"),
        },
      },
      () =>
        configureGitRemote(root, {
          ...optionalStringProperty(params, "remote", "remote"),
          ...optionalStringProperty(params, "branch", "branch"),
          ...optionalStringProperty(params, "remote_url", "remote_url"),
          ...optionalStringProperty(params, "credential_ref", "credential_ref"),
        }),
    );
    return { status: 200, body: { connection, registry: await readWorkspaceRegistry(root) } };
  }
  return undefined;
}

function effectiveRuntimeSummary(config: OpenWikiConfig): Record<string, unknown> {
  return {
    mode: openWikiRuntimeModeFromEnvOrProfile(process.env, config.runtime?.profile),
    profile: config.runtime?.profile ?? "local",
    postgres_configured: postgresRuntimeConfigured(),
    read_backend: postgresRuntimeReadEnabled() ? "postgres" : "local",
    search_backend: postgresRuntimeSearchEnabled() ? "postgres" : "sqlite",
    queue_backend: runtimeQueueBackend(config),
    operational_state_backend: operationalStateBackendFromEnvOrConfig(config.runtime?.controls?.operational_state?.backend),
    write_coordinator_backend: runtimeWriteCoordinatorBackend(config),
  };
}

function runtimeQueueBackend(config: OpenWikiConfig): "local" | "postgres" {
  const value = process.env.OPENWIKI_QUEUE_BACKEND?.trim() || config.runtime?.queue?.backend || "local";
  return value === "postgres" ? "postgres" : "local";
}

function runtimeWriteCoordinatorBackend(config: OpenWikiConfig): "local" | "postgres" {
  return resolveWriteCoordinatorBackendFromEnvOrConfig(config.runtime?.queue?.backend);
}
