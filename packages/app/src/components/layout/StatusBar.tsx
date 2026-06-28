import { useState, useEffect, type CSSProperties } from 'react'
import { useSessionStore } from '../../stores/session'
import { formatAgentLabel as formatReadableAgentLabel } from '../../helpers/agent-label'
import { formatCost } from '../../helpers/format'
import { t } from '../../helpers/i18n'
import { ModalBackdrop } from './ModalBackdrop'
import { getModelContextLimit } from '../../helpers/model-info'
import { McpStatusBadge } from '../chrome/McpStatusBadge'
import { Badge, type BadgeTone } from '../ui'

type MeterStyle = CSSProperties & {
  '--statusbar-meter-color': string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

function formatStatusAgentLabel(agent: string | null) {
  if (!agent) return t('statusbar.thinking', 'Thinking...')
  return t('statusbar.agentWorking', '{{agent}} working...', { agent: formatReadableAgentLabel(agent).toLowerCase() })
}

function contextToneTextClass(tone: BadgeTone) {
  if (tone === 'danger') return 'text-red'
  if (tone === 'warning') return 'text-amber'
  if (tone === 'accent') return 'text-accent'
  return 'text-text-muted'
}

export function StatusBar() {
  const currentView = useSessionStore((s) => s.currentView)
  const totalCost = useSessionStore((s) => s.totalCost)
  const isGenerating = currentView.isGenerating
  const isAwaitingPermission = currentView.isAwaitingPermission
  const isAwaitingQuestion = currentView.isAwaitingQuestion
  const sessionCost = currentView.sessionCost
  const sessionTokens = currentView.sessionTokens
  const activeAgent = currentView.activeAgent
  const contextState = currentView.contextState
  const compactionCount = currentView.compactionCount
  const lastCompactedAt = currentView.lastCompactedAt
  const lastInputTokens = currentView.lastInputTokens
  const [modelName, setModelName] = useState('...')
  const [sdkContextLimit, setSdkContextLimit] = useState<number | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  const refreshModelState = () => {
    Promise.all([
      window.coworkApi.settings.get(),
      window.coworkApi.model.info(),
    ]).then(([s, info]: [any, any]) => {
      const model = s.effectiveModel || s.selectedModelId || ''
      const provider = s.effectiveProviderId || s.selectedProviderId || ''
      setSdkContextLimit(getModelContextLimit(info, provider, model))
      const name = model
        .replace(/-/g, ' ')
      setModelName(name || model)
    }).catch(() => {
      setSdkContextLimit(null)
    })
  }

  useEffect(() => {
    refreshModelState()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => {
      refreshModelState()
    })
    return unsubscribe
  }, [])

  const totalTokens = sessionTokens.input + sessionTokens.output + sessionTokens.reasoning

  const contextLimit = sdkContextLimit
  const contextPercent = contextLimit && lastInputTokens > 0 ? Math.min(Math.round((lastInputTokens / contextLimit) * 100), 100) : 0
  const showContext = lastInputTokens > 0 || contextState === 'compacting' || contextState === 'compacted'
  // Warn when context is close to the auto-compaction threshold so the user
  // isn't surprised when the runtime suddenly shortens history. Threshold
  // at 85% mirrors the "amber" zone used by the bar colour.
  const nearCompactionThreshold = contextPercent >= 85 && contextState !== 'compacting' && contextState !== 'compacted'
  const contextColor = contextState === 'compacting'
    ? 'var(--color-accent)'
    : contextState === 'compacted'
      ? 'var(--color-amber)'
      : contextPercent > 84
        ? 'var(--color-red)'
        : contextPercent > 69
          ? 'var(--color-amber)'
          : 'var(--color-text-muted)'
  const contextTone: BadgeTone = contextState === 'compacting'
    ? 'accent'
    : contextState === 'compacted' || nearCompactionThreshold
      ? 'warning'
      : contextPercent > 84
        ? 'danger'
        : contextPercent > 69
          ? 'warning'
          : 'neutral'
  const contextLabel = contextState === 'compacting'
    ? t('statusbar.compacting', 'Compacting…')
    : contextState === 'compacted'
      ? t('compaction.done', 'Compacted')
      : nearCompactionThreshold
        ? t('statusbar.contextCompactingSoon', '{{percent}}% · compacting soon', { percent: String(contextPercent) })
        : contextLimit
          ? t('statusbar.contextPercent', '{{percent}}% context', { percent: String(contextPercent) })
          : t('statusbar.contextTokens', '{{count}} context tokens', { count: formatTokens(lastInputTokens) })
  const meterWidth = contextState === 'compacting'
    ? 100
    : contextLimit
      ? Math.max(6, contextPercent)
      : 100
  const contextDetail = contextState === 'compacting'
    ? t('statusbar.contextCompactingDetail', 'Compacting older turns to preserve context')
    : contextState === 'compacted'
      ? contextLimit
        ? t('statusbar.contextCompactedDetail', 'Compacted after {{percent}}% of {{limit}}', { percent: String(contextPercent), limit: formatTokens(contextLimit) })
        : t('statusbar.contextCompactedUnknownLimit', 'Compacted after {{count}} input tokens', { count: formatTokens(lastInputTokens) })
      : nearCompactionThreshold
        ? t('statusbar.contextNearThreshold', '{{percent}}% of {{limit}} — auto-compaction will fire soon', { percent: String(contextPercent), limit: formatTokens(contextLimit || 0) })
        : contextLimit
          ? t('statusbar.contextOfLimit', '{{percent}}% of {{limit}}', { percent: String(contextPercent), limit: formatTokens(contextLimit) })
          : t('statusbar.contextUnknownLimit', '{{count}} input tokens; model context limit unavailable', { count: formatTokens(lastInputTokens) })

  return (
    <div className="relative">
      <div
        className="statusbar-root flex items-center justify-between h-[26px] px-4 shrink-0 select-none text-2xs border-t border-border-subtle text-text-muted"
      >
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`status-dot ${isGenerating || isAwaitingQuestion ? 'status-dot--live' : isAwaitingPermission ? 'status-dot--warn' : 'status-dot--idle'}`}
              aria-hidden
            />
            <span className="text-text-secondary font-[560]">
              {isGenerating
                ? formatStatusAgentLabel(activeAgent)
                : isAwaitingPermission
                  ? t('chat.awaitingApproval', 'Awaiting approval')
                  : isAwaitingQuestion
                    ? t('chat.awaitingAnswer', 'Awaiting answer')
                    : t('statusbar.ready', 'Ready')}
            </span>
          </span>
          <span className="text-border">|</span>
          <span className="capitalize">{modelName}</span>
        </div>

        <div className="flex items-center gap-3">
          <McpStatusBadge />
          {showContext && (
            <div className="tabular flex items-center gap-1.5 min-w-[96px]">
              <Badge tone={contextTone} className="statusbar-badge">{contextLabel}</Badge>
              <span className="statusbar-meter">
                <span
                  className={`statusbar-meter__fill ${contextState === 'compacting' ? 'statusbar-meter__fill--compacting animate-pulse' : ''}`}
                  style={{
                    width: `${meterWidth}%`,
                    '--statusbar-meter-color': contextColor,
                  } as MeterStyle}
                />
              </span>
            </div>
          )}

          {/* Token/cost display */}
          {totalTokens > 0 && (
            <button
              onClick={() => setShowDetail(!showDetail)}
              className="tabular flex items-center gap-1.5 cursor-pointer hover:text-text-secondary transition-colors"
            >
              <span>{t('statusbar.tokensCount', '{{count}} tokens', { count: formatTokens(totalTokens) })}</span>
              <span className="text-border">|</span>
              <span>{formatCost(sessionCost, 'precise')}</span>
            </button>
          )}

        </div>
      </div>

      {/* Cost detail popup */}
      {showDetail && totalTokens > 0 && (
        <>
          <ModalBackdrop onDismiss={() => setShowDetail(false)} className="fixed inset-0 z-40" />
          <div className="tabular theme-popover absolute bottom-8 end-4 z-50 w-56 rounded-xl p-3">
            <div className="mb-2 text-2xs font-[750] uppercase tracking-[0.06em] text-text-muted">{t('statusbar.sessionUsage', 'Session Usage')}</div>
            <div className="flex flex-col gap-1.5 text-2xs">
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.inputTokens', 'Input tokens')}</span>
                <span className="text-text font-mono">{formatTokens(sessionTokens.input)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.outputTokens', 'Output tokens')}</span>
                <span className="text-text font-mono">{formatTokens(sessionTokens.output)}</span>
              </div>
              {sessionTokens.reasoning > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">{t('tokens.reasoning', 'Reasoning')}</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.reasoning)}</span>
                </div>
              )}
              {sessionTokens.cacheRead > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">{t('statusbar.cacheRead', 'Cache read')}</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.cacheRead)}</span>
                </div>
              )}
              {sessionTokens.cacheWrite > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">{t('statusbar.cacheWrite', 'Cache write')}</span>
                  <span className="text-text font-mono">{formatTokens(sessionTokens.cacheWrite)}</span>
                </div>
              )}
              <div className="border-t border-border-subtle my-1" />
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.contextWindow', 'Context window')}</span>
                <span className={`font-mono ${contextToneTextClass(contextTone)}`}>{contextDetail}</span>
              </div>
              {compactionCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-muted">{t('statusbar.compactions', 'Compactions')}</span>
                  <span className="text-text font-mono">{compactionCount}</span>
                </div>
              )}
              {lastCompactedAt && (
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">{t('statusbar.lastCompacted', 'Last compacted')}</span>
                  <span className="text-text font-mono text-right">{new Date(lastCompactedAt).toLocaleTimeString()}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.lastMeasuredInput', 'Last measured input')}</span>
                <span className="text-text font-mono">{formatTokens(lastInputTokens)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.sessionCost', 'Session cost')}</span>
                <span className="text-text font-mono font-medium">{formatCost(sessionCost, 'precise')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">{t('statusbar.totalAllSessions', 'Total (all sessions)')}</span>
                <span className="text-text font-mono">{formatCost(totalCost, 'precise')}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
