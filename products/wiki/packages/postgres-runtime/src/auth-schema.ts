export function postgresRuntimeRemoteMcpAuthSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS oauth_clients (
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  actor_id TEXT NOT NULL,
  role TEXT,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  redirect_uris_json JSONB NOT NULL,
  grant_types_json JSONB NOT NULL,
  bounds_json JSONB NOT NULL,
  client_secret_hash_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  source_commit TEXT NOT NULL,
  json JSONB NOT NULL,
  PRIMARY KEY (workspace_id, client_id)
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  workspace_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  bounds_json JSONB NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, code_id)
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  workspace_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  bounds_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, token_id)
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  workspace_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scopes_json JSONB NOT NULL,
  principals_json JSONB NOT NULL,
  bounds_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, token_id)
);

CREATE TABLE IF NOT EXISTS oauth_token_revocations (
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  client_id TEXT,
  revoked_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, token_hash)
);

CREATE TABLE IF NOT EXISTS operational_request_logs (
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  route TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  auth_method TEXT,
  client_id TEXT,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  denied_reason TEXT,
  budget_units INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL,
  PRIMARY KEY (workspace_id, request_id)
);

CREATE TABLE IF NOT EXISTS operational_budget_counters (
  workspace_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  budget_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, subject_id, budget_key, window_start)
);

CREATE INDEX IF NOT EXISTS oauth_clients_actor_idx ON oauth_clients (workspace_id, actor_id);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_hash_idx ON oauth_authorization_codes (workspace_id, code_hash);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx ON oauth_authorization_codes (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_hash_idx ON oauth_access_tokens (workspace_id, token_hash);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_expires_idx ON oauth_access_tokens (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_hash_idx ON oauth_refresh_tokens (workspace_id, token_hash);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expires_idx ON oauth_refresh_tokens (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS operational_request_logs_actor_idx ON operational_request_logs (workspace_id, actor_id, occurred_at);
CREATE INDEX IF NOT EXISTS operational_request_logs_operation_idx ON operational_request_logs (workspace_id, operation, occurred_at);
CREATE INDEX IF NOT EXISTS operational_budget_counters_expires_idx ON operational_budget_counters (workspace_id, expires_at);
`.trim();
}
