/**
 * Delegation receipt + progress routing helpers (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { parseJSON, queryRows } from './db.js'
import { rowToDelegationReceipt } from './row-mappers.js'
import type {
  DelegatedWorkProgressKind,
  DelegatedWorkReceipt,
  ProjectBindingRecord,
  RoadmapRecord,
  RoadmapSupervisorRecord,
  WorkState,
  WorkTaskRecord,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'

export function findDelegationReceiptInDb(db: DatabaseSync, idempotencyKey: string): DelegatedWorkReceipt | undefined {
  const receiptRow = db.prepare('SELECT * FROM delegation_receipts WHERE idempotency_key = ?').get(idempotencyKey) as any
  return receiptRow?.idempotency_key ? rowToDelegationReceipt(receiptRow) : undefined
}

export function upsertDelegationReceiptRow(db: DatabaseSync, receipt: DelegatedWorkReceipt, now: string): void {
  db.prepare(`INSERT INTO delegation_receipts (
    idempotency_key, target_type, task_ids_json, roadmap_id, supervisor_id, project_binding_id,
    parent_session_id, links_json, next_scheduler_action, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(idempotency_key) DO UPDATE SET
    target_type = excluded.target_type,
    task_ids_json = excluded.task_ids_json,
    roadmap_id = excluded.roadmap_id,
    supervisor_id = excluded.supervisor_id,
    project_binding_id = excluded.project_binding_id,
    parent_session_id = excluded.parent_session_id,
    links_json = excluded.links_json,
    next_scheduler_action = excluded.next_scheduler_action,
    updated_at = excluded.updated_at`)
    .run(
      receipt.idempotencyKey,
      receipt.targetType,
      JSON.stringify(receipt.taskIds),
      receipt.roadmapId || null,
      receipt.supervisorId || null,
      receipt.projectBindingId || null,
      receipt.parentSessionId || null,
      JSON.stringify(receipt.links || {}),
      receipt.nextSchedulerAction,
      now,
      now,
    )
}

export function appendDelegationProgressForTask(db: DatabaseSync, task: WorkTaskRecord, progress: DelegatedWorkProgressKind, details: Record<string, unknown>, now: string, ...keyParts: Array<string | undefined>): void {
  for (const context of delegationContextsForTask(db, task)) {
    appendDelegationProgressRow(db, context['idempotencyKey'], progress, task.id, {
      ...context,
      ...details,
      taskId: task.id,
      roadmapId: task.roadmapId,
      links: { ...context['links'], task: `/tasks/${task.id}`, roadmap: `/roadmaps/${task.roadmapId}` },
      progressKey: delegationProgressKey(context['idempotencyKey'], progress, task.id, ...keyParts),
    }, now)
  }
}

export function appendDelegationProgressForRoadmap(db: DatabaseSync, roadmapId: string, progress: DelegatedWorkProgressKind, subjectId: string, details: Record<string, unknown>, now: string): void {
  for (const context of delegationContextsForRoadmap(db, roadmapId)) {
    appendDelegationProgressRow(db, context['idempotencyKey'], progress, subjectId, {
      ...context,
      ...details,
      roadmapId,
      links: { ...context['links'], roadmap: `/roadmaps/${roadmapId}` },
      progressKey: delegationProgressKey(context['idempotencyKey'], progress, subjectId),
    }, now)
  }
}

export function appendDelegationProgressRow(db: DatabaseSync, idempotencyKey: string, progress: DelegatedWorkProgressKind, subjectId: string | undefined, payload: Record<string, unknown>, now: string): void {
  const progressKey = typeof payload['progressKey'] === 'string' ? payload['progressKey'] : delegationProgressKey(idempotencyKey, progress, subjectId)
  if (!reserveDelegationProgressReceipt(db, progressKey, idempotencyKey, progress, subjectId, now)) return
  const eventId = appendWorkEventRow(db, 'delegation.progress', idempotencyKey, {
    ...payload,
    idempotencyKey,
    progress,
    progressKey,
    subjectId,
  }, now)
  db.prepare('UPDATE delegation_progress_receipts SET event_id = ? WHERE progress_key = ?').run(eventId, progressKey)
}

export function delegationContextsForTask(db: DatabaseSync, task: WorkTaskRecord): Array<Record<string, any>> {
  return delegationContexts(db, delegationPayloadLike(task.id)).filter(context => {
    const taskIds = Array.isArray(context['taskIds']) ? context['taskIds'] : []
    return taskIds.includes(task.id)
  })
}

export function delegationContextsForRoadmap(db: DatabaseSync, roadmapId: string): Array<Record<string, any>> {
  return delegationContexts(db, delegationPayloadLike(roadmapId)).filter(context => context['roadmapId'] === roadmapId)
}

/**
 * SQL LIKE prefilter for delegation payload scans. Delegation events are
 * durable (never pruned), so per-transition context lookups must not JSON
 * parse every payload ever recorded. The LIKE match runs inside SQLite as a
 * cheap substring scan and may over-match; callers always re-verify on the
 * parsed payload, so the prefilter only needs to never under-match a payload
 * whose JSON contains the quoted id.
 */
