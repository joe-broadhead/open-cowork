import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const cloudRoot = join(root, 'packages/cloud-server/src')
const cloudClientRoot = join(root, 'packages/cloud-client/src')
const architectureDoc = readFileSync(join(root, 'docs/architecture.md'), 'utf8')
const downstreamDoc = readFileSync(join(root, 'docs/downstream.md'), 'utf8')
const dockerIgnore = readFileSync(join(root, '.dockerignore'), 'utf8')
const postgresSchema = readFileSync(join(cloudRoot, 'postgres-schema.ts'), 'utf8')
const postgresMigrations = readFileSync(join(cloudRoot, 'postgres-migrations.ts'), 'utf8')
const postgresStore = readFileSync(join(cloudRoot, 'postgres-control-plane-store.ts'), 'utf8')
const postgresChannelDeliveriesDomain = readFileSync(join(cloudRoot, 'postgres-store-domains/channel-deliveries.ts'), 'utf8')
const postgresQuotaDomain = readFileSync(join(cloudRoot, 'postgres-store-domains/quotas.ts'), 'utf8')
const postgresWorkflowsDomain = readFileSync(join(cloudRoot, 'postgres-store-domains/workflows.ts'), 'utf8')
const postgresSessionsDomain = readFileSync(join(cloudRoot, 'postgres-store-domains/sessions.ts'), 'utf8')
const performanceDoc = readFileSync(join(root, 'docs/performance.md'), 'utf8')

const lineThreshold = 2_000
// Budgets are ratcheted to just above the current size so a decomposed file cannot
// silently re-grow (previously they sat 600-2,000+ lines above actuals). Lower these
// (never raise) whenever a file shrinks further.
const documentedLargeFileBudgets = new Map([
  ['packages/cloud-server/src/http-server.ts', 1_800],
  ['packages/cloud-server/src/in-memory-control-plane-store.ts', 1_750],
  // session-service is a thin facade: ~156 of its ~168 methods are one-line delegators to the
  // ~30 cohesive sub-services it composes (byok/member/role/policy/sso/scim/channel/…). The real
  // decomposition already lives at the service layer; this budget is ratcheted to just above the
  // current size so the facade can't grow — new capabilities must go into a sub-service (and,
  // over time, routes should depend on those sub-services directly). See docs/architecture.md (#914).
  ['packages/cloud-server/src/session-service.ts', 2_030],
])

test('cloud core has enforceable domain module boundaries', () => {
  const expectedStoreDomains = [
    'identity.ts',
    'billing.ts',
    'byok.ts',
    'channels.ts',
    'sessions.ts',
    'settings.ts',
    'workers.ts',
    'workflows.ts',
    'thread-index.ts',
    'schema.ts',
  ]
  for (const file of expectedStoreDomains) {
    assert.equal(existsSync(join(cloudRoot, 'control-plane-domains', file)), true, `${file} domain store contract is missing`)
  }

  const expectedPostgresDomains = [
    'billing.ts',
    'byok.ts',
    'channels.ts',
    'identity.ts',
    'schema.ts',
    'sessions.ts',
    'shared.ts',
    'thread-index.ts',
    'webhooks.ts',
    'workers.ts',
    'workflows.ts',
  ]
  for (const file of expectedPostgresDomains) {
    assert.equal(existsSync(join(cloudRoot, 'postgres-domains', file)), true, `${file} Postgres domain mapper is missing`)
  }

  const expectedRoutes = [
    'access-policy.ts',
    'admin.ts',
    'artifacts.ts',
    'api-tokens.ts',
    'billing.ts',
    'byok.ts',
    'capabilities.ts',
    'channels.ts',
    'project-sources.ts',
    'settings.ts',
    'threads.ts',
    'workspace.ts',
  ]
  for (const file of expectedRoutes) {
    assert.equal(existsSync(join(cloudRoot, 'http-routes', file)), true, `${file} route module is missing`)
  }

  const expectedServices = [
    'identity-service.ts',
    'byok-service.ts',
    'billing-service.ts',
    'quota-service.ts',
    'channel-service.ts',
    'workflow-service.ts',
    'projection-service.ts',
    'managed-worker-service.ts',
    'session-command-service.ts',
    'usage-governance-service.ts',
  ]
  for (const file of expectedServices) {
    assert.equal(existsSync(join(cloudRoot, 'services', file)), true, `${file} domain service is missing`)
  }
})

