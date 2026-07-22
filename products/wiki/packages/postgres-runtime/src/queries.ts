import { runtimeRecordFromJson, runtimeWorkspaceConfigFromJson } from "./records.ts";
import { POSTGRES_RUNTIME_SCHEMA_VERSION } from "./schema.ts";
import { boundedOpenWikiListLimit, type EventRecord, idToUri, type OpenWikiDerivedRecordType, type OpenWikiWorkspaceRegistry, type ProposalRecord, type RunRecord } from "@openwiki/core";
import { listGraphEdges, listTopics, loadRepository } from "@openwiki/repo";
import { openPostgresSql } from "./connection.ts";
import { postgresRuntimeReadEnabled } from "./config.ts";
import { collectDerivedRecords, derivedRuntimeContentHash } from "./derived-records.ts";
import { currentGitCommit } from "./git.ts";
import { readPostgresMigrationDiagnostics } from "./migrations.ts";
import { jobAttemptFromRow, jobDetailFromRow, jsonb, readRuntimeSections, stringField } from "./rows.ts";
import { proposalSectionIds, proposalTargetsPath, proposalUpdatedAt } from "./search.ts";
import { openCurrentPostgresRuntime } from "./sync.ts";
import { metadataCount, recordTypeCount, tableCount, workspaceSourceCommit } from "./queries-counts.ts";
export { jobStatusCount, recordTypeCount, runStatusCount } from "./queries-counts.ts";
export {
  listCurrentPostgresIdentities,
  listCurrentPostgresOpenQuestions,
  listCurrentPostgresSources,
  listCurrentPostgresTopics,
  readCurrentPostgresSource,
} from "./queries-catalog.ts";
import type { CountRow, MetadataRow, PostgresRuntimeEventList, PostgresRuntimeEventListOptions, PostgresRuntimeIntegrityResult, PostgresRuntimeOptions, PostgresRuntimeProposalList, PostgresRuntimeProposalListOptions, PostgresRuntimeRecordEntry, PostgresRuntimeRunDetail, PostgresRuntimeRunList, PostgresRuntimeRunListOptions, PostgresRuntimeSummary, PostgresRuntimeWorkspaceIndex, RuntimeRow } from "./types.ts";

