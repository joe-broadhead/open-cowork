import { createRequire } from 'node:module'
import {
  generateChannelInteractionToken,
  generateCloudApiToken,
  hashChannelInteractionToken,
  hashCloudApiToken,
} from './control-plane-store.ts'
import type {
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import type {
  AttachWorkflowRunSessionInput,
  AppendWorkspaceEventInput,
  AccountRecord,
  ApiTokenRecord,
  AuditEventRecord,
  AckChannelDeliveryInput,
  BindChannelSessionInput,
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  ClaimDueWorkflowRunInput,
  ClaimChannelDeliveryInput,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  CompleteWorkflowRunInput,
  ControlPlaneCommandStatus,
  ControlPlaneRole,
  ControlPlaneSessionStatus,
  ControlPlaneStore,
  CreateChannelBindingInput,
  CreateChannelDeliveryInput,
  CreateChannelInteractionInput,
  CreateAccountInput,
  CreateHeadlessAgentInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  CreateThreadSmartFilterInput,
  CreateThreadTagInput,
  FailWorkflowRunInput,
  FindChannelInteractionInput,
  HeadlessAgentRecord,
  IssuedApiTokenRecord,
  IssuedChannelInteractionRecord,
  IssueApiTokenInput,
  MembershipRecord,
  OrgRecord,
  PrincipalMembershipRecord,
  RecordAuditEventInput,
  RevokeApiTokenInput,
  ResolveChannelInteractionInput,
  ResolveChannelInteractionWithCommandInput,
  SchemaMigrationRecord,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  SettingMetadataRecord,
  TenantRecord,
  ThreadMetadataRecord,
  ThreadSmartFilterRecord,
  ThreadTagLinkInput,
  ThreadTagRecord,
  UpdateChannelBindingInput,
  UpdateChannelCursorInput,
  UpdateHeadlessAgentInput,
  UpdateWorkflowStatusInput,
  UpdateThreadSmartFilterInput,
  UpdateThreadTagInput,
  UpsertChannelIdentityInput,
  UpsertMembershipInput,
  UserRecord,
  WorkerHeartbeatRecord,
  WorkerLeaseRecord,
  WorkerRole,
  WorkspaceEventRecord,
} from './control-plane-store.ts'
import type {
  WebhookAuthFailureRecord,
  WorkflowWebhookReplayClaim,
  WorkflowWebhookSecurityStore,
} from '../workflow/workflow-webhook-server.ts'
import {
  CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS,
  CLOUD_CONTROL_PLANE_MIGRATIONS,
} from './postgres-schema.ts'

type QueryRow = Record<string, unknown>
type QueryResult<Row extends QueryRow = QueryRow> = { rows: Row[] }
type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }
type PgPool = PgExecutor & {
  connect(): Promise<PgClient>
  end(): Promise<void>
}

export type PostgresControlPlaneStoreOptions = {
  connectionString: string
  runMigrations?: boolean
  pool?: PgPool
}

const require = createRequire(import.meta.url)

const THREAD_TAG_NAME_MAX_LENGTH = 48
const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
const THREAD_DEFAULT_TAG_COLOR = '#64748b'
const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500
const SMART_FILTER_QUERY_MAX_BYTES = 16_384
const WORKFLOW_RUN_LIST_LIMIT = 100
const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_DELIVERY_ERROR_MAX_LENGTH = 1024

function loadPgPool(connectionString: string): PgPool {
  const pg = require('pg') as {
    Pool: new (options: { connectionString: string }) => PgPool
  }
  return new pg.Pool({ connectionString })
}

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function workspaceOperationFromType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

function optionalTrimmedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  throw new Error('Expected a timestamp column.')
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('Expected a numeric column.')
  return parsed
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}

function isoOrNull(value: unknown) {
  return value ? iso(value) : null
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function workflowTriggers(value: unknown): WorkflowTrigger[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is WorkflowTrigger => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : []
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function normalizeOptionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined) return undefined
  return normalizeText(value, maxLength, label)
}

function normalizeTagColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : THREAD_DEFAULT_TAG_COLOR
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function normalizeThreadQuery(value: unknown) {
  const query = jsonRecord(value)
  const serialized = stableJson(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return query
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = jsonRecord(value)
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

function normalizeNonNegativeInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`)
  return parsed
}

function normalizeProvider(value: unknown): ChannelProviderId {
  const provider = normalizeText(value, 32, 'Channel provider') as ChannelProviderId
  if (!['telegram', 'slack', 'email', 'discord', 'whatsapp', 'signal', 'webhook', 'cli'].includes(provider)) {
    throw new Error(`Unsupported channel provider ${provider}.`)
  }
  return provider
}

function redactAuditMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [field, entry] of Object.entries(value || {})) {
    if (/token|secret|key|password|credential/i.test(field)) {
      redacted[field] = '[redacted]'
    } else if (entry && typeof entry === 'object') {
      redacted[field] = '[object]'
    } else if (typeof entry === 'string') {
      redacted[field] = entry.length > 256 ? `${entry.slice(0, 253)}...` : entry
    } else {
      redacted[field] = entry
    }
  }
  return redacted
}

function tenantFromRow(row: QueryRow): TenantRecord {
  return {
    tenantId: String(row.tenant_id),
    name: String(row.name),
    createdAt: iso(row.created_at),
  }
}

function userFromRow(row: QueryRow): UserRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    email: String(row.email),
    role: String(row.role) as ControlPlaneRole,
    createdAt: iso(row.created_at),
  }
}

function orgFromRow(row: QueryRow): OrgRecord {
  return {
    orgId: String(row.org_id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    planKey: stringOrNull(row.plan_key),
    status: String(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function accountFromRow(row: QueryRow): AccountRecord {
  return {
    accountId: String(row.account_id),
    idpSubject: stringOrNull(row.idp_subject),
    email: String(row.email),
    displayName: stringOrNull(row.display_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function membershipFromRow(row: QueryRow): MembershipRecord {
  return {
    orgId: String(row.org_id),
    accountId: String(row.account_id),
    role: String(row.role) as ControlPlaneRole,
    status: String(row.status) as MembershipRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function apiTokenFromRow(row: QueryRow): ApiTokenRecord {
  return {
    tokenId: String(row.token_id),
    orgId: String(row.org_id),
    accountId: stringOrNull(row.account_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    scopes: jsonStringArray(row.scopes) as ApiTokenRecord['scopes'],
    last4: String(row.last4),
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function auditEventFromRow(row: QueryRow): AuditEventRecord {
  return {
    eventId: String(row.event_id),
    orgId: String(row.org_id),
    accountId: stringOrNull(row.account_id),
    actorType: String(row.actor_type) as AuditEventRecord['actorType'],
    actorId: stringOrNull(row.actor_id),
    eventType: String(row.event_type),
    targetType: stringOrNull(row.target_type),
    targetId: stringOrNull(row.target_id),
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
  }
}

function headlessAgentFromRow(row: QueryRow): HeadlessAgentRecord {
  return {
    agentId: String(row.agent_id),
    orgId: String(row.org_id),
    tenantId: String(row.tenant_id),
    profileName: String(row.profile_name),
    name: String(row.name),
    status: String(row.status) as HeadlessAgentRecord['status'],
    managed: row.managed === true,
    createdByAccountId: stringOrNull(row.created_by_account_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function channelBindingFromRow(row: QueryRow): ChannelBindingRecord {
  return {
    bindingId: String(row.binding_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    displayName: String(row.display_name),
    status: String(row.status) as ChannelBindingRecord['status'],
    credentialRef: stringOrNull(row.credential_ref),
    settings: jsonRecord(row.settings),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function channelIdentityFromRow(row: QueryRow): ChannelIdentityRecord {
  return {
    identityId: String(row.identity_id),
    orgId: String(row.org_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    externalUserId: String(row.external_user_id),
    accountId: stringOrNull(row.account_id),
    role: String(row.role) as ChannelIdentityRecord['role'],
    status: String(row.status) as ChannelIdentityRecord['status'],
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function channelSessionBindingFromRow(row: QueryRow): ChannelSessionBindingRecord {
  return {
    bindingId: String(row.binding_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    channelBindingId: String(row.channel_binding_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    externalThreadId: String(row.external_thread_id),
    externalChatId: String(row.external_chat_id),
    sessionId: String(row.session_id),
    lastEventSequence: numberValue(row.last_event_sequence),
    lastWorkspaceSequence: numberValue(row.last_workspace_sequence),
    lastChatMessageId: stringOrNull(row.last_chat_message_id),
    status: String(row.status) as ChannelSessionBindingRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function channelInteractionFromRow(row: QueryRow): ChannelInteractionRecord {
  return {
    interactionId: String(row.interaction_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    sessionId: String(row.session_id),
    provider: String(row.provider) as ChannelProviderId,
    externalInteractionId: stringOrNull(row.external_interaction_id),
    tokenHash: String(row.token_hash),
    kind: String(row.kind) as ChannelInteractionRecord['kind'],
    targetId: String(row.target_id),
    status: String(row.status) as ChannelInteractionRecord['status'],
    createdByIdentityId: stringOrNull(row.created_by_identity_id),
    expiresAt: iso(row.expires_at),
    usedAt: isoOrNull(row.used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function channelDeliveryFromRow(row: QueryRow): ChannelDeliveryRecord {
  return {
    deliveryId: String(row.delivery_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    channelBindingId: String(row.channel_binding_id),
    sessionBindingId: stringOrNull(row.session_binding_id),
    provider: String(row.provider) as ChannelProviderId,
    target: jsonRecord(row.target),
    eventType: String(row.event_type),
    payload: jsonRecord(row.payload),
    status: String(row.status) as ChannelDeliveryRecord['status'],
    attemptCount: numberValue(row.attempt_count),
    claimedBy: stringOrNull(row.claimed_by),
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    nextAttemptAt: iso(row.next_attempt_at),
    lastError: stringOrNull(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sessionFromRow(row: QueryRow): SessionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    opencodeSessionId: String(row.opencode_session_id),
    profileName: String(row.profile_name),
    status: String(row.status) as ControlPlaneSessionStatus,
    title: stringOrNull(row.title),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function eventFromRow(row: QueryRow): SessionEventRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    eventId: String(row.event_id),
    sequence: numberValue(row.sequence),
    type: String(row.type),
    payload: jsonRecord(row.payload),
    createdAt: iso(row.created_at),
  }
}

function workspaceEventFromRow(row: QueryRow): WorkspaceEventRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: stringOrNull(row.session_id),
    eventId: String(row.event_id),
    sequence: numberValue(row.sequence),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    operation: String(row.operation),
    projectionVersion: numberValue(row.projection_version),
    type: String(row.type),
    payload: jsonRecord(row.payload),
    createdAt: iso(row.created_at),
  }
}

function projectionFromRow(row: QueryRow): SessionProjectionRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    view: jsonRecord(row.view),
    updatedAt: iso(row.updated_at),
  }
}

function leaseFromRow(row: QueryRow): WorkerLeaseRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    leasedBy: String(row.leased_by),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: numberValue(row.lease_expires_at_ms),
    checkpointVersion: numberValue(row.checkpoint_version),
  }
}

function commandFromRow(row: QueryRow): SessionCommandRecord {
  return {
    commandId: String(row.command_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    kind: String(row.kind) as SessionCommandRecord['kind'],
    payload: jsonRecord(row.payload),
    targetLeaseToken: stringOrNull(row.target_lease_token),
    createdSequence: numberValue(row.created_sequence),
    createdAt: iso(row.created_at),
    status: String(row.status) as ControlPlaneCommandStatus,
    claimedBy: stringOrNull(row.claimed_by),
    claimedLeaseToken: stringOrNull(row.claimed_lease_token),
    ackedAt: row.acked_at ? iso(row.acked_at) : null,
    error: stringOrNull(row.error),
  }
}

function heartbeatFromRow(row: QueryRow): WorkerHeartbeatRecord {
  return {
    workerId: String(row.worker_id),
    role: String(row.role) as WorkerRole,
    activeSessionIds: Array.isArray(row.active_session_ids)
      ? row.active_session_ids.map(String)
      : [],
    lastSeenAt: iso(row.last_seen_at),
  }
}

function settingFromRow(row: QueryRow): SettingMetadataRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: stringOrNull(row.user_id),
    key: String(row.key),
    value: jsonRecord(row.value),
    updatedAt: iso(row.updated_at),
  }
}

function workflowFromRow(row: QueryRow): CloudWorkflowRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    id: String(row.workflow_id),
    title: String(row.title),
    instructions: String(row.instructions),
    agentName: String(row.agent_name || 'build'),
    skillNames: jsonStringArray(row.skill_names),
    toolIds: jsonStringArray(row.tool_ids),
    status: String(row.status) as WorkflowStatus,
    projectDirectory: stringOrNull(row.project_directory),
    draftSessionId: stringOrNull(row.draft_session_id),
    triggers: workflowTriggers(row.triggers),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    nextRunAt: isoOrNull(row.next_run_at),
    lastRunAt: isoOrNull(row.last_run_at),
    latestRunId: stringOrNull(row.latest_run_id),
    latestRunStatus: row.latest_run_status ? String(row.latest_run_status) as WorkflowRunStatus : null,
    latestRunSessionId: stringOrNull(row.latest_run_session_id),
    latestRunSummary: stringOrNull(row.latest_run_summary),
    webhookUrl: null,
  }
}

function workflowRunFromRow(row: QueryRow): CloudWorkflowRunRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    id: String(row.run_id),
    workflowId: String(row.workflow_id),
    sessionId: stringOrNull(row.session_id),
    triggerType: String(row.trigger_type) as WorkflowTriggerType,
    triggerPayload: row.trigger_payload ? jsonRecord(row.trigger_payload) : null,
    status: String(row.status) as WorkflowRunStatus,
    title: String(row.title),
    summary: stringOrNull(row.summary),
    error: stringOrNull(row.error),
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  }
}

function threadTagFromRow(row: QueryRow): ThreadTagRecord {
  return {
    tenantId: String(row.tenant_id),
    tagId: String(row.tag_id),
    name: String(row.name),
    color: String(row.color),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function threadSmartFilterFromRow(row: QueryRow): ThreadSmartFilterRecord {
  return {
    tenantId: String(row.tenant_id),
    filterId: String(row.filter_id),
    name: String(row.name),
    query: jsonRecord(row.query),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function migrationFromRow(row: QueryRow): SchemaMigrationRecord {
  return {
    id: String(row.id),
    appliedAt: iso(row.applied_at),
  }
}

function webhookAuthFailureFromRow(row: QueryRow): WebhookAuthFailureRecord {
  return {
    authWindowStartedAt: numberValue(row.auth_window_started_at_ms),
    authFailureCount: numberValue(row.auth_failure_count),
    blockedUntil: numberValue(row.blocked_until_ms),
  }
}

export class PostgresControlPlaneStore implements ControlPlaneStore, WorkflowWebhookSecurityStore {
  private readonly pool: PgPool
  private readonly ownsPool: boolean

  private constructor(pool: PgPool, ownsPool: boolean) {
    this.pool = pool
    this.ownsPool = ownsPool
  }

  static async connect(options: PostgresControlPlaneStoreOptions) {
    const pool = options.pool || loadPgPool(options.connectionString)
    const store = new PostgresControlPlaneStore(pool, !options.pool)
    if (options.runMigrations !== false) await store.runMigrations()
    return store
  }

  async close() {
    if (this.ownsPool) await this.pool.end()
  }

  async runMigrations() {
    await this.withTransaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [...CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS],
      )
      for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS) {
        for (const statement of migration.statements) await client.query(statement)
        await client.query(
          `INSERT INTO cloud_schema_migrations (id, applied_at)
           VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [migration.id, nowIso(undefined)],
        )
      }
    })
  }

  async createTenant(input: { tenantId: string, name: string, createdAt?: Date }) {
    await this.pool.query(
      `INSERT INTO cloud_tenants (tenant_id, name, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [input.tenantId, input.name, nowIso(input.createdAt)],
    )
    await this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.name, createdAt: input.createdAt })
    return this.requireTenant(input.tenantId)
  }

  async ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }) {
    await this.requireTenant(input.tenantId)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_users WHERE tenant_id = $1 AND user_id = $2`,
      [input.tenantId, input.userId],
    )
    if (existing) return userFromRow(existing)
    await this.pool.query(
      `INSERT INTO cloud_users (tenant_id, user_id, email, role, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [input.tenantId, input.userId, input.email, input.role || 'member', nowIso(input.createdAt)],
    )
    const org = await this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId, createdAt: input.createdAt })
    const account = await this.createAccount({
      accountId: input.userId,
      idpSubject: input.userId,
      email: input.email,
      createdAt: input.createdAt,
    })
    await this.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: input.role || 'member',
      status: 'active',
      updatedAt: input.createdAt,
      actor: { actorType: 'system', actorId: 'compat.ensureUser' },
    })
    return this.requireTenantUser(input.tenantId, input.userId)
  }

  async ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }) {
    const now = nowIso(input.createdAt)
    const result = await this.pool.query(
      `INSERT INTO cloud_orgs (org_id, tenant_id, name, plan_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (tenant_id) DO UPDATE
       SET name = COALESCE(NULLIF(EXCLUDED.name, ''), cloud_orgs.name),
           plan_key = COALESCE(EXCLUDED.plan_key, cloud_orgs.plan_key),
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [input.orgId || input.tenantId, input.tenantId, input.name, input.planKey ?? null, input.status || 'active', now],
    )
    return orgFromRow(result.rows[0])
  }

  async createAccount(input: CreateAccountInput) {
    const now = nowIso(input.createdAt)
    const result = await this.pool.query(
      `INSERT INTO cloud_accounts (account_id, idp_subject, email, display_name, created_at, updated_at)
       VALUES ($1, $2, lower($3), $4, $5, $5)
       ON CONFLICT (account_id) DO UPDATE
       SET idp_subject = COALESCE(cloud_accounts.idp_subject, EXCLUDED.idp_subject),
           email = EXCLUDED.email,
           display_name = COALESCE(EXCLUDED.display_name, cloud_accounts.display_name),
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [input.accountId, input.idpSubject || null, input.email, input.displayName || null, now],
    )
    return accountFromRow(result.rows[0])
  }

  async findAccountBySubject(idpSubject: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_accounts WHERE idp_subject = $1`, [idpSubject])
    return row ? accountFromRow(row) : null
  }

  async findAccountByEmail(email: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_accounts WHERE lower(email) = lower($1)`, [email])
    return row ? accountFromRow(row) : null
  }

  async upsertMembership(input: UpsertMembershipInput) {
    return this.withTransaction(async (client) => {
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_memberships WHERE org_id = $1 AND account_id = $2`,
        [input.orgId, input.accountId],
        client,
      )
      const now = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_memberships (org_id, account_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (org_id, account_id) DO UPDATE
         SET role = EXCLUDED.role,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.orgId, input.accountId, input.role, input.status || 'active', now],
      )
      await this.recordAuditEventWithExecutor(client, {
        orgId: input.orgId,
        accountId: input.accountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: existing ? 'membership.updated' : 'membership.created',
        targetType: 'membership',
        targetId: `${input.orgId}:${input.accountId}`,
        metadata: { role: input.role, status: input.status || 'active' },
        createdAt: input.updatedAt,
      })
      return membershipFromRow(result.rows[0])
    })
  }

  async listMembershipsForAccount(accountId: string) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_memberships WHERE account_id = $1 ORDER BY updated_at DESC, org_id`,
      [accountId],
    )
    return result.rows.map(membershipFromRow)
  }

  async resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): Promise<PrincipalMembershipRecord | null> {
    const row = await this.maybeOne(
      `SELECT
         o.org_id, o.tenant_id, o.name AS org_name, o.plan_key, o.status AS org_status,
         o.created_at AS org_created_at, o.updated_at AS org_updated_at,
         a.account_id, a.idp_subject, a.email, a.display_name,
         a.created_at AS account_created_at, a.updated_at AS account_updated_at,
         m.role, m.status AS membership_status,
         m.created_at AS membership_created_at, m.updated_at AS membership_updated_at
       FROM cloud_orgs o
       JOIN cloud_memberships m ON m.org_id = o.org_id
       JOIN cloud_accounts a ON a.account_id = m.account_id
       WHERE (o.tenant_id = $1 OR o.org_id = $1)
         AND ($2::text IS NULL OR a.account_id = $2)
         AND ($3::text IS NULL OR a.idp_subject = $3)
         AND ($4::text IS NULL OR lower(a.email) = lower($4))
       ORDER BY m.updated_at DESC
       LIMIT 1`,
      [input.tenantId, input.accountId || input.userId || null, input.idpSubject || null, input.email || null],
    )
    if (!row) return null
    return {
      org: orgFromRow({
        org_id: row.org_id,
        tenant_id: row.tenant_id,
        name: row.org_name,
        plan_key: row.plan_key,
        status: row.org_status,
        created_at: row.org_created_at,
        updated_at: row.org_updated_at,
      }),
      account: accountFromRow({
        account_id: row.account_id,
        idp_subject: row.idp_subject,
        email: row.email,
        display_name: row.display_name,
        created_at: row.account_created_at,
        updated_at: row.account_updated_at,
      }),
      membership: membershipFromRow({
        org_id: row.org_id,
        account_id: row.account_id,
        role: row.role,
        status: row.membership_status,
        created_at: row.membership_created_at,
        updated_at: row.membership_updated_at,
      }),
    }
  }

  async issueApiToken(input: IssueApiTokenInput): Promise<IssuedApiTokenRecord> {
    return this.withTransaction(async (client) => {
      const generated = generateCloudApiToken(input)
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_api_tokens (
          token_id, org_id, account_id, name, token_hash, scopes, last4,
          expires_at, revoked_at, last_used_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NULL, NULL, $9, $9)
         RETURNING *`,
        [
          generated.tokenId,
          input.orgId,
          input.accountId || null,
          normalizeText(input.name, 96, 'API token name'),
          hashCloudApiToken(generated.plaintext),
          JSON.stringify([...new Set(input.scopes)]),
          generated.plaintext.slice(-4),
          input.expiresAt ? input.expiresAt.toISOString() : null,
          now,
        ],
      )
      const token = apiTokenFromRow(result.rows[0])
      await this.recordAuditEventWithExecutor(client, {
        orgId: input.orgId,
        accountId: input.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'api_token.created',
        targetType: 'api_token',
        targetId: token.tokenId,
        metadata: { name: token.name, scopes: token.scopes, last4: token.last4 },
        createdAt: input.createdAt,
      })
      return { token, plaintext: generated.plaintext }
    })
  }

  async findApiTokenByPlaintext(plaintext: string, now = new Date()) {
    const tokenHash = hashCloudApiToken(plaintext)
    const result = await this.pool.query(
      `UPDATE cloud_api_tokens
       SET last_used_at = $2, updated_at = $2
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)
       RETURNING *`,
      [tokenHash, nowIso(now)],
    )
    return result.rows[0] ? apiTokenFromRow(result.rows[0]) : null
  }

  async revokeApiToken(input: RevokeApiTokenInput) {
    return this.withTransaction(async (client) => {
      const now = nowIso(input.revokedAt)
      const result = await client.query(
        `UPDATE cloud_api_tokens
         SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
         WHERE token_id = $1
         RETURNING *`,
        [input.tokenId, now],
      )
      if (!result.rows[0]) return null
      const token = apiTokenFromRow(result.rows[0])
      await this.recordAuditEventWithExecutor(client, {
        orgId: token.orgId,
        accountId: token.accountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'api_token.revoked',
        targetType: 'api_token',
        targetId: token.tokenId,
        metadata: { name: token.name, scopes: token.scopes, last4: token.last4 },
        createdAt: input.revokedAt,
      })
      return token
    })
  }

  async recordAuditEvent(input: RecordAuditEventInput) {
    return this.recordAuditEventWithExecutor(this.pool, input)
  }

  async listAuditEvents(orgId: string, limit = 100) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_audit_events
       WHERE org_id = $1
       ORDER BY created_at DESC, event_id DESC
       LIMIT $2`,
      [orgId, Math.max(1, Math.min(limit, 500))],
    )
    return result.rows.map(auditEventFromRow)
  }

  async createHeadlessAgent(input: CreateHeadlessAgentInput) {
    return this.withTransaction(async (client) => {
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO headless_agents (
          agent_id, org_id, tenant_id, profile_name, name, status, managed,
          created_by_account_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (agent_id) DO NOTHING
         RETURNING *`,
        [
          normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
          input.orgId,
          input.tenantId,
          normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile'),
          normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name'),
          input.status || 'active',
          input.managed === true,
          input.createdByAccountId || null,
          now,
        ],
      )
      const row = result.rows[0] || await this.one(
        `SELECT * FROM headless_agents WHERE agent_id = $1 AND org_id = $2`,
        [input.agentId, input.orgId],
        client,
      )
      const agent = headlessAgentFromRow(row)
      if (result.rows[0]) {
        await this.recordAuditEventWithExecutor(client, {
          orgId: agent.orgId,
          accountId: agent.createdByAccountId,
          actorType: 'system',
          actorId: 'headless_agent.create',
          eventType: 'headless_agent.created',
          targetType: 'headless_agent',
          targetId: agent.agentId,
          metadata: { name: agent.name, profileName: agent.profileName, managed: agent.managed },
          createdAt: input.createdAt,
        })
      }
      return agent
    })
  }

  async updateHeadlessAgent(input: UpdateHeadlessAgentInput) {
    const result = await this.pool.query(
      `UPDATE headless_agents
       SET profile_name = CASE WHEN $3::boolean THEN $4 ELSE profile_name END,
           name = CASE WHEN $5::boolean THEN $6 ELSE name END,
           status = COALESCE($7, status),
           managed = CASE WHEN $8::boolean THEN $9 ELSE managed END,
           updated_at = $10
       WHERE org_id = $1 AND agent_id = $2
       RETURNING *`,
      [
        input.orgId,
        input.agentId,
        input.profileName !== undefined,
        input.profileName === undefined ? null : normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile'),
        input.name !== undefined,
        input.name === undefined ? null : normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name'),
        input.status || null,
        input.managed !== undefined,
        input.managed ?? null,
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? headlessAgentFromRow(result.rows[0]) : null
  }

  async getHeadlessAgent(orgId: string, agentId: string) {
    const row = await this.maybeOne(`SELECT * FROM headless_agents WHERE org_id = $1 AND agent_id = $2`, [orgId, agentId])
    return row ? headlessAgentFromRow(row) : null
  }

  async listHeadlessAgents(orgId: string) {
    const result = await this.pool.query(
      `SELECT * FROM headless_agents WHERE org_id = $1 ORDER BY updated_at DESC, agent_id`,
      [orgId],
    )
    return result.rows.map(headlessAgentFromRow)
  }

  async createChannelBinding(input: CreateChannelBindingInput) {
    return this.withTransaction(async (client) => {
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_channel_bindings (
          binding_id, org_id, agent_id, provider, external_workspace_id,
          display_name, status, credential_ref, settings, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
         ON CONFLICT (binding_id) DO NOTHING
         RETURNING *`,
        [
          normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
          input.orgId,
          input.agentId,
          normalizeProvider(input.provider),
          normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
          normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
          input.status || 'active',
          normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
          JSON.stringify(normalizeRecord(input.settings, 'Channel binding settings')),
          now,
        ],
      )
      const row = result.rows[0] || await this.one(
        `SELECT * FROM cloud_channel_bindings WHERE org_id = $1 AND binding_id = $2`,
        [input.orgId, input.bindingId],
        client,
      )
      const binding = channelBindingFromRow(row)
      if (result.rows[0]) {
        await this.recordAuditEventWithExecutor(client, {
          orgId: binding.orgId,
          actorType: 'system',
          actorId: 'channel_binding.create',
          eventType: 'channel_binding.created',
          targetType: 'channel_binding',
          targetId: binding.bindingId,
          metadata: { provider: binding.provider, displayName: binding.displayName, credentialRef: binding.credentialRef },
          createdAt: input.createdAt,
        })
      }
      return binding
    })
  }

  async updateChannelBinding(input: UpdateChannelBindingInput) {
    const result = await this.pool.query(
      `UPDATE cloud_channel_bindings
       SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
           status = COALESCE($5, status),
           credential_ref = CASE WHEN $6::boolean THEN $7 ELSE credential_ref END,
           settings = CASE WHEN $8::boolean THEN $9::jsonb ELSE settings END,
           updated_at = $10
       WHERE org_id = $1 AND binding_id = $2
       RETURNING *`,
      [
        input.orgId,
        input.bindingId,
        input.displayName !== undefined,
        input.displayName === undefined ? null : normalizeText(input.displayName, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding name'),
        input.status || null,
        input.credentialRef !== undefined,
        input.credentialRef === undefined ? null : normalizeNullableText(input.credentialRef, CHANNEL_TEXT_MAX_LENGTH, 'Credential ref'),
        input.settings !== undefined,
        input.settings === undefined ? null : JSON.stringify(normalizeRecord(input.settings, 'Channel binding settings')),
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? channelBindingFromRow(result.rows[0]) : null
  }

  async getChannelBinding(orgId: string, bindingId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_bindings WHERE org_id = $1 AND binding_id = $2`, [orgId, bindingId])
    return row ? channelBindingFromRow(row) : null
  }

  async listChannelBindings(orgId: string, agentId?: string | null) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_channel_bindings
       WHERE org_id = $1 AND ($2::text IS NULL OR agent_id = $2)
       ORDER BY updated_at DESC, binding_id`,
      [orgId, agentId || null],
    )
    return result.rows.map(channelBindingFromRow)
  }

  async upsertChannelIdentity(input: UpsertChannelIdentityInput) {
    const now = nowIso(input.updatedAt)
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_identities (
        identity_id, org_id, provider, external_workspace_id, external_user_id,
        account_id, role, status, metadata, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
       ON CONFLICT (org_id, provider, (COALESCE(external_workspace_id, '')), external_user_id) DO UPDATE
       SET account_id = CASE
             WHEN EXCLUDED.account_id IS NOT NULL THEN EXCLUDED.account_id
             ELSE cloud_channel_identities.account_id
           END,
           role = EXCLUDED.role,
           status = EXCLUDED.status,
           metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.identityId || `chid_${provider}_${externalUserId}`,
        input.orgId,
        provider,
        externalWorkspaceId,
        externalUserId,
        input.accountId || null,
        input.role || 'viewer',
        input.status || 'pending',
        JSON.stringify(normalizeRecord(input.metadata, 'Channel identity metadata')),
        now,
      ],
    )
    return channelIdentityFromRow(result.rows[0])
  }

  async getChannelIdentity(orgId: string, identityId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_identities WHERE org_id = $1 AND identity_id = $2`, [orgId, identityId])
    return row ? channelIdentityFromRow(row) : null
  }

  async findChannelIdentity(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalUserId: string }) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_identities
       WHERE org_id = $1
         AND provider = $2
         AND COALESCE(external_workspace_id, '') = COALESCE($3, '')
         AND external_user_id = $4`,
      [
        input.orgId,
        normalizeProvider(input.provider),
        normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id'),
        normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id'),
      ],
    )
    return row ? channelIdentityFromRow(row) : null
  }

  async bindChannelSession(input: BindChannelSessionInput) {
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const now = nowIso(input.createdAt)
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_session_bindings (
        binding_id, org_id, agent_id, channel_binding_id, provider,
        external_workspace_id, external_thread_id, external_chat_id, session_id,
        last_event_sequence, last_workspace_sequence, last_chat_message_id,
        status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        normalizeText(input.bindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel session binding id'),
        input.orgId,
        input.agentId,
        input.channelBindingId,
        provider,
        externalWorkspaceId,
        normalizeText(input.externalThreadId, CHANNEL_TEXT_MAX_LENGTH, 'External thread id'),
        normalizeText(input.externalChatId, CHANNEL_TEXT_MAX_LENGTH, 'External chat id'),
        input.sessionId,
        normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence'),
        normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence'),
        normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id'),
        input.status || 'active',
        now,
      ],
    )
    const row = result.rows[0] || await this.one(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND provider = $2 AND COALESCE(external_workspace_id, '') = COALESCE($3::text, '')
         AND external_chat_id = $4 AND external_thread_id = $5`,
      [input.orgId, provider, externalWorkspaceId, input.externalChatId, input.externalThreadId],
    )
    const binding = channelSessionBindingFromRow(row)
    if (result.rows[0]) {
      await this.recordAuditEvent({
        orgId: binding.orgId,
        actorType: 'system',
        actorId: 'channel_session.bind',
        eventType: 'channel_session_bound',
        targetType: 'channel_session_binding',
        targetId: binding.bindingId,
        metadata: { provider: binding.provider, sessionId: binding.sessionId },
        createdAt: input.createdAt,
      })
    }
    return binding
  }

  async getChannelSessionBinding(orgId: string, bindingId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_channel_session_bindings WHERE org_id = $1 AND binding_id = $2`, [orgId, bindingId])
    return row ? channelSessionBindingFromRow(row) : null
  }

  async findChannelSessionBindingByThread(input: { orgId: string, provider: ChannelProviderId, externalWorkspaceId?: string | null, externalChatId: string, externalThreadId: string }) {
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND provider = $2 AND COALESCE(external_workspace_id, '') = COALESCE($3::text, '')
         AND external_chat_id = $4 AND external_thread_id = $5`,
      [input.orgId, normalizeProvider(input.provider), externalWorkspaceId, input.externalChatId, input.externalThreadId],
    )
    return row ? channelSessionBindingFromRow(row) : null
  }

  async listChannelSessionBindingsForSession(orgId: string, sessionId: string) {
    const result = await this.pool.query(
      `SELECT * FROM cloud_channel_session_bindings
       WHERE org_id = $1 AND session_id = $2 AND status = 'active'
       ORDER BY updated_at DESC, binding_id`,
      [orgId, sessionId],
    )
    return result.rows.map(channelSessionBindingFromRow)
  }

  async updateChannelCursor(input: UpdateChannelCursorInput) {
    const result = await this.pool.query(
      `UPDATE cloud_channel_session_bindings
       SET last_event_sequence = $3,
           last_workspace_sequence = $4,
           last_chat_message_id = CASE WHEN $5::boolean THEN $6 ELSE last_chat_message_id END,
           updated_at = $7
       WHERE org_id = $1
         AND binding_id = $2
         AND last_event_sequence <= $3
         AND last_workspace_sequence <= $4
       RETURNING *`,
      [
        input.orgId,
        input.bindingId,
        normalizeNonNegativeInteger(input.lastEventSequence, 'Last event sequence'),
        normalizeNonNegativeInteger(input.lastWorkspaceSequence, 'Last workspace sequence'),
        input.lastChatMessageId !== undefined,
        normalizeNullableText(input.lastChatMessageId, CHANNEL_TEXT_MAX_LENGTH, 'Last chat message id'),
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? channelSessionBindingFromRow(result.rows[0]) : null
  }

  async createChannelInteraction(input: CreateChannelInteractionInput): Promise<IssuedChannelInteractionRecord> {
    const plaintextToken = generateChannelInteractionToken({ interactionId: input.interactionId, secret: input.tokenSecret })
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_interactions (
        interaction_id, org_id, agent_id, session_id, provider, external_interaction_id,
        token_hash, kind, target_id, status, created_by_identity_id,
        expires_at, used_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, NULL, $12, $12)
       ON CONFLICT (interaction_id) DO NOTHING
       RETURNING *`,
      [
        input.interactionId,
        input.orgId,
        input.agentId,
        input.sessionId,
        normalizeProvider(input.provider),
        normalizeNullableText(input.externalInteractionId, CHANNEL_TEXT_MAX_LENGTH, 'External interaction id'),
        hashChannelInteractionToken(plaintextToken),
        input.kind,
        normalizeText(input.targetId, CHANNEL_TEXT_MAX_LENGTH, 'Interaction target id'),
        input.createdByIdentityId || null,
        input.expiresAt.toISOString(),
        nowIso(input.createdAt),
      ],
    )
    if (!result.rows[0]) throw new Error(`Channel interaction ${input.interactionId} already exists.`)
    return { interaction: channelInteractionFromRow(result.rows[0]), plaintextToken }
  }

  async findChannelInteraction(input: FindChannelInteractionInput) {
    const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
    const now = nowIso(input.now)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_channel_interactions
       WHERE org_id = $1
         AND status = 'pending'
         AND expires_at > $5
         AND (
           ($2::text IS NOT NULL AND token_hash = $2)
           OR (
             $3::text IS NOT NULL
             AND $4::text IS NOT NULL
             AND provider = $3
             AND external_interaction_id = $4
           )
         )`,
      [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, now],
    )
    return row ? channelInteractionFromRow(row) : null
  }

  async resolveChannelInteraction(input: ResolveChannelInteractionInput) {
    const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
    const now = nowIso(input.usedAt)
    const result = await this.pool.query(
      `UPDATE cloud_channel_interactions
       SET status = 'used', used_at = $5, updated_at = $5
       WHERE org_id = $1
         AND status = 'pending'
         AND expires_at > $5
         AND (
           ($2::text IS NOT NULL AND token_hash = $2)
           OR (
             $3::text IS NOT NULL
             AND $4::text IS NOT NULL
             AND provider = $3
             AND external_interaction_id = $4
           )
         )
       RETURNING *`,
      [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, now],
    )
    const interaction = result.rows[0] ? channelInteractionFromRow(result.rows[0]) : null
    if (interaction) {
      await this.recordAuditEvent({
        orgId: interaction.orgId,
        actorType: 'system',
        actorId: input.identityId,
        eventType: 'channel_interaction.used',
        targetType: 'channel_interaction',
        targetId: interaction.interactionId,
        metadata: { kind: interaction.kind, targetId: interaction.targetId },
        createdAt: input.usedAt,
      })
    }
    return interaction
  }

  async resolveChannelInteractionWithCommand(input: ResolveChannelInteractionWithCommandInput) {
    return this.withTransaction(async (client) => {
      const tokenHash = input.token ? hashChannelInteractionToken(input.token) : null
      const usedAt = nowIso(input.usedAt)
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_channel_interactions
         WHERE org_id = $1
           AND status = 'pending'
           AND expires_at > $5
           AND (
             ($2::text IS NOT NULL AND token_hash = $2)
             OR (
               $3::text IS NOT NULL
               AND $4::text IS NOT NULL
               AND provider = $3
               AND external_interaction_id = $4
             )
           )
         FOR UPDATE`,
        [input.orgId, tokenHash, input.provider || null, input.externalInteractionId || null, usedAt],
        client,
      )
      if (!selected) return null
      const interaction = channelInteractionFromRow(selected)
      if (input.command.sessionId !== interaction.sessionId) {
        throw new Error('Channel interaction command session does not match interaction session.')
      }
      await this.requireTenantUser(input.command.tenantId, input.command.userId, client)
      await this.requireSession(input.command.tenantId, input.command.sessionId, client, true)
      const payload = input.command.payload || {}
      const existingCommand = await this.maybeOne(
        `SELECT * FROM cloud_session_commands WHERE command_id = $1`,
        [input.command.commandId],
        client,
      )
      let command: SessionCommandRecord
      if (existingCommand) {
        command = commandFromRow(existingCommand)
        if (
          command.tenantId !== input.command.tenantId
          || command.userId !== input.command.userId
          || command.sessionId !== input.command.sessionId
          || command.kind !== input.command.kind
          || command.targetLeaseToken !== (input.command.targetLeaseToken ?? null)
          || stableJson(command.payload) !== stableJson(payload)
        ) {
          throw new Error(`Command id ${input.command.commandId} was reused with different content.`)
        }
      } else {
        const createdAt = nowIso(input.command.createdAt)
        const sequence = await this.incrementSessionCounter(
          client,
          input.command.tenantId,
          input.command.sessionId,
          'next_command_sequence',
        )
        const commandResult = await client.query(
          `INSERT INTO cloud_session_commands (
            command_id, tenant_id, user_id, session_id, kind, payload,
            target_lease_token, created_sequence, created_at, status
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
           RETURNING *`,
          [
            input.command.commandId,
            input.command.tenantId,
            input.command.userId,
            input.command.sessionId,
            input.command.kind,
            JSON.stringify(payload),
            input.command.targetLeaseToken ?? null,
            sequence,
            createdAt,
          ],
        )
        command = commandFromRow(commandResult.rows[0])
      }
      const updated = await client.query(
        `UPDATE cloud_channel_interactions
         SET status = 'used', used_at = $2, updated_at = $2
         WHERE interaction_id = $1
         RETURNING *`,
        [interaction.interactionId, usedAt],
      )
      const resolvedInteraction = channelInteractionFromRow(updated.rows[0])
      await this.recordAuditEventWithExecutor(client, {
        orgId: resolvedInteraction.orgId,
        actorType: 'system',
        actorId: input.identityId,
        eventType: 'channel_interaction.used',
        targetType: 'channel_interaction',
        targetId: resolvedInteraction.interactionId,
        metadata: { kind: resolvedInteraction.kind, targetId: resolvedInteraction.targetId },
        createdAt: input.usedAt,
      })
      return { interaction: resolvedInteraction, command }
    })
  }

  async createChannelDelivery(input: CreateChannelDeliveryInput) {
    const now = nowIso(input.createdAt)
    const result = await this.pool.query(
      `INSERT INTO cloud_channel_deliveries (
        delivery_id, org_id, agent_id, channel_binding_id, session_binding_id,
        provider, target, event_type, payload, status, attempt_count,
        claimed_by, claim_expires_at, next_attempt_at, last_error, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, 0, NULL, NULL, $11, NULL, $12, $12)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING *`,
      [
        input.deliveryId,
        input.orgId,
        input.agentId,
        input.channelBindingId,
        input.sessionBindingId || null,
        normalizeProvider(input.provider),
        JSON.stringify(normalizeRecord(input.target, 'Channel delivery target')),
        normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery event type'),
        JSON.stringify(normalizeRecord(input.payload, 'Channel delivery payload')),
        input.status || 'pending',
        (input.nextAttemptAt || input.createdAt || new Date()).toISOString(),
        now,
      ],
    )
    const row = result.rows[0] || await this.one(
      `SELECT * FROM cloud_channel_deliveries WHERE org_id = $1 AND delivery_id = $2`,
      [input.orgId, input.deliveryId],
    )
    return channelDeliveryFromRow(row)
  }

  async claimNextChannelDelivery(input: ClaimChannelDeliveryInput) {
    return this.withTransaction(async (client) => {
      const now = input.now || new Date()
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_channel_deliveries
         WHERE org_id = $1
           AND (
             (status = 'pending' AND next_attempt_at <= $2)
             OR (status = 'failed' AND next_attempt_at <= $2)
             OR (status = 'claimed' AND claim_expires_at <= $2)
           )
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [input.orgId, now.toISOString()],
        client,
      )
      if (!selected) return null
      const result = await client.query(
        `UPDATE cloud_channel_deliveries
         SET status = 'claimed',
             claimed_by = $2,
             claim_expires_at = $3,
             attempt_count = attempt_count + 1,
             updated_at = $4
         WHERE delivery_id = $1
         RETURNING *`,
        [
          String(selected.delivery_id),
          normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery claimant'),
          new Date(now.getTime() + (input.ttlMs || 30_000)).toISOString(),
          now.toISOString(),
        ],
      )
      return channelDeliveryFromRow(result.rows[0])
    })
  }

  async ackChannelDelivery(input: AckChannelDeliveryInput) {
    const result = await this.pool.query(
      `UPDATE cloud_channel_deliveries
       SET status = $3,
           claimed_by = NULL,
           claim_expires_at = NULL,
           last_error = $4,
           next_attempt_at = $5,
           updated_at = $6
       WHERE org_id = $1
         AND delivery_id = $2
         AND ($7::text IS NULL OR claimed_by = $7)
       RETURNING *`,
      [
        input.orgId,
        input.deliveryId,
        input.status,
        input.lastError ? normalizeText(input.lastError, CHANNEL_DELIVERY_ERROR_MAX_LENGTH, 'Delivery error') : null,
        (input.nextAttemptAt || input.updatedAt || new Date()).toISOString(),
        nowIso(input.updatedAt),
        input.claimedBy || null,
      ],
    )
    return result.rows[0] ? channelDeliveryFromRow(result.rows[0]) : null
  }

  async createSession(input: {
    tenantId: string
    userId: string
    sessionId: string
    opencodeSessionId: string
    profileName: string
    title?: string | null
    createdAt?: Date
  }) {
    await this.requireTenantUser(input.tenantId, input.userId)
    const createdAt = nowIso(input.createdAt)
    await this.pool.query(
      `INSERT INTO cloud_sessions (
        tenant_id, session_id, user_id, opencode_session_id, profile_name,
        status, title, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, 'idle', $6, $7, $7)
       ON CONFLICT (tenant_id, session_id) DO NOTHING`,
      [
        input.tenantId,
        input.sessionId,
        input.userId,
        input.opencodeSessionId,
        input.profileName,
        input.title || null,
        createdAt,
      ],
    )
    return sessionFromRow(await this.requireSession(input.tenantId, input.sessionId))
  }

  async getSession(tenantId: string, userId: string, sessionId: string) {
    await this.requireTenantUser(tenantId, userId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
      [tenantId, userId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async getSessionForTenant(tenantId: string, sessionId: string) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async findSession(sessionId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE session_id = $1 OR opencode_session_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async listSessions(tenantId: string, userId: string) {
    await this.requireTenantUser(tenantId, userId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY updated_at DESC, session_id`,
      [tenantId, userId],
    )
    return result.rows.map(sessionFromRow)
  }

  async listAllSessions() {
    const result = await this.pool.query(
      `SELECT * FROM cloud_sessions ORDER BY updated_at DESC, tenant_id, session_id`,
    )
    return result.rows.map(sessionFromRow)
  }

  async bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    updatedAt?: Date
  }) {
    const updatedAt = nowIso(input.updatedAt)
    const result = await this.pool.query(
      `UPDATE cloud_sessions
       SET opencode_session_id = $3,
           title = CASE WHEN $4::boolean THEN $5 ELSE title END,
           updated_at = $6
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING *`,
      [
        input.tenantId,
        input.sessionId,
        input.opencodeSessionId,
        input.title !== undefined,
        input.title ?? null,
        updatedAt,
      ],
    )
    if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
    return sessionFromRow(result.rows[0])
  }

  async updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    updatedAt?: Date
  }) {
    const updatedAt = nowIso(input.updatedAt)
    const result = await this.pool.query(
      `UPDATE cloud_sessions
       SET status = $3,
           title = CASE WHEN $4::boolean THEN $5 ELSE title END,
           updated_at = $6
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING *`,
      [
        input.tenantId,
        input.sessionId,
        input.status,
        input.title !== undefined,
        input.title ?? null,
        updatedAt,
      ],
    )
    if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
    return sessionFromRow(result.rows[0])
  }

  async appendSessionEvent(input: {
    tenantId: string
    sessionId: string
    eventId?: string
    type: string
    payload?: Record<string, unknown>
    createdAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      const payload = input.payload || {}
      if (input.eventId) {
        const existing = await this.findEvent(input.tenantId, input.sessionId, input.eventId, client)
        if (existing) return this.replayOrRejectEvent(existing, input.type, payload)
      }
      const createdAt = nowIso(input.createdAt)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_event_sequence',
        createdAt,
      )
      const eventId = input.eventId || `${input.sessionId}:${sequence}`
      const inserted = await client.query(
        `INSERT INTO cloud_session_events (
          tenant_id, session_id, event_id, sequence, type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [input.tenantId, input.sessionId, eventId, sequence, input.type, JSON.stringify(payload), createdAt],
      )
      return eventFromRow(inserted.rows[0])
    })
  }

  async listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0) {
    await this.requireSession(tenantId, sessionId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND sequence > $3
       ORDER BY sequence`,
      [tenantId, sessionId, afterSequence],
    )
    return result.rows.map(eventFromRow)
  }

  async appendWorkspaceEvent(input: AppendWorkspaceEventInput) {
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      if (input.sessionId) {
        const session = await this.requireSession(input.tenantId, input.sessionId, client, true)
        if (String(session.user_id) !== input.userId) {
          throw new Error(`Session ${input.sessionId} does not belong to user ${input.userId}.`)
        }
      }

      const payload = input.payload || {}
      const sessionId = input.sessionId || null
      const entityType = optionalTrimmedText(input.entityType) || (sessionId ? 'session' : 'workspace')
      const entityId = optionalTrimmedText(input.entityId) || sessionId || input.userId
      const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
      await client.query(
        `INSERT INTO cloud_workspace_event_counters (tenant_id, user_id, next_sequence)
         VALUES ($1, $2, 0)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [input.tenantId, input.userId],
      )
      const counter = await this.one(
        `SELECT next_sequence
         FROM cloud_workspace_event_counters
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.tenantId, input.userId],
        client,
      )
      if (input.eventId) {
        const existing = await this.findWorkspaceEvent(input.tenantId, input.userId, input.eventId, client)
        if (existing) {
          const projectionVersion = Number.isFinite(input.projectionVersion)
            ? Math.max(0, Math.floor(input.projectionVersion || 0))
            : existing.projectionVersion
          return this.replayOrRejectWorkspaceEvent(existing, input.type, payload, {
            sessionId,
            entityType,
            entityId,
            operation,
            projectionVersion,
          })
        }
      }

      const sequence = numberValue(counter.next_sequence) + 1
      const eventId = input.eventId || `${input.userId}:${sequence}`
      const projectionVersion = Number.isFinite(input.projectionVersion)
        ? Math.max(0, Math.floor(input.projectionVersion || 0))
        : sequence
      await client.query(
        `UPDATE cloud_workspace_event_counters
         SET next_sequence = $3
         WHERE tenant_id = $1 AND user_id = $2`,
        [input.tenantId, input.userId, sequence],
      )
      const createdAt = nowIso(input.createdAt)
      const inserted = await client.query(
        `INSERT INTO cloud_workspace_events (
          tenant_id, user_id, event_id, sequence, session_id,
          entity_type, entity_id, operation, projection_version,
          type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [
          input.tenantId,
          input.userId,
          eventId,
          sequence,
          sessionId,
          entityType,
          entityId,
          operation,
          projectionVersion,
          input.type,
          JSON.stringify(payload),
          createdAt,
        ],
      )
      return workspaceEventFromRow(inserted.rows[0])
    })
  }

  async listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0) {
    await this.requireTenantUser(tenantId, userId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND sequence > $3
       ORDER BY sequence`,
      [tenantId, userId, afterSequence],
    )
    return result.rows.map(workspaceEventFromRow)
  }

  async writeSessionProjection(input: {
    tenantId: string
    sessionId: string
    sequence: number
    view: Record<string, unknown>
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      const lease = await this.getLease(input.tenantId, input.sessionId, client, true)
      if (lease && lease.leaseToken !== (input.leaseToken ?? null)) {
        throw new Error('Projection write used a stale worker lease.')
      }
      const currentRow = await this.maybeOne(
        `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      const current = currentRow ? projectionFromRow(currentRow) : null
      if (input.sequence < (current?.sequence || 0)) {
        throw new Error('Projection sequence must be monotonic.')
      }
      if (input.sequence === current?.sequence) {
        if (stableJson(current.view) !== stableJson(input.view)) {
          throw new Error('Projection sequence was reused with different content.')
        }
        return current
      }
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_session_projections (tenant_id, session_id, sequence, view, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET sequence = EXCLUDED.sequence, view = EXCLUDED.view, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.tenantId, input.sessionId, input.sequence, JSON.stringify(input.view), updatedAt],
      )
      await client.query(
        `UPDATE cloud_sessions SET updated_at = $3 WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId, updatedAt],
      )
      return projectionFromRow(result.rows[0])
    })
  }

  async getSessionProjection(tenantId: string, sessionId: string) {
    await this.requireSession(tenantId, sessionId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? projectionFromRow(row) : null
  }

  async claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
  ) {
    return this.withTransaction(async (client) => {
      const session = await this.requireSession(tenantId, sessionId, client, true)
      const lease = await this.getLease(tenantId, sessionId, client, true)
      const nowMs = now.getTime()
      if (lease && lease.leaseExpiresAt > nowMs) return null
      const attempt = numberValue(session.next_lease_attempt) + 1
      const leaseRecord: WorkerLeaseRecord = {
        tenantId,
        sessionId,
        leasedBy: workerId,
        leaseToken: `${tenantId}:${sessionId}:${attempt}:${workerId}`,
        leaseExpiresAt: nowMs + ttlMs,
        checkpointVersion: lease?.checkpointVersion || 0,
      }
      await client.query(
        `UPDATE cloud_sessions
         SET next_lease_attempt = $3, status = 'running', updated_at = $4
         WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId, attempt, now.toISOString()],
      )
      const result = await client.query(
        `INSERT INTO cloud_worker_leases (
          tenant_id, session_id, leased_by, lease_token, lease_expires_at_ms, checkpoint_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET leased_by = EXCLUDED.leased_by,
             lease_token = EXCLUDED.lease_token,
             lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
             checkpoint_version = EXCLUDED.checkpoint_version
         RETURNING *`,
        [
          tenantId,
          sessionId,
          leaseRecord.leasedBy,
          leaseRecord.leaseToken,
          leaseRecord.leaseExpiresAt,
          leaseRecord.checkpointVersion,
        ],
      )
      return leaseFromRow(result.rows[0])
    })
  }

  async renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET lease_expires_at_ms = $3
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId, now.getTime() + ttlMs],
      )
      return leaseFromRow(result.rows[0])
    })
  }

  async checkpointSession(lease: WorkerLeaseRecord) {
    return this.withTransaction(async (client) => {
      const current = await this.assertCurrentLease(lease, client)
      if (lease.checkpointVersion !== current.checkpointVersion) {
        throw new Error('Checkpoint version is stale.')
      }
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET checkpoint_version = checkpoint_version + 1
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId],
      )
      return leaseFromRow(result.rows[0])
    })
  }

  async enqueueSessionCommand(input: {
    commandId: string
    tenantId: string
    userId: string
    sessionId: string
    kind: SessionCommandRecord['kind']
    payload?: Record<string, unknown>
    targetLeaseToken?: string | null
    createdAt?: Date
  }) {
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      const payload = input.payload || {}
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_session_commands WHERE command_id = $1`,
        [input.commandId],
        client,
      )
      if (existing) {
        const command = commandFromRow(existing)
        if (
          command.tenantId !== input.tenantId
          || command.userId !== input.userId
          || command.sessionId !== input.sessionId
          || command.kind !== input.kind
          || command.targetLeaseToken !== (input.targetLeaseToken ?? null)
          || stableJson(command.payload) !== stableJson(payload)
        ) {
          throw new Error(`Command id ${input.commandId} was reused with different content.`)
        }
        return command
      }
      const createdAt = nowIso(input.createdAt)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_command_sequence',
      )
      const result = await client.query(
        `INSERT INTO cloud_session_commands (
          command_id, tenant_id, user_id, session_id, kind, payload,
          target_lease_token, created_sequence, created_at, status
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
         RETURNING *`,
        [
          input.commandId,
          input.tenantId,
          input.userId,
          input.sessionId,
          input.kind,
          JSON.stringify(payload),
          input.targetLeaseToken ?? null,
          sequence,
          createdAt,
        ],
      )
      return commandFromRow(result.rows[0])
    })
  }

  async claimNextSessionCommand(lease: WorkerLeaseRecord) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_session_commands
         WHERE tenant_id = $1
           AND session_id = $2
           AND (
             (status = 'pending' AND (target_lease_token IS NULL OR target_lease_token = $3))
             OR (status = 'running' AND claimed_lease_token <> $3 AND target_lease_token IS NULL)
           )
         ORDER BY created_sequence
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [lease.tenantId, lease.sessionId, lease.leaseToken],
        client,
      )
      if (!selected) return null
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'running', claimed_by = $2, claimed_lease_token = $3
         WHERE command_id = $1
         RETURNING *`,
        [String(selected.command_id), lease.leasedBy, lease.leaseToken],
      )
      return commandFromRow(result.rows[0])
    })
  }

  async ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status === 'acked') return command
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'acked', acked_at = $2, error = NULL
         WHERE command_id = $1
         RETURNING *`,
        [commandId, now.toISOString()],
      )
      return commandFromRow(result.rows[0])
    })
  }

  async failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string) {
    return this.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'failed', error = $2
         WHERE command_id = $1
         RETURNING *`,
        [commandId, error],
      )
      return commandFromRow(result.rows[0])
    })
  }

  async recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }) {
    const result = await this.pool.query(
      `INSERT INTO cloud_worker_heartbeats (worker_id, role, active_session_ids, last_seen_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (worker_id) DO UPDATE
       SET role = EXCLUDED.role,
           active_session_ids = EXCLUDED.active_session_ids,
           last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        input.workerId,
        input.role,
        JSON.stringify([...new Set(input.activeSessionIds || [])]),
        nowIso(input.now),
      ],
    )
    return heartbeatFromRow(result.rows[0])
  }

  async listWorkerHeartbeats() {
    const result = await this.pool.query(
      `SELECT * FROM cloud_worker_heartbeats ORDER BY worker_id`,
    )
    return result.rows.map(heartbeatFromRow)
  }

  async setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }) {
    await this.requireTenant(input.tenantId)
    if (input.userId) await this.requireTenantUser(input.tenantId, input.userId)
    const result = await this.pool.query(
      `INSERT INTO cloud_setting_metadata (
        tenant_id, user_scope, user_id, key, value, updated_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (tenant_id, user_scope, key) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.tenantId,
        input.userId || '',
        input.userId || null,
        input.key,
        JSON.stringify(input.value),
        nowIso(input.updatedAt),
      ],
    )
    return settingFromRow(result.rows[0])
  }

  async getSettingMetadata(tenantId: string, keyName: string, userId?: string | null) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_setting_metadata
       WHERE tenant_id = $1 AND user_scope = $2 AND key = $3`,
      [tenantId, userId || '', keyName],
    )
    return row ? settingFromRow(row) : null
  }

  async listSettingMetadata(tenantId: string, userId?: string | null) {
    await this.requireTenant(tenantId)
    if (userId) await this.requireTenantUser(tenantId, userId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_setting_metadata
       WHERE tenant_id = $1 AND user_scope = $2
       ORDER BY key`,
      [tenantId, userId || ''],
    )
    return result.rows.map(settingFromRow)
  }

  async createWorkflow(input: CreateWorkflowInput) {
    await this.requireTenantUser(input.tenantId, input.userId)
    const createdAt = nowIso(input.createdAt)
    const draft = input.draft
    await this.pool.query(
      `INSERT INTO cloud_workflows (
        tenant_id, workflow_id, user_id, title, instructions, agent_name,
        skill_names, tool_ids, status, project_directory, draft_session_id,
        triggers, created_at, updated_at, next_run_at, last_run_at,
        latest_run_id, latest_run_status, latest_run_session_id, latest_run_summary
       )
       VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8::jsonb, 'active', $9, $10,
        $11::jsonb, $12, $12, $13, NULL,
        NULL, NULL, NULL, NULL
       )
       ON CONFLICT (tenant_id, workflow_id) DO NOTHING`,
      [
        input.tenantId,
        input.workflowId,
        input.userId,
        draft.title,
        draft.instructions,
        draft.agentName,
        JSON.stringify(draft.skillNames || []),
        JSON.stringify(draft.toolIds || []),
        draft.projectDirectory || null,
        draft.draftSessionId || null,
        JSON.stringify(draft.triggers),
        createdAt,
        input.nextRunAt || null,
      ],
    )
    return workflowFromRow(await this.requireWorkflow(input.tenantId, input.workflowId))
  }

  async findWorkflow(workflowId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE workflow_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async listWorkflows(tenantId: string, userId: string) {
    await this.requireTenantUser(tenantId, userId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_workflows
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY updated_at DESC, workflow_id`,
      [tenantId, userId],
    )
    return result.rows.map(workflowFromRow)
  }

  async getWorkflow(tenantId: string, userId: string, workflowId: string) {
    await this.requireTenantUser(tenantId, userId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3`,
      [tenantId, userId, workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async getWorkflowForTenant(tenantId: string, workflowId: string) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows WHERE tenant_id = $1 AND workflow_id = $2`,
      [tenantId, workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async updateWorkflowStatus(input: UpdateWorkflowStatusInput) {
    await this.requireTenantUser(input.tenantId, input.userId)
    const result = await this.pool.query(
      `UPDATE cloud_workflows
       SET status = $4,
           next_run_at = $5,
           updated_at = $6
       WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3
       RETURNING *`,
      [
        input.tenantId,
        input.userId,
        input.workflowId,
        input.status,
        input.nextRunAt || null,
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? workflowFromRow(result.rows[0]) : null
  }

  async listWorkflowRuns(tenantId: string, workflowId: string, limit = 25) {
    await this.requireWorkflow(tenantId, workflowId)
    const boundedLimit = Math.min(Math.max(1, limit), WORKFLOW_RUN_LIST_LIMIT)
    const result = await this.pool.query(
      `SELECT * FROM cloud_workflow_runs
       WHERE tenant_id = $1 AND workflow_id = $2
       ORDER BY created_at DESC, run_id
       LIMIT $3`,
      [tenantId, workflowId, boundedLimit],
    )
    return result.rows.map(workflowRunFromRow)
  }

  async createWorkflowRun(input: CreateWorkflowRunInput) {
    return this.withTransaction(async (client) => {
      await this.requireTenantUser(input.tenantId, input.userId, client)
      const workflow = workflowFromRow(await this.requireWorkflow(input.tenantId, input.workflowId, client, true))
      if (workflow.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_workflow_runs WHERE tenant_id = $1 AND run_id = $2`,
        [input.tenantId, input.runId],
        client,
      )
      if (existing) return workflowRunFromRow(existing)
      this.assertWorkflowRunnable(workflow)
      const createdAt = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_workflow_runs (
          tenant_id, run_id, workflow_id, user_id, session_id, trigger_type,
          trigger_payload, status, title, summary, error, created_at, started_at, finished_at
         )
         VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, 'queued', $7, NULL, NULL, $8, NULL, NULL)
         RETURNING *`,
        [
          input.tenantId,
          input.runId,
          input.workflowId,
          input.userId,
          input.triggerType,
          input.triggerPayload ? JSON.stringify(input.triggerPayload) : null,
          `Run ${workflow.title}`,
          createdAt,
        ],
      )
      await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'queued',
             updated_at = $4
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [input.tenantId, input.workflowId, input.runId, createdAt],
      )
      return workflowRunFromRow(result.rows[0])
    })
  }

  async claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): Promise<ClaimedWorkflowRunRecord | null> {
    return this.withTransaction(async (client) => {
      const now = input.now || new Date()
      const claimedAt = now.toISOString()
      const row = await this.maybeOne(
        `SELECT * FROM cloud_workflows
         WHERE status = 'active'
           AND next_run_at IS NOT NULL
           AND next_run_at <= $1
         ORDER BY next_run_at ASC, tenant_id, workflow_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [claimedAt],
        client,
      )
      if (!row) return null
      const workflow = workflowFromRow(row)
      const result = await client.query(
        `INSERT INTO cloud_workflow_runs (
          tenant_id, run_id, workflow_id, user_id, session_id, trigger_type,
          trigger_payload, status, title, summary, error, created_at, started_at, finished_at
         )
         VALUES (
          $1, $2, $3, $4, NULL, 'schedule',
          $5::jsonb, 'queued', $6, NULL, NULL, $7, NULL, NULL
         )
         RETURNING *`,
        [
          workflow.tenantId,
          input.runId,
          workflow.id,
          workflow.userId,
          JSON.stringify({ source: 'schedule', scheduledFor: workflow.nextRunAt }),
          `Run ${workflow.title}`,
          claimedAt,
        ],
      )
      const updatedWorkflow = await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'queued',
             updated_at = $4
         WHERE tenant_id = $1 AND workflow_id = $2
         RETURNING *`,
        [workflow.tenantId, workflow.id, input.runId, claimedAt],
      )
      return {
        workflow: workflowFromRow(updatedWorkflow.rows[0]),
        run: workflowRunFromRow(result.rows[0]),
      }
    })
  }

  async attachWorkflowRunSession(input: AttachWorkflowRunSessionInput) {
    return this.withTransaction(async (client) => {
      await this.requireWorkflow(input.tenantId, input.workflowId, client, true)
      const startedAt = nowIso(input.startedAt)
      const result = await client.query(
        `UPDATE cloud_workflow_runs
         SET session_id = $4,
             status = 'running',
             started_at = COALESCE(started_at, $5)
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         RETURNING *`,
        [input.tenantId, input.workflowId, input.runId, input.sessionId, startedAt],
      )
      if (!result.rows[0]) return null
      await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'running',
             latest_run_session_id = $4,
             updated_at = $5
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [input.tenantId, input.workflowId, input.runId, input.sessionId, startedAt],
      )
      return workflowRunFromRow(result.rows[0])
    })
  }

  async completeWorkflowRun(input: CompleteWorkflowRunInput) {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'completed',
      summary: input.summary,
      error: null,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      finishedAt: input.finishedAt,
    })
  }

  async failWorkflowRun(input: FailWorkflowRunInput) {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'failed',
      summary: input.error,
      error: input.error,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      finishedAt: input.finishedAt,
    })
  }

  async getWorkflowRun(tenantId: string, runId: string) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflow_runs WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    )
    return row ? workflowRunFromRow(row) : null
  }

  async getWorkflowRunBySession(tenantId: string, sessionId: string) {
    await this.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflow_runs
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, sessionId],
    )
    return row ? workflowRunFromRow(row) : null
  }

  async listThreadTags(tenantId: string) {
    await this.requireTenant(tenantId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_thread_tags
       WHERE tenant_id = $1
       ORDER BY lower(name), tag_id`,
      [tenantId],
    )
    return result.rows.map(threadTagFromRow)
  }

  async createThreadTag(input: CreateThreadTagInput) {
    await this.requireTenant(input.tenantId)
    const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = normalizeTagColor(input.color)
    const createdAt = nowIso(input.createdAt)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [input.tenantId, input.tagId],
    )
    if (existing) {
      const tag = threadTagFromRow(existing)
      if (tag.name !== name || tag.color !== color) {
        throw new Error(`Tag id ${input.tagId} was reused with different content.`)
      }
      return tag
    }
    const result = await this.pool.query(
      `INSERT INTO cloud_thread_tags (tenant_id, tag_id, name, color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [input.tenantId, input.tagId, name, color, createdAt],
    )
    return threadTagFromRow(result.rows[0])
  }

  async updateThreadTag(input: UpdateThreadTagInput) {
    await this.requireTenant(input.tenantId)
    const name = normalizeOptionalText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = input.color === undefined ? undefined : normalizeTagColor(input.color)
    const result = await this.pool.query(
      `UPDATE cloud_thread_tags
       SET name = COALESCE($3, name),
           color = COALESCE($4, color),
           updated_at = $5
       WHERE tenant_id = $1 AND tag_id = $2
       RETURNING *`,
      [input.tenantId, input.tagId, name ?? null, color ?? null, nowIso(input.updatedAt)],
    )
    return result.rows[0] ? threadTagFromRow(result.rows[0]) : null
  }

  async deleteThreadTag(tenantId: string, tagId: string) {
    await this.requireTenant(tenantId)
    const result = await this.pool.query(
      `DELETE FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [tenantId, tagId],
    ) as QueryResult & { rowCount?: number }
    return Number(result.rowCount || 0) > 0
  }

  async applyThreadTags(input: ThreadTagLinkInput) {
    await this.withTransaction(async (client) => {
      await this.requireTenant(input.tenantId, client)
      const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
      const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      for (const sessionId of sessionIds) await this.requireSession(input.tenantId, sessionId, client)
      for (const tagId of tagIds) await this.requireThreadTag(input.tenantId, tagId, client)
      const createdAt = nowIso(input.createdAt)
      for (const sessionId of sessionIds) {
        for (const tagId of tagIds) {
          await client.query(
            `INSERT INTO cloud_thread_tag_links (tenant_id, session_id, tag_id, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, session_id, tag_id) DO NOTHING`,
            [input.tenantId, sessionId, tagId, createdAt],
          )
        }
      }
    })
  }

  async removeThreadTags(input: ThreadTagLinkInput) {
    await this.withTransaction(async (client) => {
      await this.requireTenant(input.tenantId, client)
      const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
      const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      for (const sessionId of sessionIds) await this.requireSession(input.tenantId, sessionId, client)
      for (const tagId of tagIds) await this.requireThreadTag(input.tenantId, tagId, client)
      if (sessionIds.length === 0 || tagIds.length === 0) return
      await client.query(
        `DELETE FROM cloud_thread_tag_links
         WHERE tenant_id = $1
           AND session_id = ANY($2::text[])
           AND tag_id = ANY($3::text[])`,
        [input.tenantId, sessionIds, tagIds],
      )
    })
  }

  async listThreadSmartFilters(tenantId: string) {
    await this.requireTenant(tenantId)
    const result = await this.pool.query(
      `SELECT * FROM cloud_thread_smart_filters
       WHERE tenant_id = $1
       ORDER BY lower(name), filter_id`,
      [tenantId],
    )
    return result.rows.map(threadSmartFilterFromRow)
  }

  async createThreadSmartFilter(input: CreateThreadSmartFilterInput) {
    await this.requireTenant(input.tenantId)
    const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = normalizeThreadQuery(input.query)
    const createdAt = nowIso(input.createdAt)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_thread_smart_filters WHERE tenant_id = $1 AND filter_id = $2`,
      [input.tenantId, input.filterId],
    )
    if (existing) {
      const filter = threadSmartFilterFromRow(existing)
      if (filter.name !== name || stableJson(filter.query) !== stableJson(query)) {
        throw new Error(`Smart filter id ${input.filterId} was reused with different content.`)
      }
      return filter
    }
    const result = await this.pool.query(
      `INSERT INTO cloud_thread_smart_filters (tenant_id, filter_id, name, query, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)
       RETURNING *`,
      [input.tenantId, input.filterId, name, JSON.stringify(query), createdAt],
    )
    return threadSmartFilterFromRow(result.rows[0])
  }

  async updateThreadSmartFilter(input: UpdateThreadSmartFilterInput) {
    await this.requireTenant(input.tenantId)
    const name = normalizeOptionalText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = input.query === undefined ? undefined : normalizeThreadQuery(input.query)
    const result = await this.pool.query(
      `UPDATE cloud_thread_smart_filters
       SET name = COALESCE($3, name),
           query = COALESCE($4::jsonb, query),
           updated_at = $5
       WHERE tenant_id = $1 AND filter_id = $2
       RETURNING *`,
      [
        input.tenantId,
        input.filterId,
        name ?? null,
        query === undefined ? null : JSON.stringify(query),
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? threadSmartFilterFromRow(result.rows[0]) : null
  }

  async deleteThreadSmartFilter(tenantId: string, filterId: string) {
    await this.requireTenant(tenantId)
    const result = await this.pool.query(
      `DELETE FROM cloud_thread_smart_filters WHERE tenant_id = $1 AND filter_id = $2`,
      [tenantId, filterId],
    ) as QueryResult & { rowCount?: number }
    return Number(result.rowCount || 0) > 0
  }

  async listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): Promise<ThreadMetadataRecord[]> {
    await this.requireTenantUser(input.tenantId, input.userId)
    const tagIds = input.tagIds
      ? normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      : []
    const limit = Number.isInteger(input.limit) && input.limit && input.limit > 0
      ? Math.min(input.limit, THREAD_BULK_MAX_SESSION_IDS)
      : THREAD_BULK_MAX_SESSION_IDS
    const result = tagIds.length > 0
      ? await this.pool.query(
        `SELECT * FROM cloud_sessions s
         WHERE s.tenant_id = $1
           AND s.user_id = $2
           AND EXISTS (
             SELECT 1 FROM cloud_thread_tag_links link
             WHERE link.tenant_id = s.tenant_id
               AND link.session_id = s.session_id
               AND link.tag_id = ANY($3::text[])
           )
         ORDER BY s.updated_at DESC, s.session_id
         LIMIT $4`,
        [input.tenantId, input.userId, tagIds, limit],
      )
      : await this.pool.query(
        `SELECT * FROM cloud_sessions
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY updated_at DESC, session_id
         LIMIT $3`,
        [input.tenantId, input.userId, limit],
      )
    return Promise.all(result.rows.map(async (row) => {
      const session = sessionFromRow(row)
      return {
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId: session.sessionId,
        title: session.title,
        profileName: session.profileName,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        tags: await this.listThreadTagsForSession(session.tenantId, session.sessionId),
      }
    }))
  }

  async recordSchemaMigration(id: string, appliedAt = new Date()) {
    await this.pool.query(
      `INSERT INTO cloud_schema_migrations (id, applied_at)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, appliedAt.toISOString()],
    )
    const row = await this.one(
      `SELECT * FROM cloud_schema_migrations WHERE id = $1`,
      [id],
    )
    return migrationFromRow(row)
  }

  async listSchemaMigrations() {
    const result = await this.pool.query(
      `SELECT * FROM cloud_schema_migrations ORDER BY applied_at, id`,
    )
    return result.rows.map(migrationFromRow)
  }

  async claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }) {
    const result = await this.pool.query(
      `INSERT INTO cloud_webhook_rate_limits (source, window_started_at_ms, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (source) DO UPDATE
       SET window_started_at_ms = CASE
             WHEN $2 - cloud_webhook_rate_limits.window_started_at_ms > $3 THEN $2
             ELSE cloud_webhook_rate_limits.window_started_at_ms
           END,
           count = CASE
             WHEN $2 - cloud_webhook_rate_limits.window_started_at_ms > $3 THEN 1
             ELSE cloud_webhook_rate_limits.count + 1
           END
       RETURNING count`,
      [input.source, input.nowMs, input.windowMs],
    )
    return numberValue(result.rows[0]?.count) <= input.limit
  }

  async checkAuthBackoff(input: { scope: string, nowMs: number }) {
    const row = await this.maybeOne(
      `SELECT blocked_until_ms FROM cloud_webhook_auth_failures WHERE scope = $1`,
      [input.scope],
    )
    return !row || numberValue(row.blocked_until_ms) <= input.nowMs
  }

  async recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }) {
    const blockedUntil = input.nowMs + input.backoffMs
    const result = await this.pool.query(
      `INSERT INTO cloud_webhook_auth_failures (
        scope, source, auth_window_started_at_ms, auth_failure_count, blocked_until_ms
       )
       VALUES ($1, $2, $3, 1, CASE WHEN $5 <= 1 THEN $6 ELSE 0 END)
       ON CONFLICT (scope) DO UPDATE
       SET source = EXCLUDED.source,
           auth_window_started_at_ms = CASE
             WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN $3
             ELSE cloud_webhook_auth_failures.auth_window_started_at_ms
           END,
           auth_failure_count = CASE
             WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN 1
             ELSE cloud_webhook_auth_failures.auth_failure_count + 1
           END,
           blocked_until_ms = CASE
             WHEN (
               CASE
                 WHEN $3 - cloud_webhook_auth_failures.auth_window_started_at_ms > $4 THEN 1
                 ELSE cloud_webhook_auth_failures.auth_failure_count + 1
               END
             ) >= $5 THEN GREATEST(cloud_webhook_auth_failures.blocked_until_ms, $6)
             ELSE cloud_webhook_auth_failures.blocked_until_ms
           END
       RETURNING *`,
      [input.scope, input.source, input.nowMs, input.windowMs, input.limit, blockedUntil],
    )
    return webhookAuthFailureFromRow(result.rows[0])
  }

  async claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }): Promise<WorkflowWebhookReplayClaim | null> {
    const claimed = await this.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM cloud_webhook_replay_claims WHERE $1 - seen_at_ms > $2`,
        [input.nowMs, input.windowMs],
      )
      const result = await client.query(
        `INSERT INTO cloud_webhook_replay_claims (replay_key, seen_at_ms, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (replay_key) DO NOTHING
         RETURNING replay_key`,
        [input.key, input.nowMs],
      )
      await client.query(
        `DELETE FROM cloud_webhook_replay_claims
         WHERE replay_key IN (
           SELECT replay_key
           FROM cloud_webhook_replay_claims
           ORDER BY seen_at_ms ASC
           OFFSET $1
         )`,
        [input.cacheLimit],
      )
      return Boolean(result.rows[0])
    })
    if (!claimed) return null
    let active = true
    return {
      accept: async () => {
        if (!active) return
        active = false
        await this.pool.query(
          `UPDATE cloud_webhook_replay_claims
           SET status = 'accepted'
           WHERE replay_key = $1`,
          [input.key],
        )
      },
      release: async () => {
        if (!active) return
        active = false
        await this.pool.query(
          `DELETE FROM cloud_webhook_replay_claims
           WHERE replay_key = $1 AND status = 'pending'`,
          [input.key],
        )
      },
    }
  }

  async clear() {
    await this.pool.query('DELETE FROM cloud_webhook_replay_claims')
    await this.pool.query('DELETE FROM cloud_webhook_auth_failures')
    await this.pool.query('DELETE FROM cloud_webhook_rate_limits')
  }

  private async recordAuditEventWithExecutor(
    executor: PgExecutor,
    input: RecordAuditEventInput,
  ): Promise<AuditEventRecord> {
    const eventId = input.eventId || `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const result = await executor.query(
      `INSERT INTO cloud_audit_events (
        event_id, org_id, account_id, actor_type, actor_id,
        event_type, target_type, target_id, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        eventId,
        input.orgId,
        input.accountId || null,
        input.actorType,
        input.actorId || null,
        input.eventType,
        input.targetType || null,
        input.targetId || null,
        JSON.stringify(redactAuditMetadata(input.metadata)),
        nowIso(input.createdAt),
      ],
    )
    if (result.rows[0]) return auditEventFromRow(result.rows[0])
    const existing = await this.maybeOne(`SELECT * FROM cloud_audit_events WHERE event_id = $1`, [eventId], executor)
    if (!existing) throw new Error(`Audit event ${eventId} was not recorded.`)
    return auditEventFromRow(existing)
  }

  private async requireTenant(tenantId: string, executor: PgExecutor = this.pool) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_tenants WHERE tenant_id = $1`,
      [tenantId],
      executor,
    )
    if (!row) throw new Error(`Unknown tenant ${tenantId}.`)
    return tenantFromRow(row)
  }

  private async requireTenantUser(
    tenantId: string,
    userId: string,
    executor: PgExecutor = this.pool,
  ) {
    await this.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_users WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
      executor,
    )
    if (!row) throw new Error(`User ${userId} does not belong to tenant ${tenantId}.`)
    return userFromRow(row)
  }

  private async requireSession(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor = this.pool,
    forUpdate = false,
  ) {
    await this.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    if (!row) throw new Error(`Unknown session ${sessionId}.`)
    return row
  }

  private async requireWorkflow(
    tenantId: string,
    workflowId: string,
    executor: PgExecutor = this.pool,
    forUpdate = false,
  ) {
    await this.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE tenant_id = $1 AND workflow_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, workflowId],
      executor,
    )
    if (!row) throw new Error(`Unknown workflow ${workflowId}.`)
    return row
  }

  private assertWorkflowRunnable(workflow: CloudWorkflowRecord) {
    if (workflow.status === 'archived') throw new Error('Archived workflows cannot run.')
    if (workflow.status === 'paused') throw new Error('Paused workflows cannot run.')
    if (workflow.status === 'running') throw new Error('Workflow is already running.')
  }

  private async finishWorkflowRun(input: {
    tenantId: string
    workflowId: string
    runId: string
    status: Extract<WorkflowRunStatus, 'completed' | 'failed'>
    summary: string | null
    error: string | null
    nextStatus: WorkflowStatus
    nextRunAt: string | null
    finishedAt?: Date
  }): Promise<CloudWorkflowRunRecord | null> {
    return this.withTransaction(async (client) => {
      await this.requireWorkflow(input.tenantId, input.workflowId, client, true)
      const runRow = await this.maybeOne(
        `SELECT * FROM cloud_workflow_runs
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         FOR UPDATE`,
        [input.tenantId, input.workflowId, input.runId],
        client,
      )
      if (!runRow) return null
      const current = workflowRunFromRow(runRow)
      if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
        return current
      }
      const finishedAt = nowIso(input.finishedAt)
      const result = await client.query(
        `UPDATE cloud_workflow_runs
         SET status = $4,
             summary = $5,
             error = $6,
             finished_at = $7
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         RETURNING *`,
        [
          input.tenantId,
          input.workflowId,
          input.runId,
          input.status,
          input.summary,
          input.error,
          finishedAt,
        ],
      )
      await client.query(
        `UPDATE cloud_workflows
         SET status = $4,
             latest_run_id = $3,
             latest_run_status = $5,
             latest_run_summary = $6,
             last_run_at = CASE WHEN $5 = 'completed' THEN $7 ELSE last_run_at END,
             next_run_at = $8,
             updated_at = $7
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [
          input.tenantId,
          input.workflowId,
          input.runId,
          input.nextStatus,
          input.status,
          input.summary,
          finishedAt,
          input.nextRunAt,
        ],
      )
      return workflowRunFromRow(result.rows[0])
    })
  }

  private async requireThreadTag(
    tenantId: string,
    tagId: string,
    executor: PgExecutor = this.pool,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [tenantId, tagId],
      executor,
    )
    if (!row) throw new Error(`Unknown thread tag ${tagId}.`)
    return threadTagFromRow(row)
  }

  private async listThreadTagsForSession(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor = this.pool,
  ) {
    const result = await executor.query(
      `SELECT tag.*
       FROM cloud_thread_tags tag
       JOIN cloud_thread_tag_links link
         ON link.tenant_id = tag.tenant_id
        AND link.tag_id = tag.tag_id
       WHERE link.tenant_id = $1 AND link.session_id = $2
       ORDER BY lower(tag.name), tag.tag_id`,
      [tenantId, sessionId],
    )
    return result.rows.map(threadTagFromRow)
  }

  private async requireCommand(commandId: string, executor: PgExecutor, forUpdate = false) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_commands
       WHERE command_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [commandId],
      executor,
    )
    if (!row) throw new Error(`Unknown command ${commandId}.`)
    return commandFromRow(row)
  }

  private async assertCurrentLease(lease: WorkerLeaseRecord, executor: PgExecutor) {
    const current = await this.getLease(lease.tenantId, lease.sessionId, executor, true)
    if (!current || current.leaseToken !== lease.leaseToken) {
      throw new Error('Worker lease is stale.')
    }
    return current
  }

  private async getLease(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor,
    forUpdate = false,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_worker_leases
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    return row ? leaseFromRow(row) : null
  }

  private async findEvent(
    tenantId: string,
    sessionId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND event_id = $3`,
      [tenantId, sessionId, eventId],
      executor,
    )
    return row ? eventFromRow(row) : null
  }

  private async findWorkspaceEvent(
    tenantId: string,
    userId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND event_id = $3`,
      [tenantId, userId, eventId],
      executor,
    )
    return row ? workspaceEventFromRow(row) : null
  }

  private replayOrRejectEvent(
    existing: SessionEventRecord,
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (existing.type !== type || stableJson(existing.payload) !== stableJson(payload)) {
      throw new Error(`Event id ${existing.eventId} was reused with different content.`)
    }
    return existing
  }

  private replayOrRejectWorkspaceEvent(
    existing: WorkspaceEventRecord,
    type: string,
    payload: Record<string, unknown>,
    expected: {
      sessionId: string | null
      entityType: string
      entityId: string
      operation: string
      projectionVersion: number
    },
  ) {
    if (
      existing.type !== type
      || stableJson(existing.payload) !== stableJson(payload)
      || existing.sessionId !== expected.sessionId
      || existing.entityType !== expected.entityType
      || existing.entityId !== expected.entityId
      || existing.operation !== expected.operation
      || existing.projectionVersion !== expected.projectionVersion
    ) {
      throw new Error(`Workspace event id ${existing.eventId} was reused with different content.`)
    }
    return existing
  }

  private async incrementSessionCounter(
    executor: PgExecutor,
    tenantId: string,
    sessionId: string,
    field: 'next_event_sequence' | 'next_command_sequence',
    updatedAt?: string,
  ) {
    const setUpdatedAt = updatedAt ? ', updated_at = $3' : ''
    const values = updatedAt ? [tenantId, sessionId, updatedAt] : [tenantId, sessionId]
    const result = await executor.query(
      `UPDATE cloud_sessions
       SET ${field} = ${field} + 1${setUpdatedAt}
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING ${field}`,
      values,
    )
    return numberValue(result.rows[0]?.[field])
  }

  private async one<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }

  private async withTransaction<T>(fn: (client: PgClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

export async function createPostgresControlPlaneStore(options: PostgresControlPlaneStoreOptions) {
  return PostgresControlPlaneStore.connect(options)
}
