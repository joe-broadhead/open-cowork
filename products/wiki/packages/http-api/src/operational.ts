import type { HttpPolicyOptions, HttpRequestContext } from "./types.ts";
import { hashOpenWikiOperationalValue, writeOpenWikiLog } from "@openwiki/core";
import type { McpToolMode } from "@openwiki/mcp-server";
import { incrementPostgresRateLimitWindow, migratePostgresRuntime } from "@openwiki/postgres-runtime";
import { readConfig } from "@openwiki/repo";
import { isObject, webActionId } from "./route-utils.ts";

const DEFAULT_RATE_LIMIT_WINDOW_MAX_KEYS = 10_000;

const DEFAULT_OPERATIONAL_METRIC_MAX_SERIES = 10_000;

type RateLimitBucket = "default" | "mcp" | "search" | "ask" | "source" | "proposal" | "policy" | "inbox" | "job" | "auth";

type RateLimitDimension = "ip" | "actor" | "token" | "anonymous";

type OperationalStateBackend = "memory" | "postgres";

export interface OperationalRoute {
  route: string;
  operation: string;
  bucket?: RateLimitBucket | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface RateLimitSettings {
  enabled: boolean;
  backend: OperationalStateBackend;
  windowMs: number;
  limits: Record<RateLimitBucket, number>;
}

export interface RateLimitDecision {
  allowed: boolean;
  bucket: RateLimitBucket;
  dimension: RateLimitDimension;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface RateLimitStoreIncrementInput {
  root: string;
  key: string;
  now: number;
  windowMs: number;
  maxKeys: number;
}

interface RateLimitStoreExpireInput {
  now: number;
  windowMs: number;
}

interface RateLimitStore {
  increment(input: RateLimitStoreIncrementInput): Promise<{ startedAt: number; count: number }>;
  expire(input: RateLimitStoreExpireInput): Promise<void>;
}

export interface HistogramMetric {
  count: number;
  sumSeconds: number;
  buckets: Map<number, number>;
}

interface MetricsSink {
  incrementCounter(map: Map<string, number>, key: string): void;
  observeHistogram(map: Map<string, HistogramMetric>, key: string, seconds: number): void;
}

const rateLimitWindows = new Map<string, { startedAt: number; count: number }>();
const REQUEST_LOG_STORE_LIMIT = 500;
const requestLogStore: Record<string, unknown>[] = [];

export const httpRequestCounters = new Map<string, number>();

export const mcpToolCounters = new Map<string, number>();

export const rateLimitRejectionCounters = new Map<string, number>();

export const httpRequestDurationMetrics = new Map<string, HistogramMetric>();

export const mcpToolDurationMetrics = new Map<string, HistogramMetric>();

export const searchLatencyMetrics = new Map<string, HistogramMetric>();

let lastRateLimitPruneAt = 0;

export const LATENCY_BUCKET_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const inMemoryMetricsSink: MetricsSink = {
  incrementCounter(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
    pruneOldestMapEntries(map, operationalMetricMaxSeries());
  },
  observeHistogram(map, key, seconds) {
    const metric = map.get(key) ?? { count: 0, sumSeconds: 0, buckets: new Map<number, number>() };
    metric.count += 1;
    metric.sumSeconds += Math.max(seconds, 0);
    for (const bucket of LATENCY_BUCKET_SECONDS) {
      if (seconds <= bucket) {
        metric.buckets.set(bucket, (metric.buckets.get(bucket) ?? 0) + 1);
      }
    }
    map.set(key, metric);
    pruneOldestMapEntries(map, operationalMetricMaxSeries());
  },
};

export function resetHttpOperationalStateForTests(): void {
  rateLimitWindows.clear();
  httpRequestCounters.clear();
  mcpToolCounters.clear();
  rateLimitRejectionCounters.clear();
  httpRequestDurationMetrics.clear();
  mcpToolDurationMetrics.clear();
  searchLatencyMetrics.clear();
  lastRateLimitPruneAt = 0;
}

export function shouldResolvePolicyForOperationalRoute(method: string, url: URL): boolean {
  return !isPublicOperationalRoute(method, url.pathname);
}

export function classifyOperationalRoute(method: string, url: URL, body?: unknown): OperationalRoute {
  if (url.pathname === "/mcp") {
    const mcp = mcpRequestMetadata(body);
    return {
      route: "/mcp",
      operation: mcp.tool === undefined ? `mcp.${mcp.method ?? "request"}` : mcp.tool,
      bucket: "mcp",
      metadata: {
        ...(mcp.method === undefined ? {} : { mcp_method: mcp.method }),
        ...(mcp.tool === undefined ? {} : { mcp_tool: mcp.tool }),
        ...(url.searchParams.get("tools") === null ? {} : { mcp_mode: url.searchParams.get("tools") ?? "" }),
      },
    };
  }
  if (isPublicOperationalRoute(method, url.pathname)) {
    return { route: normalizeRoutePath(url.pathname), operation: routeOperation(method, url.pathname), bucket: undefined };
  }
  if (url.pathname === "/api/v1/search") {
    return { route: "/api/v1/search", operation: "wiki.search", bucket: "search" };
  }
  if (url.pathname === "/api/v1/ask") {
    return { route: "/api/v1/ask", operation: "wiki.ask", bucket: "ask" };
  }
  if (url.pathname === "/api/v1/think") {
    return { route: "/api/v1/think", operation: "wiki.think", bucket: "ask" };
  }
  if (url.pathname === "/api/v1/sources" || url.pathname.startsWith("/api/v1/sources/")) {
    return { route: normalizeRoutePath(url.pathname), operation: sourceOperation(url.pathname), bucket: sourceRateBucket(url.pathname) };
  }
  if (url.pathname === "/api/v1/proposals" || url.pathname.startsWith("/api/v1/proposals/")) {
    return { route: normalizeRoutePath(url.pathname), operation: proposalOperation(url.pathname), bucket: method === "POST" ? "proposal" : "default" };
  }
  if (url.pathname === "/api/v1/synthesis" || url.pathname === "/api/v1/synthesis/create") {
    return { route: url.pathname, operation: url.pathname.endsWith("/create") ? "wiki.create_synthesis" : "wiki.propose_synthesis", bucket: "proposal" };
  }
  if (url.pathname.startsWith("/api/v1/policy") || url.pathname === "/policy" || url.pathname.startsWith("/policy/") || url.pathname === "/spaces" || url.pathname.startsWith("/spaces/")) {
    return { route: normalizeRoutePath(url.pathname), operation: policyOperation(url.pathname), bucket: "policy" };
  }
  if (url.pathname.startsWith("/api/v1/inbox") || url.pathname === "/inbox" || url.pathname.startsWith("/inbox/")) {
    return { route: normalizeRoutePath(url.pathname), operation: inboxOperation(method, url.pathname), bucket: "inbox" };
  }
  if (url.pathname.startsWith("/api/v1/runs") || url.pathname.startsWith("/api/v1/dream/runs") || url.pathname === "/runs" || url.pathname.startsWith("/runs/") || url.pathname.startsWith("/api/v1/git") || url.pathname === "/api/v1/publish" || url.pathname === "/api/v1/commit" || (method === "POST" && url.pathname === "/api/v1/sync/now")) {
    return { route: normalizeRoutePath(url.pathname), operation: jobOperation(method, url.pathname), bucket: "job" };
  }
  if (method === "POST" && webActionId(url.pathname, "/pages/", "propose")) {
    return { route: "/pages/:id/propose", operation: "wiki.propose_edit", bucket: "proposal" };
  }
  if (method === "POST") {
    const proposalAction = webProposalAction(url.pathname);
    if (proposalAction !== undefined) {
      return { route: `/proposals/:id/${proposalAction.action}`, operation: proposalAction.operation, bucket: "proposal" };
    }
  }
  if (url.pathname.startsWith("/api/v1/auth") || url.pathname.startsWith("/api/v1/tokens") || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/oauth-")) {
    return { route: normalizeRoutePath(url.pathname), operation: "wiki.admin", bucket: "auth" };
  }
  return { route: normalizeRoutePath(url.pathname), operation: routeOperation(method, url.pathname), bucket: "default" };
}

function isPublicOperationalRoute(method: string, pathname: string): boolean {
  return (
    method === "GET" &&
    (pathname === "/livez" ||
      pathname === "/api/v1/livez" ||
      pathname === "/readyz" ||
      pathname === "/api/v1/readyz")
  );
}

export function mcpRequestMetadata(body: unknown): { method?: string; tool?: string } {
  if (!isObject(body)) {
    return {};
  }
  const method = typeof body.method === "string" ? body.method : undefined;
  const params = body.params;
  if (method !== "tools/call" || !isObject(params) || typeof params.name !== "string") {
    return method === undefined ? {} : { method };
  }
  return { method, tool: params.name };
}

function normalizeRoutePath(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => {
      try {
        const decoded = decodeURIComponent(part);
        return /^(page|source|claim|proposal|decision|run|event|actor|service):/.test(decoded) ? ":id" : part;
      } catch {
        return part;
      }
    })
    .join("/");
}

function sourceOperation(pathname: string): string {
  if (pathname.endsWith("/fetch")) return "wiki.fetch_source";
  if (pathname.endsWith("/ingest")) return "wiki.ingest_source";
  if (pathname.endsWith("/propose")) return "wiki.propose_source";
  return "wiki.read_source";
}

function sourceRateBucket(pathname: string): RateLimitBucket | undefined {
  return pathname.endsWith("/fetch") || pathname.endsWith("/ingest") || pathname.endsWith("/propose") ? "source" : "default";
}

function proposalOperation(pathname: string): string {
  if (pathname.endsWith("/comments")) return "wiki.comment_on_proposal";
  if (pathname.endsWith("/review")) return "wiki.review_proposal";
  if (pathname.endsWith("/close")) return "wiki.close_proposal";
  if (pathname.endsWith("/apply")) return "wiki.apply_proposal";
  return "wiki.propose_edit";
}

function webProposalAction(pathname: string): { action: "comment" | "review" | "close" | "apply"; operation: string } | undefined {
  const actions: Array<{ action: "comment" | "review" | "close" | "apply"; operation: string }> = [
    { action: "comment", operation: "wiki.comment_on_proposal" },
    { action: "review", operation: "wiki.review_proposal" },
    { action: "close", operation: "wiki.close_proposal" },
    { action: "apply", operation: "wiki.apply_proposal" },
  ];
  return actions.find((action) => webActionId(pathname, "/proposals/", action.action));
}

function policyOperation(pathname: string): string {
  if (pathname.endsWith("/preview")) return "wiki.preview_permissions";
  if (pathname.endsWith("/identities")) return "wiki.list_policy_identities";
  if (pathname.endsWith("/sections/proposals") || pathname.endsWith("/sections/propose")) return "wiki.propose_section_policy";
  if (pathname.endsWith("/proposals") || pathname.endsWith("/propose")) return "wiki.propose_policy_change";
  return "wiki.read_policy";
}

function inboxOperation(method: string, pathname: string): string {
  if (method === "POST" && pathname.endsWith("/process")) return "wiki.process_inbox";
  if (method === "POST" && pathname.endsWith("/ignore")) return "wiki.ignore_inbox";
  if (method === "POST" && pathname.endsWith("/retry")) return "wiki.retry_inbox";
  if (method === "POST") return "wiki.submit_inbox";
  return "wiki.list_inbox";
}

function jobOperation(method: string, pathname: string): string {
  if (pathname.startsWith("/api/v1/dream/runs")) return method === "POST" ? "wiki.dream_run" : "wiki.dream_status";
  if (pathname === "/api/v1/git/status") return "wiki.git_status";
  if (pathname === "/api/v1/git/pull") return "wiki.git_pull";
  if (pathname === "/api/v1/git/push") return "wiki.git_push";
  if (pathname === "/api/v1/git/configure") return "wiki.admin";
  if (pathname === "/api/v1/publish") return "wiki.publish";
  if (pathname === "/api/v1/commit") return "wiki.commit_changes";
  if (method === "POST" && pathname === "/api/v1/sync/now") return "wiki.sync_now";
  if (method === "POST") return "wiki.run_job";
  return "wiki.list_runs";
}

function routeOperation(method: string, pathname: string): string {
  if (method === "GET") {
    return pathname === "/" ? "wiki.read_page" : "wiki.read";
  }
  return "wiki.write";
}

export async function checkRateLimit(
  root: string,
  route: OperationalRoute,
  policy: HttpPolicyOptions,
  context: HttpRequestContext,
): Promise<RateLimitDecision> {
  const settings = await rateLimitSettings(root);
  const bucket = route.bucket ?? "default";
  const limit = settings.limits[bucket];
  if (!settings.enabled || limit < 1) {
    return { allowed: true, bucket, dimension: "anonymous", limit, remaining: limit, resetAt: Date.now() + settings.windowMs };
  }
  const dimensions = rateLimitDimensions(policy, context);
  const now = Date.now();
  const store = rateLimitStore(settings.backend);
  await store.expire({ now, windowMs: settings.windowMs });
  let mostConstrained: RateLimitDecision = { allowed: true, bucket, dimension: "anonymous", limit, remaining: limit, resetAt: now + settings.windowMs };
  for (const dimension of dimensions) {
    const key = rateLimitKey(bucket, route.route, dimension);
    const window = await store.increment({
      root,
      key,
      now,
      windowMs: settings.windowMs,
      maxKeys: rateLimitWindowMaxKeys(),
    });
    const remaining = Math.max(limit - window.count, 0);
    const decision = {
      allowed: window.count <= limit,
      bucket,
      dimension: dimension.dimension,
      limit,
      remaining,
      resetAt: window.startedAt + settings.windowMs,
    };
    if (!decision.allowed) {
      return decision;
    }
    if (decision.remaining < mostConstrained.remaining) {
      mostConstrained = decision;
    }
  }
  return mostConstrained;
}

function rateLimitStore(backend: OperationalStateBackend): RateLimitStore {
  return backend === "postgres" ? postgresRateLimitStore : memoryRateLimitStore;
}

const memoryRateLimitStore: RateLimitStore = {
  async increment(input) {
    return incrementMemoryRateLimitWindow(input.key, input.now, input.windowMs);
  },
  async expire(input) {
    pruneExpiredRateLimitWindows(input.now, input.windowMs);
  },
};

const postgresRateLimitStore: RateLimitStore = {
  async increment(input) {
    return incrementPostgresRateLimitWindow({
      root: input.root,
      key: input.key,
      now: input.now,
      windowMs: input.windowMs,
      maxKeys: input.maxKeys,
    });
  },
  async expire() {
    return;
  },
};

function rateLimitDimensions(policy: HttpPolicyOptions, context: HttpRequestContext): Array<{ dimension: RateLimitDimension; value: string }> {
  const dimensions: Array<{ dimension: RateLimitDimension; value: string }> = [];
  if (context.remoteAddress !== undefined) {
    dimensions.push({ dimension: "ip", value: hashOperationalValue(context.remoteAddress) });
  }
  if (policy.actorId !== undefined) {
    dimensions.push({ dimension: "actor", value: policy.actorId });
  }
  if (policy.token !== undefined) {
    dimensions.push({ dimension: "token", value: hashOperationalValue(policy.token) });
  }
  return dimensions.length === 0 ? [{ dimension: "anonymous", value: "anonymous" }] : dimensions;
}

function rateLimitKey(bucket: RateLimitBucket, route: string, dimension: { dimension: RateLimitDimension; value: string }): string {
  return [bucket, route, dimension.dimension, dimension.value].join("|");
}

function incrementMemoryRateLimitWindow(key: string, now: number, windowMs: number): { startedAt: number; count: number } {
  const window = currentRateLimitWindow(key, now, windowMs);
  window.count += 1;
  return window;
}

function currentRateLimitWindow(key: string, now: number, windowMs: number): { startedAt: number; count: number } {
  const current = rateLimitWindows.get(key);
  if (current !== undefined && now - current.startedAt < windowMs) {
    return current;
  }
  const next = { startedAt: now, count: 0 };
  rateLimitWindows.set(key, next);
  pruneOldestMapEntries(rateLimitWindows, rateLimitWindowMaxKeys());
  return next;
}

function pruneExpiredRateLimitWindows(now: number, windowMs: number): void {
  if (now - lastRateLimitPruneAt < windowMs) {
    return;
  }
  lastRateLimitPruneAt = now;
  for (const [key, window] of rateLimitWindows) {
    if (now - window.startedAt >= windowMs) {
      rateLimitWindows.delete(key);
    }
  }
}

export async function rateLimitSettings(root: string): Promise<RateLimitSettings> {
  const config = await readConfig(root).catch(() => undefined);
  const configured = config?.runtime?.controls?.rate_limits;
  const operationalState = config?.runtime?.controls?.operational_state;
  const enabled = booleanFromEnv("OPENWIKI_RATE_LIMIT_ENABLED") ?? configured?.enabled ?? hostedControlsDefault(config?.runtime?.profile);
  const windowMs = boundedOperationalNumber(numberFromEnv("OPENWIKI_RATE_LIMIT_WINDOW_MS") ?? configured?.window_ms ?? 60000, 1000, 60 * 60 * 1000, "rate limit window");
  const defaultLimit = boundedOperationalNumber(numberFromEnv("OPENWIKI_RATE_LIMIT_REQUESTS") ?? configured?.default_limit ?? 600, 0, 1_000_000, "default rate limit");
  return {
    enabled,
    backend: operationalStateBackendFromEnvOrConfig(operationalState?.backend),
    windowMs,
    limits: {
      default: defaultLimit,
      mcp: limitFor("OPENWIKI_RATE_LIMIT_MCP", configured?.mcp_limit, 120, defaultLimit),
      search: limitFor("OPENWIKI_RATE_LIMIT_SEARCH", configured?.search_limit, 120, defaultLimit),
      ask: limitFor("OPENWIKI_RATE_LIMIT_ASK", configured?.ask_limit, 60, defaultLimit),
      source: limitFor("OPENWIKI_RATE_LIMIT_SOURCE", configured?.source_limit, 30, defaultLimit),
      proposal: limitFor("OPENWIKI_RATE_LIMIT_PROPOSAL", configured?.proposal_limit, 60, defaultLimit),
      policy: limitFor("OPENWIKI_RATE_LIMIT_POLICY", configured?.policy_limit, 60, defaultLimit),
      inbox: limitFor("OPENWIKI_RATE_LIMIT_INBOX", configured?.inbox_limit, 60, defaultLimit),
      job: limitFor("OPENWIKI_RATE_LIMIT_JOB", configured?.job_limit, 30, defaultLimit),
      auth: limitFor("OPENWIKI_RATE_LIMIT_AUTH", configured?.auth_limit, 20, defaultLimit),
    },
  };
}

export async function operationalStateBackend(root: string): Promise<OperationalStateBackend> {
  const config = await readConfig(root).catch(() => undefined);
  return operationalStateBackendFromEnvOrConfig(config?.runtime?.controls?.operational_state?.backend);
}

export function operationalStateBackendFromEnvOrConfig(configured: string | undefined): OperationalStateBackend {
  const env = process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND?.trim().toLowerCase();
  const value = env && env.length > 0 ? env : configured;
  if (value === undefined || value === "" || value === "memory") {
    return "memory";
  }
  if (value === "postgres") {
    return "postgres";
  }
  throw new Error("OPENWIKI_OPERATIONAL_STATE_BACKEND must be memory or postgres");
}

export async function ensureHttpOperationalState(root: string): Promise<void> {
  if (await operationalStateBackend(root) !== "postgres") {
    return;
  }
  if (process.env.OPENWIKI_POSTGRES_MIGRATE === "0") {
    return;
  }
  await migratePostgresRuntime();
}

function hostedControlsDefault(profile: string | undefined): boolean {
  if (process.env.OPENWIKI_PUBLIC_ORIGIN !== undefined && process.env.OPENWIKI_PUBLIC_ORIGIN.trim() !== "") {
    return true;
  }
  return profile === "team" || profile === "hosted" || profile === "compose" || profile === "umbrel" || profile === "cloud" || profile === "enterprise";
}

function limitFor(envName: string, configured: number | undefined, fallback: number, defaultLimit: number): number {
  return boundedOperationalNumber(numberFromEnv(envName) ?? configured ?? Math.min(fallback, defaultLimit), 0, 1_000_000, envName);
}

export function boundedOperationalNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return Math.trunc(value);
}

