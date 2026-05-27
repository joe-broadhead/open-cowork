import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import electron from 'electron'
import type {
  WorkflowDetail,
  WorkflowDraft,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowToolPreview,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import { getAppDataDir } from '../config-loader.ts'
import {
  readSafeStorageBackendForPolicy,
  resolveSecretStorageMode,
  type SecretStorageMode,
} from '../secure-storage-policy.ts'
import { computeNextWorkflowRunAt, validateWorkflowSchedule } from './workflow-schedule.ts'

const WORKFLOW_DB_SCHEMA_VERSION = 1
const WORKFLOW_SCHEMA_VERSION_KEY = 'schema_version'
const MAX_TEXT = 32 * 1024
const MAX_LIST_ITEMS = 50
const VALID_STATUS = new Set<WorkflowStatus>(['active', 'paused', 'running', 'failed', 'archived'])
const VALID_RUN_STATUS = new Set<WorkflowRunStatus>(['queued', 'running', 'completed', 'failed', 'cancelled'])
const VALID_TRIGGER_TYPES = new Set<WorkflowTriggerType>(['manual', 'schedule', 'webhook'])

let workflowDb: DatabaseSync | null = null
let transactionCounter = 0
let workflowSecretStorageForTests: WorkflowSecretStorageAdapter | null = null

const electronApp = (electron as { app?: typeof import('electron').app }).app
const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
const electronSafeStorageBackend = electronSafeStorage as (typeof import('electron').safeStorage & {
  getSelectedStorageBackend?: () => string
}) | undefined
const LEGACY_ENCRYPTED_WEBHOOK_SECRET_PREFIX = 'enc:v1:'
const ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION = 2

type DbRow = Record<string, unknown>
type WorkflowWriteOptions = {
  now?: Date
}
type WorkflowSecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString?: (value: string) => Buffer
  decryptString?: (value: Buffer) => string
}
type EncryptedWebhookSecretRecord = {
  __openCoworkEncryptedWebhookSecret: typeof ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION
  value: string
}

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

function boundedText(value: unknown, label: string, max = MAX_TEXT) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (Buffer.byteLength(trimmed, 'utf8') > max) throw new Error(`${label} is too large.`)
  return trimmed
}

function boundedOptionalText(value: unknown, label: string, max = MAX_TEXT) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > max) throw new Error(`${label} is too large.`)
  return trimmed
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
    isPackaged: Boolean(electronApp?.isPackaged),
    encryptionAvailable: Boolean(electronSafeStorage?.isEncryptionAvailable?.()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      electronSafeStorageBackend?.getSelectedStorageBackend?.bind(electronSafeStorageBackend),
    ),
  })
  return {
    mode,
    encryptString: electronSafeStorage?.encryptString?.bind(electronSafeStorage),
    decryptString: electronSafeStorage?.decryptString?.bind(electronSafeStorage),
  }
}

function isEncryptedWebhookSecretRecord(value: unknown): value is EncryptedWebhookSecretRecord {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Partial<EncryptedWebhookSecretRecord>).__openCoworkEncryptedWebhookSecret === ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION
    && typeof (value as Partial<EncryptedWebhookSecretRecord>).value === 'string',
  )
}

function encryptWebhookSecretValue(storage: WorkflowSecretStorageAdapter, secret: string): EncryptedWebhookSecretRecord {
  if (!storage.encryptString) throw new Error('Electron safeStorage is unavailable')
  return {
    __openCoworkEncryptedWebhookSecret: ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION,
    value: Buffer.from(storage.encryptString(secret)).toString('base64'),
  }
}

function tryDecryptWebhookSecretPayload(storage: WorkflowSecretStorageAdapter, payload: string) {
  if (!storage.decryptString) return null
  try {
    return storage.decryptString(Buffer.from(payload, 'base64'))
  } catch {
    return null
  }
}

function encodeWebhookSecretForStorage(secret: unknown): string | EncryptedWebhookSecretRecord | null {
  if (isEncryptedWebhookSecretRecord(secret)) return secret
  if (typeof secret !== 'string' || !secret) return null
  const storage = getWorkflowSecretStorage()
  if (storage.mode === 'encrypted') {
    return encryptWebhookSecretValue(storage, secret)
  }
  if (storage.mode === 'plaintext') return secret
  throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist workflow webhook secrets in production without OS-backed secret storage.')
}

function decodeWebhookSecretFromStorage(secret: unknown) {
  const storage = getWorkflowSecretStorage()
  if (isEncryptedWebhookSecretRecord(secret)) {
    return tryDecryptWebhookSecretPayload(storage, secret.value) ?? secret
  }

  if (typeof secret !== 'string' || !secret.trim()) return null
  if (!secret.startsWith(LEGACY_ENCRYPTED_WEBHOOK_SECRET_PREFIX)) return secret

  const legacyPayload = secret.slice(LEGACY_ENCRYPTED_WEBHOOK_SECRET_PREFIX.length)
  const decrypted = tryDecryptWebhookSecretPayload(storage, legacyPayload)
  // Older builds stored encrypted webhook secrets as strings prefixed with
  // enc:v1:. If decryption fails, preserve the original value so an imported
  // plaintext secret with that literal prefix still round-trips.
  return decrypted ?? secret
}

