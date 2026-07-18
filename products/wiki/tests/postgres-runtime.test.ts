import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRunQueue } from "@openwiki/jobs";
import {
  POSTGRES_RUNTIME_MIGRATIONS,
  postgresRuntimeConfigured,
  postgresRuntimeHealthEnabled,
  postgresRuntimeOperationalFilterIndexesSchemaSql,
  postgresRuntimeOperationalStateSchemaSql,
  postgresRuntimeRemoteMcpAuthSchemaSql,
  postgresRuntimeReadEnabled,
  postgresRuntimeSchemaSql,
  postgresRuntimeSearchEnabled,
  postgresRuntimeWriteLeaseSchemaSql,
  postgresRuntimeWriteSyncEnabled,
  resolvePostgresDatabaseUrl,
} from "@openwiki/postgres-runtime";
import { createWorkspace } from "@openwiki/repo";
import { sanitizeRunInput as sanitizePostgresRunInput } from "../packages/postgres-runtime/src/rows.ts";
import { escapePostgresLikePattern } from "../packages/postgres-runtime/src/search.ts";

const execFileAsync = promisify(execFile);
const POSTGRES_RUNTIME_SCHEMA_TABLES = [
  "organizations",
  "tenants",
  "workspaces",
  "workspace_repos",
  "records",
  "record_versions",
  "record_paths",
  "edges",
  "search_documents",
  "search_chunks",
  "search_chunk_embeddings",
  "principals",
  "groups",
  "principal_groups",
  "service_accounts",
  "sessions",
  "api_tokens",
  "idp_mappings",
  "sections",
  "grants",
  "effective_permissions",
  "proposals",
  "proposal_reviews",
  "decisions",
  "events",
  "runs",
  "jobs",
  "job_attempts",
  "source_objects",
  "write_leases",
  "operational_mcp_sessions",
  "operational_rate_limits",
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_token_revocations",
  "operational_request_logs",
  "operational_budget_counters",
  "runtime_metadata",
] as const;