export function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}

export function booleanFromEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function recordHttpRequestMetric(route: OperationalRoute, status: number, durationMs: number): void {
  incrementCounter(httpRequestCounters, [route.route, route.operation, String(status)].join("|"));
  observeHistogram(httpRequestDurationMetrics, [route.route, route.operation, String(status)].join("|"), durationMs / 1000);
}

export function recordMcpToolMetric(tool: string, mode: McpToolMode, status: string, durationMs: number): void {
  incrementCounter(mcpToolCounters, [tool, mode, status].join("|"));
  observeHistogram(mcpToolDurationMetrics, [tool, mode, status].join("|"), durationMs / 1000);
}

export function recordSearchLatencyMetric(backend: string, mode: string, status: string, durationMs: number): void {
  observeHistogram(searchLatencyMetrics, [backend, mode, status].join("|"), durationMs / 1000);
}

export function recordRateLimitRejection(route: OperationalRoute, decision: RateLimitDecision): void {
  incrementCounter(rateLimitRejectionCounters, [route.route, route.operation, decision.dimension].join("|"));
}

function incrementCounter(map: Map<string, number>, key: string): void {
  inMemoryMetricsSink.incrementCounter(map, key);
}

function observeHistogram(map: Map<string, HistogramMetric>, key: string, seconds: number): void {
  inMemoryMetricsSink.observeHistogram(map, key, seconds);
}

