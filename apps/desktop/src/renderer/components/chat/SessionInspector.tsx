import { useEffect, useMemo, useState } from 'react'
import type { SessionView, TaskRun } from '@open-cowork/shared'
import { useSessionStore, type Message } from '../../stores/session'
import { listSessionArtifacts } from './session-artifacts'
import { TodoListView } from './TodoListView'
import { countTodos, summarizeTodoCounts } from './todo-utils'
import {
  FALLBACK_CONTEXT_LIMITS,
  computeBreakdown,
  formatCost,
  formatDateTime,
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTokens,
  serializeToolPayload,
} from './session-inspector-utils'

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
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-[13px] font-medium text-text">{value}</div>
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
      const result = await window.openCowork.session.summarize(sessionId)
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
      <div className="text-[11px] text-text-muted">
        {nearLimit
          ? 'Context is close to the auto-compaction threshold — you can pre-empt it now.'
          : 'Trim history proactively using the compaction agent.'}
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={!sessionId || isCompacting}
        className="shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-border-subtle text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
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
            className="w-full rounded-2xl border border-border-subtle bg-surface px-3 py-3 text-left transition-colors hover:bg-surface-hover cursor-pointer"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted shrink-0">
                    {message.role}
                  </span>
                  <span className="text-[12px] text-text truncate">{message.id}</span>
                </div>
                <div className="mt-1 text-[11px] text-text-muted">
                  {formatDateTime(message.timestamp || null)}
                </div>
              </div>
              <span className="text-[11px] text-text-muted shrink-0">{expanded ? 'Hide' : 'Show'}</span>
            </div>
            {expanded && (
              <pre className="mt-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-secondary font-sans">
                {message.content || '(empty)'}
              </pre>
            )}
          </button>
        )
      })}
    </div>
  )
}

