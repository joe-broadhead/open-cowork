import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EffectiveAppSettings, WorkflowListPayload, WorkflowRun, WorkflowSummary, WorkflowTrigger } from '@open-cowork/shared'
import { formatDate as formatLocalizedDate, t } from '../../helpers/i18n'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { Badge, Button, Card, EmptyState, ErrorState, Icon, Skeleton, StudioPageHeader, entityChroma, toast, type BadgeTone } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'

export type WorkflowNavigationTarget = {
  workflowId: string
  runId?: string | null
  run?: WorkflowRun | null
}

type Props = {
  onOpenThread: (sessionId: string) => void
  initialTarget?: WorkflowNavigationTarget | null
  onInitialTargetHandled?: () => void
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

export function WorkflowsPage({ onOpenThread, initialTarget = null, onInitialTargetHandled }: Props) {
  const [payload, setPayload] = useState<WorkflowListPayload>(EMPTY_PAYLOAD)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WorkflowSummary | null>(null)
  const [webhookRegenerationTarget, setWebhookRegenerationTarget] = useState<WorkflowSummary | null>(null)
  const [highlightedTarget, setHighlightedTarget] = useState<WorkflowNavigationTarget | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [runtimeConfigSource, setRuntimeConfigSource] = useState<EffectiveAppSettings['runtimeConfigSource']>('app')
  const refreshGenerationRef = useRef(0)
  const settingsGenerationRef = useRef(0)
  const workflowCardRefs = useRef(new Map<string, HTMLDivElement>())
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
  const archivedWorkflows = useMemo(
    () => payload.workflows.filter((workflow) => workflow.status === 'archived'),
    [payload.workflows],
  )
  const workflowsForView = showArchived ? archivedWorkflows : activeWorkflows
  const visibleWorkflows = useMemo(() => {
    if (!highlightedTarget) return workflowsForView
    if (workflowsForView.some((workflow) => workflow.id === highlightedTarget.workflowId)) return workflowsForView
    const target = payload.workflows.find((workflow) => workflow.id === highlightedTarget.workflowId)
    return target ? [target, ...workflowsForView] : workflowsForView
  }, [highlightedTarget, payload.workflows, workflowsForView])
  const targetedRun = useMemo(() => {
    const workflowId = highlightedTarget?.workflowId
    const runId = highlightedTarget?.runId
    if (!workflowId || !runId) return null
    const currentRun = payload.runs.find((run) => run.id === runId && run.workflowId === workflowId)
    if (currentRun) return currentRun
    const suppliedRun = highlightedTarget.run
    if (suppliedRun?.id === runId && suppliedRun.workflowId === workflowId) return suppliedRun
    return null
  }, [highlightedTarget, payload.runs])
  const archivedCount = archivedWorkflows.length
  const activeCount = useMemo(
    () => activeWorkflows.filter((workflow) => workflow.status === 'active').length,
    [activeWorkflows],
  )
  const runningCount = useMemo(
    () => activeWorkflows.filter((workflow) => workflow.status === 'running').length,
    [activeWorkflows],
  )
  const initialTargetArchived = useMemo(() => {
    if (!initialTarget) return null
    const targetWorkflow = payload.workflows.find((workflow) => workflow.id === initialTarget.workflowId)
    return targetWorkflow ? targetWorkflow.status === 'archived' : null
  }, [initialTarget, payload.workflows])

  const refresh = useCallback(async (generation = refreshGenerationRef.current + 1) => {
    refreshGenerationRef.current = generation
    const isCurrentRefresh = () => refreshGenerationRef.current === generation
    setLoading(true)
    if (isCurrentRefresh()) setLoadError(null)
    try {
      if (workflowListBlocked) {
        if (isCurrentRefresh()) {
          setPayload(EMPTY_PAYLOAD)
          setLoadError(null)
        }
        return
      }
      const nextPayload = activeWorkspaceIsLocal
        ? await window.coworkApi.workflows.list()
        : await window.coworkApi.workflows.list(workspaceOptions)
      if (isCurrentRefresh()) {
        setPayload(nextPayload)
        setLoadError(null)
      }
    } catch (error) {
      if (isCurrentRefresh()) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (isCurrentRefresh()) setLoading(false)
    }
  }, [activeWorkspaceIsLocal, workflowListBlocked, workspaceOptions])

  useEffect(() => {
    const generation = refreshGenerationRef.current + 1
    refreshGenerationRef.current = generation
    const settingsGeneration = settingsGenerationRef.current + 1
    settingsGenerationRef.current = settingsGeneration
    const isCurrentSettingsRequest = () => settingsGenerationRef.current === settingsGeneration
    void refresh(generation)
    const settingsRequest = activeWorkspaceIsLocal
      ? window.coworkApi.settings.get()
      : window.coworkApi.settings.get(workspaceOptions)
    void settingsRequest.then((settings) => {
      if (isCurrentSettingsRequest()) setRuntimeConfigSource(settings.runtimeConfigSource === 'machine' ? 'machine' : 'app')
    }).catch(() => {
      if (isCurrentSettingsRequest()) setRuntimeConfigSource('app')
    })
    const unsubscribe = window.coworkApi.on.workflowUpdated(() => {
      void refresh()
    })
    return () => {
      refreshGenerationRef.current += 1
      settingsGenerationRef.current += 1
      unsubscribe()
    }
  }, [activeWorkspaceIsLocal, refresh, workspaceOptions])

  useEffect(() => {
    if (!initialTarget || loading) return
    if (loadError && payload.workflows.length === 0) return
    setHighlightedTarget(initialTarget)
    if (initialTargetArchived !== null) setShowArchived(initialTargetArchived)
    onInitialTargetHandled?.()
  }, [initialTarget, initialTargetArchived, loadError, loading, onInitialTargetHandled, payload.workflows.length])

  useEffect(() => {
    if (!highlightedTarget) return
    const frame = window.requestAnimationFrame(() => {
      workflowCardRefs.current.get(highlightedTarget.workflowId)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [highlightedTarget, showArchived])

  const setWorkflowCardRef = useCallback((workflowId: string, node: HTMLDivElement | null) => {
    if (node) {
      workflowCardRefs.current.set(workflowId, node)
      return
    }
    workflowCardRefs.current.delete(workflowId)
  }, [])

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

  const confirmWebhookRegeneration = async () => {
    const target = webhookRegenerationTarget
    setWebhookRegenerationTarget(null)
    if (!target) return
    await runAction(
      target.id,
      () => window.coworkApi.workflows.regenerateWebhookSecret(target.id),
      t('workflows.webhookSecretRegenerated', 'Webhook secret regenerated.'),
    )
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
        {!loading || payload.workflows.length > 0 ? (
          <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t('workflows.viewToggleLabel', 'Playbook views')}>
            <Button
              size="sm"
              variant={showArchived ? 'secondary' : 'primary'}
              aria-pressed={!showArchived}
              onClick={() => {
                setShowArchived(false)
                setHighlightedTarget(null)
              }}
            >
              {t('workflows.activeView', 'Active ({{count}})', { count: activeWorkflows.length })}
            </Button>
            <Button
              size="sm"
              variant={showArchived ? 'primary' : 'secondary'}
              aria-pressed={showArchived}
              onClick={() => {
                setShowArchived(true)
                setHighlightedTarget(null)
              }}
            >
              {t('workflows.archivedView', 'Archived ({{count}})', { count: archivedCount })}
            </Button>
          </div>
        ) : null}
        {loading && payload.workflows.length === 0 ? (
          <div className="grid gap-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} variant="card" className="h-40" />
            ))}
          </div>
        ) : loadError && payload.workflows.length === 0 ? (
          <ErrorState
            title={t('workflows.loadErrorTitle', 'Couldn’t load playbooks')}
            message={t('workflows.loadErrorBody', 'We couldn’t reach the workflow store to list your saved playbooks.')}
            hint={loadError}
            onRetry={() => void refresh()}
            retryLabel={t('workflows.reload', 'Reload')}
          />
        ) : visibleWorkflows.length === 0 ? (
          <EmptyState
            icon="workflow"
            title={showArchived ? t('workflows.emptyArchiveTitle', 'No archived playbooks') : t('workflows.emptyTitle', 'No playbooks yet')}
            body={showArchived
              ? t('workflows.emptyArchiveBody', 'Archived playbooks will appear here until you restore them.')
              : workflowListBlocked && workflowListReason
                ? workflowListReason
                : workflowDraftBlocked
                  ? activeWorkspaceIsLocal
                    ? t('workflows.emptySetupRequiresInApp', 'Playbook setup requires the in-app OpenCode config source because it uses the Workflow Designer agent and Workflows tool.')
                    : t('workflows.emptyCloudManaged', 'Cloud playbook creation is managed by the cloud workspace. Existing playbooks will appear here when available.')
                  : t('workflows.emptyStartChat', 'Start with a setup chat. The Workflow Designer agent will clarify the task, tools, skills, coworker, schedule, and webhook trigger before saving anything.')}
            action={(
              <Button
                variant="primary"
                onClick={showArchived ? () => setShowArchived(false) : () => void startDraft()}
                disabled={!showArchived && workflowDraftBlocked}
                disabledReason={showArchived ? null : !activeWorkspaceIsLocal ? t('workflows.cloudCreationManagedShort', 'Cloud playbook creation is managed by this cloud workspace.') : workflowDraftBlocked ? t('workflows.setupRequiresInApp', 'Playbook setup requires the in-app OpenCode config source.') : null}
              >
                {showArchived ? t('workflows.viewActiveButton', 'View active playbooks') : t('workflows.addButton', 'Add playbook')}
              </Button>
            )}
          />
        ) : (
          <div className="grid gap-4">
            {loadError ? (
              <div role="alert" className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
                <span className="font-semibold">{t('workflows.refreshFailed', 'Couldn’t refresh playbooks.')}</span> {loadError}
                <Button size="sm" variant="ghost" className="ml-2" onClick={() => void refresh()}>
                  {t('workflows.reload', 'Reload')}
                </Button>
              </div>
            ) : null}
            {visibleWorkflows.map((workflow) => {
              const isHighlighted = highlightedTarget?.workflowId === workflow.id
              const isRunTarget = isHighlighted && Boolean(highlightedTarget?.runId)
              const exactRun = isRunTarget ? targetedRun : null
              return (
              <div
                key={workflow.id}
                ref={(node) => setWorkflowCardRef(workflow.id, node)}
                className={`rounded-lg border p-0.5 transition-colors ${isHighlighted ? 'border-accent bg-accent/10' : 'border-transparent bg-transparent'}`}
                data-workflow-id={workflow.id}
                data-workflow-run-id={exactRun?.id}
                data-open-cowork-target={isHighlighted ? 'true' : undefined}
              >
              <Card variant="surface">
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
                    {isHighlighted ? (
                      <div role="status" className="mt-1 text-2xs font-semibold text-accent">
                        {highlightedTarget?.runId
                          ? t('workflows.openedTargetRun', 'Opened run {{runId}}', { runId: highlightedTarget.runId })
                          : t('workflows.openedTargetWorkflow', 'Opened playbook')}
                      </div>
                    ) : null}
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
                    {isRunTarget ? (
                      exactRun?.sessionId ? (
                        <Button size="sm" variant="secondary" onClick={() => onOpenThread(exactRun.sessionId!)}>
                          {t('workflows.openTargetRun', 'Open this run')}
                        </Button>
                      ) : null
                    ) : workflow.latestRunSessionId ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenThread(workflow.latestRunSessionId!)}>
                        {t('workflows.openLatestRun', 'Open latest run')}
                      </Button>
                    ) : null}
                    {workflow.status === 'archived' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busyId === workflow.id}
                        disabledReason={workflowActionBlocked ? workflowActionReason : null}
                        onClick={() => void runAction(workflow.id, () => (
                          activeWorkspaceIsLocal
                            ? window.coworkApi.workflows.resume(workflow.id)
                            : window.coworkApi.workflows.resume(workflow.id, workspaceOptions)
                        ), t('workflows.restored', 'Playbook restored.'))}
                      >
                        {t('workflows.restoreButton', 'Restore')}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busyId === workflow.id || workflow.status === 'running' || workflow.status === 'paused'}
                          disabledReason={workflowActionBlocked
                            ? workflowActionReason
                            : workflow.status === 'paused'
                              ? t('workflows.resumeBeforeRunning', 'Resume this playbook before running it.')
                              : null}
                          onClick={() => void runAction(workflow.id, () => (
                            activeWorkspaceIsLocal
                              ? window.coworkApi.workflows.runNow(workflow.id)
                              : window.coworkApi.workflows.runNow(workflow.id, workspaceOptions)
                          ), t('workflows.runStarted', 'Playbook run started.'))}
                        >
                          {t('workflows.runButton', 'Run')}
                        </Button>
                        {workflow.status === 'paused' ? (
                          <Button size="sm" variant="secondary" disabled={busyId === workflow.id} disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                            activeWorkspaceIsLocal
                              ? window.coworkApi.workflows.resume(workflow.id)
                              : window.coworkApi.workflows.resume(workflow.id, workspaceOptions)
                          ), t('workflows.resumed', 'Playbook resumed.'))}>
                            {t('workflows.resumeButton', 'Resume')}
                          </Button>
                        ) : (
                          <Button size="sm" variant="secondary" disabled={busyId === workflow.id} disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
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
                      </>
                    )}
                  </div>
                </div>

                <ol className="mt-4 grid gap-2 md:grid-cols-3" aria-label={t('workflows.stepsAriaLabel', '{{title}} steps', { title: workflow.title })}>
                  {workflow.steps.map((step, index) => (
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
                  {isRunTarget ? (
                    <div className="rounded-md border border-accent/40 bg-accent/10 p-3" aria-label={t('workflows.targetRunAriaLabel', 'Targeted run {{runId}}', { runId: highlightedTarget?.runId || '' })}>
                      <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('workflows.targetRun', 'Targeted run')}</div>
                      <div className="mt-1">
                        <Badge tone={runStatusTone(exactRun?.status)} className="capitalize">
                          {exactRun?.status || t('workflows.runDetailsUnavailable', 'Details unavailable')}
                        </Badge>
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-text-muted">
                        {exactRun
                          ? exactRun.summary || exactRun.error || t('workflows.runDate', 'Run created: {{date}}', { date: formatWorkflowDate(exactRun.createdAt) })
                          : t('workflows.exactRunUnavailable', 'Run {{runId}} is not available in the current playbook data.', { runId: highlightedTarget?.runId || '' })}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border border-border-subtle bg-elevated p-3">
                      <div className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{t('workflows.latestRun', 'Latest run')}</div>
                      <div className="mt-1">
                        <Badge tone={runStatusTone(workflow.latestRunStatus)} className="capitalize">
                          {workflow.latestRunStatus || t('workflows.noRunsYet', 'No runs yet')}
                        </Badge>
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-text-muted">{workflow.latestRunSummary || t('workflows.lastRunDate', 'Last run: {{date}}', { date: formatWorkflowDate(workflow.lastRunAt) })}</div>
                    </div>
                  )}
                </div>

                {workflow.webhookUrl ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-elevated p-3">
                    <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">{workflow.webhookUrl}</code>
                    <Button size="sm" variant="secondary" onClick={() => void copyWebhook(workflow)}>
                      {t('workflows.copyCurl', 'Copy curl')}
                    </Button>
                    {activeWorkspaceIsLocal && workflow.status !== 'archived' ? (
                      <Button size="sm" variant="secondary" disabled={busyId === workflow.id} onClick={() => setWebhookRegenerationTarget(workflow)}>
                        {t('workflows.regenerate', 'Regenerate')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </Card>
              </div>
              )
            })}
          </div>
        )}
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
      <ConfirmDialog
        open={Boolean(webhookRegenerationTarget)}
        title={t('workflows.webhookRegenerateConfirmTitle', 'Regenerate this webhook secret?')}
        body={webhookRegenerationTarget
          ? t('workflows.webhookRegenerateConfirmBody', 'Regenerating the webhook secret for “{{title}}” immediately invalidates the current secret. Existing callers will stop working until they use the new secret.', { title: webhookRegenerationTarget.title })
          : undefined}
        confirmLabel={t('workflows.webhookRegenerateConfirmAction', 'Regenerate secret')}
        cancelLabel={t('workflows.webhookRegenerateConfirmCancel', 'Keep current secret')}
        tone="danger"
        onConfirm={confirmWebhookRegeneration}
        onCancel={() => setWebhookRegenerationTarget(null)}
      />
    </div>
  )
}
