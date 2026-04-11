import { useState, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'

// Fallback context limits — overridden by SDK model info when available
const FALLBACK_CONTEXT_LIMITS: Record<string, number> = {
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'databricks-claude-sonnet-4': 200_000,
  'databricks-claude-opus-4-6': 200_000,
  'databricks-claude-sonnet-4-6': 200_000,
  'databricks-gpt-oss-120b': 128_000,
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

export function StatusBar() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const sessionCost = useSessionStore((s) => s.sessionCost)
  const sessionTokens = useSessionStore((s) => s.sessionTokens)
  const totalCost = useSessionStore((s) => s.totalCost)
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const [modelId, setModelId] = useState('')
  const [modelName, setModelName] = useState('...')
  const [sdkContextLimit, setSdkContextLimit] = useState<number | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  useEffect(() => {
    window.cowork.settings.get().then((s: any) => {
      const model = s.effectiveModel || s.defaultModel
      setModelId(model)
      const name = model
        ?.replace('databricks-', '')
        .replace('gemini-', 'Gemini ')
        .replace('claude-', 'Claude ')
        .replace(/-/g, ' ')
      setModelName(name || model)
    })
    // Fetch SDK model info for context limits
    ;window.cowork.model.info().then((info: any) => {
      if (info?.contextLimits) {
        const limit = info.contextLimits[modelId]
        if (limit) setSdkContextLimit(limit)
      }
    }).catch(() => {})
  }, [])

  const lastInputTokens = useSessionStore((s) => s.lastInputTokens)
  const up = mcpConnections.filter((m) => m.connected).length
  const total = mcpConnections.length
  const totalTokens = sessionTokens.input + sessionTokens.output + sessionTokens.reasoning

  // Context percentage — use the LAST turn's input tokens (= current context window usage)
  // Each model call sends the full conversation, so the last input count IS the context usage
  const contextLimit = sdkContextLimit || FALLBACK_CONTEXT_LIMITS[modelId] || 200_000
  const contextPercent = lastInputTokens > 0 ? Math.min(Math.round((lastInputTokens / contextLimit) * 100), 100) : 0
  const contextColor = contextPercent > 80 ? 'var(--color-red)' : contextPercent > 50 ? 'var(--color-amber)' : 'var(--color-text-muted)'

  return (
    <div className="relative">
      <div className="flex items-center justify-between h-[26px] px-4 shrink-0 select-none text-[10px] border-t border-border-subtle text-text-muted glass-panel" style={{ background: 'color-mix(in srgb, var(--color-base) 80%, transparent)' }}>
        <div className="flex items-center gap-2.5">
          {isGenerating ? (
            <span className="text-accent flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {activeAgent ? `${activeAgent} working...` : 'Thinking...'}
            </span>
          ) : (
            <span>Ready</span>
          )}
          <span className="text-border">|</span>
          <span className="capitalize">{modelName}</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Context percentage */}
          {sessionTokens.input > 0 && (
            <span style={{ color: contextColor }}>{contextPercent}% context</span>
          )}

          {/* Token/cost display */}
          {totalTokens > 0 && (
            <button
              onClick={() => setShowDetail(!showDetail)}
              className="flex items-center gap-1.5 cursor-pointer hover:text-text-secondary transition-colors"
            >
              <span>{formatTokens(totalTokens)} tokens</span>
              <span className="text-border">|</span>
              <span>{formatCost(sessionCost)}</span>
            </button>
          )}

          {/* Connection status */}
          {total > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-[5px] h-[5px] rounded-full" style={{ background: up === total ? 'var(--color-green)' : up > 0 ? 'var(--color-amber)' : 'var(--color-red)', boxShadow: up === total ? '0 0 4px var(--color-green)' : 'none' }} />
              <span>{up}/{total}</span>
            </div>
          )}
        </div>
      </div>

      {/* Cost detail popup */}
      {showDetail && totalTokens > 0 && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowDetail(false)} />
          <div className="absolute bottom-8 right-4 z-50 w-56 p-3 rounded-xl bg-elevated border border-border shadow-lg">
            <div className="text-[11px] font-semibold text-text mb-2">Session Usage</div>
            <div className="flex flex-col gap-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-text-muted">Input tokens</span>
                <span className="text-text font-mono">{formatTokens(sessionTokens.input)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Output tokens</span>
                <span className="text-text font-mono">{formatTokens(sessionTokens.output)}</span>
              </div>
              {sessionTokens.reasoning > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Reasoning</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.reasoning)}</span>
                </div>
              )}
              {sessionTokens.cacheRead > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Cache read</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.cacheRead)}</span>
                </div>
              )}
              {sessionTokens.cacheWrite > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Cache write</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.cacheWrite)}</span>
                </div>
              )}
              <div className="border-t border-border-subtle my-1" />
              <div className="flex justify-between">
                <span className="text-text-muted">Context window</span>
                <span className="text-text font-mono" style={{ color: contextColor }}>{contextPercent}% of {formatTokens(contextLimit)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Session cost</span>
                <span className="text-text font-mono font-medium">{formatCost(sessionCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Total (all sessions)</span>
                <span className="text-text font-mono">{formatCost(totalCost)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