function rateLimitWindowMaxKeys(): number {
  return boundedOperationalNumber(
    numberFromEnv("OPENWIKI_RATE_LIMIT_MAX_KEYS") ?? DEFAULT_RATE_LIMIT_WINDOW_MAX_KEYS,
    1,
    1_000_000,
    "rate limit key cap",
  );
}

function operationalMetricMaxSeries(): number {
  return boundedOperationalNumber(
    numberFromEnv("OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES") ?? DEFAULT_OPERATIONAL_METRIC_MAX_SERIES,
    1,
    1_000_000,
    "operational metric series cap",
  );
}

function pruneOldestMapEntries<T>(map: Map<string, T>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    map.delete(oldest);
  }
}

export function writeRequestLog(context: HttpRequestContext, entry: Record<string, unknown>): void {
  requestLogStore.push(entry);
  while (requestLogStore.length > REQUEST_LOG_STORE_LIMIT) {
    requestLogStore.shift();
  }
  if (process.env.OPENWIKI_REQUEST_LOGS !== "1" && context.logger === undefined) {
    return;
  }
  writeOpenWikiLog(
    {
      event: "http_request",
      ...entry,
    },
    {
      enabled: process.env.OPENWIKI_REQUEST_LOGS === "1",
      ...(context.logger === undefined ? {} : { sink: context.logger }),
    },
  );
}