function ArtifactList({
  sessionId,
  artifacts,
}: {
  sessionId: string
  artifacts: ReturnType<typeof listSessionArtifacts>
}) {
  const [exportingId, setExportingId] = useState<string | null>(null)

  if (artifacts.length === 0) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3 text-[12px] text-text-muted">
        No generated artifacts yet.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className="rounded-2xl border border-border-subtle bg-surface px-3 py-3 flex items-center justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-text truncate">{artifact.filename}</div>
            <div className="mt-1 text-[11px] text-text-muted">
              {artifact.toolName}{artifact.taskRunId ? ' via sub-agent' : ' in thread'}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={async () => {
                await window.openCowork.artifact.reveal({
                  sessionId,
                  filePath: artifact.filePath,
                })
              }}
              className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
            >
              Reveal
            </button>
            <button
              onClick={async () => {
                try {
                  setExportingId(artifact.id)
                  await window.openCowork.artifact.export({
                    sessionId,
                    filePath: artifact.filePath,
                    suggestedName: artifact.filename,
                  })
                } finally {
                  setExportingId(null)
                }
              }}
              className="px-2.5 py-1.5 rounded-lg border border-border-subtle text-[11px] text-text-secondary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
            >
              {exportingId === artifact.id ? 'Saving...' : 'Save As…'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function SessionInspector({ onClose }: InspectorProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const currentView = useSessionStore((state) => state.currentView)
  const [tab, setTab] = useState<InspectorTab>('context')
  const [runtimeModel, setRuntimeModel] = useState<RuntimeModelState>({
    providerId: null,
    modelId: null,
    contextLimit: null,
  })

  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId],
  )
  const showArtifactsTab = !currentSession?.directory

  useEffect(() => {
    let cancelled = false

    async function loadRuntimeModel() {
      try {
        const [settings, info] = await Promise.all([
          window.openCowork.settings.get(),
          window.openCowork.model.info(),
        ])
        if (cancelled) return
        const modelId = settings.effectiveModel || settings.selectedModelId || null
        const providerId = settings.effectiveProviderId || null
        const contextLimit = modelId && info?.contextLimits
          ? info.contextLimits[modelId] || FALLBACK_CONTEXT_LIMITS[modelId] || null
          : null

        setRuntimeModel({
          providerId,
          modelId,
          contextLimit,
        })
      } catch {
        if (cancelled) return
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
  }, [currentSessionId])

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
  const contextLimit = runtimeModel.contextLimit || (modelId ? FALLBACK_CONTEXT_LIMITS[modelId] || null : null)
  const contextTokens = currentView.lastInputTokens || currentView.sessionTokens.input
  const contextUsage = contextLimit && contextTokens > 0
    ? Math.min(Math.round((contextTokens / contextLimit) * 100), 100)
    : 0
  const userMessageCount = currentView.messages.filter((message) => message.role === 'user').length
  const assistantMessageCount = currentView.messages.filter((message) => message.role === 'assistant').length
  const totalTokens = currentView.sessionTokens.input + currentView.sessionTokens.output + currentView.sessionTokens.reasoning
  const rawMessages = currentView.messages.slice().sort((left, right) => left.order - right.order)
  const artifacts = useMemo(() => listSessionArtifacts(currentView), [currentView])
  const toolPayloads = [
    ...currentView.toolCalls.map((tool) => `${tool.name} ${serializeToolPayload(tool.input)} ${serializeToolPayload(tool.output)}`),
    ...currentView.taskRuns.flatMap((taskRun) =>
      taskRun.toolCalls.map((tool) => `${tool.name} ${serializeToolPayload(tool.input)} ${serializeToolPayload(tool.output)}`),
    ),
  ]
  const breakdown = computeBreakdown({
    messages: currentView.messages,
    toolPayloads,
    totalContextTokens: contextTokens,
  })

  if (!currentSessionId) return null

  return (
    <aside
      className="w-[360px] shrink-0 border-l border-border-subtle flex flex-col min-h-0"
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
              className="px-3 py-1.5 rounded-full text-[12px] font-medium cursor-pointer transition-colors"
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
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer">
          Hide
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {tab === 'context' && (
          <div className="flex flex-col gap-5">
            <section>
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Session</div>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <Stat label="Provider" value={formatProviderLabel(providerId)} />
                <Stat label="Model" value={formatModelLabel(modelId)} />
                <Stat label="Messages" value={String(currentView.messages.length)} />
                <Stat label="Total Tokens" value={formatInteger(totalTokens)} />
                <Stat label="Input Tokens" value={formatInteger(currentView.sessionTokens.input)} />
                <Stat label="Reasoning" value={formatInteger(currentView.sessionTokens.reasoning)} />
                <Stat label="Cache (R/W)" value={`${formatInteger(currentView.sessionTokens.cacheRead)} / ${formatInteger(currentView.sessionTokens.cacheWrite)}`} />
                <Stat label="Total Cost" value={formatCost(currentView.sessionCost)} />
                <Stat label="User Messages" value={String(userMessageCount)} />
                <Stat label="Assistant Messages" value={String(assistantMessageCount)} />
                <Stat label="Created" value={formatDateTime(currentSession?.createdAt || null)} />
                <Stat label="Last Activity" value={formatDateTime(currentSession?.updatedAt || null)} />
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Context Usage</div>
                <div className="text-[12px] text-text-secondary">
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
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Context Breakdown</div>
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
                  <div key={item.id} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                    <span className="w-2 h-2 rounded-full" style={{ background: item.color }} />
                    <span>{item.label} {contextTokens > 0 ? `${Math.round((item.value / contextTokens) * 100)}%` : '0%'}</span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Recent Raw Messages</div>
              <div className="mt-3">
                <MessageList messages={rawMessages.slice(-5)} />
              </div>
            </section>
          </div>
        )}

        {tab === 'messages' && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Raw Messages</div>
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
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Sandbox Artifacts</div>
            <div className="mt-3">
              <ArtifactList sessionId={currentSessionId} artifacts={artifacts} />
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
      <div className="text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
        No todos yet. Agents populate this list via the <span className="font-mono">todowrite</span> tool.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {executionPlan.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Agent plan</div>
            <div className="text-[11px] text-text-muted">Derived from active task runs</div>
          </div>
          <div className="mt-3">
            <TodoListView todos={executionPlan} showPriorityTag={false} />
          </div>
        </section>
      )}

      {rootTodos.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">Session todos</div>
            <div className="text-[11px] text-text-muted">{summarizeTodoCounts(rootCounts)}</div>
          </div>
          <div className="mt-3">
            <TodoListView todos={rootTodos} />
          </div>
        </section>
      )}

      {taskRunsWithTodos.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-3">Sub-agent todos</div>
          <div className="flex flex-col gap-4">
            {taskRunsWithTodos.map((task) => (
              <TaskTodos key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      <div className="text-[11px] text-text-muted leading-relaxed rounded-xl border border-border-subtle bg-surface px-3 py-2">
        Todos are maintained by the agent via the <span className="font-mono">todowrite</span> tool. The app reads them live through the OpenCode SDK — direct edits are not exposed.
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
          <div className="text-[12px] font-medium text-text truncate">
            {task.title || 'Sub-Agent'}
          </div>
          {task.agent && (
            <div className="text-[10px] text-text-muted truncate">
              via {task.agent}
            </div>
          )}
        </div>
        <div className="text-[10px] text-text-muted shrink-0">
          {summarizeTodoCounts(counts)}
        </div>
      </div>
      <TodoListView todos={task.todos} variant="compact" />
    </div>
  )
}
