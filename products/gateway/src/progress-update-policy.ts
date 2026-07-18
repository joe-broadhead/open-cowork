import type { ProjectBindingRecord, ProjectNotificationMode, RoadmapSupervisorRecord, WorkState } from './work-store.js'

export type ProgressUpdateDelivery = 'immediate' | 'digest' | 'deferred' | 'muted' | 'session'
export type ProgressUpdateSeverity = 'normal' | 'critical'

export interface QuietHoursPolicy {
  start?: string
  end?: string
  timezone?: 'UTC'
}

export interface ProgressUpdateEscalationPolicy {
  criticalBypassDigest: boolean
  criticalBypassQuietHours: boolean
}

export interface ProgressUpdatePolicy {
  mode: ProjectNotificationMode
  mutedUntil?: string
  quietHours: QuietHoursPolicy
  lastDigestAt?: string
  escalation: ProgressUpdateEscalationPolicy
}

export interface ProgressUpdateDecision {
  delivery: ProgressUpdateDelivery
  reason: string
  policy: ProgressUpdatePolicy
  deferredUntil?: string
  suppressedUntil?: string
  escalationBypass?: 'digest' | 'quiet_hours'
}

export interface ProgressUpdateDecisionInput {
  policy: ProgressUpdatePolicy
  severity: ProgressUpdateSeverity
  now: number
  digestIntervalMs: number
  hasChannelTarget: boolean
}

const DEFAULT_ESCALATION: ProgressUpdateEscalationPolicy = {
  criticalBypassDigest: true,
  criticalBypassQuietHours: true,
}

export function defaultProgressUpdatePolicy(overrides: Partial<Omit<ProgressUpdatePolicy, 'escalation'>> & { escalation?: Partial<ProgressUpdateEscalationPolicy> } = {}): ProgressUpdatePolicy {
  return {
    mode: overrides.mode || 'immediate',
    mutedUntil: overrides.mutedUntil,
    quietHours: normalizeQuietHours(overrides.quietHours),
    lastDigestAt: overrides.lastDigestAt,
    escalation: { ...DEFAULT_ESCALATION, ...(overrides.escalation || {}) },
  }
}

export function progressUpdatePolicyFromBinding(binding: ProjectBindingRecord): ProgressUpdatePolicy {
  return defaultProgressUpdatePolicy({
    mode: binding.notificationMode || 'immediate',
    mutedUntil: binding.mutedUntil,
    quietHours: binding.quietHours,
    lastDigestAt: binding.lastDigestAt,
    escalation: escalationFromObject(binding.quietHours),
  })
}

export function progressUpdatePolicyFromTarget(value: unknown): ProgressUpdatePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultProgressUpdatePolicy()
  const target = value as Record<string, unknown>
  return defaultProgressUpdatePolicy({
    mode: normalizeMode(target['notificationMode']),
    mutedUntil: typeof target['mutedUntil'] === 'string' ? target['mutedUntil'] : undefined,
    quietHours: objectValue(target['quietHours']),
    escalation: escalationFromObject(objectValue(target['escalation']) || objectValue(target['quietHours'])),
  })
}

export function progressUpdatePolicyForSupervisor(supervisor: RoadmapSupervisorRecord | undefined, state: WorkState): ProgressUpdatePolicy {
  if (!supervisor) return defaultProgressUpdatePolicy()
  const ref = supervisor.notificationPolicyRef
  if (ref) {
    const binding = state.projectBindings.find(row => row.id === ref || `project_binding:${row.id}` === ref)
      || state.projectBindings.find(row => row.roadmapId === supervisor.roadmapId && row.alias === ref)
      || state.projectBindings.find(row => row.alias === ref)
    if (binding) return progressUpdatePolicyFromBinding(binding)
  }
  const binding = state.projectBindings.find(row => row.roadmapId === supervisor.roadmapId && row.sessionId === supervisor.sessionId)
  return binding ? progressUpdatePolicyFromBinding(binding) : defaultProgressUpdatePolicy()
}

