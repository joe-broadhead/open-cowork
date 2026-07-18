import { postgresRuntimeRemoteMcpAuthSchemaSql } from "./auth-schema.ts";

export interface PostgresMigration {
  id: string;
  name: string;
  sql: string;
  transactional?: boolean;
}
export const POSTGRES_RUNTIME_SCHEMA_VERSION = "0.1.4";
export const POSTGRES_RUNTIME_MIGRATIONS: PostgresMigration[] = [
  {
    id: "0001_runtime_schema",
    name: "runtime records, graph, permissions, and queues",
    sql: postgresRuntimeSchemaSql(),
  },
  {
    id: "0002_runtime_metadata",
    name: "runtime freshness metadata",
    sql: postgresRuntimeMetadataSchemaSql(),
  },
  {
    id: "0003_job_attempts",
    name: "historical job attempt timeline",
    sql: postgresRuntimeJobAttemptsSchemaSql(),
  },
  {
    id: "0004_runtime_identity",
    name: "runtime identity, sessions, tokens, and IdP mappings",
    sql: postgresRuntimeIdentitySchemaSql(),
  },
  {
    id: "0005_search_fts",
    name: "postgres full-text search index",
    sql: postgresRuntimeSearchFtsSchemaSql(),
  },
  {
    id: "0006_identity_workspace_scope",
    name: "workspace-scoped identity lookup tables",
    sql: postgresRuntimeIdentityWorkspaceScopeSchemaSql(),
  },
  {
    id: "0007_write_leases",
    name: "hosted Git write leases",
    sql: postgresRuntimeWriteLeaseSchemaSql(),
  },
  {
    id: "0008_operational_state",
    name: "hosted HTTP operational state",
    sql: postgresRuntimeOperationalStateSchemaSql(),
  },
  {
    id: "0009_operational_filter_indexes",
    name: "operational event and run filter indexes",
    sql: postgresRuntimeOperationalFilterIndexesSchemaSql(),
    transactional: false,
  },
  {
    id: "0010_search_chunks",
    name: "derived search chunks and embedding metadata",
    sql: postgresRuntimeSearchChunksSchemaSql(),
  },
  {
    id: "0011_remote_mcp_auth",
    name: "remote MCP OAuth, request audit, and budget state",
    sql: postgresRuntimeRemoteMcpAuthSchemaSql(),
  },
];


export function postgresRuntimeSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS organizations (
  organization_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  repo_format TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  remote TEXT,
  branch TEXT,
  remote_url TEXT,
  credential_ref TEXT,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, repo_id)
);

CREATE TABLE IF NOT EXISTS records (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  sensitivity TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, record_id)
);

CREATE TABLE IF NOT EXISTS record_versions (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  parent_sha TEXT,
  author TEXT,
  authored_at TIMESTAMPTZ,
  committer TEXT,
  committed_at TIMESTAMPTZ,
  subject TEXT,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  json_snapshot JSONB NOT NULL,
  PRIMARY KEY (workspace_id, record_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS record_paths (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path, record_id)
);

CREATE TABLE IF NOT EXISTS edges (
  workspace_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  path TEXT,
  anchor TEXT,
  weight DOUBLE PRECISION NOT NULL,
  source_commit TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, edge_id)
);

CREATE TABLE IF NOT EXISTS search_documents (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  search_text TEXT NOT NULL,
  topics_json JSONB NOT NULL,
  source_ids_json JSONB NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, record_id)
);

CREATE TABLE IF NOT EXISTS search_chunks (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  source_ids_json JSONB NOT NULL,
  source_commit TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS search_chunk_embeddings (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BYTEA NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id, provider, model, dimensions)
);

CREATE TABLE IF NOT EXISTS principals (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, principal_id)
);

CREATE TABLE IF NOT EXISTS groups (
  workspace_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, group_id)
);

CREATE TABLE IF NOT EXISTS principal_groups (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, group_id)
);

CREATE TABLE IF NOT EXISTS service_accounts (
  workspace_id TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  token_hash_count INTEGER NOT NULL DEFAULT 0,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, service_account_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  workspace_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  principal_id TEXT,
  scopes_json JSONB NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, token_id)
);

CREATE TABLE IF NOT EXISTS idp_mappings (
  workspace_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  claim TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, mapping_id)
);

