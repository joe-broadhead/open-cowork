import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilityTool,
  CustomMcpConfig,
  CustomAgentSummary,
  PerfCounterSnapshot,
  PerfDistributionSnapshot,
  PerfSnapshot,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { loadSessionMessages } from '../helpers/loadSessionMessages'

type RuntimeModel = {
  providerId: string | null
  modelId: string | null
  contextLimit: number | null
}

type DiagnosticsState = {
  loading: boolean
  runtimeReady: boolean
  runtimeModel: RuntimeModel
  skills: CapabilitySkill[]
  customMcps: CustomMcpConfig[]
  customSkills: Array<{ name: string; content: string }>
  tools: CapabilityTool[]
  builtinAgents: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
  perf: PerfSnapshot | null
  updatedAt: string | null
}

const EMPTY_DIAGNOSTICS: DiagnosticsState = {
  loading: true,
  runtimeReady: false,
  runtimeModel: {
    providerId: null,
    modelId: null,
    contextLimit: null,
  },
  skills: [],
  customMcps: [],
  customSkills: [],
  tools: [],
  builtinAgents: [],
  customAgents: [],
  perf: null,
  updatedAt: null,
}

const formatInteger = new Intl.NumberFormat('en-US')
const formatCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function ArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10L10 4" />
      <path d="M5 4H10V9" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round">
      <path d="M7 3v8" />
      <path d="M3 7h8" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.75 4.25h3.2l1.15 1.25h6.15v4.9a1.1 1.1 0 0 1-1.1 1.1H2.85a1.1 1.1 0 0 1-1.1-1.1v-5.05Z" />
      <path d="M1.75 4.2V3.55a1.05 1.05 0 0 1 1.05-1.05h2l1 1.15h1.35" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.25 5.25A4.75 4.75 0 0 0 3.9 3.7" />
      <path d="M11.25 2.75v2.5h-2.5" />
      <path d="M2.75 8.75A4.75 4.75 0 0 0 10.1 10.3" />
      <path d="M2.75 11.25v-2.5h2.5" />
    </svg>
  )
}

function DatabaseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="7" cy="3" rx="4.25" ry="1.75" />
      <path d="M2.75 3v3.75C2.75 7.72 4.65 8.5 7 8.5s4.25-.78 4.25-1.75V3" />
      <path d="M2.75 6.75v3.25C2.75 10.97 4.65 11.75 7 11.75s4.25-.78 4.25-1.75V6.75" />
    </svg>
  )
}

function CircuitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="3" r="1.1" />
      <circle cx="11" cy="3" r="1.1" />
      <circle cx="7" cy="11" r="1.1" />
      <path d="M4.1 3h2.1L7 5.6V9.9" />
      <path d="M9.9 3H7.8" />
    </svg>
  )
}

function LightningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.75 1.75 3.9 7h2.55L5.8 12.25 10.1 6.9H7.45l.3-5.15Z" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 2 4.75 2.55L7 7.1 2.25 4.55 7 2Z" />
      <path d="m2.25 7 4.75 2.55L11.75 7" />
      <path d="m2.25 9.95 4.75 2.55 4.75-2.55" />
    </svg>
  )
}

function formatCost(value: number) {
  return `$${value.toFixed(2)}`
}

