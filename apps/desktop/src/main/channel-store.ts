import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  COWORK_CHANNEL_DELIVERY_SCHEMA_VERSION,
  COWORK_CHANNEL_SCHEMA_VERSION,
  type ChannelActivationMode,
  type ChannelAuditState,
  type ChannelDefinition,
  type ChannelDefinitionDraft,
  type ChannelDeliveryDraft,
  type ChannelDeliveryProvider,
  type ChannelDeliveryRecord,
  type ChannelDeliveryStatus,
  type ChannelInboundDraft,
  type ChannelInboundItem,
  type ChannelInboundStatus,
  type ChannelListPayload,
  type ChannelProvider,
  type ChannelRoutePolicy,
  type LocalWebhookChannelPairing,
  type LocalWebhookChannelPairingResult,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { enqueueOperationalRun, getWorkspaceProfile } from './operational-queue-store.ts'

export const CHANNEL_STORE_SCHEMA_VERSION = 2
export const CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID = 'channel-sandbox'
const LOCAL_WEBHOOK_TOKEN_PREFIX = 'ocw_wh_'

const CHANNEL_SCHEMA_VERSION_KEY = 'schema_version'
const MAX_TEXT_BYTES = 16 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_JSON_BYTES = 128 * 1024
const CHANNEL_PROVIDERS = new Set<ChannelProvider>(['local_webhook', 'email', 'slack', 'teams'])
const CHANNEL_ACTIVATION_MODES = new Set<ChannelActivationMode>(['ignore', 'draft_reply', 'ask_user', 'run_sop', 'run_crew'])
const CHANNEL_INBOUND_STATUSES = new Set<ChannelInboundStatus>(['denied', 'received', 'drafted', 'needs_user', 'queued', 'dispatching', 'dispatched', 'failed'])
const CHANNEL_AUDIT_STATES = new Set<ChannelAuditState>([
  'denied_unknown_sender',
  'denied_channel_disabled',
  'ignored',
  'draft_created',
  'user_review_required',
  'queued_for_review',
  'execution_dispatching',
  'execution_dispatched',
  'dismissed',
  'failed',
])
type ChannelInboundRunKind = Exclude<ChannelInboundItem['runKind'], null>
const CHANNEL_INBOUND_RUN_KINDS = new Set<ChannelInboundRunKind>(['sop', 'crew'])
const CHANNEL_DELIVERY_PROVIDERS = new Set<ChannelDeliveryProvider>(['desktop_notification', 'email', 'slack', 'teams', 'webhook'])
const CHANNEL_DELIVERY_STATUSES = new Set<ChannelDeliveryStatus>(['draft', 'approval_required', 'sending', 'delivered', 'failed', 'cancelled'])
type ChannelDeliveryRunKind = Exclude<ChannelDeliveryRecord['runKind'], null>
const DELIVERY_RUN_KINDS = new Set<ChannelDeliveryRunKind>(['crew', 'sop', 'automation', 'channel'])

type DbRow = Record<string, unknown>

let channelDb: DatabaseSync | null = null
let channelTransactionCounter = 0

function getChannelDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'channels.sqlite')
}

function ensureChannelDbFileModes(dbPath = getChannelDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function readSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from channel_meta where key = ?')
    .get(CHANNEL_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function recordSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into channel_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(CHANNEL_SCHEMA_VERSION_KEY, String(CHANNEL_STORE_SCHEMA_VERSION))
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readSchemaVersion(db)
  if (version > CHANNEL_STORE_SCHEMA_VERSION) {
    throw new Error(`Channel store schema version ${version} is newer than supported version ${CHANNEL_STORE_SCHEMA_VERSION}.`)
  }
}

function channelInboundItemColumns(db: DatabaseSync) {
  const rows = db.prepare('pragma table_info(channel_inbound_items)').all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => String(row.name || '')))
}

function addChannelInboundColumnIfMissing(db: DatabaseSync, columns: Set<string>, columnName: string, definition: string) {
  if (columns.has(columnName)) return
  db.exec(`alter table channel_inbound_items add column ${columnName} ${definition}`)
}

function migrateChannelDb(db: DatabaseSync) {
  const columns = channelInboundItemColumns(db)
  addChannelInboundColumnIfMissing(db, columns, 'work_item_id', 'text')
  addChannelInboundColumnIfMissing(db, columns, 'routed_run_kind', 'text')
  addChannelInboundColumnIfMissing(db, columns, 'routed_run_id', 'text')
  addChannelInboundColumnIfMissing(db, columns, 'approved_at', 'text')
  addChannelInboundColumnIfMissing(db, columns, 'approved_by', 'text')
  addChannelInboundColumnIfMissing(db, columns, 'review_note', 'text')
}

