import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OpenWikiError, openWikiHttpStatusForError, openWikiOffsetCursor, type DecisionValue, type ProposalStatus, type RunRecord, type SearchPersona, type SearchRequest } from "@openwiki/core";
import { InvalidGitRevisionError } from "@openwiki/git";
import { parseRole, parseScopes, type OpenWikiRole, type OpenWikiScope } from "@openwiki/policy";
import type { GovernanceDetectorKind, ServiceAccountTokenProfile } from "@openwiki/workflows";
import { firstHeader } from "./http-headers.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "./types.ts";

type RunStatus = RunRecord["status"];

class HttpBadRequestError extends OpenWikiError {
  constructor(message: string) {
    super("bad_request", message, 400);
    this.name = "HttpBadRequestError";
  }
}

class HttpPayloadTooLargeError extends OpenWikiError {
  constructor(message: string) {
    super("payload_too_large", message, 413);
    this.name = "HttpPayloadTooLargeError";
  }
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_JSON_BODY_DEPTH = 100;
/** Read and validate a JSON or form request body with OpenWiki size/depth limits. */
export async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return (await readRequestBodyWithRaw(request)).body;
}

export async function readRequestBodyWithRaw(request: IncomingMessage): Promise<{ body: unknown; rawBody: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new HttpPayloadTooLargeError("Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return { body: {}, rawBody: "" };
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const raw = rawBody.trim();
  if (!raw) {
    return { body: {}, rawBody };
  }
  const contentType = firstHeader(request.headers["content-type"]) ?? "";
  if (contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return { body: Object.fromEntries(new URLSearchParams(raw).entries()), rawBody };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpBadRequestError("Request body must be valid JSON");
  }
  assertJsonBodyDepth(parsed);
  return { body: parsed, rawBody };
}

function assertJsonBodyDepth(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_BODY_DEPTH) {
    throw new HttpBadRequestError(`Request JSON body exceeds maximum depth ${MAX_JSON_BODY_DEPTH}`);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    assertJsonBodyDepth(entry, depth + 1);
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new HttpBadRequestError("Expected object request body");
}

export function stringBody(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpBadRequestError(`Expected string body field '${key}'`);
  }
  return value;
}

export function stringListBody(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new HttpBadRequestError(`Expected string list body field '${key}'`);
    }
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  throw new HttpBadRequestError(`Expected string list body field '${key}'`);
}

export function visibilityBody(params: Record<string, unknown>, key: string): "public" | "internal" | "private" | undefined {
  const value = params[key];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "public" || value === "internal" || value === "private") {
    return value;
  }
  throw new HttpBadRequestError(`Invalid visibility '${String(value)}'`);
}

export function policyFileBody(params: Record<string, unknown>, key: string): "sections" | "grants" | "approval-rules" | "approval_rules" {
  const value = stringBody(params, key);
  if (value === "sections" || value === "grants" || value === "approval-rules" || value === "approval_rules") {
    return value;
  }
  throw new HttpBadRequestError("Invalid policy file '" + value + "'");
}

export function policyBody(params: Record<string, unknown>): string {
  const value = params.body;
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  const records = params.records;
  if (Array.isArray(records)) {
    return JSON.stringify(records, null, 2) + "\n";
  }
  throw new HttpBadRequestError("Expected policy body string or records array");
}

export function serviceAccountTokenCreateParams(params: Record<string, unknown>): {
  id?: string;
  profile?: ServiceAccountTokenProfile;
  actorId?: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals?: string[];
  groups?: string[];
  expiresAt?: string;
  expiresInDays?: number;
  description?: string;
  tokenDescription?: string;
} {
  const profile = optionalServiceAccountTokenProfile(params.profile);
  const role = optionalOpenWikiRole(params.role);
  const scopes = stringListBody(params, "scopes").flatMap((entry) => parseScopes(entry));
  const expiresInDays = optionalNumberBody(params, "expires_in_days");
  return {
    ...optionalNonEmptyStringProperty(params, "id", "id"),
    ...(profile === undefined ? {} : { profile }),
    ...optionalNonEmptyStringProperty(params, "actor_id", "actorId"),
    ...(role === undefined ? {} : { role }),
    ...(scopes.length === 0 ? {} : { scopes }),
    ...optionalStringListProperty(params, "principals", "principals"),
    ...optionalStringListProperty(params, "groups", "groups"),
    ...optionalNonEmptyStringProperty(params, "expires_at", "expiresAt"),
    ...(expiresInDays === undefined ? {} : { expiresInDays }),
    ...optionalNonEmptyStringProperty(params, "description", "description"),
    ...optionalNonEmptyStringProperty(params, "token_description", "tokenDescription"),
  };
}

