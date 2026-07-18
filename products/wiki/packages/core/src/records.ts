import { OPENWIKI_PROTOCOL_VERSION, OPENWIKI_REPO_FORMAT, type OpenWikiKind } from "./protocol.ts";
import { OpenWikiValidationError } from "./errors.ts";
import { assertOpenWikiId } from "./ids.ts";
import type { OpenWikiConfig, OpenWikiSectionVisibility } from "./config.ts";

export interface PageRecord {
  id: string;
  uri: string;
  type: "page";
  page_type: string;
  title: string;
  summary?: string;
  body_format: "markdown";
  body: string;
  path: string;
  source_ids: string[];
  claim_ids: string[];
  status: string;
  topics: string[];
  created_at: string;
  updated_at: string;
}

export interface SourceRecord {
  id: string;
  uri: string;
  type: "source";
  title: string;
  source_type: string;
  url?: string;
  retrieved_at: string;
  content_hash?: string;
  storage?: Record<string, unknown>;
  trust?: Record<string, unknown>;
  path: string;
}

export interface ClaimRecord {
  id: string;
  uri: string;
  type: "claim";
  text: string;
  page_id: string;
  source_ids: string[];
  confidence: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  last_verified_at?: string;
  status: "active" | "stale" | "disputed" | "archived";
}

export type FactStatus = "active" | "stale" | "disputed" | "forgotten" | "archived";

export interface FactRecord {
  id: string;
  uri: string;
  type: "fact";
  kind: string;
  text: string;
  subject_ids: string[];
  page_ids: string[];
  source_ids: string[];
  claim_ids: string[];
  confidence: "low" | "medium" | "high";
  sensitivity: OpenWikiSectionVisibility;
  status: FactStatus;
  valid_from?: string;
  valid_to?: string;
  created_at: string;
  updated_at: string;
  path: string;
}

export type TakeResolution = "correct" | "incorrect" | "partial" | "unresolvable";
export type TakeStatus = "open" | "resolved" | "archived";

export interface TakeRecord {
  id: string;
  uri: string;
  type: "take";
  statement: string;
  rationale: string;
  probability: number;
  confidence: "low" | "medium" | "high";
  status: TakeStatus;
  due_at?: string;
  resolved_at?: string;
  resolution?: TakeResolution;
  score?: number;
  page_ids: string[];
  source_ids: string[];
  claim_ids: string[];
  created_at: string;
  updated_at: string;
  path: string;
}

export type InboxItemStatus = "received" | "queued" | "processing" | "proposed" | "applied" | "ignored" | "failed" | "superseded";

export interface InboxItemPayloadReference {
  kind: "git" | "object";
  path: string;
  media_type?: string;
  bytes?: number;
  content_hash?: string;
  backend?: string;
}

export interface InboxItemProcessingState {
  ignored_reason?: string;
  error?: string;
  failure_category?: InboxProcessingFailureCategory;
  next_action?: string;
  retryable?: boolean;
  next_retry_at?: string;
  retry_count?: number;
  attempt_count?: number;
  last_processed_at?: string;
  processor?: string;
  run_id?: string;
}

export type InboxProcessingFailureCategory =
  | "duplicate"
  | "validation_failed"
  | "payload_unavailable"
  | "permission_denied"
  | "provider_unavailable"
  | "provider_timeout"
  | "proposal_validation_failed"
  | "sync_failed"
  | "unknown_internal_error";

export interface InboxItemRecord {
  id: string;
  uri: string;
  type: "inbox";
  title: string;
  inbox_kind: string;
  provider: string;
  adapter?: string;
  status: InboxItemStatus;
  owner_actor_id?: string;
  submitted_by?: string;
  target_space_id?: string;
  target_path?: string;
  external_id?: string;
  origin?: string;
  source_url?: string;
  received_at: string;
  updated_at: string;
  idempotency_key: string;
  content_hash?: string;
  payload?: InboxItemPayloadReference;
  source_ids?: string[];
  proposal_ids?: string[];
  page_ids?: string[];
  event_ids?: string[];
  run_ids?: string[];
  git_commits?: string[];
  sensitivity?: OpenWikiSectionVisibility;
  processing?: InboxItemProcessingState;
  metadata?: Record<string, unknown>;
  validation_report?: Record<string, unknown>;
  path: string;
}

export type ProposalStatus = "open" | "accepted" | "rejected" | "applied" | "closed";
export type ProposalCloseResolution = "closed" | "superseded" | "withdrawn" | "duplicate" | "stale" | "invalid";
export type DecisionValue = "accepted" | "rejected" | "needs_changes";

