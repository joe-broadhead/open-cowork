import { type PageRecord, type SourceRecord } from "@openwiki/core";
import { openQuestionsFromPageRecord, topicFromRuntimeRecord } from "./derived-records.ts";
import { postgresRuntimeReadEnabled } from "./config.ts";
import { runtimeRecordFromJson } from "./records.ts";
import {
  recordsFromPostgres,
  runtimeApiTokenFromRow,
  runtimeGroupFromRow,
  runtimeIdpMappingFromRow,
  runtimePrincipalFromRow,
  runtimePrincipalGroupFromRow,
  runtimeServiceAccountFromRow,
  runtimeSessionFromRow,
} from "./rows.ts";
import { openCurrentPostgresRuntime } from "./sync.ts";
import { tableCount } from "./queries-counts.ts";
import type {
  PostgresRuntimeIdentityList,
  PostgresRuntimeOpenQuestionList,
  PostgresRuntimeSourceList,
  PostgresRuntimeTopicList,
  RuntimeRow,
} from "./types.ts";

export async function listCurrentPostgresTopics(root: string): Promise<PostgresRuntimeTopicList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const topics = (await recordsFromPostgres<Record<string, unknown>>(sql, workspaceId, "topic"))
      .map(topicFromRuntimeRecord)
      .sort((left, right) => right.page_count - left.page_count || left.topic.localeCompare(right.topic));
    return { source: "postgres-runtime", topics };
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresOpenQuestions(root: string): Promise<PostgresRuntimeOpenQuestionList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const pages = await recordsFromPostgres<PageRecord>(sql, workspaceId, "page");
    return {
      source: "postgres-runtime",
      open_questions: pages.flatMap(openQuestionsFromPageRecord),
    };
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresSources(root: string, limit = 100): Promise<PostgresRuntimeSourceList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM source_objects
      WHERE workspace_id = ${workspaceId}
      ORDER BY source_id ASC
      LIMIT ${Math.min(Math.max(limit, 0), 1000)}
    `;
    const total = await tableCount(sql, "source_objects", workspaceId);
    return { source: "postgres-runtime", sources: rows.map((row) => runtimeRecordFromJson<SourceRecord>(row.json, "source")), total };
  } finally {
    await opened.close();
  }
}

export async function readCurrentPostgresSource(root: string, id: string): Promise<SourceRecord | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM source_objects
      WHERE workspace_id = ${workspaceId} AND source_id = ${id}
      LIMIT 1
    `;
    if (!rows[0]) {
      return undefined;
    }
    return runtimeRecordFromJson<SourceRecord>(rows[0].json, "source");
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresIdentities(root: string): Promise<PostgresRuntimeIdentityList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const principalRows = await sql<Array<Record<string, unknown>>>`
      SELECT principal_id, principal_type, title, json
      FROM principals
      WHERE workspace_id = ${workspaceId}
      ORDER BY principal_id ASC
    `;
    const groupRows = await sql<Array<Record<string, unknown>>>`
      SELECT group_id, title, json
      FROM groups
      WHERE workspace_id = ${workspaceId}
      ORDER BY group_id ASC
    `;
    const principalGroupRows = await sql<Array<Record<string, unknown>>>`
      SELECT principal_id, group_id
      FROM principal_groups
      WHERE workspace_id = ${workspaceId}
      ORDER BY principal_id ASC, group_id ASC
    `;
    const serviceAccountRows = await sql<Array<Record<string, unknown>>>`
      SELECT service_account_id, actor_id, role, scopes_json, principals_json, token_hash_count, json
      FROM service_accounts
      WHERE workspace_id = ${workspaceId}
      ORDER BY service_account_id ASC
    `;
    const sessionRows = await sql<Array<Record<string, unknown>>>`
      SELECT session_id, actor_id, principal_id, created_at, expires_at, revoked_at, json
      FROM sessions
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, session_id DESC
      LIMIT 500
    `;
    const tokenRows = await sql<Array<Record<string, unknown>>>`
      SELECT token_id, actor_id, principal_id, scopes_json, token_hash, created_at, expires_at, revoked_at, json
      FROM api_tokens
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC, token_id DESC
      LIMIT 500
    `;
    const mappingRows = await sql<Array<Record<string, unknown>>>`
      SELECT mapping_id, provider, claim, claim_value, principal_id, json
      FROM idp_mappings
      WHERE workspace_id = ${workspaceId}
      ORDER BY provider ASC, claim ASC, claim_value ASC
    `;
    return {
      source: "postgres-runtime",
      workspace_id: workspaceId,
      principals: principalRows.map(runtimePrincipalFromRow),
      groups: groupRows.map(runtimeGroupFromRow),
      principal_groups: principalGroupRows.map(runtimePrincipalGroupFromRow),
      service_accounts: serviceAccountRows.map(runtimeServiceAccountFromRow),
      sessions: sessionRows.map(runtimeSessionFromRow),
      api_tokens: tokenRows.map(runtimeApiTokenFromRow),
      idp_mappings: mappingRows.map(runtimeIdpMappingFromRow),
    };
  } finally {
    await opened.close();
  }
}
