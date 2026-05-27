export const CLOUD_CONTROL_PLANE_MIGRATION_ID = '001_cloud_control_plane'
export const CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS = [720_908_611, 1_762_083_497] as const

export const CLOUD_CONTROL_PLANE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_tenants (
    tenant_id text PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_users (
    tenant_id text NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    user_id text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_sessions (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    user_id text NOT NULL,
    opencode_session_id text NOT NULL,
    profile_name text NOT NULL,
    status text NOT NULL,
    title text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    next_event_sequence integer NOT NULL DEFAULT 0,
    next_command_sequence integer NOT NULL DEFAULT 0,
    next_lease_attempt integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES cloud_users(tenant_id, user_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_sessions_user_idx
    ON cloud_sessions (tenant_id, user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_session_events (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    event_id text NOT NULL,
    sequence integer NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, session_id, event_id),
    UNIQUE (tenant_id, session_id, sequence),
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_session_events_sequence_idx
    ON cloud_session_events (tenant_id, session_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS cloud_workspace_event_counters (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    next_sequence integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, user_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES cloud_users(tenant_id, user_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_workspace_events (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    event_id text NOT NULL,
    sequence integer NOT NULL,
    session_id text,
    entity_type text NOT NULL DEFAULT 'session',
    entity_id text NOT NULL,
    operation text NOT NULL DEFAULT 'update',
    projection_version integer NOT NULL DEFAULT 0,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, user_id, event_id),
    UNIQUE (tenant_id, user_id, sequence),
    FOREIGN KEY (tenant_id, user_id) REFERENCES cloud_users(tenant_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `ALTER TABLE cloud_workspace_events
    ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'session'`,
  `ALTER TABLE cloud_workspace_events
    ADD COLUMN IF NOT EXISTS entity_id text NOT NULL DEFAULT ''`,
  `ALTER TABLE cloud_workspace_events
    ADD COLUMN IF NOT EXISTS operation text NOT NULL DEFAULT 'update'`,
  `ALTER TABLE cloud_workspace_events
    ADD COLUMN IF NOT EXISTS projection_version integer NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS cloud_workspace_events_sequence_idx
    ON cloud_workspace_events (tenant_id, user_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS cloud_session_projections (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    sequence integer NOT NULL,
    view jsonb NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, session_id),
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_worker_leases (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    leased_by text NOT NULL,
    lease_token text NOT NULL,
    lease_expires_at_ms bigint NOT NULL,
    checkpoint_version integer NOT NULL,
    PRIMARY KEY (tenant_id, session_id),
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_session_commands (
    command_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    target_lease_token text,
    created_sequence integer NOT NULL,
    created_at timestamptz NOT NULL,
    status text NOT NULL,
    claimed_by text,
    claimed_lease_token text,
    acked_at timestamptz,
    error text,
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_session_commands_pending_idx
    ON cloud_session_commands (tenant_id, session_id, status, created_sequence)`,
  `CREATE TABLE IF NOT EXISTS cloud_worker_heartbeats (
    worker_id text PRIMARY KEY,
    role text NOT NULL,
    active_session_ids jsonb NOT NULL,
    last_seen_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_setting_metadata (
    tenant_id text NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    user_scope text NOT NULL,
    user_id text,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, user_scope, key)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_workflows (
    tenant_id text NOT NULL,
    workflow_id text NOT NULL,
    user_id text NOT NULL,
    title text NOT NULL,
    instructions text NOT NULL,
    agent_name text NOT NULL,
    skill_names jsonb NOT NULL,
    tool_ids jsonb NOT NULL,
    status text NOT NULL,
    project_directory text,
    draft_session_id text,
    triggers jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    next_run_at timestamptz,
    last_run_at timestamptz,
    latest_run_id text,
    latest_run_status text,
    latest_run_session_id text,
    latest_run_summary text,
    PRIMARY KEY (tenant_id, workflow_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES cloud_users(tenant_id, user_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_workflows_user_idx
    ON cloud_workflows (tenant_id, user_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_workflows_due_idx
    ON cloud_workflows (status, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS cloud_workflow_runs (
    tenant_id text NOT NULL,
    run_id text NOT NULL,
    workflow_id text NOT NULL,
    user_id text NOT NULL,
    session_id text,
    trigger_type text NOT NULL,
    trigger_payload jsonb,
    status text NOT NULL,
    title text NOT NULL,
    summary text,
    error text,
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    PRIMARY KEY (tenant_id, run_id),
    FOREIGN KEY (tenant_id, workflow_id) REFERENCES cloud_workflows(tenant_id, workflow_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_workflow_runs_workflow_idx
    ON cloud_workflow_runs (tenant_id, workflow_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_workflow_runs_session_idx
    ON cloud_workflow_runs (tenant_id, session_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_thread_tags (
    tenant_id text NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    tag_id text NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, tag_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_thread_tags_name_idx
    ON cloud_thread_tags (tenant_id, lower(name))`,
  `CREATE TABLE IF NOT EXISTS cloud_thread_tag_links (
    tenant_id text NOT NULL,
    session_id text NOT NULL,
    tag_id text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, session_id, tag_id),
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, tag_id) REFERENCES cloud_thread_tags(tenant_id, tag_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_thread_tag_links_tag_idx
    ON cloud_thread_tag_links (tenant_id, tag_id, session_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_thread_smart_filters (
    tenant_id text NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    filter_id text NOT NULL,
    name text NOT NULL,
    query jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, filter_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_webhook_rate_limits (
    source text PRIMARY KEY,
    window_started_at_ms bigint NOT NULL,
    count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_webhook_auth_failures (
    scope text PRIMARY KEY,
    source text NOT NULL,
    auth_window_started_at_ms bigint NOT NULL,
    auth_failure_count integer NOT NULL,
    blocked_until_ms bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_webhook_replay_claims (
    replay_key text PRIMARY KEY,
    seen_at_ms bigint NOT NULL,
    status text NOT NULL
  )`,
] as const