export function decideProgressUpdateDelivery(input: ProgressUpdateDecisionInput): ProgressUpdateDecision {
  const { policy, severity, now, digestIntervalMs, hasChannelTarget } = input
  const mutedUntil = Date.parse(policy.mutedUntil || '')
  if (policy.mode === 'muted') return { delivery: 'muted', reason: 'target muted', policy }
  if (Number.isFinite(mutedUntil) && mutedUntil > now) return { delivery: 'muted', reason: `muted until ${policy.mutedUntil}`, policy, suppressedUntil: policy.mutedUntil }

  const quiet = quietHoursWindow(policy.quietHours, now)
  if (quiet.active) {
    if (severity === 'critical' && policy.escalation.criticalBypassQuietHours) {
      return { delivery: hasChannelTarget ? 'immediate' : 'session', reason: 'critical bypasses quiet hours', policy, escalationBypass: 'quiet_hours' }
    }
    return { delivery: 'deferred', reason: 'quiet hours active', policy, deferredUntil: quiet.endsAt }
  }

  if (policy.mode === 'digest') {
    if (severity === 'critical' && policy.escalation.criticalBypassDigest) {
      return { delivery: hasChannelTarget ? 'immediate' : 'session', reason: 'critical bypasses digest', policy, escalationBypass: 'digest' }
    }
    const lastDigest = Date.parse(policy.lastDigestAt || '')
    if (!Number.isFinite(lastDigest)) return { delivery: hasChannelTarget ? 'digest' : 'session', reason: 'digest due', policy }
    const nextDigest = lastDigest + Math.max(60_000, digestIntervalMs)
    if (now >= nextDigest) return { delivery: hasChannelTarget ? 'digest' : 'session', reason: 'digest due', policy }
    return { delivery: 'deferred', reason: 'digest interval not due', policy, deferredUntil: new Date(nextDigest).toISOString() }
  }

  return { delivery: hasChannelTarget ? 'immediate' : 'session', reason: hasChannelTarget ? 'immediate policy' : 'session target only', policy }
}

export function quietHoursWindow(quietHours: QuietHoursPolicy | Record<string, unknown> | undefined, now: number): { active: boolean; endsAt?: string } {
  const start = parseMinuteOfDay(quietHours?.start)
  const end = parseMinuteOfDay(quietHours?.end)
  if (start === undefined || end === undefined || start === end) return { active: false }
  const date = new Date(now)
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  const active = start < end ? minute >= start && minute < end : minute >= start || minute < end
  if (!active) return { active: false }
  const endDate = new Date(now)
  const endHours = Math.floor(end / 60)
  const endMinutes = end % 60
  endDate.setUTCHours(endHours, endMinutes, 0, 0)
  if (endDate.getTime() <= now) endDate.setUTCDate(endDate.getUTCDate() + 1)
  return { active: true, endsAt: endDate.toISOString() }
}

function normalizeQuietHours(value: unknown): QuietHoursPolicy {
  const object = objectValue(value)
  if (!object) return {}
  return {
    start: typeof object['start'] === 'string' ? object['start'] : undefined,
    end: typeof object['end'] === 'string' ? object['end'] : undefined,
    timezone: object['timezone'] === 'UTC' ? 'UTC' : undefined,
  }
}

function escalationFromObject(value: unknown): Partial<ProgressUpdateEscalationPolicy> {
  const object = objectValue(value)
  if (!object) return {}
  const policy: Partial<ProgressUpdateEscalationPolicy> = {}
  if (typeof object['criticalBypassDigest'] === 'boolean') policy.criticalBypassDigest = object['criticalBypassDigest']
  if (typeof object['criticalBypassQuietHours'] === 'boolean') policy.criticalBypassQuietHours = object['criticalBypassQuietHours']
  return policy
}

function normalizeMode(value: unknown): ProjectNotificationMode | undefined {
  return value === 'immediate' || value === 'digest' || value === 'muted' ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseMinuteOfDay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined
  return hours * 60 + minutes
}