export function delegationPayloadLike(id: string): string {
  return `%${JSON.stringify(String(id))}%`
}

export function delegationContexts(db: DatabaseSync, payloadLike: string): Array<Record<string, any>> {
  const rows = db.prepare("SELECT payload_json FROM events WHERE type = 'delegation.mapped' AND payload_json LIKE ? ORDER BY id ASC").all(payloadLike) as any[]
  if (!rows.length) return []
  const contexts: Array<Record<string, any>> = []
  const keys = new Set<string>()
  for (const row of rows) {
    const payload = parseJSON<Record<string, any>>(row.payload_json, {})
    const idempotencyKey = typeof payload['idempotencyKey'] === 'string' ? payload['idempotencyKey'] : ''
    if (!idempotencyKey) continue
    keys.add(idempotencyKey)
    contexts.push({ ...payload, idempotencyKey })
  }

  const accepted = new Map<string, Record<string, unknown>>()
  for (const key of keys) {
    const acceptedRows = db.prepare("SELECT payload_json FROM events WHERE type = 'delegation.accepted' AND payload_json LIKE ? ORDER BY id ASC").all(delegationPayloadLike(key)) as any[]
    for (const row of acceptedRows) {
      const payload = parseJSON<Record<string, unknown>>(row.payload_json, {})
      if (payload['idempotencyKey'] === key) accepted.set(key, payload)
    }
  }

  return contexts.map(payload => {
    const acceptedPayload = accepted.get(payload['idempotencyKey']) || {}
    return {
      ...payload,
      parentSessionId: typeof payload['parentSessionId'] === 'string' ? payload['parentSessionId'] : acceptedPayload['parentSessionId'],
      notificationTarget: payload['notificationTarget'] || acceptedPayload['notificationTarget'],
      objective: payload['objective'] || acceptedPayload['objective'],
    }
  })
}

