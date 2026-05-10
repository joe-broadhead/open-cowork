import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  COWORK_CREW_SCHEMA_VERSION,
  COWORK_EVAL_SCHEMA_VERSION,
  COWORK_TRACE_EVENT_SCHEMA_VERSION,
  type CoworkWorkItem,
  type CrewDefinition,
  type CrewApproval,
  type CrewApprovalStatus,
  type CrewArtifact,
  type CrewLifecycleStatus,
  type CrewMember,
  type CrewRun,
  type CrewRunNode,
  type CrewRunNodeKind,
  type CrewRunNodeStatus,
  type CrewRunStatus,
  type CrewVersion,
  type EvalCase,
  type EvalSuite,
  type OutcomeEvaluation,
  type OutcomeEvaluationStatus,
  type OutcomeRubric,
  type PolicyDecision,
  type PolicyDecisionStatus,
  createCoworkTraceEvent,
  serializeCoworkTraceEvent,
  sortCoworkTraceEvents,
  type CoworkRunKind,
  type CoworkTraceEvent,
  type TraceActorKind,
  type TraceEventSource,
  type TraceRedactionState,
  type TraceTokenUsage,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'

export const CREW_STORE_SCHEMA_VERSION = 1
const CREW_SCHEMA_VERSION_KEY = 'schema_version'

type DbRow = Record<string, unknown>

let crewDb: DatabaseSync | null = null
let crewTransactionCounter = 0

function getCrewDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'crew.sqlite')
}

function ensureCrewDbFileModes(dbPath = getCrewDbPath()) {
  if (process.platform === 'win32') return
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue
    chmodSync(path, 0o600)
  }
}

function ensureMetaTable(db: DatabaseSync) {
  db.exec(`
    create table if not exists crew_meta (
      key text primary key,
      value text not null
    );
  `)
}

function readCrewStoreSchemaVersion(db: DatabaseSync) {
  const row = db.prepare('select value from crew_meta where key = ?')
    .get(CREW_SCHEMA_VERSION_KEY) as { value?: string } | undefined
  const version = Number(row?.value || 0)
  return Number.isInteger(version) && version >= 0 ? version : 0
}

function assertSupportedCrewStoreSchemaVersion(db: DatabaseSync) {
  const version = readCrewStoreSchemaVersion(db)
  if (version > CREW_STORE_SCHEMA_VERSION) {
    throw new Error(`Crew database schema version ${version} is newer than supported version ${CREW_STORE_SCHEMA_VERSION}.`)
  }
}

function recordCrewStoreSchemaVersion(db: DatabaseSync) {
  db.prepare(`
    insert into crew_meta (key, value)
    values (?, ?)
    on conflict(key) do update set value = excluded.value
  `).run(CREW_SCHEMA_VERSION_KEY, String(CREW_STORE_SCHEMA_VERSION))
}

