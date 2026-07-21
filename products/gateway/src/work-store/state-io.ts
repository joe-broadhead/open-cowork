/**
 * Work-state materialization, mutate/sync, and row upsert core (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts (keeps dependency graph acyclic).
 */
import type { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'
import {
  getRow,
  markWorkDbActive,
  openWorkDb,
  queryRows,
  unmarkWorkDbActive,
  withWorkDb,
  withWorkDbReadOnly,
  workStatePath,
} from './db.js'
import { assertNoStorageOperationInProgress } from './storage-lock.js'
import {
  isDependencyRecord,
  isProjectBindingRecord,
  isRoadmapCompletionProposalRecord,
  isRoadmapRecord,
  isRoadmapSupervisorRecord,
  isRunRecord,
  isTaskRecord,
  normalizeProjectBindingRecord,
  normalizeRoadmapQualitySpec,
  rowToDependency,
  rowToProjectBinding,
  rowToRoadmap,
  rowToRoadmapCompletionProposal,
  rowToRoadmapSupervisor,
  rowToRun,
  rowToTask,
} from './row-mappers.js'
import { normalizeThreadId } from './validators.js'
import { reconcileDefaultSupervisorInState } from './supervisor-helpers.js'
import type {
  ProjectBindingRecord,
  RoadmapCompletionProposalRecord,
  RoadmapRecord,
  RoadmapSupervisorRecord,
  RunRecord,
  WorkDependencyRecord,
  WorkState,
  WorkTaskRecord,
} from './types.js'

export function emptyWorkState(): WorkState {
  return emptyState()
}

/**
 * Options for the public work-state reads.
 * - `all` (default) materializes every run — the durable, complete history that
 *   full-history consumers (backups, evidence export, all-time totals, session
 *   lookups over arbitrarily old runs) still depend on.
 * - `live` materializes only the bounded window the mutation/scheduler hot path
 *   can touch (running runs, `currentRunId` runs, a recent terminal slice), so
 *   materialization latency is flat regardless of cumulative run history.
 *
 * The default stays `all` on purpose: a broad set of consumers reads full
 * `state.runs` for correctness, so callers opt into the bounded window
 * explicitly rather than the default silently truncating history.
 */
export interface LoadWorkStateOptions {
  runsScope?: 'all' | 'live'
}

const WORK_STATE_MATERIALIZATION = Symbol('opencode-gateway.workStateMaterialization')

export function loadWorkState(filePath = workStatePath(), options: LoadWorkStateOptions = {}): WorkState {
  return withWorkDb(filePath, db => readWorkState(db, { runsScope: options.runsScope || 'all' }))
}

export function loadWorkStateReadOnly(filePath = workStatePath(), options: LoadWorkStateOptions = {}): WorkState {
  return withWorkDbReadOnly(filePath, db => readWorkState(db, { runsScope: options.runsScope || 'all' }))
}

export function saveWorkState(state: WorkState, filePath = workStatePath()): void {
  assertFullWorkStateForReplace(state)
  assertNoStorageOperationInProgress(filePath)
  return withWorkDb(filePath, db => {
    writeWorkState(db, state)
  })
}

function assertFullWorkStateForReplace(state: WorkState): void {
  const materialization = (state as any)[WORK_STATE_MATERIALIZATION] as { runsScope?: 'all' | 'live' } | undefined
  if (materialization?.runsScope && materialization.runsScope !== 'all') {
    throw new Error('saveWorkState refuses to replace durable state from a partial live-window WorkState; reload with runsScope=all before saving')
  }
}

export function getRunFromDb(db: DatabaseSync, id: string): RunRecord | undefined {
  const row = getRow(db, 'SELECT * FROM runs WHERE id = ? OR session_id = ? ORDER BY started_at ASC LIMIT 1', id, id)
  if (!row) return undefined
  return rowToRun(row) ?? undefined
}

export function mutateWorkState<T>(filePath: string, fn: (state: WorkState, db: DatabaseSync) => T): T {
  assertNoStorageOperationInProgress(filePath)
  const db = openWorkDb(filePath)
  const dbPath = path.resolve(filePath)
  // Pin this handle for the whole transaction so a nested cross-path open under
  // the cache cap can't evict/close it out from under the BEGIN IMMEDIATE.
  markWorkDbActive(dbPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const state = readWorkState(db, { runsScope: 'live' })
      // Capture per-row fingerprints of the pre-mutation state instead of
      // deep-cloning and re-serializing the whole state twice: readWorkState
      // output is already normalized, so serializing each row once here yields
      // exactly the strings the post-mutation diff compares against. Unchanged
      // rows are never rewritten (guarded by the DELETE-trigger test).
      const before = captureWorkStateFingerprints(state)
      const result = fn(state, db)
      syncWorkStateRows(db, before, state)
      db.exec('COMMIT')
      return result
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    unmarkWorkDbActive(dbPath)
    db.close()
  }
}


/**
 * Bounded count of recent terminal runs materialized into the live (mutation)
 * WorkState window. The read/mutate hot paths only ever operate on active runs
 * and `currentRunId` runs; this recent slice is a correctness safety margin.
 * All older terminal runs stay durable in SQLite and remain fully queryable via
 * `loadWorkState` (full scope) and the targeted `getRunsForTask` /
 * `getRunCostTokenTotals` reads. Bounded + index-served (idx_runs_started_at)
 * so live materialization stays flat regardless of cumulative run history.
 */
const LIVE_RECENT_TERMINAL_RUNS = 500

/**
 * Read scope for {@link readWorkState}.
 * - `all` materializes every run (durable, complete history) and backs the
 *   public `loadWorkState` reads that historical/all-time consumers depend on.
 * - `live` windows the runs table down to only what the scheduler /
 *   state-machine / completion logic can touch during a mutation, making
 *   materialization latency flat regardless of cumulative run history.
 */
type ReadWorkStateOptions = { runsScope?: 'all' | 'live' }

export function readWorkState(db: DatabaseSync, options: ReadWorkStateOptions = {}): WorkState {
  const savedAt = String(getRow(db, "SELECT value FROM meta WHERE key = 'savedAt'")?.['value'] || new Date().toISOString())
  const roadmaps = queryRows(db, 'SELECT * FROM roadmaps ORDER BY created_at ASC').map(rowToRoadmap).filter(Boolean) as RoadmapRecord[]
  const supervisors = queryRows(db, 'SELECT * FROM roadmap_supervisors ORDER BY roadmap_id ASC, created_at ASC').map(rowToRoadmapSupervisor).filter(Boolean) as RoadmapSupervisorRecord[]
  const projectBindings = queryRows(db, 'SELECT * FROM project_bindings ORDER BY alias ASC, created_at ASC').map(rowToProjectBinding).filter(Boolean) as ProjectBindingRecord[]
  const completionProposals = queryRows(db, 'SELECT * FROM roadmap_completion_proposals ORDER BY created_at DESC').map(rowToRoadmapCompletionProposal).filter(Boolean) as RoadmapCompletionProposalRecord[]
  const tasks = queryRows(db, 'SELECT * FROM tasks ORDER BY created_at ASC').map(rowToTask).filter(Boolean) as WorkTaskRecord[]
  const runs = readWorkStateRuns(db, options.runsScope || 'all')
  const dependencies = queryRows(db, 'SELECT * FROM work_dependencies ORDER BY created_at ASC').map(rowToDependency).filter(Boolean) as WorkDependencyRecord[]
  return tagWorkStateMaterialization(
    normalizeState({ version: 1, savedAt, roadmaps, supervisors, projectBindings, completionProposals, tasks, runs, dependencies }),
    options.runsScope || 'all',
  )
}

function tagWorkStateMaterialization(state: WorkState, runsScope: 'all' | 'live'): WorkState {
  Object.defineProperty(state, WORK_STATE_MATERIALIZATION, {
    value: { runsScope },
    enumerable: false,
    configurable: false,
  })
  return state
}

function readWorkStateRuns(db: DatabaseSync, scope: 'all' | 'live'): RunRecord[] {
  if (scope !== 'live') {
    return queryRows(db, 'SELECT * FROM runs ORDER BY started_at ASC').map(rowToRun).filter(Boolean) as RunRecord[]
  }
  // Live window: every run the mutation hot path can legitimately touch.
  //  (a) all non-terminal (running) runs — active dispatch/lease/completion,
  //  (b) every run referenced by a task's currentRunId — retry/complete/abort,
  //  (c) a bounded recency slice of terminal runs — safety margin only.
  // Every clause is index-served (idx_runs_status, PK, idx_runs_started_at) so
  // SQLite unions three small index probes instead of scanning the table, and
  // only the bounded result set is JSON-materialized in JS — flat regardless of
  // how many terminal runs have accumulated.
  const rows = queryRows(
    db,
    `SELECT * FROM runs
       WHERE status = 'running'
          OR id IN (SELECT current_run_id FROM tasks WHERE current_run_id IS NOT NULL)
          OR id IN (SELECT id FROM runs WHERE status != 'running' ORDER BY started_at DESC LIMIT ?)
       ORDER BY started_at ASC`,
    LIVE_RECENT_TERMINAL_RUNS,
  )
  return rows.map(rowToRun).filter(Boolean) as RunRecord[]
}

/**
 * Look up a run for a mutation whose target may be an older terminal run that
 * the live window did not materialize (e.g. environment cleanup of a retained
 * run months after it finished). Returns undefined when no run matches.
 */
export function findRunRowForEnvironmentOrId(db: DatabaseSync, id: string): RunRecord | undefined {
  // Fast path: the target may itself be a run id.
  const byId = getRow(db, 'SELECT * FROM runs WHERE id = ? LIMIT 1', id)
  if (byId) {
    const run = rowToRun(byId) ?? undefined
    if (run?.id === id) return run
  }
  // Otherwise the target is an environment id. The LIKE over environment_json is
  // only a cheap prefilter, so it must be paired with an exact re-verification:
  // a substring collision (a nested metadata value, an artifact path, or another
  // env ref that happens to contain the id) would otherwise hydrate the WRONG
  // run and apply retain/release/cleanup/abort to it. Escape LIKE metacharacters
  // (\ % _) so they match literally, and only accept a run whose
  // environment.id === id exactly (mirroring the in-window `environment?.id === id`).
  const like = `%"id":"${id.replace(/[\\%_]/g, match => `\\${match}`)}"%`
  const rows = queryRows(
    db,
    `SELECT * FROM runs
       WHERE environment_json LIKE ? ESCAPE '\\'
       ORDER BY started_at DESC`,
    like,
  )
  for (const row of rows) {
    const run = rowToRun(row) ?? undefined
    if (run?.environment?.id === id) return run
  }
  return undefined
}

export function writeWorkState(db: DatabaseSync, state: WorkState): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    writeWorkStateRows(db, state)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

function writeWorkStateRows(db: DatabaseSync, state: WorkState): void {
  const normalized = normalizeState(state)
  normalized.savedAt = new Date().toISOString()
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('savedAt', normalized.savedAt)
  db.exec('DELETE FROM runs; DELETE FROM work_dependencies; DELETE FROM tasks; DELETE FROM roadmap_completion_proposals; DELETE FROM project_bindings; DELETE FROM roadmap_supervisors; DELETE FROM roadmaps;')
  const insertRoadmap = db.prepare('INSERT INTO roadmaps (id, title, status, priority, source, agent_team, environment_json, quality_spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const roadmap of normalized.roadmaps) {
    insertRoadmap.run(roadmap.id, roadmap.title, roadmap.status, roadmap.priority, 'manual', roadmap.agentTeam || null, roadmap.environment ? JSON.stringify(roadmap.environment) : null, roadmap.qualitySpec ? JSON.stringify(roadmap.qualitySpec) : null, roadmap.createdAt, roadmap.updatedAt)
  }
  const insertSupervisor = db.prepare(`INSERT INTO roadmap_supervisors (
    supervisor_id, roadmap_id, session_id, profile, status, is_default, cadence_json, event_triggers_json,
    last_reviewed_event_id, last_review_at, next_review_at, completion_policy_json, notification_policy_ref, note,
    wake_lease_owner, wake_lease_expires_at, last_wake_at, last_wake_reason, last_wake_event_id,
    last_result_hash, last_result_at, last_result_status, last_result_summary, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const supervisor of normalized.supervisors) {
    insertSupervisor.run(
      supervisor.supervisorId,
      supervisor.roadmapId,
      supervisor.sessionId,
      supervisor.profile,
      supervisor.status,
      supervisor.isDefault ? 1 : 0,
      JSON.stringify(supervisor.cadence || {}),
      JSON.stringify(supervisor.eventTriggers || {}),
      supervisor.lastReviewedEventId ?? null,
      supervisor.lastReviewAt || null,
      supervisor.nextReviewAt || null,
      JSON.stringify(supervisor.completionPolicy || {}),
      supervisor.notificationPolicyRef || null,
      supervisor.note || null,
      supervisor.wakeLeaseOwner || null,
      supervisor.wakeLeaseExpiresAt || null,
      supervisor.lastWakeAt || null,
      supervisor.lastWakeReason || null,
      supervisor.lastWakeEventId ?? null,
      supervisor.lastResultHash || null,
      supervisor.lastResultAt || null,
      supervisor.lastResultStatus || null,
      supervisor.lastResultSummary || null,
      supervisor.createdAt,
      supervisor.updatedAt,
    )
  }
  const insertProjectBinding = db.prepare(`INSERT INTO project_bindings (
    id, alias, roadmap_id, session_id, scope, provider, chat_id, thread_id, title,
    notification_mode, muted_until, quiet_hours_json, last_digest_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const binding of normalized.projectBindings) {
    insertProjectBinding.run(binding.id, binding.alias, binding.roadmapId, binding.sessionId, binding.scope, binding.provider || null, binding.chatId || null, normalizeThreadId(binding.threadId), binding.title || null, binding.notificationMode || 'immediate', binding.mutedUntil || null, JSON.stringify(binding.quietHours || {}), binding.lastDigestAt || null, binding.createdAt, binding.updatedAt)
  }
  const insertCompletionProposal = db.prepare(`INSERT INTO roadmap_completion_proposals (
    id, roadmap_id, proposed_by, session_id, evidence_json, unresolved_risks_json, recommendation, status, decision_by, decision_note, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const proposal of normalized.completionProposals) {
    insertCompletionProposal.run(proposal.id, proposal.roadmapId, proposal.proposedBy || null, proposal.sessionId || null, JSON.stringify(proposal.evidence), JSON.stringify(proposal.unresolvedRisks), proposal.recommendation, proposal.status, proposal.decisionBy || null, proposal.decisionNote || null, proposal.expiresAt || null, proposal.createdAt, proposal.updatedAt)
  }
  const insertTask = db.prepare(`INSERT INTO tasks (
    id, roadmap_id, title, description, status, priority, agent, agent_team, stage_profiles_json, environment_json, pipeline_json, current_stage, current_run_id,
    attempts_json, note, earliest_start_at, deadline_at, recurrence, manual_gate, sla_class, quality_spec_json, source_type, source_key, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const task of normalized.tasks) {
    insertTask.run(
      task.id,
      task.roadmapId,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.agent,
      task.agentTeam || null,
      task.stageProfiles ? JSON.stringify(task.stageProfiles) : null,
      task.environment ? JSON.stringify(task.environment) : null,
      JSON.stringify(task.pipeline),
      task.currentStage || null,
      task.currentRunId || null,
      JSON.stringify(task.attempts || {}),
      task.note || null,
      task.earliestStartAt || null,
      task.deadlineAt || null,
      task.recurrence || null,
      task.manualGate || null,
      task.slaClass || null,
      task.qualitySpec ? JSON.stringify(task.qualitySpec) : null,
      task.sourceType || 'manual',
      task.sourceKey || `manual:${task.id}`,
      task.createdAt,
      task.updatedAt,
    )
  }
  db.exec('DELETE FROM task_run_counters WHERE task_id NOT IN (SELECT id FROM tasks)')
  const insertRun = db.prepare(`INSERT INTO runs (
    id, task_id, stage, session_id, profile, agent_team, agent_team_version, resolved_profile, resolved_agent, environment_json, runtime_profile_json, status, attempt, started_at, completed_at, lease_owner, lease_expires_at, scheduler_generation,
    cost_usd, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const run of normalized.runs) {
    insertRun.run(
      run.id,
      run.taskId,
      run.stage,
      run.sessionId,
      run.profile,
      run.agentTeam || null,
      run.agentTeamVersion || null,
      run.resolvedProfile || null,
      run.resolvedAgent || null,
      run.environment ? JSON.stringify(run.environment) : null,
      run.runtimeProfile ? JSON.stringify(run.runtimeProfile) : null,
      run.status,
      run.attempt,
      run.startedAt,
      run.completedAt || null,
      run.leaseOwner || null,
      run.leaseExpiresAt || null,
      run.schedulerGeneration || null,
      run.costUsd ?? null,
      run.inputTokens ?? null,
      run.outputTokens ?? null,
      run.reasoningTokens ?? null,
      run.cacheReadTokens ?? null,
      run.cacheWriteTokens ?? null,
      run.runtimeMs ?? null,
      run.result ? JSON.stringify(run.result) : null,
    )
  }
  const insertDependency = db.prepare(`INSERT INTO work_dependencies (task_id, depends_on_task_id, type, created_at) VALUES (?, ?, ?, ?)`)
  for (const dependency of normalized.dependencies || []) {
    insertDependency.run(dependency.taskId, dependency.dependsOnTaskId, dependency.type, dependency.createdAt)
  }
}

interface WorkStateRowFingerprints {
  runs: Map<string, string>
  dependencies: Map<string, string>
  tasks: Map<string, string>
  completionProposals: Map<string, string>
  projectBindings: Map<string, string>
  supervisors: Map<string, string>
  roadmaps: Map<string, string>
}

function captureWorkStateFingerprints(state: WorkState): WorkStateRowFingerprints {
  return {
    runs: fingerprintRowsByKey(state.runs, run => run.id),
    dependencies: fingerprintRowsByKey(state.dependencies || [], dependencyKey),
    tasks: fingerprintRowsByKey(state.tasks, task => task.id),
    completionProposals: fingerprintRowsByKey(state.completionProposals, proposal => proposal.id),
    projectBindings: fingerprintRowsByKey(state.projectBindings, binding => binding.id),
    supervisors: fingerprintRowsByKey(state.supervisors, supervisor => supervisor.supervisorId),
    roadmaps: fingerprintRowsByKey(state.roadmaps, roadmap => roadmap.id),
  }
}

function fingerprintRowsByKey<T>(rows: T[], keyFor: (row: T) => string): Map<string, string> {
  return new Map(rows.map(row => [keyFor(row), stableRowFingerprint(row)]))
}

function syncWorkStateRows(db: DatabaseSync, before: WorkStateRowFingerprints, nextState: WorkState): void {
  const next = normalizeState(nextState)
  next.savedAt = new Date().toISOString()
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('savedAt', next.savedAt)

  syncRows(
    before.runs,
    next.runs,
    run => run.id,
    id => db.prepare('DELETE FROM runs WHERE id = ?').run(id),
    run => upsertRunRow(db, run),
  )
  syncRows(
    before.dependencies,
    next.dependencies || [],
    dependencyKey,
    key => {
      const [taskId, dependsOnTaskId, type] = key.split('\u0000')
      db.prepare('DELETE FROM work_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND type = ?').run(taskId, dependsOnTaskId, type)
    },
    dependency => upsertDependencyRow(db, dependency),
  )
  syncRows(
    before.tasks,
    next.tasks,
    task => task.id,
    id => db.prepare('DELETE FROM tasks WHERE id = ?').run(id),
    task => upsertTaskRow(db, task),
  )
  syncRows(
    before.completionProposals,
    next.completionProposals,
    proposal => proposal.id,
    id => db.prepare('DELETE FROM roadmap_completion_proposals WHERE id = ?').run(id),
    proposal => upsertCompletionProposalRow(db, proposal),
  )
  syncRows(
    before.projectBindings,
    next.projectBindings,
    binding => binding.id,
    id => db.prepare('DELETE FROM project_bindings WHERE id = ?').run(id),
    binding => upsertProjectBindingStateRow(db, binding),
  )
  syncRows(
    before.supervisors,
    next.supervisors,
    supervisor => supervisor.supervisorId,
    id => db.prepare('DELETE FROM roadmap_supervisors WHERE supervisor_id = ?').run(id),
    supervisor => upsertRoadmapSupervisorStateRow(db, supervisor),
  )
  syncRows(
    before.roadmaps,
    next.roadmaps,
    roadmap => roadmap.id,
    id => db.prepare('DELETE FROM roadmaps WHERE id = ?').run(id),
    roadmap => upsertRoadmapStateRow(db, roadmap),
  )
}

function syncRows<T>(beforeFingerprints: Map<string, string>, nextRows: T[], keyFor: (row: T) => string, deleteRow: (key: string) => void, upsertRow: (row: T) => void): void {
  const nextKeys = new Set(nextRows.map(row => keyFor(row)))
  for (const key of beforeFingerprints.keys()) {
    if (!nextKeys.has(key)) deleteRow(key)
  }
  for (const row of nextRows) {
    const key = keyFor(row)
    if (beforeFingerprints.get(key) !== stableRowFingerprint(row)) upsertRow(row)
  }
}

function stableRowFingerprint(row: unknown): string {
  return JSON.stringify(row)
}

function dependencyKey(dependency: WorkDependencyRecord): string {
  return [dependency.taskId, dependency.dependsOnTaskId, dependency.type].join('\u0000')
}

function upsertRoadmapStateRow(db: DatabaseSync, roadmap: RoadmapRecord): void {
  db.prepare(`INSERT INTO roadmaps (
    id, title, status, priority, source, agent_team, environment_json, quality_spec_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    status = excluded.status,
    priority = excluded.priority,
    source = excluded.source,
    agent_team = excluded.agent_team,
    environment_json = excluded.environment_json,
    quality_spec_json = excluded.quality_spec_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    roadmap.id,
    roadmap.title,
    roadmap.status,
    roadmap.priority,
    'manual',
    roadmap.agentTeam || null,
    roadmap.environment ? JSON.stringify(roadmap.environment) : null,
    roadmap.qualitySpec ? JSON.stringify(roadmap.qualitySpec) : null,
    roadmap.createdAt,
    roadmap.updatedAt,
  )
}

function upsertRoadmapSupervisorStateRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord): void {
  db.prepare(`INSERT INTO roadmap_supervisors (
    supervisor_id, roadmap_id, session_id, profile, status, is_default, cadence_json, event_triggers_json,
    last_reviewed_event_id, last_review_at, next_review_at, completion_policy_json, notification_policy_ref, note,
    wake_lease_owner, wake_lease_expires_at, last_wake_at, last_wake_reason, last_wake_event_id,
    last_result_hash, last_result_at, last_result_status, last_result_summary, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(supervisor_id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    session_id = excluded.session_id,
    profile = excluded.profile,
    status = excluded.status,
    is_default = excluded.is_default,
    cadence_json = excluded.cadence_json,
    event_triggers_json = excluded.event_triggers_json,
    last_reviewed_event_id = excluded.last_reviewed_event_id,
    last_review_at = excluded.last_review_at,
    next_review_at = excluded.next_review_at,
    completion_policy_json = excluded.completion_policy_json,
    notification_policy_ref = excluded.notification_policy_ref,
    note = excluded.note,
    wake_lease_owner = excluded.wake_lease_owner,
    wake_lease_expires_at = excluded.wake_lease_expires_at,
    last_wake_at = excluded.last_wake_at,
    last_wake_reason = excluded.last_wake_reason,
    last_wake_event_id = excluded.last_wake_event_id,
    last_result_hash = excluded.last_result_hash,
    last_result_at = excluded.last_result_at,
    last_result_status = excluded.last_result_status,
    last_result_summary = excluded.last_result_summary,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    supervisor.supervisorId,
    supervisor.roadmapId,
    supervisor.sessionId,
    supervisor.profile,
    supervisor.status,
    supervisor.isDefault ? 1 : 0,
    JSON.stringify(supervisor.cadence || {}),
    JSON.stringify(supervisor.eventTriggers || {}),
    supervisor.lastReviewedEventId ?? null,
    supervisor.lastReviewAt || null,
    supervisor.nextReviewAt || null,
    JSON.stringify(supervisor.completionPolicy || {}),
    supervisor.notificationPolicyRef || null,
    supervisor.note || null,
    supervisor.wakeLeaseOwner || null,
    supervisor.wakeLeaseExpiresAt || null,
    supervisor.lastWakeAt || null,
    supervisor.lastWakeReason || null,
    supervisor.lastWakeEventId ?? null,
    supervisor.lastResultHash || null,
    supervisor.lastResultAt || null,
    supervisor.lastResultStatus || null,
    supervisor.lastResultSummary || null,
    supervisor.createdAt,
    supervisor.updatedAt,
  )
}

function upsertProjectBindingStateRow(db: DatabaseSync, binding: ProjectBindingRecord): void {
  db.prepare(`INSERT INTO project_bindings (
    id, alias, roadmap_id, session_id, scope, provider, chat_id, thread_id, title,
    notification_mode, muted_until, quiet_hours_json, last_digest_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    alias = excluded.alias,
    roadmap_id = excluded.roadmap_id,
    session_id = excluded.session_id,
    scope = excluded.scope,
    provider = excluded.provider,
    chat_id = excluded.chat_id,
    thread_id = excluded.thread_id,
    title = excluded.title,
    notification_mode = excluded.notification_mode,
    muted_until = excluded.muted_until,
    quiet_hours_json = excluded.quiet_hours_json,
    last_digest_at = excluded.last_digest_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    binding.id,
    binding.alias,
    binding.roadmapId,
    binding.sessionId,
    binding.scope,
    binding.provider || null,
    binding.chatId || null,
    normalizeThreadId(binding.threadId),
    binding.title || null,
    binding.notificationMode || 'immediate',
    binding.mutedUntil || null,
    JSON.stringify(binding.quietHours || {}),
    binding.lastDigestAt || null,
    binding.createdAt,
    binding.updatedAt,
  )
}

function upsertCompletionProposalRow(db: DatabaseSync, proposal: RoadmapCompletionProposalRecord): void {
  db.prepare(`INSERT INTO roadmap_completion_proposals (
    id, roadmap_id, proposed_by, session_id, evidence_json, unresolved_risks_json, recommendation, status,
    decision_by, decision_note, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    proposed_by = excluded.proposed_by,
    session_id = excluded.session_id,
    evidence_json = excluded.evidence_json,
    unresolved_risks_json = excluded.unresolved_risks_json,
    recommendation = excluded.recommendation,
    status = excluded.status,
    decision_by = excluded.decision_by,
    decision_note = excluded.decision_note,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    proposal.id,
    proposal.roadmapId,
    proposal.proposedBy || null,
    proposal.sessionId || null,
    JSON.stringify(proposal.evidence),
    JSON.stringify(proposal.unresolvedRisks),
    proposal.recommendation,
    proposal.status,
    proposal.decisionBy || null,
    proposal.decisionNote || null,
    proposal.expiresAt || null,
    proposal.createdAt,
    proposal.updatedAt,
  )
}

function upsertTaskRow(db: DatabaseSync, task: WorkTaskRecord): void {
  db.prepare(`INSERT INTO tasks (
    id, roadmap_id, title, description, status, priority, agent, agent_team, stage_profiles_json, environment_json, pipeline_json,
    current_stage, current_run_id, attempts_json, note, earliest_start_at, deadline_at, recurrence, manual_gate, sla_class,
    quality_spec_json, source_type, source_key, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    roadmap_id = excluded.roadmap_id,
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    priority = excluded.priority,
    agent = excluded.agent,
    agent_team = excluded.agent_team,
    stage_profiles_json = excluded.stage_profiles_json,
    environment_json = excluded.environment_json,
    pipeline_json = excluded.pipeline_json,
    current_stage = excluded.current_stage,
    current_run_id = excluded.current_run_id,
    attempts_json = excluded.attempts_json,
    note = excluded.note,
    earliest_start_at = excluded.earliest_start_at,
    deadline_at = excluded.deadline_at,
    recurrence = excluded.recurrence,
    manual_gate = excluded.manual_gate,
    sla_class = excluded.sla_class,
    quality_spec_json = excluded.quality_spec_json,
    source_type = excluded.source_type,
    source_key = excluded.source_key,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`).run(
    task.id,
    task.roadmapId,
    task.title,
    task.description,
    task.status,
    task.priority,
    task.agent,
    task.agentTeam || null,
    task.stageProfiles ? JSON.stringify(task.stageProfiles) : null,
    task.environment ? JSON.stringify(task.environment) : null,
    JSON.stringify(task.pipeline),
    task.currentStage || null,
    task.currentRunId || null,
    JSON.stringify(task.attempts || {}),
    task.note || null,
    task.earliestStartAt || null,
    task.deadlineAt || null,
    task.recurrence || null,
    task.manualGate || null,
    task.slaClass || null,
    task.qualitySpec ? JSON.stringify(task.qualitySpec) : null,
    task.sourceType || 'manual',
    task.sourceKey || `manual:${task.id}`,
    task.createdAt,
    task.updatedAt,
  )
}

function upsertRunRow(db: DatabaseSync, run: RunRecord): void {
  db.prepare(`INSERT INTO runs (
    id, task_id, stage, session_id, profile, agent_team, agent_team_version, resolved_profile, resolved_agent, environment_json, runtime_profile_json,
    status, attempt, started_at, completed_at, lease_owner, lease_expires_at, scheduler_generation, cost_usd, input_tokens,
    output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    task_id = excluded.task_id,
    stage = excluded.stage,
    session_id = excluded.session_id,
    profile = excluded.profile,
    agent_team = excluded.agent_team,
    agent_team_version = excluded.agent_team_version,
    resolved_profile = excluded.resolved_profile,
    resolved_agent = excluded.resolved_agent,
    environment_json = excluded.environment_json,
    runtime_profile_json = excluded.runtime_profile_json,
    status = excluded.status,
    attempt = excluded.attempt,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    scheduler_generation = excluded.scheduler_generation,
    cost_usd = excluded.cost_usd,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    runtime_ms = excluded.runtime_ms,
    result_json = excluded.result_json`).run(
    run.id,
    run.taskId,
    run.stage,
    run.sessionId,
    run.profile,
    run.agentTeam || null,
    run.agentTeamVersion || null,
    run.resolvedProfile || null,
    run.resolvedAgent || null,
    run.environment ? JSON.stringify(run.environment) : null,
    run.runtimeProfile ? JSON.stringify(run.runtimeProfile) : null,
    run.status,
    run.attempt,
    run.startedAt,
    run.completedAt || null,
    run.leaseOwner || null,
    run.leaseExpiresAt || null,
    run.schedulerGeneration || null,
    run.costUsd ?? null,
    run.inputTokens ?? null,
    run.outputTokens ?? null,
    run.reasoningTokens ?? null,
    run.cacheReadTokens ?? null,
    run.cacheWriteTokens ?? null,
    run.runtimeMs ?? null,
    run.result ? JSON.stringify(run.result) : null,
  )
}

function upsertDependencyRow(db: DatabaseSync, dependency: WorkDependencyRecord): void {
  db.prepare(`INSERT INTO work_dependencies (task_id, depends_on_task_id, type, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, depends_on_task_id, type) DO UPDATE SET created_at = excluded.created_at`)
    .run(dependency.taskId, dependency.dependsOnTaskId, dependency.type, dependency.createdAt)
}


function emptyState(): WorkState {
  return { version: 1, savedAt: new Date().toISOString(), roadmaps: [], supervisors: [], projectBindings: [], completionProposals: [], tasks: [], runs: [], dependencies: [] }
}

function normalizeState(value: any): WorkState {
  const state = emptyState()
  state.savedAt = typeof value?.savedAt === 'string' ? value.savedAt : state.savedAt
  state.roadmaps = Array.isArray(value?.roadmaps) ? value.roadmaps.filter(isRoadmapRecord).map((roadmap: RoadmapRecord) => ({ ...roadmap, qualitySpec: normalizeRoadmapQualitySpec(roadmap.qualitySpec) })) : []
  const roadmapIds = new Set(state.roadmaps.map(roadmap => roadmap.id))
  state.supervisors = Array.isArray(value?.supervisors) ? value.supervisors.filter(isRoadmapSupervisorRecord).filter((supervisor: RoadmapSupervisorRecord) => roadmapIds.has(supervisor.roadmapId)) : []
  state.projectBindings = Array.isArray(value?.projectBindings) ? value.projectBindings.filter(isProjectBindingRecord).filter((binding: ProjectBindingRecord) => roadmapIds.has(binding.roadmapId)).map(normalizeProjectBindingRecord) : []
  state.completionProposals = Array.isArray(value?.completionProposals) ? value.completionProposals.filter(isRoadmapCompletionProposalRecord).filter((proposal: RoadmapCompletionProposalRecord) => roadmapIds.has(proposal.roadmapId)) : []
  state.tasks = Array.isArray(value?.tasks) ? value.tasks.filter(isTaskRecord) : []
  state.runs = Array.isArray(value?.runs) ? value.runs.filter(isRunRecord) : []
  const taskIds = new Set(state.tasks.map(task => task.id))
  state.dependencies = Array.isArray(value?.dependencies)
    ? value.dependencies.filter(isDependencyRecord).filter((dep: WorkDependencyRecord) => taskIds.has(dep.taskId) && taskIds.has(dep.dependsOnTaskId))
    : []
  for (const roadmapId of roadmapIds) reconcileDefaultSupervisorInState(state, roadmapId, undefined, new Date().toISOString())
  return state
}
