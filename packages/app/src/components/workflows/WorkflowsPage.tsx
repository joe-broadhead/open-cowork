import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EffectiveAppSettings, WorkflowListPayload, WorkflowRun, WorkflowSummary, WorkflowTrigger } from '@open-cowork/shared'
import { formatDate as formatLocalizedDate, t } from '../../helpers/i18n'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { Badge, Button, Card, EmptyState, Icon, Skeleton, StudioPageHeader, entityChroma, toast, type BadgeTone } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'

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

function runStatusTone(status?: WorkflowRun['status'] | null): BadgeTone {
  if (status === 'completed') return 'success'
  if (status === 'running' || status === 'queued') return 'info'
  if (status === 'failed') return 'danger'
  return 'muted'
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
  const [busyId, setBusyId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WorkflowSummary | null>(null)
  const [runtimeConfigSource, setRuntimeConfigSource] = useState<EffectiveAppSettings['runtimeConfigSource']>('app')
  const refreshGenerationRef = useRef(0)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = useMemo(
    () => (activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId }),
    [activeWorkspaceIsLocal, workspaceSupport.workspaceId],
  )
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

  const refresh = useCallback(async (generation = refreshGenerationRef.current + 1) => {
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
  }, [activeWorkspaceIsLocal, workflowListBlocked, workspaceOptions])

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
  }, [activeWorkspaceIsLocal, refresh, workspaceOptions])
  const workflowDraftBlocked = !activeWorkspaceIsLocal || runtimeConfigSource === 'machine'
  const workflowActionBlocked = !workspaceSupport.flags.canRunWorkflow
  const workflowActionReason = workflowActionBlocked ? workspaceSupport.flags.reasons.runWorkflow : null

  const runAction = async (workflowId: string, action: () => Promise<unknown>, message: string) => {
    setBusyId(workflowId)
    try {
      if (workflowActionBlocked) {
        toast({ tone: 'warning', message: workflowActionReason || t('workflows.runsDisabledPolicy', 'Playbook runs are disabled by this workspace policy.') })
        return
      }
      const result = await action()
      toast({ tone: 'success', message })
      if (result && typeof result === 'object' && 'sessionId' in result) {
        const sessionId = (result as { sessionId?: unknown }).sessionId
        if (typeof sessionId === 'string' && sessionId) onOpenThread(sessionId)
      }
      await refresh()
    } catch (error) {
      toast({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }

  const startDraft = async () => {
    if (!activeWorkspaceIsLocal) {
      toast({ tone: 'warning', message: t('workflows.cloudCreationManaged', 'Cloud playbook creation is managed by the cloud workspace. Existing cloud playbooks can be run when policy allows it.') })
      return
    }
    if (workflowDraftBlocked) {
      toast({ tone: 'warning', message: t('workflows.switchConfigInApp', 'Switch OpenCode config source to In app before adding playbooks. Setup still uses Cowork’s Workflow Designer agent and Workflows tool.') })
      return
    }
    setBusyId('new')
    try {
      const session = await window.coworkApi.workflows.startDraft()
      onOpenThread(session.id)
      await refresh()
    } catch (error) {
      toast({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }

  const archiveWorkflow = (workflow: WorkflowSummary) => runAction(workflow.id, () => (
    activeWorkspaceIsLocal
      ? window.coworkApi.workflows.archive(workflow.id)
      : window.coworkApi.workflows.archive(workflow.id, workspaceOptions)
  ), t('workflows.archived', 'Playbook archived.'))

  const confirmArchive = async () => {
    const target = archiveTarget
    setArchiveTarget(null)
    if (!target) return
    await archiveWorkflow(target)
  }

  const copyWebhook = async (workflow: WorkflowSummary) => {
    const command = webhookCurlCommand(workflow)
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      toast({ tone: 'success', message: command === workflow.webhookUrl ? t('workflows.webhookUrlCopied', 'Webhook URL copied.') : t('workflows.webhookCurlCopied', 'Webhook curl copied.') })
    } catch {
      toast({ tone: 'error', message: t('workflows.webhookCopyFailed', 'Could not copy the webhook command. Copy it manually: {{command}}', { command }) })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-text">
      <div className="border-b border-border-subtle px-6 py-5">
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
              <Card key={workflow.id} variant="surface">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div
                      className="entity-tile h-9 w-9 rounded-lg"
                      style={{ '--entity-chroma': entityChroma(workflow.id || workflow.title) } as React.CSSProperties}
                      aria-hidden="true"
                    >
                      <Icon name="workflow" size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 font-display text-role-card-title font-bold text-text">{workflow.title}</h2>
                      <Badge tone={statusTone(workflow.status)} className="capitalize">
                        {workflow.status}
                      </Badge>
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-text-secondary">{workflow.instructions}</p>
                    <div className="mt-3 text-xs font-medium text-text-muted">
                      {t('workflows.runsAs', 'Runs as')} {workflow.agentName || 'build'} <span aria-hidden="true">·</span> {t('workflows.lastRun', 'last run')} {workflowLastRunLabel(workflow)}
                    </div>
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
                    <Button size="sm" variant="danger" disabled={busyId === workflow.id} disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => setArchiveTarget(workflow)}>
                      {t('workflows.archiveButton', 'Archive')}
                    </Button>
                  </div>
                </div>

                <ol className="mt-4 grid gap-2 md:grid-cols-3" aria-label={t('workflows.stepsAriaLabel', '{{title}} steps', { title: workflow.title })}>
                  {workflowDisplaySteps(workflow).map((step, index) => (
                    <li key={step.id || index} className="flex min-w-0 gap-3 rounded-md border border-border-subtle bg-elevated p-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-surface-active text-xs font-bold text-text-secondary">
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-text">{step.title}</span>
                        {step.detail ? <span className="mt-1 block line-clamp-2 text-xs leading-5 text-text-muted">{step.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-border-subtle bg-elevated p-3">
                    <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('workflows.leadCoworker', 'Lead coworker')}</div>
                    <div className="mt-1 text-sm text-text">{workflow.agentName || 'build'}</div>
                    <div className="mt-1 text-xs text-text-muted">
                      {[...workflow.skillNames, ...workflow.toolIds].slice(0, 4).join(', ') || t('workflows.usesSelectedTools', 'Uses selected tools and skills from the setup chat')}
                    </div>
                  </div>
                  <div className="rounded-md border border-border-subtle bg-elevated p-3">
                    <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('workflows.triggers', 'Triggers')}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {workflow.triggers.map((trigger) => (
                        <Badge key={trigger.id} tone="muted">
                          {triggerLabel(trigger)}
                        </Badge>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-text-muted">{t('workflows.next', 'Next:')} {formatWorkflowDate(workflow.nextRunAt)}</div>
                  </div>
                  <div className="rounded-md border border-border-subtle bg-elevated p-3">
                    <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('workflows.latestRun', 'Latest run')}</div>
                    <div className="mt-1">
                      <Badge tone={runStatusTone(workflow.latestRunStatus)} className="capitalize">
                        {workflow.latestRunStatus || t('workflows.noRunsYet', 'No runs yet')}
                      </Badge>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-text-muted">{workflow.latestRunSummary || t('workflows.lastRunDate', 'Last run: {{date}}', { date: formatWorkflowDate(workflow.lastRunAt) })}</div>
                  </div>
                </div>

                {workflow.webhookUrl ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-elevated p-3">
                    <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">{workflow.webhookUrl}</code>
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
              </Card>
            ))}
          </div>
        )}
        {archivedCount > 0 ? (
          <div className="mt-4 text-xs text-text-muted">{t('workflows.archivedHidden', '{{count}} archived playbook{{plural}} hidden.', { count: archivedCount, plural: archivedCount === 1 ? '' : 's' })}</div>
        ) : null}
      </div>
      <ConfirmDialog
        open={Boolean(archiveTarget)}
        title={t('workflows.archiveConfirmTitle', 'Archive this playbook?')}
        body={archiveTarget
          ? t('workflows.archiveConfirmBody', 'Archiving “{{title}}” stops its schedules and webhook triggers and hides it from the active list. You can recover it later from the archive.', { title: archiveTarget.title })
          : undefined}
        confirmLabel={t('workflows.archiveButton', 'Archive')}
        cancelLabel={t('workflows.archiveConfirmCancel', 'Cancel')}
        tone="danger"
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  )
}