export interface ProposalRecord {
  id: string;
  uri: string;
  type: "proposal";
  title: string;
  status: ProposalStatus;
  actor_id: string;
  target_ids: string[];
  target_path?: string;
  base_commit?: string;
  diff: {
    format: "unified";
    path: string;
  };
  snapshot_path?: string;
  snapshot_paths?: Record<string, string>;
  validation_report_path?: string;
  rationale?: string;
  created_at: string;
  applied_at?: string;
  applied_commit?: string;
  closed_at?: string;
  closed_by?: string;
  close_resolution?: ProposalCloseResolution;
  close_rationale?: string;
  superseded_by?: string;
  path: string;
}

export interface ProposalCommentRecord {
  id: string;
  uri: string;
  type: "comment";
  proposal_id: string;
  actor_id: string;
  body: string;
  created_at: string;
  path: string;
}

export interface DecisionRecord {
  id: string;
  uri: string;
  type: "decision";
  proposal_id: string;
  decision: DecisionValue;
  actor_id: string;
  rationale: string;
  commit?: string;
  decided_at: string;
  path: string;
}

export interface EventRecord {
  id: string;
  uri: string;
  type: string;
  workspace_id: string;
  actor_id?: string;
  operation?: string;
  record_id?: string;
  record_type?: string;
  occurred_at: string;
  data?: Record<string, unknown>;
  subject_ids?: string[];
  subject_paths?: string[];
  sensitivity?: OpenWikiSectionVisibility;
  path: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";
export const OPENWIKI_RUN_TYPES = [
  "index.rebuild",
  "static.export",
  "lint",
  "source.fetch",
  "git.sync",
  "backup.create",
  "inbox.process",
  "inbox.watch",
  "inbox.reconcile",
  "inbox.sync_after_process",
  "dream.run",
] as const;
export type RunType = typeof OPENWIKI_RUN_TYPES[number];

export function isOpenWikiRunType(value: string): value is RunType {
  return (OPENWIKI_RUN_TYPES as readonly string[]).includes(value);
}

export function assertOpenWikiRunType(value: string): asserts value is RunType {
  if (!isOpenWikiRunType(value)) {
    throw new OpenWikiValidationError(`Unsupported OpenWiki run type: ${value}`);
  }
}

export const OPENWIKI_SYSTEM_ACTOR_ID = "actor:system:openwiki" as const;
export const SOURCE_FETCH_RUN_INPUT_KEYS = [
  "title",
  "url",
  "source_type",
  "max_bytes",
  "timeout_ms",
  "connector_kind",
  "connector_id",
  "credential_ref",
  "github_owner",
  "github_repo",
  "gitlab_project",
  "source_path",
  "ref",
] as const;
export const SOURCE_FETCH_STRING_INPUT_KEYS = [
  "title",
  "url",
  "source_type",
  "connector_kind",
  "connector_id",
  "credential_ref",
  "github_owner",
  "github_repo",
  "gitlab_project",
  "source_path",
  "ref",
] as const;
export const SOURCE_FETCH_NUMBER_INPUT_KEYS = ["max_bytes", "timeout_ms"] as const;
const SENSITIVE_SOURCE_FETCH_INPUT_KEY_NAMES = [
  "headers",
  "header",
  "authorization",
  "cookie",
  "proxy_authorization",
  "set_cookie",
  "x_api_key",
  "api_key",
  "x_auth_token",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "password",
  "bearer",
  "github_token",
  "gitlab_token",
  "private_token",
] as const;

const SENSITIVE_SOURCE_FETCH_INPUT_KEYS: ReadonlySet<string> = new Set(SENSITIVE_SOURCE_FETCH_INPUT_KEY_NAMES);

function normalizeSourceFetchInputKey(key: string): string {
  return key.toLowerCase().replace(/[-\s]/g, "_");
}

export function isSensitiveSourceFetchInputKey(key: string): boolean {
  return SENSITIVE_SOURCE_FETCH_INPUT_KEYS.has(normalizeSourceFetchInputKey(key));
}

export interface RunRecord {
  id: string;
  uri: string;
  type: "run";
  run_type: RunType | string;
  status: RunStatus;
  actor_id: string;
  workspace_id: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  subject_ids?: string[];
  subject_paths?: string[];
  sensitivity?: OpenWikiSectionVisibility;
  path: string;
}

export function redactOpenWikiRunRecord(
  run: RunRecord,
  options: { includeSensitiveOperationalMetadata?: boolean } = {},
): RunRecord {
  if (options.includeSensitiveOperationalMetadata === true || run.run_type !== "source.fetch") {
    return run;
  }
  return {
    ...run,
    ...(run.input === undefined ? {} : { input: redactSourceFetchInput(run.input) }),
    ...(run.output === undefined ? {} : { output: redactSourceFetchOutput(run.output) }),
  };
}

export function redactOpenWikiRunEventRecord(
  event: EventRecord,
  options: { includeSensitiveOperationalMetadata?: boolean } = {},
): EventRecord {
  if (options.includeSensitiveOperationalMetadata === true || event.data?.run_type !== "source.fetch") {
    return event;
  }
  const data = { ...event.data };
  if (data.input !== undefined && typeof data.input === "object" && data.input !== null && !Array.isArray(data.input)) {
    data.input = redactSourceFetchInput(data.input as Record<string, unknown>);
  }
  if (data.output !== undefined && typeof data.output === "object" && data.output !== null && !Array.isArray(data.output)) {
    data.output = redactSourceFetchOutput(data.output as Record<string, unknown>);
  }
  return {
    ...event,
    data,
  };
}

function redactSourceFetchInput(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["title", "source_type", "connector_kind", "max_bytes", "timeout_ms"]) {
    if (input[key] !== undefined) {
      output[key] = input[key];
    }
  }
  return output;
}

