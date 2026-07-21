import { browserWriteProtectionFailure, trustedProxyOriginRequest } from "./browser-security.ts";
import { firstHeader } from "./http-headers.ts";
import { corsHeaders, httpErrorStatus, readRequestBodyWithRaw, writeJson, writeRouteResult } from "./request.ts";
import type { HttpApiOptions, HttpPolicyOptions, HttpRequestContext, HttpRouteResult, StartedHttpApi } from "./types.ts";
import { OpenWikiError, writeOpenWikiLog } from "@openwiki/core";
import { InvalidGitRevisionError } from "@openwiki/git";
import { withRepositoryReadCache } from "@openwiki/repo";
import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { webAssetNameFromUrl, writeWebAsset } from "./assets.ts";
import { authorizeHttp, httpTrustsRequestHeaders, mergeHttpPolicy, policyOptionsFromRequest, requireAuthenticatedHttpPolicy, resolveHttpPolicy } from "./auth.ts";
import { eventStreamUrl, writeEventStream } from "./events.ts";
import { mcpEndpointUrl, mcpOriginFailure, mcpProtocolVersionFailure, writeMcpHttpResponse } from "./mcp-http.ts";
import { boundedOperationalNumber, checkRateLimit, classifyOperationalRoute, ensureHttpOperationalState, recordHttpRequestMetric, recordRateLimitRejection, redactedRequestMetadata, shouldResolvePolicyForOperationalRoute, writeRequestLog } from "./operational.ts";
import { routeHttpRequestInner } from "./routes/router.ts";
import { warmHostedHealth } from "./health-metrics.ts";

