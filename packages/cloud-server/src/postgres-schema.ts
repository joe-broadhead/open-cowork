export const CLOUD_CONTROL_PLANE_MIGRATION_ID = '001_cloud_control_plane'
export const CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS = [720_908_611, 1_762_083_497] as const

export type CloudControlPlaneMigration = {
  id: string
  statements: readonly string[]
  transactional?: boolean
  concurrentIndexes?: readonly string[]
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
  `CREATE TABLE IF NOT EXISTS cloud_artifact_index (
    tenant_id text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    artifact_id text NOT NULL,
    filename text NOT NULL,
    content_type text,
    size_bytes bigint NOT NULL,
    object_key text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    author_agent_id text,
    project_id text,
    task_id text,
    status_updated_by text,
    status_updated_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, session_id, artifact_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES cloud_users(tenant_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, session_id) REFERENCES cloud_sessions(tenant_id, session_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_index_user_updated_idx
    ON cloud_artifact_index (tenant_id, user_id, updated_at DESC, session_id, artifact_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_index_session_updated_idx
    ON cloud_artifact_index (tenant_id, user_id, session_id, updated_at DESC, artifact_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_index_project_idx
    ON cloud_artifact_index (tenant_id, user_id, project_id, task_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_artifact_index_kind_status_idx
    ON cloud_artifact_index (tenant_id, user_id, kind, status, updated_at DESC)`,
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
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
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
    ON CONFLICT (tenant_id) DO NOTHING`,
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
    SELECT orgs.org_id, u.user_id, u.role, 'active', u.created_at, u.created_at
    FROM cloud_users u
    JOIN cloud_orgs orgs ON orgs.tenant_id = u.tenant_id
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
    last_claimed_by text,
    claim_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_deliveries_claim_idx
    ON cloud_channel_deliveries (org_id, status, next_attempt_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS cloud_channel_provider_events (
    event_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_instance_id text NOT NULL,
    external_workspace_id text,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    status text NOT NULL,
    claimed_by text,
    claim_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0,
    retryable boolean NOT NULL DEFAULT true,
    last_error text,
    metadata jsonb NOT NULL,
    processed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_channel_provider_events_dedupe_idx
    ON cloud_channel_provider_events (org_id, provider, provider_instance_id, COALESCE(external_workspace_id, ''), event_type, provider_event_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_provider_events_claim_idx
    ON cloud_channel_provider_events (org_id, status, retryable, claim_expires_at, updated_at)`,
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

export const CLOUD_CONTROL_PLANE_USAGE_QUOTAS_MIGRATION_ID = '005_usage_quotas_rate_limits'

export const CLOUD_CONTROL_PLANE_USAGE_QUOTAS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_usage_events (
    event_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    account_id text REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    event_type text NOT NULL,
    quantity bigint NOT NULL,
    unit text NOT NULL,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_usage_events_org_created_idx
    ON cloud_usage_events (org_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_usage_counters (
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    quota_key text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    quantity bigint NOT NULL,
    PRIMARY KEY (org_id, quota_key)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_quota_locks (
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    quota_key text NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, quota_key)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_rate_limits (
    scope text NOT NULL,
    source text NOT NULL,
    window_started_at_ms bigint NOT NULL,
    count integer NOT NULL,
    PRIMARY KEY (scope, source)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_auth_failures (
    scope text PRIMARY KEY,
    source text NOT NULL,
    auth_window_started_at_ms bigint NOT NULL,
    auth_failure_count integer NOT NULL,
    blocked_until_ms bigint NOT NULL
  )`,
] as const

export const CLOUD_CONTROL_PLANE_BILLING_SUBSCRIPTIONS_MIGRATION_ID = '006_billing_subscriptions'

export const CLOUD_CONTROL_PLANE_BILLING_SUBSCRIPTIONS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_subscriptions (
    org_id text PRIMARY KEY REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    plan_key text NOT NULL,
    provider_id text NOT NULL,
    provider_customer_id text,
    provider_subscription_id text,
    status text NOT NULL,
    seats integer NOT NULL DEFAULT 1,
    entitlements jsonb NOT NULL,
    current_period_end timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_subscriptions_provider_customer_idx
    ON cloud_subscriptions (provider_id, provider_customer_id)
    WHERE provider_customer_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_subscriptions_provider_subscription_idx
    ON cloud_subscriptions (provider_id, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL`,
] as const

export const CLOUD_CONTROL_PLANE_SCALE_FOUNDATION_MIGRATION_ID = '007_scale_foundation'

export const CLOUD_CONTROL_PLANE_SCALE_FOUNDATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS cloud_sessions_user_cursor_idx
    ON cloud_sessions (tenant_id, user_id, updated_at DESC, session_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_sessions_user_status_cursor_idx
    ON cloud_sessions (tenant_id, user_id, status, updated_at DESC, session_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_sessions_user_profile_cursor_idx
    ON cloud_sessions (tenant_id, user_id, profile_name, updated_at DESC, session_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_session_commands_runnable_idx
    ON cloud_session_commands (status, target_lease_token, tenant_id, session_id, created_sequence)
    WHERE status IN ('pending', 'running')`,
  `CREATE INDEX IF NOT EXISTS cloud_worker_leases_expiry_idx
    ON cloud_worker_leases (tenant_id, session_id, lease_expires_at_ms)`,
] as const

export const CLOUD_CONTROL_PLANE_MANAGED_WORKERS_MIGRATION_ID = '008_managed_workers'

export const CLOUD_CONTROL_PLANE_MANAGED_WORKERS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_worker_pools (
    pool_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    tenant_id text REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    name text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    region text,
    capabilities jsonb NOT NULL,
    max_workers integer,
    max_concurrent_work integer,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_worker_pools_org_idx
    ON cloud_worker_pools (org_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_managed_workers (
    worker_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    tenant_id text REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    pool_id text NOT NULL REFERENCES cloud_worker_pools(pool_id) ON DELETE CASCADE,
    display_name text NOT NULL,
    status text NOT NULL,
    version text,
    capabilities jsonb NOT NULL,
    last_heartbeat_at timestamptz,
    last_error_code text,
    last_error_summary text,
    current_load integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revoked_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_managed_workers_org_pool_idx
    ON cloud_managed_workers (org_id, pool_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_managed_workers_org_status_idx
    ON cloud_managed_workers (org_id, status, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_worker_credentials (
    credential_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    worker_id text NOT NULL REFERENCES cloud_managed_workers(worker_id) ON DELETE CASCADE,
    pool_id text NOT NULL REFERENCES cloud_worker_pools(pool_id) ON DELETE CASCADE,
    token_hash text UNIQUE NOT NULL,
    scopes jsonb NOT NULL,
    last4 text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz,
    rotated_from_credential_id text REFERENCES cloud_worker_credentials(credential_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_worker_credentials_worker_idx
    ON cloud_worker_credentials (org_id, worker_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS cloud_managed_worker_heartbeats (
    worker_id text PRIMARY KEY REFERENCES cloud_managed_workers(worker_id) ON DELETE CASCADE,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    tenant_id text REFERENCES cloud_tenants(tenant_id) ON DELETE CASCADE,
    pool_id text NOT NULL REFERENCES cloud_worker_pools(pool_id) ON DELETE CASCADE,
    version text,
    capabilities jsonb NOT NULL,
    current_load integer NOT NULL,
    active_work_ids jsonb NOT NULL,
    last_error_code text,
    last_error_summary text,
    heartbeat_sequence bigint,
    received_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_managed_worker_heartbeats_org_idx
    ON cloud_managed_worker_heartbeats (org_id, received_at DESC)`,
] as const

export const CLOUD_CONTROL_PLANE_MANAGED_WORK_CLAIMS_MIGRATION_ID = '009_managed_work_claims'

export const CLOUD_CONTROL_PLANE_MANAGED_WORK_CLAIMS_STATEMENTS = [
  `ALTER TABLE cloud_session_commands
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_session_commands
    ADD COLUMN IF NOT EXISTS available_at timestamptz`,
  `ALTER TABLE cloud_session_commands
    ADD COLUMN IF NOT EXISTS last_error_code text`,
  `ALTER TABLE cloud_session_commands
    ADD COLUMN IF NOT EXISTS last_error_summary text`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS claimed_by text`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS claim_token text`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS idempotency_key text`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS checkpoint_version integer NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS last_error_code text`,
  `ALTER TABLE cloud_workflow_runs
    ADD COLUMN IF NOT EXISTS last_error_summary text`,
  `CREATE INDEX IF NOT EXISTS cloud_session_commands_available_idx
    ON cloud_session_commands (status, available_at, tenant_id, session_id, created_sequence)`,
  `CREATE INDEX IF NOT EXISTS cloud_workflow_runs_claim_idx
    ON cloud_workflow_runs (tenant_id, status, claim_expires_at)`,
] as const

export const CLOUD_CONTROL_PLANE_MANAGED_WORK_REAPER_INDEXES_MIGRATION_ID = '010_managed_work_reaper_indexes'

export const CLOUD_CONTROL_PLANE_MANAGED_WORK_REAPER_INDEXES_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_worker_leases_reaper_idx
    ON cloud_worker_leases (lease_expires_at_ms, tenant_id, session_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_workflow_runs_reaper_idx
    ON cloud_workflow_runs (claim_expires_at, tenant_id, workflow_id, run_id)
    WHERE claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND status IN ('queued', 'running')`,
] as const

export const CLOUD_CONTROL_PLANE_CHANNEL_PROVIDER_EVENTS_MIGRATION_ID = '011_channel_provider_events'

export const CLOUD_CONTROL_PLANE_CHANNEL_PROVIDER_EVENTS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_channel_provider_events (
    event_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    provider text NOT NULL,
    provider_instance_id text NOT NULL,
    external_workspace_id text,
    provider_event_id text NOT NULL,
    event_type text NOT NULL,
    status text NOT NULL,
    claimed_by text,
    claim_expires_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0,
    retryable boolean NOT NULL DEFAULT true,
    last_error text,
    metadata jsonb NOT NULL,
    processed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_channel_provider_events_dedupe_idx
    ON cloud_channel_provider_events (org_id, provider, provider_instance_id, COALESCE(external_workspace_id, ''), event_type, provider_event_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_provider_events_claim_idx
    ON cloud_channel_provider_events (org_id, status, retryable, claim_expires_at, updated_at)`,
] as const

export const CLOUD_CONTROL_PLANE_DELIVERY_OWNER_MIGRATION_ID = '012_channel_delivery_owner'

export const CLOUD_CONTROL_PLANE_DELIVERY_OWNER_STATEMENTS = [
  `ALTER TABLE cloud_channel_deliveries
    ADD COLUMN IF NOT EXISTS last_claimed_by text`,
  `CREATE INDEX IF NOT EXISTS cloud_channel_deliveries_owner_idx
    ON cloud_channel_deliveries (org_id, last_claimed_by, status, updated_at DESC)
    WHERE last_claimed_by IS NOT NULL`,
] as const

export const CLOUD_CONTROL_PLANE_API_TOKEN_CHANNEL_BINDINGS_MIGRATION_ID = '013_api_token_channel_binding_grants'

export const CLOUD_CONTROL_PLANE_API_TOKEN_CHANNEL_BINDINGS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_api_token_channel_binding_grants (
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    token_id text NOT NULL REFERENCES cloud_api_tokens(token_id) ON DELETE CASCADE,
    channel_binding_id text NOT NULL REFERENCES cloud_channel_bindings(binding_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, token_id, channel_binding_id)
  )`,
  `INSERT INTO cloud_api_token_channel_binding_grants (
    org_id, token_id, channel_binding_id, created_at
   )
   SELECT tokens.org_id, tokens.token_id, bindings.binding_id, now()
   FROM cloud_api_tokens tokens
   JOIN cloud_channel_bindings bindings ON bindings.org_id = tokens.org_id
   WHERE tokens.revoked_at IS NULL
     AND tokens.scopes @> '["gateway"]'::jsonb
     AND NOT EXISTS (
       SELECT 1
       FROM cloud_schema_migrations
       WHERE id = '${CLOUD_CONTROL_PLANE_API_TOKEN_CHANNEL_BINDINGS_MIGRATION_ID}'
     )
   ON CONFLICT (org_id, token_id, channel_binding_id) DO NOTHING`,
  `CREATE INDEX IF NOT EXISTS cloud_api_token_channel_binding_grants_token_idx
    ON cloud_api_token_channel_binding_grants (org_id, token_id, channel_binding_id)`,
  `CREATE INDEX IF NOT EXISTS cloud_api_token_channel_binding_grants_binding_idx
    ON cloud_api_token_channel_binding_grants (org_id, channel_binding_id, token_id)`,
] as const

export const CLOUD_CONTROL_PLANE_COORDINATION_WATCHES_MIGRATION_ID = '014_cloud_coordination_watches'

export const CLOUD_CONTROL_PLANE_COORDINATION_WATCHES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_coordination_watches (
    workspace_id text NOT NULL,
    watch_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    events jsonb NOT NULL,
    channel jsonb NOT NULL,
    recipient jsonb,
    status text NOT NULL,
    delivery_surface text NOT NULL,
    verbosity text NOT NULL,
    cursor jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, watch_id)
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_coordination_watches_workspace_idx
    ON cloud_coordination_watches (workspace_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_coordination_watches_target_idx
    ON cloud_coordination_watches (workspace_id, target_kind, target_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_coordination_watches_events_idx
    ON cloud_coordination_watches USING GIN (events jsonb_path_ops)`,
] as const

export const CLOUD_CONTROL_PLANE_WORKFLOW_STEPS_MIGRATION_ID = '015_cloud_workflow_steps'

export const CLOUD_CONTROL_PLANE_WORKFLOW_STEPS_STATEMENTS = [
  `ALTER TABLE cloud_workflows
    ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb`,
] as const

export const CLOUD_CONTROL_PLANE_KNOWLEDGE_MIGRATION_ID = '016_cloud_knowledge'

// Cloud-backed knowledge wiki. Mirrors the desktop SQLite schema
// (knowledge_spaces / knowledge_pages / knowledge_page_versions /
// knowledge_proposals) one-for-one, but every table is tenant-scoped by
// workspace_id: it is the leading column of every PRIMARY KEY and the leading
// column of every index, so a query that filters on workspace_id can never
// cross a tenant boundary. Timestamps and the *_json payloads are stored as
// text (ISO-8601 / serialized JSON), not timestamptz/jsonb, to preserve
// byte-identical content with the SQLite store — the values are
// produced/validated by the shared knowledge serializer, so the cloud and
// desktop revision hashes match and the shared row→domain mappers work
// unchanged against both backends.
export const CLOUD_CONTROL_PLANE_KNOWLEDGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_knowledge_spaces (
    workspace_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    icon text,
    hue text,
    visibility text NOT NULL,
    role text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (workspace_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_knowledge_pages (
    workspace_id text NOT NULL,
    id text NOT NULL,
    space_id text NOT NULL,
    title text NOT NULL,
    updated_by text NOT NULL,
    updated_at text NOT NULL,
    version integer NOT NULL,
    revision text NOT NULL,
    links_json text NOT NULL,
    body_json text NOT NULL,
    created_at text NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, space_id)
      REFERENCES cloud_knowledge_spaces (workspace_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_knowledge_page_versions (
    workspace_id text NOT NULL,
    id text NOT NULL,
    page_id text NOT NULL,
    space_id text NOT NULL,
    title text NOT NULL,
    updated_by text NOT NULL,
    updated_at text NOT NULL,
    version integer NOT NULL,
    revision text NOT NULL,
    proposal_id text,
    links_json text NOT NULL,
    body_json text NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, page_id)
      REFERENCES cloud_knowledge_pages (workspace_id, id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_knowledge_proposals (
    workspace_id text NOT NULL,
    id text NOT NULL,
    space_id text NOT NULL,
    page_id text,
    page_title text NOT NULL,
    by_name text NOT NULL,
    created_at text NOT NULL,
    summary text NOT NULL,
    add_count integer NOT NULL,
    del_count integer NOT NULL,
    status text NOT NULL,
    reviewed_at text,
    reviewed_by text,
    links_json text NOT NULL,
    body_json text NOT NULL,
    PRIMARY KEY (workspace_id, id),
    FOREIGN KEY (workspace_id, space_id)
      REFERENCES cloud_knowledge_spaces (workspace_id, id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_knowledge_spaces_workspace_idx
    ON cloud_knowledge_spaces (workspace_id, name)`,
  `CREATE INDEX IF NOT EXISTS cloud_knowledge_pages_workspace_idx
    ON cloud_knowledge_pages (workspace_id, space_id, title)`,
  `CREATE INDEX IF NOT EXISTS cloud_knowledge_page_versions_page_idx
    ON cloud_knowledge_page_versions (workspace_id, page_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS cloud_knowledge_proposals_workspace_idx
    ON cloud_knowledge_proposals (workspace_id, status, created_at)`,
] as const

// Maintained concurrency gauges. The per-org count of *active* rows for each
// concurrency quota (workflow runs, sessions, queued commands, worker leases) is
// kept in cloud_concurrency_counters by AFTER-row triggers, so the quota hot path
// reads an O(1) primary-key row instead of running a COUNT(*) on every
// enqueue/claim/create. The trigger fires for EVERY row change regardless of code
// path, so the gauge can't drift; a migration-time backfill seeds it from the
// current COUNT. (Built one gauge per migration — this one covers workflow runs.)
//
// KNOWN CEILING (#912): the counter is one row per (scope_id=org, counter_key), so all
// concurrent transactions that change an org's active count serialize on that row's lock
// until commit. The trigger already narrows this to genuine active-count transitions
// (`IF old_active = new_active THEN RETURN NULL`), so steady-state churn that doesn't cross
// the queued/running boundary never touches the row. It remains a per-ORG write-throughput
// ceiling (not cross-org, and each update is sub-millisecond). If a single very high-volume
// org approaches it, shard the row into (scope_id, counter_key, bucket) with the bucket
// chosen by hash(session_id/run_id) % N and SUM the buckets on read — the read stays O(N
// buckets). See docs/performance.md ("What's NOT optimized (yet)") for the threshold guidance.
export const CLOUD_CONTROL_PLANE_CONCURRENCY_COUNTERS_MIGRATION_ID = '017_cloud_concurrency_counters'
const CLOUD_CONTROL_PLANE_CONCURRENCY_COUNTERS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_concurrency_counters (
    scope_id text NOT NULL,
    counter_key text NOT NULL,
    value bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, counter_key)
  )`,
  `CREATE OR REPLACE FUNCTION cloud_workflow_run_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status IN ('queued', 'running') THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status IN ('queued', 'running') THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'concurrent_workflow_runs', GREATEST(0, new_active - old_active), now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = GREATEST(0, cloud_concurrency_counters.value + (new_active - old_active)), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS cloud_workflow_runs_concurrency_counter ON cloud_workflow_runs`,
  `CREATE TRIGGER cloud_workflow_runs_concurrency_counter
    AFTER INSERT OR UPDATE OR DELETE ON cloud_workflow_runs
    FOR EACH ROW EXECUTE FUNCTION cloud_workflow_run_concurrency_counter()`,
  `INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value)
    SELECT COALESCE(orgs.org_id, runs.tenant_id), 'concurrent_workflow_runs', count(*)
    FROM cloud_workflow_runs runs
    LEFT JOIN cloud_orgs orgs ON orgs.tenant_id = runs.tenant_id
    WHERE runs.status IN ('queued', 'running')
    GROUP BY COALESCE(orgs.org_id, runs.tenant_id)
    ON CONFLICT (scope_id, counter_key) DO UPDATE SET value = EXCLUDED.value`,
] as const

// Concurrent-sessions gauge (active = status <> 'closed'), same drift-free
// trigger pattern as workflow runs.
export const CLOUD_CONTROL_PLANE_CONCURRENCY_SESSIONS_MIGRATION_ID = '018_concurrency_counter_sessions'
const CLOUD_CONTROL_PLANE_CONCURRENCY_SESSIONS_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION cloud_session_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status <> 'closed' THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status <> 'closed' THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'concurrent_sessions', GREATEST(0, new_active - old_active), now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = GREATEST(0, cloud_concurrency_counters.value + (new_active - old_active)), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS cloud_sessions_concurrency_counter ON cloud_sessions`,
  `CREATE TRIGGER cloud_sessions_concurrency_counter
    AFTER INSERT OR UPDATE OR DELETE ON cloud_sessions
    FOR EACH ROW EXECUTE FUNCTION cloud_session_concurrency_counter()`,
  `INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value)
    SELECT COALESCE(orgs.org_id, sessions.tenant_id), 'concurrent_sessions', count(*)
    FROM cloud_sessions sessions
    LEFT JOIN cloud_orgs orgs ON orgs.tenant_id = sessions.tenant_id
    WHERE sessions.status <> 'closed'
    GROUP BY COALESCE(orgs.org_id, sessions.tenant_id)
    ON CONFLICT (scope_id, counter_key) DO UPDATE SET value = EXCLUDED.value`,
] as const

// Queued-commands gauge (active = status IN ('pending','running')), same
// drift-free trigger pattern. The queue-AGE limit still needs min(created_at),
// so the quota keeps a bounded age scan only when that limit is configured.
export const CLOUD_CONTROL_PLANE_CONCURRENCY_COMMANDS_MIGRATION_ID = '019_concurrency_counter_commands'
const CLOUD_CONTROL_PLANE_CONCURRENCY_COMMANDS_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION cloud_command_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status IN ('pending', 'running') THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status IN ('pending', 'running') THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'queued_commands', GREATEST(0, new_active - old_active), now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = GREATEST(0, cloud_concurrency_counters.value + (new_active - old_active)), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS cloud_session_commands_concurrency_counter ON cloud_session_commands`,
  `CREATE TRIGGER cloud_session_commands_concurrency_counter
    AFTER INSERT OR UPDATE OR DELETE ON cloud_session_commands
    FOR EACH ROW EXECUTE FUNCTION cloud_command_concurrency_counter()`,
  `INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value)
    SELECT COALESCE(orgs.org_id, commands.tenant_id), 'queued_commands', count(*)
    FROM cloud_session_commands commands
    LEFT JOIN cloud_orgs orgs ON orgs.tenant_id = commands.tenant_id
    WHERE commands.status IN ('pending', 'running')
    GROUP BY COALESCE(orgs.org_id, commands.tenant_id)
    ON CONFLICT (scope_id, counter_key) DO UPDATE SET value = EXCLUDED.value`,
] as const

// Concurrency-gauge correctness (P2-7). The original triggers clamped the in-place write with
// GREATEST(0, value + delta), which permanently LOST any decrement that momentarily took the value
// below zero — so a later increment built on the wrongly-elevated floor and the gauge drifted high
// forever, falsely rejecting legitimate work. The fix keeps the counter as a true running delta-sum
// (allowed to sit transiently negative) and clamps GREATEST(0, value) on READ instead; combined
// with the always-firing AFTER-row trigger this is drift-free for all post-migration activity. The
// `reconcile` statements recompute every counter from its source table (resetting idle scopes to 0)
// to wipe drift accumulated under the old clamp on deploy, and are reused by the periodic reconcile.
//
// COST (#924): each statement is a full, status-filtered GROUP BY scan of its source table — no
// index serves it. That is cheap at deploy time (one-off) but EXPENSIVE if the optional periodic
// reconcile (concurrencyReconcileMs) is enabled on a large deployment, where it re-scans all of
// cloud_sessions / cloud_session_commands / cloud_workflow_runs on every tick. It is off by default
// because the clamp-on-read trigger already keeps the gauges drift-free; only enable it as a
// belt-and-braces safety net, and if a deployment is large enough for the scan to matter, bound it
// (per-org batching) rather than running the global aggregate.
function concurrencyReconcileStatements(counterKey: string, sourceTable: string, activeWhere: string) {
  // counterKey/sourceTable/activeWhere are fixed literals below — never request input.
  return [
    `INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
      SELECT COALESCE(o.org_id, s.tenant_id), '${counterKey}', count(*), now()
      FROM ${sourceTable} s LEFT JOIN cloud_orgs o ON o.tenant_id = s.tenant_id
      WHERE ${activeWhere}
      GROUP BY COALESCE(o.org_id, s.tenant_id)
      ON CONFLICT (scope_id, counter_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      RETURNING scope_id`,
    `UPDATE cloud_concurrency_counters SET value = 0, updated_at = now()
      WHERE counter_key = '${counterKey}'
        AND scope_id NOT IN (
          SELECT COALESCE(o.org_id, s.tenant_id)
          FROM ${sourceTable} s LEFT JOIN cloud_orgs o ON o.tenant_id = s.tenant_id
          WHERE ${activeWhere}
        )
      RETURNING scope_id`,
  ] as const
}

// Reused by migration 024's one-time correction AND the scheduler's periodic reconcile job.
export const CLOUD_CONTROL_PLANE_CONCURRENCY_RECONCILE_STATEMENTS = [
  ...concurrencyReconcileStatements('concurrent_workflow_runs', 'cloud_workflow_runs', `s.status IN ('queued', 'running')`),
  ...concurrencyReconcileStatements('concurrent_sessions', 'cloud_sessions', `s.status <> 'closed'`),
  ...concurrencyReconcileStatements('queued_commands', 'cloud_session_commands', `s.status IN ('pending', 'running')`),
] as const

export const CLOUD_CONTROL_PLANE_CONCURRENCY_CLAMP_ON_READ_MIGRATION_ID = '024_concurrency_counter_clamp_on_read'
const CLOUD_CONTROL_PLANE_CONCURRENCY_CLAMP_ON_READ_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION cloud_workflow_run_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status IN ('queued', 'running') THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status IN ('queued', 'running') THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'concurrent_workflow_runs', new_active - old_active, now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = cloud_concurrency_counters.value + (new_active - old_active), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION cloud_session_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status <> 'closed' THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status <> 'closed' THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'concurrent_sessions', new_active - old_active, now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = cloud_concurrency_counters.value + (new_active - old_active), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION cloud_command_concurrency_counter() RETURNS trigger AS $func$
    DECLARE
      old_active int := 0;
      new_active int := 0;
      tid text;
      scope text;
    BEGIN
      IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.status IN ('pending', 'running') THEN old_active := 1; END IF;
      IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.status IN ('pending', 'running') THEN new_active := 1; END IF;
      IF old_active = new_active THEN RETURN NULL; END IF;
      tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
      scope := COALESCE((SELECT org_id FROM cloud_orgs WHERE tenant_id = tid LIMIT 1), tid);
      INSERT INTO cloud_concurrency_counters (scope_id, counter_key, value, updated_at)
        VALUES (scope, 'queued_commands', new_active - old_active, now())
        ON CONFLICT (scope_id, counter_key) DO UPDATE
          SET value = cloud_concurrency_counters.value + (new_active - old_active), updated_at = now();
      RETURN NULL;
    END;
    $func$ LANGUAGE plpgsql`,
  ...CLOUD_CONTROL_PLANE_CONCURRENCY_RECONCILE_STATEMENTS,
] as const

// findSession resolves a session globally by either id (session_id OR
// opencode_session_id), so the (tenant_id, session_id) primary key and the
// per-user indexes can't serve it — it was a full cross-tenant scan of
// cloud_sessions. Index both lookup columns so the OR-query can BitmapOr two
// index seeks instead. Built CONCURRENTLY (non-transactional) so adding them to
// a populated table never holds a write lock.
export const CLOUD_CONTROL_PLANE_SESSION_LOOKUP_INDEXES_MIGRATION_ID = '020_session_lookup_indexes'
const CLOUD_CONTROL_PLANE_SESSION_LOOKUP_INDEXES_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_sessions_session_id_idx
    ON cloud_sessions (session_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_sessions_opencode_session_idx
    ON cloud_sessions (opencode_session_id)`,
] as const

// Scheduled / hot-path queries that were full-scanning or top-N-sorting unindexed
// columns: the scheduler's due-workflow probe (claim_token IS NULL — the opposite of the
// existing partial reaper index), the channel retention sweeps (status/expires_at), the
// per-webhook replay-cache trim (seen_at_ms), and account→orgs principal resolution
// (account_id, not the PK lead). Built CONCURRENTLY so they never lock a populated table.
export const CLOUD_CONTROL_PLANE_PERFORMANCE_INDEXES_MIGRATION_ID = '021_performance_indexes'
const CLOUD_CONTROL_PLANE_PERFORMANCE_INDEXES_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_workflow_runs_due_idx
    ON cloud_workflow_runs (created_at, run_id)
    WHERE claim_token IS NULL AND status IN ('queued', 'running')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_channel_deliveries_retention_idx
    ON cloud_channel_deliveries (updated_at)
    WHERE status IN ('sent', 'dead')`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_channel_interactions_expiry_idx
    ON cloud_channel_interactions (expires_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_webhook_replay_claims_seen_idx
    ON cloud_webhook_replay_claims (seen_at_ms)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_memberships_account_idx
    ON cloud_memberships (account_id, updated_at DESC)`,
] as const

// Age-leading indexes for the opt-in event-retention sweep (P1-C3). The existing event indexes all
// lead with tenant/org, so a global "created_at < cutoff" bounded delete would seq-scan; these let
// the retention prune find the oldest rows cheaply without disturbing the read-path indexes.
export const CLOUD_CONTROL_PLANE_EVENT_RETENTION_INDEXES_MIGRATION_ID = '022_event_retention_indexes'
const CLOUD_CONTROL_PLANE_EVENT_RETENTION_INDEXES_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_session_events_created_idx
    ON cloud_session_events (created_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_audit_events_created_idx
    ON cloud_audit_events (created_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_usage_events_created_idx
    ON cloud_usage_events (created_at)`,
] as const

// P1-B: created_at index so the cloud_workspace_events retention prune (the twin of the P1-C3
// session-event prune, previously missed) doesn't seq-scan. P2: a partial (org_id, expires_at)
// index so the channel-interaction token lookup's pending scan is bounded to one org's pending set.
export const CLOUD_CONTROL_PLANE_WORKSPACE_EVENT_RETENTION_MIGRATION_ID = '025_workspace_event_retention_and_interaction_index'
const CLOUD_CONTROL_PLANE_WORKSPACE_EVENT_RETENTION_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_workspace_events_created_idx
    ON cloud_workspace_events (created_at)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_channel_interactions_pending_idx
    ON cloud_channel_interactions (org_id, expires_at) WHERE status = 'pending'`,
] as const

// Org custom roles (named permission maps) + the membership pointer that assigns
// one to a member. Built-in roles keep working: custom_role_key is nullable and
// only overrides the effective permission set when set. RBAC foundation (#894).
export const CLOUD_CONTROL_PLANE_ORG_CUSTOM_ROLES_MIGRATION_ID = '026_org_custom_roles'
const CLOUD_CONTROL_PLANE_ORG_CUSTOM_ROLES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_custom_roles (
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    role_key text NOT NULL,
    name text NOT NULL,
    description text,
    base_role text NOT NULL,
    permissions jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (org_id, role_key)
  )`,
  `ALTER TABLE cloud_memberships ADD COLUMN IF NOT EXISTS custom_role_key text`,
] as const

// Org-managed workspace & desktop policy (#898): one policy record per org that clamps
// permission maxima, allow/deny-lists providers/models, gates extension classes, pins
// the update channel, and sets the key-management requirement. Nullable allow-lists are
// SQL NULL (unrestricted); deny-lists default to an empty jsonb array.
export const CLOUD_CONTROL_PLANE_MANAGED_POLICIES_MIGRATION_ID = '027_managed_policies'
const CLOUD_CONTROL_PLANE_MANAGED_POLICIES_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_managed_policies (
    org_id text PRIMARY KEY REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    allowed_providers jsonb,
    denied_providers jsonb NOT NULL DEFAULT '[]'::jsonb,
    allowed_models jsonb,
    denied_models jsonb NOT NULL DEFAULT '[]'::jsonb,
    key_management text NOT NULL DEFAULT 'any',
    extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
    features jsonb NOT NULL DEFAULT '{}'::jsonb,
    permission_ceilings jsonb NOT NULL DEFAULT '{}'::jsonb,
    update_channel text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
] as const

// Enterprise identity (#895): the per-org SSO configuration record (SAML 2.0 + OIDC,
// domain verification, SSO-only enforcement toggle, SCIM enablement) and the durable
// SCIM sync-event queue with retry/backoff. IdP secrets (SAML cert, OIDC client secret)
// and the SCIM bearer token are stored ONLY as `enc:vN:` envelope ciphertext / salted
// hash — never plaintext (the *_ciphertext / *_hash columns).
export const CLOUD_CONTROL_PLANE_SSO_SCIM_MIGRATION_ID = '028_org_sso_scim'
const CLOUD_CONTROL_PLANE_SSO_SCIM_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cloud_org_sso_configs (
    org_id text PRIMARY KEY REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    protocol text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    enforced boolean NOT NULL DEFAULT false,
    display_name text,
    verified_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
    domain_verification_token text NOT NULL,
    oidc_issuer text,
    oidc_client_id text,
    oidc_client_secret_ciphertext text,
    saml_entity_id text,
    saml_acs_url text,
    saml_slo_url text,
    saml_idp_entity_id text,
    saml_idp_sso_url text,
    saml_idp_metadata_url text,
    saml_idp_certificate_ciphertext text,
    scim_enabled boolean NOT NULL DEFAULT false,
    scim_token_hash text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_scim_sync_events (
    event_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES cloud_orgs(org_id) ON DELETE CASCADE,
    operation text NOT NULL,
    external_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 8,
    next_attempt_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS cloud_scim_sync_events_due_idx
     ON cloud_scim_sync_events (status, next_attempt_at)`,
] as const

// Serves the scheduler's projection-lag gauge, which previously full-scanned cloud_sessions +
// LEFT JOINed projections on every emission. A partial index on updated_at over only the sessions
// that carry events lets the bounded (recent-window) lag query touch just the active tail (#911).
export const CLOUD_CONTROL_PLANE_PROJECTION_LAG_INDEX_MIGRATION_ID = '029_projection_lag_index'
const CLOUD_CONTROL_PLANE_PROJECTION_LAG_INDEX_STATEMENTS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS cloud_sessions_projection_lag_idx
    ON cloud_sessions (updated_at)
    WHERE next_event_sequence > 0`,
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
  {
    id: CLOUD_CONTROL_PLANE_USAGE_QUOTAS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_USAGE_QUOTAS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_BILLING_SUBSCRIPTIONS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_BILLING_SUBSCRIPTIONS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_SCALE_FOUNDATION_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_SCALE_FOUNDATION_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_MANAGED_WORKERS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_MANAGED_WORKERS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_MANAGED_WORK_CLAIMS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_MANAGED_WORK_CLAIMS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_MANAGED_WORK_REAPER_INDEXES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_MANAGED_WORK_REAPER_INDEXES_STATEMENTS,
    concurrentIndexes: ['cloud_worker_leases_reaper_idx', 'cloud_workflow_runs_reaper_idx'],
    transactional: false,
  },
  {
    id: CLOUD_CONTROL_PLANE_CHANNEL_PROVIDER_EVENTS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_CHANNEL_PROVIDER_EVENTS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_DELIVERY_OWNER_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_DELIVERY_OWNER_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_API_TOKEN_CHANNEL_BINDINGS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_API_TOKEN_CHANNEL_BINDINGS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_COORDINATION_WATCHES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_COORDINATION_WATCHES_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_WORKFLOW_STEPS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_WORKFLOW_STEPS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_KNOWLEDGE_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_KNOWLEDGE_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_CONCURRENCY_COUNTERS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_CONCURRENCY_COUNTERS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_CONCURRENCY_SESSIONS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_CONCURRENCY_SESSIONS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_CONCURRENCY_COMMANDS_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_CONCURRENCY_COMMANDS_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_SESSION_LOOKUP_INDEXES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_SESSION_LOOKUP_INDEXES_STATEMENTS,
    concurrentIndexes: ['cloud_sessions_session_id_idx', 'cloud_sessions_opencode_session_idx'],
    transactional: false,
  },
  {
    id: CLOUD_CONTROL_PLANE_PERFORMANCE_INDEXES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_PERFORMANCE_INDEXES_STATEMENTS,
    concurrentIndexes: [
      'cloud_workflow_runs_due_idx',
      'cloud_channel_deliveries_retention_idx',
      'cloud_channel_interactions_expiry_idx',
      'cloud_webhook_replay_claims_seen_idx',
      'cloud_memberships_account_idx',
    ],
    transactional: false,
  },
  {
    id: CLOUD_CONTROL_PLANE_EVENT_RETENTION_INDEXES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_EVENT_RETENTION_INDEXES_STATEMENTS,
    concurrentIndexes: [
      'cloud_session_events_created_idx',
      'cloud_audit_events_created_idx',
      'cloud_usage_events_created_idx',
    ],
    transactional: false,
  },
  {
    id: CLOUD_CONTROL_PLANE_CONCURRENCY_CLAMP_ON_READ_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_CONCURRENCY_CLAMP_ON_READ_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_WORKSPACE_EVENT_RETENTION_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_WORKSPACE_EVENT_RETENTION_STATEMENTS,
    concurrentIndexes: ['cloud_workspace_events_created_idx', 'cloud_channel_interactions_pending_idx'],
    transactional: false,
  },
  {
    id: CLOUD_CONTROL_PLANE_ORG_CUSTOM_ROLES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_ORG_CUSTOM_ROLES_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_MANAGED_POLICIES_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_MANAGED_POLICIES_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_SSO_SCIM_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_SSO_SCIM_STATEMENTS,
  },
  {
    id: CLOUD_CONTROL_PLANE_PROJECTION_LAG_INDEX_MIGRATION_ID,
    statements: CLOUD_CONTROL_PLANE_PROJECTION_LAG_INDEX_STATEMENTS,
    concurrentIndexes: ['cloud_sessions_projection_lag_idx'],
    transactional: false,
  },
] as const