function redactSourceFetchOutput(output: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const key of ["source_id", "manifest_path", "raw_path", "object_path"]) {
    if (output[key] !== undefined) {
      redacted[key] = output[key];
    }
  }
  const fetch = output.fetch;
  if (fetch !== undefined && typeof fetch === "object" && fetch !== null && !Array.isArray(fetch)) {
    const fetchRecord = fetch as Record<string, unknown>;
    const safeFetch: Record<string, unknown> = {};
    for (const key of ["status", "content_type", "bytes"]) {
      if (fetchRecord[key] !== undefined) {
        safeFetch[key] = fetchRecord[key];
      }
    }
    redacted.fetch = safeFetch;
  }
  return redacted;
}

export type OpenWikiDerivedRecordType = "page" | "source" | "claim" | "fact" | "take" | "inbox" | "proposal" | "comment" | "decision" | "event" | "run" | "topic";

const DERIVED_RECORD_REQUIRED_STRING_FIELDS: Readonly<Record<OpenWikiDerivedRecordType, readonly string[]>> = {
  page: ["uri", "type", "page_type", "title", "body_format", "body", "path", "status", "created_at", "updated_at"],
  source: ["uri", "type", "title", "source_type", "retrieved_at", "path"],
  claim: ["uri", "type", "text", "page_id", "confidence", "risk", "status"],
  fact: ["uri", "type", "kind", "text", "confidence", "sensitivity", "status", "created_at", "updated_at", "path"],
  take: ["uri", "type", "statement", "rationale", "confidence", "status", "created_at", "updated_at", "path"],
  inbox: ["uri", "type", "title", "inbox_kind", "provider", "status", "received_at", "updated_at", "idempotency_key", "path"],
  proposal: ["uri", "type", "title", "status", "actor_id", "path", "created_at"],
  comment: ["uri", "type", "proposal_id", "actor_id", "body", "created_at", "path"],
  decision: ["uri", "type", "proposal_id", "decision", "actor_id", "rationale", "decided_at", "path"],
  event: ["uri", "type", "workspace_id", "occurred_at", "path"],
  run: ["uri", "type", "run_type", "status", "actor_id", "workspace_id", "created_at", "path"],
  topic: ["type", "topic", "updated_at"],
};

const DERIVED_RECORD_REQUIRED_ARRAY_FIELDS: Readonly<Record<OpenWikiDerivedRecordType, readonly string[]>> = {
  page: ["source_ids", "claim_ids", "topics"],
  source: [],
  claim: ["source_ids"],
  fact: ["subject_ids", "page_ids", "source_ids", "claim_ids"],
  take: ["page_ids", "source_ids", "claim_ids"],
  inbox: [],
  proposal: ["target_ids"],
  comment: [],
  decision: [],
  event: [],
  run: [],
  topic: ["page_ids", "source_ids"],
};

export function assertOpenWikiDerivedRecord(
  value: unknown,
  expectedType: OpenWikiDerivedRecordType,
  context = "OpenWiki derived record",
): asserts value is Record<string, unknown> {
  const record = objectRecordFromUnknown(value, context);
  const id = stringRecordField(record, "id", context);
  assertValidatedOpenWikiId(id, expectedType, context);
  const recordType = stringRecordField(record, "type", context);
  if (expectedType === "event") {
    if (!recordType.trim()) {
      throw new OpenWikiValidationError(`${context}: field 'type' must be a non-empty event name`);
    }
  } else if (recordType !== expectedType) {
    throw new OpenWikiValidationError(`${context}: expected type '${expectedType}', got '${recordType}'`);
  }
  for (const field of DERIVED_RECORD_REQUIRED_STRING_FIELDS[expectedType]) {
    stringRecordField(record, field, context);
  }
  for (const field of DERIVED_RECORD_REQUIRED_ARRAY_FIELDS[expectedType]) {
    arrayRecordField(record, field, context);
  }
}

