import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AutomationAutonomyPolicy,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationKind,
  AutomationListPayload,
  AutomationScheduleType,
  BuiltInAgentDetail,
  CustomAgentSummary,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  AgentTeamSelector,
  AUTOMATION_TEMPLATES,
  buildAutomationAgentOptions,
  createDefaultDraft,
  dailyRunAttemptCapLabel,
  dailyRunAttemptCapPlaceholder,
  deriveNextAction,
  deriveReliabilityState,
  describeRunPolicy,
  DetailGroup,
  DetailSection,
  draftToPayload,
  formatSchedule,
  formatStatus,
  formatTimestamp,
  latestRunSummary,
  pluralize,
  resolveAgentLabels,
  summarizeWorkItems,
  SummaryCard,
  type AutomationAgentOption,
  type DraftState,
} from './automations-page-support'

type Props = {
  onOpenThread?: (sessionId: string) => void
}

export function AutomationsPage({ onOpenThread }: Props) {
  const [payload, setPayload] = useState<AutomationListPayload>({ automations: [], inbox: [], workItems: [], runs: [], deliveries: [] })
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const [selectedAutomation, setSelectedAutomation] = useState<AutomationDetail | null>(null)
  const [draftDefaults, setDraftDefaults] = useState<DraftState>(() => createDefaultDraft())
  const [draft, setDraft] = useState<DraftState>(() => createDefaultDraft())
  const [draftAgentOptions, setDraftAgentOptions] = useState<AutomationAgentOption[]>([])
  const [selectedAgentOptions, setSelectedAgentOptions] = useState<AutomationAgentOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inboxReplies, setInboxReplies] = useState<Record<string, string>>({})

  const loadAgentOptions = useCallback(async (directory: string | null | undefined, selectedNames: string[]) => {
    const context = directory?.trim() ? { directory: directory.trim() } : undefined
    const [builtins, customAgents] = await Promise.all([
      window.coworkApi.app.builtinAgents().catch(() => [] as BuiltInAgentDetail[]),
      window.coworkApi.agents.list(context).catch(() => [] as CustomAgentSummary[]),
    ])
    return buildAutomationAgentOptions({
      builtinAgents: builtins || [],
      customAgents: customAgents || [],
      selectedNames,
    })
  }, [])

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
    }).catch((err) => {
      console.error('Failed to load automation defaults:', err)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadAgentOptions(draft.projectDirectory, draft.preferredAgentNames).then((options) => {
      if (!cancelled) setDraftAgentOptions(options)
    }).catch(() => {
      if (!cancelled) setDraftAgentOptions([])
    })
    return () => {
      cancelled = true
    }
  }, [draft.projectDirectory, draft.preferredAgentNames, loadAgentOptions])

  useEffect(() => {
    let cancelled = false
    if (!selectedAutomation) {
      setSelectedAgentOptions([])
      return () => {
        cancelled = true
      }
    }
    void loadAgentOptions(selectedAutomation.projectDirectory, selectedAutomation.preferredAgentNames).then((options) => {
      if (!cancelled) setSelectedAgentOptions(options)
    }).catch(() => {
      if (!cancelled) setSelectedAgentOptions([])
    })
    return () => {
      cancelled = true
    }
  }, [selectedAutomation?.projectDirectory, selectedAutomation?.preferredAgentNames, loadAgentOptions])

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
  const latestRun = automationRuns[0] || null
  const latestDelivery = automationDeliveries[0] || null
  const backlog = useMemo(
    () => summarizeWorkItems(automationWorkItems),
    [automationWorkItems],
  )
  const overview = useMemo(() => {
    const activeAutomations = payload.automations.filter((automation) => automation.status !== 'archived').length
    const runningRuns = payload.runs.filter((run) => run.status === 'queued' || run.status === 'running').length
    const failedRuns = payload.runs.filter((run) => run.status === 'failed').length
    const latestActivity = payload.runs[0] || null
    return {
      totalAutomations: payload.automations.length,
      activeAutomations,
      inboxCount: payload.inbox.length,
      runningRuns,
      failedRuns,
      deliveryCount: payload.deliveries.length,
      latestActivity,
    }
  }, [payload])
  const selectedNextAction = useMemo(
    () => selectedAutomation
      ? deriveNextAction({
        automation: selectedAutomation,
        inbox: automationInbox,
        activeRun,
        latestRun,
        latestDelivery,
      })
      : '',
    [selectedAutomation, automationInbox, activeRun, latestRun, latestDelivery],
  )
  const selectedPreferredAgentLabels = useMemo(
    () => selectedAutomation ? resolveAgentLabels(selectedAutomation.preferredAgentNames, selectedAgentOptions) : [],
    [selectedAutomation, selectedAgentOptions],
  )
  const reliability = useMemo(
    () => selectedAutomation
      ? deriveReliabilityState({
        automation: selectedAutomation,
        inbox: automationInbox,
        activeRun,
        latestRun,
      })
      : null,
    [selectedAutomation, automationInbox, activeRun, latestRun],
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
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Preferred specialists</div>
              <div className="mt-2">
                <AgentTeamSelector
                  options={draftAgentOptions}
                  value={draft.preferredAgentNames}
                  onChange={(preferredAgentNames) => updateDraft({ preferredAgentNames })}
                  emptyLabel="No specialist agents are available yet. You can still create the automation and let Cowork use its default routing."
                />
              </div>
              <div className="mt-2 text-[11px] text-text-muted">
                These agents stay preferred during enrichment and execution, but Cowork still uses plan/build as the primary automation flow.
              </div>
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
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input value={draft.dailyRunCap} onChange={(event) => updateDraft({ dailyRunCap: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder={dailyRunAttemptCapPlaceholder()} />
              <input value={draft.maxRunDurationMinutes} onChange={(event) => updateDraft({ maxRunDurationMinutes: event.target.value })} className="rounded-xl border border-border px-3 py-2 text-[12px] bg-transparent" placeholder="Max run duration (min)" />
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
          <div className="space-y-5">
            <div className="rounded-3xl border border-border-subtle p-6" style={{ background: 'var(--color-elevated)' }}>
              <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">Automation overview</div>
                  <h2 className="mt-2 text-[28px] font-semibold text-text">Turn repeatable work into a standing agent program</h2>
                  <p className="mt-3 max-w-3xl text-[14px] leading-7 text-text-secondary">
                    Automations wake up on schedule, enrich raw asks into execution-ready briefs, ask for clarification when context is missing,
                    and route approved work into the Cowork agent team.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => setDraft((current) => AUTOMATION_TEMPLATES[0]!.apply(current))}
                      className="rounded-xl px-3 py-2 text-[12px] font-medium cursor-pointer"
                      style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
                    >
                      Load weekly report template
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft((current) => AUTOMATION_TEMPLATES[1]!.apply(current))}
                      className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer"
                    >
                      Load managed project template
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <SummaryCard
                    label="Active automations"
                    value={String(overview.activeAutomations)}
                    detail={overview.totalAutomations === 0 ? 'No standing programs yet' : `${overview.totalAutomations} total configured`}
                    accent
                  />
                  <SummaryCard
                    label="Open inbox"
                    value={String(overview.inboxCount)}
                    detail={overview.inboxCount > 0 ? 'Approvals and clarifications waiting on you' : 'No user action is currently required'}
                  />
                  <SummaryCard
                    label="Live runs"
                    value={String(overview.runningRuns)}
                    detail={overview.runningRuns > 0 ? 'Queued or running automation work' : 'Nothing is currently executing'}
                  />
                  <SummaryCard
                    label="Deliveries"
                    value={String(overview.deliveryCount)}
                    detail={overview.deliveryCount > 0 ? `${overview.failedRuns} failed run${overview.failedRuns === 1 ? '' : 's'} recorded` : 'Nothing has been delivered yet'}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_0.85fr]">
              <DetailSection title="Start with a template">
                <div className="grid gap-3 lg:grid-cols-2">
                  {AUTOMATION_TEMPLATES.map((template) => (
                    <button
                      key={`overview-${template.id}`}
                      type="button"
                      onClick={() => setDraft((current) => template.apply(current))}
                      className="rounded-2xl border border-border px-4 py-4 text-left transition-colors hover:bg-surface-hover cursor-pointer"
                    >
                      <div className="text-[13px] font-semibold text-text">{template.label}</div>
                      <div className="mt-2 text-[12px] leading-6 text-text-secondary">{template.description}</div>
                      <div className="mt-3 text-[11px] text-text-muted">Loads the draft on the left so you can adjust the schedule, autonomy, and retry policy.</div>
                    </button>
                  ))}
                </div>
              </DetailSection>

              <DetailSection title="How it works">
                <div className="space-y-3">
                  {[
                    ['1. Enrich', 'Cowork routes the raw ask through the plan agent and attached specialists until the brief is execution-ready.'],
                    ['2. Ask when blocked', 'Missing context and review gates become inbox items so automations stop instead of guessing.'],
                    ['3. Execute and deliver', 'Approved work runs through build and specialist subagents, then lands as run output and delivery records.'],
                  ].map(([label, detail]) => (
                    <div key={label} className="rounded-2xl border border-border px-4 py-3">
                      <div className="text-[13px] font-semibold text-text">{label}</div>
                      <div className="mt-1 text-[12px] leading-6 text-text-secondary">{detail}</div>
                    </div>
                  ))}
                </div>
              </DetailSection>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.05fr_0.95fr]">
              <DetailSection title="Recent automation activity">
                {overview.latestActivity ? (
                  <div className="space-y-3">
                    {payload.runs.slice(0, 5).map((run) => (
                      <div key={run.id} className="rounded-xl border border-border px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[12px] font-medium text-text">{run.title}</div>
                          <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{run.status}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-text-muted">
                          {formatTimestamp(run.createdAt)} · attempt {run.attempt}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">
                    No automation activity yet. Create the first recurring report or managed project and the right side will turn into an operations view.
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Good first use cases">
                <div className="space-y-3">
                  {[
                    'Build a weekly market + performance report every Monday and keep it ready for review.',
                    'Maintain a project roadmap, enrich the next tasks, and keep execution-ready work moving.',
                    'Run a recurring research sweep that produces a brief, charts, and linked run history.',
                  ].map((example) => (
                    <div key={example} className="rounded-xl border border-border px-4 py-3 text-[12px] leading-6 text-text-secondary">
                      {example}
                    </div>
                  ))}
                </div>
              </DetailSection>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="rounded-3xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{selectedAutomation.kind === 'recurring' ? 'Recurring program' : 'Managed project'}</div>
                  <h2 className="mt-1 text-[26px] font-semibold text-text">{selectedAutomation.title}</h2>
                  <p className="mt-2 max-w-3xl text-[13px] leading-6 text-text-secondary">{selectedAutomation.goal}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-text-muted">
                    <span>{formatSchedule(selectedAutomation.schedule)}</span>
                    <span>Heartbeat {selectedAutomation.heartbeatMinutes}m</span>
                    <span>Retries {selectedAutomation.retryPolicy.maxRetries}x ({selectedAutomation.retryPolicy.baseDelayMinutes}m → {selectedAutomation.retryPolicy.maxDelayMinutes}m)</span>
                    <span>Run cap {dailyRunAttemptCapLabel(selectedAutomation.runPolicy.dailyRunCap)} · {selectedAutomation.runPolicy.maxRunDurationMinutes}m max</span>
                    {selectedAutomation.nextHeartbeatAt ? <span>Next heartbeat {formatTimestamp(selectedAutomation.nextHeartbeatAt)}</span> : null}
                    <span>{selectedAutomation.executionMode === 'planning_only' ? 'Planning only' : 'Scoped execution'}</span>
                    <span>{selectedAutomation.autonomyPolicy}</span>
                    <span>In-app delivery</span>
                    {selectedPreferredAgentLabels.length > 0 ? <span>Team {selectedPreferredAgentLabels.join(', ')}</span> : null}
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

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              <SummaryCard
                label="Status"
                value={formatStatus(selectedAutomation.status)}
                detail={selectedAutomation.brief?.approvedAt ? 'Execution brief approved and reusable' : 'Still moving toward an execution-ready brief'}
                accent
              />
              <SummaryCard
                label="Reliability"
                value={reliability?.value || 'Healthy'}
                detail={reliability?.detail || 'No reliability issues detected.'}
                compact
              />
              <SummaryCard
                label="Next step"
                value={selectedNextAction}
                detail={activeRun ? `Active run: ${activeRun.title}` : latestRun ? latestRunSummary(latestRun) : 'No runs yet'}
                compact
              />
              <SummaryCard
                label="Backlog"
                value={backlog.total > 0 ? `${backlog.completed}/${backlog.total}` : '0'}
                detail={backlog.total > 0
                  ? `${pluralize(backlog.ready + backlog.running, 'ready item')} · ${pluralize(backlog.blocked + backlog.failed, 'blocked item')}`
                  : 'Work items appear after enrichment'}
              />
              <SummaryCard
                label="Run policy"
                value={`${selectedAutomation.runPolicy.dailyRunCap}/day`}
                detail={describeRunPolicy(selectedAutomation, latestRun)}
              />
              <SummaryCard
                label="Delivery"
                value="In-app"
                detail={latestDelivery
                  ? `Latest via ${latestDelivery.provider} on ${formatTimestamp(latestDelivery.createdAt)}`
                  : 'Outputs land in the automation inbox and delivery ledger.'}
                compact
              />
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.1fr_0.9fr]">
              <DetailSection
                title="Execution brief"
                action={selectedAutomation.latestSessionId && onOpenThread ? (
                  <button type="button" onClick={() => onOpenThread(selectedAutomation.latestSessionId!)} className="text-[11px] text-text-muted underline cursor-pointer">
                    Open linked thread
                  </button>
                ) : undefined}
              >
                {selectedAutomation.brief ? (
                  <div className="space-y-4 text-[12px]">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <DetailGroup label="Deliverables" values={selectedAutomation.brief.deliverables} empty="No deliverables specified yet" />
                      <DetailGroup label="Recommended agents" values={selectedAutomation.brief.recommendedAgents} empty="Use standard plan/build routing" />
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <DetailGroup label="Preferred specialists" values={selectedPreferredAgentLabels} empty="No preferred specialist team configured" />
                      <DetailGroup label="Assumptions" values={selectedAutomation.brief.assumptions} />
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <DetailGroup label="Success criteria" values={selectedAutomation.brief.successCriteria} />
                      <div />
                    </div>
                    <DetailGroup label="Missing context" values={selectedAutomation.brief.missingContext} empty="No missing context" />
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Approval boundary</div>
                      <div className="mt-2 text-[12px] leading-6 text-text-secondary">{selectedAutomation.brief.approvalBoundary}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">No execution brief yet. Run Preview brief to enrich this task through the plan agent.</div>
                )}
              </DetailSection>

              <DetailSection title="Inbox">
                <div className="space-y-3">
                  {automationInbox.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No open inbox items.</div>
                  ) : automationInbox.map((item) => (
                    <div key={item.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-text">{item.title}</div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{item.type}</span>
                      </div>
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
              </DetailSection>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <DetailSection title="Backlog">
                <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <SummaryCard label="Total" value={String(backlog.total)} detail="Items in this brief revision" />
                  <SummaryCard label="Completed" value={String(backlog.completed)} detail="Work already finished" />
                  <SummaryCard label="Ready now" value={String(backlog.ready + backlog.running)} detail="Execution-ready or in-flight" />
                  <SummaryCard label="Blocked" value={String(backlog.blocked + backlog.failed)} detail="Waiting on context, review, or recovery" />
                </div>
                <div className="space-y-3">
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
                        {item.blockingReason ? ` · ${item.blockingReason}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </DetailSection>

              <DetailSection title="Run timeline">
                <div className="space-y-3">
                  {automationRuns.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No runs yet.</div>
                  ) : automationRuns.map((run) => (
                    <div key={run.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-text">{run.title}</div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{run.status}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {formatTimestamp(run.createdAt)} · attempt {run.attempt}
                        {run.nextRetryAt ? ` · retrying ${formatTimestamp(run.nextRetryAt)}` : ''}
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
              </DetailSection>
            </div>

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.95fr_1.05fr]">
              <DetailSection title="Deliveries">
                <div className="space-y-3">
                  {automationDeliveries.length === 0 ? (
                    <div className="text-[12px] text-text-muted">No deliveries yet.</div>
                  ) : automationDeliveries.map((delivery) => (
                    <div key={delivery.id} className="rounded-xl border border-border px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[12px] font-medium text-text">{delivery.title}</div>
                        <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{delivery.provider} · {delivery.status}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">{formatTimestamp(delivery.createdAt)} · {delivery.target}</div>
                      <div className="mt-2 text-[12px] text-text-secondary whitespace-pre-wrap">{delivery.body}</div>
                    </div>
                  ))}
                </div>
              </DetailSection>

              <DetailSection title="Quick edits">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
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
                  <input
                    type="number"
                    min={1}
                    value={selectedAutomation.runPolicy.dailyRunCap}
                    onChange={(event) => setSelectedAutomation((current) => current
                      ? {
                        ...current,
                        runPolicy: {
                          ...current.runPolicy,
                          dailyRunCap: Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                        },
                      }
                      : current)}
                    className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent"
                    placeholder={dailyRunAttemptCapPlaceholder()}
                  />
                  <input
                    type="number"
                    min={1}
                    value={selectedAutomation.runPolicy.maxRunDurationMinutes}
                    onChange={(event) => setSelectedAutomation((current) => current
                      ? {
                        ...current,
                        runPolicy: {
                          ...current.runPolicy,
                          maxRunDurationMinutes: Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                        },
                      }
                      : current)}
                    className="rounded-xl border border-border px-3 py-2 text-[13px] bg-transparent"
                    placeholder="Max run duration (min)"
                  />
                </div>
                <div className="mt-4">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">Preferred specialists</div>
                  <div className="mt-2">
                    <AgentTeamSelector
                      options={selectedAgentOptions}
                      value={selectedAutomation.preferredAgentNames}
                      onChange={(preferredAgentNames) => setSelectedAutomation((current) => current ? { ...current, preferredAgentNames } : current)}
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => void patchSelected({
                      title: selectedAutomation.title,
                      goal: selectedAutomation.goal,
                      projectDirectory: selectedAutomation.projectDirectory,
                      preferredAgentNames: selectedAutomation.preferredAgentNames,
                      runPolicy: selectedAutomation.runPolicy,
                    })}
                    className="rounded-xl border border-border px-3 py-2 text-[12px] cursor-pointer"
                  >
                    Save edits
                  </button>
                </div>
              </DetailSection>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
