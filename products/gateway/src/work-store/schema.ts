import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface WorkStoreSchemaInspection {
  tables: string[]
  columns: Record<string, string[]>
  indexes: Record<string, string[]>
  signature: string
}

export const CURRENT_WORK_STORE_SCHEMA_VERSION = 3

export class UnsupportedWorkStoreSchemaVersionError extends Error {
  readonly foundVersion: number
  readonly supportedVersion: number

  constructor(foundVersion: number, supportedVersion = CURRENT_WORK_STORE_SCHEMA_VERSION) {
    super(`Gateway state schema version ${foundVersion} is newer than this binary supports (${supportedVersion})`)
    this.name = 'UnsupportedWorkStoreSchemaVersionError'
    this.foundVersion = foundVersion
    this.supportedVersion = supportedVersion
  }
}

// Schema introspection. The signature locks the effective SQLite schema
// (tables/columns/indexes) against the whole-create DDL and migration result so
// accidental drift is caught by tests.
export function inspectWorkStoreSqliteSchema(db: DatabaseSync): WorkStoreSchemaInspection {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[])
    .map(row => String(row.name))
  const columns: Record<string, string[]> = {}
  const indexes: Record<string, string[]> = {}
  for (const table of tables) {
    const tableId = sqliteIdentifier(table)
    columns[table] = (db.prepare(`PRAGMA table_info(${tableId})`).all() as any[])
      .map(row => [
        String(row.name),
        String(row.type || ''),
        Number(row.notnull || 0),
        row.dflt_value === null || row.dflt_value === undefined ? '' : String(row.dflt_value),
        Number(row.pk || 0),
      ].join(':'))
    indexes[table] = (db.prepare(`PRAGMA index_list(${tableId})`).all() as any[])
      .map(row => ({ name: String(row.name), unique: Number(row.unique || 0), origin: String(row.origin || '') }))
      .filter(row => row.origin !== 'pk' && !row.name.startsWith('sqlite_autoindex_'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(row => {
        const indexColumns = (db.prepare(`PRAGMA index_info(${sqliteIdentifier(row.name)})`).all() as any[])
          .map(column => String(column.name))
          .join(',')
        return `${row.name}:${row.unique}:${indexColumns}`
      })
  }
  return {
    tables,
    columns,
    indexes,
    signature: workStoreSchemaSignature({ tables, columns, indexes }),
  }
}

function workStoreSchemaSignature(stable: Pick<WorkStoreSchemaInspection, 'tables' | 'columns' | 'indexes'>): string {
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function sqliteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe sqlite identifier: ${name}`)
  return `"${name}"`
}

/**
 * Whole-create DDL for the current work-store SQLite schema. Existing databases
 * are advanced by {@link migrateWorkStoreSchema}; this remains idempotent so a
 * legacy version-0 database can be identified and adopted without losing rows.
 */
export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roadmaps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'done', 'blocked', 'archived')),
      priority TEXT NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
      source TEXT NOT NULL,
      agent_team TEXT,
      environment_json TEXT,
      quality_spec_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      roadmap_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived')),
      priority TEXT NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
      agent TEXT NOT NULL,
      agent_team TEXT,
      stage_profiles_json TEXT,
      environment_json TEXT,
      pipeline_json TEXT NOT NULL,
      current_stage TEXT,
      current_run_id TEXT,
      attempts_json TEXT NOT NULL,
      note TEXT,
      earliest_start_at TEXT,
      deadline_at TEXT,
      recurrence TEXT,
      manual_gate TEXT,
      sla_class TEXT,
      quality_spec_json TEXT,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_type, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_roadmap ON tasks(roadmap_id);
    CREATE TABLE IF NOT EXISTS work_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, depends_on_task_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_work_dependencies_task ON work_dependencies(task_id);
    CREATE INDEX IF NOT EXISTS idx_work_dependencies_depends ON work_dependencies(depends_on_task_id);
    CREATE TABLE IF NOT EXISTS roadmap_supervisors (
      supervisor_id TEXT PRIMARY KEY,
      roadmap_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      status TEXT NOT NULL,
      is_default INTEGER NOT NULL,
      cadence_json TEXT NOT NULL,
      event_triggers_json TEXT NOT NULL,
      last_reviewed_event_id INTEGER,
      last_review_at TEXT,
      next_review_at TEXT,
      completion_policy_json TEXT NOT NULL,
      notification_policy_ref TEXT,
      note TEXT,
      wake_lease_owner TEXT,
      wake_lease_expires_at TEXT,
      last_wake_at TEXT,
      last_wake_reason TEXT,
      last_wake_event_id INTEGER,
      last_result_hash TEXT,
      last_result_at TEXT,
      last_result_status TEXT,
      last_result_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_supervisors_roadmap ON roadmap_supervisors(roadmap_id, status, is_default, created_at);
    CREATE INDEX IF NOT EXISTS idx_roadmap_supervisors_session ON roadmap_supervisors(session_id);
    CREATE TABLE IF NOT EXISTS supervisor_wakeup_receipts (
      id TEXT PRIMARY KEY,
      supervisor_id TEXT NOT NULL,
      roadmap_id TEXT NOT NULL,
      wake_reason TEXT NOT NULL,
      reason_detail TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      window_key TEXT NOT NULL,
      cursor_event_id INTEGER NOT NULL,
      trigger_event_ids_json TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      inspected_inputs_json TEXT NOT NULL DEFAULT '[]',
      changed_object_ids_json TEXT NOT NULL DEFAULT '[]',
      recommendation TEXT,
      next_action TEXT,
      next_wake_at TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_wakeup_receipts_supervisor ON supervisor_wakeup_receipts(supervisor_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_supervisor_wakeup_receipts_roadmap ON supervisor_wakeup_receipts(roadmap_id, status, created_at);
    CREATE TABLE IF NOT EXISTS task_dispatch_receipts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      profile TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      session_id TEXT,
      environment_json TEXT,
      acquisition_journal_json TEXT NOT NULL DEFAULT '[]',
      prompt_submitted_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_task ON task_dispatch_receipts(task_id, status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_status ON task_dispatch_receipts(status, lease_expires_at);
    CREATE TABLE IF NOT EXISTS task_run_counters (
      task_id TEXT PRIMARY KEY,
      pruned_runs INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delegation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      task_ids_json TEXT NOT NULL,
      roadmap_id TEXT,
      supervisor_id TEXT,
      project_binding_id TEXT,
      parent_session_id TEXT,
      links_json TEXT NOT NULL,
      next_scheduler_action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_receipts_roadmap ON delegation_receipts(roadmap_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_receipts_parent ON delegation_receipts(parent_session_id);
    CREATE TABLE IF NOT EXISTS delegation_progress_receipts (
      progress_key TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      progress TEXT NOT NULL,
      subject_id TEXT,
      event_id INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_progress_receipts_delegation ON delegation_progress_receipts(idempotency_key, progress, created_at);
    CREATE INDEX IF NOT EXISTS idx_delegation_progress_receipts_event ON delegation_progress_receipts(event_id);
    CREATE TABLE IF NOT EXISTS delegation_progress_route_receipts (
      dedupe_key TEXT PRIMARY KEY,
      progress_key TEXT,
      idempotency_key TEXT,
      progress TEXT,
      target_key TEXT,
      provider TEXT,
      session_id TEXT,
      delivery TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      error TEXT,
      deferred_until TEXT,
      suppressed_until TEXT,
      progress_event_id INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_event_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_progress_route_receipts_delegation ON delegation_progress_route_receipts(idempotency_key, progress, updated_at);
    CREATE INDEX IF NOT EXISTS idx_delegation_progress_route_receipts_progress ON delegation_progress_route_receipts(progress_key, updated_at);
    CREATE INDEX IF NOT EXISTS idx_delegation_progress_route_receipts_state ON delegation_progress_route_receipts(state, updated_at);
    CREATE TABLE IF NOT EXISTS project_bindings (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      roadmap_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      provider TEXT,
      chat_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      title TEXT,
      notification_mode TEXT NOT NULL DEFAULT 'immediate',
      muted_until TEXT,
      quiet_hours_json TEXT NOT NULL DEFAULT '{}',
      last_digest_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_bindings_alias ON project_bindings(alias, scope);
    CREATE INDEX IF NOT EXISTS idx_project_bindings_roadmap ON project_bindings(roadmap_id);
    CREATE INDEX IF NOT EXISTS idx_project_bindings_session ON project_bindings(session_id);
    CREATE INDEX IF NOT EXISTS idx_project_bindings_channel ON project_bindings(provider, chat_id, thread_id);
    CREATE TABLE IF NOT EXISTS roadmap_completion_proposals (
      id TEXT PRIMARY KEY,
      roadmap_id TEXT NOT NULL,
      proposed_by TEXT,
      session_id TEXT,
      evidence_json TEXT NOT NULL,
      unresolved_risks_json TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      status TEXT NOT NULL,
      decision_by TEXT,
      decision_note TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_completion_proposals_roadmap ON roadmap_completion_proposals(roadmap_id, status, created_at);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      agent_team TEXT,
      agent_team_version TEXT,
      resolved_profile TEXT,
      resolved_agent TEXT,
      environment_json TEXT,
      runtime_profile_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'blocked', 'errored')),
      attempt INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      scheduler_generation TEXT,
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      runtime_ms INTEGER,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    CREATE TABLE IF NOT EXISTS human_gates (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      roadmap_id TEXT,
      task_id TEXT,
      run_id TEXT,
      stage TEXT,
      reason TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      timeout_action TEXT NOT NULL,
      escalated_at TEXT,
      decided_by TEXT,
      decision_note TEXT,
      scope TEXT,
      scope_key TEXT,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_human_gates_status ON human_gates(status, requested_at);
    CREATE INDEX IF NOT EXISTS idx_human_gates_task ON human_gates(task_id, status);
    CREATE INDEX IF NOT EXISTS idx_human_gates_scope ON human_gates(scope_key, status, scope);
    CREATE TABLE IF NOT EXISTS promotion_scorecards (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_name TEXT NOT NULL,
      subject_revision TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_version TEXT,
      metrics_json TEXT NOT NULL,
      thresholds_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      status TEXT NOT NULL,
      regression_json TEXT,
      gate_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_promotion_scorecards_subject ON promotion_scorecards(subject_kind, subject_name, updated_at);
    CREATE INDEX IF NOT EXISTS idx_promotion_scorecards_source ON promotion_scorecards(source_kind, source_id, source_version);
    CREATE TABLE IF NOT EXISTS promotion_decisions (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_name TEXT NOT NULL,
      subject_revision TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      scorecard_id TEXT,
      gate_id TEXT,
      status TEXT NOT NULL,
      actor TEXT,
      source TEXT,
      note TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_promotion_decisions_subject ON promotion_decisions(subject_kind, subject_name, updated_at);
    CREATE INDEX IF NOT EXISTS idx_promotion_decisions_gate ON promotion_decisions(gate_id);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      source TEXT NOT NULL,
      target TEXT,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      next_action TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_notified_at TEXT,
      resolved_at TEXT,
      acknowledged_at TEXT,
      suppressed_until TEXT,
      dedupe_count INTEGER NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status_seen ON alerts(status, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_key_status ON alerts(key, status);
    CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts(source, status);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      subject_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
    CREATE TABLE IF NOT EXISTS audit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      source_event_id INTEGER UNIQUE,
      source_event_type TEXT,
      class TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_ref TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_ref TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      correlation_id TEXT,
      retention_class TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      redacted_payload_json TEXT NOT NULL,
      previous_hash TEXT,
      entry_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_class_occurred ON audit_ledger(class, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_trace ON audit_ledger(trace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_correlation ON audit_ledger(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_source_type ON audit_ledger(source_event_type, source_event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_source_event ON audit_ledger(source_event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ledger_occurred ON audit_ledger(occurred_at);
    CREATE TABLE IF NOT EXISTS channel_bindings (
      provider TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'chat',
      roadmap_id TEXT,
      task_id TEXT,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, chat_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_session ON channel_bindings(session_id);
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_task ON channel_bindings(task_id);
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_roadmap ON channel_bindings(roadmap_id);
    CREATE TABLE IF NOT EXISTS channel_claim_codes (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      code_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_target_hash TEXT,
      denied_at TEXT,
      denial_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_claim_codes_provider_status ON channel_claim_codes(provider, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_channel_claim_codes_status_expires ON channel_claim_codes(status, expires_at);
    CREATE TABLE IF NOT EXISTS agent_presences (
      presence_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      opencode_agent TEXT NOT NULL,
      session_id TEXT,
      directory TEXT,
      profile TEXT,
      status TEXT NOT NULL,
      wake_json TEXT NOT NULL DEFAULT '{}',
      provider TEXT,
      chat_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_presences_status ON agent_presences(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_agent_presences_session ON agent_presences(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_presences_channel ON agent_presences(provider, chat_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_agent_presences_agent ON agent_presences(opencode_agent);
    CREATE TABLE IF NOT EXISTS session_admissions (
      admission_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      idempotency_key TEXT,
      purpose TEXT NOT NULL,
      agent TEXT,
      directory TEXT,
      presence_id TEXT,
      task_id TEXT,
      peer_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_admissions_session ON session_admissions(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_session_admissions_created ON session_admissions(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_admissions_idempotency ON session_admissions(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(earliest_start_at, deadline_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_dispatch_receipts_stage_profile ON task_dispatch_receipts(stage, profile, status, lease_expires_at)')
}

/**
 * Adopt legacy version-0 databases and apply every pending migration under one
 * write lock. SQLite DDL and `user_version` changes are transactional, so an
 * interrupted migration leaves both schema and version at the previous state.
 */
export function migrateWorkStoreSchema(db: DatabaseSync): number {
  const foundVersion = workStoreSchemaVersion(db)
  assertSupportedWorkStoreSchemaVersion(foundVersion)
  if (foundVersion === CURRENT_WORK_STORE_SCHEMA_VERSION) return foundVersion

  db.exec('BEGIN IMMEDIATE')
  try {
    let version = foundVersion
    if (version === 0) {
      // All databases produced before durable versioning are the version-1
      // baseline. Whole-create fills tables/indexes that are absent while
      // preserving every existing row and column.
      initializeSchema(db)
      version = 1
      setWorkStoreSchemaVersion(db, version)
    }
    if (version === 1) {
      addColumnIfMissing(db, 'task_dispatch_receipts', 'acquisition_journal_json', "TEXT NOT NULL DEFAULT '[]'")
      version = 2
      setWorkStoreSchemaVersion(db, version)
    }
    if (version === 2) {
      addColumnIfMissing(db, 'session_admissions', 'status', "TEXT NOT NULL DEFAULT 'active'")
      addColumnIfMissing(db, 'session_admissions', 'idempotency_key', 'TEXT')
      addColumnIfMissing(db, 'session_admissions', 'last_error', 'TEXT')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_admissions_idempotency ON session_admissions(idempotency_key) WHERE idempotency_key IS NOT NULL')
      version = 3
      setWorkStoreSchemaVersion(db, version)
    }
    if (version !== CURRENT_WORK_STORE_SCHEMA_VERSION) {
      throw new Error(`No work-store migration path from schema version ${version} to ${CURRENT_WORK_STORE_SCHEMA_VERSION}`)
    }
    db.exec('COMMIT')
    return version
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

export function workStoreSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined
  const version = Number(row?.user_version ?? 0)
  return Number.isSafeInteger(version) && version >= 0 ? version : 0
}

export function assertSupportedWorkStoreSchemaVersion(version: number): void {
  if (version > CURRENT_WORK_STORE_SCHEMA_VERSION) throw new UnsupportedWorkStoreSchemaVersionError(version)
}

function setWorkStoreSchemaVersion(db: DatabaseSync, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`invalid work-store schema version: ${version}`)
  db.exec(`PRAGMA user_version = ${version}`)
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const tableId = sqliteIdentifier(table)
  const exists = (db.prepare(`PRAGMA table_info(${tableId})`).all() as Array<{ name?: unknown }>)
    .some(row => String(row.name || '') === column)
  if (exists) return
  db.exec(`ALTER TABLE ${tableId} ADD COLUMN ${sqliteIdentifier(column)} ${definition}`)
}