export function serializeWorkflowTriggersForStorage(triggers: WorkflowTrigger[]) {
  return JSON.stringify(triggers.map((trigger) => trigger.type === 'webhook'
    ? { ...trigger, webhookSecret: encodeWebhookSecretForStorage(trigger.webhookSecret) }
    : trigger))
}

export function parseWorkflowTriggersFromStorage(value: unknown) {
  const parsed = parseJson<unknown>(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((raw): WorkflowTrigger[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const trigger = raw as Partial<WorkflowTrigger>
    if (!VALID_TRIGGER_TYPES.has(trigger.type as WorkflowTriggerType)) return []
    return [trigger.type === 'webhook'
      ? { ...trigger, webhookSecret: decodeWebhookSecretFromStorage(trigger.webhookSecret) } as WorkflowTrigger
      : trigger as WorkflowTrigger]
  })
}

export function setWorkflowSecretStorageForTests(adapter: WorkflowSecretStorageAdapter | null) {
  workflowSecretStorageForTests = adapter
}

function normalizeStringList(value: unknown, label: string) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return Array.from(new Set(value.map((item) => boundedText(item, `${label} entry`, 256)))).slice(0, MAX_LIST_ITEMS)
}

function randomSecret() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

function writeNow(options?: WorkflowWriteOptions) {
  return options?.now ?? new Date()
}

export function normalizeWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
  const title = boundedText(draft.title, 'Workflow title', 512)
  const instructions = boundedText(draft.instructions, 'Workflow instructions', MAX_TEXT)
  const agentName = boundedText(draft.agentName || 'build', 'Workflow agent', 256)
  const triggers = normalizeWorkflowTriggers(draft.triggers)
  if (!triggers.some((trigger) => trigger.type === 'manual')) {
    triggers.unshift({ id: crypto.randomUUID(), type: 'manual', enabled: true })
  }
  return {
    title,
    instructions,
    agentName,
    skillNames: normalizeStringList(draft.skillNames, 'Workflow skillNames'),
    toolIds: normalizeStringList(draft.toolIds, 'Workflow toolIds'),
    projectDirectory: boundedOptionalText(draft.projectDirectory, 'Workflow projectDirectory', 4096),
    draftSessionId: boundedOptionalText(draft.draftSessionId, 'Workflow draftSessionId', 256),
    triggers,
  }
}

function normalizeWorkflowTriggers(value: unknown): WorkflowTrigger[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Workflow requires at least one trigger.')
  }
  return value.slice(0, 8).map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Workflow trigger must be an object.')
    const trigger = raw as Partial<WorkflowTrigger>
    const type = String(trigger.type || '')
    if (!VALID_TRIGGER_TYPES.has(type as WorkflowTriggerType)) throw new Error('Workflow trigger type is invalid.')
    const normalized: WorkflowTrigger = {
      id: typeof trigger.id === 'string' && trigger.id.trim() ? trigger.id.trim() : crypto.randomUUID(),
      type: type as WorkflowTriggerType,
      enabled: trigger.enabled !== false,
      schedule: null,
      webhookSecret: null,
    }
    if (normalized.type === 'schedule') {
      if (!trigger.schedule) throw new Error('Scheduled workflow trigger requires a schedule.')
      const scheduleError = validateWorkflowSchedule(trigger.schedule)
      if (scheduleError) throw new Error(scheduleError)
      normalized.schedule = trigger.schedule
    }
    if (normalized.type === 'webhook') {
      normalized.webhookSecret = typeof trigger.webhookSecret === 'string' && trigger.webhookSecret.trim()
        ? trigger.webhookSecret.trim()
        : randomSecret()
    }
    return normalized
  })
}