export function getCrewDb() {
  if (crewDb) return crewDb
  const dbPath = getCrewDbPath()
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('pragma journal_mode = WAL;')
    ensureMetaTable(db)
    assertSupportedCrewStoreSchemaVersion(db)
    db.exec(`
      create table if not exists crew_trace_events (
        id text primary key,
        schema_version integer not null,
        sequence integer not null,
        run_id text not null,
        run_kind text not null,
        source text not null,
        source_event_id text,
        correlation_id text,
        causation_id text,
        session_id text,
        parent_session_id text,
        actor_kind text not null,
        actor_id text not null,
        node_id text,
        artifact_id text,
        approval_id text,
        policy_decision_id text,
        input_hash text,
        output_hash text,
        payload_ref text,
        payload_hash text,
        redaction_state text not null,
        token_usage_json text,
        cost_usd real,
        payload_json text,
        created_at text not null
      );

      create index if not exists idx_crew_trace_events_run_sequence
        on crew_trace_events (run_id, sequence, created_at, id);

      create table if not exists crew_definitions (
        id text primary key,
        schema_version integer not null,
        name text not null,
        description text not null,
        status text not null,
        active_version_id text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists crew_versions (
        id text primary key,
        schema_version integer not null,
        crew_id text not null,
        version integer not null,
        members_json text not null,
        workspace_profile_id text,
        outcome_rubric_id text,
        budget_cap_usd real,
        workflow_json text not null,
        created_at text not null,
        created_by text,
        unique (crew_id, version)
      );

      create table if not exists crew_runs (
        id text primary key,
        schema_version integer not null,
        crew_id text not null,
        crew_version_id text not null,
        work_item_id text,
        status text not null,
        title text not null,
        summary text,
        root_session_id text,
        created_at text not null,
        started_at text,
        finished_at text
      );

      create table if not exists crew_run_nodes (
        id text primary key,
        schema_version integer not null,
        crew_run_id text not null,
        sequence integer not null,
        kind text not null,
        status text not null,
        agent_name text,
        session_id text,
        parent_node_id text,
        title text not null,
        created_at text not null,
        started_at text,
        finished_at text
      );

      create table if not exists cowork_work_items (
        id text primary key,
        schema_version integer not null,
        title text not null,
        description text not null,
        source text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists crew_artifacts (
        id text primary key,
        schema_version integer not null,
        crew_run_id text not null,
        node_id text,
        title text not null,
        mime text not null,
        uri text not null,
        hash text,
        created_at text not null
      );

      create table if not exists crew_approvals (
        id text primary key,
        schema_version integer not null,
        crew_run_id text not null,
        node_id text,
        status text not null,
        title text not null,
        body text not null,
        requested_at text not null,
        resolved_at text,
        resolved_by text
      );

      create table if not exists policy_decisions (
        id text primary key,
        schema_version integer not null,
        run_id text not null,
        run_kind text not null,
        node_id text,
        status text not null,
        reason text not null,
        capability_id text,
        created_at text not null
      );

      create table if not exists outcome_rubrics (
        id text primary key,
        schema_version integer not null,
        name text not null,
        description text not null,
        criteria_json text not null,
        passing_score real not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists eval_suites (
        id text primary key,
        schema_version integer not null,
        name text not null,
        description text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists eval_cases (
        id text primary key,
        schema_version integer not null,
        suite_id text not null,
        name text not null,
        input_ref text not null,
        expected_outcome text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists outcome_evaluations (
        id text primary key,
        schema_version integer not null,
        crew_run_id text not null,
        evaluator_agent_name text not null,
        rubric_id text not null,
        status text not null,
        score real not null,
        evidence_trace_event_ids_json text not null,
        recommendation text not null,
        created_at text not null
      );

      create index if not exists idx_crew_versions_crew_version
        on crew_versions (crew_id, version);

      create index if not exists idx_crew_runs_crew_status
        on crew_runs (crew_id, status, created_at);

      create index if not exists idx_crew_run_nodes_run
        on crew_run_nodes (crew_run_id, sequence);

      create index if not exists idx_cowork_work_items_status
        on cowork_work_items (status, created_at);

      create index if not exists idx_crew_artifacts_run
        on crew_artifacts (crew_run_id, created_at);

      create index if not exists idx_crew_approvals_run
        on crew_approvals (crew_run_id, requested_at);

      create index if not exists idx_policy_decisions_run
        on policy_decisions (run_kind, run_id, created_at);

      create index if not exists idx_eval_cases_suite
        on eval_cases (suite_id, created_at);

      create index if not exists idx_outcome_evaluations_run
        on outcome_evaluations (crew_run_id, created_at);
    `)
    recordCrewStoreSchemaVersion(db)
    ensureCrewDbFileModes(dbPath)
    crewDb = db
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function clearCrewStoreCache() {
  crewDb?.close()
  crewDb = null
}

export function withCrewTransaction<T>(callback: (db: DatabaseSync) => T): T {
  const db = getCrewDb()
  const savepoint = `crew_tx_${crewTransactionCounter += 1}`
  db.exec(`savepoint ${savepoint}`)
  try {
    const result = callback(db)
    db.exec(`release savepoint ${savepoint}`)
    ensureCrewDbFileModes()
    return result
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${savepoint}`)
    } finally {
      db.exec(`release savepoint ${savepoint}`)
      ensureCrewDbFileModes()
    }
    throw error
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function requiredText(value: string, label: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}

function nowIso() {
  return new Date().toISOString()
}

function rowToCrewDefinition(row: DbRow): CrewDefinition {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    name: String(row.name || ''),
    description: String(row.description || ''),
    status: String(row.status || 'draft') as CrewLifecycleStatus,
    activeVersionId: typeof row.active_version_id === 'string' ? row.active_version_id : null,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToCrewVersion(row: DbRow): CrewVersion {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewId: String(row.crew_id || ''),
    version: Number(row.version || 0),
    members: parseJson<CrewMember[]>(row.members_json, []),
    workspaceProfileId: typeof row.workspace_profile_id === 'string' ? row.workspace_profile_id : null,
    outcomeRubricId: typeof row.outcome_rubric_id === 'string' ? row.outcome_rubric_id : null,
    budgetCapUsd: typeof row.budget_cap_usd === 'number' ? row.budget_cap_usd : null,
    workflow: parseJson<CrewVersion['workflow']>(row.workflow_json, []),
    createdAt: String(row.created_at || ''),
    createdBy: typeof row.created_by === 'string' ? row.created_by : null,
  }
}

function rowToCrewRun(row: DbRow): CrewRun {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewId: String(row.crew_id || ''),
    crewVersionId: String(row.crew_version_id || ''),
    workItemId: typeof row.work_item_id === 'string' ? row.work_item_id : null,
    status: String(row.status || 'queued') as CrewRunStatus,
    title: String(row.title || ''),
    summary: typeof row.summary === 'string' ? row.summary : null,
    rootSessionId: typeof row.root_session_id === 'string' ? row.root_session_id : null,
    createdAt: String(row.created_at || ''),
    startedAt: typeof row.started_at === 'string' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}

function rowToCrewRunNode(row: DbRow): CrewRunNode {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewRunId: String(row.crew_run_id || ''),
    sequence: Number(row.sequence || 0),
    kind: String(row.kind || 'system') as CrewRunNodeKind,
    status: String(row.status || 'queued') as CrewRunNodeStatus,
    agentName: typeof row.agent_name === 'string' ? row.agent_name : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    parentNodeId: typeof row.parent_node_id === 'string' ? row.parent_node_id : null,
    title: String(row.title || ''),
    startedAt: typeof row.started_at === 'string' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}

function rowToCoworkWorkItem(row: DbRow): CoworkWorkItem {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    source: String(row.source || 'manual') as CoworkWorkItem['source'],
    status: String(row.status || 'queued') as CoworkWorkItem['status'],
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToCrewArtifact(row: DbRow): CrewArtifact {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewRunId: String(row.crew_run_id || ''),
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    title: String(row.title || ''),
    mime: String(row.mime || ''),
    uri: String(row.uri || ''),
    hash: typeof row.hash === 'string' ? row.hash : null,
    createdAt: String(row.created_at || ''),
  }
}

function rowToCrewApproval(row: DbRow): CrewApproval {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewRunId: String(row.crew_run_id || ''),
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    status: String(row.status || 'requested') as CrewApprovalStatus,
    title: String(row.title || ''),
    body: String(row.body || ''),
    requestedAt: String(row.requested_at || ''),
    resolvedAt: typeof row.resolved_at === 'string' ? row.resolved_at : null,
    resolvedBy: typeof row.resolved_by === 'string' ? row.resolved_by : null,
  }
}

function rowToPolicyDecision(row: DbRow): PolicyDecision {
  return {
    schemaVersion: Number(row.schema_version || COWORK_CREW_SCHEMA_VERSION),
    id: String(row.id || ''),
    runId: String(row.run_id || ''),
    runKind: String(row.run_kind || 'crew') as CoworkRunKind,
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    status: String(row.status || 'approval_required') as PolicyDecisionStatus,
    reason: String(row.reason || ''),
    capabilityId: typeof row.capability_id === 'string' ? row.capability_id : null,
    createdAt: String(row.created_at || ''),
  }
}

function rowToOutcomeRubric(row: DbRow): OutcomeRubric {
  return {
    schemaVersion: Number(row.schema_version || COWORK_EVAL_SCHEMA_VERSION),
    id: String(row.id || ''),
    name: String(row.name || ''),
    description: String(row.description || ''),
    criteria: parseJson<OutcomeRubric['criteria']>(row.criteria_json, []),
    passingScore: typeof row.passing_score === 'number' ? row.passing_score : 0,
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToEvalSuite(row: DbRow): EvalSuite {
  return {
    schemaVersion: Number(row.schema_version || COWORK_EVAL_SCHEMA_VERSION),
    id: String(row.id || ''),
    name: String(row.name || ''),
    description: String(row.description || ''),
    status: String(row.status || 'draft') as EvalSuite['status'],
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToEvalCase(row: DbRow): EvalCase {
  return {
    schemaVersion: Number(row.schema_version || COWORK_EVAL_SCHEMA_VERSION),
    id: String(row.id || ''),
    suiteId: String(row.suite_id || ''),
    name: String(row.name || ''),
    inputRef: String(row.input_ref || ''),
    expectedOutcome: String(row.expected_outcome || ''),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToOutcomeEvaluation(row: DbRow): OutcomeEvaluation {
  return {
    schemaVersion: Number(row.schema_version || COWORK_EVAL_SCHEMA_VERSION),
    id: String(row.id || ''),
    crewRunId: String(row.crew_run_id || ''),
    evaluatorAgentName: String(row.evaluator_agent_name || ''),
    rubricId: String(row.rubric_id || ''),
    status: String(row.status || 'needs_human') as OutcomeEvaluationStatus,
    score: typeof row.score === 'number' ? row.score : 0,
    evidenceTraceEventIds: parseJson<string[]>(row.evidence_trace_event_ids_json, []),
    recommendation: String(row.recommendation || 'escalate') as OutcomeEvaluation['recommendation'],
    createdAt: String(row.created_at || ''),
  }
}

function terminalCrewRunStatus(status: CrewRunStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function terminalCrewRunNodeStatus(status: CrewRunNodeStatus) {
  return status === 'completed' || status === 'failed' || status === 'skipped'
}

function assertCrewRunExists(db: DatabaseSync, crewRunId: string) {
  const run = db.prepare('select id from crew_runs where id = ?').get(crewRunId)
  if (!run) throw new Error(`Crew run ${crewRunId} does not exist.`)
}

function assertCrewRunNodeBelongsToRun(db: DatabaseSync, nodeId: string | null | undefined, crewRunId: string) {
  if (!nodeId) return
  const node = db.prepare('select crew_run_id from crew_run_nodes where id = ?').get(nodeId) as { crew_run_id?: string } | undefined
  if (!node || node.crew_run_id !== crewRunId) {
    throw new Error(`Crew run node ${nodeId} does not belong to crew run ${crewRunId}.`)
  }
}

function assertOutcomeRubricExists(db: DatabaseSync, rubricId: string) {
  const rubric = db.prepare('select id from outcome_rubrics where id = ?').get(rubricId)
  if (!rubric) throw new Error(`Outcome rubric ${rubricId} does not exist.`)
}

function assertEvalSuiteExists(db: DatabaseSync, suiteId: string) {
  const suite = db.prepare('select id from eval_suites where id = ?').get(suiteId)
  if (!suite) throw new Error(`Eval suite ${suiteId} does not exist.`)
}

export function createCrewDefinition(input: {
  name: string
  description: string
  status?: CrewLifecycleStatus
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare(`
      insert into crew_definitions (
        id, schema_version, name, description, status, active_version_id, created_at, updated_at
      ) values (?, ?, ?, ?, ?, null, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      requiredText(input.name, 'Crew name'),
      requiredText(input.description, 'Crew description'),
      input.status || 'draft',
      now,
      now,
    )
  })
  return getCrewDefinition(id)
}

