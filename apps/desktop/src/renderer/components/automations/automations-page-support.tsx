import type { ReactNode } from 'react'
import type {
  AutomationAutonomyPolicy,
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationInboxItem,
  AutomationKind,
  AutomationRun,
  AutomationSchedule,
  AutomationScheduleType,
  AutomationWorkItem,
  BuiltInAgentDetail,
  CustomAgentSummary,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { formatAgentLabel } from '../chat/chat-input-utils'

export type DraftState = {
  title: string
  goal: string
  kind: AutomationKind
  scheduleType: AutomationScheduleType
  timezone: string
  runAtHour: string
  runAtMinute: string
  dayOfWeek: string
  dayOfMonth: string
  startAt: string
  heartbeatMinutes: string
  maxRetries: string
  retryBaseDelayMinutes: string
  retryMaxDelayMinutes: string
  dailyRunCap: string
  maxRunDurationMinutes: string
  executionMode: AutomationExecutionMode
  autonomyPolicy: AutomationAutonomyPolicy
  projectDirectory: string
  preferredAgentNames: string[]
}

export type AutomationAgentOption = {
  id: string
  label: string
  description: string
  source: 'builtin' | 'custom'
}

export function createDefaultDraft(overrides: Partial<Pick<DraftState, 'executionMode' | 'autonomyPolicy'>> = {}): DraftState {
  return {
    title: '',
    goal: '',
    kind: 'recurring',
    scheduleType: 'weekly',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    runAtHour: '9',
    runAtMinute: '0',
    dayOfWeek: '1',
    dayOfMonth: '1',
    startAt: '',
    heartbeatMinutes: '15',
    maxRetries: '3',
    retryBaseDelayMinutes: '5',
    retryMaxDelayMinutes: '60',
    dailyRunCap: '6',
    maxRunDurationMinutes: '120',
    executionMode: overrides.executionMode || 'planning_only',
    autonomyPolicy: overrides.autonomyPolicy || 'review-first',
    projectDirectory: '',
    preferredAgentNames: [],
  }
}

export const AUTOMATION_TEMPLATES: Array<{
  id: string
  label: string
  description: string
  apply: (current: DraftState) => DraftState
}> = [
  {
    id: 'weekly-report',
    label: 'Weekly report',
    description: 'Recurring analysis, research, and chart-heavy reporting every Monday morning.',
    apply: (current) => ({
      ...current,
      title: 'Weekly market report',
      goal: 'Build a weekly analysis and market research report, summarize the most important trends, and keep it ready for review every Monday morning.',
      kind: 'recurring',
      scheduleType: 'weekly',
      dayOfWeek: '1',
      runAtHour: '9',
      runAtMinute: '0',
      heartbeatMinutes: '15',
      maxRetries: '3',
      retryBaseDelayMinutes: '5',
      retryMaxDelayMinutes: '60',
      dailyRunCap: '4',
      maxRunDurationMinutes: '90',
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    }),
  },
  {
    id: 'managed-project',
    label: 'Managed project',
    description: 'Maintain a roadmap, enrich the next chunk of work, and keep execution-ready tasks moving.',
    apply: (current) => ({
      ...current,
      title: 'Managed product roadmap',
      goal: 'Maintain a clear roadmap for this project, enrich the next execution-ready tasks, and keep progress moving forward without guessing when context is missing.',
      kind: 'managed-project',
      scheduleType: 'daily',
      runAtHour: '10',
      runAtMinute: '0',
      heartbeatMinutes: '30',
      maxRetries: '3',
      retryBaseDelayMinutes: '10',
      retryMaxDelayMinutes: '60',
      dailyRunCap: '8',
      maxRunDurationMinutes: '180',
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    }),
  },
]

export function formatStatus(status: string) {
  return status.replace(/-/g, ' ')
}

export function formatSchedule(schedule: AutomationSchedule) {
  const time = `${String(schedule.runAtHour ?? 9).padStart(2, '0')}:${String(schedule.runAtMinute ?? 0).padStart(2, '0')}`
  if (schedule.type === 'one_time') return schedule.startAt || 'One time'
  if (schedule.type === 'daily') return `Daily at ${time}`
  if (schedule.type === 'weekly') return `Weekly (day ${schedule.dayOfWeek ?? 1}) at ${time}`
  return `Monthly (day ${schedule.dayOfMonth ?? 1}) at ${time}`
}

export function formatTimestamp(value: string | null | undefined, empty = 'Not scheduled') {
  return value ? new Date(value).toLocaleString() : empty
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function summarizeWorkItems(items: AutomationWorkItem[]) {
  return {
    total: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    ready: items.filter((item) => item.status === 'ready').length,
    running: items.filter((item) => item.status === 'running').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }
}

export function deriveReliabilityState(input: {
  automation: AutomationDetail
  inbox: AutomationInboxItem[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
}) {
  const { automation, inbox, activeRun, latestRun } = input
  const hasFailureInbox = inbox.some((item) => item.type === 'failure')
  if (automation.status === 'paused' && hasFailureInbox) {
    return {
      value: 'Circuit open',
      detail: 'Paused after repeated or deterministic failures until you review it and resume.',
    }
  }
  if (latestRun?.status === 'failed' && latestRun.nextRetryAt) {
    return {
      value: 'Retry queued',
      detail: `Attempt ${latestRun.attempt + 1} is scheduled for ${formatTimestamp(latestRun.nextRetryAt, '')}.`,
    }
  }
  if (automation.status === 'needs_user') {
    return {
      value: 'Waiting on you',
      detail: inbox.length > 0 ? `${pluralize(inbox.length, 'open inbox item')} is blocking progress.` : 'Waiting for clarification or approval.',
    }
  }
  if (activeRun) {
    return {
      value: 'Running',
      detail: `${activeRun.kind} is active right now.`,
    }
  }
  if (latestRun?.status === 'failed') {
    return {
      value: 'Needs review',
      detail: latestRun.error || 'The latest run failed without an automatic retry.',
    }
  }
  return {
    value: 'Healthy',
    detail: automation.nextHeartbeatAt ? `Next heartbeat ${formatTimestamp(automation.nextHeartbeatAt)}.` : 'No heartbeat is currently scheduled.',
  }
}

export function describeRunPolicy(automation: AutomationDetail, latestRun: AutomationRun | null) {
  if (latestRun?.error?.includes('attempt cap reached')) {
    return latestRun.error
  }
  if (latestRun?.error?.includes('timed out')) {
    return latestRun.error
  }
  return `${automation.runPolicy.dailyRunCap} work-run attempt${automation.runPolicy.dailyRunCap === 1 ? '' : 's'} per day (including retries) · ${automation.runPolicy.maxRunDurationMinutes} minute max per run · ${automation.retryPolicy.maxRetries} retry${automation.retryPolicy.maxRetries === 1 ? '' : 'ies'} available.`
}

export function latestRunSummary(run: AutomationRun | null) {
  if (!run) return 'No runs yet'
  if (run.status === 'running') return `Running ${run.kind}`
  if (run.status === 'queued') return `Queued ${run.kind}`
  if (run.status === 'failed' && run.nextRetryAt) return `Retry scheduled ${formatTimestamp(run.nextRetryAt, '')}`
  return `${formatStatus(run.status)} ${run.kind}`
}

export function deriveNextAction(input: {
  automation: AutomationDetail
  inbox: AutomationInboxItem[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
  latestDelivery: AutomationDeliveryRecord | null
}) {
  const { automation, inbox, activeRun, latestRun, latestDelivery } = input
  if (activeRun) return `Monitor the ${activeRun.kind} run in progress`
  if (automation.status === 'needs_user') {
    return inbox.length > 0 ? `Resolve ${pluralize(inbox.length, 'open inbox item')}` : 'Provide the missing context'
  }
  if (automation.status === 'paused') return 'Resume when you want work to continue'
  if (!automation.brief) return 'Preview the execution brief'
  if (!automation.brief.approvedAt) return 'Approve the execution brief'
  if (automation.status === 'failed') {
    return latestRun?.nextRetryAt
      ? 'Wait for the scheduled retry or inspect the failed run'
      : 'Inspect the failed run and retry when ready'
  }
  if (automation.status === 'ready' || automation.status === 'draft') return 'Run the next execution pass'
  if (latestDelivery) return 'Review the latest delivery and linked thread'
  return 'Review the latest run summary'
}

export function SummaryCard({
  label,
  value,
  detail,
  accent = false,
  compact = false,
}: {
  label: string
  value: string
  detail: string
  accent?: boolean
  compact?: boolean
}) {
  return (
    <div
      className="rounded-2xl border border-border-subtle p-4"
      style={{ background: accent ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)' }}
    >
      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className={`mt-2 font-semibold text-text ${compact ? 'text-[15px] leading-6' : 'text-[22px]'} `}>{value}</div>
      <div className="mt-1 text-[12px] leading-5 text-text-secondary">{detail}</div>
    </div>
  )
}

export function DetailSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[15px] font-semibold text-text">{title}</div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  )
}

export function DetailGroup({
  label,
  values,
  empty = 'None',
}: {
  label: string
  values: string[]
  empty?: string
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {values.map((value) => (
            <span key={`${label}-${value}`} className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary">
              {value}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-text-muted">{empty}</div>
      )}
    </div>
  )
}

export function buildAutomationAgentOptions(input: {
  builtinAgents: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
  selectedNames?: string[]
}) {
  const options = new Map<string, AutomationAgentOption>()
  for (const agent of input.builtinAgents) {
    if (agent.mode !== 'subagent' || agent.hidden || agent.disabled || agent.surface === 'automation') continue
    options.set(agent.name, {
      id: agent.name,
      label: agent.label || formatAgentLabel(agent.name),
      description: agent.description || 'Built-in specialist',
      source: 'builtin',
    })
  }
  for (const agent of input.customAgents) {
    if (!agent.enabled || !agent.valid) continue
    options.set(agent.name, {
      id: agent.name,
      label: formatAgentLabel(agent.name),
      description: agent.description || 'Custom specialist',
      source: 'custom',
    })
  }
  for (const name of input.selectedNames || []) {
    if (!options.has(name)) {
      options.set(name, {
        id: name,
        label: `${formatAgentLabel(name)} (unavailable)`,
        description: 'Previously selected but not available in this context',
        source: 'custom',
      })
    }
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function resolveAgentLabels(names: string[], options: AutomationAgentOption[]) {
  const labels = new Map(options.map((option) => [option.id, option.label.replace(/\s+\(unavailable\)$/i, '')]))
  return names.map((name) => labels.get(name) || formatAgentLabel(name))
}

export function AgentTeamSelector({
  options,
  value,
  onChange,
  emptyLabel = 'No specialist agents are available in this context yet.',
}: {
  options: AutomationAgentOption[]
  value: string[]
  onChange: (next: string[]) => void
  emptyLabel?: string
}) {
  if (options.length === 0) {
    return <div className="text-[12px] text-text-muted">{emptyLabel}</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = value.includes(option.id)
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(selected ? value.filter((entry) => entry !== option.id) : [...value, option.id])}
            className="rounded-full border px-3 py-1.5 text-left transition-colors cursor-pointer"
            style={{
              borderColor: selected ? 'var(--color-accent)' : 'var(--color-border)',
              background: selected ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))' : 'transparent',
            }}
            title={option.description}
          >
            <span className="text-[11px] font-medium text-text">{option.label}</span>
            <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">{option.source}</span>
          </button>
        )
      })}
    </div>
  )
}