export function openWikiDerivedRecordFromUnknown<T = Record<string, unknown>>(
  value: unknown,
  expectedType: OpenWikiDerivedRecordType,
  context = "OpenWiki derived record",
): T {
  assertOpenWikiDerivedRecord(value, expectedType, context);
  return value as T;
}

export function assertOpenWikiWorkspaceConfig(
  value: unknown,
  context = "OpenWiki workspace config",
): asserts value is OpenWikiConfig {
  const record = objectRecordFromUnknown(value, context);
  const workspaceId = stringRecordField(record, "workspace_id", context);
  try {
    assertOpenWikiId(workspaceId, "workspace");
  } catch (error) {
    throw new OpenWikiValidationError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const protocolVersion = stringRecordField(record, "protocol_version", context);
  if (protocolVersion !== OPENWIKI_PROTOCOL_VERSION) {
    throw new OpenWikiValidationError(`${context}: expected protocol_version '${OPENWIKI_PROTOCOL_VERSION}', got '${protocolVersion}'`);
  }
  const repoFormat = stringRecordField(record, "repo_format", context);
  if (repoFormat !== OPENWIKI_REPO_FORMAT) {
    throw new OpenWikiValidationError(`${context}: expected repo_format '${OPENWIKI_REPO_FORMAT}', got '${repoFormat}'`);
  }
  stringRecordField(record, "title", context);
  stringRecordField(record, "created_at", context);
}

export function openWikiWorkspaceConfigFromUnknown<T extends OpenWikiConfig = OpenWikiConfig>(
  value: unknown,
  context = "OpenWiki workspace config",
): T {
  assertOpenWikiWorkspaceConfig(value, context);
  return value as T;
}

export function openWikiIndexedRecordJsonFromUnknown(
  value: unknown,
  recordType: string,
  context = "OpenWiki indexed record",
): Record<string, unknown> {
  if (isOpenWikiDerivedRecordType(recordType)) {
    return openWikiDerivedRecordFromUnknown<Record<string, unknown>>(value, recordType, context);
  }
  if (recordType === "workspace") {
    return openWikiWorkspaceConfigFromUnknown<Record<string, unknown> & OpenWikiConfig>(value, context);
  }
  if (recordType === "policy") {
    const record = objectRecordFromUnknown(value, context);
    assertIdField(record, "policy", context);
    const type = stringRecordField(record, "type", context);
    if (type !== "policy") {
      throw new OpenWikiValidationError(`${context}: expected type 'policy', got '${type}'`);
    }
    if (!("body" in record)) {
      throw new OpenWikiValidationError(`${context}: missing field 'body'`);
    }
    return record;
  }
  if (recordType === "section") {
    const record = objectRecordFromUnknown(value, context);
    assertIdField(record, "section", context);
    stringRecordField(record, "title", context);
    arrayRecordField(record, "paths", context);
    return record;
  }
  throw new OpenWikiValidationError(`${context}: unsupported record type '${recordType}'`);
}

function isOpenWikiDerivedRecordType(value: string): value is OpenWikiDerivedRecordType {
  return value === "page" ||
    value === "source" ||
    value === "claim" ||
    value === "fact" ||
    value === "take" ||
    value === "inbox" ||
    value === "proposal" ||
    value === "comment" ||
    value === "decision" ||
    value === "event" ||
    value === "run" ||
    value === "topic";
}

function objectRecordFromUnknown(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenWikiValidationError(`${context}: expected JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringRecordField(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new OpenWikiValidationError(`${context}: missing string field '${field}'`);
  }
  return value;
}

function arrayRecordField(record: Record<string, unknown>, field: string, context: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new OpenWikiValidationError(`${context}: missing array field '${field}'`);
  }
  return value;
}

function assertIdField(record: Record<string, unknown>, expectedType: OpenWikiKind, context: string): void {
  const id = stringRecordField(record, "id", context);
  try {
    assertOpenWikiId(id, expectedType);
  } catch (error) {
    throw new OpenWikiValidationError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertValidatedOpenWikiId(id: string, expectedType: OpenWikiDerivedRecordType, context: string): void {
  try {
    assertOpenWikiId(id, expectedType);
  } catch (error) {
    throw new OpenWikiValidationError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