export function getChannelDb() {
  if (channelDb) return channelDb
  const dbPath = getChannelDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    db.exec(`
      create table if not exists channel_meta (
        key text primary key,
        value text not null
      );
    `)
    assertSupportedSchemaVersion(db)
    db.exec(`
      create table if not exists channel_definitions (
        id text primary key,
        schema_version integer not null,
        provider text not null,
        name text not null,
        description text,
        source_key text not null,
        enabled integer not null,
        sender_allowlist_json text not null,
        allowed_capability_ids_json text not null,
        route_json text not null,
        workspace_profile_id text not null,
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists idx_channel_definitions_source
        on channel_definitions (provider, source_key);

      create table if not exists channel_inbound_items (
        id text primary key,
        schema_version integer not null,
        channel_id text not null,
        provider text not null,
        source_json text not null,
        sender text not null,
        subject text,
        body text not null,
        route_json text not null,
        status text not null,
        audit_state text not null,
        allowed_capability_ids_json text not null,
        workspace_profile_id text not null,
        queue_item_id text,
        delivery_record_id text,
        received_at text not null,
        updated_at text not null,
        error text,
        foreign key(channel_id) references channel_definitions(id)
      );

      create index if not exists idx_channel_inbound_items_channel
        on channel_inbound_items (channel_id, received_at desc);

      create table if not exists channel_delivery_records (
        id text primary key,
        schema_version integer not null,
        channel_id text not null,
        inbound_item_id text,
        provider text not null,
        target text not null,
        status text not null,
        title text not null,
        body text not null,
        draft_first integer not null,
        work_item_id text,
        run_kind text,
        run_id text,
        artifact_ids_json text not null,
        policy_decision_ids_json text not null,
        approval_ids_json text not null,
        created_at text not null,
        updated_at text not null,
        error text,
        foreign key(channel_id) references channel_definitions(id),
        foreign key(inbound_item_id) references channel_inbound_items(id)
      );

      create index if not exists idx_channel_delivery_records_channel
        on channel_delivery_records (channel_id, created_at desc);

      create table if not exists channel_local_webhook_pairings (
        channel_id text primary key,
        schema_version integer not null,
        token_hash text not null,
        token_prefix text not null,
        created_at text not null,
        rotated_at text not null,
        foreign key(channel_id) references channel_definitions(id)
      );
    `)
    migrateChannelDb(db)
    recordSchemaVersion(db)
    ensureChannelDbFileModes(dbPath)
    channelDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function clearChannelStoreCache() {
  if (channelDb) {
    channelDb.close()
    channelDb = null
  }
  channelTransactionCounter = 0
}

function withChannelTransaction<T>(fn: () => T): T {
  const db = getChannelDb()
  const savepoint = `channel_tx_${++channelTransactionCounter}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = fn()
    db.exec(`release ${savepoint}`)
    return result
  } catch (error) {
    db.exec(`rollback to ${savepoint}`)
    db.exec(`release ${savepoint}`)
    throw error
  }
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function boundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function optionalBoundedText(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const normalized = value.trim()
  if (!normalized) return null
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return normalized
}

function boundedString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
  return value
}

function assertJsonSize(value: unknown, label: string, maxBytes = MAX_JSON_BYTES) {
  const raw = JSON.stringify(value)
  if (raw === undefined) throw new Error(`${label} must be JSON-serializable.`)
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error(`${label} is too large.`)
}

function assertKnown<T extends string>(set: Set<T>, value: unknown, label: string): T {
  if (typeof value !== 'string' || !set.has(value as T)) throw new Error(`${label} is invalid.`)
  return value as T
}

function boundedStringArray(value: unknown, label: string, options: {
  maxItems?: number
  maxItemBytes?: number
  lowerCase?: boolean
  allowEmpty?: boolean
} = {}) {
  const maxItems = options.maxItems ?? 100
  const maxItemBytes = options.maxItemBytes ?? 512
  if (!Array.isArray(value)) {
    if (options.allowEmpty && (value === undefined || value === null)) return []
    throw new Error(`${label} must be an array.`)
  }
  if (value.length > maxItems) throw new Error(`${label} has too many entries.`)
  const entries = value.map((entry, index) => {
    const text = boundedText(entry, `${label} ${index + 1}`, maxItemBytes)
    return options.lowerCase ? text.toLowerCase() : text
  })
  return [...new Set(entries)].sort((left, right) => left.localeCompare(right))
}

function sourceKey(value: unknown) {
  const key = boundedText(value, 'Channel source key', 256)
  if (!/^[a-zA-Z0-9_.:-]+$/.test(key)) {
    throw new Error('Channel source key may only contain letters, numbers, dots, underscores, colons, and dashes.')
  }
  return key
}

function senderAllowlist(value: unknown) {
  const patterns = boundedStringArray(value, 'Channel sender allowlist', {
    maxItems: 200,
    maxItemBytes: 512,
    lowerCase: true,
  })
  if (patterns.length === 0) throw new Error('Channel sender allowlist must contain at least one sender.')
  if (patterns.some((pattern) => senderAllowlistPatternIsCatchAll(pattern))) {
    throw new Error('Channel sender allowlist cannot use a catch-all wildcard.')
  }
  return patterns
}

function senderAllowlistPatternIsCatchAll(pattern: string) {
  if (!pattern.includes('*')) return false
  return pattern.replaceAll('*', '').replace(/[.@:_+\-\s]/g, '').length === 0
}

function normalizeCapabilities(value: unknown) {
  return boundedStringArray(value || [], 'Channel capability list', {
    maxItems: 200,
    maxItemBytes: 512,
    allowEmpty: true,
  })
}

function workspaceProfileId(value: unknown) {
  const id = optionalBoundedText(value, 'Channel workspace profile id', 512) || CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID
  const profile = getWorkspaceProfile(id)
  if (!profile) throw new Error(`Workspace profile ${id} does not exist.`)
  if (!profile.authority.isolation.channelBound) {
    throw new Error(`Workspace profile ${id} is not channel-bound.`)
  }
  return profile.id
}

function routePolicy(value: ChannelDefinitionDraft['route']): ChannelRoutePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Channel route must be an object.')
  const activationMode = assertKnown(CHANNEL_ACTIVATION_MODES, value.activationMode, 'Channel activation mode')
  const targetSopId = optionalBoundedText(value.targetSopId, 'Channel route SOP id', 512)
  const targetCrewId = optionalBoundedText(value.targetCrewId, 'Channel route crew id', 512)
  if (activationMode === 'run_sop' && !targetSopId) throw new Error('Channel route requires a SOP id.')
  if (activationMode === 'run_crew' && !targetCrewId) throw new Error('Channel route requires a crew id.')
  return {
    schemaVersion: COWORK_CHANNEL_SCHEMA_VERSION,
    activationMode,
    targetSopId: activationMode === 'run_sop' ? targetSopId : null,
    targetCrewId: activationMode === 'run_crew' ? targetCrewId : null,
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function senderMatchesPattern(sender: string, pattern: string) {
  const normalizedSender = sender.toLowerCase()
  const normalizedPattern = pattern.toLowerCase()
  if (normalizedPattern.startsWith('*@')) {
    return normalizedSender.endsWith(normalizedPattern.slice(1))
  }
  if (!normalizedPattern.includes('*')) {
    return normalizedSender === normalizedPattern
  }
  const regex = new RegExp(`^${normalizedPattern.split('*').map(escapeRegExp).join('.*')}$`, 'i')
  return regex.test(sender)
}

function senderIsAllowed(sender: string, patterns: string[]) {
  return patterns.some((pattern) => senderMatchesPattern(sender, pattern))
}

function normalizedChannelDraft(draft: ChannelDefinitionDraft) {
  const provider = assertKnown(CHANNEL_PROVIDERS, draft.provider, 'Channel provider')
  const name = boundedText(draft.name, 'Channel name', 256)
  const description = optionalBoundedText(draft.description, 'Channel description', 2048)
  const route = routePolicy(draft.route)
  return {
    provider,
    name,
    description,
    sourceKey: sourceKey(draft.sourceKey),
    enabled: draft.enabled !== false,
    senderAllowlist: senderAllowlist(draft.senderAllowlist),
    allowedCapabilityIds: normalizeCapabilities(draft.allowedCapabilityIds),
    route,
    workspaceProfileId: workspaceProfileId(draft.workspaceProfileId),
  }
}

function normalizeRoutePolicy(value: unknown): ChannelRoutePolicy {
  const fallback: ChannelRoutePolicy = {
    schemaVersion: COWORK_CHANNEL_SCHEMA_VERSION,
    activationMode: 'ignore',
    targetSopId: null,
    targetCrewId: null,
  }
  const route = parseJson<ChannelRoutePolicy>(value, fallback)
  const activationMode = CHANNEL_ACTIVATION_MODES.has(route.activationMode) ? route.activationMode : 'ignore'
  return {
    schemaVersion: Number(route.schemaVersion || COWORK_CHANNEL_SCHEMA_VERSION),
    activationMode,
    targetSopId: typeof route.targetSopId === 'string' ? route.targetSopId : null,
    targetCrewId: typeof route.targetCrewId === 'string' ? route.targetCrewId : null,
  }
}

function rowToChannelDefinition(row: DbRow): ChannelDefinition {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CHANNEL_SCHEMA_VERSION),
    id: String(row.id || ''),
    provider: CHANNEL_PROVIDERS.has(String(row.provider) as ChannelProvider) ? String(row.provider) as ChannelProvider : 'local_webhook',
    name: String(row.name || ''),
    description: typeof row.description === 'string' ? row.description : null,
    sourceKey: String(row.source_key || ''),
    enabled: Number(row.enabled || 0) === 1,
    senderAllowlist: parseJson<string[]>(row.sender_allowlist_json, []),
    allowedCapabilityIds: parseJson<string[]>(row.allowed_capability_ids_json, []),
    route: normalizeRoutePolicy(row.route_json),
    workspaceProfileId: String(row.workspace_profile_id || CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToInboundItem(row: DbRow): ChannelInboundItem {
  const provider = CHANNEL_PROVIDERS.has(String(row.provider) as ChannelProvider) ? String(row.provider) as ChannelProvider : 'local_webhook'
  const parsedSource = parseJson<Partial<ChannelInboundItem['source']>>(row.source_json, {})
  const source: ChannelInboundItem['source'] = {
    schemaVersion: COWORK_CHANNEL_SCHEMA_VERSION,
    provider,
    sourceKey: typeof parsedSource.sourceKey === 'string' ? parsedSource.sourceKey : '',
    externalMessageId: typeof parsedSource.externalMessageId === 'string' ? parsedSource.externalMessageId : null,
    replyTarget: typeof parsedSource.replyTarget === 'string' ? parsedSource.replyTarget : null,
  }
  return {
    schemaVersion: Number(row.schema_version || COWORK_CHANNEL_SCHEMA_VERSION),
    id: String(row.id || ''),
    channelId: String(row.channel_id || ''),
    provider,
    source,
    sender: String(row.sender || ''),
    subject: typeof row.subject === 'string' ? row.subject : null,
    body: String(row.body || ''),
    route: normalizeRoutePolicy(row.route_json),
    status: CHANNEL_INBOUND_STATUSES.has(String(row.status) as ChannelInboundStatus) ? String(row.status) as ChannelInboundStatus : 'failed',
    auditState: CHANNEL_AUDIT_STATES.has(String(row.audit_state) as ChannelAuditState) ? String(row.audit_state) as ChannelAuditState : 'failed',
    allowedCapabilityIds: parseJson<string[]>(row.allowed_capability_ids_json, []),
    workspaceProfileId: String(row.workspace_profile_id || CHANNEL_SANDBOX_WORKSPACE_PROFILE_ID),
    queueItemId: typeof row.queue_item_id === 'string' ? row.queue_item_id : null,
    deliveryRecordId: typeof row.delivery_record_id === 'string' ? row.delivery_record_id : null,
    workItemId: typeof row.work_item_id === 'string' ? row.work_item_id : null,
    runKind: CHANNEL_INBOUND_RUN_KINDS.has(String(row.routed_run_kind) as ChannelInboundRunKind)
      ? String(row.routed_run_kind) as ChannelInboundRunKind
      : null,
    runId: typeof row.routed_run_id === 'string' ? row.routed_run_id : null,
    runStatus: null,
    approvedAt: typeof row.approved_at === 'string' ? row.approved_at : null,
    approvedBy: typeof row.approved_by === 'string' ? row.approved_by : null,
    reviewNote: typeof row.review_note === 'string' ? row.review_note : null,
    receivedAt: String(row.received_at || ''),
    updatedAt: String(row.updated_at || ''),
    error: typeof row.error === 'string' ? row.error : null,
  }
}

function rowToDeliveryRecord(row: DbRow): ChannelDeliveryRecord {
  const runKind = DELIVERY_RUN_KINDS.has(String(row.run_kind) as ChannelDeliveryRunKind)
    ? String(row.run_kind) as ChannelDeliveryRunKind
    : null
  return {
    schemaVersion: Number(row.schema_version || COWORK_CHANNEL_DELIVERY_SCHEMA_VERSION),
    id: String(row.id || ''),
    channelId: String(row.channel_id || ''),
    inboundItemId: typeof row.inbound_item_id === 'string' ? row.inbound_item_id : null,
    provider: CHANNEL_DELIVERY_PROVIDERS.has(String(row.provider) as ChannelDeliveryProvider) ? String(row.provider) as ChannelDeliveryProvider : 'webhook',
    target: String(row.target || ''),
    status: CHANNEL_DELIVERY_STATUSES.has(String(row.status) as ChannelDeliveryStatus) ? String(row.status) as ChannelDeliveryStatus : 'failed',
    title: String(row.title || ''),
    body: String(row.body || ''),
    draftFirst: Number(row.draft_first || 0) === 1,
    workItemId: typeof row.work_item_id === 'string' ? row.work_item_id : null,
    runKind,
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    artifactIds: parseJson<string[]>(row.artifact_ids_json, []),
    policyDecisionIds: parseJson<string[]>(row.policy_decision_ids_json, []),
    approvalIds: parseJson<string[]>(row.approval_ids_json, []),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    error: typeof row.error === 'string' ? row.error : null,
  }
}

type LocalWebhookPairingSecret = LocalWebhookChannelPairing & {
  tokenHash: string
}

function createLocalWebhookToken() {
  return `${LOCAL_WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

function hashLocalWebhookToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function normalizeLocalWebhookToken(value: unknown) {
  const token = boundedText(value, 'Local webhook pairing token', 512)
  if (!token.startsWith(LOCAL_WEBHOOK_TOKEN_PREFIX)) {
    throw new Error('Local webhook pairing token is invalid.')
  }
  return token
}

function localWebhookTokenMatches(token: string, tokenHash: string) {
  const next = Buffer.from(hashLocalWebhookToken(token), 'hex')
  const expected = Buffer.from(tokenHash, 'hex')
  return next.length === expected.length && timingSafeEqual(next, expected)
}

function rowToLocalWebhookPairing(row: DbRow): LocalWebhookChannelPairing {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CHANNEL_SCHEMA_VERSION),
    channelId: String(row.channel_id || ''),
    sourceKey: String(row.source_key || ''),
    tokenPrefix: String(row.token_prefix || ''),
    createdAt: String(row.created_at || ''),
    rotatedAt: String(row.rotated_at || ''),
  }
}

function rowToLocalWebhookPairingSecret(row: DbRow): LocalWebhookPairingSecret {
  return {
    ...rowToLocalWebhookPairing(row),
    tokenHash: String(row.token_hash || ''),
  }
}

function localWebhookPairingQuery() {
  return `
    select
      p.channel_id,
      p.schema_version,
      p.token_hash,
      p.token_prefix,
      p.created_at,
      p.rotated_at,
      c.source_key
    from channel_local_webhook_pairings p
    join channel_definitions c on c.id = p.channel_id
    where c.provider = 'local_webhook'
  `
}

export function createChannelDefinition(draft: ChannelDefinitionDraft) {
  const normalized = normalizedChannelDraft(draft)
  const id = randomUUID()
  const now = nowIso()
  getChannelDb().prepare(`
    insert into channel_definitions (
      id, schema_version, provider, name, description, source_key, enabled,
      sender_allowlist_json, allowed_capability_ids_json, route_json,
      workspace_profile_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    COWORK_CHANNEL_SCHEMA_VERSION,
    normalized.provider,
    normalized.name,
    normalized.description,
    normalized.sourceKey,
    normalized.enabled ? 1 : 0,
    JSON.stringify(normalized.senderAllowlist),
    JSON.stringify(normalized.allowedCapabilityIds),
    JSON.stringify(normalized.route),
    normalized.workspaceProfileId,
    now,
    now,
  )
  return getChannelDefinition(id)!
}

export function updateChannelDefinition(id: string, draft: ChannelDefinitionDraft) {
  const channelId = boundedText(id, 'Channel id', 512)
  if (!getChannelDefinition(channelId)) return null
  const normalized = normalizedChannelDraft(draft)
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_definitions
    set provider = ?, name = ?, description = ?, source_key = ?, enabled = ?,
      sender_allowlist_json = ?, allowed_capability_ids_json = ?, route_json = ?,
      workspace_profile_id = ?, updated_at = ?
    where id = ?
  `).run(
    normalized.provider,
    normalized.name,
    normalized.description,
    normalized.sourceKey,
    normalized.enabled ? 1 : 0,
    JSON.stringify(normalized.senderAllowlist),
    JSON.stringify(normalized.allowedCapabilityIds),
    JSON.stringify(normalized.route),
    normalized.workspaceProfileId,
    now,
    channelId,
  )
  return getChannelDefinition(channelId)
}

export function getChannelDefinition(id: string) {
  const row = getChannelDb().prepare('select * from channel_definitions where id = ?')
    .get(boundedText(id, 'Channel id', 512)) as DbRow | undefined
  return row ? rowToChannelDefinition(row) : null
}

export function listChannelDefinitions() {
  const rows = getChannelDb().prepare('select * from channel_definitions order by name asc, id asc').all() as DbRow[]
  return rows.map(rowToChannelDefinition)
}

export function rotateLocalWebhookPairingToken(channelId: string): LocalWebhookChannelPairingResult | null {
  const channel = getChannelDefinition(boundedText(channelId, 'Channel id', 512))
  if (!channel) return null
  if (channel.provider !== 'local_webhook') throw new Error('Only local webhook channels can have pairing tokens.')
  const token = createLocalWebhookToken()
  const now = nowIso()
  const existing = getChannelDb().prepare('select created_at from channel_local_webhook_pairings where channel_id = ?')
    .get(channel.id) as { created_at?: string } | undefined
  getChannelDb().prepare(`
    insert into channel_local_webhook_pairings (
      channel_id, schema_version, token_hash, token_prefix, created_at, rotated_at
    ) values (?, ?, ?, ?, ?, ?)
    on conflict(channel_id) do update set
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      rotated_at = excluded.rotated_at
  `).run(
    channel.id,
    COWORK_CHANNEL_SCHEMA_VERSION,
    hashLocalWebhookToken(token),
    token.slice(0, LOCAL_WEBHOOK_TOKEN_PREFIX.length + 6),
    existing?.created_at || now,
    now,
  )
  const pairing = getLocalWebhookPairingForChannel(channel.id)
  if (!pairing) throw new Error('Failed to persist local webhook pairing token.')
  return { channel, pairing, token }
}

export function createLocalWebhookChannelPairing(draft: Omit<ChannelDefinitionDraft, 'provider'>): LocalWebhookChannelPairingResult {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Local webhook channel draft must be an object.')
  }
  return withChannelTransaction(() => {
    const channel = createChannelDefinition({
      ...draft,
      provider: 'local_webhook',
    })
    const paired = rotateLocalWebhookPairingToken(channel.id)
    if (!paired) throw new Error('Failed to create local webhook pairing.')
    return paired
  })
}

