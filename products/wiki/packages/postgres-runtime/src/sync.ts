import { POSTGRES_RUNTIME_SCHEMA_VERSION } from "./schema.ts";
import { materializeEffectivePermissions } from "@openwiki/policy";
import { clearRepositoryProcessReadCache, listGraphEdges, listTopics, type LoadedOpenWikiRepo, loadRepository } from "@openwiki/repo";
import { openPostgresSql } from "./connection.ts";
import { resolvePostgresDatabaseUrl } from "./config.ts";
import { collectDerivedRecords, derivedRuntimeContentHash, recordAffectedByPaths, searchDocumentFromRecord } from "./derived-records.ts";
import { changedGitPaths, currentGitCommit, gitDirtyPaths } from "./git.ts";
import { migratePostgresRuntime } from "./migrations.ts";
import { readPostgresRuntimeSummary } from "./queries.ts";
import { clearWorkspaceRuntimeRows, deleteRecordsForChangedPaths, insertEdges, insertGovernancePlane, insertPolicyPlane, insertRecords, insertSearchDocuments, insertWorkspacePlane, refreshEdges, refreshEdgesForChangedPaths, refreshGovernancePlane, refreshPolicyPlane, refreshSearchDocuments, upsertRecords, upsertRuntimeMetadata, upsertWorkspacePlane } from "./sync-writes.ts";
import type { PostgresQuery, PostgresRuntimeOptions, PostgresRuntimeRebuildResult, PostgresRuntimeSyncResult, PostgresSql, SourceCommitRow } from "./types.ts";

