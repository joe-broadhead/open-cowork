import { requestOriginIsAllowed } from "./browser-security.ts";
import { firstHeader } from "./http-headers.ts";
import { corsHeaders, objectBody, readRequestBody, writeRouteResult } from "./request.ts";
import type { HttpPolicyOptions, HttpRequestContext, HttpRouteResult } from "./types.ts";
import { OpenWikiError, openWikiMcpJsonRpcCodeForError, writeOpenWikiLog } from "@openwiki/core";
import { InvalidGitRevisionError } from "@openwiki/git";
import { handleMcpRequest, MCP_PROTOCOL_VERSION, type McpToolMode } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eventStreamHeaders, sseField } from "./events.ts";
import { classifyOperationalRoute, hashOperationalValue, mcpRequestMetadata, redactedRequestMetadata, writeRequestLog } from "./operational.ts";
import { mcpHttpSessionExpired, resolveMcpHttpRuntime, type McpHttpRuntime, type McpHttpSession, type McpSessionStore } from "./mcp-http-runtime.ts";

const MCP_HTTP_SESSION_HEADER = "mcp-session-id";

const MCP_HTTP_PROTOCOL_HEADER = "mcp-protocol-version";

interface McpHttpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export type { McpHttpRuntime, McpHttpSession, McpSessionStore } from "./mcp-http-runtime.ts";

interface McpHttpRouteOptions {
  responseFormat?: "json" | "sse";
  notificationBody?: "compat" | "empty";
  session?: McpHttpSession;
  context?: HttpRequestContext;
  runtime?: McpHttpRuntime;
}

export function mcpEndpointUrl(rawUrl: string): URL | undefined {
  const url = new URL(rawUrl, "http://openwiki.local");
  return url.pathname === "/mcp" ? url : undefined;
}

export async function routeMcpRequest(
  root: string,
  url: URL,
  body: unknown,
  policy: HttpPolicyOptions,
  options: McpHttpRouteOptions = {},
): Promise<HttpRouteResult> {
  const route = classifyOperationalRoute("POST", url, body);
  const context = options.context ?? {};
  const runtime = await resolveMcpHttpRuntime(root, options.runtime);
  let request: McpHttpRequest;
  let toolMode: McpToolMode;
  try {
    request = mcpJsonRpcRequestBody(body);
    toolMode = options.session?.toolMode ?? mcpToolModeFromUrl(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 400, body: mcpJsonRpcError(undefined, -32600, message), headers: mcpHttpResponseHeaders() };
  }

  await touchMcpHttpSession(root, options.session, runtime.sessionStore);
  const rateLimit = await runtime.rateLimiter.check(root, route, policy, context);
  if (!rateLimit.allowed) {
    runtime.rateLimiter.recordRejection(route, rateLimit);
    const tool = mcpRequestMetadata(body).tool;
    if (tool !== undefined) {
      runtime.metrics.recordTool(tool, toolMode, "rate_limited", 0);
    }
    return {
      status: 429,
      body: mcpJsonRpcError(request.id, -32000, `Rate limit exceeded for ${route.operation}`),
      headers: {
        ...mcpHttpResponseHeaders(options.session),
        "retry-after": String(Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))),
        "x-ratelimit-limit": String(rateLimit.limit),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": new Date(rateLimit.resetAt).toISOString(),
      },
    };
  }

  if (!("id" in request)) {
    return options.notificationBody === "empty"
      ? { status: 202, body: "", contentType: "text/plain; charset=utf-8", headers: mcpHttpResponseHeaders(options.session) }
      : { status: 202, body: { accepted: true }, headers: mcpHttpResponseHeaders(options.session) };
  }

  const tool = mcpRequestMetadata(body).tool;
  const toolStartedAt = Date.now();
  try {
    const result = await handleMcpRequest(root, request, mcpOptionsFromHttpPolicy(policy, toolMode));
    if (tool !== undefined) {
      runtime.metrics.recordTool(tool, toolMode, "success", Date.now() - toolStartedAt);
    }
    const response = {
      jsonrpc: "2.0",
      id: request.id,
      result,
    };
    const session = request.method === "initialize" ? await createMcpHttpSession(root, toolMode, runtime.sessionStore) : options.session;
    const headers = mcpHttpResponseHeaders(session);
    if (options.responseFormat === "sse") {
      return {
        status: 200,
        body: renderMcpSseResponse(response),
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          ...eventStreamHeaders(),
          ...headers,
        },
      };
    }
    return {
      status: 200,
      body: response,
      headers,
    };
  } catch (error) {
    if (tool !== undefined) {
      runtime.metrics.recordTool(tool, toolMode, "error", Date.now() - toolStartedAt);
    }
    const message = error instanceof Error ? error.message : String(error);
    const response = mcpJsonRpcError(request.id, mcpJsonRpcErrorCode(error), message);
    if (options.responseFormat === "sse") {
      return {
        status: 200,
        body: renderMcpSseResponse(response),
        contentType: "text/event-stream; charset=utf-8",
        headers: {
          ...eventStreamHeaders(),
          ...mcpHttpResponseHeaders(options.session),
        },
      };
    }
    return {
      status: 200,
      body: response,
      headers: mcpHttpResponseHeaders(options.session),
    };
  }
}

