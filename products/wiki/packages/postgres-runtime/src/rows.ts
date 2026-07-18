import { parseJsonObject, runtimeRecordFromJson } from "./records.ts";
import { isOpenWikiScope, isSensitiveSourceFetchInputKey, openWikiPrincipalTitle, openWikiPrincipalTypeForId, type OpenWikiDerivedRecordType, type OpenWikiRuntimeApiTokenRecord, type OpenWikiRuntimeGroupRecord, type OpenWikiRuntimeIdpMappingRecord, type OpenWikiRuntimePrincipalGroupRecord, type OpenWikiRuntimePrincipalRecord, type OpenWikiRuntimeServiceAccountRecord, type OpenWikiRuntimeSessionRecord, type RunRecord, type RunType, SOURCE_FETCH_RUN_INPUT_KEYS } from "@openwiki/core";
import type { PostgresJsonValue, PostgresQuery, PostgresRuntimeJobAttempt, PostgresRuntimeJobDetail, RunRow, RuntimeRow } from "./types.ts";

export async function recordsFromPostgres<T>(sql: PostgresQuery, workspaceId: string, type: OpenWikiDerivedRecordType): Promise<T[]> {
  const rows = await sql<RuntimeRow[]>`
    SELECT json
    FROM records
    WHERE workspace_id = ${workspaceId} AND record_type = ${type}
    ORDER BY record_id
  `;
  return (rows as RuntimeRow[]).map((row) => runtimeRecordFromJson<T>(row.json, type));
}