function optionalServiceAccountTokenProfile(value: unknown): ServiceAccountTokenProfile | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (
    value === "local-agent" ||
    value === "ci-bot" ||
    value === "hosted-readonly-agent" ||
    value === "inbox-submitter" ||
    value === "inbox-curator" ||
    value === "proposal-agent" ||
    value === "maintainer-automation"
  ) {
    return value;
  }
  throw new HttpBadRequestError(`Invalid service-account token profile '${String(value)}'`);
}

function optionalOpenWikiRole(value: unknown): OpenWikiRole | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpBadRequestError("Expected string body field 'role'");
  }
  const role = parseRole(value);
  if (role === undefined) {
    throw new HttpBadRequestError(`Invalid OpenWiki role '${value}'`);
  }
  return role;
}

export function optionalStringProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string>> {
  const value = params[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new HttpBadRequestError(`Expected string body field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, string>>;
}

function optionalStringListProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const values = stringListBody(params, inputKey);
  return values.length === 0 ? {} : ({ [outputKey]: values } as Partial<Record<Key, string[]>>);
}

export function optionalAuditActor(policy: HttpPolicyOptions): { auditActorId?: string } {
  return policy.actorId === undefined ? {} : { auditActorId: policy.actorId };
}

export function optionalRequestActor(policy: HttpPolicyOptions, params: Record<string, unknown>): { actorId?: string } {
  if (policy.actorId !== undefined) {
    return { actorId: policy.actorId };
  }
  if (
    policy.role !== undefined ||
    policy.token !== undefined ||
    (policy.scopes !== undefined && policy.scopes.length > 0) ||
    (policy.principals !== undefined && policy.principals.length > 0)
  ) {
    return {};
  }
  return optionalNonEmptyStringProperty(params, "actor_id", "actorId");
}

export function optionalPolicyActor(policy: HttpPolicyOptions): { actorId?: string } {
  return policy.actorId === undefined ? {} : { actorId: policy.actorId };
}

export function optionalNonEmptyStringProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string>> {
  const value = params[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new HttpBadRequestError(`Expected string body field '${inputKey}'`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? {} : ({ [outputKey]: trimmed } as Partial<Record<Key, string>>);
}

export function optionalBooleanProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, boolean>> {
  const value = params[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new HttpBadRequestError(`Expected boolean body field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, boolean>>;
}

export function optionalStringArrayProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const value = params[inputKey];
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new HttpBadRequestError(`Expected string array body field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, string[]>>;
}

export function optionalObjectProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, Record<string, unknown>>> {
  const value = params[inputKey];
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpBadRequestError(`Expected object body field '${inputKey}'`);
  }
  return { [outputKey]: value as Record<string, unknown> } as Partial<Record<Key, Record<string, unknown>>>;
}

export function optionalNumberProperty<Key extends string>(
  params: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, number>> {
  const value = optionalNumberBody(params, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, number>>);
}

export function optionalBooleanBody(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true" || value === "1" || value === "yes") {
      return true;
    }
    if (value === "false" || value === "0" || value === "no") {
      return false;
    }
  }
  throw new HttpBadRequestError(`Expected boolean body field '${key}'`);
}

export function optionalNumberBody(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new HttpBadRequestError(`Expected numeric body field '${key}'`);
  }
  return parsed;
}

export function requiredQuery(url: URL, primary: string, fallback: string): string {
  const value = url.searchParams.get(primary) ?? url.searchParams.get(fallback);
  if (!value?.trim()) {
    throw new HttpBadRequestError("Missing required query parameter " + primary);
  }
  return value;
}

export function optionalLimitObject(url: URL): { limit?: number } {
  const limit = numberQuery(url, "limit");
  return limit === undefined ? {} : { limit };
}

export function boundedOffset(value: number | undefined, max: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function optionalGraphDirectionQuery(url: URL): { direction?: "in" | "out" | "both" } {
  const value = url.searchParams.get("direction");
  if (value === null) {
    return {};
  }
  if (value === "in" || value === "out" || value === "both") {
    return { direction: value };
  }
  throw new HttpBadRequestError("Expected direction to be in, out, or both");
}

export function numberQuery(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpBadRequestError(`Expected numeric query parameter '${key}'`);
  }
  return parsed;
}

export function boundedNumberQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const value = numberQuery(url, key) ?? fallback;
  return Math.min(Math.max(value, min), max);
}

export function optionalSearchParam<Key extends string>(url: URL, inputKey: string, outputKey: Key): Partial<Record<Key, string>> {
  const value = url.searchParams.get(inputKey);
  return value === null ? {} : ({ [outputKey]: value } as Partial<Record<Key, string>>);
}

export function optionalSearchTypes(url: URL): Pick<SearchRequest, "types"> {
  const types = stringListQuery(url, "type", "types");
  return types.length === 0 ? {} : { types };
}

export function searchOffsetFromCursor(cursor: string | null): number | undefined {
  if (cursor === null || cursor.trim().length === 0) {
    return undefined;
  }
  const value = cursor.trim();
  const offset = value.startsWith("offset:") ? Number(value.slice("offset:".length)) : Number(value);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpBadRequestError("Invalid search cursor");
  }
  return offset;
}

export function offsetCursor(offset: number): string {
  return openWikiOffsetCursor(offset);
}

export function paginateOffsetItems<T>(items: T[], limit: number, offset = 0): { items: T[]; next_cursor?: string } {
  const pageSize = Math.max(Math.trunc(limit), 0);
  const start = Math.max(Math.trunc(offset), 0);
  const windowed = items.slice(start, start + pageSize);
  return {
    items: windowed,
    ...(items.length > start + windowed.length ? { next_cursor: offsetCursor(start + windowed.length) } : {}),
  };
}

export function optionalGovernanceDetectorsQuery(url: URL): { detectors?: GovernanceDetectorKind[] } {
  const values = stringListQuery(url, "detector", "detectors");
  if (values.length === 0) {
    return {};
  }
  return { detectors: values.map(governanceDetectorKindQuery) };
}

function governanceDetectorKindQuery(value: string): GovernanceDetectorKind {
  if (value === "stale_claim" || value === "missing_source" || value === "broken_link" || value === "orphan_page") {
    return value;
  }
  throw new HttpBadRequestError(`Invalid governance detector '${value}'`);
}

export function optionalStaleAfterDaysQuery(url: URL): { staleAfterDays?: number } {
  const value = numberQuery(url, "stale_after_days");
  return value === undefined ? {} : { staleAfterDays: value };
}

export function optionalSearchFilters(url: URL): Pick<SearchRequest, "filters"> {
  const filters: NonNullable<SearchRequest["filters"]> = {};
  const topics = stringListQuery(url, "topic", "topics");
  const statuses = stringListQuery(url, "status", "statuses");
  const updatedAfter = url.searchParams.get("updated_after") ?? url.searchParams.get("updatedAfter");
  if (topics.length > 0) {
    filters.topics = topics;
  }
  if (statuses.length > 0) {
    filters.status = statuses;
  }
  if (updatedAfter !== null) {
    filters.updated_after = updatedAfter;
  }
  return Object.keys(filters).length === 0 ? {} : { filters };
}

export function optionalSearchPersona(url: URL): Pick<SearchRequest, "persona"> {
  const value = url.searchParams.get("persona");
  if (value === null) {
    return {};
  }
  return { persona: searchPersona(value) };
}

export function optionalSearchMode(url: URL): Pick<SearchRequest, "mode"> {
  const value = url.searchParams.get("mode");
  if (value === null) {
    return {};
  }
  if (value === "lexical" || value === "hybrid") {
    return { mode: value };
  }
  throw new HttpBadRequestError(`Invalid search mode '${value}'`);
}

export function optionalSearchBoolean<Key extends string>(
  url: URL,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, boolean>> {
  const value = url.searchParams.get(inputKey);
  if (value === null) {
    return {};
  }
  if (value === "true") {
    return { [outputKey]: true } as Partial<Record<Key, boolean>>;
  }
  if (value === "false") {
    return { [outputKey]: false } as Partial<Record<Key, boolean>>;
  }
  throw new HttpBadRequestError(`Expected boolean query parameter '${inputKey}'`);
}

function stringListQuery(url: URL, singularKey: string, pluralKey: string): string[] {
  return [...url.searchParams.getAll(singularKey), ...url.searchParams.getAll(pluralKey)]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function proposalStatusesQuery(url: URL): ProposalStatus[] | undefined {
  const values = stringListQuery(url, "status", "statuses");
  if (values.length === 0) {
    return undefined;
  }
  return values.map(proposalStatus);
}

export function runStatusesQuery(url: URL): RunStatus[] | undefined {
  const values = stringListQuery(url, "status", "statuses");
  if (values.length === 0) {
    return undefined;
  }
  return values.map(runStatus);
}

function proposalStatus(value: string): ProposalStatus {
  if (value === "open" || value === "accepted" || value === "rejected" || value === "applied" || value === "closed") {
    return value;
  }
  throw new HttpBadRequestError(`Invalid proposal status '${value}'`);
}

function runStatus(value: string): RunStatus {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") {
    return value;
  }
  throw new HttpBadRequestError(`Invalid run status '${value}'`);
}

function searchPersona(value: string): SearchPersona {
  if (
    value === "default" ||
    value === "researcher" ||
    value === "editor" ||
    value === "reviewer" ||
    value === "governance"
  ) {
    return value;
  }
  throw new HttpBadRequestError(`Invalid search persona '${value}'`);
}

export function decisionBody(params: Record<string, unknown>, key: string): DecisionValue {
  const value = stringBody(params, key);
  if (value === "accepted" || value === "rejected" || value === "needs_changes") {
    return value;
  }
  throw new HttpBadRequestError(`Invalid proposal decision '${value}'`);
}

export function redirect(location: string): HttpRouteResult {
  return {
    status: 303,
    headers: { location },
    contentType: "text/plain; charset=utf-8",
    body: `See ${location}\n`,
  };
}

/** Serialize a route result to an HTTP response with CORS, content type, and ETag headers. */
export function writeRouteResult(response: ServerResponse, result: HttpRouteResult, headOnly = false, ifNoneMatch?: string): void {
  if (typeof result.body === "string") {
    const contentType = result.contentType ?? "text/plain; charset=utf-8";
    const matchingEtag = notModifiedEtag(result.status, result.body, contentType, ifNoneMatch);
    if (matchingEtag !== undefined) {
      response.writeHead(304, {
        ...corsHeaders(),
        ...securityHeaders(contentType),
        "cache-control": "no-cache",
        "etag": matchingEtag,
        ...(result.headers ?? {}),
      });
      response.end();
      return;
    }
    const headers = {
      ...corsHeaders(),
      ...securityHeaders(contentType),
      ...entityHeaders(result.body, contentType),
      ...(result.headers ?? {}),
      "content-type": contentType,
    };
    response.writeHead(result.status, {
      ...headers,
    });
    response.end(headOnly ? undefined : result.body);
    return;
  }
  const json = `${JSON.stringify(result.body, null, 2)}\n`;
  const matchingEtag = notModifiedEtag(result.status, json, "application/json; charset=utf-8", ifNoneMatch);
  if (matchingEtag !== undefined) {
    response.writeHead(304, {
      ...corsHeaders(),
      ...securityHeaders("application/json; charset=utf-8"),
      "cache-control": "no-cache",
      "etag": matchingEtag,
      ...(result.headers ?? {}),
    });
    response.end();
    return;
  }
  response.writeHead(result.status, {
    ...corsHeaders(),
    ...securityHeaders("application/json; charset=utf-8"),
    ...entityHeaders(json, "application/json; charset=utf-8"),
    ...(result.headers ?? {}),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(headOnly ? undefined : json);
}

function notModifiedEtag(status: number, body: string, contentType: string, ifNoneMatch?: string): string | undefined {
  if (status !== 200 || ifNoneMatch === undefined || contentType.startsWith("text/event-stream")) {
    return undefined;
  }
  const etag = `"sha256-${createHash("sha256").update(body).digest("base64url")}"`;
  const candidates = ifNoneMatch.split(",").map((value) => value.trim());
  return candidates.includes(etag) || candidates.includes("*") ? etag : undefined;
}

function entityHeaders(body: string, contentType: string): Record<string, string> {
  if (contentType.startsWith("text/event-stream")) {
    return {};
  }
  return {
    "cache-control": "no-cache",
    "etag": `"sha256-${createHash("sha256").update(body).digest("base64url")}"`,
  };
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    ...corsHeaders(),
    ...securityHeaders("application/json; charset=utf-8"),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

export function securityHeaders(contentType: string): Record<string, string> {
  if (contentType.startsWith("text/event-stream")) {
    return {
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
  }
  return {
    // style-src 'self' only (JOE-980 / wiki audit P2-4): graph height/chip colors
    // use data-attrs + CSSOM/CSS presets, not style= attributes.
    "content-security-policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; script-src 'self'; worker-src 'self' blob:; style-src 'self'; connect-src 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

/** Map thrown route errors to the HTTP status used by server adapters. */
export function httpErrorStatus(error: unknown): number {
  if (error instanceof OpenWikiError) {
    return openWikiHttpStatusForError(error);
  }
  return error instanceof InvalidGitRevisionError || error instanceof HttpBadRequestError ? 400 : 500;
}

export function corsHeaders(): Record<string, string> {
  const origin = process.env.OPENWIKI_CORS_ORIGIN?.trim();
  return {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,mcp-protocol-version,mcp-session-id,x-openwiki-scopes,x-openwiki-role,x-openwiki-actor,x-openwiki-groups,x-openwiki-principals,x-openwiki-proxy-secret",
  };
}