export function reserveDelegationProgressReceipt(db: DatabaseSync, progressKey: string, idempotencyKey: string, progress: DelegatedWorkProgressKind, subjectId: string | undefined, now: string): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO delegation_progress_receipts (
    progress_key, idempotency_key, progress, subject_id, event_id, created_at
  ) VALUES (?, ?, ?, ?, NULL, ?)`).run(progressKey, idempotencyKey, progress, subjectId || null, now) as any
  return Number(result?.changes || 0) > 0
}

export function delegationProgressKey(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.filter(Boolean).join('\n')).digest('hex').slice(0, 32)
}

export function receiptLinks(roadmap: RoadmapRecord | undefined, tasks: WorkTaskRecord[], supervisor: RoadmapSupervisorRecord | undefined, binding: ProjectBindingRecord | undefined): Record<string, string> {
  const links: Record<string, string> = {}
  if (roadmap) links['roadmap'] = `/roadmaps/${roadmap.id}`
  if (tasks.length === 1) links['task'] = `/tasks/${tasks[0]!.id}`
  if (tasks.length > 1) links['tasks'] = `/tasks?roadmapId=${roadmap?.id || ''}`
  if (supervisor) links['supervisor'] = `/roadmap-supervisors/${supervisor.supervisorId}`
  if (binding) links['projectBinding'] = `/project-bindings/${binding.id}`
  return links
}

export function nextDelegationSchedulerAction(tasks: WorkTaskRecord[], supervisor?: RoadmapSupervisorRecord): string {
  if (tasks.some(task => task.manualGate)) return 'await_human_gate'
  if (tasks.some(task => task.earliestStartAt && Date.parse(task.earliestStartAt) > Date.now())) return 'scheduled_for_earliest_start'
  if (tasks.length) return 'dispatch_when_scheduler_runs'
  if (supervisor) return 'roadmap_supervisor_review_when_due'
  return 'none'
}

export function supervisedProjectResultFromReceipt(state: WorkState, receipt: DelegatedWorkReceipt): Omit<import('./types.js').SupervisedProjectCreateResult, 'idempotencyStatus'> {
  const roadmap = receipt.roadmapId ? state.roadmaps.find(row => row.id === receipt.roadmapId) : undefined
  if (!roadmap) throw new Error(`project create receipt references missing roadmap: ${receipt.idempotencyKey}`)
  const supervisor = receipt.supervisorId
    ? state.supervisors.find(row => row.supervisorId === receipt.supervisorId)
    : state.supervisors.find(row => row.roadmapId === roadmap.id && row.isDefault)
  if (!supervisor) throw new Error(`project create receipt references missing supervisor: ${receipt.idempotencyKey}`)
  const binding = receipt.projectBindingId
    ? state.projectBindings.find(row => row.id === receipt.projectBindingId)
    : state.projectBindings.find(row => row.roadmapId === roadmap.id)
  if (!binding) throw new Error(`project create receipt references missing project binding: ${receipt.idempotencyKey}`)
  const taskIds = new Set(receipt.taskIds)
  const tasks = state.tasks.filter(task => task.roadmapId === roadmap.id && (!taskIds.size || taskIds.has(task.id)))
  return { roadmap, tasks, supervisor, binding }
}

export function updateDelegationReceiptsForDeletion(
  db: DatabaseSync,
  deletedTaskIds: Set<string>,
  deleted: { roadmapId?: string; supervisorIds?: Set<string>; projectBindingIds?: Set<string> } = {},
): void {
  const rows = queryRows(db, 'SELECT idempotency_key, task_ids_json, roadmap_id, supervisor_id, project_binding_id FROM delegation_receipts')
  const update = db.prepare(`UPDATE delegation_receipts
    SET task_ids_json = ?,
        roadmap_id = CASE WHEN roadmap_id = ? THEN NULL ELSE roadmap_id END,
        supervisor_id = CASE WHEN supervisor_id = ? THEN NULL ELSE supervisor_id END,
        project_binding_id = CASE WHEN project_binding_id = ? THEN NULL ELSE project_binding_id END,
        updated_at = ?
    WHERE idempotency_key = ?`)
  const now = new Date().toISOString()
  for (const row of rows) {
    const taskIds = parseJSON<unknown[]>(row['task_ids_json'], []).map(String)
    const remainingTaskIds = taskIds.filter(taskId => !deletedTaskIds.has(taskId))
    const supervisorId = String(row['supervisor_id'] || '')
    const projectBindingId = String(row['project_binding_id'] || '')
    const roadmapMatches = Boolean(deleted.roadmapId && row['roadmap_id'] === deleted.roadmapId)
    const supervisorMatches = Boolean(supervisorId && deleted.supervisorIds?.has(supervisorId))
    const projectBindingMatches = Boolean(projectBindingId && deleted.projectBindingIds?.has(projectBindingId))
    if (remainingTaskIds.length === taskIds.length && !roadmapMatches && !supervisorMatches && !projectBindingMatches) continue
    update.run(
      JSON.stringify(remainingTaskIds),
      deleted.roadmapId || '',
      supervisorMatches ? supervisorId : '',
      projectBindingMatches ? projectBindingId : '',
      now,
      row['idempotency_key'],
    )
  }
}