export function getLocalWebhookPairingForChannel(channelId: string): LocalWebhookChannelPairing | null {
  const row = getChannelDb().prepare(`${localWebhookPairingQuery()} and p.channel_id = ?`)
    .get(boundedText(channelId, 'Channel id', 512)) as DbRow | undefined
  return row ? rowToLocalWebhookPairing(row) : null
}

export function getLocalWebhookPairingForSourceKey(sourceKeyValue: string): LocalWebhookChannelPairing | null {
  const row = getChannelDb().prepare(`${localWebhookPairingQuery()} and c.source_key = ?`)
    .get(sourceKey(sourceKeyValue)) as DbRow | undefined
  return row ? rowToLocalWebhookPairing(row) : null
}

export function verifyLocalWebhookPairingToken(sourceKeyValue: string, tokenValue: string) {
  const row = getChannelDb().prepare(`${localWebhookPairingQuery()} and c.source_key = ?`)
    .get(sourceKey(sourceKeyValue)) as DbRow | undefined
  if (!row) return null
  const pairing = rowToLocalWebhookPairingSecret(row)
  let token: string
  try {
    token = normalizeLocalWebhookToken(tokenValue)
  } catch {
    return null
  }
  if (!localWebhookTokenMatches(token, pairing.tokenHash)) return null
  const channel = getChannelDefinition(pairing.channelId)
  return channel ? { channel, pairing } : null
}

