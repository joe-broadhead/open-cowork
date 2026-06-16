import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffectiveAppSettings, WorkflowListPayload, WorkflowRun, WorkflowSummary, WorkflowTrigger } from '@open-cowork/shared'
import { formatDate as formatLocalizedDate, t } from '../../helpers/i18n'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { Badge, Button, EmptyState, Skeleton, StudioPageHeader, type BadgeTone } from '../ui'

type Props = {
  onOpenThread: (sessionId: string) => void
}

const EMPTY_PAYLOAD: WorkflowListPayload = { workflows: [], runs: [] }

function formatWorkflowDate(value?: string | null) {
  if (!value) return t('workflows.notScheduled', 'Not scheduled')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return formatLocalizedDate(date, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function triggerLabel(trigger: WorkflowTrigger) {
  if (!trigger.enabled) return t('workflows.triggerDisabled', '{{type}} disabled', { type: trigger.type })
  if (trigger.type === 'manual') return t('workflows.triggerManual', 'Manual')
  if (trigger.type === 'webhook') return t('workflows.triggerWebhook', 'Webhook')
  const schedule = trigger.schedule
  if (!schedule) return t('workflows.triggerSchedule', 'Schedule')
  if (schedule.type === 'one_time') return t('workflows.triggerOnce', 'Once {{date}}', { date: formatWorkflowDate(schedule.startAt) })
  const minute = String(schedule.runAtMinute ?? 0).padStart(2, '0')
  const time = `${String(schedule.runAtHour ?? 9).padStart(2, '0')}:${minute}`
  if (schedule.type === 'daily') return t('workflows.triggerDaily', 'Daily at {{time}}', { time })
  if (schedule.type === 'weekly') return t('workflows.triggerWeekly', 'Weekly at {{time}}', { time })
  return t('workflows.triggerMonthly', 'Monthly at {{time}}', { time })
}

function statusTone(status: WorkflowSummary['status']): BadgeTone {
  if (status === 'active') return 'success'
  if (status === 'running') return 'accent'
  if (status === 'failed') return 'danger'
  if (status === 'paused') return 'warning'
  return 'neutral'
}

function runStatusTone(status?: WorkflowRun['status'] | null) {
  if (status === 'completed') return 'text-emerald-300'
  if (status === 'running' || status === 'queued') return 'text-sky-300'
  if (status === 'failed') return 'text-red-300'
  return 'text-muted'
}

function workflowLastRunLabel(workflow: WorkflowSummary) {
  if (workflow.lastRunAt) return formatWorkflowDate(workflow.lastRunAt)
  if (workflow.latestRunStatus) return workflow.latestRunStatus
  return t('workflows.lastRunNever', 'never')
}

function workflowDisplaySteps(workflow: WorkflowSummary) {
  return workflow.steps?.length
    ? workflow.steps
    : [{ id: 'step-1', title: t('workflows.defaultStepTitle', 'Run saved instructions'), detail: workflow.instructions || null }]
}

function activeWebhookSecret(workflow: WorkflowSummary) {
  return workflow.triggers.find((trigger) => (
    trigger.enabled
    && trigger.type === 'webhook'
    && typeof trigger.webhookSecret === 'string'
    && trigger.webhookSecret.length > 0
  ))?.webhookSecret || null
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function webhookCurlCommand(workflow: WorkflowSummary) {
  if (!workflow.webhookUrl) return null
  const secret = activeWebhookSecret(workflow)
  if (!secret) return workflow.webhookUrl
  return [
    `curl -X POST ${shellSingleQuote(workflow.webhookUrl)}`,
    `  -H ${shellSingleQuote('content-type: application/json')}`,
    `  -H ${shellSingleQuote(`Authorization: Bearer ${secret}`)}`,
    `  --data ${shellSingleQuote('{"source":"manual"}')}`,
  ].join(' \\\n')
}

export function WorkflowsPage({ onOpenThread }: Props) {
  const [payload, setPayload] = useState<WorkflowListPayload>(EMPTY_PAYLOAD)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [runtimeConfigSource, setRuntimeConfigSource] = useState<EffectiveAppSettings['runtimeConfigSource']>('app')
  const refreshGenerationRef = useRef(0)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId }
  const workflowListBlocked = !workspaceSupport.flags.canListWorkflows
  const workflowListReason = workflowListBlocked ? workspaceSupport.flags.reasons.listWorkflows : null

  const activeWorkflows = useMemo(
    () => payload.workflows.filter((workflow) => workflow.status !== 'archived'),
    [payload.workflows],
  )
  const archivedCount = payload.workflows.length - activeWorkflows.length
  const activeCount = useMemo(
    () => activeWorkflows.filter((workflow) => workflow.status === 'active').length,
    [activeWorkflows],
  )
  const runningCount = useMemo(
    () => activeWorkflows.filter((workflow) => workflow.status === 'running').length,
    [activeWorkflows],
  )

  const refresh = async (generation = refreshGenerationRef.current + 1) => {
    refreshGenerationRef.current = generation
    const isCurrentRefresh = () => refreshGenerationRef.current === generation
    setLoading(true)
    try {
      if (workflowListBlocked) {
        if (isCurrentRefresh()) setPayload(EMPTY_PAYLOAD)
        return
      }
      const nextPayload = activeWorkspaceIsLocal
        ? await window.coworkApi.workflows.list()
        : await window.coworkApi.workflows.list(workspaceOptions)
      if (isCurrentRefresh()) setPayload(nextPayload)
    } finally {
      if (isCurrentRefresh()) setLoading(false)
    }
  }

  useEffect(() => {
    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    const isCurrentRefresh = () => refreshGenerationRef.current === generation
    void refresh(generation)
    const settingsRequest = activeWorkspaceIsLocal
      ? window.coworkApi.settings.get()
      : window.coworkApi.settings.get(workspaceOptions)
    void settingsRequest.then((settings) => {
      if (isCurrentRefresh()) setRuntimeConfigSource(settings.runtimeConfigSource === 'machine' ? 'machine' : 'app')
    }).catch(() => {
      if (isCurrentRefresh()) setRuntimeConfigSource('app')
    })
    const unsubscribe = window.coworkApi.on.workflowUpdated(() => {
      void refresh()
    })
    return () => {
      refreshGenerationRef.current += 1
      unsubscribe()
    }
  }, [workflowListBlocked, workspaceOptions?.workspaceId])
  const workflowDraftBlocked = !activeWorkspaceIsLocal || runtimeConfigSource === 'machine'
  const workflowActionBlocked = !workspaceSupport.flags.canRunWorkflow
  const workflowActionReason = workflowActionBlocked ? workspaceSupport.flags.reasons.runWorkflow : null

  const runAction = async (workflowId: string, action: () => Promise<unknown>, message: string) => {
    setBusyId(workflowId)
    setFeedback(null)
    try {
      if (workflowActionBlocked) {
        setFeedback(workflowActionReason || t('workflows.runsDisabledPolicy', 'Playbook runs are disabled by this workspace policy.'))
        return
      }
      const result = await action()
      setFeedback(message)
      if (result && typeof result === 'object' && 'sessionId' in result) {
        const sessionId = (result as { sessionId?: unknown }).sessionId
        if (typeof sessionId === 'string' && sessionId) onOpenThread(sessionId)
      }
      await refresh()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const startDraft = async () => {
    if (!activeWorkspaceIsLocal) {
      setFeedback(t('workflows.cloudCreationManaged', 'Cloud playbook creation is managed by the cloud workspace. Existing cloud playbooks can be run when policy allows it.'))
      return
    }
    if (workflowDraftBlocked) {
      setFeedback(t('workflows.switchConfigInApp', 'Switch OpenCode config source to In app before adding playbooks. Setup still uses Cowork’s Workflow Designer agent and Workflows tool.'))
      return
    }
    setBusyId('new')
    setFeedback(null)
    try {
      const session = await window.coworkApi.workflows.startDraft()
      onOpenThread(session.id)
      await refresh()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const copyWebhook = async (workflow: WorkflowSummary) => {
    const command = webhookCurlCommand(workflow)
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setFeedback(command === workflow.webhookUrl ? t('workflows.webhookUrlCopied', 'Webhook URL copied.') : t('workflows.webhookCurlCopied', 'Webhook curl copied.'))
    } catch {
      setFeedback(command)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-primary">
      <div className="border-b border-border px-6 py-5">
        <StudioPageHeader
          eyebrow={t('workflows.eyebrow', 'Playbooks')}
          title={t('workflows.title', 'Playbooks')}
          description={t('workflows.description', 'Save repeatable work from a Workflow Designer setup chat, then run it manually, on a schedule, or from a webhook.')}
          meta={(
            <div className="flex flex-wrap gap-2 text-2xs text-text-muted">
              <span>{t('workflows.metaActive', '{{count}} active', { count: activeCount })}</span>
              <span>{t('workflows.metaRunning', '{{count}} running', { count: runningCount })}</span>
              {archivedCount > 0 ? <span>{t('workflows.metaArchived', '{{count}} archived', { count: archivedCount })}</span> : null}
            </div>
          )}
          actions={[{
            id: 'add-playbook',
            children: busyId === 'new' ? t('workflows.startingButton', 'Starting...') : t('workflows.addButton', 'Add playbook'),
            onClick: () => void startDraft(),
            variant: 'primary',
            leftIcon: 'plus',
            disabled: busyId === 'new' || workflowDraftBlocked,
            disabledReason: !activeWorkspaceIsLocal ? t('workflows.cloudCreationManagedShort', 'Cloud playbook creation is managed by this cloud workspace.') : workflowDraftBlocked ? t('workflows.setupRequiresInApp', 'Playbook setup requires the in-app OpenCode config source.') : null,
          }]}
        />
        {feedback ? (
          <div className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-secondary">
            {feedback}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {loading && payload.workflows.length === 0 ? (
          <div className="grid gap-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} variant="card" className="h-40" />
            ))}
          </div>
        ) : activeWorkflows.length === 0 ? (
          <EmptyState
            icon="workflow"
            title={t('workflows.emptyTitle', 'No playbooks yet')}
            body={workflowListBlocked && workflowListReason
              ? workflowListReason
              : workflowDraftBlocked
                ? activeWorkspaceIsLocal
                  ? t('workflows.emptySetupRequiresInApp', 'Playbook setup requires the in-app OpenCode config source because it uses the Workflow Designer agent and Workflows tool.')
                  : t('workflows.emptyCloudManaged', 'Cloud playbook creation is managed by the cloud workspace. Existing playbooks will appear here when available.')
                : t('workflows.emptyStartChat', 'Start with a setup chat. The Workflow Designer agent will clarify the task, tools, skills, coworker, schedule, and webhook trigger before saving anything.')}
            action={(
              <Button
                variant="primary"
                onClick={() => void startDraft()}
                disabled={workflowDraftBlocked}
                disabledReason={!activeWorkspaceIsLocal ? t('workflows.cloudCreationManagedShort', 'Cloud playbook creation is managed by this cloud workspace.') : workflowDraftBlocked ? t('workflows.setupRequiresInApp', 'Playbook setup requires the in-app OpenCode config source.') : null}
              >
                {t('workflows.addButton', 'Add playbook')}
              </Button>
            )}
          />
        ) : (
          <div className="grid gap-4">
            {activeWorkflows.map((workflow) => (
              <article key={workflow.id} className="rounded-lg border border-border bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 font-display text-role-card-title font-bold text-primary">{workflow.title}</h2>
                      <Badge tone={statusTone(workflow.status)} className="uppercase">
                        {workflow.status}
                      </Badge>
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-secondary">{workflow.instructions}</p>
                    <div className="mt-3 text-xs font-medium text-muted">
                      {t('workflows.runsAs', 'Runs as')} {workflow.agentName || 'build'} <span aria-hidden="true">·</span> {t('workflows.lastRun', 'last run')} {workflowLastRunLabel(workflow)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {workflow.draftSessionId ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenThread(workflow.draftSessionId!)}>
                        {t('workflows.openSetupChat', 'Open setup chat')}
                      </Button>
                    ) : null}
                    {workflow.latestRunSessionId ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenThread(workflow.latestRunSessionId!)}>
                        {t('workflows.openLatestRun', 'Open latest run')}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === workflow.id || workflow.status === 'running'}
                      disabledReason={workflowActionBlocked ? workflowActionReason : null}
                      onClick={() => void runAction(workflow.id, () => (
                        activeWorkspaceIsLocal
                          ? window.coworkApi.workflows.runNow(workflow.id)
                          : window.coworkApi.workflows.runNow(workflow.id, workspaceOptions)
                      ), t('workflows.runStarted', 'Playbook run started.'))}
                    >
                      {t('workflows.runButton', 'Run')}
                    </Button>
                    {workflow.status === 'paused' ? (
                      <Button size="sm" variant="secondary" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                        activeWorkspaceIsLocal
                          ? window.coworkApi.workflows.resume(workflow.id)
                          : window.coworkApi.workflows.resume(workflow.id, workspaceOptions)
                      ), t('workflows.resumed', 'Playbook resumed.'))}>
                        {t('workflows.resumeButton', 'Resume')}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                        activeWorkspaceIsLocal
                          ? window.coworkApi.workflows.pause(workflow.id)
                          : window.coworkApi.workflows.pause(workflow.id, workspaceOptions)
                      ), t('workflows.paused', 'Playbook paused.'))}>
                        {t('workflows.pauseButton', 'Pause')}
                      </Button>
                    )}
                    <Button size="sm" variant="danger" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                      activeWorkspaceIsLocal
                        ? window.coworkApi.workflows.archive(workflow.id)
                        : window.coworkApi.workflows.archive(workflow.id, workspaceOptions)
                    ), t('workflows.archived', 'Playbook archived.'))}>
                      {t('workflows.archiveButton', 'Archive')}
                    </Button>
                  </div>
                </div>

                <ol className="mt-4 grid gap-2 md:grid-cols-3" aria-label={t('workflows.stepsAriaLabel', '{{title}} steps', { title: workflow.title })}>
                  {workflowDisplaySteps(workflow).map((step, index) => (
                    <li key={step.id || index} className="flex min-w-0 gap-3 rounded-md border border-border bg-base/40 p-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-accent/40 bg-accent/15 text-xs font-bold text-accent">
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-primary">{step.title}</span>
                        {step.detail ? <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted">{step.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('workflows.leadCoworker', 'Lead coworker')}</div>
                    <div className="mt-1 text-sm text-primary">{workflow.agentName || 'build'}</div>
                    <div className="mt-1 text-xs text-muted">
                      {[...workflow.skillNames, ...workflow.toolIds].slice(0, 4).join(', ') || t('workflows.usesSelectedTools', 'Uses selected tools and skills from the setup chat')}
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('workflows.triggers', 'Triggers')}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {workflow.triggers.map((trigger) => (
                        <span key={trigger.id} className="rounded border border-border bg-muted px-2 py-0.5 text-xs text-secondary">
                          {triggerLabel(trigger)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted">{t('workflows.next', 'Next:')} {formatWorkflowDate(workflow.nextRunAt)}</div>
                  </div>
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('workflows.latestRun', 'Latest run')}</div>
                    <div className={`mt-1 text-sm ${runStatusTone(workflow.latestRunStatus)}`}>
                      {workflow.latestRunStatus || t('workflows.noRunsYet', 'No runs yet')}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted">{workflow.latestRunSummary || t('workflows.lastRunDate', 'Last run: {{date}}', { date: formatWorkflowDate(workflow.lastRunAt) })}</div>
                  </div>
                </div>

                {workflow.webhookUrl ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-base/40 p-3">
                    <code className="min-w-0 flex-1 truncate text-xs text-secondary">{workflow.webhookUrl}</code>
                    <Button size="sm" variant="secondary" onClick={() => void copyWebhook(workflow)}>
                      {t('workflows.copyCurl', 'Copy curl')}
                    </Button>
                    {activeWorkspaceIsLocal ? (
                      <Button size="sm" variant="secondary" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.regenerateWebhookSecret(workflow.id), t('workflows.webhookSecretRegenerated', 'Webhook secret regenerated.'))}>
                        {t('workflows.regenerate', 'Regenerate')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {archivedCount > 0 ? (
          <div className="mt-4 text-xs text-muted">{t('workflows.archivedHidden', '{{count}} archived playbook{{plural}} hidden.', { count: archivedCount, plural: archivedCount === 1 ? '' : 's' })}</div>
        ) : null}
      </div>
    </div>
  )
}