test('cloud client exposes a thin public barrel and domain barrels', () => {
  const indexSource = readFileSync(join(cloudClientRoot, 'index.ts'), 'utf8')
  assert.doesNotMatch(indexSource, /function createHttpSseCloudTransportAdapter/)
  assert.match(indexSource, /export \* from '\.\/adapter\.js'/)

  const expectedClientDomains = [
    'artifacts.ts',
    'billing.ts',
    'byok.ts',
    'capabilities.ts',
    'channels.ts',
    'config.ts',
    'identity.ts',
    'sessions.ts',
    'settings.ts',
    'threads.ts',
    'transport.ts',
    'workflows.ts',
  ]
  for (const file of expectedClientDomains) {
    assert.equal(existsSync(join(cloudClientRoot, 'domains', file)), true, `${file} cloud-client domain barrel is missing`)
  }
})

test('large cloud source files are documented exceptions', () => {
  const sourceRoots = [cloudRoot, cloudClientRoot]
  for (const sourceRoot of sourceRoots) {
    for (const file of sourceFiles(sourceRoot)) {
      const relativePath = relative(root, file)
      const lineCount = readFileSync(file, 'utf8').split('\n').length
      if (lineCount <= lineThreshold) continue
      const budget = documentedLargeFileBudgets.get(relativePath)
      assert.equal(
        typeof budget,
        'number',
        `${relativePath} has ${lineCount} lines and needs a documented modularity budget or further splitting`,
      )
      assert.ok(
        lineCount <= budget!,
        `${relativePath} has ${lineCount} lines and exceeds its modularity budget of ${budget}`,
      )
      assert.match(
        architectureDoc,
        new RegExp(relativePath.split('/').at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${relativePath} is a large-file exception but is not documented in docs/architecture.md`,
      )
    }
  }
})

test('gateway token delivery-owner paths require explicit current grants and owners', () => {
  assert.match(
    postgresChannelDeliveriesDomain,
    /last_claimed_by = COALESCE\(\$8, last_claimed_by\)/,
    'delivery ACKs must preserve the current owner or set an explicit current owner',
  )
  assert.doesNotMatch(
    postgresSchema,
    /INSERT INTO cloud_api_token_channel_binding_grants[\s\S]+tokens\.scopes @> '\["gateway"\]'::jsonb/,
    'gateway API token grant migration must not backfill from broad legacy gateway scopes',
  )
  assert.doesNotMatch(
    postgresChannelDeliveriesDomain,
    /last_claimed_by IS NULL AND \$7::text IS NOT NULL AND claimed_by = \$7/,
    'delivery ACKs must not accept legacy ownerless claims when a token owner is required',
  )
})

test('cloud route, service, and client modules stay within ownership budgets', () => {
  assertSourceBudget('cloud HTTP route module', join(cloudRoot, 'http-routes'), 500)
  assertSourceBudget('cloud service module', join(cloudRoot, 'services'), 450)
  assertSourceBudget('cloud-client domain barrel', join(cloudClientRoot, 'domains'), 120)
  assertSourceBudget('gateway production source module', join(root, 'apps/gateway/src'), 900)
})

test('postgres store delegates row mapping to domain modules', () => {
  const source = readFileSync(join(cloudRoot, 'postgres-control-plane-store.ts'), 'utf8')
  assert.doesNotMatch(source, /function \w+FromRow\(/, 'Postgres row mappers belong in postgres-domains/*')
  assert.match(source, /postgres-domains\/identity\.ts/)
  assert.match(source, /postgres-domains\/sessions\.ts/)
  assert.match(source, /postgres-domains\/channels\.ts/)
  assert.match(source, /postgres-store-domains\/workers\.ts/)
  assert.match(source, /postgres-store-domains\/workflows\.ts/)
  // The workflow row mappers now live in the extracted workflows repository.
  assert.match(postgresWorkflowsDomain, /postgres-domains\/workflows\.ts/)

  for (const file of sourceFiles(join(cloudRoot, 'postgres-domains'))) {
    const relativePath = relative(root, file)
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lineCount <= 250, `${relativePath} has ${lineCount} lines; Postgres domain mappers should stay narrow`)
  }
  // The sessions repository owns the remaining session core (session/event/projection/lease/
  // command lifecycle) after artifact/launchpad indexes and workspace-event streams were split
  // into dedicated repositories. The workflows repository owns workflow definitions plus run
  // scheduling/claim/finalization. These are the cohesive domains that legitimately exceed the
  // narrow per-file budget; ratcheted to just above their post-split sizes so they can't silently
  // re-grow. Every other domain module stays under 700.
  assertSourceBudget('Postgres store domain module', join(cloudRoot, 'postgres-store-domains'), 700, {
    'packages/cloud-server/src/postgres-store-domains/sessions.ts': 1_190,
    'packages/cloud-server/src/postgres-store-domains/workflows.ts': 790,
  })
})

test('control plane store contract barrel does not export concrete stores', () => {
  const source = readFileSync(join(cloudRoot, 'control-plane-store.ts'), 'utf8')
  assert.doesNotMatch(source, /export \* from '\.\/in-memory-control-plane-store\.ts'/)
  assert.doesNotMatch(source, /InMemoryControlPlaneStore/)
  assert.match(source, /export type \* from '\.\/in-memory-control-plane-store\.ts'/)
})

test('session service delegates command payload parsing to command service module', () => {
  const source = readFileSync(join(cloudRoot, 'session-service.ts'), 'utf8')
  assert.doesNotMatch(source, /function normalize(Prompt|QuestionReply|QuestionReject|Permission)Payload\(/)
  assert.match(source, /services\/session-command-service\.ts/)
})

test('session service delegates workflow-draft validation to the workflow-validation module', () => {
  const source = readFileSync(join(cloudRoot, 'session-service.ts'), 'utf8')
  const workflowOps = readFileSync(join(cloudRoot, 'session-workflow-operations.ts'), 'utf8')
  // The draft normalizers/validators were carved out of the god class, and workflow
  // orchestration itself now lives in session-workflow-operations.ts; the draft
  // validators must not re-grow as private methods on either CloudSessionService or its
  // workflow collaborator (ARCH god-class carve).
  assert.doesNotMatch(source, /private (normalizeWorkflowDraft|normalizeWorkflowTriggers|assertWorkflowDraftAllowed)\(/)
  assert.doesNotMatch(workflowOps, /private (normalizeWorkflowDraft|normalizeWorkflowTriggers|assertWorkflowDraftAllowed)\(/)
  assert.match(workflowOps, /session-workflow-validation\.ts/)
})

test('cloud route and service modules stay behind store and runtime boundaries', () => {
  const checkedRoots = [
    join(cloudRoot, 'http-routes'),
    join(cloudRoot, 'services'),
  ]
  for (const checkedRoot of checkedRoots) {
    for (const file of sourceFiles(checkedRoot)) {
      const relativePath = relative(root, file)
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /postgres-control-plane-store/, `${relativePath} must not import concrete Postgres stores`)
      assert.doesNotMatch(source, /@opencode-ai\/sdk/, `${relativePath} must not import OpenCode runtime surfaces`)
    }
  }
})

test('client surfaces do not import server-only cloud internals', () => {
  const checkedRoots = [
    'packages/app/src',
    'apps/gateway/src',
    'packages/cloud-client/src',
  ]
  const forbidden = [
    /apps\/desktop\/src\/main\/cloud/,
    /\.\.\/.*main\/cloud/,
    /cloud\/postgres-/,
    /postgres-control-plane-store/,
    /control-plane-store/,
    /session-service/,
    /secret-adapter/,
    /runtime-adapter/,
    /@opencode-ai\/sdk/,
  ]

  for (const checkedRoot of checkedRoots) {
    for (const file of productionSourceFiles(join(root, checkedRoot))) {
      const relativePath = relative(root, file)
      const source = readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        assert.doesNotMatch(source, pattern, `${relativePath} must not import server-only cloud internals matching ${pattern}`)
      }
    }
  }
})

test('high-volume cloud tables keep indexed and bounded query shapes', () => {
  assertIndexShape('cloud_sessions_user_cursor_idx', 'cloud_sessions', 'tenant_id, user_id, updated_at DESC, session_id')
  assertIndexShape('cloud_sessions_user_status_cursor_idx', 'cloud_sessions', 'tenant_id, user_id, status, updated_at DESC, session_id')
  assertIndexShape('cloud_sessions_user_profile_cursor_idx', 'cloud_sessions', 'tenant_id, user_id, profile_name, updated_at DESC, session_id')
  assertIndexShape('cloud_sessions_session_id_idx', 'cloud_sessions', 'session_id')
  assertIndexShape('cloud_sessions_opencode_session_idx', 'cloud_sessions', 'opencode_session_id')
  assert.match(postgresSchema, /CLOUD_CONTROL_PLANE_SESSION_LOOKUP_INDEXES_MIGRATION_ID[\s\S]*transactional: false/)
  assertIndexShape('cloud_workflow_runs_due_idx', 'cloud_workflow_runs', 'created_at, run_id', "WHERE claim_token IS NULL AND status IN ('queued', 'running')")
  assertIndexShape('cloud_channel_deliveries_retention_idx', 'cloud_channel_deliveries', 'updated_at', "WHERE status IN ('sent', 'dead')")
  assertIndexShape('cloud_channel_interactions_expiry_idx', 'cloud_channel_interactions', 'expires_at')
  assertIndexShape('cloud_webhook_replay_claims_seen_idx', 'cloud_webhook_replay_claims', 'seen_at_ms')
  assertIndexShape('cloud_memberships_account_idx', 'cloud_memberships', 'account_id, updated_at DESC')
  assert.match(postgresSchema, /CLOUD_CONTROL_PLANE_PERFORMANCE_INDEXES_MIGRATION_ID[\s\S]*transactional: false/)
  assertIndexShape('cloud_session_events_sequence_idx', 'cloud_session_events', 'tenant_id, session_id, sequence')
  assertIndexShape('cloud_workspace_events_sequence_idx', 'cloud_workspace_events', 'tenant_id, user_id, sequence')
  assertIndexShape('cloud_session_commands_available_idx', 'cloud_session_commands', 'status, available_at, tenant_id, session_id, created_sequence')
  assertIndexShape('cloud_session_commands_runnable_idx', 'cloud_session_commands', 'status, target_lease_token, tenant_id, session_id, created_sequence', "WHERE status IN ('pending', 'running')")
  assertIndexShape('cloud_worker_leases_expiry_idx', 'cloud_worker_leases', 'tenant_id, session_id, lease_expires_at_ms')
  assertIndexShape('cloud_worker_leases_reaper_idx', 'cloud_worker_leases', 'lease_expires_at_ms, tenant_id, session_id')
  assertIndexShape('cloud_workflow_runs_claim_idx', 'cloud_workflow_runs', 'tenant_id, status, claim_expires_at')
  assertIndexShape('cloud_workflow_runs_reaper_idx', 'cloud_workflow_runs', 'claim_expires_at, tenant_id, workflow_id, run_id', "WHERE claim_token IS NOT NULL")
  assert.match(postgresSchema, /cloud_workflow_runs_reaper_idx[\s\S]*AND claim_expires_at IS NOT NULL[\s\S]*AND status IN \('queued', 'running'\)/)
  assert.match(postgresSchema, /CLOUD_CONTROL_PLANE_MANAGED_WORK_REAPER_INDEXES_MIGRATION_ID[\s\S]*transactional: false/)
  assert.match(postgresMigrations, /SELECT pg_try_advisory_lock\(\$1, \$2\) AS locked/)
  assert.doesNotMatch(postgresMigrations, /SELECT pg_advisory_lock\(\$1, \$2\)/)
  assertIndexShape('cloud_channel_deliveries_claim_idx', 'cloud_channel_deliveries', 'org_id, status, next_attempt_at, created_at')
  assertIndexShape('cloud_usage_events_org_created_idx', 'cloud_usage_events', 'org_id, created_at DESC')
  assertIndexShape('cloud_worker_pools_org_idx', 'cloud_worker_pools', 'org_id, updated_at DESC')
  assertIndexShape('cloud_managed_workers_org_status_idx', 'cloud_managed_workers', 'org_id, status, updated_at DESC')
  assertIndexShape('cloud_managed_worker_heartbeats_org_idx', 'cloud_managed_worker_heartbeats', 'org_id, received_at DESC')

  // The session core (session/event/projection/lease/command SQL) now lives in the extracted
  // sessions repository; assert the bounded query shapes there.
  assert.match(postgresSessionsDomain, /async listSessionsPage[\s\S]*LIMIT \$\$\{params\.length\}/)
  assert.match(postgresSessionsDomain, /async listSessions\b[\s\S]*WHERE s\.tenant_id = \$1 AND s\.user_id = \$2[\s\S]*LIMIT 1000/)
  assert.match(postgresStore, /async pruneExpiredChannelInteractions[\s\S]*DELETE FROM cloud_channel_interactions[\s\S]*WHERE ctid IN \([\s\S]*WHERE expires_at < \$1[\s\S]*LIMIT \$2/)
  assert.match(postgresStore, /async pruneStaleThrottleState[\s\S]*DELETE FROM cloud_rate_limits[\s\S]*window_started_at_ms < \$1[\s\S]*DELETE FROM cloud_auth_failures[\s\S]*blocked_until_ms < \$1/)
  // Event-log retention (P1-C3) deletes via a ctid-keyed, ORDER BY created_at bounded subselect.
  assert.match(postgresStore, /private async pruneByCreatedAt[\s\S]*DELETE FROM \$\{table\}[\s\S]*WHERE ctid IN \([\s\S]*WHERE created_at < \$1[\s\S]*ORDER BY created_at[\s\S]*LIMIT \$2/)
  for (const method of ['pruneExpiredSessionEvents', 'pruneExpiredAuditEvents', 'pruneExpiredUsageEvents']) {
    assert.match(postgresStore, new RegExp(`async ${method}[\\s\\S]*pruneByCreatedAt\\(`), `${method} should delegate to the bounded created_at prune`)
  }
  assert.match(postgresChannelDeliveriesDomain, /async pruneTerminal[\s\S]*DELETE FROM cloud_channel_deliveries[\s\S]*WHERE ctid IN \([\s\S]*status IN \('sent', 'dead'\)[\s\S]*LIMIT \$2/)
  // P2-7: the concurrency gauge is clamped on READ (the trigger no longer clamps writes), and the
  // drift-correcting reconcile is co-located with the gauge reads in the quotas domain.
  assert.match(postgresQuotaDomain, /SELECT GREATEST\(0, value\)::int AS count[\s\S]*counter_key = 'concurrent_sessions'/)
  assert.match(postgresQuotaDomain, /export async function reconcilePostgresConcurrencyCounters/)
  assert.match(postgresQuotaDomain, /export async function listPostgresRunnableSessions[\s\S]*ORDER BY first_sequence[\s\S]*LIMIT \$3/)
  assert.doesNotMatch(extractFunctionSource(postgresQuotaDomain, 'listPostgresRunnableSessions'), /count\(\*\)[\s\S]*cloud_session_commands/)
  assert.match(postgresSessionsDomain, /async claimNextSessionCommand[\s\S]*ORDER BY created_sequence[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*LIMIT 1/)
  assert.match(postgresChannelDeliveriesDomain, /async claimNext[\s\S]*ORDER BY next_attempt_at, created_at[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*LIMIT 1/)
  assert.match(postgresWorkflowsDomain, /async claimDueWorkflowRun[\s\S]*ORDER BY runs\.created_at ASC, runs\.run_id[\s\S]*FOR UPDATE OF runs, workflows SKIP LOCKED[\s\S]*LIMIT 1/)
})

test('cloud and gateway OCI builds keep generated artifacts out of Docker context', () => {
  for (const pattern of [
    'node_modules',
    '**/node_modules',
    'coverage',
    '**/coverage',
    'dist',
    '**/dist',
    'release',
    '**/release',
    'tmp',
    '**/tmp',
  ]) {
    assert.match(dockerIgnore, new RegExp(`(^|\\n)${escapeRegex(pattern)}(\\n|$)`), `.dockerignore must exclude ${pattern}`)
  }
})

test('downstream extension docs map extension points to owning modules', () => {
  for (const phrase of [
    'Extension Points And Ownership',
    'Downstream Contract',
    'Gateway providers',
    'Deployment recipes',
    'Billing adapters',
    'Object-store adapters',
    'Secret adapters',
    'Worker pool modes',
    'Runtime profiles and policy packs',
    'Cloud Web feature modules and admin panels',
    'BYOK validation and injection hooks',
    'Cloud event and projection contract',
    'Do not patch core execution code',
  ]) {
    assert.match(downstreamDoc, new RegExp(escapeRegex(phrase)), `docs/downstream.md must document ${phrase}`)
  }
})

test('performance docs document cloud query guardrails', () => {
  for (const phrase of [
    'Cloud API query guardrails',
    'cursor pagination',
    '500 rows',
    'FOR UPDATE SKIP LOCKED',
    'claim loops',
    'Postgres indexes',
    '`query` search',
  ]) {
    assert.match(performanceDoc, new RegExp(escapeRegex(phrase)), `docs/performance.md must document ${phrase}`)
  }
})

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'dist' || entry === 'node_modules') continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts')) files.push(path)
  }
  return files
}

function productionSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'dist' || entry === 'node_modules' || entry === 'coverage') continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...productionSourceFiles(path))
    else if (
      (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs'))
      && !path.endsWith('.test.ts')
      && !path.endsWith('.test.tsx')
    ) {
      files.push(path)
    }
  }
  return files
}

function assertSourceBudget(
  label: string,
  directory: string,
  maxLines: number,
  overrides: Record<string, number> = {},
) {
  for (const file of productionSourceFiles(directory)) {
    const relativePath = relative(root, file)
    const budget = overrides[relativePath] ?? maxLines
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lineCount <= budget, `${label} ${relativePath} has ${lineCount} lines; budget is ${budget}`)
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertIndexShape(indexName: string, tableName: string, columns: string, predicate?: string) {
  const pattern = new RegExp(
    `CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? IF NOT EXISTS ${escapeRegex(indexName)}\\s+ON ${escapeRegex(tableName)} \\(${escapeRegex(columns)}\\)${predicate ? `[\\s\\S]*${escapeRegex(predicate)}` : ''}`,
  )
  assert.match(postgresSchema, pattern, `${indexName} must keep its indexed table, column order, and predicate`)
}

function extractFunctionSource(source: string, functionName: string) {
  const start = source.indexOf(`function ${functionName}`)
  assert.notEqual(start, -1, `${functionName} function is missing`)
  const nextFunction = source.indexOf('\nexport async function ', start + 1)
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction)
}