export function listLocalWebhookPairings() {
  const rows = getChannelDb().prepare(`${localWebhookPairingQuery()} order by c.source_key asc, p.channel_id asc`).all() as DbRow[]
  return rows.map(rowToLocalWebhookPairing)
}

function insertInboundItem(input: {
  id: string
  channel: ChannelDefinition
  sender: string
  subject: string | null
  body: string
  source: ChannelInboundItem['source']
  status: ChannelInboundStatus
  auditState: ChannelAuditState
  receivedAt: string
  error?: string | null
}) {
  const now = nowIso()
  getChannelDb().prepare(`
    insert into channel_inbound_items (
      id, schema_version, channel_id, provider, source_json, sender, subject, body,
      route_json, status, audit_state, allowed_capability_ids_json,
      workspace_profile_id, queue_item_id, delivery_record_id, received_at,
      updated_at, error
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?, ?)
  `).run(
    input.id,
    COWORK_CHANNEL_SCHEMA_VERSION,
    input.channel.id,
    input.channel.provider,
    JSON.stringify(input.source),
    input.sender,
    input.subject,
    input.body,
    JSON.stringify(input.channel.route),
    input.status,
    input.auditState,
    JSON.stringify(input.channel.allowedCapabilityIds),
    input.channel.workspaceProfileId,
    input.receivedAt,
    now,
    input.error || null,
  )
  return getChannelInboundItem(input.id)!
}

