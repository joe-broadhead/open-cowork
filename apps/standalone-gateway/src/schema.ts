export const STANDALONE_GATEWAY_SCHEMA_VERSION = 2;

export const standaloneGatewayMigrations = [{
  id: "0001_standalone_gateway_core",
  sql: `
CREATE TABLE IF NOT EXISTS standalone_gateway_schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_daemon_leases (
  lease_id text PRIMARY KEY,
  owner_id text NOT NULL,
  lease_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_sessions (
  session_id text PRIMARY KEY,
  opencode_session_id text,
  title text NOT NULL,
  status text NOT NULL,
  provider text NOT NULL,
  provider_kind text NOT NULL,
  provider_workspace_id text NOT NULL DEFAULT '',
  channel_binding_id text NOT NULL,
  external_user_id text NOT NULL,
  external_chat_id text NOT NULL,
  external_thread_id text NOT NULL,
  last_event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_events (
  event_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES standalone_gateway_sessions(session_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS standalone_gateway_jobs (
  job_id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL,
  session_id text REFERENCES standalone_gateway_sessions(session_id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_by text,
  claim_token text,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_channel_identities (
  identity_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_workspace_id text NOT NULL DEFAULT '',
  external_user_id text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'approver', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_channel_bindings (
  binding_id text PRIMARY KEY,
  provider text NOT NULL,
  provider_kind text NOT NULL,
  display_name text NOT NULL,
  credential_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_artifacts (
  artifact_id text PRIMARY KEY,
  session_id text REFERENCES standalone_gateway_sessions(session_id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text,
  storage_uri text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_team_tasks (
  task_id text PRIMARY KEY,
  parent_session_id text REFERENCES standalone_gateway_sessions(session_id) ON DELETE SET NULL,
  child_session_id text REFERENCES standalone_gateway_sessions(session_id) ON DELETE SET NULL,
  status text NOT NULL,
  assignee text,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standalone_gateway_audit_events (
  audit_id text PRIMARY KEY,
  action text NOT NULL,
  actor text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS standalone_gateway_sessions_provider_workspace_thread_idx
  ON standalone_gateway_sessions (provider, provider_workspace_id, external_chat_id, external_thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS standalone_gateway_sessions_provider_workspace_thread_unique
  ON standalone_gateway_sessions (provider, provider_workspace_id, external_chat_id, external_thread_id);
CREATE INDEX IF NOT EXISTS standalone_gateway_events_session_sequence_idx
  ON standalone_gateway_events (session_id, sequence);
CREATE INDEX IF NOT EXISTS standalone_gateway_jobs_claim_idx
  ON standalone_gateway_jobs (status, available_at, claim_expires_at);
CREATE INDEX IF NOT EXISTS standalone_gateway_audit_created_idx
  ON standalone_gateway_audit_events (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS standalone_gateway_channel_identities_provider_workspace_user_unique
  ON standalone_gateway_channel_identities (provider, provider_workspace_id, external_user_id);

CREATE INDEX IF NOT EXISTS standalone_gateway_channel_identities_prompt_auth_idx
  ON standalone_gateway_channel_identities (provider, status, role);
  `,
  }, {
    id: "0002_standalone_gateway_retention_indexes",
    sql: `
CREATE INDEX IF NOT EXISTS standalone_gateway_sessions_retention_idx
  ON standalone_gateway_sessions (updated_at)
  WHERE status IN ('idle', 'failed', 'completed');

CREATE INDEX IF NOT EXISTS standalone_gateway_jobs_retention_idx
  ON standalone_gateway_jobs (updated_at)
  WHERE status IN ('completed', 'failed', 'dead');

CREATE INDEX IF NOT EXISTS standalone_gateway_jobs_active_session_idx
  ON standalone_gateway_jobs (session_id, status)
  WHERE status IN ('pending', 'claimed', 'running');

CREATE INDEX IF NOT EXISTS standalone_gateway_artifacts_retention_idx
  ON standalone_gateway_artifacts (created_at);

CREATE INDEX IF NOT EXISTS standalone_gateway_artifacts_session_retention_idx
  ON standalone_gateway_artifacts (session_id, created_at);
  `,
  }];

export function standaloneGatewaySchemaContainsProductionTables(sql = standaloneGatewayMigrations.map((migration) => migration.sql).join("\n")): boolean {
  return [
    "standalone_gateway_sessions",
    "standalone_gateway_events",
    "standalone_gateway_jobs",
    "standalone_gateway_daemon_leases",
    "standalone_gateway_channel_identities",
    "standalone_gateway_channel_bindings",
    "standalone_gateway_artifacts",
    "standalone_gateway_team_tasks",
    "standalone_gateway_audit_events",
  ].every((table) => sql.includes(table));
}
