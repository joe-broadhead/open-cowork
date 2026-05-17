import { useEffect, useMemo, useState } from 'react'
import type { EffectiveAppSettings, WorkflowListPayload, WorkflowRun, WorkflowSummary, WorkflowTrigger } from '@open-cowork/shared'
import { formatDate as formatLocalizedDate } from '../../helpers/i18n'

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

function statusTone(status: WorkflowSummary['status']) {
  if (status === 'active') return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
  if (status === 'running') return 'border-sky-400/30 bg-sky-500/10 text-sky-100'
  if (status === 'failed') return 'border-red-400/30 bg-red-500/10 text-red-100'
  if (status === 'paused') return 'border-amber-400/30 bg-amber-500/10 text-amber-100'
  return 'border-border bg-muted text-muted'
}

function runStatusTone(status?: WorkflowRun['status'] | null) {
  if (status === 'completed') return 'text-emerald-300'
  if (status === 'running' || status === 'queued') return 'text-sky-300'
  if (status === 'failed') return 'text-red-300'
  return 'text-muted'
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

  const activeWorkflows = useMemo(
    () => payload.workflows.filter((workflow) => workflow.status !== 'archived'),
    [payload.workflows],
  )
  const archivedCount = payload.workflows.length - activeWorkflows.length

  const refresh = async () => {
    setLoading(true)
    try {
      setPayload(await window.coworkApi.workflows.list())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    void window.coworkApi.settings.get().then((settings) => {
      setRuntimeConfigSource(settings.runtimeConfigSource === 'machine' ? 'machine' : 'app')
    }).catch(() => {
      setRuntimeConfigSource('app')
    })
    return window.coworkApi.on.workflowUpdated(() => {
      void refresh()
    })
  }, [])
  const workflowDraftBlocked = runtimeConfigSource === 'machine'

  const runAction = async (workflowId: string, action: () => Promise<unknown>, message: string) => {
    setBusyId(workflowId)
    setFeedback(null)
    try {
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
    if (workflowDraftBlocked) {
      setFeedback('Switch OpenCode config source to In app before adding workflows. Workflow setup uses Cowork’s Workflow Designer agent and Workflows tool.')
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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-normal text-primary">Workflows</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Save repeatable work from a Workflow Designer setup thread, then run it manually, on a schedule, or from a webhook.
            </p>
          </div>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void startDraft()}
              disabled={busyId === 'new' || workflowDraftBlocked}
              title={workflowDraftBlocked ? 'Workflow setup requires the in-app OpenCode config source.' : undefined}
            >
            {busyId === 'new' ? 'Starting...' : 'Add workflow'}
          </button>
        </div>
        {feedback ? (
          <div className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-secondary">
            {feedback}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {loading && payload.workflows.length === 0 ? (
          <div className="text-sm text-muted">Loading workflows...</div>
        ) : activeWorkflows.length === 0 ? (
          <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-border bg-surface/40 px-6 text-center">
            <div>
              <h2 className="text-lg font-semibold text-primary">No workflows yet</h2>
              <p className="mt-2 max-w-md text-sm text-muted">
                {workflowDraftBlocked
                  ? 'Workflow setup requires the in-app OpenCode config source because it uses Cowork’s Workflow Designer agent and Workflows tool.'
                  : 'Start with a thread. The Workflow Designer agent will help clarify the task, tools, skills, agent, schedule, and webhook trigger before saving anything.'}
              </p>
              <button
                type="button"
                className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void startDraft()}
                disabled={workflowDraftBlocked}
                title={workflowDraftBlocked ? 'Workflow setup requires the in-app OpenCode config source.' : undefined}
              >
                Add workflow
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {activeWorkflows.map((workflow) => (
              <article key={workflow.id} className="rounded-lg border border-border bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 text-base font-semibold text-primary">{workflow.title}</h2>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusTone(workflow.status)}`}>
                        {workflow.status}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-secondary">{workflow.instructions}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {workflow.draftSessionId ? (
                      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary hover:bg-muted" onClick={() => onOpenThread(workflow.draftSessionId!)}>
                        Open setup
                      </button>
                    ) : null}
                    {workflow.latestRunSessionId ? (
                      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary hover:bg-muted" onClick={() => onOpenThread(workflow.latestRunSessionId!)}>
                        Open latest run
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={busyId === workflow.id || workflow.status === 'running'}
                      onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.runNow(workflow.id), 'Workflow run started.')}
                    >
                      Run
                    </button>
                    {workflow.status === 'paused' ? (
                      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary hover:bg-muted" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.resume(workflow.id), 'Workflow resumed.')}>
                        Resume
                      </button>
                    ) : (
                      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-secondary hover:bg-muted" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.pause(workflow.id), 'Workflow paused.')}>
                        Pause
                      </button>
                    )}
                    <button type="button" className="rounded-md border border-red-400/30 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/10" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.archive(workflow.id), 'Workflow archived.')}>
                      Archive
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-border bg-base/40 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Execution</div>
                    <div className="mt-1 text-sm text-primary">{workflow.agentName || 'build'}</div>
                    <div className="mt-1 text-xs text-muted">
                      {[...workflow.skillNames, ...workflow.toolIds].slice(0, 4).join(', ') || 'Uses selected tools and skills from the setup thread'}
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
                    <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs text-secondary hover:bg-muted" onClick={() => void copyWebhook(workflow)}>
                      Copy curl
                    </button>
                    <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs text-secondary hover:bg-muted" onClick={() => void runAction(workflow.id, () => window.coworkApi.workflows.regenerateWebhookSecret(workflow.id), 'Webhook secret regenerated.')}>
                      Regenerate
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
        {archivedCount > 0 ? (
          <div className="mt-4 text-xs text-muted">{archivedCount} archived workflow{archivedCount === 1 ? '' : 's'} hidden.</div>
        ) : null}
      </div>
    </div>
  )
}