function updateInboundItemLinks(id: string, fields: {
  status?: ChannelInboundStatus
  auditState?: ChannelAuditState
  queueItemId?: string | null
  deliveryRecordId?: string | null
  workItemId?: string | null
  runKind?: ChannelInboundItem['runKind']
  runId?: string | null
  approvedAt?: string | null
  approvedBy?: string | null
  reviewNote?: string | null
  error?: string | null
}) {
  const current = getChannelInboundItem(id)
  if (!current) return null
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_inbound_items
    set status = ?, audit_state = ?, queue_item_id = ?, delivery_record_id = ?,
      work_item_id = ?, routed_run_kind = ?, routed_run_id = ?,
      approved_at = ?, approved_by = ?, review_note = ?, updated_at = ?, error = ?
    where id = ?
  `).run(
    fields.status || current.status,
    fields.auditState || current.auditState,
    fields.queueItemId === undefined ? current.queueItemId : fields.queueItemId,
    fields.deliveryRecordId === undefined ? current.deliveryRecordId : fields.deliveryRecordId,
    fields.workItemId === undefined ? current.workItemId : fields.workItemId,
    fields.runKind === undefined ? current.runKind : fields.runKind,
    fields.runId === undefined ? current.runId : fields.runId,
    fields.approvedAt === undefined ? current.approvedAt : fields.approvedAt,
    fields.approvedBy === undefined ? current.approvedBy : fields.approvedBy,
    fields.reviewNote === undefined ? current.reviewNote : fields.reviewNote,
    now,
    fields.error === undefined ? current.error : fields.error,
    id,
  )
  return getChannelInboundItem(id)
}

export function markChannelInboundItemDispatched(id: string, fields: {
  runKind: ChannelInboundRunKind
  runId: string
  workItemId?: string | null
  approvedBy: string
  reviewNote?: string | null
}) {
  const runKind = assertKnown(CHANNEL_INBOUND_RUN_KINDS, fields.runKind, 'Channel inbound run kind')
  return updateInboundItemLinks(id, {
    status: 'dispatched',
    auditState: 'execution_dispatched',
    runKind,
    runId: boundedText(fields.runId, 'Channel inbound routed run id', 512),
    workItemId: optionalBoundedText(fields.workItemId, 'Channel inbound work item id', 512),
    approvedAt: nowIso(),
    approvedBy: boundedText(fields.approvedBy, 'Channel reviewer', 512),
    reviewNote: optionalBoundedText(fields.reviewNote, 'Channel review note', 2048),
    error: null,
  })
}

export function claimChannelInboundItemForDispatch(id: string, reviewer: string) {
  const current = getChannelInboundItem(id)
  if (!current) return null
  if (current.status !== 'queued' && current.status !== 'needs_user') return current
  return updateInboundItemLinks(id, {
    status: 'dispatching',
    auditState: 'execution_dispatching',
    approvedAt: nowIso(),
    approvedBy: boundedText(reviewer, 'Channel reviewer', 512),
    error: null,
  })
}

export function markChannelInboundItemFailed(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return updateInboundItemLinks(id, {
    status: 'failed',
    auditState: 'failed',
    error: message,
  })
}

export function markChannelInboundDeliveryRecord(id: string, deliveryRecordId: string) {
  return updateInboundItemLinks(id, {
    deliveryRecordId: boundedText(deliveryRecordId, 'Channel delivery record id', 512),
  })
}

export function dismissChannelInboundItem(id: string, note?: string | null) {
  return updateInboundItemLinks(id, {
    status: 'denied',
    auditState: 'dismissed',
    reviewNote: optionalBoundedText(note, 'Channel review note', 2048),
    approvedAt: nowIso(),
    approvedBy: 'local-user',
    error: null,
  })
}

export function recordChannelInboundItem(draft: ChannelInboundDraft) {
  const channel = getChannelDefinition(boundedText(draft.channelId, 'Channel id', 512))
  if (!channel) throw new Error(`Channel ${draft.channelId} does not exist.`)
  const sender = boundedText(draft.sender, 'Channel sender', 512)
  const subject = optionalBoundedText(draft.subject, 'Channel subject', 2048)
  const body = boundedText(draft.body, 'Channel body', MAX_BODY_BYTES)
  const replyTarget = optionalBoundedText(draft.replyTarget, 'Channel reply target', 2048)
  const receivedAt = optionalBoundedText(draft.receivedAt, 'Channel received timestamp', 128) || nowIso()
  const source = {
    schemaVersion: COWORK_CHANNEL_SCHEMA_VERSION,
    provider: channel.provider,
    sourceKey: channel.sourceKey,
    externalMessageId: optionalBoundedText(draft.externalMessageId, 'Channel external message id', 512),
    replyTarget,
  }
  assertJsonSize(source, 'Channel inbound source')

  const itemId = randomUUID()
  if (!channel.enabled) {
    return insertInboundItem({
      id: itemId,
      channel,
      sender,
      subject,
      body,
      source,
      status: 'denied',
      auditState: 'denied_channel_disabled',
      receivedAt,
      error: 'Channel is disabled.',
    })
  }

  if (!senderIsAllowed(sender, channel.senderAllowlist)) {
    return insertInboundItem({
      id: itemId,
      channel,
      sender,
      subject,
      body,
      source,
      status: 'denied',
      auditState: 'denied_unknown_sender',
      receivedAt,
      error: 'Sender is not allowlisted.',
    })
  }

  if (channel.route.activationMode === 'ignore') {
    return insertInboundItem({
      id: itemId,
      channel,
      sender,
      subject,
      body,
      source,
      status: 'received',
      auditState: 'ignored',
      receivedAt,
    })
  }

  if (channel.route.activationMode === 'ask_user') {
    return insertInboundItem({
      id: itemId,
      channel,
      sender,
      subject,
      body,
      source,
      status: 'needs_user',
      auditState: 'user_review_required',
      receivedAt,
    })
  }

  if (channel.route.activationMode === 'draft_reply') {
    return withChannelTransaction(() => {
      const item = insertInboundItem({
        id: itemId,
        channel,
        sender,
        subject,
        body,
        source,
        status: 'drafted',
        auditState: 'draft_created',
        receivedAt,
      })
      const delivery = createChannelDeliveryRecord({
        channelId: channel.id,
        inboundItemId: item.id,
        provider: channel.provider === 'local_webhook' ? 'webhook' : channel.provider,
        target: replyTarget || sender,
        status: 'draft',
        title: subject || `Reply to ${sender}`,
        body: '',
        draftFirst: true,
      })
      return updateInboundItemLinks(item.id, { deliveryRecordId: delivery.id })!
    })
  }

  const item = insertInboundItem({
    id: itemId,
    channel,
    sender,
    subject,
    body,
    source,
    status: 'needs_user',
    auditState: 'user_review_required',
    receivedAt,
  })
  try {
    const queueItem = enqueueOperationalRun({
      runKind: 'channel',
      runId: item.id,
      title: subject || `Channel item from ${sender}`,
      requestedAutonomy: 'approve',
      workspaceProfileId: channel.workspaceProfileId,
      channelId: channel.id,
      writeCapable: true,
      caps: {
        maxParallel: 1,
        maxRunDurationMinutes: 60,
        maxRetries: 0,
      },
    })
    return updateInboundItemLinks(item.id, {
      status: 'queued',
      auditState: 'queued_for_review',
      queueItemId: queueItem.id,
    })!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return updateInboundItemLinks(item.id, {
      status: 'failed',
      auditState: 'failed',
      error: message,
    })!
  }
}

export function getChannelInboundItem(id: string) {
  const row = getChannelDb().prepare('select * from channel_inbound_items where id = ?')
    .get(boundedText(id, 'Channel inbound item id', 512)) as DbRow | undefined
  return row ? rowToInboundItem(row) : null
}

export function listChannelInboundItems() {
  const rows = getChannelDb().prepare('select * from channel_inbound_items order by received_at desc, id asc').all() as DbRow[]
  return rows.map(rowToInboundItem)
}

export function createChannelDeliveryRecord(draft: ChannelDeliveryDraft) {
  const channel = getChannelDefinition(boundedText(draft.channelId, 'Channel id', 512))
  if (!channel) throw new Error(`Channel ${draft.channelId} does not exist.`)
  const inboundItemId = optionalBoundedText(draft.inboundItemId, 'Channel inbound item id', 512)
  if (inboundItemId) {
    const item = getChannelInboundItem(inboundItemId)
    if (!item || item.channelId !== channel.id) throw new Error('Channel inbound item does not belong to this channel.')
  }
  const provider = assertKnown(CHANNEL_DELIVERY_PROVIDERS, draft.provider, 'Channel delivery provider')
  const status = draft.status === undefined
    ? 'draft'
    : assertKnown(CHANNEL_DELIVERY_STATUSES, draft.status, 'Channel delivery status')
  const artifactIds = boundedStringArray(draft.artifactIds || [], 'Channel delivery artifact ids', { allowEmpty: true })
  const policyDecisionIds = boundedStringArray(draft.policyDecisionIds || [], 'Channel delivery policy decision ids', { allowEmpty: true })
  const approvalIds = boundedStringArray(draft.approvalIds || [], 'Channel delivery approval ids', { allowEmpty: true })
  if (status === 'delivered' && approvalIds.length === 0) {
    throw new Error('Delivered channel records require an approval reference.')
  }
  const runKind = draft.runKind === undefined || draft.runKind === null
    ? null
    : assertKnown(DELIVERY_RUN_KINDS, draft.runKind, 'Channel delivery run kind')
  const record = {
    id: randomUUID(),
    channelId: channel.id,
    inboundItemId,
    provider,
    target: boundedText(draft.target, 'Channel delivery target', 1024),
    status,
    title: boundedText(draft.title, 'Channel delivery title', 2048),
    body: boundedString(draft.body, 'Channel delivery body', MAX_BODY_BYTES),
    draftFirst: draft.draftFirst !== false,
    workItemId: optionalBoundedText(draft.workItemId, 'Channel delivery work item id', 512),
    runKind,
    runId: optionalBoundedText(draft.runId, 'Channel delivery run id', 512),
    artifactIds,
    policyDecisionIds,
    approvalIds,
    error: optionalBoundedText(draft.error, 'Channel delivery error', 4096),
  }
  assertJsonSize(record.artifactIds, 'Channel delivery artifact ids')
  assertJsonSize(record.policyDecisionIds, 'Channel delivery policy decision ids')
  assertJsonSize(record.approvalIds, 'Channel delivery approval ids')
  const now = nowIso()
  getChannelDb().prepare(`
    insert into channel_delivery_records (
      id, schema_version, channel_id, inbound_item_id, provider, target, status,
      title, body, draft_first, work_item_id, run_kind, run_id,
      artifact_ids_json, policy_decision_ids_json, approval_ids_json,
      created_at, updated_at, error
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    COWORK_CHANNEL_DELIVERY_SCHEMA_VERSION,
    record.channelId,
    record.inboundItemId,
    record.provider,
    record.target,
    record.status,
    record.title,
    record.body,
    record.draftFirst ? 1 : 0,
    record.workItemId,
    record.runKind,
    record.runId,
    JSON.stringify(record.artifactIds),
    JSON.stringify(record.policyDecisionIds),
    JSON.stringify(record.approvalIds),
    now,
    now,
    record.error,
  )
  return getChannelDeliveryRecord(record.id)!
}