export async function readPostgresRuntimeSummary(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeSummary | undefined> {
  const repo = await loadRepository(root);
  return readPostgresRuntimeSummaryForWorkspace(repo.root, repo.config.workspace_id, options);
}

export async function readPostgresRuntimeSummaryForWorkspace(
  root: string,
  workspaceId: string,
  options: PostgresRuntimeOptions = {},
): Promise<PostgresRuntimeSummary | undefined> {
  const openedSql = openPostgresSql(options);
  const { sql } = openedSql;
  try {
    const metadataRows = await sql<MetadataRow[]>`
      SELECT key, value
      FROM runtime_metadata
      WHERE workspace_id = ${workspaceId}
    `;
    const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
    const workspaceRows = await sql<RuntimeRow[]>`SELECT json FROM workspaces WHERE workspace_id = ${workspaceId} LIMIT 1`;
    if (metadataRows.length === 0 && workspaceRows.length === 0) {
      return undefined;
    }
    const schemaVersion = metadata.get("schema_version");
    const sourceCommit = metadata.get("source_commit");
    const contentHash = metadata.get("content_hash");
    const generatedAt = metadata.get("generated_at");
    return {
      source: "postgres-runtime",
      root,
      workspace_id: workspaceId,
      ...(schemaVersion === undefined ? {} : { schema_version: schemaVersion }),
      ...(sourceCommit === undefined ? await workspaceSourceCommit(sql, workspaceId) : { source_commit: sourceCommit }),
      ...(contentHash === undefined ? {} : { content_hash: contentHash }),
      ...(generatedAt === undefined ? {} : { generated_at: generatedAt }),
      record_count: metadataCount(metadata, "record_count") ?? await tableCount(sql, "records", workspaceId),
      edge_count: metadataCount(metadata, "edge_count") ?? await tableCount(sql, "edges", workspaceId),
      search_document_count: metadataCount(metadata, "search_document_count") ?? await tableCount(sql, "search_documents", workspaceId),
      effective_permission_count: metadataCount(metadata, "effective_permission_count") ?? await tableCount(sql, "effective_permissions", workspaceId),
    };
  } finally {
    await openedSql.close();
  }
}

export async function checkPostgresRuntimeIntegrity(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeIntegrityResult> {
  const repo = await loadRepository(root);
  const [summary, sourceCommit, graph, topics, migrations] = await Promise.all([
    readPostgresRuntimeSummary(repo.root, options),
    currentGitCommit(repo.root),
    listGraphEdges(repo.root),
    listTopics(repo.root),
    readPostgresMigrationDiagnostics(options),
  ]);
  if (!summary) {
    return {
      source: "postgres-runtime",
      root: repo.root,
      workspace_id: repo.config.workspace_id,
      enabled: true,
      current_commit: sourceCommit,
      ok: false,
      issues: ["Postgres runtime has not been synced for this workspace"],
      migrations,
      record_count: 0,
      edge_count: 0,
      search_document_count: 0,
      effective_permission_count: 0,
    };
  }
  const records = collectDerivedRecords(repo, topics.topics);
  const contentHash = derivedRuntimeContentHash(records, graph.edges);
  const issues: string[] = [];
  if (summary.schema_version !== POSTGRES_RUNTIME_SCHEMA_VERSION) {
    issues.push(`schema version mismatch: indexed=${summary.schema_version ?? "missing"} expected=${POSTGRES_RUNTIME_SCHEMA_VERSION}`);
  }
  if (migrations.missing.length > 0) {
    issues.push(`missing Postgres migrations: ${migrations.missing.join(", ")}`);
  }
  if (summary.source_commit !== sourceCommit) {
    issues.push(`source commit mismatch: indexed=${summary.source_commit ?? "missing"} current=${sourceCommit}`);
  }
  if (summary.content_hash !== contentHash) {
    issues.push("content hash mismatch: Git workspace content has changed since the Postgres runtime sync");
  }
  if (summary.record_count !== records.length) {
    issues.push(`record count mismatch: indexed=${summary.record_count} current=${records.length}`);
  }
  if (summary.edge_count !== graph.edges.length) {
    issues.push(`edge count mismatch: indexed=${summary.edge_count} current=${graph.edges.length}`);
  }
  return {
    ...summary,
    enabled: true,
    current_commit: sourceCommit,
    current_content_hash: contentHash,
    ok: issues.length === 0,
    issues,
    migrations,
  };
}

export async function checkPostgresRuntimeServingHealth(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeIntegrityResult> {
  const repo = await loadRepository(root);
  return checkPostgresRuntimeServingHealthForWorkspace(repo.root, repo.config.workspace_id, options);
}

export async function checkPostgresRuntimeServingHealthForWorkspace(
  root: string,
  workspaceId: string,
  options: PostgresRuntimeOptions = {},
): Promise<PostgresRuntimeIntegrityResult> {
  const [summary, sourceCommit, migrations] = await Promise.all([
    readPostgresRuntimeSummaryForWorkspace(root, workspaceId, { ...options, pooled: true }).catch(() => undefined),
    currentGitCommit(root),
    readPostgresMigrationDiagnostics({ ...options, pooled: true }),
  ]);
  if (!summary) {
    return {
      source: "postgres-runtime",
      root,
      workspace_id: workspaceId,
      enabled: true,
      current_commit: sourceCommit,
      ok: false,
      issues: ["Postgres runtime has not been synced for this workspace"],
      migrations,
      record_count: 0,
      edge_count: 0,
      search_document_count: 0,
      effective_permission_count: 0,
    };
  }
  const issues: string[] = [];
  if (summary.schema_version !== POSTGRES_RUNTIME_SCHEMA_VERSION) {
    issues.push(`schema version mismatch: indexed=${summary.schema_version ?? "missing"} expected=${POSTGRES_RUNTIME_SCHEMA_VERSION}`);
  }
  if (migrations.missing.length > 0) {
    issues.push(`missing Postgres migrations: ${migrations.missing.join(", ")}`);
  }
  if (summary.source_commit !== sourceCommit) {
    issues.push(`source commit mismatch: indexed=${summary.source_commit ?? "missing"} current=${sourceCommit}`);
  }
  return {
    ...summary,
    enabled: true,
    current_commit: sourceCommit,
    ok: issues.length === 0,
    issues,
    migrations,
  };
}

export async function readCurrentPostgresWorkspaceIndex(root: string): Promise<PostgresRuntimeWorkspaceIndex | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<RuntimeRow[]>`SELECT json FROM workspaces WHERE workspace_id = ${workspaceId} LIMIT 1`;
    const workspace = rows[0]?.json;
    if (workspace === undefined) {
      return undefined;
    }
    return {
      source: "postgres-runtime",
      workspace: runtimeWorkspaceConfigFromJson(workspace),
      counts: {
        pages: await recordTypeCount(sql, workspaceId, "page"),
        sources: await recordTypeCount(sql, workspaceId, "source"),
        claims: await recordTypeCount(sql, workspaceId, "claim"),
        facts: await recordTypeCount(sql, workspaceId, "fact"),
        takes: await recordTypeCount(sql, workspaceId, "take"),
        proposals: await recordTypeCount(sql, workspaceId, "proposal"),
        comments: await recordTypeCount(sql, workspaceId, "comment"),
        decisions: await recordTypeCount(sql, workspaceId, "decision"),
        events: await recordTypeCount(sql, workspaceId, "event"),
        runs: await recordTypeCount(sql, workspaceId, "run"),
      },
    };
  } finally {
    await opened.close();
  }
}

export async function readCurrentPostgresWorkspaceRegistry(root: string): Promise<OpenWikiWorkspaceRegistry | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const workspaces = await sql<Array<Record<string, unknown>>>`SELECT * FROM workspaces WHERE workspace_id = ${workspaceId} ORDER BY workspace_id`;
    const repos = await sql<Array<Record<string, unknown>>>`SELECT * FROM workspace_repos WHERE workspace_id = ${workspaceId} ORDER BY workspace_id, repo_id`;
    if (workspaces.length === 0) {
      return undefined;
    }
    const tenants = await sql<Array<Record<string, unknown>>>`
      SELECT tenants.*
      FROM tenants
      JOIN workspaces ON workspaces.tenant_id = tenants.tenant_id
      WHERE workspaces.workspace_id = ${workspaceId}
      ORDER BY tenants.tenant_id
    `;
    const organizations = await sql<Array<Record<string, unknown>>>`
      SELECT organizations.*
      FROM organizations
      JOIN tenants ON tenants.organization_id = organizations.organization_id
      JOIN workspaces ON workspaces.tenant_id = tenants.tenant_id
      WHERE workspaces.workspace_id = ${workspaceId}
      ORDER BY organizations.organization_id
    `;
    return {
      source: "postgres-runtime",
      organizations: organizations.map((row) => {
        const id = stringField(row, "organization_id") ?? "organization:local";
        return {
          id,
          uri: idToUri(id),
          type: "organization",
          title: stringField(row, "title") ?? "Untitled Organization",
          created_at: stringField(row, "created_at") ?? "",
        };
      }),
      tenants: tenants.map((row) => {
        const id = stringField(row, "tenant_id") ?? "tenant:local";
        return {
          id,
          uri: idToUri(id),
          type: "tenant",
          organization_id: stringField(row, "organization_id") ?? "organization:local",
          title: stringField(row, "title") ?? "Untitled Tenant",
          created_at: stringField(row, "created_at") ?? "",
        };
      }),
      workspaces: workspaces.map((row) => {
        const config = runtimeWorkspaceConfigFromJson(row.json);
        const id = stringField(row, "workspace_id") ?? config.workspace_id;
        const sourceCommit = stringField(row, "source_commit");
        return {
          id,
          uri: idToUri(id),
          type: "workspace",
          tenant_id: stringField(row, "tenant_id") ?? "tenant:local",
          title: stringField(row, "title") ?? config.title,
          repo_format: config.repo_format,
          protocol_version: config.protocol_version,
          created_at: stringField(row, "created_at") ?? config.created_at,
          ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
          config,
        };
      }),
      repos: repos.map((row, index) => {
        const id = `workspace_repo:${index + 1}`;
        const remote = stringField(row, "remote");
        const branch = stringField(row, "branch");
        const remoteUrl = stringField(row, "remote_url");
        const credentialRef = stringField(row, "credential_ref");
        const sourceCommit = stringField(row, "source_commit");
        return {
          id,
          uri: idToUri(id),
          type: "workspace_repo",
          workspace_id: stringField(row, "workspace_id") ?? workspaceId,
          repo_id: stringField(row, "repo_id") ?? "repo:default",
          root_path: stringField(row, "root_path") ?? "",
          ...(remote === undefined ? {} : { remote }),
          ...(branch === undefined ? {} : { branch }),
          ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
          ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
          ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
        };
      }),
    };
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresProposals(
  root: string,
  options: PostgresRuntimeProposalListOptions = {},
): Promise<PostgresRuntimeProposalList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    if (options.statuses !== undefined && options.statuses.length === 0) {
      return { source: "postgres-runtime", proposals: [], total: 0 };
    }
    const statuses = options.statuses ?? ["open", "accepted", "rejected", "applied", "closed"];
    const limit = boundedOpenWikiListLimit(options.limit, 100, 1000);
    const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10000);
    const sqlLimit = options.sectionId === undefined ? limit : 1000;
    const sqlOffset = options.sectionId === undefined ? offset : 0;
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM proposals
      WHERE workspace_id = ${workspaceId}
        AND status IN ${sql(statuses)}
        AND (${options.actorId === undefined} OR actor_id = ${options.actorId ?? ""})
        AND (${options.targetId === undefined} OR target_ids_json @> ${jsonb([options.targetId ?? ""])}::jsonb)
        AND (${options.targetPath === undefined} OR target_path = ${options.targetPath ?? ""} OR json->'diff'->>'path' = ${options.targetPath ?? ""} OR json->>'snapshot_path' = ${options.targetPath ?? ""})
        AND (${options.updatedAfter === undefined} OR updated_at >= ${options.updatedAfter ?? "1970-01-01T00:00:00.000Z"})
        AND (${options.updatedBefore === undefined} OR updated_at <= ${options.updatedBefore ?? "9999-12-31T23:59:59.999Z"})
      ORDER BY updated_at DESC, proposal_id DESC
      LIMIT ${sqlLimit}
      OFFSET ${sqlOffset}
    `;
    const countRows = options.sectionId === undefined
      ? await sql<CountRow[]>`
        SELECT COUNT(*) AS count
        FROM proposals
        WHERE workspace_id = ${workspaceId}
          AND status IN ${sql(statuses)}
          AND (${options.actorId === undefined} OR actor_id = ${options.actorId ?? ""})
          AND (${options.targetId === undefined} OR target_ids_json @> ${jsonb([options.targetId ?? ""])}::jsonb)
          AND (${options.targetPath === undefined} OR target_path = ${options.targetPath ?? ""} OR json->'diff'->>'path' = ${options.targetPath ?? ""} OR json->>'snapshot_path' = ${options.targetPath ?? ""})
          AND (${options.updatedAfter === undefined} OR updated_at >= ${options.updatedAfter ?? "1970-01-01T00:00:00.000Z"})
          AND (${options.updatedBefore === undefined} OR updated_at <= ${options.updatedBefore ?? "9999-12-31T23:59:59.999Z"})
      `
      : [];
    const sections = await readRuntimeSections(sql, workspaceId);
    const proposals = rows
      .map((row) => runtimeRecordFromJson<ProposalRecord>(row.json, "proposal"))
      .filter((proposal) => options.sectionId === undefined || proposalSectionIds(proposal, sections).includes(options.sectionId))
      .filter((proposal) => options.targetPath === undefined || proposalTargetsPath(proposal, options.targetPath))
      .filter((proposal) => options.updatedAfter === undefined || proposalUpdatedAt(proposal) >= options.updatedAfter)
      .filter((proposal) => options.updatedBefore === undefined || proposalUpdatedAt(proposal) <= options.updatedBefore);
    if (options.sectionId !== undefined) {
      return { source: "postgres-runtime", proposals: proposals.slice(offset, offset + limit), total: proposals.length };
    }
    return { source: "postgres-runtime", proposals: proposals.slice(0, limit), total: Number(countRows[0]?.count ?? proposals.length) };
  } finally {
    await opened.close();
  }
}

export async function readCurrentPostgresRecord<T>(
  root: string,
  id: string,
  type: OpenWikiDerivedRecordType,
): Promise<T | undefined> {
  const entry = await readCurrentPostgresRecordEntry<T>(root, id, type);
  return entry?.record;
}

export async function readCurrentPostgresRecordEntry<T>(
  root: string,
  id: string,
  type: OpenWikiDerivedRecordType,
): Promise<PostgresRuntimeRecordEntry<T> | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<PostgresRecordEntryRow[]>`
      SELECT record_id, json, path, status, sensitivity
      FROM records
      WHERE workspace_id = ${workspaceId} AND record_id = ${id} AND record_type = ${type}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : postgresRecordEntryFromRow<T>(rows[0], type);
  } finally {
    await opened.close();
  }
}

