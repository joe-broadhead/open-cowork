/**
 * Roadmap supervisor in-state helpers (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts (keeps dependency graph acyclic).
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import { parseJSON } from './db.js'
import {
  normalizeJsonObject,
  normalizeOptionalEventId,
  normalizeOptionalIdentifier,
  normalizeOptionalIsoTime,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeStringList,
} from './validators.js'
import { rowToSupervisorWakeupReceipt } from './row-mappers.js'
import type {
  RoadmapSupervisorCreateInput,
  RoadmapSupervisorRecord,
  RoadmapSupervisorStatus,
  RoadmapSupervisorUpdateInput,
  SupervisorWakeReason,
  SupervisorWakeupReceiptRecord,
  SupervisorWakeupReceiptStatus,
  WorkEventRecord,
  WorkState,
} from './types.js'

function artifactHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueResultStrings(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function assertRoadmapAcceptsSupervisors(state: WorkState, roadmapId: string, options: { allowArchivedSupervisor?: boolean } = {}): void {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (!options.allowArchivedSupervisor && roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)
}

function assertProfileExists(profile: string): void {
  if (!getConfig().profiles[profile]) throw new Error(`profile not found: ${profile}`)
}

function normalizeRoadmapSupervisorStatus(value: unknown): RoadmapSupervisorStatus {
  if (value === 'active' || value === 'paused' || value === 'blocked' || value === 'completed' || value === 'archived') return value
  throw new Error(`roadmap supervisor status must be active, paused, blocked, completed, or archived: ${String(value)}`)
}

export function createRoadmapSupervisorInState(state: WorkState, input: RoadmapSupervisorCreateInput, now: string): RoadmapSupervisorRecord {
  const roadmapId = normalizeRequiredString(input.roadmapId, 'roadmapId', 120)
  assertRoadmapAcceptsSupervisors(state, roadmapId)
  const status = normalizeRoadmapSupervisorStatus(input.status || 'active')
  if (status === 'archived') throw new Error('cannot create an archived roadmap supervisor')
  const profile = normalizeOptionalIdentifier(input.profile, 'profile') || 'supervisor'
  assertProfileExists(profile)
  const supervisor: RoadmapSupervisorRecord = {
    supervisorId: `supervisor_${randomUUID()}`,
    roadmapId,
    sessionId: normalizeRequiredString(input.sessionId, 'sessionId', 200),
    profile,
    status,
    isDefault: input.isDefault === true,
    cadence: normalizeJsonObject(input.cadence, 'cadence'),
    eventTriggers: normalizeJsonObject(input.eventTriggers, 'eventTriggers'),
    lastReviewedEventId: normalizeOptionalEventId(input.lastReviewedEventId, 'lastReviewedEventId'),
    lastReviewAt: normalizeOptionalIsoTime(input.lastReviewAt, 'lastReviewAt'),
    nextReviewAt: normalizeOptionalIsoTime(input.nextReviewAt, 'nextReviewAt'),
    completionPolicy: normalizeJsonObject(input.completionPolicy, 'completionPolicy'),
    notificationPolicyRef: normalizeOptionalString(input.notificationPolicyRef, 200),
    note: normalizeOptionalString(input.note, 5000),
    createdAt: now,
    updatedAt: now,
  }
  state.supervisors.push(supervisor)
  return supervisor
}

export function applyRoadmapSupervisorUpdate(state: WorkState, supervisor: RoadmapSupervisorRecord, input: RoadmapSupervisorUpdateInput, now: string): void {
  const roadmap = state.roadmaps.find(row => row.id === supervisor.roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${supervisor.roadmapId}`)
  if (roadmap.status === 'archived' && (supervisor.status !== 'archived' || (input.status !== undefined && input.status !== 'archived'))) throw new Error(`roadmap is archived: ${supervisor.roadmapId}`)
  if (input.sessionId !== undefined) supervisor.sessionId = normalizeRequiredString(input.sessionId, 'sessionId', 200)
  if (input.profile !== undefined) {
    const profile = normalizeOptionalIdentifier(input.profile, 'profile') || 'supervisor'
    assertProfileExists(profile)
    supervisor.profile = profile
  }
  if (input.status !== undefined) {
    const status = normalizeRoadmapSupervisorStatus(input.status)
    if (status === 'archived') throw new Error('use roadmap_supervisor_archive to archive a supervisor')
    supervisor.status = status
  }
  if (input.isDefault !== undefined) supervisor.isDefault = Boolean(input.isDefault)
  if (input.cadence !== undefined) supervisor.cadence = normalizeJsonObject(input.cadence, 'cadence')
  if (input.eventTriggers !== undefined) supervisor.eventTriggers = normalizeJsonObject(input.eventTriggers, 'eventTriggers')
  if (input.lastReviewedEventId !== undefined) supervisor.lastReviewedEventId = normalizeOptionalEventId(input.lastReviewedEventId, 'lastReviewedEventId')
  if (input.lastReviewAt !== undefined) supervisor.lastReviewAt = normalizeOptionalIsoTime(input.lastReviewAt, 'lastReviewAt')
  if (input.nextReviewAt !== undefined) supervisor.nextReviewAt = normalizeOptionalIsoTime(input.nextReviewAt, 'nextReviewAt')
  if (input.completionPolicy !== undefined) supervisor.completionPolicy = normalizeJsonObject(input.completionPolicy, 'completionPolicy')
  if (input.notificationPolicyRef !== undefined) supervisor.notificationPolicyRef = normalizeOptionalString(input.notificationPolicyRef, 200)
  if (input.note !== undefined) supervisor.note = normalizeOptionalString(input.note, 5000)
  if (input.lastResultHash !== undefined) supervisor.lastResultHash = normalizeOptionalString(input.lastResultHash, 200)
  if (input.lastResultAt !== undefined) supervisor.lastResultAt = normalizeOptionalIsoTime(input.lastResultAt, 'lastResultAt')
  if (input.lastResultStatus !== undefined) supervisor.lastResultStatus = normalizeOptionalString(input.lastResultStatus, 80)
  if (input.lastResultSummary !== undefined) supervisor.lastResultSummary = normalizeOptionalString(input.lastResultSummary, 2000)
  supervisor.updatedAt = now
}

export function reconcileDefaultSupervisorInState(state: WorkState, roadmapId: string, preferredSupervisorId: string | undefined, now: string): void {
  const active = state.supervisors.filter(supervisor => supervisor.roadmapId === roadmapId && supervisor.status === 'active')
  const preferred = preferredSupervisorId ? active.find(supervisor => supervisor.supervisorId === preferredSupervisorId) : undefined
  const existingDefault = active.filter(supervisor => supervisor.isDefault).sort(compareRoadmapSupervisors)[0]
  const selected = preferred || existingDefault || active.sort(compareRoadmapSupervisors)[0]
  for (const supervisor of state.supervisors.filter(row => row.roadmapId === roadmapId)) {
    const nextDefault = Boolean(selected && supervisor.supervisorId === selected.supervisorId)
    if (supervisor.isDefault !== nextDefault) {
      supervisor.isDefault = nextDefault
      supervisor.updatedAt = now
    }
  }
}

export function defaultRoadmapSupervisor(state: WorkState, roadmapId: string): RoadmapSupervisorRecord | undefined {
  return state.supervisors
    .filter(supervisor => supervisor.roadmapId === roadmapId && supervisor.status === 'active')
    .sort(compareRoadmapSupervisors)[0]
}

export function compareRoadmapSupervisors(a: RoadmapSupervisorRecord, b: RoadmapSupervisorRecord): number {
  const roadmap = a.roadmapId.localeCompare(b.roadmapId)
  if (roadmap !== 0) return roadmap
  if (a.status === 'active' && b.status !== 'active') return -1
  if (a.status !== 'active' && b.status === 'active') return 1
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.supervisorId.localeCompare(b.supervisorId)
}

export function supervisorEligibleForWakeup(supervisor: RoadmapSupervisorRecord, nowMs: number): boolean {
  if (supervisor.status !== 'active' || !supervisor.isDefault) return false
  const policy = supervisorWakeTriggerPolicy(supervisor)
  if (policy['enabled'] === false || policy['quiet'] === true || policy['disabled'] === true) return false
  const leaseExpires = Date.parse(supervisor.wakeLeaseExpiresAt || '')
  return !Number.isFinite(leaseExpires) || leaseExpires <= nowMs
}

export interface SupervisorWakeupCandidate {
  reason: string
  wakeReason: SupervisorWakeReason
  reasonDetail: string
  events: WorkEventRecord[]
  cursorEventId: number
  windowKey: string
}

export function supervisorWakeupReason(state: WorkState, supervisor: RoadmapSupervisorRecord, events: WorkEventRecord[], nowMs: number): SupervisorWakeupCandidate | undefined {
  const policy = supervisorWakeTriggerPolicy(supervisor)
  const cursor = supervisor.lastReviewedEventId || 0
  const matchingEvents = events.filter(event => event.id > cursor && eventTriggersSupervisor(state, supervisor, event, policy))
  const latestEventId = matchingEvents.length ? matchingEvents[matchingEvents.length - 1]!.id : cursor
  if (matchingEvents.length) {
    const latest = matchingEvents[matchingEvents.length - 1]!
    const detail = eventTriggerCategory(latest, state, supervisor) || 'workflow'
    return { reason: `event:${detail}`, wakeReason: supervisorWakeReasonForEvent(latest, detail), reasonDetail: detail, events: matchingEvents, cursorEventId: latestEventId, windowKey: `events:${matchingEvents.map(event => event.id).join(',')}` }
  }

  const pendingProposal = state.completionProposals.find(proposal => proposal.roadmapId === supervisor.roadmapId && proposal.status === 'pending' && Date.parse(proposal.createdAt) > Date.parse(supervisor.lastReviewAt || ''))
  if (pendingProposal && policy['completionProposal'] !== false) return { reason: 'completion_proposal', wakeReason: 'completion_proposal', reasonDetail: pendingProposal.id, events: [], cursorEventId: cursor, windowKey: `completion:${pendingProposal.id}` }

  const nextReview = Date.parse(supervisor.nextReviewAt || '')
  if (policy['cadence'] !== false && Number.isFinite(nextReview) && nextReview <= nowMs) return { reason: 'cadence', wakeReason: 'schedule', reasonDetail: 'nextReviewAt', events: [], cursorEventId: cursor, windowKey: `nextReviewAt:${supervisor.nextReviewAt}` }

  const intervalMs = supervisorCadenceMs(supervisor)
  const lastReview = Date.parse(supervisor.lastReviewAt || supervisor.createdAt)
  if (policy['cadence'] !== false && intervalMs > 0 && Number.isFinite(lastReview) && lastReview + intervalMs <= nowMs) return { reason: 'cadence', wakeReason: 'schedule', reasonDetail: 'cadence.intervalMs', events: [], cursorEventId: cursor, windowKey: `cadence:${lastReview + intervalMs}:${intervalMs}` }
  return undefined
}

export function eventTriggersSupervisor(state: WorkState, supervisor: RoadmapSupervisorRecord, event: WorkEventRecord, policy: Record<string, any>): boolean {
  const category = eventTriggerCategory(event, state, supervisor)
  if (!category || policy[category] === false) return false
  if (category === 'criticalAlertActive') return true
  if (category === 'opencodeQuestionPending' || category === 'opencodePermissionPending') return String(event.payload?.['sessionId'] || '') === supervisor.sessionId
  const roadmapId = eventRoadmapId(event, state)
  return roadmapId === supervisor.roadmapId
}

export function eventTriggerCategory(event: WorkEventRecord, state: WorkState, supervisor: RoadmapSupervisorRecord): string | undefined {
  const roadmapId = eventRoadmapId(event, state)
  const roadmapTasks = roadmapId === supervisor.roadmapId ? state.tasks.filter(task => task.roadmapId === roadmapId) : []
  if ((event.type === 'task.done' || event.type === 'task.done.manual' || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'done')) && roadmapTasks.length && roadmapTasks.every(task => task.status === 'done')) return 'allRoadmapTasksDone'
  if ((event.type === 'task.done' || event.type === 'task.done.manual') || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'done')) return 'taskDone'
  if (event.type === 'task.block' || event.type === 'task.run.prompt_failed' || event.type === 'human_gate.blocked_task' || (event.type === 'task.run.completed' && event.payload?.['taskStatus'] === 'blocked')) return 'taskBlocked'
  if (event.type === 'task.run.prompt_failed' || event.type === 'task.run.lease_expired' || (event.type === 'task.run.completed' && ['failed', 'errored', 'blocked'].includes(String(event.payload?.['runStatus'] || '')))) return 'runFailed'
  if (event.type === 'human_gate.created' || event.type === 'human_gate.escalated') return 'humanGatePending'
  if (event.type === 'opencode.request.notified' && event.payload?.['kind'] === 'question') return 'opencodeQuestionPending'
  if (event.type === 'opencode.request.notified' && event.payload?.['kind'] === 'permission') return 'opencodePermissionPending'
  if (event.type === 'alert.detected' && event.payload?.['severity'] === 'critical') return 'criticalAlertActive'
  if (event.type === 'roadmap.completion.proposed' || event.type === 'roadmap.completion.rejected') return 'completionProposal'
  if (event.type === 'roadmap.supervisor.review_requested') return 'manualPoke'
  if (event.type === 'delegation.progress' || event.type === 'delegation.completed') return 'delegatedProgress'
  if (event.type === 'delegation.blocked' || event.type === 'delegation.failed') return 'delegatedProgress'
  if (event.type === 'channel.mention' || event.type === 'channel.inbound_mention') return 'channelMention'
  return undefined
}

export function supervisorWakeReasonForEvent(event: WorkEventRecord, detail: string): SupervisorWakeReason {
  if (detail === 'allRoadmapTasksDone' || detail === 'taskDone') return 'issue_completed'
  if (detail === 'taskBlocked') return event.type === 'task.run.lease_expired' ? 'stale_run' : 'blocked_work'
  if (detail === 'runFailed') return event.type === 'task.run.lease_expired' ? 'stale_run' : 'failure_alert'
  if (detail === 'humanGatePending' || detail === 'opencodeQuestionPending' || detail === 'opencodePermissionPending') return 'gate_requested'
  if (detail === 'criticalAlertActive') return 'failure_alert'
  if (detail === 'completionProposal') return 'completion_proposal'
  if (detail === 'manualPoke') return 'manual_poke'
  if (detail === 'delegatedProgress') return 'delegated_progress'
  if (detail === 'channelMention') return 'channel_mention'
  return 'delegated_progress'
}

export function supervisorWakeupIdempotencyKey(supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate): string {
  return artifactHash(['supervisor-wakeup-v1', supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.windowKey, wakeup.cursorEventId].join('\n')).slice(0, 32)
}

export function upsertSupervisorWakeupReceiptRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate, lease: { idempotencyKey: string; leaseOwner: string; leaseExpiresAt: string }, now: string): SupervisorWakeupReceiptRecord {
  const triggerEventIds = wakeup.events.map(event => event.id)
  const inspectedInputs = inspectedInputsForWakeup(supervisor, wakeup)
  const existing = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE idempotency_key = ?').get(lease.idempotencyKey) as any
  const id = existing?.id ? String(existing.id) : `supervisor_wakeup_${randomUUID()}`
  if (existing?.id) {
    db.prepare(`UPDATE supervisor_wakeup_receipts
      SET supervisor_id = ?, roadmap_id = ?, wake_reason = ?, reason_detail = ?, window_key = ?, cursor_event_id = ?, trigger_event_ids_json = ?, lease_owner = ?, lease_expires_at = ?, status = 'leased', inspected_inputs_json = ?, completed_at = NULL, updated_at = ?
      WHERE id = ?`)
      .run(supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.reasonDetail, wakeup.windowKey, wakeup.cursorEventId, JSON.stringify(triggerEventIds), lease.leaseOwner, lease.leaseExpiresAt, JSON.stringify(inspectedInputs), now, id)
  } else {
    db.prepare(`INSERT INTO supervisor_wakeup_receipts (
      id, supervisor_id, roadmap_id, wake_reason, reason_detail, idempotency_key, window_key, cursor_event_id, trigger_event_ids_json, lease_owner, lease_expires_at, status, summary, inspected_inputs_json, changed_object_ids_json, recommendation, next_action, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', NULL, ?, '[]', NULL, NULL, ?, ?)`)
      .run(id, supervisor.supervisorId, supervisor.roadmapId, wakeup.wakeReason, wakeup.reasonDetail, lease.idempotencyKey, wakeup.windowKey, wakeup.cursorEventId, JSON.stringify(triggerEventIds), lease.leaseOwner, lease.leaseExpiresAt, JSON.stringify(inspectedInputs), now, now)
  }
  const row = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE id = ?').get(id) as any
  return rowToSupervisorWakeupReceipt(row)!
}

export function completeSupervisorWakeupReceiptRow(db: DatabaseSync, supervisor: RoadmapSupervisorRecord, input: { leaseOwner?: string; status: SupervisorWakeupReceiptStatus; summary?: string; inspectedInputs?: string[]; changedObjectIds?: string[]; recommendation?: string; nextAction?: string; cursorEventId: number; nextWakeAt?: string }, now: string): SupervisorWakeupReceiptRecord | undefined {
  const leaseOwner = input.leaseOwner || supervisor.wakeLeaseOwner
  const row = leaseOwner
    ? db.prepare("SELECT * FROM supervisor_wakeup_receipts WHERE supervisor_id = ? AND lease_owner = ? AND status = 'leased' ORDER BY created_at DESC, id DESC LIMIT 1").get(supervisor.supervisorId, leaseOwner) as any
    : db.prepare("SELECT * FROM supervisor_wakeup_receipts WHERE supervisor_id = ? AND status = 'leased' ORDER BY created_at DESC, id DESC LIMIT 1").get(supervisor.supervisorId) as any
  if (!row?.id) return undefined
  const summary = normalizeOptionalString(input.summary, 2000)
  const inspectedInputs = uniqueResultStrings([
    ...normalizeStringList(parseJSON(row.inspected_inputs_json, []), 500),
    ...normalizeStringList(input.inspectedInputs || [], 500),
  ])
  const changedObjectIds = uniqueResultStrings(normalizeStringList(input.changedObjectIds || [], 500))
  const recommendation = normalizeOptionalString(input.recommendation, 2000)
  const nextAction = normalizeOptionalString(input.nextAction, 2000)
  db.prepare(`UPDATE supervisor_wakeup_receipts
    SET status = ?, summary = ?, inspected_inputs_json = ?, changed_object_ids_json = ?, recommendation = ?, next_action = ?, cursor_event_id = ?, next_wake_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?`)
    .run(input.status, summary || null, JSON.stringify(inspectedInputs), JSON.stringify(changedObjectIds), recommendation || null, nextAction || null, input.cursorEventId, input.nextWakeAt || null, now, now, row.id)
  const updated = db.prepare('SELECT * FROM supervisor_wakeup_receipts WHERE id = ?').get(row.id) as any
  return rowToSupervisorWakeupReceipt(updated) || undefined
}

export function inspectedInputsForWakeup(supervisor: RoadmapSupervisorRecord, wakeup: SupervisorWakeupCandidate): string[] {
  return uniqueResultStrings([
    `supervisor:${supervisor.supervisorId}`,
    `roadmap:${supervisor.roadmapId}`,
    `cursor:${wakeup.cursorEventId}`,
    `window:${wakeup.windowKey}`,
    ...wakeup.events.map(event => `event:${event.id}:${event.type}`),
  ])
}

export function eventRoadmapId(event: WorkEventRecord, state: WorkState): string | undefined {
  if (typeof event.payload?.['roadmapId'] === 'string') return event.payload['roadmapId']
  if (typeof event.subjectId === 'string' && state.roadmaps.some(roadmap => roadmap.id === event.subjectId)) return event.subjectId
  const taskId = typeof event.subjectId === 'string' ? event.subjectId : typeof event.payload?.['taskId'] === 'string' ? event.payload['taskId'] : undefined
  return taskId ? state.tasks.find(task => task.id === taskId)?.roadmapId : undefined
}

export function supervisorWakeTriggerPolicy(supervisor: RoadmapSupervisorRecord): Record<string, any> {
  return {
    taskDone: true,
    taskBlocked: true,
    runFailed: true,
    humanGatePending: true,
    opencodeQuestionPending: true,
    opencodePermissionPending: true,
    criticalAlertActive: true,
    allRoadmapTasksDone: true,
    completionProposal: true,
    manualPoke: true,
    delegatedProgress: true,
    channelMention: true,
    cadence: true,
    ...supervisor.eventTriggers,
  }
}

export function supervisorCadenceMs(supervisor: RoadmapSupervisorRecord): number {
  const raw = Number((supervisor.cadence as any)?.intervalMs || 0)
  return Number.isFinite(raw) && raw > 0 ? Math.max(60 * 1000, Math.min(raw, 30 * 24 * 60 * 60 * 1000)) : 0
}

export function nextSupervisorReviewAt(supervisor: RoadmapSupervisorRecord, nowMs: number): string | undefined {
  const intervalMs = supervisorCadenceMs(supervisor)
  return intervalMs > 0 ? new Date(nowMs + intervalMs).toISOString() : undefined
}
