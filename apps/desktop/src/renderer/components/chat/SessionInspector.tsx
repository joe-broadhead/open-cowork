import { useEffect, useMemo, useState } from 'react'
import { useSessionStore, type Message } from '../../stores/session'
import { listSessionArtifacts } from './session-artifacts'
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

type InspectorTab = 'context' | 'messages' | 'artifacts'

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