export async function readRuntimeSections(sql: PostgresQuery, workspaceId: string): Promise<Array<{ id: string; paths: string[] }>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT section_id, paths_json
    FROM sections
    WHERE workspace_id = ${workspaceId}
    ORDER BY section_id
  `;
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: stringField(row, "section_id") ?? "",
    paths: parseJsonStringArray(row.paths_json),
  }));
}

export function principalTypeForId(id: string): string {
  return openWikiPrincipalTypeForId(id);
}

export function principalTitle(id: string): string {
  return openWikiPrincipalTitle(id);
}

export function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return undefined;
}

export function dateStringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined;
}

export function timestampMsField(row: Record<string, unknown>, key: string): number | undefined {
  const date = dateStringField(row, key);
  if (date === undefined) {
    return undefined;
  }
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : undefined;
}

export function stringArrayField(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function parseJsonStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return parseJsonStringArray(parsed);
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseJsonScopeArray(value: unknown): OpenWikiRuntimeServiceAccountRecord["scopes"] {
  return parseJsonStringArray(value).filter(isOpenWikiScope);
}

export function jsonb(value: unknown): string {
  return JSON.stringify(value);
}

export function postgresJsonValue(value: unknown): PostgresJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(postgresJsonValue);
  }
  if (value && typeof value === "object") {
    const json: Record<string, PostgresJsonValue | undefined> = {};
    for (const [key, entry] of Object.entries(value)) {
      json[key] = entry === undefined ? undefined : postgresJsonValue(entry);
    }
    return json;
  }
  return null;
}

export function runtimePrincipalFromRow(row: Record<string, unknown>): OpenWikiRuntimePrincipalRecord {
  return {
    id: stringField(row, "principal_id") ?? "",
    type: runtimePrincipalType(stringField(row, "principal_type")),
    title: stringField(row, "title") ?? "",
  };
}

export function runtimeGroupFromRow(row: Record<string, unknown>): OpenWikiRuntimeGroupRecord {
  return {
    id: stringField(row, "group_id") ?? "",
    title: stringField(row, "title") ?? "",
  };
}

export function runtimePrincipalGroupFromRow(row: Record<string, unknown>): OpenWikiRuntimePrincipalGroupRecord {
  return {
    principal_id: stringField(row, "principal_id") ?? "",
    group_id: stringField(row, "group_id") ?? "",
    source: "git",
  };
}

export function runtimeServiceAccountFromRow(row: Record<string, unknown>): OpenWikiRuntimeServiceAccountRecord {
  const role = runtimeRole(stringField(row, "role"));
  const json = parseJsonObject(row.json);
  const tokens = parseRuntimeServiceAccountTokens(json.tokens);
  const description = stringField(json, "description");
  const createdAt = dateStringField(json, "created_at");
  const updatedAt = dateStringField(json, "updated_at");
  const expiresAt = dateStringField(json, "expires_at");
  return {
    id: stringField(row, "service_account_id") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    ...(description === undefined ? {} : { description }),
    ...(role === undefined ? {} : { role }),
    scopes: parseJsonScopeArray(row.scopes_json),
    principals: parseJsonStringArray(row.principals_json),
    token_hash_count: numberField(row, "token_hash_count"),
    ...(typeof json.active_token_count === "number" ? { active_token_count: json.active_token_count } : {}),
    ...(typeof json.revoked_token_count === "number" ? { revoked_token_count: json.revoked_token_count } : {}),
    ...(typeof json.expired_token_count === "number" ? { expired_token_count: json.expired_token_count } : {}),
    ...(tokens.length === 0 ? {} : { tokens }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

function parseRuntimeServiceAccountTokens(value: unknown): NonNullable<OpenWikiRuntimeServiceAccountRecord["tokens"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const token = parseJsonObject(entry);
    const id = stringField(token, "id");
    const status = stringField(token, "status");
    if (id === undefined || (status !== "active" && status !== "expired" && status !== "revoked")) {
      return [];
    }
    const description = stringField(token, "description");
    const createdAt = dateStringField(token, "created_at");
    const expiresAt = dateStringField(token, "expires_at");
    const revokedAt = dateStringField(token, "revoked_at");
    return [{
      id,
      status,
      ...(description === undefined ? {} : { description }),
      ...(createdAt === undefined ? {} : { created_at: createdAt }),
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      ...(revokedAt === undefined ? {} : { revoked_at: revokedAt }),
    }];
  });
}

export function runtimeSessionFromRow(row: Record<string, unknown>): OpenWikiRuntimeSessionRecord {
  const principalId = stringField(row, "principal_id");
  const expiresAt = dateStringField(row, "expires_at");
  const revokedAt = dateStringField(row, "revoked_at");
  return {
    id: stringField(row, "session_id") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    ...(principalId === undefined ? {} : { principal_id: principalId }),
    created_at: dateStringField(row, "created_at") ?? "",
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(revokedAt === undefined ? {} : { revoked_at: revokedAt }),
  };
}

export function runtimeApiTokenFromRow(row: Record<string, unknown>): Omit<OpenWikiRuntimeApiTokenRecord, "token_hash"> & { token_hash_present: boolean } {
  const principalId = stringField(row, "principal_id");
  const expiresAt = dateStringField(row, "expires_at");
  const revokedAt = dateStringField(row, "revoked_at");
  return {
    id: stringField(row, "token_id") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    ...(principalId === undefined ? {} : { principal_id: principalId }),
    scopes: parseJsonScopeArray(row.scopes_json),
    token_hash_present: Boolean(stringField(row, "token_hash")),
    created_at: dateStringField(row, "created_at") ?? "",
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(revokedAt === undefined ? {} : { revoked_at: revokedAt }),
  };
}

export function runtimeIdpMappingFromRow(row: Record<string, unknown>): OpenWikiRuntimeIdpMappingRecord {
  return {
    id: stringField(row, "mapping_id") ?? "",
    provider: stringField(row, "provider") ?? "",
    claim: stringField(row, "claim") ?? "",
    value: stringField(row, "claim_value") ?? "",
    principal_id: stringField(row, "principal_id") ?? "",
  };
}

export function runtimePrincipalType(value: string | undefined): OpenWikiRuntimePrincipalRecord["type"] {
  if (
    value === "actor" ||
    value === "group" ||
    value === "role" ||
    value === "service_account" ||
    value === "user" ||
    value === "principal"
  ) {
    return value;
  }
  return "unknown";
}

function runtimeRole(value: string | undefined): NonNullable<OpenWikiRuntimeServiceAccountRecord["role"]> | undefined {
  if (
    value === "viewer" ||
    value === "contributor" ||
    value === "researcher" ||
    value === "reviewer" ||
    value === "maintainer" ||
    value === "admin" ||
    value === "agent"
  ) {
    return value;
  }
  return undefined;
}

export function runFromRow(row: RunRow): RunRecord {
  return runtimeRecordFromJson<RunRecord>(row.json, "run");
}

export function jobDetailFromRow(row: Record<string, unknown>): PostgresRuntimeJobDetail {
  const claimedBy = stringField(row, "claimed_by");
  const claimedAt = dateStringField(row, "claimed_at");
  const completedAt = dateStringField(row, "completed_at");
  return {
    source: "postgres-runtime",
    backend: "postgres",
    workspace_id: stringField(row, "workspace_id") ?? "",
    job_id: stringField(row, "job_id") ?? "",
    run_id: stringField(row, "run_id") ?? "",
    job_type: stringField(row, "job_type") ?? "",
    status: stringField(row, "status") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    attempts: numberField(row, "attempts"),
    max_attempts: numberField(row, "max_attempts"),
    created_at: dateStringField(row, "created_at") ?? "",
    ...(claimedBy === undefined ? {} : { claimed_by: claimedBy }),
    ...(claimedAt === undefined ? {} : { claimed_at: claimedAt }),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    source_commit: stringField(row, "source_commit") ?? "",
    json: parseJsonObject(row.json),
  };
}

export function jobAttemptFromRow(row: Record<string, unknown>): PostgresRuntimeJobAttempt {
  const workerId = stringField(row, "worker_id");
  const completedAt = dateStringField(row, "completed_at");
  const error = stringField(row, "error");
  return {
    source: "postgres-runtime",
    workspace_id: stringField(row, "workspace_id") ?? "",
    job_id: stringField(row, "job_id") ?? "",
    run_id: stringField(row, "run_id") ?? "",
    attempt: numberField(row, "attempt"),
    job_type: stringField(row, "job_type") ?? "",
    status: stringField(row, "status") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    ...(workerId === undefined ? {} : { worker_id: workerId }),
    started_at: dateStringField(row, "started_at") ?? "",
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    ...(error === undefined ? {} : { error }),
    source_commit: stringField(row, "source_commit") ?? "",
    json: parseJsonObject(row.json),
  };
}

export function optionalSanitizedRunInput(runType: RunType | string, input: Record<string, unknown> | undefined): { input?: Record<string, unknown> } {
  const sanitized = sanitizeRunInput(runType, input);
  return sanitized === undefined ? {} : { input: sanitized };
}

export function sanitizeRunInput(runType: RunType | string, input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (runType === "dream.run") {
    return sanitizeDreamRunInput(input);
  }
  if (runType !== "source.fetch") {
    return { ...input };
  }
  for (const key of Object.keys(input)) {
    if (isSensitiveSourceFetchInputKey(key)) {
      throw new Error(`Sensitive source.fetch run input field '${key}' must be stored as a credential_ref, not in the run payload`);
    }
  }
  const sanitized: Record<string, unknown> = {};
  for (const key of SOURCE_FETCH_RUN_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      sanitized[key] = value.trim();
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

const DREAM_RUN_PHASES = new Set([
  "lint",
  "index_refresh",
  "stale_claims",
  "missing_backlinks",
  "thin_pages",
  "orphan_pages",
  "link_suggestions",
  "fact_candidates",
  "take_score_candidates",
  "report",
]);

function sanitizeDreamRunInput(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};
  const phases = input.phases;
  if (Array.isArray(phases) && phases.every((phase) => typeof phase === "string" && DREAM_RUN_PHASES.has(phase))) {
    sanitized.phases = phases;
  } else if (typeof phases === "string") {
    const values = phases.split(/[\s,]+/g).map((phase) => phase.trim()).filter(Boolean);
    if (values.every((phase) => DREAM_RUN_PHASES.has(phase))) {
      sanitized.phases = values;
    } else {
      throw new Error("Expected dream.run phases to contain known phase names");
    }
  } else if (phases !== undefined) {
    throw new Error("Expected dream.run phases to contain known phase names");
  }
  for (const key of ["limit", "max_records", "timeout_ms"]) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Expected numeric dream.run input field '${key}'`);
    }
    sanitized[key] = value;
  }
  for (const key of ["dry_run", "create_proposals"]) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "boolean") {
      throw new Error(`Expected boolean dream.run input field '${key}'`);
    }
    sanitized[key] = value;
  }
  for (const key of ["provider", "schema_pack"]) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Expected string dream.run input field '${key}'`);
    }
    if (value.trim()) {
      sanitized[key] = value.trim();
    }
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}