export function draftToPayload(draft: DraftState): AutomationDraft {
  const schedule: AutomationSchedule = {
    type: draft.scheduleType,
    timezone: draft.timezone,
    runAtHour: Number.parseInt(draft.runAtHour, 10) || 9,
    runAtMinute: Number.parseInt(draft.runAtMinute, 10) || 0,
  }
  if (draft.scheduleType === 'weekly') schedule.dayOfWeek = Number.parseInt(draft.dayOfWeek, 10) || 1
  if (draft.scheduleType === 'monthly') schedule.dayOfMonth = Number.parseInt(draft.dayOfMonth, 10) || 1
  if (draft.scheduleType === 'one_time' && draft.startAt.trim()) schedule.startAt = new Date(draft.startAt).toISOString()

  return {
    title: draft.title.trim(),
    goal: draft.goal.trim(),
    kind: draft.kind,
    schedule,
    heartbeatMinutes: Number.parseInt(draft.heartbeatMinutes, 10) || 15,
    retryPolicy: {
      maxRetries: Math.max(0, Number.parseInt(draft.maxRetries, 10) || 0),
      baseDelayMinutes: Math.max(1, Number.parseInt(draft.retryBaseDelayMinutes, 10) || 5),
      maxDelayMinutes: Math.max(
        Math.max(1, Number.parseInt(draft.retryBaseDelayMinutes, 10) || 5),
        Number.parseInt(draft.retryMaxDelayMinutes, 10) || 60,
      ),
    },
    runPolicy: {
      dailyRunCap: Math.max(1, Number.parseInt(draft.dailyRunCap, 10) || 1),
      maxRunDurationMinutes: Math.max(1, Number.parseInt(draft.maxRunDurationMinutes, 10) || 1),
    },
    executionMode: draft.executionMode,
    autonomyPolicy: draft.autonomyPolicy,
    projectDirectory: draft.projectDirectory.trim() || null,
    preferredAgentNames: draft.preferredAgentNames,
  }
}

export function dailyRunAttemptCapLabel(count: number) {
  return `${count} attempt${count === 1 ? '' : 's'} / day`
}

export function dailyRunAttemptCapPlaceholder() {
  return t('automations.dailyRunAttemptCapPlaceholder', 'Daily work-run attempt cap')
}