export function getChannelDeliveryRecord(id: string) {
  const row = getChannelDb().prepare('select * from channel_delivery_records where id = ?')
    .get(boundedText(id, 'Channel delivery record id', 512)) as DbRow | undefined
  return row ? rowToDeliveryRecord(row) : null
}

export function claimChannelDeliveryForSend(id: string) {
  const record = getChannelDeliveryRecord(id)
  if (!record) return null
  if (record.status === 'delivered' || record.status === 'sending') return record
  if (record.status !== 'draft' && record.status !== 'approval_required') {
    throw new Error('Only draft delivery records can be sent.')
  }
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_delivery_records
    set status = 'sending',
        updated_at = ?,
        error = null
    where id = ?
  `).run(now, record.id)
  return getChannelDeliveryRecord(record.id)
}

export function markChannelDeliveryDelivered(id: string, approvalId: string) {
  const record = getChannelDeliveryRecord(id)
  if (!record) return null
  if (record.status === 'delivered') return record
  if (record.status !== 'draft' && record.status !== 'approval_required' && record.status !== 'sending') {
    throw new Error('Only draft delivery records can be sent.')
  }
  const approvalIds = boundedStringArray([...record.approvalIds, approvalId], 'Channel delivery approval ids', { allowEmpty: true })
  if (approvalIds.length === 0) throw new Error('Delivered channel records require an approval reference.')
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_delivery_records
    set status = 'delivered',
        approval_ids_json = ?,
        updated_at = ?,
        error = null
    where id = ?
  `).run(JSON.stringify(approvalIds), now, record.id)
  return getChannelDeliveryRecord(record.id)
}

