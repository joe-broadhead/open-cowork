import { listHumanGates, listRoadmapCompletionProposals, listWorkEvents, loadWorkState, type RoadmapSupervisorRecord, type WorkEventRecord, type WorkState } from './work-store.js'

export type SupervisorHealth = 'ok' | 'due' | 'leased' | 'stale' | 'paused' | 'blocked' | 'completed'

export interface SupervisorObservabilityRow {
  supervisorId: string
  roadmapId: string
  roadmapTitle: string
  alias?: string
  sessionId: string
  profile: string
  status: string
  isDefault: boolean
  health: SupervisorHealth
  due: boolean
  leased: boolean
  leaseExpired: boolean
  nextReviewAt?: string
  lastReviewAt?: string
  lastWakeAt?: string
  lastWakeReason?: string
  lastWakeEventId?: number
  lastResultAt?: string
  lastResultStatus?: string
  lastResultSummary?: string
  pendingCompletionProposals: number
  openHumanGates: number
}

export interface SupervisorObservabilityReport {
  generatedAt: string
  summary: {
    total: number
    active: number
    due: number
    leased: number
    stale: number
    paused: number
    blocked: number
    completed: number
    pendingCompletionProposals: number
    openHumanGates: number
  }
  supervisors: SupervisorObservabilityRow[]
  auditEvents: WorkEventRecord[]
}

export function buildSupervisorObservability(state: WorkState = loadWorkState(), options: { now?: number; eventLimit?: number } = {}): SupervisorObservabilityReport {
  const nowMs = options.now || Date.now()
  const rows = state.supervisors
    .filter(supervisor => supervisor.status !== 'archived')
    .map(supervisor => supervisorRow(state, supervisor, nowMs))
    .sort((a, b) => healthRank(a.health) - healthRank(b.health) || a.roadmapTitle.localeCompare(b.roadmapTitle) || a.supervisorId.localeCompare(b.supervisorId))
  const auditEvents = listWorkEvents(options.eventLimit || 200).filter(isSupervisorAuditEvent).slice(-25)
  return {
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      total: rows.length,
      active: rows.filter(row => row.status === 'active').length,
      due: rows.filter(row => row.due).length,
      leased: rows.filter(row => row.leased).length,
      stale: rows.filter(row => row.health === 'stale').length,
      paused: rows.filter(row => row.status === 'paused').length,
      blocked: rows.filter(row => row.status === 'blocked').length,
      completed: rows.filter(row => row.status === 'completed').length,
      pendingCompletionProposals: rows.reduce((sum, row) => sum + row.pendingCompletionProposals, 0),
      openHumanGates: rows.reduce((sum, row) => sum + row.openHumanGates, 0),
    },
    supervisors: rows,
    auditEvents,
  }
}

export function formatSupervisorObservability(report: SupervisorObservabilityReport): string {
  const summary = report.summary
  const lines = [
    'Supervisor Observability',
    `Generated: ${report.generatedAt}`,
    `Supervisors: ${summary.total} total, ${summary.active} active, ${summary.due} due, ${summary.leased} leased, ${summary.stale} stale, ${summary.paused} paused, ${summary.blocked} blocked`,
  ]
  for (const row of report.supervisors.slice(0, 12)) {
    lines.push(`- [${row.health}] ${row.alias || row.roadmapTitle} (${row.supervisorId}) status=${row.status} next=${row.nextReviewAt || 'none'} result=${row.lastResultStatus || 'none'}`)
  }
  if (report.auditEvents.length) {
    lines.push('Recent audit events:')
    for (const event of report.auditEvents.slice(-8)) lines.push(`- #${event.id} ${event.createdAt} ${event.type}${event.subjectId ? ` ${event.subjectId}` : ''}`)
  }
  return lines.join('\n')
}

function supervisorRow(state: WorkState, supervisor: RoadmapSupervisorRecord, nowMs: number): SupervisorObservabilityRow {
  const roadmap = state.roadmaps.find(row => row.id === supervisor.roadmapId)
  const binding = state.projectBindings.filter(row => row.roadmapId === supervisor.roadmapId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  const dueAt = Date.parse(supervisor.nextReviewAt || '')
  const leaseExpiresAt = Date.parse(supervisor.wakeLeaseExpiresAt || '')
  const lastReviewAt = Date.parse(supervisor.lastReviewAt || supervisor.createdAt || '')
  const due = supervisor.status === 'active' && Number.isFinite(dueAt) && dueAt <= nowMs
  const leased = Boolean(supervisor.wakeLeaseOwner && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > nowMs))
  const leaseExpired = Boolean(supervisor.wakeLeaseOwner && Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= nowMs)
  const stale = supervisor.status === 'active' && !leased && !due && Number.isFinite(lastReviewAt) && nowMs - lastReviewAt > 7 * 24 * 60 * 60 * 1000
  return {
    supervisorId: supervisor.supervisorId,
    roadmapId: supervisor.roadmapId,
    roadmapTitle: roadmap?.title || supervisor.roadmapId,
    alias: binding?.alias,
    sessionId: supervisor.sessionId,
    profile: supervisor.profile,
    status: supervisor.status,
    isDefault: supervisor.isDefault,
    health: supervisorHealth(supervisor, { due, leased, stale: stale || leaseExpired }),
    due,
    leased,
    leaseExpired,
    nextReviewAt: supervisor.nextReviewAt,
    lastReviewAt: supervisor.lastReviewAt,
    lastWakeAt: supervisor.lastWakeAt,
    lastWakeReason: supervisor.lastWakeReason,
    lastWakeEventId: supervisor.lastWakeEventId,
    lastResultAt: supervisor.lastResultAt,
    lastResultStatus: supervisor.lastResultStatus,
    lastResultSummary: supervisor.lastResultSummary,
    pendingCompletionProposals: listRoadmapCompletionProposals({ roadmapId: supervisor.roadmapId, status: 'open' }).length,
    openHumanGates: listHumanGates({ roadmapId: supervisor.roadmapId, status: 'open' }).length,
  }
}

function supervisorHealth(supervisor: RoadmapSupervisorRecord, flags: { due: boolean; leased: boolean; stale: boolean }): SupervisorHealth {
  if (supervisor.status === 'paused') return 'paused'
  if (supervisor.status === 'blocked') return 'blocked'
  if (supervisor.status === 'completed') return 'completed'
  if (flags.leased) return 'leased'
  if (flags.due) return 'due'
  if (flags.stale) return 'stale'
  return 'ok'
}

function healthRank(health: SupervisorHealth): number {
  return { blocked: 0, stale: 1, due: 2, leased: 3, paused: 4, ok: 5, completed: 6 }[health]
}

function isSupervisorAuditEvent(event: WorkEventRecord): boolean {
  return event.type.startsWith('roadmap.supervisor.') || event.type.startsWith('roadmap.completion.') || event.type.startsWith('project.binding.') || event.type === 'audit.human_decision'
}
