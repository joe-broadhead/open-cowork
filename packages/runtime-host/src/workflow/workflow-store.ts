import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getAppPathHost, getSafeStorageHost, type WebhookAuthFailureRecord, type WorkflowWebhookReplayClaim, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import type {
  CloudProjectionCheckpoint,
  CloudProjectionFenceToken,
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  createCloudProjectionCheckpoint,
  createCloudProjectionFenceToken,
  normalizeWorkflowSteps,
} from '@open-cowork/shared'
import { getAppDataDir } from '../config-loader-core.js'
import { initializeLocalSqliteSchema } from '../local-sqlite-schema.js'
import {
  readSafeStorageBackendForPolicy,
  resolveSecretStorageMode,
} from '../secure-storage-policy.js'
import { computeNextWorkflowRunAt } from './workflow-schedule.js'
import {
  assertWorkflowCapabilities,
  isWorkflowTriggerType,
  MAX_WORKFLOW_LIST_ITEMS,
  normalizeWorkflowDraft,
  previewWorkflowDraft as previewWorkflowDraftCalculation,
  type WorkflowDraftNormalizationOptions,
} from './workflow-normalization.js'
import {
  parseWorkflowTriggersFromStorageWithAdapter,
  serializeWorkflowTriggersForStorageWithAdapter,
  type WorkflowSecretStorageAdapter,
} from './workflow-secret-storage.js'

const WORKFLOW_DB_SCHEMA_VERSION = 3
const WORKFLOW_SCHEMA_VERSION_KEY = 'schema_version'
const WORKFLOW_PROJECTION_VERSION_KEY = 'workflow_projection_version'
const LOCAL_WORKFLOW_PROJECTION_TENANT_ID = 'desktop-local'
const VALID_STATUS = new Set<WorkflowStatus>(['active', 'paused', 'running', 'failed', 'archived'])
const VALID_RUN_STATUS = new Set<WorkflowRunStatus>(['queued', 'running', 'completed', 'failed', 'cancelled'])

const WORKFLOW_BASELINE_SQL = `
  create table workflow_meta (
    key text primary key,
    value text not null
  );
  create table workflows (
    id text primary key,
    title text not null,
    instructions text not null,
    agent_name text not null,
    skill_names_json text not null,
    tool_ids_json text not null,
    steps_json text not null default '[]',
    status text not null,
    project_directory text,
    draft_session_id text,
    triggers_json text not null,
    created_at text not null,
    updated_at text not null,
    next_run_at text,
    last_run_at text,
    latest_run_id text,
    latest_run_status text,
    latest_run_session_id text,
    latest_run_summary text
  );
  create table workflow_runs (
    id text primary key,
    workflow_id text not null,
    session_id text,
    trigger_type text not null,
    trigger_payload_json text,
    status text not null,
    title text not null,
    summary text,
    error text,
    created_at text not null,
    started_at text,
    finished_at text
  );
  create index idx_workflow_runs_workflow on workflow_runs(workflow_id, created_at);
  create index idx_workflows_due on workflows(status, next_run_at);
  create table workflow_webhook_rate_limits (
    source text primary key,
    window_started_at integer not null,
    count integer not null
  );
  create table workflow_webhook_auth_failures (
    scope text primary key,
    source text not null,
    auth_window_started_at integer not null,
    auth_failure_count integer not null,
    blocked_until integer not null
  );
  create table workflow_webhook_signatures (
    key_hash text primary key,
    seen_at integer not null,
    status text not null check (status in ('pending', 'accepted'))
  );
  create index idx_workflow_webhook_signatures_seen_at on workflow_webhook_signatures(seen_at);
`

let workflowDb: DatabaseSync | null = null
let workflowDbForTests: DatabaseSync | null = null
let transactionCounter = 0
let workflowSecretStorageForTests: WorkflowSecretStorageAdapter | null = null

type DbRow = Record<string, unknown>
type WorkflowWriteOptions = WorkflowDraftNormalizationOptions
type WorkflowDraftOptions = WorkflowDraftNormalizationOptions
export type { WorkflowCapabilityValidationContext } from './workflow-normalization.js'

function workflowDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'workflows.sqlite')
}