CREATE TABLE IF NOT EXISTS sections (
  workspace_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL,
  paths_json JSONB NOT NULL,
  owner_principal TEXT,
  default_reviewers_json JSONB NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, section_id)
);

CREATE TABLE IF NOT EXISTS grants (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  role TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, section_id)
);

CREATE TABLE IF NOT EXISTS effective_permissions (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, section_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  workspace_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_path TEXT,
  target_ids_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, proposal_id)
);

CREATE TABLE IF NOT EXISTS proposal_reviews (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, review_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, decision_id)
);

CREATE TABLE IF NOT EXISTS events (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  operation TEXT,
  record_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  sensitivity TEXT,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, event_id)
);

CREATE TABLE IF NOT EXISTS runs (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, run_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_attempts (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  worker_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error TEXT,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, job_id, attempt)
);

CREATE TABLE IF NOT EXISTS source_objects (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  storage_json JSONB NOT NULL,
  content_hash TEXT,
  url TEXT,
  path TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);

CREATE TABLE IF NOT EXISTS write_leases (
  workspace_id TEXT NOT NULL,
  lock_name TEXT NOT NULL,
  token TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, lock_name)
);

CREATE TABLE IF NOT EXISTS runtime_metadata (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS records_type_idx ON records (workspace_id, record_type, status);
CREATE INDEX IF NOT EXISTS records_type_title_idx ON records (workspace_id, record_type, title, record_id);
CREATE INDEX IF NOT EXISTS records_path_idx ON records (workspace_id, path);
CREATE INDEX IF NOT EXISTS records_updated_idx ON records (workspace_id, updated_at, record_id);
CREATE INDEX IF NOT EXISTS edges_from_idx ON edges (workspace_id, from_id, edge_type);
CREATE INDEX IF NOT EXISTS edges_to_idx ON edges (workspace_id, to_id, edge_type);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges (workspace_id, edge_type, from_id, to_id);
CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS proposals_status_updated_idx ON proposals (workspace_id, status, updated_at, proposal_id);
CREATE INDEX IF NOT EXISTS events_type_occurred_idx ON events (workspace_id, event_type, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS events_actor_occurred_idx ON events (workspace_id, actor_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS events_operation_occurred_idx ON events (workspace_id, operation, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS events_record_occurred_idx ON events (workspace_id, record_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs (workspace_id, status, created_at, run_id);
CREATE INDEX IF NOT EXISTS runs_actor_created_idx ON runs (workspace_id, actor_id, created_at, run_id);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (workspace_id, status, created_at, job_id);
CREATE INDEX IF NOT EXISTS job_attempts_run_idx ON job_attempts (workspace_id, run_id, attempt);
CREATE INDEX IF NOT EXISTS write_leases_expires_idx ON write_leases (workspace_id, expires_at);
CREATE TABLE IF NOT EXISTS operational_mcp_sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS operational_rate_limits (
  workspace_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, rate_key)
);

CREATE INDEX IF NOT EXISTS operational_mcp_sessions_expires_idx ON operational_mcp_sessions (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS operational_rate_limits_expires_idx ON operational_rate_limits (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS service_accounts_actor_idx ON service_accounts (workspace_id, actor_id);
CREATE INDEX IF NOT EXISTS sessions_actor_idx ON sessions (workspace_id, actor_id, expires_at);
CREATE INDEX IF NOT EXISTS api_tokens_actor_idx ON api_tokens (workspace_id, actor_id, expires_at);
CREATE INDEX IF NOT EXISTS idp_mappings_claim_idx ON idp_mappings (workspace_id, provider, claim, claim_value);
CREATE INDEX IF NOT EXISTS search_documents_source_idx ON search_documents (workspace_id, source_commit);
CREATE INDEX IF NOT EXISTS search_documents_fts_idx ON search_documents USING GIN (to_tsvector('simple', search_text));
CREATE INDEX IF NOT EXISTS search_chunks_record_idx ON search_chunks (workspace_id, record_id, ordinal);
CREATE INDEX IF NOT EXISTS search_chunk_embeddings_model_idx ON search_chunk_embeddings (workspace_id, provider, model, dimensions);
${postgresRuntimeRemoteMcpAuthSchemaSql()}
`.trim();
}

export function postgresRuntimeWriteLeaseSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS write_leases (
  workspace_id TEXT NOT NULL,
  lock_name TEXT NOT NULL,
  token TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, lock_name)
);

CREATE INDEX IF NOT EXISTS write_leases_expires_idx ON write_leases (workspace_id, expires_at);
`.trim();
}

export function postgresRuntimeOperationalStateSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS operational_mcp_sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  root_path TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS operational_rate_limits (
  workspace_id TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, rate_key)
);

CREATE INDEX IF NOT EXISTS operational_mcp_sessions_expires_idx ON operational_mcp_sessions (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS operational_rate_limits_expires_idx ON operational_rate_limits (workspace_id, expires_at);
`.trim();
}

export function postgresRuntimeOperationalFilterIndexesSchemaSql(): string {
  return `
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_type_occurred_idx ON events (workspace_id, event_type, occurred_at, event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_actor_occurred_idx ON events (workspace_id, actor_id, occurred_at, event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_operation_occurred_idx ON events (workspace_id, operation, occurred_at, event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_record_occurred_idx ON events (workspace_id, record_id, occurred_at, event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_actor_created_idx ON runs (workspace_id, actor_id, created_at, run_id);
`.trim();
}

function postgresRuntimeMetadataSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS runtime_metadata (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
`.trim();
}

function postgresRuntimeJobAttemptsSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS job_attempts (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  worker_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error TEXT,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, job_id, attempt)
);

CREATE INDEX IF NOT EXISTS job_attempts_run_idx ON job_attempts (workspace_id, run_id, attempt);
`.trim();
}

function postgresRuntimeIdentitySchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS service_accounts (
  workspace_id TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  token_hash_count INTEGER NOT NULL DEFAULT 0,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, service_account_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  principal_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  workspace_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  principal_id TEXT,
  scopes_json JSONB NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, token_id)
);

CREATE TABLE IF NOT EXISTS idp_mappings (
  workspace_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  claim TEXT NOT NULL,
  claim_value TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, mapping_id)
);

CREATE INDEX IF NOT EXISTS service_accounts_actor_idx ON service_accounts (workspace_id, actor_id);
CREATE INDEX IF NOT EXISTS sessions_actor_idx ON sessions (workspace_id, actor_id, expires_at);
CREATE INDEX IF NOT EXISTS api_tokens_actor_idx ON api_tokens (workspace_id, actor_id, expires_at);
CREATE INDEX IF NOT EXISTS idp_mappings_claim_idx ON idp_mappings (workspace_id, provider, claim, claim_value);
`.trim();
}

function postgresRuntimeSearchFtsSchemaSql(): string {
  return `
CREATE INDEX IF NOT EXISTS search_documents_fts_idx ON search_documents USING GIN (to_tsvector('simple', search_text));
`.trim();
}

export function postgresRuntimeSearchChunksSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS search_chunks (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  source_ids_json JSONB NOT NULL,
  source_commit TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS search_chunk_embeddings (
  workspace_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BYTEA NOT NULL,
  source_commit TEXT NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id, provider, model, dimensions)
);

CREATE INDEX IF NOT EXISTS search_chunks_record_idx ON search_chunks (workspace_id, record_id, ordinal);
CREATE INDEX IF NOT EXISTS search_chunk_embeddings_model_idx ON search_chunk_embeddings (workspace_id, provider, model, dimensions);
`.trim();
}

function postgresRuntimeIdentityWorkspaceScopeSchemaSql(): string {
  return `
ALTER TABLE principals ADD COLUMN IF NOT EXISTS workspace_id TEXT;
UPDATE principals SET workspace_id = 'workspace:legacy' WHERE workspace_id IS NULL;
ALTER TABLE principals ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_pkey;
ALTER TABLE principals ADD PRIMARY KEY (workspace_id, principal_id);

ALTER TABLE groups ADD COLUMN IF NOT EXISTS workspace_id TEXT;
UPDATE groups SET workspace_id = 'workspace:legacy' WHERE workspace_id IS NULL;
ALTER TABLE groups ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_pkey;
ALTER TABLE groups ADD PRIMARY KEY (workspace_id, group_id);

ALTER TABLE principal_groups ADD COLUMN IF NOT EXISTS workspace_id TEXT;
UPDATE principal_groups SET workspace_id = 'workspace:legacy' WHERE workspace_id IS NULL;
ALTER TABLE principal_groups ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE principal_groups DROP CONSTRAINT IF EXISTS principal_groups_pkey;
ALTER TABLE principal_groups ADD PRIMARY KEY (workspace_id, principal_id, group_id);
`.trim();
}