export function getCrewDefinition(id: string) {
  const row = getCrewDb().prepare('select * from crew_definitions where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewDefinition(row) : null
}

export function listCrewDefinitions() {
  const rows = getCrewDb().prepare(`
    select *
    from crew_definitions
    order by updated_at desc, created_at desc, id asc
  `).all() as DbRow[]
  return rows.map(rowToCrewDefinition)
}

export function createCrewVersion(input: {
  crewId: string
  members: CrewMember[]
  workspaceProfileId?: string | null
  outcomeRubricId?: string | null
  budgetCapUsd?: number | null
  workflow?: CrewVersion['workflow']
  createdBy?: string | null
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    const crew = db.prepare('select id from crew_definitions where id = ?').get(input.crewId)
    if (!crew) throw new Error(`Crew ${input.crewId} does not exist.`)
    const latest = db.prepare('select max(version) as version from crew_versions where crew_id = ?')
      .get(input.crewId) as { version?: number | null } | undefined
    const version = Number(latest?.version || 0) + 1
    db.prepare(`
      insert into crew_versions (
        id, schema_version, crew_id, version, members_json, workspace_profile_id,
        outcome_rubric_id, budget_cap_usd, workflow_json, created_at, created_by
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.crewId,
      version,
      JSON.stringify(input.members),
      input.workspaceProfileId || null,
      input.outcomeRubricId || null,
      input.budgetCapUsd ?? null,
      JSON.stringify(input.workflow || ['plan', 'delegate', 'join', 'evaluate', 'deliver']),
      now,
      input.createdBy || null,
    )
    db.prepare('update crew_definitions set active_version_id = ?, updated_at = ? where id = ?')
      .run(id, now, input.crewId)
  })
  return getCrewVersion(id)
}

export function getCrewVersion(id: string) {
  const row = getCrewDb().prepare('select * from crew_versions where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewVersion(row) : null
}

export function listCrewVersions(crewId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_versions
    where crew_id = ?
    order by version asc
  `).all(crewId) as DbRow[]
  return rows.map(rowToCrewVersion)
}

export function createCrewRun(input: {
  crewId: string
  crewVersionId: string
  title: string
  workItemId?: string | null
  rootSessionId?: string | null
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    const version = db.prepare('select crew_id from crew_versions where id = ?').get(input.crewVersionId) as { crew_id?: string } | undefined
    if (!version || version.crew_id !== input.crewId) {
      throw new Error(`Crew version ${input.crewVersionId} does not belong to crew ${input.crewId}.`)
    }
    db.prepare(`
      insert into crew_runs (
        id, schema_version, crew_id, crew_version_id, work_item_id, status,
        title, summary, root_session_id, created_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, 'queued', ?, null, ?, ?, null, null)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.crewId,
      input.crewVersionId,
      input.workItemId || null,
      requiredText(input.title, 'Crew run title'),
      input.rootSessionId || null,
      now,
    )
  })
  return getCrewRun(id)
}

export function getCrewRun(id: string) {
  const row = getCrewDb().prepare('select * from crew_runs where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewRun(row) : null
}

export function listCrewRuns(crewId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_runs
    where crew_id = ?
    order by created_at desc, id asc
  `).all(crewId) as DbRow[]
  return rows.map(rowToCrewRun)
}

export function getCrewRunByRootSessionId(rootSessionId: string) {
  const row = getCrewDb().prepare(`
    select *
    from crew_runs
    where root_session_id = ?
    order by created_at desc, id asc
    limit 1
  `).get(rootSessionId) as DbRow | undefined
  return row ? rowToCrewRun(row) : null
}

export function updateCrewRunStatus(
  runId: string,
  status: CrewRunStatus,
  options: { summary?: string | null, rootSessionId?: string | null } = {},
) {
  const existing = getCrewRun(runId)
  if (!existing) return null
  const now = nowIso()
  const startedAt = existing.startedAt || (status !== 'queued' ? now : null)
  const finishedAt = terminalCrewRunStatus(status) ? (existing.finishedAt || now) : null
  withCrewTransaction((db) => {
    db.prepare(`
      update crew_runs
      set status = ?, summary = coalesce(?, summary), root_session_id = coalesce(?, root_session_id),
        started_at = ?, finished_at = ?
      where id = ?
    `).run(
      status,
      options.summary ?? null,
      options.rootSessionId ?? null,
      startedAt,
      finishedAt,
      runId,
    )
  })
  return getCrewRun(runId)
}

export function createCrewRunNode(input: {
  crewRunId: string
  kind: CrewRunNodeKind
  title: string
  status?: CrewRunNodeStatus
  agentName?: string | null
  sessionId?: string | null
  parentNodeId?: string | null
}) {
  const id = crypto.randomUUID()
  const status = input.status || 'queued'
  const now = nowIso()
  withCrewTransaction((db) => {
    const run = db.prepare('select id from crew_runs where id = ?').get(input.crewRunId)
    if (!run) throw new Error(`Crew run ${input.crewRunId} does not exist.`)
    const latest = db.prepare('select max(sequence) as sequence from crew_run_nodes where crew_run_id = ?')
      .get(input.crewRunId) as { sequence?: number | null } | undefined
    const sequence = Number(latest?.sequence || 0) + 1
    db.prepare(`
      insert into crew_run_nodes (
        id, schema_version, crew_run_id, sequence, kind, status, agent_name, session_id,
        parent_node_id, title, created_at, started_at, finished_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.crewRunId,
      sequence,
      input.kind,
      status,
      input.agentName || null,
      input.sessionId || null,
      input.parentNodeId || null,
      requiredText(input.title, 'Crew run node title'),
      now,
      status === 'running' ? now : null,
      terminalCrewRunNodeStatus(status) ? now : null,
    )
  })
  return getCrewRunNode(id)
}

export function getCrewRunNode(id: string) {
  const row = getCrewDb().prepare('select * from crew_run_nodes where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewRunNode(row) : null
}

export function listCrewRunNodes(crewRunId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_run_nodes
    where crew_run_id = ?
    order by sequence asc, id asc
  `).all(crewRunId) as DbRow[]
  return rows.map(rowToCrewRunNode)
}

export function updateCrewRunNodeStatus(
  nodeId: string,
  status: CrewRunNodeStatus,
  options: { sessionId?: string | null } = {},
) {
  const existing = getCrewRunNode(nodeId)
  if (!existing) return null
  const now = nowIso()
  const startedAt = existing.startedAt || (status !== 'queued' ? now : null)
  const finishedAt = terminalCrewRunNodeStatus(status) ? (existing.finishedAt || now) : null
  withCrewTransaction((db) => {
    db.prepare(`
      update crew_run_nodes
      set status = ?, session_id = coalesce(?, session_id), started_at = ?, finished_at = ?
      where id = ?
    `).run(status, options.sessionId ?? null, startedAt, finishedAt, nodeId)
  })
  return getCrewRunNode(nodeId)
}

export function updateCrewRunNodeRuntimeState(
  nodeId: string,
  patch: {
    status?: CrewRunNodeStatus
    title?: string | null
    agentName?: string | null
    sessionId?: string | null
  },
) {
  const existing = getCrewRunNode(nodeId)
  if (!existing) return null
  const nextStatus = patch.status || existing.status
  const now = nowIso()
  const startedAt = existing.startedAt || (nextStatus !== 'queued' ? now : null)
  const finishedAt = terminalCrewRunNodeStatus(nextStatus) ? (existing.finishedAt || now) : null
  const title = patch.title ? requiredText(patch.title, 'Crew run node title') : null
  const agentName = patch.agentName?.trim() || null
  withCrewTransaction((db) => {
    db.prepare(`
      update crew_run_nodes
      set status = ?,
        title = coalesce(?, title),
        agent_name = coalesce(?, agent_name),
        session_id = coalesce(?, session_id),
        started_at = ?,
        finished_at = ?
      where id = ?
    `).run(
      nextStatus,
      title,
      agentName,
      patch.sessionId ?? null,
      startedAt,
      finishedAt,
      nodeId,
    )
  })
  return getCrewRunNode(nodeId)
}

export function createCoworkWorkItem(input: {
  title: string
  description: string
  source?: CoworkWorkItem['source']
  status?: CoworkWorkItem['status']
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare(`
      insert into cowork_work_items (
        id, schema_version, title, description, source, status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      requiredText(input.title, 'Work item title'),
      requiredText(input.description, 'Work item description'),
      input.source || 'manual',
      input.status || 'queued',
      now,
      now,
    )
  })
  return getCoworkWorkItem(id)
}

export function getCoworkWorkItem(id: string) {
  const row = getCrewDb().prepare('select * from cowork_work_items where id = ?').get(id) as DbRow | undefined
  return row ? rowToCoworkWorkItem(row) : null
}

export function listCoworkWorkItems() {
  const rows = getCrewDb().prepare(`
    select *
    from cowork_work_items
    order by created_at desc, id asc
  `).all() as DbRow[]
  return rows.map(rowToCoworkWorkItem)
}

export function updateCoworkWorkItemStatus(id: string, status: CoworkWorkItem['status']) {
  const existing = getCoworkWorkItem(id)
  if (!existing) return null
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare('update cowork_work_items set status = ?, updated_at = ? where id = ?')
      .run(status, now, id)
  })
  return getCoworkWorkItem(id)
}

export function createCrewArtifact(input: {
  id?: string
  crewRunId: string
  nodeId?: string | null
  title: string
  mime: string
  uri: string
  hash?: string | null
}) {
  const id = input.id || crypto.randomUUID()
  const existing = getCrewArtifact(id)
  if (existing) {
    if (existing.crewRunId !== input.crewRunId) {
      throw new Error(`Crew artifact ${id} belongs to a different crew run.`)
    }
    return existing
  }
  const now = nowIso()
  withCrewTransaction((db) => {
    assertCrewRunExists(db, input.crewRunId)
    assertCrewRunNodeBelongsToRun(db, input.nodeId, input.crewRunId)
    db.prepare(`
      insert into crew_artifacts (
        id, schema_version, crew_run_id, node_id, title, mime, uri, hash, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.crewRunId,
      input.nodeId || null,
      requiredText(input.title, 'Artifact title'),
      requiredText(input.mime, 'Artifact MIME type'),
      requiredText(input.uri, 'Artifact URI'),
      input.hash || null,
      now,
    )
  })
  return getCrewArtifact(id)
}

export function getCrewArtifact(id: string) {
  const row = getCrewDb().prepare('select * from crew_artifacts where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewArtifact(row) : null
}

export function listCrewArtifactsForRun(crewRunId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_artifacts
    where crew_run_id = ?
    order by created_at asc, id asc
  `).all(crewRunId) as DbRow[]
  return rows.map(rowToCrewArtifact)
}

export function createCrewApproval(input: {
  id?: string
  crewRunId: string
  nodeId?: string | null
  title: string
  body: string
}) {
  const id = input.id || crypto.randomUUID()
  const existing = getCrewApproval(id)
  if (existing) {
    if (existing.crewRunId !== input.crewRunId) {
      throw new Error(`Crew approval ${id} belongs to a different crew run.`)
    }
    return existing
  }
  const now = nowIso()
  withCrewTransaction((db) => {
    assertCrewRunExists(db, input.crewRunId)
    assertCrewRunNodeBelongsToRun(db, input.nodeId, input.crewRunId)
    db.prepare(`
      insert into crew_approvals (
        id, schema_version, crew_run_id, node_id, status, title, body,
        requested_at, resolved_at, resolved_by
      ) values (?, ?, ?, ?, 'requested', ?, ?, ?, null, null)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.crewRunId,
      input.nodeId || null,
      requiredText(input.title, 'Approval title'),
      requiredText(input.body, 'Approval body'),
      now,
    )
  })
  return getCrewApproval(id)
}

export function getCrewApproval(id: string) {
  const row = getCrewDb().prepare('select * from crew_approvals where id = ?').get(id) as DbRow | undefined
  return row ? rowToCrewApproval(row) : null
}

export function listCrewApprovalsForRun(crewRunId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_approvals
    where crew_run_id = ?
    order by requested_at asc, id asc
  `).all(crewRunId) as DbRow[]
  return rows.map(rowToCrewApproval)
}

export function resolveCrewApproval(id: string, status: Exclude<CrewApprovalStatus, 'requested'>, resolvedBy: string) {
  const existing = getCrewApproval(id)
  if (!existing) return null
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare('update crew_approvals set status = ?, resolved_at = ?, resolved_by = ? where id = ?')
      .run(status, now, requiredText(resolvedBy, 'Approval resolver'), id)
  })
  return getCrewApproval(id)
}

export function recordPolicyDecision(input: {
  runId: string
  runKind: CoworkRunKind
  nodeId?: string | null
  status: PolicyDecisionStatus
  reason: string
  capabilityId?: string | null
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    if (input.runKind === 'crew') assertCrewRunExists(db, input.runId)
    if (input.runKind === 'crew') assertCrewRunNodeBelongsToRun(db, input.nodeId, input.runId)
    db.prepare(`
      insert into policy_decisions (
        id, schema_version, run_id, run_kind, node_id, status, reason, capability_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_CREW_SCHEMA_VERSION,
      input.runId,
      input.runKind,
      input.nodeId || null,
      input.status,
      requiredText(input.reason, 'Policy decision reason'),
      input.capabilityId || null,
      now,
    )
  })
  return getPolicyDecision(id)
}

export function getPolicyDecision(id: string) {
  const row = getCrewDb().prepare('select * from policy_decisions where id = ?').get(id) as DbRow | undefined
  return row ? rowToPolicyDecision(row) : null
}

export function listPolicyDecisionsForRun(runKind: CoworkRunKind, runId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from policy_decisions
    where run_kind = ? and run_id = ?
    order by created_at asc, id asc
  `).all(runKind, runId) as DbRow[]
  return rows.map(rowToPolicyDecision)
}

export function createOutcomeRubric(input: {
  name: string
  description: string
  criteria: OutcomeRubric['criteria']
  passingScore: number
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare(`
      insert into outcome_rubrics (
        id, schema_version, name, description, criteria_json, passing_score, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_EVAL_SCHEMA_VERSION,
      requiredText(input.name, 'Outcome rubric name'),
      requiredText(input.description, 'Outcome rubric description'),
      JSON.stringify(input.criteria),
      input.passingScore,
      now,
      now,
    )
  })
  return getOutcomeRubric(id)
}