export async function writeMcpHttpResponse(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  policy: HttpPolicyOptions,
  context: HttpRequestContext = {},
  runtime: McpHttpRuntime = {},
): Promise<void> {
  const startedAt = Date.now();
  const method = request.method ?? "GET";
  const resolvedRuntime = await resolveMcpHttpRuntime(root, runtime);
  const originFailure = mcpOriginFailure(request);
  if (originFailure !== undefined) {
    writeMcpHttpRouteResult(response, originFailure, method, url, undefined, policy, context, startedAt, resolvedRuntime);
    return;
  }

  const protocolFailure = mcpProtocolVersionFailure(request);
  if (protocolFailure !== undefined) {
    writeMcpHttpRouteResult(response, protocolFailure, method, url, undefined, policy, context, startedAt, resolvedRuntime);
    return;
  }

  if (method !== "POST") {
    const rateLimitResult = await mcpHttpRateLimitResult(root, method, url, policy, context, resolvedRuntime);
    if (rateLimitResult !== undefined) {
      writeMcpHttpRouteResult(response, rateLimitResult, method, url, undefined, policy, context, startedAt, resolvedRuntime);
      return;
    }
  }

  await expireMcpHttpSessions(root, resolvedRuntime.sessionStore);
  const sessionResult = await mcpHttpSessionFromRequest(root, request, resolvedRuntime.sessionStore);
  if (sessionResult.failure !== undefined) {
    writeMcpHttpRouteResult(response, sessionResult.failure, method, url, undefined, policy, context, startedAt, resolvedRuntime);
    return;
  }

  if (method === "GET") {
    if (sessionResult.session === undefined) {
      writeMcpHttpRouteResult(response, mcpHttpError(400, -32600, "MCP GET requires an MCP-Session-Id header"), method, url, undefined, policy, context, startedAt, resolvedRuntime);
      return;
    }
    await writeMcpHttpEventStream(root, request, response, url, sessionResult.session, resolvedRuntime);
    recordMcpHttpRouteResult(200, method, url, undefined, policy, context, startedAt, resolvedRuntime);
    return;
  }

  if (method === "POST") {
    const body = await readRequestBody(request);
    const result = await routeMcpRequest(root, url, body, policy, {
      responseFormat: mcpPostResponseFormat(request),
      notificationBody: "empty",
      ...(sessionResult.session === undefined ? {} : { session: sessionResult.session }),
      context,
      runtime: resolvedRuntime,
    });
    writeMcpHttpRouteResult(response, result, method, url, body, policy, context, startedAt, resolvedRuntime);
    return;
  }

  if (method === "DELETE") {
    if (sessionResult.session === undefined) {
      writeMcpHttpRouteResult(response, mcpHttpError(400, -32600, "MCP DELETE requires an MCP-Session-Id header"), method, url, undefined, policy, context, startedAt, resolvedRuntime);
      return;
    }
    await deleteMcpHttpSession(root, sessionResult.session.id, resolvedRuntime.sessionStore);
    writeMcpHttpRouteResult(
      response,
      {
        status: 204,
        body: "",
        contentType: "text/plain; charset=utf-8",
        headers: mcpHttpResponseHeaders(),
      },
      method,
      url,
      undefined,
      policy,
      context,
      startedAt,
      resolvedRuntime,
    );
    return;
  }

  writeMcpHttpRouteResult(
    response,
    {
      status: 405,
      body: mcpJsonRpcError(undefined, -32600, "Method not allowed"),
      headers: {
        ...mcpHttpResponseHeaders(sessionResult.session),
        "allow": "GET,POST,DELETE,OPTIONS",
      },
    },
    method,
    url,
    undefined,
    policy,
    context,
    startedAt,
    resolvedRuntime,
  );
}

