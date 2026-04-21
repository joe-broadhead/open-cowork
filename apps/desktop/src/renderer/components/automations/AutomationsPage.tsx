import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AutomationAutonomyPolicy,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationKind,
  AutomationListPayload,
  AutomationSchedule,
  AutomationScheduleType,
  AutomationStatus,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

type Props = {
  onOpenThread?: (sessionId: string) => void
}

type DraftState = {
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
  executionMode: AutomationExecutionMode
  autonomyPolicy: AutomationAutonomyPolicy
  projectDirectory: string
}

function createDefaultDraft(overrides: Partial<Pick<DraftState, 'executionMode' | 'autonomyPolicy'>> = {}): DraftState {
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
    executionMode: overrides.executionMode || 'planning_only',
    autonomyPolicy: overrides.autonomyPolicy || 'review-first',
    projectDirectory: '',
  }
}

const AUTOMATION_TEMPLATES: Array<{
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
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    }),
  },
]

function formatStatus(status: AutomationStatus) {
  return status.replace(/-/g, ' ')
}

function formatSchedule(schedule: AutomationSchedule) {
  const time = `${String(schedule.runAtHour ?? 9).padStart(2, '0')}:${String(schedule.runAtMinute ?? 0).padStart(2, '0')}`
  if (schedule.type === 'one_time') return schedule.startAt || 'One time'
  if (schedule.type === 'daily') return `Daily at ${time}`
  if (schedule.type === 'weekly') return `Weekly (day ${schedule.dayOfWeek ?? 1}) at ${time}`
  return `Monthly (day ${schedule.dayOfMonth ?? 1}) at ${time}`
}

function draftToPayload(draft: DraftState): AutomationDraft {
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
    executionMode: draft.executionMode,
    autonomyPolicy: draft.autonomyPolicy,
    projectDirectory: draft.projectDirectory.trim() || null,
  }
}

