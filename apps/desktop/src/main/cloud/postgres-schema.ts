export const CLOUD_CONTROL_PLANE_MIGRATION_ID = '001_cloud_control_plane'
export const CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS = [720_908_611, 1_762_083_497] as const

export type CloudControlPlaneMigration = {
  id: string
  statements: readonly string[]
}

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

export const CLOUD_CONTROL_PLANE_ORG_IDENTITY_TOKENS_AUDIT_MIGRATION_ID = '002_org_identity_tokens_audit'

export const CLOUD_CONTROL_PLANE_ORG_IDENTITY_TOKENS_AUDIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_orgs (
    org_id text PRIMARY KEY,
    tenant_id text UNIQUE NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    name text NOT NULL,
    plan_key text,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `INSERT INTO cloud_orgs (org_id, tenant_id, name, plan_key, status, created_at, updated_at)
    SELECT tenant_id, tenant_id, name, NULL, 'active', created_at, created_at
    FROM cloud_tenants
    ON CONFLICT (org_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS cloud_accounts (
    account_id text PRIMARY KEY,
    idp_subject text UNIQUE,
    email text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_accounts_email_idx
    ON cloud_accounts (lower(email))`,
  `INSERT INTO cloud_accounts (account_id, idp_subject, email, display_name, created_at, updated_at)
    SELECT DISTINCT user_id, user_id, email, NULL, created_at, created_at
    FROM cloud_users
    ON CONFLICT (account_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS cloud_memberships (
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    role text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, account_id)
  )`,
  `INSERT INTO cloud_memberships (org_id, account_id, role, status, created_at, updated_at)
    SELECT u.tenant_id, u.user_id, u.role, 'active', u.created_at, u.created_at
    FROM cloud_users u
    ON CONFLICT (org_id, account_id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS cloud_api_tokens (
    token_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    name text NOT NULL,
    token_hash text UNIQUE NOT NULL,
    scopes jsonb NOT NULL,
    last4 text NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_api_tokens_org_idx
    ON cloud_api_tokens (org_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_audit_events (
    event_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    actor_type text NOT NULL,
    actor_id text,
    event_type text NOT NULL,
    target_type text,
    target_id text,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_audit_events_org_created_idx
    ON cloud_audit_events (org_id, created_at DESC)`,
] as const

export const CLOUD_CONTROL_PLANE_HEADLESS_CHANNELS_MIGRATION_ID = '003_headless_channels'

export const CLOUD_CONTROL_PLANE_HEADLESS_CHANNELS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS headless_agents (
    agent_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    tenant_id text NOT NULL REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    profile_name text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    managed boolean NOT NULL DEFAULT false,
    created_by_account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS headless_agents_org_idx
    ON headless_agents (org_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_bindings (
    binding_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES headless_agents(agent_id) ON DELETE CASCADE,
    provider text NOT NULL,
    external_workspace_id text,
    display_name text NOT NULL,
    status text NOT NULL,
    credential_ref text,
    settings jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_bindings_org_agent_idx
    ON cloud_channel_bindings (org_id, agent_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_identities (
    identity_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    provider text NOT NULL,
    external_workspace_id text,
    external_user_id text NOT NULL,
    account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    role text NOT NULL,
    status text NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_channel_identities_external_idx
    ON cloud_channel_identities (org_id, provider, COALESCE(external_workspace_id, ''), external_user_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_session_bindings (
    binding_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES headless_agents(agent_id) ON DELETE CASCADE,
    channel_binding_id text NOT NULL REFERENCES cloud_channel_bindings(binding_id) ON DELETE CASCADE,
    provider text NOT NULL,
    external_workspace_id text,
    external_thread_id text NOT NULL,
    external_chat_id text NOT NULL,
    session_id text NOT NULL,
    last_event_sequence integer NOT NULL DEFAULT 0,
    last_workspace_sequence integer NOT NULL DEFAULT 0,
    last_chat_message_id text,
    status text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `ALTER TABLE cloud_channel_session_bindings
    ADD COLUMN IF NOT EXISTS external_workspace_id text`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'cloud_channel_session_bindings_thread_idx'
         AND indexdef NOT LIKE '%COALESCE(external_workspace_id%'
     ) THEN
       DROP INDEX cloud_channel_session_bindings_thread_idx;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_channel_session_bindings_thread_idx
    ON cloud_channel_session_bindings (org_id, provider, COALESCE(external_workspace_id, ''), external_chat_id, external_thread_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_session_bindings_session_idx
    ON cloud_channel_session_bindings (org_id, session_id)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_interactions (
    interaction_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES headless_agents(agent_id) ON DELETE CASCADE,
    session_id text NOT NULL,
    provider text NOT NULL,
    external_interaction_id text,
    token_hash text UNIQUE NOT NULL,
    kind text NOT NULL,
    target_id text NOT NULL,
    status text NOT NULL,
    created_by_identity_id text REFERENCES cloud_channel_identities(identity_id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_channel_interactions_external_idx
    ON cloud_channel_interactions (org_id, provider, external_interaction_id)
    WHERE external_interaction_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_interactions_session_idx
    ON cloud_channel_interactions (org_id, session_id, status)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_deliveries (
    delivery_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES headless_agents(agent_id) ON DELETE CASCADE,
    channel_binding_id text NOT NULL REFERENCES cloud_channel_bindings(binding_id) ON DELETE CASCADE,
    session_binding_id text REFERENCES cloud_channel_session_bindings(binding_id) ON DELETE SET NULL,
    provider text NOT NULL,
    target jsonb NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    claimed_by text,
    claim_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_deliveries_claim_idx
    ON cloud_channel_deliveries (org_id, status, next_attempt_at, created_at)`,
] as const

export const CLOUD_CONTROL_PLANE_BYOK_SECRETS_MIGRATION_ID = '004_byok_secrets'

export const CLOUD_CONTROL_PLANE_BYOK_SECRETS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_byok_secrets (
    secret_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    provider_id text NOT NULL,
    status text NOT NULL,
    ciphertext text,
    kms_ref text,
    last4 text NOT NULL,
    key_fingerprint text NOT NULL,
    created_by_account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    rotated_from_secret_id text REFERENCES cloud_byok_secrets(secret_id) ON DELETE SET NULL,
    last_validated_at timestamptz,
    validation_error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (
      (ciphertext IS NOT NULL AND kms_ref IS NULL)
      OR (ciphertext IS NULL AND kms_ref IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_byok_secrets_org_provider_idx
    ON cloud_byok_secrets (org_id, provider_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_byok_secrets_one_active_idx
    ON cloud_byok_secrets (org_id, provider_id)
    WHERE status = 'active'`,
] as const

export const CLOUD_CONTROL_PLANE_MIGRATIONS: readonly CloudControlPlaneMigration[] = [
  {
    id: CLOUD_CONTROL_PLANE_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_SCHEMA_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_ORG_IDENTITY_TOKENS_AUDIT_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_ORG_IDENTITY_TOKENS_AUDIT_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_HEADLESS_CHANNELS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_HEADLESS_CHANNELS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_BYOK_SECRETS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_BYOK_SECRETS_STATEMENTS,
  },
] as const