export async function readCurrentPostgresRecordsByIds<T>(
  root: string,
  ids: string[],
  type: OpenWikiDerivedRecordType,
): Promise<{ source: "postgres-runtime"; records: Array<PostgresRuntimeRecordEntry<T>> } | undefined> {
  const uniqueIds = [...new Set(ids.filter((id) => id.trim().length > 0))];
  if (!postgresRuntimeReadEnabled(process.env)) {
    return undefined;
  }
  if (uniqueIds.length === 0) {
    return { source: "postgres-runtime", records: [] };
  }
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<PostgresRecordEntryRow[]>`
      SELECT record_id, json, path, status, sensitivity
      FROM records
      WHERE workspace_id = ${workspaceId} AND record_type = ${type} AND record_id IN ${sql(uniqueIds)}
    `;
    const byId = new Map(rows.map((row) => [row.record_id, postgresRecordEntryFromRow<T>(row, type)] as const));
    return {
      source: "postgres-runtime",
      records: uniqueIds.map((id) => byId.get(id)).filter((entry): entry is PostgresRuntimeRecordEntry<T> => entry !== undefined),
    };
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresRecords<T>(
  root: string,
  options: { type: OpenWikiDerivedRecordType; status?: string; path?: string; group?: string; limit?: number; offset?: number },
): Promise<{ source: "postgres-runtime"; records: T[]; total: number } | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  const limit = boundedOpenWikiListLimit(options.limit, 100, 1000);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10000);
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM records
      WHERE workspace_id = ${workspaceId}
        AND record_type = ${options.type}
        AND (${options.status === undefined} OR status = ${options.status ?? ""})
        AND (${options.path === undefined} OR path = ${options.path ?? ""})
        AND (${options.group === undefined} OR json->>'page_type' = ${options.group ?? ""})
      ORDER BY updated_at DESC, record_id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;
    const countRows = await sql<CountRow[]>`
      SELECT COUNT(*) AS count
      FROM records
      WHERE workspace_id = ${workspaceId}
        AND record_type = ${options.type}
        AND (${options.status === undefined} OR status = ${options.status ?? ""})
        AND (${options.path === undefined} OR path = ${options.path ?? ""})
        AND (${options.group === undefined} OR json->>'page_type' = ${options.group ?? ""})
    `;
    return {
      source: "postgres-runtime",
      records: rows.map((row) => runtimeRecordFromJson<T>(row.json, options.type)),
      total: Number(countRows[0]?.count ?? rows.length),
    };
  } finally {
    await opened.close();
  }
}