export function readRecentRequestLogs(limit = 100): Record<string, unknown>[] {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), REQUEST_LOG_STORE_LIMIT);
  return requestLogStore.slice(-boundedLimit).reverse();
}

export function redactedRequestMetadata(policy: HttpPolicyOptions, route: OperationalRoute, context: HttpRequestContext): Record<string, unknown> {
  return {
    ...(route.bucket === undefined ? {} : { rate_limit_bucket: route.bucket }),
    ...(context.remoteAddress === undefined ? {} : { ip_hash: hashOperationalValue(context.remoteAddress) }),
    ...(policy.token === undefined ? {} : { token_hash: hashOperationalValue(policy.token) }),
    ...(policy.authMethod === undefined ? {} : { auth_method: policy.authMethod }),
    ...(policy.serviceAccountId === undefined ? {} : { service_account_id: policy.serviceAccountId }),
    ...(policy.oauthClientId === undefined ? {} : { oauth_client_id: policy.oauthClientId }),
    ...(policy.oauthTokenId === undefined ? {} : { oauth_token_id: policy.oauthTokenId }),
    ...(policy.bounds === undefined ? {} : { bounds: redactedBoundsMetadata(policy.bounds) }),
    ...(route.metadata ?? {}),
  };
}

function redactedBoundsMetadata(bounds: NonNullable<HttpPolicyOptions["bounds"]>): Record<string, unknown> {
  return {
    ...(bounds.operations === undefined ? {} : { operations: bounds.operations }),
    ...(bounds.toolModes === undefined ? {} : { tool_modes: bounds.toolModes }),
    ...(bounds.pathPrefixes === undefined ? {} : { path_prefix_hashes: bounds.pathPrefixes.map(hashOperationalValue) }),
    ...(bounds.sectionIds === undefined ? {} : { section_hashes: bounds.sectionIds.map(hashOperationalValue) }),
    ...(bounds.sourceIds === undefined ? {} : { source_hashes: bounds.sourceIds.map(hashOperationalValue) }),
    ...(bounds.inboxProviders === undefined ? {} : { inbox_provider_hashes: bounds.inboxProviders.map(hashOperationalValue) }),
    ...(bounds.dailyBudget === undefined ? {} : { daily_budget: bounds.dailyBudget }),
    ...(bounds.maxConcurrentRequests === undefined ? {} : { max_concurrent_requests: bounds.maxConcurrentRequests }),
    ...(bounds.expiresAt === undefined ? {} : { expires_at: bounds.expiresAt }),
  };
}

export function hashOperationalValue(value: string): string {
  return hashOpenWikiOperationalValue(value);
}
