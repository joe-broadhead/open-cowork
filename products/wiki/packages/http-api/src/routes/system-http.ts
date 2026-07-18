import { authorizeHttp, forbidden, httpCanSeeUnfilteredIndex, httpRequiresAuthentication } from "../auth.ts";
import { liveness } from "./system.ts";
import type { HttpRouteResult } from "../types.ts";
import { operationNames } from "@openwiki/policy";
import { mcpManifest, openApiDocument } from "@openwiki/static-export";
import { health, metricsText, readiness } from "../health-metrics.ts";
import { routeMcpRequest } from "../mcp-http.ts";
import { readRecentRequestLogs } from "../operational.ts";
import type { HttpRouteHandlerContext } from "./router.ts";

export async function routePublicSystemRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const method = input.method;
  const url = input.url;
  if (method === "GET" && (url.pathname === "/livez" || url.pathname === "/api/v1/livez")) {
    return { status: 200, body: liveness() };
  }

  if (method === "GET" && (url.pathname === "/readyz" || url.pathname === "/api/v1/readyz")) {
    const result = await readiness(input.root);
    if (await httpRequiresAuthentication(input.root)) {
      return { status: result.status === "ready" ? 200 : 503, body: { status: result.status, checked_at: result.checked_at } };
    }
    return { status: result.status === "ready" ? 200 : 503, body: result };
  }

  return undefined;
}

export async function routeProtectedSystemRoutes(input: HttpRouteHandlerContext): Promise<HttpRouteResult | undefined> {
  const root = input.root;
  const method = input.method;
  const url = input.url;
  const body = input.body;
  const policy = input.policy;
  const context = input.context;
  if (method === "GET" && (url.pathname === "/healthz" || url.pathname === "/api/v1/health")) {
    return { status: 200, body: await health(root) };
  }

  if (method === "GET" && (url.pathname === "/metrics" || url.pathname === "/api/v1/metrics")) {
    if (!publicMetricsEnabled() || await httpRequiresAuthentication(root)) {
      const auth = authorizeHttp("wiki.admin", policy);
      if (auth !== undefined) {
        return auth;
      }
    }
    return {
      status: 200,
      body: await metricsText(root),
      contentType: "text/plain; version=0.0.4; charset=utf-8",
    };
  }

  if (method === "GET" && url.pathname === "/api/v1/capabilities") {
    return { status: 200, body: capabilities() };
  }

  if (method === "GET" && (url.pathname === "/api/v1/auth/request-logs" || url.pathname === "/api/v1/admin/request-logs")) {
    const auth = authorizeHttp("wiki.admin", policy);
    if (auth !== undefined) {
      return auth;
    }
    if (!httpCanSeeUnfilteredIndex(policy)) {
      return forbidden("OpenWiki request logs require an unbounded admin credential");
    }
    return { status: 200, body: { logs: readRecentRequestLogs(requestLogLimit(url)) } };
  }

  if (method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/api/v1/openapi.json")) {
    return { status: 200, body: openApiDocument() };
  }

  if (method === "GET" && (url.pathname === "/mcp-manifest.json" || url.pathname === "/api/v1/mcp-manifest")) {
    return { status: 200, body: mcpManifest() };
  }

  if (method === "POST" && url.pathname === "/mcp") {
    return routeMcpRequest(root, url, body, policy, { context });
  }
  return undefined;
}

function requestLogLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") ?? "100");
  return Number.isFinite(value) ? value : 100;
}

function publicMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OPENWIKI_PUBLIC_METRICS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function capabilities(): unknown {
  return {
    protocol_version: "0.1",
    operations: operationNames().filter((operation) => operation !== "wiki.admin"),
    adapters: ["http", "cli", "mcp-stdio", "mcp-http", "static-export"],
    scopes: [
      "wiki:read",
      "wiki:search",
      "wiki:ask",
      "wiki:propose",
      "wiki:ingest:draft",
      "wiki:review",
      "wiki:patch",
      "wiki:commit",
      "wiki:publish",
      "wiki:admin",
    ],
  };
}
