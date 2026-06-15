import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffectiveAppSettings, WorkflowListPayload, WorkflowRun, WorkflowSummary, WorkflowTrigger } from '@open-cowork/shared'
import { formatDate as formatLocalizedDate } from '../../helpers/i18n'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { Badge, Button, EmptyState, Skeleton, StudioPageHeader, type BadgeTone } from '../ui'

type Props = {
  onOpenThread: (sessionId: string) => void
}

const EMPTY_PAYLOAD: WorkflowListPayload = { workflows: [], runs: [] }

function formatWorkflowDate(value?: string | null) {
  if (!value) return 'Not scheduled'
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
  if (!trigger.enabled) return `${trigger.type} disabled`
  if (trigger.type === 'manual') return 'Manual'
  if (trigger.type === 'webhook') return 'Webhook'
  const schedule = trigger.schedule
  if (!schedule) return 'Schedule'
  if (schedule.type === 'one_time') return `Once ${formatWorkflowDate(schedule.startAt)}`
  const minute = String(schedule.runAtMinute ?? 0).padStart(2, '0')
  const time = `${String(schedule.runAtHour ?? 9).padStart(2, '0')}:${minute}`
  if (schedule.type === 'daily') return `Daily at ${time}`
  if (schedule.type === 'weekly') return `Weekly at ${time}`
  return `Monthly at ${time}`
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
  return 'never'
}

function workflowDisplaySteps(workflow: WorkflowSummary) {
  return workflow.steps?.length
    ? workflow.steps
    : [{ id: 'step-1', title: 'Run saved instructions', detail: workflow.instructions || null }]
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
        setFeedback(workflowActionReason || 'Playbook runs are disabled by this workspace policy.')
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
      setFeedback('Cloud playbook creation is managed by the cloud workspace. Existing cloud playbooks can be run when policy allows it.')
      return
    }
    if (workflowDraftBlocked) {
      setFeedback('Switch OpenCode config source to In app before adding playbooks. Setup still uses Cowork’s Workflow Designer agent and Workflows tool.')
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
      setFeedback(command === workflow.webhookUrl ? 'Webhook URL copied.' : 'Webhook curl copied.')
    } catch {
      setFeedback(command)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-primary">
      <div className="border-b border-border px-6 py-5">
        <StudioPageHeader
          eyebrow="Playbooks"
          title="Playbooks"
          description="Save repeatable work from a Workflow Designer setup chat, then run it manually, on a schedule, or from a webhook."
          meta={(
            <div className="flex flex-wrap gap-2 text-2xs text-text-muted">
              <span>{activeCount} active</span>
              <span>{runningCount} running</span>
              {archivedCount > 0 ? <span>{archivedCount} archived</span> : null}
            </div>
          )}
          actions={[{
            id: 'add-playbook',
            children: busyId === 'new' ? 'Starting...' : 'Add playbook',
            onClick: () => void startDraft(),
            variant: 'primary',
            leftIcon: 'plus',
            disabled: busyId === 'new' || workflowDraftBlocked,
            disabledReason: !activeWorkspaceIsLocal ? 'Cloud playbook creation is managed by this cloud workspace.' : workflowDraftBlocked ? 'Playbook setup requires the in-app OpenCode config source.' : null,
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
            title="No playbooks yet"
            body={workflowListBlocked && workflowListReason
              ? workflowListReason
              : workflowDraftBlocked
                ? activeWorkspaceIsLocal
                  ? 'Playbook setup requires the in-app OpenCode config source because it uses the Workflow Designer agent and Workflows tool.'
                  : 'Cloud playbook creation is managed by the cloud workspace. Existing playbooks will appear here when available.'
                : 'Start with a setup chat. The Workflow Designer agent will clarify the task, tools, skills, coworker, schedule, and webhook trigger before saving anything.'}
            action={(
              <Button
                variant="primary"
                onClick={() => void startDraft()}
                disabled={workflowDraftBlocked}
                disabledReason={!activeWorkspaceIsLocal ? 'Cloud playbook creation is managed by this cloud workspace.' : workflowDraftBlocked ? 'Playbook setup requires the in-app OpenCode config source.' : null}
              >
                Add playbook
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
                      Runs as {workflow.agentName || 'build'} <span aria-hidden="true">·</span> last run {workflowLastRunLabel(workflow)}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {workflow.draftSessionId ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenThread(workflow.draftSessionId!)}>
                        Open setup chat
                      </Button>
                    ) : null}
                    {workflow.latestRunSessionId ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenThread(workflow.latestRunSessionId!)}>
                        Open latest run
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
                      ), 'Playbook run started.')}
                    >
                      Run
                    </Button>
                    {workflow.status === 'paused' ? (
                      <Button size="sm" variant="secondary" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                        activeWorkspaceIsLocal
                          ? window.coworkApi.workflows.resume(workflow.id)
                          : window.coworkApi.workflows.resume(workflow.id, workspaceOptions)
                      ), 'Playbook resumed.')}>
                        Resume
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                        activeWorkspaceIsLocal
                          ? window.coworkApi.workflows.pause(workflow.id)
                          : window.coworkApi.workflows.pause(workflow.id, workspaceOptions)
                      ), 'Playbook paused.')}>
                        Pause
                      </Button>
                    )}
                    <Button size="sm" variant="danger" disabledReason={workflowActionBlocked ? workflowActionReason : null} onClick={() => void runAction(workflow.id, () => (
                      activeWorkspaceIsLocal
                        ? window.coworkApi.workflows.archive(workflow.id)
                        : window.coworkApi.workflows.archive(workflow.id, workspaceOptions)
                    ), 'Playbook archived.')}>
                      Archive
                    </Button>
                  </div>
                </div>

                <ol className="mt-4 grid gap-2 md:grid-cols-3" aria-label={`${workflow.title} steps`}>
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
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Lead coworker</div>
                    <div className="mt-1 text-sm text-primary">{workflow.agentName || 'build'}</div>
                    <div className="mt-1 text-xs text-muted">
                      {[...workflow.skillNames, ...workflow.toolIds].slice(0, 4).join(', ') || 'Uses selected tools and skills from the setup chat'}
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Triggers</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {workflow.triggers.map((trigger) => (
                        <span key={trigger.id} className="rounded border border-border bg-muted px-2 py-0.5 text-xs text-secondary">
                          {triggerLabel(trigger)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted">Next: {formatWorkflowDate(workflow.nextRunAt)}</div>
                  </div>
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Latest run</div>
                    <div className={`mt-1 text-sm ${runStatusTone(workflow.latestRunStatus)}`}>
                      {workflow.latestRunStatus || 'No runs yet'}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted">{workflow.latestRunSummary || `Last run: ${formatWorkflowDate(workflow.lastRunAt)}`}</div>
                  </div>
                </div>

                {workflow.webhookUrl ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-base/40 p-3">
                    <code className="min-w-0 flex-1 truncate text-xs text-secondary">{workflow.webhookUrl}</code>
                    <Button size="sm" variant="secondary" onClick={() => void copyWebhook(workflow)}>
                      Copy curl
                    </Button>
                    {activeWorkspaceIsLocal ? (
                      <Button size="sm" variant="secondary" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.regenerateWebhookSecret(workflow.id), 'Webhook secret regenerated.')}>
                        Regenerate
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {archivedCount > 0 ? (
          <div className="mt-4 text-xs text-muted">{archivedCount} archived playbook{archivedCount === 1 ? '' : 's'} hidden.</div>
        ) : null}
      </div>
    </div>
  )
}