export function AutomationsPage({ onOpenThread }: Props) {
  const [payload, setPayload] = useState<AutomationListPayload>({ automations: [], inbox: [], workItems: [], runs: [], deliveries: [] })
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const [selectedAutomation, setSelectedAutomation] = useState<AutomationDetail | null>(null)
  const [draftDefaults, setDraftDefaults] = useState<DraftState>(() => createDefaultDraft())
  const [draft, setDraft] = useState<DraftState>(() => createDefaultDraft())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inboxReplies, setInboxReplies] = useState<Record<string, string>>({})

  const refresh = useCallback(async (preferredAutomationId?: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const nextPayload = await window.coworkApi.automation.list()
      setPayload(nextPayload)
      const resolvedId = preferredAutomationId ?? selectedAutomationId ?? nextPayload.automations[0]?.id ?? null
      setSelectedAutomationId(resolvedId)
      setSelectedAutomation(resolvedId ? await window.coworkApi.automation.get(resolvedId) : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations.')
    } finally {
      setLoading(false)
    }
  }, [selectedAutomationId])

  useEffect(() => {
    void refresh()
    return window.coworkApi.on.automationUpdated(() => {
      void refresh()
    })
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    void window.coworkApi.settings.get().then((settings) => {
      if (cancelled) return
      const defaults = createDefaultDraft({
        autonomyPolicy: settings.defaultAutomationAutonomyPolicy,
        executionMode: settings.defaultAutomationExecutionMode,
      })
      setDraftDefaults(defaults)
      setDraft((current) => ({
        ...defaults,
        ...current,
        autonomyPolicy: settings.defaultAutomationAutonomyPolicy,
        executionMode: settings.defaultAutomationExecutionMode,
      }))
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const automationInbox = useMemo(
    () => payload.inbox.filter((item) => item.automationId === selectedAutomationId),
    [payload.inbox, selectedAutomationId],
  )
  const automationWorkItems = useMemo(
    () => payload.workItems.filter((item) => item.automationId === selectedAutomationId),
    [payload.workItems, selectedAutomationId],
  )
  const automationRuns = useMemo(
    () => payload.runs.filter((item) => item.automationId === selectedAutomationId),
    [payload.runs, selectedAutomationId],
  )
  const automationDeliveries = useMemo(
    () => payload.deliveries.filter((item) => item.automationId === selectedAutomationId),
    [payload.deliveries, selectedAutomationId],
  )
  const activeRun = useMemo(
    () => automationRuns.find((run) => run.status === 'queued' || run.status === 'running') || null,
    [automationRuns],
  )
  const hasActiveRun = Boolean(activeRun)
  const isArchived = selectedAutomation?.status === 'archived'
  const controlsLocked = hasActiveRun || isArchived

  const submitDraft = async () => {
    try {
      const created = await window.coworkApi.automation.create(draftToPayload(draft))
      setDraft(draftDefaults)
      await refresh(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create automation.')
    }
  }

  const patchSelected = async (patch: Partial<AutomationDraft>) => {
    if (!selectedAutomationId) return
    try {
      const updated = await window.coworkApi.automation.update(selectedAutomationId, patch)
      await refresh(updated?.id || selectedAutomationId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update automation.')
    }
  }

  const updateDraft = (patch: Partial<DraftState>) => setDraft((current) => ({ ...current, ...patch }))

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[340px] shrink-0 border-r border-border-subtle p-4 overflow-y-auto">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{t('automations.label', 'Automations')}</div>
            <h1 className="mt-1 text-[20px] font-semibold text-text">{t('automations.title', 'Always-on work')}</h1>
          </div>
          {loading ? <span className="text-[11px] text-text-muted">{t('common.loading', 'Loading…')}</span> : null}
        </div>

        <div className="mt-5 rounded-2xl border border-border-subtle p-4" style={{ background: 'var(--color-elevated)' }}>
          <div className="text-[13px] font-semibold text-text">{t('automations.create', 'New automation')}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {AUTOMATION_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => setDraft((current) => template.apply(current))}
                className="rounded-full border border-border px-3 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover cursor-pointer"
                title={template.description}
              >
                {template.label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <input
              value={draft.title}
              onChange={(event) => updateDraft({ title: event.target.value })}
              placeholder={t('automations.titlePlaceholder', 'Weekly market report')}
              className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent"
            />
            <textarea
              value={draft.goal}
              onChange={(event) => updateDraft({ goal: event.target.value })}
              rows={5}
              placeholder={t('automations.goalPlaceholder', 'Build a weekly analysis and market research report and keep it ready for review every Monday morning.')}
              className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent resize-y"
            />
            <div className="grid grid-cols-2 gap-2">
              <select value={draft.kind} onChange={(event) => updateDraft({ kind: event.target.value as AutomationKind })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent">
                <option value="recurring">Recurring program</option>
                <option value="managed-project">Managed project</option>
              </select>
              <select value={draft.scheduleType} onChange={(event) => updateDraft({ scheduleType: event.target.value as AutomationScheduleType })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent">
                <option value="weekly">Weekly</option>
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
            <input value={draft.timezone} onChange={(event) => updateDraft({ timezone: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Europe/Amsterdam" />
            <div className="grid grid-cols-2 gap-2">
              <input value={draft.runAtHour} onChange={(event) => updateDraft({ runAtHour: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Hour" />
              <input value={draft.runAtMinute} onChange={(event) => updateDraft({ runAtMinute: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Minute" />
            </div>
            {draft.scheduleType === 'weekly' && (
              <input value={draft.dayOfWeek} onChange={(event) => updateDraft({ dayOfWeek: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Day of week (0-6)" />
            )}
            {draft.scheduleType === 'monthly' && (
              <input value={draft.dayOfMonth} onChange={(event) => updateDraft({ dayOfMonth: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Day of month (1-31)" />
            )}
            {draft.scheduleType === 'one_time' && (
              <input value={draft.startAt} onChange={(event) => updateDraft({ startAt: event.target.value })} type="datetime-local" className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" />
            )}
            <div className="grid grid-cols-2 gap-2">
              <select value={draft.executionMode} onChange={(event) => updateDraft({ executionMode: event.target.value as AutomationExecutionMode })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent">
                <option value="planning_only">Planning only</option>
                <option value="scoped_execution">Scoped execution</option>
              </select>
              <select value={draft.autonomyPolicy} onChange={(event) => updateDraft({ autonomyPolicy: event.target.value as AutomationAutonomyPolicy })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent">
                <option value="review-first">Review first</option>
                <option value="mostly-autonomous">Mostly autonomous</option>
              </select>
            </div>
            <div className="flex gap-2">
              <input value={draft.projectDirectory} onChange={(event) => updateDraft({ projectDirectory: event.target.value })} className="flex-1 rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Optional project directory" />
              <button
                type="button"
                onClick={async () => {
                  const selected = await window.coworkApi.dialog.selectDirectory()
                  if (selected) updateDraft({ projectDirectory: selected })
                }}
                className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer"
              >
                Browse
              </button>
            </div>
            {draft.executionMode === 'scoped_execution' && !draft.projectDirectory.trim() ? (
              <div className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
                Scoped execution needs a project directory so the agent team has an explicit workspace boundary.
              </div>
            ) : null}
            <input value={draft.heartbeatMinutes} onChange={(event) => updateDraft({ heartbeatMinutes: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Heartbeat minutes" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input value={draft.maxRetries} onChange={(event) => updateDraft({ maxRetries: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Max retries" />
              <input value={draft.retryBaseDelayMinutes} onChange={(event) => updateDraft({ retryBaseDelayMinutes: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Base retry delay (min)" />
              <input value={draft.retryMaxDelayMinutes} onChange={(event) => updateDraft({ retryMaxDelayMinutes: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Max retry delay (min)" />
            </div>
            <button
              type="button"
              onClick={() => void submitDraft()}
              className="rounded-xl px-3 py-2 text-[13px] font-medium cursor-pointer"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
            >
              {t('automations.createAction', 'Create automation')}
            </button>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          {payload.automations.map((automation) => (
            <button
              key={automation.id}
              type="button"
              onClick={() => {
                setSelectedAutomationId(automation.id)
                void window.coworkApi.automation.get(automation.id).then(setSelectedAutomation)
              }}
              className={`rounded-2xl border px-4 py-3 text-start transition-colors cursor-pointer ${selectedAutomationId === automation.id ? 'bg-surface-active' : 'hover:bg-surface-hover'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-text">{automation.title}</div>
                  <div className="mt-1 text-[11px] text-text-muted truncate">{automation.goal}</div>
                </div>
                <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', color: 'var(--color-accent)' }}>
                  {formatStatus(automation.status)}
                </span>
              </div>
              <div className="mt-2 text-[10px] text-text-muted">
                {formatSchedule(automation.schedule)}
                {automation.nextRunAt ? ` · next ${new Date(automation.nextRunAt).toLocaleString()}` : ''}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-5">
        {error ? (
          <div className="mb-4 rounded-2xl border border-border-subtle px-4 py-3 text-[12px]" style={{ background: 'color-mix(in srgb, var(--color-red) 8%, transparent)', color: 'var(--color-red)' }}>
            {error}
          </div>
        ) : null}

        {!selectedAutomation ? (
          <div className="rounded-2xl border border-border-subtle p-6 text-[13px] text-text-muted">
            {t('automations.emptyState', 'Create an automation to start generating execution-ready work with the agent team.')}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{selectedAutomation.kind === 'recurring' ? 'Recurring program' : 'Managed project'}</div>
                  <h2 className="mt-1 text-[24px] font-semibold text-text">{selectedAutomation.title}</h2>
                  <p className="mt-2 max-w-3xl text-[13px] leading-6 text-text-secondary">{selectedAutomation.goal}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
                    <span>{formatSchedule(selectedAutomation.schedule)}</span>
                    <span>Heartbeat {selectedAutomation.heartbeatMinutes}m</span>
                    <span>Retries {selectedAutomation.retryPolicy.maxRetries}x ({selectedAutomation.retryPolicy.baseDelayMinutes}m → {selectedAutomation.retryPolicy.maxDelayMinutes}m)</span>
                    {selectedAutomation.nextHeartbeatAt ? <span>Next heartbeat {new Date(selectedAutomation.nextHeartbeatAt).toLocaleString()}</span> : null}
                    <span>{selectedAutomation.executionMode === 'planning_only' ? 'Planning only' : 'Scoped execution'}</span>
                    <span>{selectedAutomation.autonomyPolicy}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={controlsLocked} onClick={() => void window.coworkApi.automation.previewBrief(selectedAutomation.id).then(() => refresh(selectedAutomation.id))} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Preview brief</button>
                  <button type="button" disabled={isArchived} onClick={() => void window.coworkApi.automation.approveBrief(selectedAutomation.id).then(() => refresh(selectedAutomation.id))} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Approve brief</button>
                  <button type="button" disabled={controlsLocked} onClick={() => void window.coworkApi.automation.runNow(selectedAutomation.id).then(() => refresh(selectedAutomation.id))} className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}>Run now</button>
                  {selectedAutomation.status === 'paused' ? (
                    <button type="button" disabled={isArchived} onClick={() => void window.coworkApi.automation.resume(selectedAutomation.id).then(() => refresh(selectedAutomation.id))} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Resume</button>
                  ) : (
                    <button type="button" disabled={isArchived} onClick={() => void window.coworkApi.automation.pause(selectedAutomation.id).then(() => refresh(selectedAutomation.id))} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Pause</button>
                  )}
                  <button type="button" disabled={hasActiveRun || isArchived} onClick={() => void window.coworkApi.automation.archive(selectedAutomation.id).then(() => refresh())} className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Archive</button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[15px] font-semibold text-text">Execution brief</div>
                  {selectedAutomation.latestSessionId && onOpenThread ? (
                    <button type="button" onClick={() => onOpenThread(selectedAutomation.latestSessionId!)} className="text-[11px] text-text-muted underline cursor-pointer">
                      Open linked thread
                    </button>
                  ) : null}
                </div>
                {selectedAutomation.brief ? (
                  <div className="mt-4 space-y-3 text-[12px]">
                    <div><span className="font-medium text-text">Status:</span> <span className="text-text-secondary">{selectedAutomation.brief.status}</span></div>
                    <div><span className="font-medium text-text">Deliverables:</span><div className="mt-1 text-text-secondary whitespace-pre-wrap">{selectedAutomation.brief.deliverables.join('\n') || 'None yet'}</div></div>
                    <div><span className="font-medium text-text">Missing context:</span><div className="mt-1 text-text-secondary whitespace-pre-wrap">{selectedAutomation.brief.missingContext.join('\n') || 'None'}</div></div>
                    <div><span className="font-medium text-text">Recommended agents:</span><div className="mt-1 text-text-secondary">{selectedAutomation.brief.recommendedAgents.join(', ') || 'Use standard plan/build routing'}</div></div>
                    <div><span className="font-medium text-text">Approval boundary:</span><div className="mt-1 text-text-secondary">{selectedAutomation.brief.approvalBoundary}</div></div>
                  </div>
                ) : (
                  <div className="mt-4 text-[12px] text-text-muted">No execution brief yet. Run Preview brief to enrich this task through the plan agent.</div>
                )}
              </div>

              <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
                <div className="text-[15px] font-semibold text-text">Inbox</div>
                <div className="mt-4 space-y-3">
                  {automationInbox.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No open inbox items.</div>
                  ) : automationInbox.map((item) => (
                    <div key={item.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="text-[12px] font-medium text-text">{item.title}</div>
                      <div className="mt-1 text-[12px] text-text-secondary whitespace-pre-wrap">{item.body}</div>
                      {item.questionId ? (
                        <div className="mt-3 flex gap-2">
                          <input
                            value={inboxReplies[item.id] || ''}
                            onChange={(event) => setInboxReplies((current) => ({ ...current, [item.id]: event.target.value }))}
                            placeholder="Reply to continue"
                            className="flex-1 rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent"
                          />
                          <button
                            type="button"
                            onClick={() => void window.coworkApi.automation.inboxRespond(item.id, inboxReplies[item.id] || '').then(() => refresh(selectedAutomation.id))}
                            className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer"
                            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
                          >
                            Send
                          </button>
                        </div>
                      ) : null}
                      {item.type === 'approval' ? (
                          <button
                            type="button"
                            disabled={selectedAutomation.status === 'archived'}
                            onClick={() => void window.coworkApi.automation.approveBrief(selectedAutomation.id).then(() => refresh(selectedAutomation.id))}
                            className="mt-3 rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
                          >
                          Approve brief
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void window.coworkApi.automation.inboxDismiss(item.id).then(() => refresh(selectedAutomation.id))} className="mt-3 text-[11px] text-text-muted underline cursor-pointer">Dismiss</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
                <div className="text-[15px] font-semibold text-text">Work items</div>
                <div className="mt-4 space-y-3">
                  {automationWorkItems.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No work items yet.</div>
                  ) : automationWorkItems.map((item) => (
                    <div key={item.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-text">{item.title}</div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{item.status}</span>
                      </div>
                      <div className="mt-1 text-[12px] text-text-secondary">{item.description}</div>
                      <div className="mt-2 text-[11px] text-text-muted">
                        {item.ownerAgent ? `Owner: ${item.ownerAgent}` : 'Owner decided at runtime'}
                        {item.dependsOn.length > 0 ? ` · depends on ${item.dependsOn.join(', ')}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
                <div className="text-[15px] font-semibold text-text">Runs</div>
                <div className="mt-4 space-y-3">
                  {automationRuns.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No runs yet.</div>
                  ) : automationRuns.map((run) => (
                    <div key={run.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-text">{run.title}</div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{run.status}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {new Date(run.createdAt).toLocaleString()} · attempt {run.attempt}
                        {run.nextRetryAt ? ` · retrying ${new Date(run.nextRetryAt).toLocaleString()}` : ''}
                      </div>
                      {run.summary ? <div className="mt-2 text-[12px] text-text-secondary whitespace-pre-wrap">{run.summary}</div> : null}
                      {run.error ? <div className="mt-2 text-[12px]" style={{ color: 'var(--color-red)' }}>{run.error}</div> : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {run.status === 'running' ? (
                          <button
                            type="button"
                            onClick={() => void window.coworkApi.automation.cancelRun(run.id).then(() => refresh(selectedAutomation.id))}
                            className="rounded-xl border border-border px-3 py-2 text-[11px] cursor-pointer"
                          >
                            Cancel run
                          </button>
                        ) : null}
                        {(run.status === 'failed' || run.status === 'cancelled') ? (
                          <button
                            type="button"
                            disabled={isArchived || hasActiveRun}
                            onClick={() => void window.coworkApi.automation.retryRun(run.id).then(() => refresh(selectedAutomation.id))}
                            className="rounded-xl border border-border px-3 py-2 text-[11px] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Retry run
                          </button>
                        ) : null}
                      </div>
                      {run.sessionId && onOpenThread ? (
                        <button type="button" onClick={() => onOpenThread(run.sessionId!)} className="mt-2 text-[11px] text-text-muted underline cursor-pointer">
                          Open run thread
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
              <div className="text-[15px] font-semibold text-text">Deliveries</div>
              <div className="mt-4 space-y-3">
                {automationDeliveries.length === 0 ? (
                  <div className="text-[12px] text-text-muted">No deliveries yet.</div>
                ) : automationDeliveries.map((delivery) => (
                  <div key={delivery.id} className="rounded-xl border border-border px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[12px] font-medium text-text">{delivery.title}</div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{delivery.provider}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">{new Date(delivery.createdAt).toLocaleString()} · {delivery.target}</div>
                    <div className="mt-2 text-[12px] text-text-secondary whitespace-pre-wrap">{delivery.body}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
              <div className="text-[15px] font-semibold text-text">Quick edits</div>
              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <input
                  value={selectedAutomation.title}
                  onChange={(event) => setSelectedAutomation((current) => current ? { ...current, title: event.target.value } : current)}
                  className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent"
                />
                <input
                  value={selectedAutomation.projectDirectory || ''}
                  onChange={(event) => setSelectedAutomation((current) => current ? { ...current, projectDirectory: event.target.value } : current)}
                  className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent"
                />
                <textarea
                  value={selectedAutomation.goal}
                  onChange={(event) => setSelectedAutomation((current) => current ? { ...current, goal: event.target.value } : current)}
                  rows={4}
                  className="lg:col-span-2 rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent resize-y"
                />
              </div>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void patchSelected({
                    title: selectedAutomation.title,
                    goal: selectedAutomation.goal,
                    projectDirectory: selectedAutomation.projectDirectory,
                  })}
                  className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer"
                >
                  Save edits
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