export function getOutcomeRubric(id: string) {
  const row = getCrewDb().prepare('select * from outcome_rubrics where id = ?').get(id) as DbRow | undefined
  return row ? rowToOutcomeRubric(row) : null
}

export function listOutcomeRubrics() {
  const rows = getCrewDb().prepare(`
    select *
    from outcome_rubrics
    order by updated_at desc, created_at desc, id asc
  `).all() as DbRow[]
  return rows.map(rowToOutcomeRubric)
}

export function createEvalSuite(input: {
  name: string
  description: string
  status?: EvalSuite['status']
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    db.prepare(`
      insert into eval_suites (
        id, schema_version, name, description, status, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_EVAL_SCHEMA_VERSION,
      requiredText(input.name, 'Eval suite name'),
      requiredText(input.description, 'Eval suite description'),
      input.status || 'draft',
      now,
      now,
    )
  })
  return getEvalSuite(id)
}

export function getEvalSuite(id: string) {
  const row = getCrewDb().prepare('select * from eval_suites where id = ?').get(id) as DbRow | undefined
  return row ? rowToEvalSuite(row) : null
}

export function createEvalCase(input: {
  suiteId: string
  name: string
  inputRef: string
  expectedOutcome: string
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    assertEvalSuiteExists(db, input.suiteId)
    db.prepare(`
      insert into eval_cases (
        id, schema_version, suite_id, name, input_ref, expected_outcome, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_EVAL_SCHEMA_VERSION,
      input.suiteId,
      requiredText(input.name, 'Eval case name'),
      requiredText(input.inputRef, 'Eval case input reference'),
      requiredText(input.expectedOutcome, 'Eval case expected outcome'),
      now,
      now,
    )
  })
  return getEvalCase(id)
}

