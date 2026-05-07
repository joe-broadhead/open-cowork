import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DashboardSummary,
  DashboardTimeRangeKey,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { loadSessionMessages } from '../helpers/loadSessionMessages'
import { formatCost } from '../helpers/format'
import { t } from '../helpers/i18n'
import { getModelContextLimit } from '../helpers/model-info'
import {
  ArrowUpRight,
  CircuitIcon,
  counterByName,
  DASHBOARD_RANGE_STORAGE_KEY,
  dashboardRangeOptions,
  DatabaseIcon,
  EMPTY_DIAGNOSTICS,
  FolderIcon,
  formatCompact,
  formatCounterValue,
  formatInteger,
  formatLeadAgentLabel,
  formatMetricValue,
  formatProviderLabel,
  formatRuntimeOptionValue,
  formatSourceLabel,
  formatThreadPath,
  LayersIcon,
  LEGACY_DASHBOARD_RANGE_STORAGE_KEY,
  LightningIcon,
  metricByName,
  PlusIcon,
  readStoredRange,
  type DiagnosticsState,
} from './pulse-page-support.tsx'
import {
  MetricCard,
  PulseHeader,
  Row,
  StatGrid,
  TagRail,
  UsageBar,
} from './pulse-page-components.tsx'

export function PulsePage({ onOpenThread, brandName }: { onOpenThread: () => void; brandName: string }) {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const busySessions = useSessionStore((s) => s.busySessions)
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>(EMPTY_DIAGNOSTICS)
  const [dashboardRange, setDashboardRange] = useState<DashboardTimeRangeKey>(readStoredRange)
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null)
  const [dashboardError, setDashboardError] = useState<string | null>(null)

  // Persist filter selection so the user's "All time" pick survives a
  // relaunch. Session-independent; one preference per install.
  useEffect(() => {
    try {
      window.localStorage.setItem(DASHBOARD_RANGE_STORAGE_KEY, dashboardRange)
      window.localStorage.removeItem(LEGACY_DASHBOARD_RANGE_STORAGE_KEY)
    } catch {
      /* Quota / disabled storage — non-fatal, selection just won't persist. */
    }
    // Invalidate any previously-loaded summary so we don't flash a
    // "Last 7 days" total while the new range's fetch is in flight.
    setDashboardSummary(null)
    setDashboardError(null)
  }, [dashboardRange])

  const busyCount = busySessions.size
  const connectedMcpCount = mcpConnections.filter((entry) => entry.connected).length
  const usageTotals = dashboardSummary?.totals || {
    threads: 0,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    taskRuns: 0,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  }
  const recentSessions = dashboardSummary?.recentSessions || []
  const runtimeOptionTags = useMemo(() => {
    const options = diagnostics.runtimeInputs?.providerOptions || {}
    return Object.entries(options).map(([key, value]) => `${key}: ${formatRuntimeOptionValue(value)}`)
  }, [diagnostics.runtimeInputs])
  const runtimeOverrideTags = diagnostics.runtimeInputs?.credentialOverrideKeys || []
  const totalTrackedTokens = useMemo(
    () => (
      usageTotals.tokens.input
      + usageTotals.tokens.output
      + usageTotals.tokens.reasoning
      + usageTotals.tokens.cacheRead
      + usageTotals.tokens.cacheWrite
    ),
    [usageTotals],
  )
  const tokenMix = useMemo(() => ({
    input: usageTotals.tokens.input,
    output: usageTotals.tokens.output,
    reasoning: usageTotals.tokens.reasoning,
    cache: usageTotals.tokens.cacheRead + usageTotals.tokens.cacheWrite,
  }), [usageTotals])

  // Memoize every derived slice of `diagnostics.*` so re-renders
  // driven by unrelated state (dashboardRange, mcp status, busy count)
  // don't re-traverse the agent lists. Low-cost individually, but the
  // dashboard re-renders frequently — every live session event. Pays
  // off under scale with many custom agents / many builtins.
  const enabledCustomAgents = useMemo(
    () => diagnostics.customAgents.filter((agent) => agent.enabled),
    [diagnostics.customAgents],
  )
  const invalidCustomAgents = useMemo(
    () => diagnostics.customAgents.filter((agent) => !agent.valid),
    [diagnostics.customAgents],
  )
  const visibleBuiltinAgents = useMemo(
    () => diagnostics.builtinAgents.filter((agent) => !agent.hidden),
    [diagnostics.builtinAgents],
  )
  const builtinWorkerCount = useMemo(
    () => visibleBuiltinAgents.filter((agent) => agent.mode === 'subagent').length,
    [visibleBuiltinAgents],
  )
  const primaryModeCount = useMemo(
    () => visibleBuiltinAgents.filter((agent) => agent.mode === 'primary').length,
    [visibleBuiltinAgents],
  )
  const topBuiltinAgentLabels = useMemo(
    () => visibleBuiltinAgents.slice(0, 6).map((agent) => agent.label),
    [visibleBuiltinAgents],
  )
  const leadAgent = useMemo(
    () => visibleBuiltinAgents.find((agent) => agent.mode === 'primary') || null,
    [visibleBuiltinAgents],
  )

  const historyLoadMetric = metricByName(diagnostics.perf, 'session.history.load')
  const coldSyncMetric = metricByName(diagnostics.perf, 'session.sync.cold')
  const flushMetric = metricByName(diagnostics.perf, 'session.view.flush.duration')
  const flushWaitMetric = metricByName(diagnostics.perf, 'session.view.flush.wait')
  const patchCounter = counterByName(diagnostics.perf, 'session.patch.published')
  const slowEvents = diagnostics.perf?.distributions.reduce((sum, metric) => sum + metric.slowCount, 0) || 0

  const statusPills = [
    {
      label: t('homepage.pill.runtime', 'Runtime'),
      value: diagnostics.runtimeReady
        ? t('homepage.pill.runtimeReady', 'Ready')
        : (diagnostics.loading
          ? t('homepage.pill.runtimeLoading', 'Loading diagnostics')
          : t('homepage.pill.runtimeNotReady', 'Not ready')),
      accent: diagnostics.runtimeReady ? 'var(--color-green)' : 'var(--color-amber)',
    },
    {
      label: t('homepage.pill.provider', 'Provider'),
      value: diagnostics.runtimeModel.providerId && diagnostics.runtimeModel.modelId
        ? `${formatProviderLabel(diagnostics.runtimeModel.providerId)} / ${diagnostics.runtimeModel.modelId}`
        : t('homepage.pill.providerNotConfigured', 'Not configured'),
    },
    {
      label: t('homepage.pill.context', 'Context'),
      value: diagnostics.runtimeModel.contextLimit
        ? t('homepage.pill.contextTokens', '{{count}} tokens', { count: formatCompact.format(diagnostics.runtimeModel.contextLimit) })
        : t('homepage.pill.contextUnknown', 'Unknown limit'),
    },
    {
      label: t('homepage.pill.mcp', 'MCP'),
      value: t('homepage.pill.mcpConnected', '{{connected}}/{{total}} connected', {
        connected: String(connectedMcpCount),
        total: String(mcpConnections.length),
      }),
      accent: connectedMcpCount === mcpConnections.length && mcpConnections.length > 0 ? 'var(--color-green)' : 'var(--color-accent)',
    },
    {
      label: t('homepage.pill.capabilities', 'Capabilities'),
      value: t('homepage.pill.capabilitiesSummary', '{{tools}} tools · {{skills}} skills', {
        tools: String(diagnostics.tools.length),
        skills: String(diagnostics.skills.length),
      }),
    },
  ]

  const refreshDiagnostics = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setDiagnostics((current) => ({ ...current, loading: true }))
    }

    const [
      runtimeStatusResult,
      settingsResult,
      modelInfoResult,
      capabilitySkillsResult,
      customMcpsResult,
      customSkillsResult,
      capabilityToolsResult,
      builtinAgentsResult,
      customAgentsResult,
      perfResult,
      dashboardSummaryResult,
      runtimeInputsResult,
    ] = await Promise.allSettled([
      window.coworkApi.runtime.status(),
      window.coworkApi.settings.get(),
      window.coworkApi.model.info(),
      window.coworkApi.capabilities.skills(),
      window.coworkApi.custom.listMcps(),
      window.coworkApi.custom.listSkills(),
      window.coworkApi.capabilities.tools(),
      window.coworkApi.app.builtinAgents(),
      window.coworkApi.agents.list(),
      window.coworkApi.diagnostics.perf(),
      window.coworkApi.app.dashboardSummary(dashboardRange),
      window.coworkApi.app.runtimeInputs(),
    ])

    const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null
    const modelInfo = modelInfoResult.status === 'fulfilled' ? modelInfoResult.value as any : null
    const modelId = settings?.effectiveModel || settings?.selectedModelId || null
    const providerId = settings?.effectiveProviderId || null
    const contextLimit = getModelContextLimit(modelInfo, providerId, modelId)

    setDiagnostics({
      loading: false,
      runtimeReady: runtimeStatusResult.status === 'fulfilled' ? runtimeStatusResult.value.ready : false,
      runtimeModel: {
        providerId,
        modelId,
        contextLimit,
      },
      runtimeInputs: runtimeInputsResult.status === 'fulfilled' ? runtimeInputsResult.value : null,
      skills: capabilitySkillsResult.status === 'fulfilled' ? capabilitySkillsResult.value : [],
      customMcps: customMcpsResult.status === 'fulfilled' ? customMcpsResult.value : [],
      customSkills: customSkillsResult.status === 'fulfilled' ? customSkillsResult.value : [],
      tools: capabilityToolsResult.status === 'fulfilled' ? capabilityToolsResult.value : [],
      builtinAgents: builtinAgentsResult.status === 'fulfilled' ? builtinAgentsResult.value : [],
      customAgents: customAgentsResult.status === 'fulfilled' ? customAgentsResult.value : [],
      perf: perfResult.status === 'fulfilled' ? perfResult.value : null,
      updatedAt: new Date().toISOString(),
    })
    if (dashboardSummaryResult.status === 'fulfilled') {
      setDashboardSummary(dashboardSummaryResult.value)
      setDashboardError(null)
    } else {
      // Surface the failure explicitly so users don't silently see
      // stale totals from the previous range selection.
      const reason = dashboardSummaryResult.reason
      setDashboardError(reason instanceof Error ? reason.message : t('homepage.warning.dashboardLoadFailed', 'Could not load dashboard totals.'))
    }
  }, [dashboardRange])

  useEffect(() => {
    let cancelled = false
    const runRefresh = async (silent = false) => {
      await refreshDiagnostics({ silent })
      if (cancelled) return
    }

    void runRefresh()
    const unsubscribeRuntimeReady = window.coworkApi.on.runtimeReady(() => {
      if (cancelled) return
      void runRefresh(true)
    })

    // Debounced silent refresh triggered by live session events. Coalesce
    // bursts (a single assistant turn fires many patches) into at most one
    // refresh per 800ms so the dashboard stays responsive without
    // hammering the main process on every streamed token.
    let debounceHandle: number | null = null
    const scheduleSilentRefresh = () => {
      if (cancelled) return
      if (debounceHandle !== null) return
      debounceHandle = window.setTimeout(() => {
        debounceHandle = null
        if (!cancelled) void runRefresh(true)
      }, 800)
    }

    const unsubscribeSessionPatch = window.coworkApi.on.sessionPatch(scheduleSilentRefresh)
    const unsubscribeSessionUpdated = window.coworkApi.on.sessionUpdated(scheduleSilentRefresh)
    const unsubscribeSessionDeleted = window.coworkApi.on.sessionDeleted(scheduleSilentRefresh)
    const unsubscribeDashboardUpdated = window.coworkApi.on.dashboardSummaryUpdated(scheduleSilentRefresh)

    const onFocus = () => {
      if (cancelled) return
      void runRefresh(true)
    }
    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      void runRefresh(true)
    }
    const interval = window.setInterval(() => {
      if (cancelled || document.visibilityState !== 'visible') return
      void runRefresh(true)
    }, 15000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      unsubscribeRuntimeReady()
      unsubscribeSessionPatch()
      unsubscribeSessionUpdated()
      unsubscribeSessionDeleted()
      unsubscribeDashboardUpdated()
      if (debounceHandle !== null) window.clearTimeout(debounceHandle)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(interval)
    }
  }, [refreshDiagnostics])

  async function createThread(directory?: string) {
    let sessionId: string | null = null
    try {
      const session = await window.coworkApi.session.create(directory)
      sessionId = session.id
      addSession(session)
      setCurrentSession(session.id)
      await window.coworkApi.session.activate(session.id)
      onOpenThread()
    } catch (err) {
      console.error('Failed to create thread:', err)
      if (sessionId) setCurrentSession(null)
    }
  }

  async function openRecentThread(sessionId: string) {
    onOpenThread()
    await loadSessionMessages(sessionId)
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div
        className="min-h-full"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-base) 97%, var(--color-elevated) 3%), var(--color-base) 100%)',
        }}
      >
        <div className="max-w-[1280px] mx-auto px-8 py-8">
          <section
            className="rounded-[30px] border border-border-subtle overflow-hidden"
            style={{
              background: 'color-mix(in srgb, var(--color-elevated) 98%, var(--color-base) 2%)',
              boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 3%, transparent)',
            }}
          >
            <PulseHeader
              brandName={brandName}
              statusPills={statusPills}
              dashboardRange={dashboardRange}
              dashboardError={dashboardError}
              backfillFailedCount={dashboardSummary?.backfillFailedCount || 0}
              backfillPendingCount={dashboardSummary?.backfillPendingCount || 0}
              loading={diagnostics.loading}
              onDashboardRangeChange={setDashboardRange}
              onRefresh={() => void refreshDiagnostics()}
            />

            <div className="grid grid-cols-[minmax(0,1.3fr)_340px] gap-0 max-[1080px]:grid-cols-1">
              <div className="p-6">
                <div className="grid grid-cols-2 gap-5 max-[820px]:grid-cols-1">
                  <MetricCard icon={<CircuitIcon />} eyebrow={t('homepage.pill.capabilities', 'Capabilities')} title={t('homepage.card.toolsAndSkills', 'Tools and skills')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.configuredTools', 'Configured tools'), value: formatInteger.format(diagnostics.tools.length), tone: 'accent' },
                        { label: t('homepage.card.activeSkills', 'Active skills'), value: formatInteger.format(diagnostics.skills.length) },
                        { label: t('homepage.card.customSkills', 'Custom skills'), value: formatInteger.format(diagnostics.customSkills.length) },
                        { label: t('homepage.card.customMcps', 'Custom MCPs'), value: formatInteger.format(diagnostics.customMcps.length) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label={t('homepage.card.connectedMcps', 'Connected MCPs')} value={`${connectedMcpCount}/${mcpConnections.length}`} tone="accent" />
                      <Row label={t('homepage.card.bundledTools', 'Bundled tools')} value={formatInteger.format(diagnostics.tools.filter((tool) => tool.source === 'builtin').length)} />
                      <Row label={t('homepage.card.customTools', 'Custom tools')} value={formatInteger.format(diagnostics.tools.filter((tool) => tool.source === 'custom').length)} />
                    </div>
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">{t('homepage.side.availableTools', 'Available tools')}</div>
                      <TagRail
                        items={diagnostics.tools.slice(0, 6).map((tool) => tool.name)}
                        emptyLabel={t('homepage.card.noToolsDiscovered', 'No tools discovered yet.')}
                      />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<LayersIcon />} eyebrow={t('sidebar.agents', 'Agents')} title={t('homepage.card.agents', 'Built-in and custom agents')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.primaryModes', 'Primary modes'), value: formatInteger.format(primaryModeCount), tone: 'accent' },
                        { label: t('homepage.card.builtinAgents', 'Built-in agents'), value: formatInteger.format(visibleBuiltinAgents.length) },
                        { label: t('homepage.card.enabledCustomAgents', 'Custom enabled'), value: formatInteger.format(enabledCustomAgents.length) },
                        { label: t('homepage.card.invalidAgents', 'Needs attention'), value: formatInteger.format(invalidCustomAgents.length) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label={t('homepage.card.leadAgent', 'Lead agent')} value={formatLeadAgentLabel(leadAgent)} tone="accent" />
                      <Row label={t('homepage.card.primaryMode', 'Primary mode')} value={leadAgent ? leadAgent.label : '—'} />
                      <Row label={t('homepage.card.availableSubAgents', 'Sub-agents available')} value={formatInteger.format(builtinWorkerCount + enabledCustomAgents.length)} />
                    </div>
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">{t('homepage.card.visibleBuiltins', 'Visible built-ins')}</div>
                      <TagRail
                        items={topBuiltinAgentLabels}
                        emptyLabel={t('homepage.card.noBuiltinAgents', 'No built-in agents are available.')}
                      />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<DatabaseIcon />} eyebrow={t('homepage.card.usageEyebrow', 'Usage')} title={t('homepage.card.usage', 'Threads, tokens, and cost')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.threads', 'Threads'), value: formatInteger.format(usageTotals.threads), tone: 'accent' },
                        { label: t('homepage.card.totalMessages', 'Messages'), value: formatInteger.format(usageTotals.messages) },
                        { label: t('homepage.card.trackedTokens', 'Tracked tokens'), value: formatCompact.format(totalTrackedTokens) },
                        { label: t('homepage.card.trackedCost', 'Tracked cost'), value: formatCost(usageTotals.cost) },
                      ]}
                    />
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">{t('homepage.card.tokenMix', 'Token mix')}</div>
                      <UsageBar
                        segments={[
                          { label: t('tokens.input', 'Input'), value: tokenMix.input, color: 'color-mix(in srgb, var(--color-accent) 85%, white)' },
                          { label: t('tokens.output', 'Output'), value: tokenMix.output, color: 'color-mix(in srgb, var(--color-green) 80%, white)' },
                          { label: t('tokens.reasoning', 'Reasoning'), value: tokenMix.reasoning, color: 'color-mix(in srgb, var(--color-amber) 85%, white)' },
                          { label: t('tokens.cache', 'Cache'), value: tokenMix.cache, color: 'color-mix(in srgb, var(--color-text-muted) 65%, white)' },
                        ]}
                      />
                    </div>
                    <div className="mt-4 space-y-3">
                      <Row label={t('homepage.card.userMessages', 'User messages')} value={formatInteger.format(usageTotals.userMessages)} />
                      <Row label={t('homepage.card.assistantMessages', 'Assistant messages')} value={formatInteger.format(usageTotals.assistantMessages)} />
                      <Row label={t('homepage.card.toolCalls', 'Tool calls')} value={formatInteger.format(usageTotals.toolCalls)} />
                      <Row label={t('homepage.card.busyRightNow', 'Busy right now')} value={formatInteger.format(busyCount)} />
                      <Row label={t('homepage.card.window', 'Window')} value={dashboardSummary?.range.label || dashboardRangeOptions().find((o) => o.key === dashboardRange)?.label || ''} tone="accent" />
                      <Row label={t('homepage.card.usageRefreshed', 'Usage refreshed')} value={dashboardSummary ? new Date(dashboardSummary.generatedAt).toLocaleTimeString() : t('homepage.card.notLoaded', 'Not loaded')} tone="muted" />
                    </div>
                    <div
                      className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                      style={{
                        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                      }}
                    >
                      {t('homepage.card.historicalUsageNote', 'Historical usage is persisted per thread and overlaid with any currently hydrated live session state, so these totals no longer depend on opening threads first.')}
                      {dashboardSummary?.backfilledSessions
                        ? t('homepage.card.backfillCompleted', ' Refreshed {{count}} older thread summary/summaries in the background.', { count: String(dashboardSummary.backfilledSessions) })
                        : ''}
                    </div>
                    <div className="mt-4 space-y-3">
                      <Row label={t('homepage.card.currentModel', 'Current model')} value={diagnostics.runtimeModel.modelId || t('homepage.card.notSet', 'Not set')} />
                      <Row label={t('homepage.card.contextWindow', 'Context window')} value={diagnostics.runtimeModel.contextLimit ? t('homepage.pill.contextTokens', '{{count}} tokens', { count: formatCompact.format(diagnostics.runtimeModel.contextLimit) }) : t('homepage.card.unknownLimit', 'Unknown')} />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<LayersIcon />} eyebrow={t('homepage.card.agentUsageEyebrow', 'Agent usage')} title={t('homepage.card.agentUsage', 'Cost and tokens by sub-agent')}>
                    {(dashboardSummary?.topAgents || []).length > 0 ? (
                      <div className="flex flex-col">
                        {(dashboardSummary?.topAgents || []).slice(0, 5).map((entry) => {
                          const entryTokens = entry.tokens.input + entry.tokens.output + entry.tokens.reasoning + entry.tokens.cacheRead + entry.tokens.cacheWrite
                          const agentLabel = entry.agent
                            ? entry.agent.split(/[-_]/g).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
                            : t('homepage.card.unknownSubAgent', 'Unknown sub-agent')
                          return (
                            <div
                              key={entry.agent || '(unknown)'}
                              className="flex items-center justify-between gap-3 py-2 border-b border-border-subtle last:border-b-0"
                            >
                              <div className="min-w-0">
                                <div className="text-[12px] font-medium text-text truncate">{agentLabel}</div>
                                <div className="text-[10px] text-text-muted mt-0.5">
                                  {entry.taskRuns} {t('homepage.card.tasks', 'task(s)')}
                                </div>
                              </div>
                              <div className="shrink-0 text-right font-mono tabular-nums">
                                <div className="text-[12px] text-text">{formatCost(entry.cost)}</div>
                                <div className="text-[10px] text-text-muted">{formatCompact.format(entryTokens)} {t('homepage.card.tokShort', 'tok')}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div
                        className="rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                        style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                      >
                        {t('homepage.card.agentUsageEmpty', 'No sub-agent delegations in {{window}}. Once a primary agent dispatches work to Research / Explore / Writer / any custom specialist, their cost and token usage rolls up here.', { window: dashboardSummary?.range.label?.toLowerCase() || t('homepage.card.selectedWindow', 'the selected window') })}
                      </div>
                    )}
                  </MetricCard>

                  <MetricCard icon={<LightningIcon />} eyebrow={t('homepage.card.perfEyebrow', 'Performance')} title={t('homepage.card.perf', 'Hydration and patch flow')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.historyLoadP95', 'History load p95'), value: formatMetricValue(historyLoadMetric), tone: 'accent' },
                        { label: t('homepage.card.coldSyncP95', 'Cold sync p95'), value: formatMetricValue(coldSyncMetric) },
                        { label: t('homepage.card.flushP95', 'Flush p95'), value: formatMetricValue(flushMetric) },
                        { label: t('homepage.card.slowEvents', 'Slow events'), value: formatInteger.format(slowEvents) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label={t('homepage.card.flushWaitP95', 'Flush wait p95')} value={formatMetricValue(flushWaitMetric)} />
                      <Row label={t('homepage.card.patchPublishes', 'Patch publishes')} value={formatCounterValue(patchCounter)} />
                      <Row label={t('homepage.card.telemetrySamples', 'Telemetry samples')} value={diagnostics.perf ? formatInteger.format(diagnostics.perf.distributions.reduce((sum, metric) => sum + metric.count, 0)) : '0'} />
                    </div>
                    <div
                      className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                      style={{
                        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                      }}
                    >
                      {diagnostics.perf && diagnostics.perf.distributions.length > 0
                        ? t('homepage.card.perfLiveNote', 'Diagnostics are live from the main-process engine. The numbers here come from the same hydration and patch pipelines the chat view uses.')
                        : t('homepage.card.perfEmptyHint', 'No perf telemetry captured yet. Open a thread, stream a response, then come back here to inspect runtime timings.')}
                    </div>
                  </MetricCard>
                </div>
              </div>

              <aside
                className="border-s max-[1080px]:border-s-0 max-[1080px]:border-t border-border-subtle p-5 flex flex-col gap-5"
                style={{ background: 'color-mix(in srgb, var(--color-base) 95%, var(--color-elevated) 5%)' }}
              >
                <section
                  className="rounded-[24px] border border-border-subtle overflow-hidden"
                  style={{
                    background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
                    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
                  }}
                >
                  <div className="px-4 py-4 border-b border-border-subtle">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.recentWork', 'Recent work')}</div>
                    <div className="mt-2 text-[18px] font-semibold text-text">{t('homepage.side.resumeThreads', 'Resume threads')}</div>
                  </div>
                  <div className="p-3 flex flex-col gap-2.5">
                    {recentSessions.length > 0 ? (
                      recentSessions.map((session) => {
                        const isBusy = busySessions.has(session.id)
                        return (
                          <button
                            key={session.id}
                            onClick={() => void openRecentThread(session.id)}
                            className="w-full rounded-2xl px-4 py-3 text-start hover:bg-surface-hover transition-colors cursor-pointer"
                            style={{
                              background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
                              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                            }}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  {isBusy ? (
                                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-accent animate-pulse" />
                                  ) : (
                                    <span
                                      className="w-1.5 h-1.5 rounded-full shrink-0"
                                      style={{ background: 'color-mix(in srgb, var(--color-text-muted) 50%, transparent)' }}
                                    />
                                  )}
                                  <span className="text-[13px] font-medium text-text truncate">{session.title || t('sidebar.threadFallback', 'Thread {{id}}', { id: session.id.slice(0, 6) })}</span>
                                </div>
                                <div className="mt-1 text-[11px] text-text-muted truncate">
                                  {formatThreadPath(session.directory)} · {new Date(session.updatedAt).toLocaleDateString()}
                                </div>
                              </div>
                              <span className="text-text-muted shrink-0"><ArrowUpRight /></span>
                            </div>
                          </button>
                        )
                      })
                    ) : (
                      <div
                        className="rounded-2xl px-4 py-6 text-[12px] leading-relaxed text-text-muted"
                        style={{
                          background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
                          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                        }}
                      >
                        {t('homepage.side.noRecentThreads', 'No threads in {{window}} yet. Start one from the actions below and the home page becomes your queue.', { window: dashboardSummary?.range.label?.toLowerCase() || t('homepage.side.selectedPeriod', 'the selected period') })}
                      </div>
                    )}
                  </div>
                </section>

                <section
                  className="rounded-[24px] border border-border-subtle overflow-hidden"
                  style={{
                    background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
                    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
                  }}
                >
                  <div className="px-4 py-4 border-b border-border-subtle">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.actions', 'Actions')}</div>
                    <div className="mt-2 text-[18px] font-semibold text-text">{t('homepage.side.openWorkingSurface', 'Open a working surface')}</div>
                  </div>
                  <div className="p-3 grid grid-cols-1 gap-2.5">
                    <button
                      onClick={() => void createThread()}
                      className="rounded-2xl hover:bg-surface-hover px-4 py-3 text-start transition-colors cursor-pointer"
                      style={{
                        background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
                        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-surface text-text-secondary"
                          style={{
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                          }}
                        >
                          <PlusIcon />
                        </span>
                        <span className="text-text-muted"><ArrowUpRight /></span>
                      </div>
                      <div className="mt-4 text-[14px] font-semibold text-text">{t('homepage.side.newThread', 'New thread')}</div>
                      <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                        {t('homepage.side.newThreadHint', 'Open a fresh workspace-bound conversation.')}
                      </div>
                    </button>

                    <button
                      onClick={async () => {
                        const dir = await window.coworkApi.dialog.selectDirectory()
                        if (dir) await createThread(dir)
                      }}
                      className="rounded-2xl hover:bg-surface-hover px-4 py-3 text-start transition-colors cursor-pointer"
                      style={{
                        background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)',
                        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-surface text-text-secondary"
                          style={{
                            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
                          }}
                        >
                          <FolderIcon />
                        </span>
                        <span className="text-text-muted"><ArrowUpRight /></span>
                      </div>
                      <div className="mt-4 text-[14px] font-semibold text-text">{t('homepage.side.openDirectory', 'Open directory')}</div>
                      <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                        {t('homepage.side.openDirectoryHint', 'Ground the next session in a real codebase or project folder.')}
                      </div>
                    </button>
                  </div>
                </section>

                <section
                  className="rounded-[24px] border border-border-subtle px-4 py-4"
                  style={{
                    background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
                    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
                  }}
                >
                  <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.currentInventory', 'Current inventory')}</div>
                  <div className="mt-3 flex flex-col gap-3">
                    <Row label={t('homepage.side.availableTools', 'Available tools')} value={formatInteger.format(diagnostics.tools.length)} />
                    <Row label={t('homepage.card.leadAgent', 'Lead agent')} value={formatLeadAgentLabel(leadAgent)} />
                    <Row label={t('homepage.side.skillBundles', 'Skill bundles')} value={formatInteger.format(diagnostics.skills.length)} />
                  </div>
                </section>

                <section
                  className="rounded-[24px] border border-border-subtle px-4 py-4"
                  style={{
                    background: 'color-mix(in srgb, var(--color-surface) 40%, var(--color-elevated) 60%)',
                    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text) 2.5%, transparent)',
                  }}
                >
                  <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.runtimeInputs', 'Runtime inputs')}</div>
                  <div className="mt-3 flex flex-col gap-3">
                    <Row label={t('homepage.side.opencodeVersion', 'OpenCode')} value={diagnostics.runtimeInputs?.opencodeVersion || t('common.unknown', 'Unknown')} />
                    <Row
                      label={t('homepage.side.providerName', 'Provider')}
                      value={diagnostics.runtimeInputs?.providerName || formatProviderLabel(diagnostics.runtimeInputs?.providerId) || t('homepage.pill.providerNotConfigured', 'Not configured')}
                    />
                    <Row
                      label={t('homepage.side.providerSource', 'Provider source')}
                      value={diagnostics.runtimeInputs ? formatSourceLabel(diagnostics.runtimeInputs.providerSource) : t('common.unknown', 'Unknown')}
                      tone="muted"
                    />
                    <Row
                      label={t('homepage.side.model', 'Model')}
                      value={diagnostics.runtimeInputs?.modelId || diagnostics.runtimeModel.modelId || t('homepage.pill.providerNotConfigured', 'Not configured')}
                    />
                    <Row
                      label={t('homepage.side.modelSource', 'Model source')}
                      value={diagnostics.runtimeInputs ? formatSourceLabel(diagnostics.runtimeInputs.modelSource) : t('common.unknown', 'Unknown')}
                      tone="muted"
                    />
                    <Row label={t('homepage.side.package', 'Package')} value={diagnostics.runtimeInputs?.providerPackage || t('homepage.side.packageFallback', 'Built-in/runtime')} tone="muted" />
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.providerOptions', 'Provider options')}</div>
                    <div className="mt-2">
                      <TagRail items={runtimeOptionTags} emptyLabel={t('homepage.side.noOptions', 'No non-secret provider options exposed.')} />
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.side.credentialOverrides', 'Credential overrides')}</div>
                    <div className="mt-2">
                      <TagRail items={runtimeOverrideTags} emptyLabel={t('homepage.side.usingDefaults', 'Using config defaults.')} />
                    </div>
                  </div>
                </section>
              </aside>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