async function mcpHttpRateLimitResult(
  root: string,
  method: string,
  url: URL,
  policy: HttpPolicyOptions,
  context: HttpRequestContext,
  runtime: Required<McpHttpRuntime>,
): Promise<HttpRouteResult | undefined> {
  const route = classifyOperationalRoute(method, url);
  const decision = await runtime.rateLimiter.check(root, route, policy, context);
  if (decision.allowed) {
    return undefined;
  }
  runtime.rateLimiter.recordRejection(route, decision);
  return {
    status: 429,
    body: mcpJsonRpcError(undefined, -32000, `Rate limit exceeded for ${route.operation}`),
    headers: {
      ...mcpHttpResponseHeaders(),
      "retry-after": String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))),
      "x-ratelimit-limit": String(decision.limit),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": new Date(decision.resetAt).toISOString(),
    },
  };
}

function writeMcpHttpRouteResult(
  response: ServerResponse,
  result: HttpRouteResult,
  method: string,
  url: URL,
  body: unknown,
  policy: HttpPolicyOptions,
  context: HttpRequestContext,
  startedAt: number,
  runtime: Required<McpHttpRuntime>,
): void {
  recordMcpHttpRouteResult(result.status, method, url, body, policy, context, startedAt, runtime);
  writeRouteResult(response, result);
}

function recordMcpHttpRouteResult(
  status: number,
  method: string,
  url: URL,
  body: unknown,
  policy: HttpPolicyOptions,
  context: HttpRequestContext,
  startedAt: number,
  runtime: Required<McpHttpRuntime>,
): void {
  const route = classifyOperationalRoute(method, url, body);
  runtime.metrics.recordRequest(route, status, Date.now() - startedAt);
  writeRequestLog(context, {
    request_id: context.requestId ?? randomUUID(),
    method,
    route: route.route,
    operation: route.operation,
    actor_id: policy.actorId ?? "anonymous",
    status,
    duration_ms: Date.now() - startedAt,
    rate_limited: status === 429,
    metadata: redactedRequestMetadata(policy, route, context),
  });
}

export function mcpOriginFailure(request: IncomingMessage): HttpRouteResult | undefined {
  if (requestOriginIsAllowed(request)) {
    return undefined;
  }
  return mcpHttpError(403, -32000, "MCP request Origin is not allowed");
}

export function mcpProtocolVersionFailure(request: IncomingMessage): HttpRouteResult | undefined {
  const version = firstHeader(request.headers[MCP_HTTP_PROTOCOL_HEADER])?.trim();
  if (version === undefined) {
    return undefined;
  }
  if (version === MCP_PROTOCOL_VERSION) {
    return undefined;
  }
  return mcpHttpError(400, -32600, `Unsupported MCP protocol version '${version}'`);
}

async function mcpHttpSessionFromRequest(
  root: string,
  request: IncomingMessage,
  store: McpSessionStore,
): Promise<{ session?: McpHttpSession; failure?: HttpRouteResult }> {
  const sessionId = firstHeader(request.headers[MCP_HTTP_SESSION_HEADER])?.trim();
  if (sessionId === undefined || sessionId.length === 0) {
    return {};
  }
  const session = await store.read(root, sessionId);
  if (session === undefined || session.root !== root || mcpHttpSessionExpired(session)) {
    if (session !== undefined) {
      await store.delete(root, session.id);
    }
    return { failure: mcpHttpError(404, -32000, "MCP session not found") };
  }
  return { session };
}

async function createMcpHttpSession(root: string, toolMode: McpToolMode, store: McpSessionStore): Promise<McpHttpSession> {
  return store.create(root, toolMode);
}

async function touchMcpHttpSession(root: string, session: McpHttpSession | undefined, store: McpSessionStore): Promise<void> {
  if (session === undefined) {
    return;
  }
  await store.touch(root, session);
}

async function expireMcpHttpSessions(root: string, store: McpSessionStore): Promise<void> {
  await store.expire(root);
}

async function deleteMcpHttpSession(root: string, sessionId: string, store: McpSessionStore): Promise<void> {
  await store.delete(root, sessionId);
}