function formatProviderLabel(providerId: string | null | undefined) {
  if (!providerId) return 'No provider'
  return providerId
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatLeadAgentLabel(agent: BuiltInAgentDetail | null) {
  if (!agent) return 'Unknown'
  return agent.label
}

function formatThreadPath(directory?: string | null) {
  if (!directory) return 'Sandbox thread'
  const parts = directory.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || directory
}

function ratio(value: number, total: number) {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

function metricByName(perf: PerfSnapshot | null, name: string) {
  return perf?.distributions.find((metric) => metric.name === name) || null
}

function counterByName(perf: PerfSnapshot | null, name: string) {
  return perf?.counters.find((metric) => metric.name === name) || null
}

function formatMetricValue(metric: PerfDistributionSnapshot | null, accessor: 'p95' | 'avg' | 'last' = 'p95') {
  if (!metric || metric.count === 0) return '—'
  const value = metric[accessor]
  if (metric.unit === 'ms') return `${value.toFixed(value >= 10 ? 0 : 1)} ms`
  return formatInteger.format(Math.round(value))
}

function formatCounterValue(metric: PerfCounterSnapshot | null) {
  if (!metric) return '—'
  return formatCompact.format(metric.value)
}

function Pill({
  label,
  value,
  accent = 'var(--color-accent)',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div
      className="rounded-2xl border border-border-subtle px-3.5 py-3"
      style={{
        background: 'color-mix(in srgb, var(--color-elevated) 88%, var(--color-base) 12%)',
        boxShadow: `inset 0 1px 0 color-mix(in srgb, ${accent} 8%, transparent)`,
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-[13px] font-medium text-text truncate">{value}</div>
    </div>
  )
}

function MetricCard({
  icon,
  eyebrow,
  title,
  children,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <section
      className="rounded-[26px] border border-border-subtle overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)' }}
    >
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{eyebrow}</div>
          <div className="mt-2 text-[18px] font-semibold text-text">{title}</div>
        </div>
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-border-subtle bg-surface text-text-secondary">
          {icon}
        </span>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

function StatGrid({
  items,
}: {
  items: Array<{ label: string; value: string; tone?: 'default' | 'accent' }>
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-border-subtle px-3.5 py-3 bg-surface/80">
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">{item.label}</div>
          <div
            className="mt-2 text-[22px] leading-none font-semibold font-mono"
            style={{ color: item.tone === 'accent' ? 'var(--color-accent)' : 'var(--color-text)' }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'muted'
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-[12px]">
      <span className="text-text-muted">{label}</span>
      <span
        className="font-medium"
        style={{
          color: tone === 'accent'
            ? 'var(--color-accent)'
            : tone === 'muted'
              ? 'var(--color-text-secondary)'
              : 'var(--color-text)',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function TagRail({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-[12px] text-text-muted">{emptyLabel}</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className="px-2.5 py-1 rounded-full border border-border-subtle bg-surface text-[11px] text-text-secondary">
          {item}
        </span>
      ))}
    </div>
  )
}

function UsageBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="h-2 rounded-full overflow-hidden bg-surface border border-border-subtle flex">
        {segments.map((segment) => (
          <div
            key={segment.label}
            style={{
              width: `${total > 0 ? (segment.value / total) * 100 : 0}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: segment.color }} />
            {segment.label} {total > 0 ? `${ratio(segment.value, total)}%` : '0%'}
          </span>
        ))}
      </div>
    </div>
  )
}

export function HomePage({ onOpenThread, brandName }: { onOpenThread: () => void; brandName: string }) {
  const sessions = useSessionStore((s) => s.sessions)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const busySessions = useSessionStore((s) => s.busySessions)
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const sessionStateById = useSessionStore((s) => s.sessionStateById)
  const totalCost = useSessionStore((s) => s.totalCost)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>(EMPTY_DIAGNOSTICS)

  const recentSessions = useMemo(() => sessions.slice(0, 6), [sessions])
  const busyCount = busySessions.size
  const connectedMcpCount = mcpConnections.filter((entry) => entry.connected).length
  const totalTrackedTokens = useMemo(
    () => Object.values(sessionStateById).reduce((sum, state) => (
      sum
      + state.sessionTokens.input
      + state.sessionTokens.output
      + state.sessionTokens.reasoning
      + state.sessionTokens.cacheRead
      + state.sessionTokens.cacheWrite
    ), 0),
    [sessionStateById],
  )
  const tokenMix = useMemo(() => Object.values(sessionStateById).reduce((acc, state) => ({
    input: acc.input + state.sessionTokens.input,
    output: acc.output + state.sessionTokens.output,
    reasoning: acc.reasoning + state.sessionTokens.reasoning,
    cache: acc.cache + state.sessionTokens.cacheRead + state.sessionTokens.cacheWrite,
  }), { input: 0, output: 0, reasoning: 0, cache: 0 }), [sessionStateById])

  const enabledCustomAgents = diagnostics.customAgents.filter((agent) => agent.enabled)
  const invalidCustomAgents = diagnostics.customAgents.filter((agent) => !agent.valid)
  const builtinWorkerCount = diagnostics.builtinAgents.filter((agent) => agent.mode === 'subagent' && !agent.hidden).length
  const leadAgent = diagnostics.builtinAgents.find((agent) => agent.mode === 'primary' && !agent.hidden)
    || null

  const historyLoadMetric = metricByName(diagnostics.perf, 'session.history.load')
  const coldSyncMetric = metricByName(diagnostics.perf, 'session.sync.cold')
  const flushMetric = metricByName(diagnostics.perf, 'session.view.flush.duration')
  const flushWaitMetric = metricByName(diagnostics.perf, 'session.view.flush.wait')
  const patchCounter = counterByName(diagnostics.perf, 'session.patch.published')
  const slowEvents = diagnostics.perf?.distributions.reduce((sum, metric) => sum + metric.slowCount, 0) || 0

  const statusPills = [
    {
      label: 'Runtime',
      value: diagnostics.runtimeReady ? 'Ready' : (diagnostics.loading ? 'Loading diagnostics' : 'Not ready'),
      accent: diagnostics.runtimeReady ? 'var(--color-green)' : 'var(--color-amber)',
    },
    {
      label: 'Provider',
      value: diagnostics.runtimeModel.providerId && diagnostics.runtimeModel.modelId
        ? `${formatProviderLabel(diagnostics.runtimeModel.providerId)} / ${diagnostics.runtimeModel.modelId}`
        : 'Not configured',
    },
    {
      label: 'Context',
      value: diagnostics.runtimeModel.contextLimit
        ? `${formatCompact.format(diagnostics.runtimeModel.contextLimit)} tokens`
        : 'Unknown limit',
    },
    {
      label: 'MCP',
      value: `${connectedMcpCount}/${mcpConnections.length} connected`,
      accent: connectedMcpCount === mcpConnections.length && mcpConnections.length > 0 ? 'var(--color-green)' : 'var(--color-accent)',
    },
    {
      label: 'Capabilities',
      value: `${diagnostics.tools.length} tools · ${diagnostics.skills.length} skills`,
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
    ] = await Promise.allSettled([
      window.openCowork.runtime.status(),
      window.openCowork.settings.get(),
      window.openCowork.model.info(),
      window.openCowork.capabilities.skills(),
      window.openCowork.custom.listMcps(),
      window.openCowork.custom.listSkills(),
      window.openCowork.capabilities.tools(),
      window.openCowork.app.builtinAgents(),
      window.openCowork.agents.list(),
      window.openCowork.diagnostics.perf(),
    ])

    const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null
    const modelInfo = modelInfoResult.status === 'fulfilled' ? modelInfoResult.value as any : null
    const modelId = settings?.effectiveModel || settings?.selectedModelId || null
    const providerId = settings?.effectiveProviderId || null
    const contextLimit = modelId && modelInfo?.contextLimits
      ? modelInfo.contextLimits[modelId] || null
      : null

    setDiagnostics({
      loading: false,
      runtimeReady: runtimeStatusResult.status === 'fulfilled' ? runtimeStatusResult.value.ready : false,
      runtimeModel: {
        providerId,
        modelId,
        contextLimit,
      },
      skills: capabilitySkillsResult.status === 'fulfilled' ? capabilitySkillsResult.value : [],
      customMcps: customMcpsResult.status === 'fulfilled' ? customMcpsResult.value : [],
      customSkills: customSkillsResult.status === 'fulfilled' ? customSkillsResult.value : [],
      tools: capabilityToolsResult.status === 'fulfilled' ? capabilityToolsResult.value : [],
      builtinAgents: builtinAgentsResult.status === 'fulfilled' ? builtinAgentsResult.value : [],
      customAgents: customAgentsResult.status === 'fulfilled' ? customAgentsResult.value : [],
      perf: perfResult.status === 'fulfilled' ? perfResult.value : null,
      updatedAt: new Date().toISOString(),
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const runRefresh = async (silent = false) => {
      await refreshDiagnostics({ silent })
      if (cancelled) return
    }

    void runRefresh()
    const unsubscribeRuntimeReady = window.openCowork.on.runtimeReady(() => {
      if (cancelled) return
      void runRefresh(true)
    })
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
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(interval)
    }
  }, [refreshDiagnostics])

  async function createThread(directory?: string) {
    let sessionId: string | null = null
    try {
      const session = await window.openCowork.session.create(directory)
      sessionId = session.id
      addSession(session)
      setCurrentSession(session.id)
      await window.openCowork.session.activate(session.id)
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
            style={{ background: 'color-mix(in srgb, var(--color-elevated) 96%, var(--color-base) 4%)' }}
          >
            <div className="px-7 py-6 border-b border-border-subtle">
              <div className="flex items-start justify-between gap-6 flex-wrap">
                <div className="max-w-[720px]">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-medium border border-border-subtle bg-surface text-text-secondary">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                    {brandName} Diagnostics
                  </div>
                  <h1 className="mt-4 text-[34px] leading-[1.02] tracking-[-0.04em] font-semibold text-text max-[720px]:text-[29px]">
                    Workspace state, capabilities, and runtime health in one view.
                  </h1>
                  <p className="mt-3 text-[13px] leading-relaxed text-text-secondary max-w-[640px]">
                    Use home as an observability surface, not a splash screen. Check what is loaded, what is connected, what the runtime is using, and where to jump back in.
                  </p>
                </div>

                <button
                  onClick={() => void refreshDiagnostics()}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-2xl border border-border-subtle bg-surface hover:bg-surface-hover text-[12px] text-text-secondary transition-colors cursor-pointer"
                >
                  <RefreshIcon />
                  {diagnostics.loading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <div className="mt-6 grid grid-cols-5 gap-3 max-[1160px]:grid-cols-3 max-[760px]:grid-cols-2">
                {statusPills.map((pill) => (
                  <Pill key={pill.label} label={pill.label} value={pill.value} accent={pill.accent} />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-[minmax(0,1.3fr)_340px] gap-0 max-[1080px]:grid-cols-1">
              <div className="p-6">
                <div className="grid grid-cols-2 gap-5 max-[820px]:grid-cols-1">
                  <MetricCard icon={<CircuitIcon />} eyebrow="Capabilities" title="Tools and skills">
                    <StatGrid
                      items={[
                        { label: 'Configured tools', value: formatInteger.format(diagnostics.tools.length), tone: 'accent' },
                        { label: 'Active skills', value: formatInteger.format(diagnostics.skills.length) },
                        { label: 'Custom skills', value: formatInteger.format(diagnostics.customSkills.length) },
                        { label: 'Custom MCPs', value: formatInteger.format(diagnostics.customMcps.length) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label="Connected MCPs" value={`${connectedMcpCount}/${mcpConnections.length}`} tone="accent" />
                      <Row label="Bundled tools" value={formatInteger.format(diagnostics.tools.filter((tool) => tool.source === 'builtin').length)} />
                      <Row label="Custom tools" value={formatInteger.format(diagnostics.tools.filter((tool) => tool.source === 'custom').length)} />
                    </div>
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">Available tools</div>
                      <TagRail
                        items={diagnostics.tools.slice(0, 6).map((tool) => tool.name)}
                        emptyLabel="No tools discovered yet."
                      />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<LayersIcon />} eyebrow="Agents" title="Built-in and custom agents">
                    <StatGrid
                      items={[
                        { label: 'Primary modes', value: formatInteger.format(diagnostics.builtinAgents.filter((agent) => agent.mode === 'primary' && !agent.hidden).length), tone: 'accent' },
                        { label: 'Built-in agents', value: formatInteger.format(diagnostics.builtinAgents.filter((agent) => !agent.hidden).length) },
                        { label: 'Custom enabled', value: formatInteger.format(enabledCustomAgents.length) },
                        { label: 'Needs attention', value: formatInteger.format(invalidCustomAgents.length) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label="Lead agent" value={formatLeadAgentLabel(leadAgent)} tone="accent" />
                      <Row label="Primary mode" value={leadAgent ? leadAgent.label : '—'} />
                      <Row label="Sub-agents available" value={formatInteger.format(builtinWorkerCount + enabledCustomAgents.length)} />
                    </div>
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">Visible built-ins</div>
                      <TagRail
                        items={diagnostics.builtinAgents.filter((agent) => !agent.hidden).slice(0, 6).map((agent) => agent.label)}
                        emptyLabel="No built-in agents are available."
                      />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<DatabaseIcon />} eyebrow="Usage" title="Threads, tokens, and cost">
                    <StatGrid
                      items={[
                        { label: 'Threads', value: formatInteger.format(sessions.length), tone: 'accent' },
                        { label: 'Busy', value: formatInteger.format(busyCount) },
                        { label: 'Tracked tokens', value: formatCompact.format(totalTrackedTokens) },
                        { label: 'Tracked cost', value: formatCost(totalCost) },
                      ]}
                    />
                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">Token mix</div>
                      <UsageBar
                        segments={[
                          { label: 'Input', value: tokenMix.input, color: 'color-mix(in srgb, var(--color-accent) 85%, white)' },
                          { label: 'Output', value: tokenMix.output, color: 'color-mix(in srgb, var(--color-green) 80%, white)' },
                          { label: 'Reasoning', value: tokenMix.reasoning, color: 'color-mix(in srgb, var(--color-amber) 85%, white)' },
                          { label: 'Cache', value: tokenMix.cache, color: 'color-mix(in srgb, var(--color-text-muted) 65%, white)' },
                        ]}
                      />
                    </div>
                    <div className="mt-4 space-y-3">
                      <Row label="Current model" value={diagnostics.runtimeModel.modelId || 'Not set'} />
                      <Row label="Context window" value={diagnostics.runtimeModel.contextLimit ? `${formatCompact.format(diagnostics.runtimeModel.contextLimit)} tokens` : 'Unknown'} />
                      <Row label="Latest refresh" value={diagnostics.updatedAt ? new Date(diagnostics.updatedAt).toLocaleTimeString() : 'Not loaded'} tone="muted" />
                    </div>
                  </MetricCard>

                  <MetricCard icon={<LightningIcon />} eyebrow="Performance" title="Hydration and patch flow">
                    <StatGrid
                      items={[
                        { label: 'History load p95', value: formatMetricValue(historyLoadMetric), tone: 'accent' },
                        { label: 'Cold sync p95', value: formatMetricValue(coldSyncMetric) },
                        { label: 'Flush p95', value: formatMetricValue(flushMetric) },
                        { label: 'Slow events', value: formatInteger.format(slowEvents) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row label="Flush wait p95" value={formatMetricValue(flushWaitMetric)} />
                      <Row label="Patch publishes" value={formatCounterValue(patchCounter)} />
                      <Row label="Telemetry samples" value={diagnostics.perf ? formatInteger.format(diagnostics.perf.distributions.reduce((sum, metric) => sum + metric.count, 0)) : '0'} />
                    </div>
                    <div className="mt-4 rounded-2xl border border-border-subtle bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed">
                      {diagnostics.perf && diagnostics.perf.distributions.length > 0
                        ? 'Diagnostics are live from the main-process engine. The numbers here come from the same hydration and patch pipelines the chat view uses.'
                        : 'No perf telemetry captured yet. Open a thread, stream a response, then come back here to inspect runtime timings.'}
                    </div>
                  </MetricCard>
                </div>
              </div>

              <aside
                className="border-l max-[1080px]:border-l-0 max-[1080px]:border-t border-border-subtle p-5 flex flex-col gap-5"
                style={{ background: 'color-mix(in srgb, var(--color-base) 94%, var(--color-elevated) 6%)' }}
              >
                <section className="rounded-[24px] border border-border-subtle bg-surface/80 overflow-hidden">
                  <div className="px-4 py-4 border-b border-border-subtle">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Recent work</div>
                    <div className="mt-2 text-[18px] font-semibold text-text">Resume threads</div>
                  </div>
                  <div className="p-3 flex flex-col gap-2.5">
                    {recentSessions.length > 0 ? (
                      recentSessions.map((session) => {
                        const isBusy = busySessions.has(session.id)
                        return (
                          <button
                            key={session.id}
                            onClick={() => void openRecentThread(session.id)}
                            className="w-full rounded-2xl border border-border-subtle px-4 py-3 text-left bg-elevated hover:bg-surface-hover transition-colors cursor-pointer"
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
                                  <span className="text-[13px] font-medium text-text truncate">{session.title || `Thread ${session.id.slice(0, 6)}`}</span>
                                </div>
                                <div className="mt-1 text-[11px] text-text-muted truncate">{formatThreadPath(session.directory)}</div>
                              </div>
                              <span className="text-text-muted shrink-0"><ArrowUpRight /></span>
                            </div>
                          </button>
                        )
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-border-subtle px-4 py-6 text-[12px] leading-relaxed text-text-muted">
                        No threads yet. Start one from the actions below and the home page becomes your queue.
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-[24px] border border-border-subtle bg-surface/80 overflow-hidden">
                  <div className="px-4 py-4 border-b border-border-subtle">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Actions</div>
                    <div className="mt-2 text-[18px] font-semibold text-text">Open a working surface</div>
                  </div>
                  <div className="p-3 grid grid-cols-1 gap-2.5">
                    <button
                      onClick={() => void createThread()}
                      className="rounded-2xl border border-border-subtle bg-elevated hover:bg-surface-hover px-4 py-3 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-border-subtle bg-surface text-text-secondary">
                          <PlusIcon />
                        </span>
                        <span className="text-text-muted"><ArrowUpRight /></span>
                      </div>
                      <div className="mt-4 text-[14px] font-semibold text-text">New thread</div>
                      <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                        Open a fresh workspace-bound conversation.
                      </div>
                    </button>

                    <button
                      onClick={async () => {
                        const dir = await window.openCowork.dialog.selectDirectory()
                        if (dir) await createThread(dir)
                      }}
                      className="rounded-2xl border border-border-subtle bg-elevated hover:bg-surface-hover px-4 py-3 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-border-subtle bg-surface text-text-secondary">
                          <FolderIcon />
                        </span>
                        <span className="text-text-muted"><ArrowUpRight /></span>
                      </div>
                      <div className="mt-4 text-[14px] font-semibold text-text">Open directory</div>
                      <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">
                        Ground the next session in a real codebase or project folder.
                      </div>
                    </button>
                  </div>
                </section>

                <section className="rounded-[24px] border border-border-subtle bg-surface/80 px-4 py-4">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">Current inventory</div>
                  <div className="mt-3 flex flex-col gap-3">
                    <Row label="Available tools" value={formatInteger.format(diagnostics.tools.length)} />
                    <Row label="Lead agent" value={formatLeadAgentLabel(leadAgent)} />
                    <Row label="Skill bundles" value={formatInteger.format(diagnostics.skills.length)} />
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
