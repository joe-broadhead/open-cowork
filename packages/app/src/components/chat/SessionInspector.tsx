import { useEffect, useMemo, useState } from 'react'
import type { ModelInfoSnapshot, SessionArtifact, SessionView, TaskRun } from '@open-cowork/shared'
import { useSessionStore, type Message } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { t } from '../../helpers/i18n'
import { listSessionArtifacts, listVisibleSessionArtifacts } from './session-artifacts'
import { SessionArtifactList } from './SessionArtifactList'
import { TodoListView } from './TodoListView'
import { countTodos, summarizeTodoCounts } from './todo-utils'
import {
  computeBreakdown,
  formatCost,
  formatDateTime,
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTokens,
  serializeToolPayload,
} from './session-inspector-utils'
import { getModelContextLimit } from '../../helpers/model-info'
import { DiffView, ReviewPanel, TaskLane, type DiffViewFile } from '../ui'

type InspectorTab = 'context' | 'messages' | 'todos' | 'artifacts'

type InspectorProps = {
  onClose: () => void
}

type RuntimeModelState = {
  providerId: string | null
  modelId: string | null
  contextLimit: number | null
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3">
      <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-sm font-medium text-text">{value}</div>
    </div>
  )
}

function SummarizeControl({
  sessionId,
  contextUsage,
  contextState,
}: {
  sessionId: string | null
  contextUsage: number
  contextState: string | null | undefined
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const isCompacting = contextState === 'compacting' || state === 'pending'
  const nearLimit = contextUsage >= 70

  // The SDK's session.summarize runs a dedicated compaction agent that
  // shortens history. We fire-and-forget and let the status reconciler /
  // session.compacted event drive the UI back to idle.
  async function onClick() {
    if (!sessionId || isCompacting) return
    setState('pending')
    setMessage(null)
    try {
      const result = await window.coworkApi.session.summarize(sessionId)
      if (result.ok) {
        setState('success')
      } else {
        setState('error')
        setMessage(result.message)
      }
    } catch (err) {
      setState('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const label = state === 'pending' || contextState === 'compacting'
    ? 'Compacting…'
    : state === 'success'
      ? 'Compaction requested'
      : state === 'error'
        ? 'Retry summarize'
        : nearLimit
          ? 'Summarize now'
          : 'Summarize session'

  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <div className="text-2xs text-text-muted">
        {nearLimit
          ? 'Context is close to the auto-compaction threshold — you can pre-empt it now.'
          : 'Trim history proactively using the compaction agent.'}
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={!sessionId || isCompacting}
        className="shrink-0 px-3 py-1.5 rounded-lg text-2xs font-medium border border-border-subtle text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        title={message || undefined}
      >
        {label}
      </button>
    </div>
  )
}

function MessageList({ messages }: { messages: Message[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-2">
      {messages.map((message) => {
        const expanded = expandedId === message.id
        return (
          <button
            key={message.id}
            onClick={() => setExpandedId(expanded ? null : message.id)}
            className="w-full rounded-2xl border border-border-subtle bg-surface px-3 py-3 text-start transition-colors hover:bg-surface-hover cursor-pointer"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-text-muted shrink-0">
                    {message.role}
                  </span>
                  <span className="text-xs text-text truncate">{message.id}</span>
                </div>
                <div className="mt-1 text-2xs text-text-muted">
                  {formatDateTime(message.timestamp || null)}
                </div>
              </div>
              <span className="text-2xs text-text-muted shrink-0">{expanded ? 'Hide' : 'Show'}</span>
            </div>
            {expanded && (
              <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary font-sans">
                {message.content || '(empty)'}
              </pre>
            )}
          </button>
        )
      })}
    </div>
  )
}

function reviewFilesFromArtifacts(artifacts: SessionArtifact[]): DiffViewFile[] {
  return artifacts.slice(0, 12).map((artifact, index) => ({
    id: artifact.id || artifact.filePath || `artifact-${index}`,
    path: artifact.filePath || artifact.filename || `artifact-${index + 1}`,
    status: 'unknown',
    synthetic: true,
    meta: artifact.toolName || artifact.source || null,
  }))
}

export function SessionInspector({ onClose }: InspectorProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const activeWorkspaceId = useSessionStore((state) => state.activeWorkspaceId)
  const sessions = useSessionStore((state) => state.sessions)
  const currentView = useSessionStore((state) => state.currentView)
  const workspaceSupport = useActiveWorkspaceSupport()
  // Subscribe to the whole map so the selector returns a stable
  // reference (zustand uses Object.is by default; returning `[]` from
  // a selector on every call triggers infinite re-renders). Slice
  // locally inside useMemo for the merged list.
  const chartArtifactsBySession = useSessionStore((state) => state.chartArtifactsBySession)
  const chartArtifacts = useMemo(
    () => {
      if (!currentSessionId) return []
      return chartArtifactsBySession[sessionWorkspaceKey(activeWorkspaceId, currentSessionId)] || []
    },
    [activeWorkspaceId, chartArtifactsBySession, currentSessionId],
  )
  const [tab, setTab] = useState<InspectorTab>('context')
  const [runtimeModel, setRuntimeModel] = useState<RuntimeModelState>({
    providerId: null,
    modelId: null,
    contextLimit: null,
  })
  const [modelInfo, setModelInfo] = useState<ModelInfoSnapshot | null>(null)

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId],
  )
  // Artifacts tab was previously sandbox-only because file-edit
  // artifacts couldn't be safely surfaced from project directories.
  // Chart PNGs live outside the session dir under appData, so they're
  // available in both modes — keep the tab when either kind is
  // present.
  const activeWorkspaceIsLocal = activeWorkspaceId === LOCAL_WORKSPACE_ID
  const canReadPrivateArtifacts = !currentSession?.directory && activeWorkspaceIsLocal
  const allArtifacts = useMemo(
    () => listSessionArtifacts(currentView, chartArtifacts),
    [currentView, chartArtifacts],
  )
  const visibleArtifacts = useMemo(
    () => listVisibleSessionArtifacts(currentView, chartArtifacts, { canReadPrivateArtifacts }),
    [currentView, chartArtifacts, canReadPrivateArtifacts],
  )
  const showArtifactsTab = canReadPrivateArtifacts || visibleArtifacts.length > 0

  useEffect(() => {
    let cancelled = false

    async function loadRuntimeModel() {
      try {
        const [settings, info] = await Promise.all([
          window.coworkApi.settings.get(activeWorkspaceId === LOCAL_WORKSPACE_ID ? undefined : { workspaceId: activeWorkspaceId }),
          window.coworkApi.model.info(),
        ])
        if (cancelled) return
        const modelId = settings.effectiveModel || settings.selectedModelId || null
        const providerId = settings.effectiveProviderId || null
        const contextLimit = getModelContextLimit(info, providerId, modelId)
        setModelInfo(info)

        setRuntimeModel({
          providerId,
          modelId,
          contextLimit,
        })
      } catch {
        if (cancelled) return
        setModelInfo(null)
        setRuntimeModel({
          providerId: null,
          modelId: null,
          contextLimit: null,
        })
      }
    }

    void loadRuntimeModel()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, currentSessionId])

  useEffect(() => {
    if (tab === 'artifacts' && !showArtifactsTab) {
      setTab('context')
    }
  }, [tab, showArtifactsTab])

  const latestModeledMessage = useMemo(
    () => currentView.messages
      .slice()
      .reverse()
      .find((message) => message.modelId || message.providerId) || null,
    [currentView.messages],
  )

  const providerId = latestModeledMessage?.providerId || runtimeModel.providerId
  const modelId = latestModeledMessage?.modelId || runtimeModel.modelId
  const contextLimit = getModelContextLimit(modelInfo, providerId, modelId) || runtimeModel.contextLimit
  const contextTokens = currentView.lastInputTokens || currentView.sessionTokens.input
  const contextUsage = contextLimit && contextTokens > 0
    ? Math.min(Math.round((contextTokens / contextLimit) * 100), 100)
    : 0
  const userMessageCount = currentView.messages.filter((message) => message.role === 'user').length
  const assistantMessageCount = currentView.messages.filter((message) => message.role === 'assistant').length
  const totalTokens = currentView.sessionTokens.input + currentView.sessionTokens.output + currentView.sessionTokens.reasoning
  const rawMessages = currentView.messages.slice().sort((left, right) => left.order - right.order)
  const reviewFiles = useMemo(() => reviewFilesFromArtifacts(allArtifacts), [allArtifacts])
  const openDecisionCount = currentView.pendingApprovals.length + currentView.pendingQuestions.length
  const activeTaskRuns = currentView.taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const todoCount = currentView.todos.length + currentView.executionPlan.length + currentView.taskRuns.reduce((count, task) => count + task.todos.length, 0)
  // serializeToolPayload JSON-stringifies every tool input AND output; computeBreakdown then scans
  // every message and payload. The view slices are referentially stable between streamed patches,
  // so memoizing keeps these off the critical path for the far more frequent re-renders that don't
  // touch the transcript (tab switches, hover, parent re-renders).
  const toolPayloads = useMemo(() => [
    ...currentView.toolCalls.map((tool) => `${tool.name} ${serializeToolPayload(tool.input)} ${serializeToolPayload(tool.output)}`),
    ...currentView.taskRuns.flatMap((taskRun) =>
      taskRun.toolCalls.map((tool) => `${tool.name} ${serializeToolPayload(tool.input)} ${serializeToolPayload(tool.output)}`),
    ),
  ], [currentView.toolCalls, currentView.taskRuns])
  const breakdown = useMemo(() => computeBreakdown({
    messages: currentView.messages,
    toolPayloads,
    totalContextTokens: contextTokens,
  }), [currentView.messages, toolPayloads, contextTokens])

  if (!currentSessionId) return null

  return (
    <aside
      className="w-[360px] shrink-0 border-s border-border-subtle flex flex-col min-h-0"
      style={{ background: 'color-mix(in srgb, var(--color-base) 94%, var(--color-elevated) 6%)' }}
    >
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {([
            { id: 'context', label: 'Context' },
            { id: 'messages', label: 'Messages' },
            { id: 'todos', label: 'Todos' },
            ...(showArtifactsTab ? [{ id: 'artifacts', label: 'Artifacts' } as const] : []),
          ] as const).map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className="px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors"
              style={{
                background: tab === entry.id ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'transparent',
                color: tab === entry.id ? 'var(--color-text)' : 'var(--color-text-muted)',
                border: `1px solid ${tab === entry.id ? 'var(--color-accent)' : 'var(--color-border-subtle)'}`,
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="text-2xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer">
          Hide
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <ReviewPanel
          title={t('sessionInspector.reviewTitle', 'Review')}
          summary={t('sessionInspector.reviewSummary', 'Session state projected from OpenCode messages, tools, delegated tasks, approvals, questions, and artifacts.')}
          status={{
            label: openDecisionCount > 0
              ? t('sessionInspector.reviewNeedsInput', 'Needs input')
              : t('sessionInspector.reviewReady', 'Ready'),
            tone: openDecisionCount > 0 ? 'warning' : 'success',
          }}
          className="mb-5"
        >
          <div className="grid gap-3">
            <TaskLane
              title={t('sessionInspector.decisionLane', 'Decisions')}
              tone="approval"
              items={[
                ...(currentView.pendingApprovals.length > 0 ? [{
                  id: 'approvals',
                  title: t('sessionInspector.permissionApprovals', 'Permission approvals'),
                  meta: t('sessionInspector.pendingCount', '{{count}} pending', { count: currentView.pendingApprovals.length }),
                  status: { label: t('sessionInspector.open', 'Open'), tone: 'warning' as const },
                }] : []),
                ...(currentView.pendingQuestions.length > 0 ? [{
                  id: 'questions',
                  title: t('sessionInspector.questions', 'Questions'),
                  meta: t('sessionInspector.pendingCount', '{{count}} pending', { count: currentView.pendingQuestions.length }),
                  status: { label: t('sessionInspector.open', 'Open'), tone: 'warning' as const },
                }] : []),
              ]}
              emptyLabel={t('sessionInspector.noDecisions', 'No decisions waiting')}
            />
            <TaskLane
              title={t('sessionInspector.deliverablesLane', 'Deliverables')}
              tone="artifact"
              items={[
                ...(allArtifacts.length > 0 ? [{
                  id: 'artifacts',
                  title: t('sessionInspector.artifactsReady', 'Artifacts ready'),
                  meta: t('sessionInspector.artifactCount', '{{count}} artifacts', { count: allArtifacts.length }),
                  status: { label: t('sessionInspector.review', 'Review'), tone: 'accent' as const },
                }] : []),
                ...(todoCount > 0 ? [{
                  id: 'todos',
                  title: t('sessionInspector.todosTracked', 'Todos tracked'),
                  meta: t('sessionInspector.todoCount', '{{count}} items', { count: todoCount }),
                  status: { label: t('sessionInspector.live', 'Live'), tone: 'neutral' as const },
                }] : []),
                ...(activeTaskRuns > 0 ? [{
                  id: 'coworkers',
                  title: t('sessionInspector.activeCoworkers', 'Coworkers active'),
                  meta: t('sessionInspector.taskCount', '{{count}} task runs', { count: activeTaskRuns }),
                  status: { label: t('sessionInspector.running', 'Running'), tone: 'accent' as const },
                }] : []),
              ]}
              emptyLabel={t('sessionInspector.noDeliverables', 'No deliverables yet')}
            />
          </div>
        </ReviewPanel>

        <DiffView
          title={t('sessionInspector.reviewTitle', 'Review')}
          subtitle={reviewFiles.length
            ? t('sessionInspector.reviewSubtitle', '{{count}} artifacts ready for inspection', { count: reviewFiles.length })
            : t('sessionInspector.reviewEmptySubtitle', 'Artifacts, file changes, and task outputs appear here first.')}
          files={reviewFiles}
          empty={t('sessionInspector.reviewEmpty', 'No artifacts to review yet.')}
          className="mb-5"
        >
          <p className="rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-xs text-text-secondary">
            {t('sessionInspector.nothingShips', 'Nothing ships until you approve.')}
          </p>
        </DiffView>

        {tab === 'context' && (
          <div className="flex flex-col gap-5">
            <section>
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('sessionInspector.session', 'Session')}</div>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <Stat label={t('sessionInspector.statProvider', 'Provider')} value={formatProviderLabel(providerId)} />
                <Stat label={t('sessionInspector.statModel', 'Model')} value={formatModelLabel(modelId)} />
                <Stat label={t('sessionInspector.statMessages', 'Messages')} value={String(currentView.messages.length)} />
                <Stat label={t('sessionInspector.statTotalTokens', 'Total Tokens')} value={formatInteger(totalTokens)} />
                <Stat label={t('sessionInspector.statInputTokens', 'Input Tokens')} value={formatInteger(currentView.sessionTokens.input)} />
                <Stat label={t('sessionInspector.statReasoning', 'Reasoning')} value={formatInteger(currentView.sessionTokens.reasoning)} />
                <Stat label={t('sessionInspector.statCache', 'Cache (R/W)')} value={`${formatInteger(currentView.sessionTokens.cacheRead)} / ${formatInteger(currentView.sessionTokens.cacheWrite)}`} />
                <Stat label={t('sessionInspector.statTotalCost', 'Total Cost')} value={formatCost(currentView.sessionCost)} />
                <Stat label={t('sessionInspector.statUserMessages', 'User Messages')} value={String(userMessageCount)} />
                <Stat label={t('sessionInspector.statAssistantMessages', 'Assistant Messages')} value={String(assistantMessageCount)} />
                <Stat label={t('sessionInspector.statCreated', 'Created')} value={formatDateTime(currentSession?.createdAt || null)} />
                <Stat label={t('sessionInspector.statLastActivity', 'Last Activity')} value={formatDateTime(currentSession?.updatedAt || null)} />
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between gap-3">
                <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('sessionInspector.contextUsage', 'Context Usage')}</div>
                <div className="text-xs text-text-secondary">
                  {contextLimit ? `${contextUsage}% of ${formatTokens(contextLimit)}` : `${formatTokens(contextTokens)} tokens`}
                </div>
              </div>
              <div className="mt-3 h-2 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--color-border) 78%, transparent)' }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${contextLimit ? Math.max(contextUsage, contextTokens > 0 ? 4 : 0) : 100}%`,
                    background: contextUsage > 84 ? 'var(--color-red)' : contextUsage > 69 ? 'var(--color-amber)' : 'var(--color-accent)',
                  }}
                />
              </div>
              <SummarizeControl sessionId={currentSessionId} contextUsage={contextUsage} contextState={currentView.contextState} />
            </section>

            <section>
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('sessionInspector.contextBreakdown', 'Context Breakdown')}</div>
              <div className="mt-3 h-2 rounded-full overflow-hidden flex" style={{ background: 'color-mix(in srgb, var(--color-border) 78%, transparent)' }}>
                {breakdown.map((item) => (
                  <span
                    key={item.id}
                    style={{
                      width: contextTokens > 0 ? `${Math.max(0, (item.value / contextTokens) * 100)}%` : '0%',
                      background: item.color,
                    }}
                  />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">
                {breakdown.map((item) => (
                  <div key={item.id} className="flex items-center gap-1.5 text-2xs text-text-secondary">
                    <span className="w-2 h-2 rounded-full" style={{ background: item.color }} />
                    <span>{item.label} {contextTokens > 0 ? `${Math.round((item.value / contextTokens) * 100)}%` : '0%'}</span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('sessionInspector.recentRawMessages', 'Recent Raw Messages')}</div>
              <div className="mt-3">
                <MessageList messages={rawMessages.slice(-5)} />
              </div>
            </section>
          </div>
        )}

        {tab === 'messages' && (
          <div>
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('sessionInspector.rawMessages', 'Raw Messages')}</div>
            <div className="mt-3">
              <MessageList messages={rawMessages} />
            </div>
          </div>
        )}

        {tab === 'todos' && (
          <TodosTab currentView={currentView} />
        )}

        {tab === 'artifacts' && currentSessionId && (
          <div>
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">
              {activeWorkspaceIsLocal
                ? t('sessionInspector.sandboxArtifacts', 'Sandbox Artifacts')
                : t('sessionInspector.cloudArtifacts', 'Cloud Artifacts')}
            </div>
            <div className="mt-3">
              <SessionArtifactList
                sessionId={currentSessionId}
                artifacts={visibleArtifacts}
                workspaceId={activeWorkspaceIsLocal ? undefined : activeWorkspaceId}
                canDownloadArtifact={workspaceSupport.flags.canDownloadArtifact}
                downloadDisabledReason={workspaceSupport.flags.reasons.downloadArtifact}
                canRevealArtifact={workspaceSupport.flags.canRevealArtifact}
                revealDisabledReason={workspaceSupport.flags.reasons.revealArtifact}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

function TodosTab({ currentView }: { currentView: SessionView }) {
  const rootTodos = currentView.todos
  const executionPlan = currentView.executionPlan
  const taskRuns = currentView.taskRuns
  const rootCounts = useMemo(() => countTodos(rootTodos), [rootTodos])
  const taskRunsWithTodos = useMemo(
    () => taskRuns.filter((task) => task.todos.length > 0),
    [taskRuns],
  )

  const nothing = rootTodos.length === 0
    && executionPlan.length === 0
    && taskRunsWithTodos.length === 0

  if (nothing) {
    return (
      <div className="text-xs text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
        No todos yet. Coworkers populate this list via the <span className="font-mono">todowrite</span> tool.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {executionPlan.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('thinking.agentPlan', 'Coworker plan')}</div>
            <div className="text-2xs text-text-muted">{t('sessionInspector.planFromTaskRuns', 'Derived from active task runs')}</div>
          </div>
          <div className="mt-3">
            <TodoListView todos={executionPlan} showPriorityTag={false} />
          </div>
        </section>
      )}

      {rootTodos.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{t('thinking.sessionTodos', 'Session todos')}</div>
            <div className="text-2xs text-text-muted">{summarizeTodoCounts(rootCounts)}</div>
          </div>
          <div className="mt-3">
            <TodoListView todos={rootTodos} />
          </div>
        </section>
      )}

      {taskRunsWithTodos.length > 0 && (
        <section>
          <div className="text-2xs uppercase tracking-[0.08em] text-text-muted mb-3">{t('sessionInspector.specialistTodos', 'Specialist todos')}</div>
          <div className="flex flex-col gap-4">
            {taskRunsWithTodos.map((task) => (
              <TaskTodos key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      <div className="text-2xs text-text-muted leading-relaxed rounded-xl border border-border-subtle bg-surface px-3 py-2">
        Todos are maintained by OpenCode via the <span className="font-mono">todowrite</span> tool. The app reads them live through the OpenCode SDK — direct edits are not exposed.
      </div>
    </div>
  )
}

function TaskTodos({ task }: { task: TaskRun }) {
  const counts = useMemo(() => countTodos(task.todos), [task.todos])
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text truncate">
            {task.title || 'Specialist'}
          </div>
          {task.agent && (
            <div className="text-2xs text-text-muted truncate">
              via {task.agent}
            </div>
          )}
        </div>
        <div className="text-2xs text-text-muted shrink-0">
          {summarizeTodoCounts(counts)}
        </div>
      </div>
      <TodoListView todos={task.todos} variant="compact" />
    </div>
  )
}