export function markChannelDeliveryFailed(id: string, error: string) {
  const record = getChannelDeliveryRecord(id)
  if (!record) return null
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_delivery_records
    set status = 'failed',
        updated_at = ?,
        error = ?
    where id = ?
  `).run(now, optionalBoundedText(error, 'Channel delivery error', 4096), record.id)
  return getChannelDeliveryRecord(record.id)
}

export function cancelChannelDeliveryRecord(id: string, note?: string | null) {
  const record = getChannelDeliveryRecord(id)
  if (!record) return null
  if (record.status === 'delivered') throw new Error('Delivered channel records cannot be cancelled.')
  if (record.status !== 'draft' && record.status !== 'approval_required') {
    throw new Error('Only draft delivery records can be cancelled.')
  }
  const now = nowIso()
  getChannelDb().prepare(`
    update channel_delivery_records
    set status = 'cancelled',
        updated_at = ?,
        error = ?
    where id = ?
  `).run(now, optionalBoundedText(note, 'Channel delivery cancellation note', 4096), record.id)
  return getChannelDeliveryRecord(record.id)
}

export function listChannelDeliveryRecords() {
  const rows = getChannelDb().prepare('select * from channel_delivery_records order by created_at desc, id asc').all() as DbRow[]
  return rows.map(rowToDeliveryRecord)
}

export function findChannelDeliveryRecordForInboundRun(input: {
  inboundItemId: string
  runKind: ChannelDeliveryRecord['runKind']
  runId: string
}) {
  if (!input.runKind) return null
  const row = getChannelDb().prepare(`
    select *
    from channel_delivery_records
    where inbound_item_id = ?
      and run_kind = ?
      and run_id = ?
      and provider != 'desktop_notification'
    order by created_at desc, id desc
    limit 1
  `).get(
    boundedText(input.inboundItemId, 'Channel inbound item id', 512),
    assertKnown(DELIVERY_RUN_KINDS, input.runKind, 'Channel delivery run kind'),
    boundedText(input.runId, 'Channel delivery run id', 512),
  ) as DbRow | undefined
  return row ? rowToDeliveryRecord(row) : null
}

export function listChannelState(): ChannelListPayload {
  return {
    channels: listChannelDefinitions(),
    inboundItems: listChannelInboundItems(),
    deliveries: listChannelDeliveryRecords(),
  }
}
