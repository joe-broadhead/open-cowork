/**
 * Project binding / completion-proposal helpers (JOE-942 / JOE-919).
 * Leaf module — no import from work-store.ts.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { queryRows } from './db.js'
import { rowToAlert, rowToHumanGate } from './row-mappers.js'
import {
  normalizeJsonObject,
  normalizeOptionalIsoTime,
  normalizeOptionalString,
  normalizeProjectAlias,
  normalizeRequiredString,
  normalizeThreadId,
} from './validators.js'
import type {
  AlertRecord,
  HumanGateRecord,
  ProjectBindingInput,
  ProjectBindingRecord,
  ProjectBindingScope,
  ProjectContextResolution,
  ProjectNotificationMode,
  RoadmapCompletionProposalRecord,
  RoadmapCompletionProposalStatus,
  RoadmapRecord,
  WorkState,
} from './types.js'
import { appendWorkEventRow } from './event-append.js'
import { defaultRoadmapSupervisor } from './supervisor-helpers.js'

export function upsertProjectBindingInState(state: WorkState, input: ProjectBindingInput, now: string, bindingId?: string): ProjectBindingRecord {
  const alias = normalizeProjectAlias(input.alias)
  const scope = normalizeProjectBindingScope(input.scope, input.provider)
  const provider = normalizeProjectBindingProvider(input.provider, scope)
  const chatId = normalizeProjectBindingChatId(input.chatId, scope)
  const threadId = normalizeThreadId(input.threadId)
  const roadmapId = normalizeRequiredString(input.roadmapId, 'roadmapId', 120)
  const sessionId = normalizeRequiredString(input.sessionId, 'sessionId', 200)
  const allowRebind = input.allowRebind === true
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  if (!roadmap) throw new Error(`roadmap not found: ${roadmapId}`)
  if (roadmap.status === 'archived') throw new Error(`roadmap is archived: ${roadmapId}`)

  const aliasConflict = state.projectBindings.find(binding => binding.id !== bindingId && binding.alias === alias && binding.scope === scope)
  const surfaceKey = scope === 'global' ? undefined : projectBindingSurfaceKey({ scope, provider, chatId, threadId, sessionId } as ProjectBindingRecord)
  const surfaceConflict = surfaceKey ? state.projectBindings.find(binding => binding.id !== bindingId && projectBindingSurfaceKey(binding) === surfaceKey) : undefined
  for (const conflict of [aliasConflict, surfaceConflict].filter(Boolean) as ProjectBindingRecord[]) {
    if (!allowRebind && !sameProjectBindingTarget(conflict, { alias, roadmapId, sessionId, scope, provider, chatId, threadId })) {
      if (conflict === aliasConflict) throw new Error(`project alias already bound for ${scope}: ${alias}`)
      throw new Error(`project surface already bound: ${projectBindingSurfaceKey(conflict)}`)
    }
  }

  const existing = bindingId ? state.projectBindings.find(binding => binding.id === bindingId) : undefined
  if (bindingId && !existing) throw new Error(`project binding not found: ${bindingId}`)
  const reusable = existing || (allowRebind ? aliasConflict || surfaceConflict : aliasConflict)
  const conflicts = new Set([aliasConflict, surfaceConflict].filter(Boolean).map(binding => binding!.id))
  if (reusable) conflicts.delete(reusable.id)
  if (conflicts.size) state.projectBindings = state.projectBindings.filter(binding => !conflicts.has(binding.id))

  const record: ProjectBindingRecord = {
    id: reusable?.id || `project_binding_${randomUUID()}`,
    alias,
    roadmapId,
    sessionId,
    scope,
    provider,
    chatId,
    threadId: threadId || undefined,
    title: normalizeOptionalString(input.title, 200) || roadmap.title,
    notificationMode: normalizeProjectNotificationMode(input.notificationMode || reusable?.notificationMode),
    mutedUntil: normalizeOptionalIsoTime(input.mutedUntil ?? reusable?.mutedUntil, 'mutedUntil'),
    quietHours: normalizeJsonObject(input.quietHours ?? reusable?.quietHours, 'quietHours'),
    lastDigestAt: normalizeOptionalIsoTime(input.lastDigestAt ?? reusable?.lastDigestAt, 'lastDigestAt'),
    createdAt: reusable?.createdAt || now,
    updatedAt: now,
  }
  if (reusable) {
    const index = state.projectBindings.findIndex(binding => binding.id === reusable.id)
    state.projectBindings[index] = record
  } else {
    state.projectBindings.push(record)
  }
  return record
}

export function resolvedProjectContext(state: WorkState, binding: ProjectBindingRecord, reason: string): ProjectContextResolution {
  const roadmap = state.roadmaps.find(row => row.id === binding.roadmapId)
  if (!roadmap) return { status: 'not_found', reason: `Roadmap not found for binding ${binding.id}: ${binding.roadmapId}`, binding }
  return { status: 'resolved', reason, binding, roadmap, supervisor: defaultRoadmapSupervisor(state, roadmap.id) }
}

export function normalizeProjectBindingScope(value: unknown, provider?: string): ProjectBindingScope {
  if (value === undefined || value === null || value === '') {
    if (provider === 'telegram' || provider === 'whatsapp' || provider === 'discord') return provider
    return 'global'
  }
  if (value === 'global' || value === 'opencode' || value === 'telegram' || value === 'whatsapp' || value === 'discord') return value
  throw new Error(`project binding scope must be global, opencode, telegram, whatsapp, or discord: ${String(value)}`)
}

export function normalizeProjectBindingProvider(value: unknown, scope: ProjectBindingScope): string | undefined {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') {
    const provider = normalizeRequiredString(value || scope, 'provider', 40)
    if (provider !== scope) throw new Error(`provider must match project binding scope: ${scope}`)
    return provider
  }
  if (value !== undefined && value !== null && value !== '') throw new Error(`provider is only valid for channel project bindings`)
  return undefined
}

export function normalizeProjectNotificationMode(value: unknown): ProjectNotificationMode {
  if (value === undefined || value === null || value === '') return 'immediate'
  if (value === 'immediate' || value === 'digest' || value === 'muted') return value
  throw new Error(`project notification mode must be immediate, digest, or muted: ${String(value)}`)
}


export function normalizeProjectBindingChatId(value: unknown, scope: ProjectBindingScope): string | undefined {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') return normalizeRequiredString(value, 'chatId', 200)
  if (value !== undefined && value !== null && value !== '') throw new Error('chatId is only valid for channel project bindings')
  return undefined
}

export function projectBindingSurfaceKey(input: Pick<ProjectBindingRecord, 'scope' | 'provider' | 'chatId' | 'threadId' | 'sessionId'>): string {
  if (input.scope === 'telegram' || input.scope === 'whatsapp' || input.scope === 'discord') return `${input.scope}:${input.provider || ''}:${input.chatId || ''}:${normalizeThreadId(input.threadId)}`
  if (input.scope === 'opencode') return `opencode:${input.sessionId}`
  return `global:${input.scope}`
}

export function sameProjectBindingTarget(binding: ProjectBindingRecord, input: Pick<ProjectBindingRecord, 'alias' | 'roadmapId' | 'sessionId' | 'scope' | 'provider' | 'chatId' | 'threadId'>): boolean {
  return binding.alias === input.alias && binding.roadmapId === input.roadmapId && binding.sessionId === input.sessionId && binding.scope === input.scope && (binding.provider || '') === (input.provider || '') && (binding.chatId || '') === (input.chatId || '') && (binding.threadId || '') === normalizeThreadId(input.threadId)
}

export function projectBindingChannelChanged(previous: ProjectBindingRecord, next: ProjectBindingRecord): boolean {
  return Boolean(previous.provider && previous.chatId && ((previous.provider || '') !== (next.provider || '') || (previous.chatId || '') !== (next.chatId || '') || normalizeThreadId(previous.threadId) !== normalizeThreadId(next.threadId)))
}

export function deleteProjectBindingChannelRow(db: DatabaseSync, binding: ProjectBindingRecord): void {
  if (!binding.provider || !binding.chatId) return
  // The channel key may have been independently rebound after this project row
  // was mirrored. Delete only the exact mirror generation we created; a newer
  // chat/task/roadmap binding at the same provider target must survive.
  db.prepare(`DELETE FROM channel_bindings
    WHERE provider = ? AND chat_id = ? AND thread_id = ?
      AND mode = 'roadmap' AND roadmap_id = ? AND session_id = ?`)
    .run(binding.provider, binding.chatId, normalizeThreadId(binding.threadId), binding.roadmapId, binding.sessionId)
}

export function approveRoadmapCompletionProposalInState(_state: WorkState, db: DatabaseSync, proposal: RoadmapCompletionProposalRecord, roadmap: RoadmapRecord, decision: { actor: string; source: string; note?: string }, now: string): void {
  proposal.status = 'approved'
  proposal.decisionBy = decision.actor
  proposal.decisionNote = decision.note
  proposal.updatedAt = now
  roadmap.status = 'done'
  roadmap.updatedAt = now
  appendWorkEventRow(db, 'roadmap.completion.approved', proposal.id, { roadmapId: roadmap.id, actor: decision.actor, source: decision.source, note: decision.note }, now)
  appendWorkEventRow(db, 'audit.human_decision', roadmap.id, { actor: decision.actor, source: decision.source, operation: 'roadmap_completion.approve', target: proposal.id, result: 'ok', note: decision.note }, now)
}

export function completionAutoBlockers(state: WorkState, db: DatabaseSync, roadmap: RoadmapRecord, proposal: RoadmapCompletionProposalRecord): string[] {
  const blockers: string[] = []
  if (state.tasks.some(task => task.roadmapId === roadmap.id && task.status === 'blocked')) blockers.push('blocked tasks exist')
  const gates = queryRows(db, "SELECT * FROM human_gates WHERE roadmap_id = ? AND status IN ('pending', 'escalated')", roadmap.id).map(rowToHumanGate).filter(Boolean) as HumanGateRecord[]
  if (gates.length) blockers.push('open required gates exist')
  const criticalAlerts = queryRows(db, "SELECT * FROM alerts WHERE severity = 'critical' AND status IN ('active', 'acknowledged')").map(rowToAlert).filter(Boolean) as AlertRecord[]
  if (criticalAlerts.length) blockers.push('active critical alerts exist')
  const required = [...(roadmap.qualitySpec?.evidenceRequirements || []), ...(roadmap.qualitySpec?.requiredArtifacts || [])]
  if (required.length) {
    const evidenceText = proposal.evidence.join('\n').toLowerCase()
    const missing = required.filter(item => !evidenceText.includes(item.toLowerCase()))
    if (missing.length) blockers.push(`missing required evidence: ${missing.join(', ')}`)
  }
  if (proposal.unresolvedRisks.length) blockers.push('unresolved risks exist')
  return blockers
}

export function compareProjectBindings(a: ProjectBindingRecord, b: ProjectBindingRecord): number {
  const scope = scopeRank(a.scope) - scopeRank(b.scope)
  if (scope !== 0) return scope
  const alias = a.alias.localeCompare(b.alias)
  if (alias !== 0) return alias
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.id.localeCompare(b.id)
}

export function compareRoadmapCompletionProposals(a: RoadmapCompletionProposalRecord, b: RoadmapCompletionProposalRecord): number {
  const status = completionProposalStatusRank(a.status) - completionProposalStatusRank(b.status)
  if (status !== 0) return status
  const created = Date.parse(b.createdAt) - Date.parse(a.createdAt)
  if (Number.isFinite(created) && created !== 0) return created
  return a.id.localeCompare(b.id)
}

export function completionProposalStatusRank(status: RoadmapCompletionProposalStatus): number {
  return status === 'pending' ? 0 : status === 'approved' ? 1 : status === 'rejected' ? 2 : 3
}

export function scopeRank(scope: ProjectBindingScope): number {
  if (scope === 'telegram' || scope === 'whatsapp' || scope === 'discord') return 0
  if (scope === 'opencode') return 1
  return 2
}

export function filterProjectBindings(bindings: ProjectBindingRecord[], filter: { alias?: string; roadmapId?: string; sessionId?: string; scope?: ProjectBindingScope; provider?: string; chatId?: string; threadId?: string } = {}): ProjectBindingRecord[] {
  if (filter.alias) bindings = bindings.filter(binding => binding.alias === normalizeProjectAlias(filter.alias!))
  if (filter.roadmapId) bindings = bindings.filter(binding => binding.roadmapId === filter.roadmapId)
  if (filter.sessionId) bindings = bindings.filter(binding => binding.sessionId === filter.sessionId)
  if (filter.scope) bindings = bindings.filter(binding => binding.scope === filter.scope)
  if (filter.provider) bindings = bindings.filter(binding => binding.provider === filter.provider)
  if (filter.chatId) bindings = bindings.filter(binding => binding.chatId === filter.chatId)
  if (filter.threadId !== undefined) bindings = bindings.filter(binding => (binding.threadId || '') === normalizeThreadId(filter.threadId))
  return bindings.slice().sort(compareProjectBindings)
}