export function getEvalCase(id: string) {
  const row = getCrewDb().prepare('select * from eval_cases where id = ?').get(id) as DbRow | undefined
  return row ? rowToEvalCase(row) : null
}

export function listEvalCasesForSuite(suiteId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from eval_cases
    where suite_id = ?
    order by created_at asc, id asc
  `).all(suiteId) as DbRow[]
  return rows.map(rowToEvalCase)
}

export function recordOutcomeEvaluation(input: {
  crewRunId: string
  evaluatorAgentName: string
  rubricId: string
  status: OutcomeEvaluationStatus
  score: number
  evidenceTraceEventIds: string[]
  recommendation: OutcomeEvaluation['recommendation']
}) {
  const id = crypto.randomUUID()
  const now = nowIso()
  withCrewTransaction((db) => {
    assertCrewRunExists(db, input.crewRunId)
    assertOutcomeRubricExists(db, input.rubricId)
    db.prepare(`
      insert into outcome_evaluations (
        id, schema_version, crew_run_id, evaluator_agent_name, rubric_id,
        status, score, evidence_trace_event_ids_json, recommendation, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      COWORK_EVAL_SCHEMA_VERSION,
      input.crewRunId,
      requiredText(input.evaluatorAgentName, 'Evaluator agent name'),
      input.rubricId,
      input.status,
      input.score,
      JSON.stringify(input.evidenceTraceEventIds),
      input.recommendation,
      now,
    )
  })
  return getOutcomeEvaluation(id)
}