test("Postgres runtime schema covers enterprise serving tables and queue indexes", () => {
  const sql = postgresRuntimeSchemaSql();
  for (const table of POSTGRES_RUNTIME_SCHEMA_TABLES) {
    assert.match(sql, new RegExp("CREATE TABLE IF NOT EXISTS " + table + "\\b"));
  }
  assert.match(sql, /json JSONB NOT NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS runs_status_created_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS edges_from_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_type_title_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_updated_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS edges_type_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS proposals_status_updated_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS events_type_occurred_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS events_actor_occurred_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS events_operation_occurred_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS events_record_occurred_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS runs_actor_created_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS search_documents_source_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS search_documents_fts_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS job_attempts/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS job_attempts_run_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS service_accounts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS principals \(\s+workspace_id TEXT NOT NULL,/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS groups \(\s+workspace_id TEXT NOT NULL,/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS principal_groups \(\s+workspace_id TEXT NOT NULL,/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS api_tokens/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS idp_mappings/);
  assert.match(sql, /token_hash_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS service_accounts_actor_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idp_mappings_claim_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS runtime_metadata/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS write_leases/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS write_leases_expires_idx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_mcp_sessions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_rate_limits/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_clients/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_authorization_codes/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_access_tokens/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_refresh_tokens/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_token_revocations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_request_logs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_budget_counters/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS operational_mcp_sessions_expires_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS operational_rate_limits_expires_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS oauth_access_tokens_hash_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS operational_request_logs_actor_idx/);
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0002_runtime_metadata"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0003_job_attempts"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0004_runtime_identity"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0005_search_fts"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0006_identity_workspace_scope"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0007_write_leases"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0008_operational_state"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0009_operational_filter_indexes"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0010_search_chunks"));
  assert.ok(POSTGRES_RUNTIME_MIGRATIONS.some((migration) => migration.id === "0011_remote_mcp_auth"));
  assert.equal(POSTGRES_RUNTIME_MIGRATIONS.find((migration) => migration.id === "0009_operational_filter_indexes")?.transactional, false);
  assert.match(postgresRuntimeWriteLeaseSchemaSql(), /PRIMARY KEY \(workspace_id, lock_name\)/);
  assert.match(postgresRuntimeOperationalFilterIndexesSchemaSql(), /CREATE INDEX CONCURRENTLY IF NOT EXISTS events_type_occurred_idx/);
  assert.match(postgresRuntimeOperationalFilterIndexesSchemaSql(), /runs_actor_created_idx/);
  assert.match(postgresRuntimeOperationalStateSchemaSql(), /PRIMARY KEY \(workspace_id, session_id\)/);
  assert.match(postgresRuntimeOperationalStateSchemaSql(), /PRIMARY KEY \(workspace_id, rate_key\)/);
  assert.match(postgresRuntimeRemoteMcpAuthSchemaSql(), /CREATE TABLE IF NOT EXISTS oauth_clients/);
  assert.match(postgresRuntimeRemoteMcpAuthSchemaSql(), /CREATE TABLE IF NOT EXISTS operational_request_logs/);
  assert.match(postgresRuntimeRemoteMcpAuthSchemaSql(), /PRIMARY KEY \(workspace_id, subject_id, budget_key, window_start\)/);
  assert.equal(new Set(POSTGRES_RUNTIME_MIGRATIONS.map((migration) => migration.id)).size, POSTGRES_RUNTIME_MIGRATIONS.length);
  for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
    assert.match(migration.id, /^\d{4}_[a-z0-9_]+$/);
    assert.match(migration.sql, /CREATE (TABLE|INDEX)(?: CONCURRENTLY)? IF NOT EXISTS|ALTER TABLE/);
    assert.doesNotMatch(migration.sql, /\$\{|\$\d+\b|--\s*@dynamic\b/);
  }
});

test("Postgres runtime resolves DATABASE_URL without storing secrets in repo config", () => {
  assert.equal(
    resolvePostgresDatabaseUrl({ databaseUrlEnv: { DATABASE_URL: "postgres://db/default", OPENWIKI_DATABASE_URL: "postgres://db/openwiki" } }),
    "postgres://db/openwiki",
  );
  assert.equal(resolvePostgresDatabaseUrl({ databaseUrlEnv: { DATABASE_URL: "postgres://db/default" } }), "postgres://db/default");
  assert.throws(() => resolvePostgresDatabaseUrl({ databaseUrlEnv: {} }), /requires OPENWIKI_DATABASE_URL or DATABASE_URL/);
});

test("Postgres runtime sanitizes dream run payloads without storing unknown fields", () => {
  assert.deepEqual(
    sanitizePostgresRunInput("dream.run", {
      phases: "index_refresh, link_suggestions",
      limit: 10,
      timeout_ms: 5000,
      dry_run: true,
      create_proposals: false,
      provider: "local-eval",
      schema_pack: "personal",
      credential: "must-not-persist",
    }),
    {
      phases: ["index_refresh", "link_suggestions"],
      limit: 10,
      timeout_ms: 5000,
      dry_run: true,
      create_proposals: false,
      provider: "local-eval",
      schema_pack: "personal",
    },
  );
  assert.throws(() => sanitizePostgresRunInput("dream.run", { phases: "index_refresh,not_a_phase" }), /known phase names/);
  assert.throws(() => sanitizePostgresRunInput("dream.run", { create_proposals: "true" }), /Expected boolean dream\.run input field/);
});

test("Postgres runtime importer and readers cover derived records, graph, proposals, and search", async () => {
  const source = await readPostgresRuntimeSources();
  const index = await readFile("packages/postgres-runtime/src/index.ts", "utf8");
  const migrations = await readFile("packages/postgres-runtime/src/migrations.ts", "utf8");
  const queries = await readFile("packages/postgres-runtime/src/queries.ts", "utf8");
  assert.match(index, /from "\.\/queries\.ts"/);
  assert.match(migrations, /function assertStaticPostgresMigration/);
  assert.match(migrations, /pg_advisory_lock/);
  assert.match(migrations, /pg_advisory_unlock/);
  assert.match(migrations, /migration\.transactional === false/);
  assert.match(migrations, /for \(const statement of staticPostgresMigrationStatements\(migration\.sql\)\)/);
  assert.match(migrations, /ON CONFLICT \(migration_id\) DO NOTHING/);
  assert.match(queries, /export async function readCurrentPostgresWorkspaceIndex/);
  assert.match(source, /export async function rebuildPostgresRuntimeIndex/);
  assert.match(source, /const POSTGRES_IMPORT_BATCH_SIZE = 500/);
  assert.match(source, /for \(const batch of chunks\(records, POSTGRES_IMPORT_BATCH_SIZE\)\)/);
  assert.match(source, /for \(const batch of chunks\(edges, POSTGRES_IMPORT_BATCH_SIZE\)\)/);
  assert.match(source, /for \(const batch of chunks\(documents, POSTGRES_IMPORT_BATCH_SIZE\)\)/);
  assert.match(source, /INSERT INTO records/);
  assert.match(source, /INSERT INTO edges/);
  assert.match(source, /INSERT INTO search_documents/);
  assert.match(source, /export async function readCurrentPostgresGraph/);
  assert.match(source, /boundedEdgeRowsForFrontier/);
  assert.match(source, /graphNodesById/);
  assert.doesNotMatch(source, /frontier\.size > 0 && !visited\.has\(toId\)/);
  assert.match(source, /jsonb_array_length\(COALESCE\(json->'source_ids', '\[\]'::jsonb\)\) = 0/);
  assert.match(source, /jsonb_array_elements_text\(COALESCE\(r\.json->'claim_ids', '\[\]'::jsonb\)\)/);
  assert.match(source, /export async function listCurrentPostgresProposals/);
  assert.match(source, /export async function readCurrentPostgresRecord/);
  assert.match(source, /export async function readCurrentPostgresRecordEntry/);
  assert.match(source, /export async function readCurrentPostgresRecordsByIds/);
  assert.match(source, /interface PostgresRuntimeRecordEntry/);
  assert.match(source, /SELECT record_id, json, path, status, sensitivity/);
  assert.match(source, /export async function listCurrentPostgresRecords/);
  assert.match(source, /json->>'page_type' = \$\{options\.group/);
  assert.match(source, /target_ids_json @> /);
  assert.match(source, /jsonb\(\[options\.targetId \?\? ""\]\)/);
  assert.match(source, /LIMIT \$\{sqlLimit\}/);
  assert.match(source, /OFFSET \$\{sqlOffset\}/);
  assert.match(source, /SELECT COUNT\(\*\) AS count\s+FROM proposals/);
  assert.match(source, /export async function listCurrentPostgresEvents/);
  assert.match(source, /event_type = \$\{options\.eventType \?\? ""\}/);
  assert.match(source, /json->'subject_ids' \? \$\{options\.recordId \?\? ""\}/);
  assert.match(source, /occurred_at >= \$\{options\.since/);
  assert.match(source, /export async function listCurrentPostgresRuns/);
  assert.match(source, /status IN \$\{sql\(statuses\)\}/);
  assert.match(source, /created_at >= \$\{options\.since/);
  assert.match(source, /function postgresEventListOptions/);
  assert.match(source, /function postgresRunListOptions/);
  assert.match(source, /export async function readCurrentPostgresRun/);
  assert.match(source, /export async function readCurrentPostgresWorkspaceRegistry/);
  assert.match(source, /JOIN workspaces ON workspaces\.tenant_id = tenants\.tenant_id/);
  assert.match(source, /JOIN tenants ON tenants\.organization_id = organizations\.organization_id/);
  assert.doesNotMatch(source, /SELECT \* FROM organizations ORDER BY organization_id/);
  assert.doesNotMatch(source, /SELECT \* FROM tenants ORDER BY tenant_id/);
  assert.match(source, /job_attempts/);
  assert.match(source, /export async function listCurrentPostgresTopics/);
  assert.doesNotMatch(source, /SELECT COUNT\(\*\) AS count FROM \$\{table\}/);
  assert.match(source, /function assertStaticPostgresMigration/);
  assert.match(source, /export async function listCurrentPostgresOpenQuestions/);
  assert.match(source, /export async function listCurrentPostgresSources/);
  assert.match(source, /export async function readCurrentPostgresSource/);
  assert.match(source, /export async function listCurrentPostgresIdentities/);
  assert.match(source, /FROM principals\s+WHERE workspace_id =/);
  assert.match(source, /FROM groups\s+WHERE workspace_id =/);
  assert.match(source, /FROM principal_groups\s+WHERE workspace_id =/);
  assert.match(source, /INSERT INTO service_accounts/);
  assert.match(source, /materializeEffectivePermissions\(repo\.config, repo\.policy\)/);
  assert.match(source, /redactedRuntimeGitConfig/);
  assert.match(source, /redactOpenWikiWorkspaceConfig/);
  assert.match(source, /jsonb\(redactedConfig\)\}::jsonb/);
  assert.match(source, /redactOpenWikiGitRemoteUrl/);
  assert.doesNotMatch(source, /git: repo\.config\.runtime\?\.git \?\? \{\}/);
  assert.doesNotMatch(source, /jsonb\(repo\.config\)::jsonb/);
  assert.match(source, /runtimeServiceAccountFromRow/);
  assert.doesNotMatch(source, /token_hashes: account\.token_hashes/);
  assert.match(source, /export async function readPostgresRuntimeQueueHealth/);
  assert.match(source, /export async function reapStalePostgresRunJobs/);
  assert.match(source, /export async function cancelPostgresRun/);
  assert.match(source, /export async function readPostgresWriteLease/);
  assert.match(source, /export async function recoverExpiredPostgresWriteLease/);
  assert.match(source, /export async function searchCurrentPostgresRuntime/);
  assert.match(source, /const POSTGRES_SEARCH_SCAN_CAP = 25_000/);
  assert.match(source, /postgresSearchRowsWithoutPolicy/);
  assert.match(source, /postgresSearchRowAllowedForPolicy/);
  assert.match(source, /postgresSearchRowMatchesRequest/);
  assert.match(source, /request: SearchRequest/);
  assert.match(source, /source_ids_json/);
  assert.match(source, /websearch_to_tsquery\('simple'/);
  assert.match(source, /fuseSearchRetrieverRuns/);
  assert.match(source, /postgresSearchRowsVisibleToPolicy/);
  assert.match(source, /visibleTarget: Math\.max\(fetchLimit, offset \+ limit \+ 1\)/);
  assert.match(source, /POSTGRES_POLICY_SEARCH_SCAN_CAP/);
  assert.match(source, /ESCAPE \$\{POSTGRES_LIKE_ESCAPE\}/);
  assert.match(source, /policy_scan_capped: searchRows\.scanCapped/);
  assert.match(source, /candidate_strategy: policyContext === undefined \? "postgres_fts_lexical" : "postgres_fts_lexical_policy_batches"/);
  assert.match(source, /capabilities: backendCapabilities/);
  assert.match(source, /disabled_retrievers: disabledPostgresSearchRetrievers\(request\)/);
  assert.match(source, /scanned_rows: searchRows\.scannedRows/);
  assert.match(source, /unsupported_retrievers: \["ngram", "fuzzy", "graph", "vector"\]/);
});

test("Postgres search escapes literal LIKE wildcards before exact path/title matching", () => {
  assert.equal(escapePostgresLikePattern("100%_Ready\\Path"), "%100\\%\\_ready\\\\path%");
});

test("HTTP and MCP simple record reads prefer the Postgres read store before Git fallback", async () => {
  const apiRecords = await readFile("packages/http-api/src/routes/api-records.ts", "utf8");
  const dataAccess = await readFile("packages/http-api/src/data-access.ts", "utf8");
  const webRoutes = await readFile("packages/http-api/src/routes/web.ts", "utf8");
  const contentRenderer = await readFile("packages/http-api/src/renderers/content.ts", "utf8");
  const toolRouter = await readFile("packages/mcp-server/src/tool-router.ts", "utf8");
  const toolHandlers = await readFile("packages/mcp-server/src/tool-handlers.ts", "utf8");
  assert.match(apiRecords, /readCurrentPostgresRecord<PageRecord>\(root, pageId, "page"\)/);
  assert.match(apiRecords, /readCurrentPostgresRecord<ClaimRecord>\(root, claimId, "claim"\)/);
  assert.match(apiRecords, /readCurrentPostgresRecord<ProposalRecord>\(root, proposalId, "proposal"\)/);
  assert.match(apiRecords, /readCurrentPostgresRecord<DecisionRecord>\(root, decisionId, "decision"\)/);
  assert.match(dataAccess, /graphPathFromIndex\(await filterGraphIndexByPolicy\(root, policy, response\), response\.from_id, response\.to_id\)/);
  assert.doesNotMatch(dataAccess, /readCurrentPostgresGraph\(root\)/);
  assert.match(webRoutes, /readCurrentPostgresRecordEntry<PageRecord>\(root, webPageId, "page"\)/);
  assert.match(webRoutes, /httpCanReadPostgresRecordEntry\(policy, postgresPage\)/);
  assert.match(contentRenderer, /async function renderPostgresPageView/);
  assert.match(contentRenderer, /readCurrentPostgresRecordEntry<PageRecord>\(root, id, "page"\)/);
  assert.match(contentRenderer, /readCurrentPostgresRecordsByIds<SourceRecord>/);
  assert.match(contentRenderer, /const claims = \(claimReads\?\.records \?\? \[\]\)\s+\.filter\(\(entry\) => httpCanReadPostgresRecordEntry\(policy, entry\)\)\s+\.map\(\(entry\) => entry\.record\);/);
  assert.match(contentRenderer, /admin \? graphCurrentPostgresNeighbors/);
  assert.match(toolRouter, /toolMode === "read" \? await withRepositoryReadCache\(invokeTool\) : await invokeTool\(\)/);
  assert.match(toolRouter, /readCurrentPostgresRecord<PageRecord>\(root, id, "page"\)/);
  assert.match(toolRouter, /readCurrentPostgresRecord<ClaimRecord>\(root, id, "claim"\)/);
  assert.match(toolRouter, /readCurrentPostgresRecord<ProposalRecord>\(root, id, "proposal"\)/);
  assert.match(toolRouter, /readCurrentPostgresRecord<DecisionRecord>\(root, id, "decision"\)/);
  assert.match(toolHandlers, /graphPathFromIndex\(await filterGraphIndexForMcp\(root, context, result\), result\.from_id, result\.to_id\)/);
  assert.doesNotMatch(toolHandlers, /readCurrentPostgresGraph\(root\)/);
});

test("CLI can print the Postgres schema outside a workspace", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
      "db",
      "schema",
      "postgres",
    ],
    { cwd: process.cwd() },
  );
  assert.match(stdout, /CREATE TABLE IF NOT EXISTS workspaces/);
  assert.match(stdout, /CREATE TABLE IF NOT EXISTS principals/);
});

test("Postgres runtime exposes incremental sync and freshness checks", async () => {
  const source = await readPostgresRuntimeSources();
  assert.match(source, /export async function syncPostgresRuntimeIndex/);
  assert.match(source, /export async function checkPostgresRuntimeIntegrity/);
  assert.match(source, /interface PostgresMigrationDiagnostics/);
  assert.match(source, /missing Postgres migrations/);
  assert.match(source, /SELECT migration_id\s+FROM openwiki_migrations/);
  assert.match(source, /runtime_metadata/);
  assert.match(source, /previousSummary\.schema_version === POSTGRES_RUNTIME_SCHEMA_VERSION/);
  assert.match(source, /previousSummary\.schema_version !== POSTGRES_RUNTIME_SCHEMA_VERSION/);
  assert.match(source, /changedGitPaths/);
  assert.match(source, /openWikiGitArgs\(undefined, \["diff", "--name-status", "-z"/);
  assert.match(source, /parseGitNameStatusPathsZ/);
  assert.match(source, /last_sync_mode/);
  assert.match(source, /record_type = 'topic'/);
  assert.match(source, /contentPathChangesTopics\(changedPath\)/);
  assert.match(source, /recordsChangedSincePreviousSync/);
  assert.match(source, /stableJsonStringify/);
  assert.match(source, /changedPathsAffectGovernancePlane/);
  assert.match(source, /currentCommit !== "uncommitted" && indexedCommit !== currentCommit/);
  assert.match(source, /openWikiGitArgs\(undefined, \["status", "--porcelain=v1", "-z"\]/);
  assert.match(source, /currentCommit === "uncommitted" \|\|/);
  assert.match(source, /runtimeDirtyPathsRequireContentCheck\(dirtyPaths, process\.env\)/);
  assert.match(source, /repoPath\.startsWith\("runs\/"\) \|\| repoPath\.startsWith\("events\/"\)/);
  assert.match(source, /refreshGovernancePlane/);
  assert.doesNotMatch(source, /upsertGovernancePlane/);
  assert.match(source, /export async function clearWorkspaceGovernanceRows/);
  assert.match(source, /DELETE FROM source_objects WHERE workspace_id/);
  assert.match(source, /DELETE FROM runs WHERE workspace_id/);
  assert.match(source, /DELETE FROM events WHERE workspace_id/);
  assert.match(source, /DELETE FROM proposals WHERE workspace_id/);
  assert.doesNotMatch(source, /DELETE FROM job_attempts WHERE workspace_id/);
  assert.doesNotMatch(source, /DELETE FROM jobs WHERE workspace_id/);
  assert.match(source, /env\.OPENWIKI_QUEUE_BACKEND !== "postgres"/);
  assert.match(source, /runtimeMetadataValue\(sql, repo\.config\.workspace_id, "content_hash"\)/);
  assert.match(source, /indexedContentHash === undefined \|\| indexedContentHash !== await currentRuntimeContentHash\(repo\)/);
  assert.doesNotMatch(source, /OPENWIKI_POSTGRES_ALLOW_UNCOMMITTED/);
});

test("Postgres queue implementation uses atomic row claiming", async () => {
  const source = await readPostgresRuntimeSources();
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /WHERE workspace_id = .* AND status = 'queued'/s);
  assert.match(source, /ORDER BY created_at ASC, run_id ASC/);
  assert.match(source, /async function upsertJobForRun/);
  assert.match(source, /async function upsertJobAttempt/);
  assert.match(source, /async heartbeat\(run: RunRecord/);
  assert.match(source, /readPostgresRuntimeQueueHealth/);
  assert.match(source, /openwiki_migrations/);
  assert.match(source, /skipped\.push\(migration\.id\)/);
  assert.match(source, /attempts = CASE WHEN EXCLUDED.status = 'running' THEN jobs.attempts \+ 1 ELSE jobs.attempts END/);
  assert.match(source, /stale_running_jobs/);
  assert.match(source, /OPENWIKI_RUN_STALE_AFTER_MS/);
  assert.match(source, /operation: "wiki.run_reaper"/);
  assert.match(source, /operation: "wiki.run_cancel"/);
});

test("Postgres read and search backends are explicit opt-ins", () => {
  assert.equal(postgresRuntimeReadEnabled({}), false);
  assert.equal(postgresRuntimeSearchEnabled({}), false);
  assert.equal(postgresRuntimeReadEnabled({ OPENWIKI_READ_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeSearchEnabled({ OPENWIKI_SEARCH_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeReadEnabled({ OPENWIKI_RUNTIME_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeSearchEnabled({ OPENWIKI_RUNTIME_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeWriteSyncEnabled({}), false);
  assert.equal(postgresRuntimeWriteSyncEnabled({ OPENWIKI_POSTGRES_SYNC_ON_WRITE: "1" }), true);
  assert.equal(postgresRuntimeWriteSyncEnabled({ OPENWIKI_READ_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeWriteSyncEnabled({ OPENWIKI_SEARCH_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeWriteSyncEnabled({ OPENWIKI_RUNTIME_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeConfigured({}), false);
  assert.equal(postgresRuntimeConfigured({ DATABASE_URL: "postgres://db/default" }), true);
  assert.equal(postgresRuntimeHealthEnabled({ DATABASE_URL: "postgres://db/default" }), false);
  assert.equal(postgresRuntimeHealthEnabled({ DATABASE_URL: "postgres://db/default", OPENWIKI_RUNTIME_BACKEND: "postgres" }), true);
  assert.equal(postgresRuntimeHealthEnabled({ DATABASE_URL: "postgres://db/default", OPENWIKI_QUEUE_BACKEND: "postgres" }), true);
});

test("queue backend can be selected by env and requires DATABASE_URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-queue-config-"));
  const oldQueue = process.env.OPENWIKI_QUEUE_BACKEND;
  const oldDatabase = process.env.DATABASE_URL;
  const oldOpenWikiDatabase = process.env.OPENWIKI_DATABASE_URL;
  try {
    await createWorkspace(root, "Postgres Queue Config Wiki");
    process.env.OPENWIKI_QUEUE_BACKEND = "postgres";
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;
    await assert.rejects(createRunQueue(root), /requires OPENWIKI_DATABASE_URL or DATABASE_URL/);
  } finally {
    restoreEnv("OPENWIKI_QUEUE_BACKEND", oldQueue);
    restoreEnv("DATABASE_URL", oldDatabase);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabase);
    await rm(root, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function readPostgresRuntimeSources(): Promise<string> {
  const modules = [
    "index.ts",
    "config.ts",
    "derived-records.ts",
    "git.ts",
    "graph.ts",
    "jobs.ts",
    "migrations.ts",
    "operational-state.ts",
    "queries.ts",
    "rows.ts",
    "search.ts",
    "sync.ts",
    "sync-writes.ts",
    "types.ts",
    "write-leases.ts",
  ];
  return (await Promise.all(modules.map((module) => readFile(path.join("packages/postgres-runtime/src", module), "utf8")))).join("\n");
}