export async function rebuildPostgresRuntimeIndex(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeRebuildResult> {
  clearRepositoryProcessReadCache(root);
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  await migratePostgresRuntime({ databaseUrl });
  const repo = await loadRepository(root);
  const [sourceCommit, graph, topics] = await Promise.all([currentGitCommit(repo.root), listGraphEdges(repo.root), listTopics(repo.root)]);
  const records = collectDerivedRecords(repo, topics.topics);
  const documents = records.map(searchDocumentFromRecord);
  const effectivePermissions = materializeEffectivePermissions(repo.config, repo.policy);
  const contentHash = derivedRuntimeContentHash(records, graph.edges);
  const openedSql = openPostgresSql({ databaseUrl });
  const { sql } = openedSql;
  try {
    await sql.begin(async (tx) => {
      const query = tx as unknown as PostgresQuery;
      await clearWorkspaceRuntimeRows(query, repo.config.workspace_id);
      await insertWorkspacePlane(query, repo, sourceCommit);
      await insertRecords(query, records, sourceCommit);
      await insertEdges(query, graph.edges, sourceCommit);
      await insertSearchDocuments(query, documents, sourceCommit);
      await insertPolicyPlane(query, repo, sourceCommit);
      await insertGovernancePlane(query, repo, sourceCommit);
      await upsertRuntimeMetadata(query, repo.config.workspace_id, {
        schema_version: POSTGRES_RUNTIME_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        source_commit: sourceCommit,
        content_hash: contentHash,
        record_count: String(records.length),
        edge_count: String(graph.edges.length),
        search_document_count: String(documents.length),
        effective_permission_count: String(effectivePermissions.length),
      });
    });
  } finally {
    await openedSql.close();
  }
  clearRepositoryProcessReadCache(repo.root);
  return {
    source: "postgres-runtime",
    root: repo.root,
    workspace_id: repo.config.workspace_id,
    source_commit: sourceCommit,
    record_count: records.length,
    edge_count: graph.edges.length,
    search_document_count: documents.length,
    effective_permission_count: effectivePermissions.length,
  };
}

export async function syncPostgresRuntimeIndex(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeSyncResult> {
  clearRepositoryProcessReadCache(root);
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  await migratePostgresRuntime({ databaseUrl });
  const repo = await loadRepository(root);
  const [sourceCommit, graph, topics, previousSummary] = await Promise.all([
    currentGitCommit(repo.root),
    listGraphEdges(repo.root),
    listTopics(repo.root),
    readPostgresRuntimeSummary(repo.root, { databaseUrl }).catch(() => undefined),
  ]);
  const records = collectDerivedRecords(repo, topics.topics);
  const searchDocumentCount = records.length;
  const contentHash = derivedRuntimeContentHash(records, graph.edges);
  if (
    previousSummary?.source_commit === sourceCommit &&
    previousSummary.content_hash === contentHash &&
    previousSummary.schema_version === POSTGRES_RUNTIME_SCHEMA_VERSION
  ) {
    return {
      source: "postgres-runtime",
      root: repo.root,
      workspace_id: repo.config.workspace_id,
      source_commit: sourceCommit,
      record_count: records.length,
      edge_count: graph.edges.length,
      search_document_count: searchDocumentCount,
      effective_permission_count: previousSummary.effective_permission_count,
      mode: "current",
      previous_source_commit: previousSummary.source_commit,
      changed_paths: [],
      upserted_record_count: 0,
    };
  }
  if (!previousSummary?.source_commit || previousSummary.source_commit === "uncommitted" || sourceCommit === "uncommitted") {
    const rebuilt = await rebuildPostgresRuntimeIndex(repo.root, { databaseUrl });
    return {
      ...rebuilt,
      mode: "rebuild",
      ...(previousSummary?.source_commit === undefined ? {} : { previous_source_commit: previousSummary.source_commit }),
      changed_paths: [],
      upserted_record_count: rebuilt.record_count,
    };
  }
  if (previousSummary.schema_version !== POSTGRES_RUNTIME_SCHEMA_VERSION) {
    const rebuilt = await rebuildPostgresRuntimeIndex(repo.root, { databaseUrl });
    return {
      ...rebuilt,
      mode: "rebuild",
      previous_source_commit: previousSummary.source_commit,
      changed_paths: [],
      upserted_record_count: rebuilt.record_count,
    };
  }
  const changedPaths = await changedGitPaths(repo.root, previousSummary.source_commit, sourceCommit);
  if (changedPaths.length === 0) {
    const rebuilt = await rebuildPostgresRuntimeIndex(repo.root, { databaseUrl });
    return {
      ...rebuilt,
      mode: "rebuild",
      previous_source_commit: previousSummary.source_commit,
      changed_paths: [],
      upserted_record_count: rebuilt.record_count,
    };
  }
  const openedSql = openPostgresSql({ databaseUrl });
  const { sql } = openedSql;
  let changedRecordCount = 0;
  let effectivePermissionCount = previousSummary.effective_permission_count;
  try {
    const affectedRecords = records.filter((record) => recordAffectedByPaths(record, changedPaths));
    const changedRecords = await recordsChangedSincePreviousSync(sql, repo.config.workspace_id, affectedRecords);
    changedRecordCount = changedRecords.length;
    const changedRecordIds = [...new Set(changedRecords.map((record) => record.record_id))].sort();
    const policyChanged = changedPathsAffectPolicyPlane(changedPaths);
    const governanceChanged = changedPathsAffectGovernancePlane(changedPaths);
    effectivePermissionCount = policyChanged ? materializeEffectivePermissions(repo.config, repo.policy).length : previousSummary.effective_permission_count;
    await sql.begin(async (tx) => {
      const query = tx as unknown as PostgresQuery;
      await upsertWorkspacePlane(query, repo, sourceCommit);
      await deleteRecordsForChangedPaths(query, repo.config.workspace_id, changedPaths, changedRecordIds);
      await upsertRecords(query, changedRecords, sourceCommit);
      if (policyChanged) {
        await refreshEdges(query, repo.config.workspace_id, graph.edges, sourceCommit);
      } else {
        await refreshEdgesForChangedPaths(query, repo.config.workspace_id, graph.edges, changedPaths, sourceCommit);
      }
      await refreshSearchDocuments(query, repo.config.workspace_id, changedRecords.map(searchDocumentFromRecord), sourceCommit);
      if (policyChanged) {
        await refreshPolicyPlane(query, repo, sourceCommit);
      }
      if (governanceChanged) {
        await refreshGovernancePlane(query, repo, sourceCommit);
      }
      await upsertRuntimeMetadata(query, repo.config.workspace_id, {
        schema_version: POSTGRES_RUNTIME_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        source_commit: sourceCommit,
        content_hash: contentHash,
        record_count: String(records.length),
        edge_count: String(graph.edges.length),
        search_document_count: String(searchDocumentCount),
        effective_permission_count: String(effectivePermissionCount),
        last_sync_mode: "incremental",
        last_changed_paths: JSON.stringify(changedPaths),
      });
    });
  } finally {
    await openedSql.close();
  }
  clearRepositoryProcessReadCache(repo.root);
  return {
    source: "postgres-runtime",
    root: repo.root,
    workspace_id: repo.config.workspace_id,
    source_commit: sourceCommit,
    record_count: records.length,
    edge_count: graph.edges.length,
    search_document_count: searchDocumentCount,
    effective_permission_count: effectivePermissionCount,
    mode: "incremental",
    previous_source_commit: previousSummary.source_commit,
    changed_paths: changedPaths,
    upserted_record_count: changedRecordCount,
  };
}

interface PreviousRuntimeRecordRow {
  record_id: string;
  json: unknown;
}

async function recordsChangedSincePreviousSync<T extends { record_id: string; json: Record<string, unknown> }>(
  sql: PostgresQuery,
  workspaceId: string,
  records: T[],
): Promise<T[]> {
  if (records.length === 0) {
    return [];
  }
  const ids = [...new Set(records.map((record) => record.record_id))].sort();
  const rows = await sql<PreviousRuntimeRecordRow[]>`
    SELECT record_id, json
    FROM records
    WHERE workspace_id = ${workspaceId} AND record_id IN ${sql(ids)}
  `;
  const previousJsonById = new Map(rows.map((row) => [row.record_id, stableJsonStringify(row.json)] as const));
  return records.filter((record) => previousJsonById.get(record.record_id) !== stableJsonStringify(record.json));
}

function changedPathsAffectPolicyPlane(paths: string[]): boolean {
  return paths.some((repoPath) => repoPath === "openwiki.json" || repoPath.startsWith("policy/"));
}

function changedPathsAffectGovernancePlane(paths: string[]): boolean {
  return paths.some((repoPath) =>
    repoPath.startsWith("sources/") ||
      repoPath.startsWith("facts/") ||
      repoPath.startsWith("takes/") ||
      repoPath.startsWith("proposals/") ||
      repoPath.startsWith("comments/") ||
      repoPath.startsWith("decisions/") ||
      repoPath.startsWith("events/") ||
      repoPath.startsWith("runs/"),
  );
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableJsonValue(record[key])]));
  }
  return value;
}