export async function startHttpApi(options: HttpApiOptions): Promise<StartedHttpApi> {
  const host = options.host ?? "127.0.0.1";
  validateTrustedHeaderRuntime(options.defaultPolicy ?? {});
  validateProcessWideDefaultPolicy({ host, defaultPolicy: options.defaultPolicy });
  validateHostedAuthConfiguration();
  await ensureHttpOperationalState(options.root);
  await warmHostedHealth(options.root);
  const port = options.port ?? 3030;
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = http.createServer((request, response) => {
    if (closing) {
      response.writeHead(503, {
        "connection": "close",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: { message: "OpenWiki server is shutting down" } }));
      return;
    }
    handleHttpRequest(options.root, request, response, options.defaultPolicy ?? {}).catch((error: unknown) => {
      writeUnhandledHttpError(response, error);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
    close: (closeOptions = {}) => {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closing = true;
      if (!server.listening) {
        closePromise = Promise.resolve();
        return closePromise;
      }
      const timeoutMs = boundedOperationalNumber(closeOptions.timeoutMs ?? 10_000, 100, 120_000, "HTTP shutdown timeout");
      closePromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections?.();
          for (const socket of sockets) {
            socket.destroy();
          }
        }, timeoutMs);
        timeout.unref();
        server.close((error) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  };
}

function writeUnhandledHttpError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const status = httpErrorStatus(error);
  if (status >= 500 && !expectedHttpBoundaryError(error)) {
    const requestId = responseHeaderString(response, "x-openwiki-request-id") ?? randomUUID();
    response.setHeader("x-openwiki-request-id", requestId);
    response.setHeader("x-request-id", requestId);
    writeOpenWikiLog(
      {
        event: "http_unhandled_error",
        level: "error",
        request_id: requestId,
        status,
        error_name: error instanceof Error ? error.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
      },
      process.env.OPENWIKI_REQUEST_LOGS === "1" ? { enabled: true } : {},
    );
    writeJson(response, status, {
      error: {
        code: "internal",
        message: "Internal server error",
        request_id: requestId,
      },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJson(response, status, { error: { message } });
}

function expectedHttpBoundaryError(error: unknown): boolean {
  return error instanceof OpenWikiError || error instanceof InvalidGitRevisionError;
}

function responseHeaderString(response: ServerResponse, name: string): string | undefined {
  const value = response.getHeader(name);
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

export function validateTrustedHeaderRuntime(defaultPolicy: HttpPolicyOptions = {}): void {
  const trustedHeadersEnabled = defaultPolicy.trustHeaders === true || process.env.OPENWIKI_TRUST_AUTH_HEADERS === "1";
  const trustedHeaderSecret = (defaultPolicy.trustedHeaderSecret ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET ?? "").trim();
  if (trustedHeadersEnabled) {
    if (trustedHeaderSecret.length === 0) {
      throw new Error("Trusted auth headers require OPENWIKI_TRUST_AUTH_HEADERS_SECRET or --trusted-header-secret");
    }
    if (trustedHeaderSecret.length < 16) {
      throw new Error("Trusted auth header secret must be at least 16 characters");
    }
  }

  if (process.env.OPENWIKI_TRUST_PROXY_ORIGIN === "1") {
    const proxyOriginSecret = (process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET ?? trustedHeaderSecret).trim();
    if (proxyOriginSecret.length === 0) {
      throw new Error("Trusted proxy origin requires OPENWIKI_TRUST_PROXY_ORIGIN_SECRET or OPENWIKI_TRUST_AUTH_HEADERS_SECRET");
    }
    if (proxyOriginSecret.length < 16) {
      throw new Error("Trusted proxy origin secret must be at least 16 characters");
    }
  }
}

/**
 * Process-wide serve --role/--scope elevates every request (and merges into
 * identity-less principals). That is only safe on loopback single-user binds.
 */
export function validateProcessWideDefaultPolicy(options: {
  host?: string;
  defaultPolicy?: HttpPolicyOptions;
} = {}): void {
  const policy = options.defaultPolicy ?? {};
  const processWideRole = policy.role !== undefined;
  const processWideScopes = policy.scopes !== undefined && policy.scopes.length > 0;
  if (!processWideRole && !processWideScopes) {
    return;
  }
  const host = options.host ?? "127.0.0.1";
  if (isLoopbackBindHost(host)) {
    return;
  }
  throw new Error(
    "Process-wide serve --role/--scope (or OPENWIKI_ROLE) is only allowed when binding to loopback (127.0.0.1, ::1, localhost). For non-loopback hosts use per-request trusted identity headers or service-account/OAuth tokens without process-wide role elevation.",
  );
}

/**
 * Explicit OPENWIKI_REQUIRE_AUTH=false must not disarm hosted / public-origin deployments.
 * Public unauthenticated content belongs on static export, not write-capable HTTP/MCP.
 */
export function validateHostedAuthConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const explicit = parseOptionalBooleanEnv(env.OPENWIKI_REQUIRE_AUTH ?? env.OPENWIKI_AUTH_REQUIRED);
  if (explicit !== false) {
    return;
  }
  if (env.OPENWIKI_PUBLIC_ORIGIN?.trim()) {
    throw new Error(
      "OPENWIKI_REQUIRE_AUTH=false is not allowed when OPENWIKI_PUBLIC_ORIGIN is set; use static export for public unauthenticated content",
    );
  }
  if (
    env.OPENWIKI_QUEUE_BACKEND === "postgres" ||
    env.OPENWIKI_OPERATIONAL_STATE_BACKEND === "postgres" ||
    env.OPENWIKI_WRITE_COORDINATOR_BACKEND === "postgres" ||
    env.OPENWIKI_READ_BACKEND === "postgres" ||
    env.OPENWIKI_SEARCH_BACKEND === "postgres" ||
    env.OPENWIKI_RUNTIME_BACKEND === "postgres"
  ) {
    throw new Error(
      "OPENWIKI_REQUIRE_AUTH=false is not allowed with hosted Postgres backends (queue, operational state, write coordinator, read, search, or runtime)",
    );
  }
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error("OPENWIKI_REQUIRE_AUTH must be true or false");
}

export async function handleHttpRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  defaultPolicy: HttpPolicyOptions = {},
): Promise<void> {
  const method = request.method ?? "GET";
  const context = requestContextFromIncoming(request);
  const requestId = context.requestId ?? randomUUID();
  response.setHeader("x-openwiki-request-id", requestId);
  response.setHeader("x-request-id", requestId);
  const mcpEndpoint = mcpEndpointUrl(request.url ?? "/");
  if (method === "OPTIONS") {
    if (mcpEndpoint !== undefined) {
      const originFailure = mcpOriginFailure(request);
      if (originFailure !== undefined) {
        writeRouteResult(response, originFailure);
        return;
      }
    }
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  if (mcpEndpoint !== undefined) {
    const originFailure = mcpOriginFailure(request);
    if (originFailure !== undefined) {
      writeRouteResult(response, originFailure);
      return;
    }
    const protocolFailure = mcpProtocolVersionFailure(request);
    if (protocolFailure !== undefined) {
      writeRouteResult(response, protocolFailure);
      return;
    }
    const requestPolicy = await policyOptionsFromRequest(root, request, httpTrustsRequestHeaders(defaultPolicy, request));
    const policy = await resolveHttpPolicy(root, mergeHttpPolicy(defaultPolicy, requestPolicy), {
      remoteAddress: context.remoteAddress,
    });
    const authenticationFailure = await requireAuthenticatedHttpPolicy(root, policy);
    if (authenticationFailure !== undefined) {
      writeRouteResult(response, authenticationFailure);
      return;
    }
    await writeMcpHttpResponse(root, request, response, mcpEndpoint, policy, context);
    return;
  }

  const browserWriteProtection = browserWriteProtectionFailure(request);
  if (browserWriteProtection !== undefined) {
    writeRouteResult(response, browserWriteProtection);
    return;
  }

  const assetName = webAssetNameFromUrl(request.url ?? "/");
  if (assetName !== undefined) {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, {
        ...corsHeaders(),
        "allow": "GET,HEAD,OPTIONS",
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Method not allowed\n");
      return;
    }
    await writeWebAsset(response, assetName, method === "HEAD", firstHeader(request.headers["if-none-match"]));
    return;
  }

  const eventStream = eventStreamUrl(request.url ?? "/");
  if (method === "GET" && eventStream) {
    const requestPolicy = await policyOptionsFromRequest(root, request, httpTrustsRequestHeaders(defaultPolicy, request));
    const policy = await resolveHttpPolicy(root, mergeHttpPolicy(defaultPolicy, requestPolicy), {
      remoteAddress: context.remoteAddress,
    });
    const authenticationFailure = await requireAuthenticatedHttpPolicy(root, policy);
    if (authenticationFailure !== undefined) {
      writeRouteResult(response, authenticationFailure);
      return;
    }
    const auth = authorizeHttp("wiki.list_events", policy);
    if (auth) {
      writeRouteResult(response, auth);
      return;
    }
    const route = classifyOperationalRoute(method, eventStream);
    const decision = await checkRateLimit(root, route, policy, context);
    if (!decision.allowed) {
      recordRateLimitRejection(route, decision);
      writeRouteResult(response, rateLimitRouteResult(route, decision));
      return;
    }
    await writeEventStream(root, request, response, eventStream, policy);
    return;
  }

  const routedMethod = method === "HEAD" ? "GET" : method;
  const parsedBody = routedMethod === "GET" ? undefined : await readRequestBodyWithRaw(request);
  const body = parsedBody?.body;
  const requestPolicy = await policyOptionsFromRequest(root, request, httpTrustsRequestHeaders(defaultPolicy, request));
  const result = await routeHttpRequest(
    root,
    routedMethod,
    request.url ?? "/",
    body,
    mergeHttpPolicy(defaultPolicy, requestPolicy),
    { ...context, headers: request.headers, ...(parsedBody === undefined ? {} : { rawBody: parsedBody.rawBody }) },
  );
  const ifNoneMatch = method === "GET" || method === "HEAD" ? firstHeader(request.headers["if-none-match"]) : undefined;
  writeRouteResult(response, result, method === "HEAD", ifNoneMatch ?? undefined);
}

export async function routeHttpRequest(
  root: string,
  method: string,
  rawUrl: string,
  body?: unknown,
  policy: HttpPolicyOptions = {},
  context: HttpRequestContext = {},
): Promise<HttpRouteResult> {
  const startedAt = Date.now();
  const requestId = context.requestId ?? randomUUID();
  const url = new URL(rawUrl, "http://openwiki.local");
  const route = classifyOperationalRoute(method, url, body);
  let effectivePolicy = policy;
  let status = 500;
  let rateLimited = false;
  try {
    const policyResolved = shouldResolvePolicyForOperationalRoute(method, url);
    effectivePolicy = policyResolved
      ? await resolveHttpPolicy(root, policy, { remoteAddress: context.remoteAddress })
      : policy;
    if (route.bucket !== undefined && url.pathname !== "/mcp") {
      const decision = await checkRateLimit(root, route, effectivePolicy, context);
      if (!decision.allowed) {
        rateLimited = true;
        status = 429;
        recordRateLimitRejection(route, decision);
        return rateLimitRouteResult(route, decision);
      }
    }
    const routeCall = () => routeHttpRequestInner(root, method, rawUrl, body, effectivePolicy, policyResolved ? { ...context, policyResolved: true } : context);
    const result = method === "GET" || method === "HEAD" ? await withRepositoryReadCache(routeCall) : await routeCall();
    status = result.status;
    return result;
  } catch (error) {
    status = httpErrorStatus(error);
    throw error;
  } finally {
    recordHttpRequestMetric(route, status, Date.now() - startedAt);
    writeRequestLog(context, {
      request_id: requestId,
      method,
      route: route.route,
      operation: route.operation,
      actor_id: effectivePolicy.actorId ?? "anonymous",
      status,
      duration_ms: Date.now() - startedAt,
      rate_limited: rateLimited,
      metadata: redactedRequestMetadata(policy, route, context),
    });
  }
}

function rateLimitRouteResult(
  route: ReturnType<typeof classifyOperationalRoute>,
  decision: Awaited<ReturnType<typeof checkRateLimit>>,
  now = Date.now(),
): HttpRouteResult {
  const resetAt = new Date(decision.resetAt).toISOString();
  return {
    status: 429,
    body: {
      error: {
        message: `Rate limit exceeded for ${route.operation}`,
        route: route.route,
        operation: route.operation,
        bucket: decision.bucket,
        dimension: decision.dimension,
        limit: decision.limit,
        reset_at: resetAt,
      },
    },
    headers: {
      "retry-after": String(Math.max(1, Math.ceil((decision.resetAt - now) / 1000))),
      "x-ratelimit-limit": String(decision.limit),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": resetAt,
    },
  };
}

function requestContextFromIncoming(request: IncomingMessage): HttpRequestContext {
  const requestId = firstHeader(request.headers["x-request-id"]) ?? firstHeader(request.headers["x-correlation-id"]) ?? randomUUID();
  return {
    requestId,
    remoteAddress: requestRemoteAddress(request),
  };
}

function requestRemoteAddress(request: IncomingMessage): string | undefined {
  if (trustedProxyOriginRequest(request)) {
    const forwarded = firstHeader(request.headers["x-forwarded-for"])?.split(",")[0]?.trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return request.socket.remoteAddress ?? undefined;
}