interface PostgresRecordEntryRow extends RuntimeRow {
  record_id: string;
  path: string;
  status: string;
  sensitivity: string | null;
}

function postgresRecordEntryFromRow<T>(row: PostgresRecordEntryRow, type: OpenWikiDerivedRecordType): PostgresRuntimeRecordEntry<T> {
  return {
    source: "postgres-runtime",
    record: runtimeRecordFromJson<T>(row.json, type),
    path: row.path,
    status: row.status,
    ...(row.sensitivity === null ? {} : { sensitivity: row.sensitivity }),
  };
}

export async function listCurrentPostgresEvents(
  root: string,
  optionsOrLimit: number | PostgresRuntimeEventListOptions = {},
): Promise<PostgresRuntimeEventList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  const options = postgresEventListOptions(optionsOrLimit);
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM events
      WHERE workspace_id = ${workspaceId}
        AND (${options.actorId === undefined} OR actor_id = ${options.actorId ?? ""})
        AND (${options.eventType === undefined} OR event_type = ${options.eventType ?? ""})
        AND (${options.operation === undefined} OR operation = ${options.operation ?? ""})
        AND (${options.recordId === undefined} OR record_id = ${options.recordId ?? ""} OR json->'subject_ids' ? ${options.recordId ?? ""})
        AND (${options.since === undefined} OR occurred_at >= ${options.since ?? "1970-01-01T00:00:00.000Z"})
        AND (${options.until === undefined} OR occurred_at <= ${options.until ?? "9999-12-31T23:59:59.999Z"})
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ${options.limit}
      OFFSET ${options.offset}
    `;
    return { source: "postgres-runtime", events: rows.map((row) => runtimeRecordFromJson<EventRecord>(row.json, "event")) };
  } finally {
    await opened.close();
  }
}

export async function listCurrentPostgresRuns(
  root: string,
  optionsOrLimit: number | PostgresRuntimeRunListOptions = {},
): Promise<PostgresRuntimeRunList | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  const options = postgresRunListOptions(optionsOrLimit);
  if (options.statuses !== undefined && options.statuses.length === 0) {
    return { source: "postgres-runtime", runs: [] };
  }
  const statuses = options.statuses ?? ["queued", "running", "succeeded", "failed"];
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM runs
      WHERE workspace_id = ${workspaceId}
        AND status IN ${sql(statuses)}
        AND (${options.actorId === undefined} OR actor_id = ${options.actorId ?? ""})
        AND (${options.recordId === undefined} OR run_id = ${options.recordId ?? ""} OR json->'subject_ids' ? ${options.recordId ?? ""})
        AND (${options.since === undefined} OR created_at >= ${options.since ?? "1970-01-01T00:00:00.000Z"})
        AND (${options.until === undefined} OR created_at <= ${options.until ?? "9999-12-31T23:59:59.999Z"})
      ORDER BY created_at DESC, run_id DESC
      LIMIT ${options.limit}
      OFFSET ${options.offset}
    `;
    return { source: "postgres-runtime", runs: rows.map((row) => runtimeRecordFromJson<RunRecord>(row.json, "run")) };
  } finally {
    await opened.close();
  }
}