function ensureWorkflowDbFileModes(dbPath = workflowDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function getWorkflowSecretStorage(): WorkflowSecretStorageAdapter {
  if (workflowSecretStorageForTests) return workflowSecretStorageForTests
  const mode = resolveSecretStorageMode({
    isPackaged: Boolean(getAppPathHost()?.isPackaged),
    encryptionAvailable: Boolean(getSafeStorageHost()?.isEncryptionAvailable()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      getSafeStorageHost()?.getSelectedStorageBackend,
    ),
  })
  return {
    mode,
    encryptString: getSafeStorageHost()?.encryptString,
    decryptString: getSafeStorageHost()?.decryptString,
  }
}

export function serializeWorkflowTriggersForStorage(triggers: WorkflowTrigger[]) {
  return serializeWorkflowTriggersForStorageWithAdapter(triggers, getWorkflowSecretStorage())
}

export function parseWorkflowTriggersFromStorage(value: unknown) {
  return parseWorkflowTriggersFromStorageWithAdapter(value, getWorkflowSecretStorage())
}

export function setWorkflowSecretStorageForTests(adapter: WorkflowSecretStorageAdapter | null) {
  workflowSecretStorageForTests = adapter
}

export function setWorkflowDatabaseForTests(db: DatabaseSync | null) {
  workflowDb?.close()
  workflowDb = null
  workflowDbForTests = null
  transactionCounter = 0
  if (db) {
    initDb(db)
    workflowDbForTests = db
  }
}

function writeNow(options?: WorkflowWriteOptions) {
  return options?.now ?? new Date()
}

function randomWebhookSecret() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

function projectDirectoryExists(directory: string) {
  try {
    return statSync(directory).isDirectory()
  } catch {
    return false
  }
}

function workflowDraftOptions(options?: WorkflowDraftOptions): WorkflowDraftNormalizationOptions {
  return {
    ...options,
    projectDirectoryExists: options?.projectDirectoryExists ?? projectDirectoryExists,
  }
}

function initDb(db: DatabaseSync) {
  initializeLocalSqliteSchema(db, {
    storeName: 'local workflow store',
    currentVersion: WORKFLOW_DB_SCHEMA_VERSION,
    metaTable: 'workflow_meta',
    versionKey: WORKFLOW_SCHEMA_VERSION_KEY,
    baselineSql: WORKFLOW_BASELINE_SQL,
    tables: [
      { name: 'workflow_meta', columns: ['key', 'value'] },
      { name: 'workflows', columns: ['id', 'title', 'instructions', 'agent_name', 'skill_names_json', 'tool_ids_json', 'steps_json', 'status', 'project_directory', 'draft_session_id', 'triggers_json', 'created_at', 'updated_at', 'next_run_at', 'last_run_at', 'latest_run_id', 'latest_run_status', 'latest_run_session_id', 'latest_run_summary'] },
      { name: 'workflow_runs', columns: ['id', 'workflow_id', 'session_id', 'trigger_type', 'trigger_payload_json', 'status', 'title', 'summary', 'error', 'created_at', 'started_at', 'finished_at'] },
      { name: 'workflow_webhook_rate_limits', columns: ['source', 'window_started_at', 'count'] },
      { name: 'workflow_webhook_auth_failures', columns: ['scope', 'source', 'auth_window_started_at', 'auth_failure_count', 'blocked_until'] },
      { name: 'workflow_webhook_signatures', columns: ['key_hash', 'seen_at', 'status'] },
    ],
    indexes: [
      'idx_workflow_runs_workflow',
      'idx_workflows_due',
      'idx_workflow_webhook_signatures_seen_at',
    ],
    recovery: 'Back up or export saved workflows and run history, then reset only workflows.sqlite before recreating or importing them.',
  })
}

export function getWorkflowDb() {
  if (workflowDbForTests) return workflowDbForTests
  if (workflowDb) return workflowDb
  const dbPath = workflowDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    initDb(db)
    db.exec('pragma journal_mode = WAL;')
    ensureWorkflowDbFileModes(dbPath)
    workflowDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function withTransaction<T>(callback: (db: DatabaseSync) => T): T {
  const db = getWorkflowDb()
  const savepoint = `workflow_tx_${transactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    if (!workflowDbForTests) ensureWorkflowDbFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      if (!workflowDbForTests) ensureWorkflowDbFileModes()
    }
    throw error
  }
}

function normalizeMs(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0
}

function webhookSecurityKeyHash(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

function pruneWorkflowWebhookSignatures(db: DatabaseSync, nowMs: number, windowMs: number, cacheLimit: number) {
  db.prepare('delete from workflow_webhook_signatures where ? - seen_at > ?').run(nowMs, windowMs)
  const row = db.prepare('select count(*) as count from workflow_webhook_signatures').get() as { count?: unknown } | undefined
  const count = Number(row?.count || 0)
  const overflow = count - cacheLimit
  if (overflow > 0) {
    db.prepare(`
      delete from workflow_webhook_signatures
      where key_hash in (
        select key_hash from workflow_webhook_signatures
        order by seen_at asc
        limit ?
      )
    `).run(overflow)
  }
}

export class SqliteWorkflowWebhookSecurityStore implements WorkflowWebhookSecurityStore {
  readonly clearOnStop = false

  claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }) {
    return withTransaction((db) => {
      const nowMs = normalizeMs(input.nowMs)
      const source = input.source || 'unknown'
      db.prepare('delete from workflow_webhook_rate_limits where ? - window_started_at > ?').run(nowMs, input.windowMs)
      const row = db.prepare('select window_started_at, count from workflow_webhook_rate_limits where source = ?').get(source) as DbRow | undefined
      const windowStartedAt = normalizeMs(row?.window_started_at)
      const currentCount = normalizeMs(row?.count)
      const expired = !row || nowMs - windowStartedAt > input.windowMs
      const nextWindowStartedAt = expired ? nowMs : windowStartedAt
      const nextCount = (expired ? 0 : currentCount) + 1
      db.prepare(`
        insert into workflow_webhook_rate_limits (source, window_started_at, count)
        values (?, ?, ?)
        on conflict(source) do update set
          window_started_at = excluded.window_started_at,
          count = excluded.count
      `).run(source, nextWindowStartedAt, nextCount)
      return nextCount <= input.limit
    })
  }

  checkAuthBackoff(input: {
    scope: string
    nowMs: number
  }) {
    const row = getWorkflowDb().prepare('select blocked_until from workflow_webhook_auth_failures where scope = ?')
      .get(input.scope || 'unknown') as DbRow | undefined
    return !row || normalizeMs(row.blocked_until) <= normalizeMs(input.nowMs)
  }

  recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }): WebhookAuthFailureRecord {
    return withTransaction((db) => {
      const nowMs = normalizeMs(input.nowMs)
      const scope = input.scope || 'unknown'
      const source = input.source || 'unknown'
      db.prepare('delete from workflow_webhook_auth_failures where blocked_until <= ? and ? - auth_window_started_at > ?')
        .run(nowMs, nowMs, input.windowMs)
      const row = db.prepare(`
        select auth_window_started_at, auth_failure_count, blocked_until
        from workflow_webhook_auth_failures
        where scope = ?
      `).get(scope) as DbRow | undefined
      const windowStartedAt = normalizeMs(row?.auth_window_started_at)
      const currentCount = normalizeMs(row?.auth_failure_count)
      const currentBlockedUntil = normalizeMs(row?.blocked_until)
      const expired = !row || nowMs - windowStartedAt > input.windowMs
      const nextWindowStartedAt = expired ? nowMs : windowStartedAt
      const nextCount = (expired ? 0 : currentCount) + 1
      const nextBlockedUntil = nextCount >= input.limit
        ? Math.max(currentBlockedUntil, nowMs + input.backoffMs)
        : currentBlockedUntil
      db.prepare(`
        insert into workflow_webhook_auth_failures (
          scope, source, auth_window_started_at, auth_failure_count, blocked_until
        ) values (?, ?, ?, ?, ?)
        on conflict(scope) do update set
          source = excluded.source,
          auth_window_started_at = excluded.auth_window_started_at,
          auth_failure_count = excluded.auth_failure_count,
          blocked_until = excluded.blocked_until
      `).run(scope, source, nextWindowStartedAt, nextCount, nextBlockedUntil)
      return {
        authWindowStartedAt: nextWindowStartedAt,
        authFailureCount: nextCount,
        blockedUntil: nextBlockedUntil,
      }
    })
  }

  claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }): WorkflowWebhookReplayClaim | null {
    const keyHash = webhookSecurityKeyHash(input.key)
    const claimedAt = normalizeMs(input.nowMs)
    return withTransaction((db) => {
      pruneWorkflowWebhookSignatures(db, claimedAt, input.windowMs, input.cacheLimit)
      const existing = db.prepare('select key_hash from workflow_webhook_signatures where key_hash = ?').get(keyHash)
      if (existing) return null
      db.prepare('insert into workflow_webhook_signatures (key_hash, seen_at, status) values (?, ?, ?)')
        .run(keyHash, claimedAt, 'pending')
      let active = true
      return {
        accept: () => {
          if (!active) return
          active = false
          withTransaction((acceptDb) => {
            acceptDb.prepare('update workflow_webhook_signatures set status = ? where key_hash = ? and status = ?')
              .run('accepted', keyHash, 'pending')
          })
        },
        release: () => {
          if (!active) return
          active = false
          withTransaction((releaseDb) => {
            releaseDb.prepare('delete from workflow_webhook_signatures where key_hash = ? and status = ?')
              .run(keyHash, 'pending')
          })
        },
      }
    })
  }

  clear() {
    withTransaction((db) => {
      db.prepare('delete from workflow_webhook_rate_limits').run()
      db.prepare('delete from workflow_webhook_auth_failures').run()
      db.prepare('delete from workflow_webhook_signatures').run()
    })
  }
}

export function createWorkflowWebhookSecurityStore(): WorkflowWebhookSecurityStore {
  return new SqliteWorkflowWebhookSecurityStore()
}

function readWorkflowProjectionVersion(db = getWorkflowDb()) {
  const row = db.prepare('select value from workflow_meta where key = ?').get(WORKFLOW_PROJECTION_VERSION_KEY) as { value?: unknown } | undefined
  const version = Number.parseInt(String(row?.value || '0'), 10)
  return Number.isFinite(version) && version >= 0 ? version : 0
}

function bumpWorkflowProjectionVersion(db: DatabaseSync) {
  const next = readWorkflowProjectionVersion(db) + 1
  db.prepare(`
    insert into workflow_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(WORKFLOW_PROJECTION_VERSION_KEY, String(next))
  return next
}

function workflowRunProjectionFence(run: Pick<WorkflowRun, 'id' | 'workflowId'>, projectionVersion = readWorkflowProjectionVersion()): CloudProjectionFenceToken {
  return createCloudProjectionFenceToken({
    scope: 'workflow-run',
    tenantId: LOCAL_WORKFLOW_PROJECTION_TENANT_ID,
    workflowId: run.workflowId,
    runId: run.id,
    sequence: projectionVersion,
    projectionVersion,
    checkpointVersion: projectionVersion,
  })
}

function withWorkflowRunProjectionFence<T extends WorkflowRun | null>(run: T, projectionVersion?: number): T {
  if (!run) return run
  return {
    ...run,
    projectionFence: workflowRunProjectionFence(run, projectionVersion),
  }
}

export function getWorkflowRunProjectionCheckpoint(runId: string): CloudProjectionCheckpoint | null {
  const run = getWorkflowRun(runId)
  if (!run) return null
  const projectionVersion = readWorkflowProjectionVersion()
  return createCloudProjectionCheckpoint({
    scope: 'workflow-run',
    tenantId: LOCAL_WORKFLOW_PROJECTION_TENANT_ID,
    workflowId: run.workflowId,
    runId: run.id,
    sequence: projectionVersion,
    projectionVersion,
    checkpointVersion: projectionVersion,
    updatedAt: run.finishedAt || run.startedAt || run.createdAt || new Date().toISOString(),
  })
}

function webhookUrlForWorkflow(workflow: WorkflowSummary, webhookBaseUrl?: string | null) {
  if (!webhookBaseUrl) return null
  const webhook = workflow.triggers.find((trigger) => (
    trigger.enabled
    && trigger.type === 'webhook'
    && typeof trigger.webhookSecret === 'string'
    && trigger.webhookSecret.length > 0
  ))
  return webhook ? `${webhookBaseUrl}/workflows/${encodeURIComponent(workflow.id)}` : null
}

function rowToWorkflow(row: DbRow, webhookBaseUrl?: string | null): WorkflowSummary {
  const status = VALID_STATUS.has(String(row.status) as WorkflowStatus) ? String(row.status) as WorkflowStatus : 'active'
  const latestRunStatus = row.latest_run_status && VALID_RUN_STATUS.has(String(row.latest_run_status) as WorkflowRunStatus)
    ? String(row.latest_run_status) as WorkflowRunStatus
    : null
  const instructions = String(row.instructions || '')
  const agentName = String(row.agent_name || 'build')
  const skillNames = parseJson<string[]>(row.skill_names_json, [])
  const toolIds = parseJson<string[]>(row.tool_ids_json, [])
  const workflow: WorkflowSummary = {
    id: String(row.id || ''),
    title: String(row.title || ''),
    instructions,
    agentName,
    skillNames,
    toolIds,
    steps: normalizeWorkflowSteps(parseJson<unknown>(row.steps_json, null), {
      instructions,
      agentName,
      skillNames,
      toolIds,
    }),
    status,
    projectDirectory: typeof row.project_directory === 'string' ? row.project_directory : null,
    draftSessionId: typeof row.draft_session_id === 'string' ? row.draft_session_id : null,
    triggers: parseWorkflowTriggersFromStorage(row.triggers_json),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    nextRunAt: typeof row.next_run_at === 'string' ? row.next_run_at : null,
    lastRunAt: typeof row.last_run_at === 'string' ? row.last_run_at : null,
    latestRunId: typeof row.latest_run_id === 'string' ? row.latest_run_id : null,
    latestRunStatus,
    latestRunSessionId: typeof row.latest_run_session_id === 'string' ? row.latest_run_session_id : null,
    latestRunSummary: typeof row.latest_run_summary === 'string' ? row.latest_run_summary : null,
    webhookUrl: null,
  }
  workflow.webhookUrl = webhookUrlForWorkflow(workflow, webhookBaseUrl)
  return workflow
}

function rowToRun(row: DbRow): WorkflowRun {
  const status = VALID_RUN_STATUS.has(String(row.status) as WorkflowRunStatus) ? String(row.status) as WorkflowRunStatus : 'queued'
  const rawTriggerType = String(row.trigger_type)
  const triggerType = isWorkflowTriggerType(rawTriggerType)
    ? rawTriggerType
    : 'manual'
  return {
    id: String(row.id || ''),
    workflowId: String(row.workflow_id || ''),
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    triggerType,
    triggerPayload: parseJson<Record<string, unknown> | null>(row.trigger_payload_json, null),
    status,
    title: String(row.title || ''),
    summary: typeof row.summary === 'string' ? row.summary : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: String(row.created_at || ''),
    startedAt: typeof row.started_at === 'string' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}

function listRunsForWorkflow(workflowId: string, limit = 25) {
  const rows = getWorkflowDb().prepare('select * from workflow_runs where workflow_id = ? order by created_at desc limit ?')
    .all(workflowId, limit) as DbRow[]
  return rows.map(rowToRun)
}

export function previewWorkflowDraft(draft: WorkflowDraft, options?: WorkflowDraftOptions) {
  return previewWorkflowDraftCalculation(draft, workflowDraftOptions(options))
}

export function listWorkflows(webhookBaseUrl?: string | null): WorkflowListPayload {
  const workflows = (getWorkflowDb().prepare('select * from workflows order by updated_at desc').all() as DbRow[])
    .map((row) => rowToWorkflow(row, webhookBaseUrl))
  const runs = (getWorkflowDb().prepare('select * from workflow_runs order by created_at desc limit 100').all() as DbRow[])
    .map(rowToRun)
  return { workflows, runs }
}

export function getWorkflow(workflowId: string, webhookBaseUrl?: string | null): WorkflowDetail | null {
  const row = getWorkflowDb().prepare('select * from workflows where id = ?').get(workflowId) as DbRow | undefined
  if (!row) return null
  return {
    ...rowToWorkflow(row, webhookBaseUrl),
    runs: listRunsForWorkflow(workflowId),
  }
}

export function createWorkflow(draft: WorkflowDraft, webhookBaseUrl?: string | null, options?: WorkflowWriteOptions): WorkflowDetail {
  const nowDate = writeNow(options)
  const normalized = normalizeWorkflowDraft(draft, workflowDraftOptions({ ...options, now: nowDate }))
  assertWorkflowCapabilities(normalized, workflowDraftOptions(options))
  const now = nowDate.toISOString()
  const id = crypto.randomUUID()
  const nextRunAt = computeNextWorkflowRunAt(normalized.triggers, nowDate)
  withTransaction((db) => {
    db.prepare(`
      insert into workflows (
        id, title, instructions, agent_name, skill_names_json, tool_ids_json, steps_json, status,
        project_directory, draft_session_id, triggers_json, created_at, updated_at,
        next_run_at, last_run_at, latest_run_id, latest_run_status, latest_run_session_id, latest_run_summary
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null)
    `).run(
      id,
      normalized.title,
      normalized.instructions,
      normalized.agentName,
      JSON.stringify(normalized.skillNames || []),
      JSON.stringify(normalized.toolIds || []),
      JSON.stringify(normalized.steps || []),
      'active',
      normalized.projectDirectory || null,
      normalized.draftSessionId || null,
      serializeWorkflowTriggersForStorage(normalized.triggers),
      now,
      now,
      nextRunAt,
    )
    bumpWorkflowProjectionVersion(db)
  })
  return getWorkflow(id, webhookBaseUrl)!
}

export function updateWorkflowStatus(workflowId: string, status: WorkflowStatus, webhookBaseUrl?: string | null, options?: WorkflowWriteOptions) {
  if (!VALID_STATUS.has(status)) throw new Error('Workflow status is invalid.')
  const nowDate = writeNow(options)
  const now = nowDate.toISOString()
  withTransaction((db) => {
    const row = db.prepare('select triggers_json from workflows where id = ?').get(workflowId) as DbRow | undefined
    const triggers = parseWorkflowTriggersFromStorage(row?.triggers_json)
    const nextRunAt = status === 'active' ? computeNextWorkflowRunAt(triggers, nowDate) : null
    db.prepare('update workflows set status = ?, updated_at = ?, next_run_at = ? where id = ?')
      .run(status, now, nextRunAt, workflowId)
    bumpWorkflowProjectionVersion(db)
  })
  return getWorkflow(workflowId, webhookBaseUrl)
}

export function regenerateWorkflowWebhookSecret(workflowId: string, webhookBaseUrl?: string | null) {
  const detail = getWorkflow(workflowId, webhookBaseUrl)
  if (!detail) return null
  const triggers = detail.triggers.map((trigger) => trigger.type === 'webhook'
    ? { ...trigger, webhookSecret: randomWebhookSecret() }
    : trigger)
  const now = new Date().toISOString()
  withTransaction((db) => {
    db.prepare('update workflows set triggers_json = ?, updated_at = ? where id = ?')
      .run(serializeWorkflowTriggersForStorage(triggers), now, workflowId)
    bumpWorkflowProjectionVersion(db)
  })
  return getWorkflow(workflowId, webhookBaseUrl)
}

export function listDueWorkflows(now = new Date(), webhookBaseUrl?: string | null) {
  const rows = getWorkflowDb().prepare(`
    select * from workflows
    where status = 'active'
      and next_run_at is not null
      and next_run_at <= ?
    order by next_run_at asc
  `).all(now.toISOString()) as DbRow[]
  return rows.map((row) => rowToWorkflow(row, webhookBaseUrl))
}

export function createWorkflowRun(workflowId: string, triggerType: WorkflowTriggerType, payload: Record<string, unknown> | null = null) {
  const workflow = getWorkflow(workflowId)
  if (!workflow) throw new Error('Workflow not found.')
  if (workflow.status === 'archived') throw new Error('Archived workflows cannot run.')
  if (workflow.status === 'paused') throw new Error('Paused workflows cannot run.')
  if (workflow.status === 'running') throw new Error('Workflow is already running.')
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  let projectionVersion = 0
  withTransaction((db) => {
    db.prepare(`
      insert into workflow_runs (
        id, workflow_id, session_id, trigger_type, trigger_payload_json, status, title,
        summary, error, created_at, started_at, finished_at
      ) values (?, ?, null, ?, ?, 'queued', ?, null, null, ?, null, null)
    `).run(id, workflowId, triggerType, payload ? JSON.stringify(payload) : null, `Run ${workflow.title}`, now)
    db.prepare(`
      update workflows
      set status = 'running', latest_run_id = ?, latest_run_status = 'queued', updated_at = ?
      where id = ?
    `).run(id, now, workflowId)
    projectionVersion = bumpWorkflowProjectionVersion(db)
  })
  return withWorkflowRunProjectionFence(getWorkflowRun(id), projectionVersion)
}

export function claimDueWorkflowRun(now = new Date()) {
  const claimedAt = now.toISOString()
  return withTransaction((db) => {
    for (let attempt = 0; attempt < MAX_WORKFLOW_LIST_ITEMS; attempt += 1) {
      const row = db.prepare(`
        select * from workflows
        where status = 'active'
          and next_run_at is not null
          and next_run_at <= ?
        order by next_run_at asc
        limit 1
      `).get(claimedAt) as DbRow | undefined
      if (!row) return null

      const workflow = rowToWorkflow(row)
      const trigger = workflow.triggers.find((entry) => (
        entry.enabled && entry.type === 'schedule' && entry.schedule && workflow.nextRunAt
      ))
      if (!trigger || !workflow.nextRunAt) {
        db.prepare('update workflows set next_run_at = ?, updated_at = ? where id = ?')
          .run(computeNextWorkflowRunAt(workflow.triggers, now), claimedAt, workflow.id)
        continue
      }

      const runId = crypto.randomUUID()
      const update = db.prepare(`
        update workflows
        set status = 'running', latest_run_id = ?, latest_run_status = 'queued', updated_at = ?
        where id = ?
          and status = 'active'
          and next_run_at = ?
      `).run(runId, claimedAt, workflow.id, workflow.nextRunAt)
      if (Number(update.changes) !== 1) continue

      const payload = {
        source: 'schedule',
        scheduledFor: workflow.nextRunAt,
      }
      db.prepare(`
        insert into workflow_runs (
          id, workflow_id, session_id, trigger_type, trigger_payload_json, status, title,
          summary, error, created_at, started_at, finished_at
        ) values (?, ?, null, 'schedule', ?, 'queued', ?, null, null, ?, null, null)
      `).run(runId, workflow.id, JSON.stringify(payload), `Run ${workflow.title}`, claimedAt)

      const projectionVersion = bumpWorkflowProjectionVersion(db)
      return withWorkflowRunProjectionFence(getWorkflowRun(runId), projectionVersion)
    }
    return null
  })
}

export function getWorkflowRun(runId: string) {
  const row = getWorkflowDb().prepare('select * from workflow_runs where id = ?').get(runId) as DbRow | undefined
  return row ? rowToRun(row) : null
}

export function attachWorkflowRunSession(workflowId: string, runId: string, sessionId: string) {
  const now = new Date().toISOString()
  let projectionVersion = 0
  withTransaction((db) => {
    db.prepare('update workflow_runs set session_id = ?, status = ?, started_at = coalesce(started_at, ?) where id = ?')
      .run(sessionId, 'running', now, runId)
    db.prepare(`
      update workflows
      set latest_run_id = ?, latest_run_status = ?, latest_run_session_id = ?, updated_at = ?, status = ?
      where id = ?
    `).run(runId, 'running', sessionId, now, 'running', workflowId)
    projectionVersion = bumpWorkflowProjectionVersion(db)
  })
  return withWorkflowRunProjectionFence(getWorkflowRun(runId), projectionVersion)
}

export function markWorkflowRunCompleted(runId: string, summary: string | null) {
  const run = getWorkflowRun(runId)
  if (!run) return null
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run
  const now = new Date().toISOString()
  const workflow = getWorkflow(run.workflowId)
  const nextStatus = workflow?.status === 'paused' || workflow?.status === 'archived'
    ? workflow.status
    : 'active'
  const nextRunAt = nextStatus === 'active' && workflow
    ? computeNextWorkflowRunAt(workflow.triggers, new Date(now))
    : null
  let projectionVersion = 0
  withTransaction((db) => {
    db.prepare('update workflow_runs set status = ?, summary = ?, finished_at = ? where id = ?')
      .run('completed', summary, now, runId)
    db.prepare(`
      update workflows
      set status = ?, latest_run_id = ?, latest_run_status = 'completed',
        latest_run_summary = ?, last_run_at = ?, next_run_at = ?, updated_at = ?
      where id = ?
    `).run(nextStatus, runId, summary, now, nextRunAt, now, run.workflowId)
    projectionVersion = bumpWorkflowProjectionVersion(db)
  })
  return withWorkflowRunProjectionFence(getWorkflowRun(runId), projectionVersion)
}

export function markWorkflowRunFailed(runId: string, error: string) {
  const run = getWorkflowRun(runId)
  if (!run) return null
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return run
  const now = new Date().toISOString()
  const workflow = getWorkflow(run.workflowId)
  const nextRunAt = workflow ? computeNextWorkflowRunAt(workflow.triggers, new Date(now)) : null
  const nextStatus = workflow?.status === 'paused' || workflow?.status === 'archived'
    ? workflow.status
    : 'active'
  let projectionVersion = 0
  withTransaction((db) => {
    db.prepare('update workflow_runs set status = ?, error = ?, finished_at = ? where id = ?')
      .run('failed', error, now, runId)
    db.prepare(`
      update workflows
      set status = ?, latest_run_id = ?, latest_run_status = 'failed',
        latest_run_summary = ?, next_run_at = ?, updated_at = ?
      where id = ?
    `).run(nextStatus, runId, error, nextRunAt, now, run.workflowId)
    projectionVersion = bumpWorkflowProjectionVersion(db)
  })
  return withWorkflowRunProjectionFence(getWorkflowRun(runId), projectionVersion)
}

export function recoverInterruptedWorkflowRuns(error = 'Workflow run was interrupted before completion.', now = new Date()) {
  const finishedAt = now.toISOString()
  const rows = getWorkflowDb().prepare(`
    select * from workflow_runs
    where status in ('queued', 'running')
    order by created_at asc
  `).all() as DbRow[]
  if (rows.length === 0) return []

  return withTransaction((db) => {
    const recovered: WorkflowRun[] = []
    for (const row of rows) {
      const run = rowToRun(row)
      db.prepare('update workflow_runs set status = ?, error = ?, finished_at = ? where id = ?')
        .run('failed', error, finishedAt, run.id)

      const workflowRow = db.prepare('select * from workflows where id = ?').get(run.workflowId) as DbRow | undefined
      if (workflowRow) {
        const status = VALID_STATUS.has(String(workflowRow.status) as WorkflowStatus)
          ? String(workflowRow.status) as WorkflowStatus
          : 'active'
        const nextStatus = status === 'paused' || status === 'archived' ? status : 'active'
        const triggers = parseWorkflowTriggersFromStorage(workflowRow.triggers_json)
        const nextRunAt = nextStatus === 'active' ? computeNextWorkflowRunAt(triggers, now) : null
        db.prepare(`
          update workflows
          set status = ?, latest_run_id = ?, latest_run_status = 'failed',
            latest_run_summary = ?, next_run_at = ?, updated_at = ?
          where id = ? and latest_run_id = ?
        `).run(nextStatus, run.id, error, nextRunAt, finishedAt, run.workflowId, run.id)
      }

      const projectionVersion = bumpWorkflowProjectionVersion(db)
      recovered.push(withWorkflowRunProjectionFence(rowToRun({
        ...row,
        status: 'failed',
        error,
        finished_at: finishedAt,
      }), projectionVersion))
    }
    return recovered
  })
}

export function clearWorkflowStoreCache() {
  workflowDb?.close()
  workflowDb = null
  workflowDbForTests = null
  transactionCounter = 0
}