export async function openCurrentPostgresRuntime(
  root: string,
  enabled: (env?: NodeJS.ProcessEnv) => boolean,
): Promise<{ sql: PostgresSql; repo: LoadedOpenWikiRepo; workspaceId: string; close(): Promise<void> } | undefined> {
  if (!enabled(process.env)) {
    return undefined;
  }
  const databaseUrl = resolvePostgresDatabaseUrl();
  const repo = await loadRepository(root);
  const openedSql = openPostgresSql({ databaseUrl, pooled: true });
  const { sql } = openedSql;
  try {
    const rows = await sql<SourceCommitRow[]>`SELECT source_commit FROM workspaces WHERE workspace_id = ${repo.config.workspace_id} LIMIT 1`;
    const indexedCommit = rows[0]?.source_commit;
    if (!indexedCommit) {
      await openedSql.close();
      return undefined;
    }
    const currentCommit = await currentGitCommit(repo.root);
    if (currentCommit !== "uncommitted" && indexedCommit !== currentCommit) {
      await openedSql.close();
      return undefined;
    }
    const dirtyPaths = currentCommit === "uncommitted" ? [] : await gitDirtyPaths(repo.root);
    if (
      currentCommit === "uncommitted" ||
      (dirtyPaths === undefined || runtimeDirtyPathsRequireContentCheck(dirtyPaths, process.env))
    ) {
      const indexedContentHash = await runtimeMetadataValue(sql, repo.config.workspace_id, "content_hash");
      if (indexedContentHash === undefined || indexedContentHash !== await currentRuntimeContentHash(repo)) {
        await openedSql.close();
        return undefined;
      }
    }
    return { sql, repo, workspaceId: repo.config.workspace_id, close: openedSql.close };
  } catch (error) {
    await openedSql.close();
    throw error;
  }
}

export async function runtimeMetadataValue(sql: PostgresSql, workspaceId: string, key: string): Promise<string | undefined> {
  const rows = await sql<Array<{ value: string }>>`
    SELECT value
    FROM runtime_metadata
    WHERE workspace_id = ${workspaceId} AND key = ${key}
    LIMIT 1
  `;
  return rows[0]?.value;
}

export async function currentRuntimeContentHash(repo: LoadedOpenWikiRepo): Promise<string> {
  const [graph, topics] = await Promise.all([listGraphEdges(repo.root), listTopics(repo.root)]);
  const records = collectDerivedRecords(repo, topics.topics);
  return derivedRuntimeContentHash(records, graph.edges);
}

export function runtimeDirtyPathsRequireContentCheck(paths: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return paths.some((repoPath) => runtimeDirtyPathRequiresContentCheck(repoPath, env));
}

function runtimeDirtyPathRequiresContentCheck(repoPath: string, env: NodeJS.ProcessEnv): boolean {
  if (repoPath === "openwiki.json") {
    return true;
  }
  if (
    repoPath.startsWith("wiki/") ||
    repoPath.startsWith("sources/") ||
    repoPath.startsWith("claims/") ||
    repoPath.startsWith("proposals/") ||
    repoPath.startsWith("comments/") ||
    repoPath.startsWith("decisions/") ||
    repoPath.startsWith("policy/")
  ) {
    return true;
  }
  if (repoPath.startsWith("runs/") || repoPath.startsWith("events/")) {
    return env.OPENWIKI_QUEUE_BACKEND !== "postgres";
  }
  return false;
}