export function getOutcomeEvaluation(id: string) {
  const row = getCrewDb().prepare('select * from outcome_evaluations where id = ?').get(id) as DbRow | undefined
  return row ? rowToOutcomeEvaluation(row) : null
}

export function listOutcomeEvaluationsForRun(crewRunId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from outcome_evaluations
    where crew_run_id = ?
    order by created_at asc, id asc
  `).all(crewRunId) as DbRow[]
  return rows.map(rowToOutcomeEvaluation)
}

function rowToTraceEvent(row: DbRow): CoworkTraceEvent {
  return createCoworkTraceEvent({
    id: String(row.id || ''),
    sequence: Number(row.sequence || 0),
    runId: String(row.run_id || ''),
    runKind: String(row.run_kind || 'crew') as CoworkRunKind,
    source: String(row.source || 'cowork_worker') as TraceEventSource,
    sourceEventId: typeof row.source_event_id === 'string' ? row.source_event_id : null,
    correlationId: typeof row.correlation_id === 'string' ? row.correlation_id : null,
    causationId: typeof row.causation_id === 'string' ? row.causation_id : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    parentSessionId: typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
    actor: {
      kind: String(row.actor_kind || 'system') as TraceActorKind,
      id: String(row.actor_id || 'system'),
    },
    nodeId: typeof row.node_id === 'string' ? row.node_id : null,
    artifactId: typeof row.artifact_id === 'string' ? row.artifact_id : null,
    approvalId: typeof row.approval_id === 'string' ? row.approval_id : null,
    policyDecisionId: typeof row.policy_decision_id === 'string' ? row.policy_decision_id : null,
    inputHash: typeof row.input_hash === 'string' ? row.input_hash : null,
    outputHash: typeof row.output_hash === 'string' ? row.output_hash : null,
    payloadRef: typeof row.payload_ref === 'string' ? row.payload_ref : null,
    payloadHash: typeof row.payload_hash === 'string' ? row.payload_hash : null,
    redactionState: String(row.redaction_state || 'none') as TraceRedactionState,
    tokenUsage: parseJson<TraceTokenUsage | null>(row.token_usage_json, null),
    costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : null,
    payload: parseJson<Record<string, unknown> | null>(row.payload_json, null),
    createdAt: String(row.created_at || ''),
  })
}

export function appendCoworkTraceEvent(event: CoworkTraceEvent) {
  if (event.schemaVersion !== COWORK_TRACE_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported trace event schema version ${event.schemaVersion}.`)
  }

  withCrewTransaction((db) => {
    db.prepare(`
      insert into crew_trace_events (
        id, schema_version, sequence, run_id, run_kind, source, source_event_id,
        correlation_id, causation_id, session_id, parent_session_id,
        actor_kind, actor_id, node_id, artifact_id, approval_id,
        policy_decision_id, input_hash, output_hash, payload_ref, payload_hash,
        redaction_state, token_usage_json, cost_usd, payload_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.schemaVersion,
      event.sequence,
      event.runId,
      event.runKind,
      event.source,
      event.sourceEventId,
      event.correlationId,
      event.causationId,
      event.sessionId,
      event.parentSessionId,
      event.actor.kind,
      event.actor.id,
      event.nodeId,
      event.artifactId,
      event.approvalId,
      event.policyDecisionId,
      event.inputHash,
      event.outputHash,
      event.payloadRef,
      event.payloadHash,
      event.redactionState,
      event.tokenUsage ? JSON.stringify(event.tokenUsage) : null,
      event.costUsd,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt,
    )
  })
  return event
}

export function appendCoworkTraceEventIfNew(event: CoworkTraceEvent) {
  if (event.schemaVersion !== COWORK_TRACE_EVENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported trace event schema version ${event.schemaVersion}.`)
  }

  withCrewTransaction((db) => {
    db.prepare(`
      insert or ignore into crew_trace_events (
        id, schema_version, sequence, run_id, run_kind, source, source_event_id,
        correlation_id, causation_id, session_id, parent_session_id,
        actor_kind, actor_id, node_id, artifact_id, approval_id,
        policy_decision_id, input_hash, output_hash, payload_ref, payload_hash,
        redaction_state, token_usage_json, cost_usd, payload_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.schemaVersion,
      event.sequence,
      event.runId,
      event.runKind,
      event.source,
      event.sourceEventId,
      event.correlationId,
      event.causationId,
      event.sessionId,
      event.parentSessionId,
      event.actor.kind,
      event.actor.id,
      event.nodeId,
      event.artifactId,
      event.approvalId,
      event.policyDecisionId,
      event.inputHash,
      event.outputHash,
      event.payloadRef,
      event.payloadHash,
      event.redactionState,
      event.tokenUsage ? JSON.stringify(event.tokenUsage) : null,
      event.costUsd,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt,
    )
  })
  return event
}

export function nextCoworkTraceSequence(runId: string) {
  const row = getCrewDb().prepare('select max(sequence) as sequence from crew_trace_events where run_id = ?')
    .get(runId) as { sequence?: number | null } | undefined
  return Number(row?.sequence || 0) + 1
}

export function listCoworkTraceEventsForRun(runId: string) {
  const rows = getCrewDb().prepare(`
    select *
    from crew_trace_events
    where run_id = ?
    order by sequence asc, created_at asc, id asc
  `).all(runId) as DbRow[]
  return rows.map(rowToTraceEvent)
}

export function exportCoworkTraceEventsForRun(runId: string) {
  return sortCoworkTraceEvents(listCoworkTraceEventsForRun(runId))
    .map(serializeCoworkTraceEvent)
    .join('\n')
}