function postgresEventListOptions(optionsOrLimit: number | PostgresRuntimeEventListOptions): Required<Pick<PostgresRuntimeEventListOptions, "limit" | "offset">> & Omit<PostgresRuntimeEventListOptions, "limit" | "offset"> {
  const options = typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : optionsOrLimit;
  return {
    ...options,
    limit: boundedOpenWikiListLimit(options.limit, 50, 1000),
    offset: Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10000),
  };
}

function postgresRunListOptions(optionsOrLimit: number | PostgresRuntimeRunListOptions): Required<Pick<PostgresRuntimeRunListOptions, "limit" | "offset">> & Omit<PostgresRuntimeRunListOptions, "limit" | "offset"> {
  const options = typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : optionsOrLimit;
  return {
    ...options,
    limit: boundedOpenWikiListLimit(options.limit, 50, 1000),
    offset: Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10000),
  };
}

export async function readCurrentPostgresRun(root: string, runId: string): Promise<PostgresRuntimeRunDetail | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeReadEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, workspaceId } = opened;
  try {
    const rows = await sql<RuntimeRow[]>`
      SELECT json
      FROM runs
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      LIMIT 1
    `;
    const run = rows[0] === undefined ? undefined : runtimeRecordFromJson<RunRecord>(rows[0].json, "run");
    if (run === undefined) {
      return undefined;
    }
    const jobRows = await sql<Array<Record<string, unknown>>>`
      SELECT workspace_id, job_id, run_id, job_type, status, actor_id, attempts,
        max_attempts, created_at, claimed_by, claimed_at, completed_at, source_commit, json
      FROM jobs
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      LIMIT 1
    `;
    const job = jobRows[0] === undefined ? undefined : jobDetailFromRow(jobRows[0]);
    const attemptRows = await sql<Array<Record<string, unknown>>>`
      SELECT workspace_id, job_id, run_id, attempt, job_type, status, actor_id,
        worker_id, started_at, completed_at, error, source_commit, json
      FROM job_attempts
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ORDER BY attempt ASC
    `;
    return {
      source: "postgres-runtime",
      run,
      ...(job === undefined ? {} : { job }),
      attempts: attemptRows.map(jobAttemptFromRow),
    };
  } finally {
    await opened.close();
  }
}