function initDb(db: DatabaseSync) {
  db.exec(`
    create table if not exists workflow_meta (
      key text primary key,
      value text not null
    );
    create table if not exists workflows (
      id text primary key,
      title text not null,
      instructions text not null,
      agent_name text not null,
      skill_names_json text not null,
      tool_ids_json text not null,
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
    create table if not exists workflow_runs (
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
    create index if not exists idx_workflow_runs_workflow on workflow_runs(workflow_id, created_at);
    create index if not exists idx_workflows_due on workflows(status, next_run_at);
  `)
  db.prepare(`
    insert into workflow_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(WORKFLOW_SCHEMA_VERSION_KEY, String(WORKFLOW_DB_SCHEMA_VERSION))
}

export function getWorkflowDb() {
  if (workflowDb) return workflowDb
  const dbPath = workflowDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    initDb(db)
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
    ensureWorkflowDbFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      ensureWorkflowDbFileModes()
    }
    throw error
  }
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
  const workflow: WorkflowSummary = {
    id: String(row.id || ''),
    title: String(row.title || ''),
    instructions: String(row.instructions || ''),
    agentName: String(row.agent_name || 'build'),
    skillNames: parseJson<string[]>(row.skill_names_json, []),
    toolIds: parseJson<string[]>(row.tool_ids_json, []),
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
  const triggerType = VALID_TRIGGER_TYPES.has(String(row.trigger_type) as WorkflowTriggerType)
    ? String(row.trigger_type) as WorkflowTriggerType
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

export function previewWorkflowDraft(draft: WorkflowDraft): WorkflowToolPreview {
  const missing: string[] = []
  try {
    const normalizedDraft = normalizeWorkflowDraft(draft)
    return {
      ok: missing.length === 0,
      title: normalizedDraft.title,
      summary: normalizedDraft.instructions.slice(0, 500),
      missing,
      normalizedDraft,
    }
  } catch (error) {
    return {
      ok: false,
      title: typeof draft.title === 'string' ? draft.title : 'Workflow draft',
      summary: error instanceof Error ? error.message : 'Workflow draft is invalid.',
      missing: [error instanceof Error ? error.message : 'Workflow draft is invalid.'],
    }
  }
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
  const normalized = normalizeWorkflowDraft(draft)
  const nowDate = writeNow(options)
  const now = nowDate.toISOString()
  const id = crypto.randomUUID()
  const nextRunAt = computeNextWorkflowRunAt(normalized.triggers, nowDate)
  withTransaction((db) => {
    db.prepare(`
      insert into workflows (
        id, title, instructions, agent_name, skill_names_json, tool_ids_json, status,
        project_directory, draft_session_id, triggers_json, created_at, updated_at,
        next_run_at, last_run_at, latest_run_id, latest_run_status, latest_run_session_id, latest_run_summary
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null)
    `).run(
      id,
      normalized.title,
      normalized.instructions,
      normalized.agentName,
      JSON.stringify(normalized.skillNames || []),
      JSON.stringify(normalized.toolIds || []),
      'active',
      normalized.projectDirectory || null,
      normalized.draftSessionId || null,
      serializeWorkflowTriggersForStorage(normalized.triggers),
      now,
      now,
      nextRunAt,
    )
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
  })
  return getWorkflow(workflowId, webhookBaseUrl)
}

export function regenerateWorkflowWebhookSecret(workflowId: string, webhookBaseUrl?: string | null) {
  const detail = getWorkflow(workflowId, webhookBaseUrl)
  if (!detail) return null
  const triggers = detail.triggers.map((trigger) => trigger.type === 'webhook'
    ? { ...trigger, webhookSecret: randomSecret() }
    : trigger)
  const now = new Date().toISOString()
  withTransaction((db) => {
    db.prepare('update workflows set triggers_json = ?, updated_at = ? where id = ?')
      .run(serializeWorkflowTriggersForStorage(triggers), now, workflowId)
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
  })
  return getWorkflowRun(id)
}

export function claimDueWorkflowRun(now = new Date()) {
  const claimedAt = now.toISOString()
  return withTransaction((db) => {
    for (let attempt = 0; attempt < MAX_LIST_ITEMS; attempt += 1) {
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

      return getWorkflowRun(runId)
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
  withTransaction((db) => {
    db.prepare('update workflow_runs set session_id = ?, status = ?, started_at = coalesce(started_at, ?) where id = ?')
      .run(sessionId, 'running', now, runId)
    db.prepare(`
      update workflows
      set latest_run_id = ?, latest_run_status = ?, latest_run_session_id = ?, updated_at = ?, status = ?
      where id = ?
    `).run(runId, 'running', sessionId, now, 'running', workflowId)
  })
  return getWorkflowRun(runId)
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
  withTransaction((db) => {
    db.prepare('update workflow_runs set status = ?, summary = ?, finished_at = ? where id = ?')
      .run('completed', summary, now, runId)
    db.prepare(`
      update workflows
      set status = ?, latest_run_id = ?, latest_run_status = 'completed',
        latest_run_summary = ?, last_run_at = ?, next_run_at = ?, updated_at = ?
      where id = ?
    `).run(nextStatus, runId, summary, now, nextRunAt, now, run.workflowId)
  })
  return getWorkflowRun(runId)
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
  withTransaction((db) => {
    db.prepare('update workflow_runs set status = ?, error = ?, finished_at = ? where id = ?')
      .run('failed', error, now, runId)
    db.prepare(`
      update workflows
      set status = ?, latest_run_id = ?, latest_run_status = 'failed',
        latest_run_summary = ?, next_run_at = ?, updated_at = ?
      where id = ?
    `).run(nextStatus, runId, error, nextRunAt, now, run.workflowId)
  })
  return getWorkflowRun(runId)
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

      recovered.push(rowToRun({
        ...row,
        status: 'failed',
        error,
        finished_at: finishedAt,
      }))
    }
    return recovered
  })
}

export function clearWorkflowStoreCache() {
  workflowDb?.close()
  workflowDb = null
}