async function writeMcpHttpEventStream(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  session: McpHttpSession,
  runtime: Required<McpHttpRuntime>,
): Promise<void> {
  const accept = firstHeader(request.headers.accept)?.toLowerCase() ?? "";
  if (!accept.includes("text/event-stream")) {
    writeRouteResult(response, mcpHttpError(406, -32600, "MCP GET requires Accept: text/event-stream"));
    return;
  }

  await touchMcpHttpSession(root, session, runtime.sessionStore);
  response.writeHead(200, {
    ...corsHeaders(),
    ...eventStreamHeaders(),
    ...mcpHttpResponseHeaders(session),
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(renderMcpSsePrime(session, runtime.stream.retryMs));
  response.write(": openwiki mcp stream\n\n");
  if (url.searchParams.get("once") === "true") {
    response.end();
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const close = (): void => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
  request.on("close", close);

  const tick = (): void => {
    if (closed) {
      return;
    }
    void touchMcpHttpSession(root, session, runtime.sessionStore).catch((error: unknown) => {
      writeOpenWikiLog({
        event: "mcp_session_touch_error",
        level: "warn",
        session_id: hashOperationalValue(session.id),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    response.write(runtime.stream.heartbeat(new Date()));
    timer = setTimeout(tick, runtime.stream.retryMs);
  };
  timer = setTimeout(tick, runtime.stream.retryMs);
}

function mcpPostResponseFormat(request: IncomingMessage): "json" | "sse" {
  const accept = firstHeader(request.headers.accept)?.toLowerCase() ?? "";
  return accept.includes("text/event-stream") && !accept.includes("application/json") ? "sse" : "json";
}

function mcpHttpResponseHeaders(session?: McpHttpSession): Record<string, string> {
  return {
    "MCP-Protocol-Version": session?.protocolVersion ?? MCP_PROTOCOL_VERSION,
    ...(session === undefined ? {} : { "MCP-Session-Id": session.id }),
  };
}

function mcpHttpError(status: number, code: number, message: string): HttpRouteResult {
  return {
    status,
    body: mcpJsonRpcError(undefined, code, message),
    headers: mcpHttpResponseHeaders(),
  };
}

function renderMcpSsePrime(session: McpHttpSession, retryMs: number): string {
  return [`id: ${sseField(`mcp-${session.id}-prime`)}`, `retry: ${retryMs}`, "data:", "", ""].join(
    "\n",
  );
}

function renderMcpSseResponse(message: unknown): string {
  return [
    `id: ${sseField(`mcp-${randomUUID()}`)}`,
    "event: message",
    `data: ${JSON.stringify(message)}`,
    "",
    "",
  ].join("\n");
}

function mcpJsonRpcRequestBody(value: unknown): McpHttpRequest {
  const params = objectBody(value);
  const jsonrpc = params.jsonrpc;
  const method = params.method;
  const id = params.id;
  if (jsonrpc !== "2.0") {
    throw new Error("Expected JSON-RPC 2.0 request");
  }
  if (typeof method !== "string" || !method.trim()) {
    throw new Error("Expected JSON-RPC method");
  }
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new Error("Expected JSON-RPC id to be a string or number");
  }
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method,
    ...(params.params === undefined ? {} : { params: params.params }),
  };
}

function mcpToolModeFromUrl(url: URL): McpToolMode {
  const value = url.searchParams.get("tools") ?? url.searchParams.get("tool_mode") ?? url.searchParams.get("mode") ?? "read";
  if (value === "read" || value === "proposal" || value === "write") {
    return value;
  }
  throw new Error("Expected MCP tools query to be read, proposal, or write");
}

function mcpOptionsFromHttpPolicy(
  policy: HttpPolicyOptions,
  toolMode: McpToolMode,
): Parameters<typeof handleMcpRequest>[2] {
  const scopes = policy.scopes ?? (policy.role === undefined ? scopesForRole("viewer") : scopesForRole(policy.role));
  return {
    toolMode,
    scopes,
    ...(policy.actorId === undefined ? {} : { actorId: policy.actorId }),
    ...(policy.role === undefined ? {} : { role: policy.role }),
    ...(policy.principals === undefined ? {} : { principals: policy.principals }),
    ...(policy.bounds === undefined ? {} : { bounds: policy.bounds }),
  };
}

function mcpJsonRpcError(id: string | number | undefined, code: number, message: string): unknown {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function mcpJsonRpcErrorCode(error: unknown): number {
  if (error instanceof InvalidGitRevisionError) {
    return -32602;
  }
  if (error instanceof OpenWikiError) {
    return openWikiMcpJsonRpcCodeForError(error);
  }
  if (error instanceof Error) {
    if (error.name === "AuthorizationError") {
      return -32001;
    }
    if (error.message.startsWith("Unsupported MCP method")) {
      return -32601;
    }
    if (error.message.startsWith("Expected ")) {
      return -32602;
    }
  }
  return -32603;
}
