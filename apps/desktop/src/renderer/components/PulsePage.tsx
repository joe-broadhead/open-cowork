import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChannelDeliveryRecord,
  ChannelInboundItem,
  CapabilityRiskMetadata,
  GovernanceAuditEvent,
  GovernanceAuditExportFormat,
  GovernanceDependencyKind,
  GovernanceIncidentControlKind,
  GovernanceRegistryPayload,
  GovernanceRegistrySubject,
  ImprovementProposalDraft,
  OperationalQueueItem,
} from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { loadSessionMessages } from '../helpers/loadSessionMessages'
import { writeTextToClipboard } from '../helpers/clipboard'
import { formatCost } from '../helpers/format'
import { t } from '../helpers/i18n'
import {
  CircuitIcon,
  counterByName,
  dashboardRangeOptions,
  DatabaseIcon,
  formatCompact,
  formatCounterValue,
  formatInteger,
  formatLeadAgentLabel,
  formatMetricValue,
  formatProviderLabel,
  LayersIcon,
  LightningIcon,
  metricByName,
} from './pulse-page-support.tsx'
import {
  MetricCard,
  PulseHeader,
  Row,
  StatGrid,
  TagRail,
  UsageBar,
} from './pulse-page-components.tsx'
import { PulseImprovementInbox, type PulseImprovementReviewAction } from './PulseImprovementInbox.tsx'
import { PulseSidebar } from './PulseSidebar.tsx'
import { usePulseDiagnostics } from './usePulseDiagnostics.ts'

function describePulseThreadError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportPulseThreadError(error: unknown, directory?: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `Failed to create Pulse thread${directory ? ` for ${directory}` : ''}: ${describePulseThreadError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'pulse',
    })
  } catch {
    // Diagnostics are best-effort from an action error handler.
  }
}

function reportPulseActionError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describePulseThreadError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'pulse',
    })
  } catch {
    // Diagnostics are best-effort from action error handlers.
  }
}

function formatCapabilityId(id: string) {
  return id
    .replace(/^(native|tool|skill):/, '')
    .split(/[_:-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function describeQueueAuthority(item: OperationalQueueItem) {
  const filesystem = item.authority.filesystem
  const roots = filesystem.roots.length > 0 ? filesystem.roots.join(', ') : t('homepage.card.noRoots', 'no roots')
  const externalWrites = item.authority.externalSystems.filter((system) => system.writeAllowed).length
  const externalSummary = item.authority.externalSystems.length === 0
    ? t('homepage.card.noExternalSystems', 'no external systems')
    : t('homepage.card.externalSystemsSummary', '{{count}} external · {{writes}} write', {
        count: String(item.authority.externalSystems.length),
        writes: String(externalWrites),
      })
  return `${filesystem.mode}${filesystem.writeAllowed ? ' write' : ' read'} · ${externalSummary} · ${roots}`
}

function formatQueueBudgetCap(item: OperationalQueueItem) {
  return item.caps.maxCostUsd === null
    ? t('homepage.card.noBudgetCap', 'No cap')
    : formatCost(item.caps.maxCostUsd)
}

function describeQueueKeys(item: OperationalQueueItem) {
  return item.queueKeys.length > 0
    ? item.queueKeys.join(' · ')
    : t('homepage.card.noQueueKeys', 'Read-only fanout')
}

function queueCapStats(item: OperationalQueueItem) {
  return [
    { label: t('homepage.card.queueParallelism', 'Parallel'), value: String(item.caps.maxParallel) },
    { label: t('homepage.card.queueDuration', 'Duration'), value: `${item.caps.maxRunDurationMinutes}m` },
    { label: t('homepage.card.queueBudget', 'Budget'), value: formatQueueBudgetCap(item) },
    { label: t('homepage.card.queueRetries', 'Retries'), value: String(item.caps.maxRetries) },
  ]
}

function describeRiskSummary(risks: CapabilityRiskMetadata[]) {
  const riskRank: Record<CapabilityRiskMetadata['risk'], number> = {
    low: 0,
    medium: 1,
    high: 2,
  }
  const byCapability = new Map<string, Pick<CapabilityRiskMetadata, 'risk' | 'writeCapable' | 'approvalRequired'>>()
  for (const risk of risks) {
    const current = byCapability.get(risk.capabilityId)
    byCapability.set(risk.capabilityId, {
      risk: !current || riskRank[risk.risk] > riskRank[current.risk] ? risk.risk : current.risk,
      writeCapable: risk.writeCapable || current?.writeCapable === true,
      approvalRequired: risk.approvalRequired || current?.approvalRequired === true,
    })
  }
  const uniqueRisks = Array.from(byCapability.values())
  const high = uniqueRisks.filter((risk) => risk.risk === 'high').length
  const write = uniqueRisks.filter((risk) => risk.writeCapable).length
  const approval = uniqueRisks.filter((risk) => risk.approvalRequired).length
  return { high, write, approval }
}

function governanceDependencyLabel(kind: GovernanceDependencyKind) {
  switch (kind) {
    case 'credential':
      return t('homepage.governance.credentials', 'Credentials')
    case 'eval_suite':
      return t('homepage.governance.evalSuites', 'Eval suites')
    case 'channel':
      return t('homepage.governance.channels', 'Channels')
    case 'sop':
      return t('homepage.governance.sops', 'SOPs')
    case 'workspace_profile':
      return t('homepage.governance.workspaces', 'Workspaces')
    case 'memory':
      return t('homepage.governance.memory', 'Memory')
    case 'skill':
      return t('homepage.governance.skills', 'Skills')
    case 'tool':
      return t('homepage.governance.tools', 'Tools')
    case 'agent':
      return t('homepage.governance.agents', 'Agents')
    default:
      return kind
  }
}

function governanceSubjectKindLabel(kind: GovernanceRegistrySubject['subjectKind']) {
  return kind === 'crew'
    ? t('homepage.governance.subjectCrew', 'Crew')
    : kind === 'memory'
      ? t('homepage.governance.subjectMemory', 'Memory')
      : kind === 'tool'
        ? t('homepage.governance.subjectTool', 'Tool')
        : t('homepage.governance.subjectAgent', 'Agent')
}

function governanceSubjectLabel(subject: GovernanceRegistrySubject | undefined) {
  if (!subject) return null
  return `${governanceSubjectKindLabel(subject.subjectKind)} · ${subject.displayName || subject.name}`
}

function formatGovernanceSubjectCount(count: number) {
  return count === 1
    ? t('homepage.governance.subjectCountSingular', '1 subject')
    : t('homepage.governance.subjectCountPlural', '{{count}} subjects', { count: formatInteger.format(count) })
}

type GovernanceIncidentActionSummary = {
  key: string
  kind: GovernanceIncidentControlKind
  label: string
  subjectId: string
  subjectKind: GovernanceRegistrySubject['subjectKind']
  subjectName: string
  scopeLabel: string
  directory: string | null
  lifecycle: GovernanceRegistrySubject['lifecycle']
  requiresConfirmation: boolean
}

function governanceIncidentSubjectLabel(action: Pick<GovernanceIncidentActionSummary, 'subjectKind' | 'subjectName'>) {
  return `${governanceSubjectKindLabel(action.subjectKind)} · ${action.subjectName}`
}

function governanceIncidentActionRank(kind: GovernanceIncidentControlKind) {
  switch (kind) {
    case 'pause_agent':
    case 'pause_crew':
      return 0
    case 'quarantine_memory':
    case 'revoke_tool':
      return 1
    case 'retire_agent':
    case 'retire_crew':
      return 2
    default:
      return 3
  }
}

function decodeGovernanceSubjectId(subject: Pick<GovernanceRegistrySubject, 'subjectId' | 'name'>, prefix: string) {
  if (!subject.subjectId.startsWith(prefix)) return subject.name
  try {
    const decoded = decodeURIComponent(subject.subjectId.slice(prefix.length))
    return decoded.trim() || subject.name
  } catch {
    return subject.name
  }
}

function formatGovernanceAuditAction(action: string) {
  return action
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatGovernanceAuditSubject(event: Pick<GovernanceAuditEvent, 'subjectKind' | 'subjectId'>, subjectLabelsById: Map<string, string>) {
  const subjectLabel = subjectLabelsById.get(event.subjectId) || event.subjectId
  return `${formatGovernanceAuditAction(event.subjectKind)} · ${subjectLabel}`
}

function summarizeGovernanceRegistry(registry: GovernanceRegistryPayload | null) {
  const subjects = registry?.subjects || []
  const dependencies = registry?.dependencyIndex || []
  const executionNodes = registry?.executionNodes || []
  const subjectsById = new Map(subjects.map((subject) => [subject.subjectId, subject]))
  const availableControls = subjects.reduce((count, subject) => (
    count + subject.incidentControls.filter((control) => control.available).length
  ), 0)
  const dependencyKinds = new Map<GovernanceDependencyKind, number>()
  for (const entry of dependencies) {
    dependencyKinds.set(entry.dependency.kind, (dependencyKinds.get(entry.dependency.kind) || 0) + 1)
  }
  const dependencyHighlights = [...dependencyKinds.entries()]
    .sort((left, right) => right[1] - left[1] || governanceDependencyLabel(left[0]).localeCompare(governanceDependencyLabel(right[0])))
    .slice(0, 5)
    .map(([kind, count]) => `${governanceDependencyLabel(kind)} · ${formatInteger.format(count)}`)
  const dependencyDetails = dependencies
    .map((entry) => ({
      key: `${entry.dependency.kind}:${entry.dependency.id}`,
      kindLabel: governanceDependencyLabel(entry.dependency.kind),
      label: entry.dependency.label || entry.dependency.id,
      subjectCount: entry.subjectIds.length,
      subjectLabels: entry.subjectIds
        .map((subjectId) => governanceSubjectLabel(subjectsById.get(subjectId)))
        .filter((label): label is string => Boolean(label))
        .slice(0, 3),
    }))
    .sort((left, right) => (
      right.subjectCount - left.subjectCount
      || left.kindLabel.localeCompare(right.kindLabel)
      || left.label.localeCompare(right.label)
    ))
    .slice(0, 4)
  const incidentActions: GovernanceIncidentActionSummary[] = subjects
    .flatMap((subject) => subject.incidentControls
      .filter((control) => control.available && control.kind !== 'export_audit')
      .map((control) => ({
        key: `${subject.subjectId}:${control.kind}`,
        kind: control.kind,
        label: control.label,
        subjectId: subject.subjectId,
        subjectKind: subject.subjectKind,
        subjectName: subject.displayName || subject.name,
        scopeLabel: subject.scope.label,
        directory: subject.scope.directory || null,
        lifecycle: subject.lifecycle,
        requiresConfirmation: control.requiresConfirmation,
      })))
    .sort((left, right) => (
      governanceIncidentActionRank(left.kind) - governanceIncidentActionRank(right.kind)
      || left.subjectName.localeCompare(right.subjectName)
      || left.label.localeCompare(right.label)
    ))
    .slice(0, 5)
  const activeExecutionNodeCount = executionNodes.filter((node) => node.status === 'active').length
  const backgroundExecutionReady = executionNodes.some((node) => (
    node.status === 'active'
    && node.capabilities.some((capability) => capability.kind === 'background_execution' && capability.available)
  ))

  return {
    organizationLabel: registry?.organization.displayName || t('homepage.governance.localOrg', 'Local organization'),
    principalCount: registry?.principals.length || 0,
    groupCount: registry?.groups.length || 0,
    executionNodeCount: executionNodes.length,
    activeExecutionNodeCount,
    backgroundExecutionReady,
    agentCount: subjects.filter((subject) => subject.subjectKind === 'agent').length,
    crewCount: subjects.filter((subject) => subject.subjectKind === 'crew').length,
    dependencyCount: dependencies.length,
    evalSuiteCount: dependencies.filter((entry) => entry.dependency.kind === 'eval_suite').length,
    availableControls,
    dependencyHighlights,
    dependencyDetails,
    incidentActions,
  }
}

function formatChannelProvider(provider: string) {
  return provider
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatChannelRoute(mode: string) {
  switch (mode) {
    case 'draft_reply':
      return t('homepage.channels.routeDraft', 'Draft')
    case 'ask_user':
      return t('homepage.channels.routeAskUser', 'Review')
    case 'run_sop':
      return t('homepage.channels.routeSop', 'SOP')
    case 'run_crew':
      return t('homepage.channels.routeCrew', 'Crew')
    default:
      return t('homepage.channels.routeIgnore', 'Ignore')
  }
}

function formatChannelTime(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function channelItemTone(item: ChannelInboundItem) {
  if (item.status === 'denied' || item.status === 'failed') return 'text-red'
  if (item.status === 'queued' || item.status === 'needs_user' || item.status === 'drafted' || item.status === 'dispatching') return 'text-amber'
  return 'text-accent'
}

function channelItemCanDispatch(item: ChannelInboundItem) {
  return (item.route.activationMode === 'run_sop' || item.route.activationMode === 'run_crew')
    && (item.status === 'queued' || item.status === 'needs_user')
}

function channelItemCanCreateDeliveryDraft(item: ChannelInboundItem, deliveries: ChannelDeliveryRecord[]) {
  if (item.status !== 'dispatched' || !item.runKind || !item.runId) return false
  if (item.runStatus !== 'completed') return false
  return !deliveries.some((delivery) => (
    delivery.inboundItemId === item.id
    && delivery.runKind === item.runKind
    && delivery.runId === item.runId
    && delivery.provider !== 'desktop_notification'
  ))
}

function deliveryTone(delivery: ChannelDeliveryRecord) {
  if (delivery.status === 'failed') return 'text-red'
  if (delivery.status === 'cancelled') return 'text-text-muted'
  if (delivery.status === 'draft' || delivery.status === 'approval_required' || delivery.status === 'sending') return 'text-amber'
  return 'text-accent'
}

function deliveryCanSend(delivery: ChannelDeliveryRecord) {
  return delivery.provider === 'webhook' && (delivery.status === 'draft' || delivery.status === 'approval_required')
}

function deliveryCanCancel(delivery: ChannelDeliveryRecord) {
  return delivery.status === 'draft' || delivery.status === 'approval_required'
}

export function PulsePage({ onOpenThread, brandName }: { onOpenThread: () => void; brandName: string }) {
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const busySessions = useSessionStore((s) => s.busySessions)
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const {
    diagnostics,
    dashboardRange,
    setDashboardRange,
    dashboardSummary,
    dashboardError,
    queueItems,
    queueAlerts,
    capabilityRisks,
    governanceRegistry,
    governanceAuditEvents,
    channelState,
    localWebhookStatus,
    improvementSummary,
    improvementInbox,
    refreshDiagnostics,
  } = usePulseDiagnostics()
  const [improvementActionId, setImprovementActionId] = useState<string | null>(null)
  const [channelActionId, setChannelActionId] = useState<string | null>(null)
  const [governanceActionId, setGovernanceActionId] = useState<string | null>(null)
  const [governanceExportStatus, setGovernanceExportStatus] = useState<'idle' | 'working-ndjson' | 'working-otel-json' | 'copied' | 'empty' | 'error'>('idle')
  const governanceExportResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (governanceExportResetTimerRef.current !== null) {
        window.clearTimeout(governanceExportResetTimerRef.current)
      }
    }
  }, [])

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
  const criticalQueueAlerts = useMemo(
    () => queueAlerts.filter((alert) => alert.severity === 'critical'),
    [queueAlerts],
  )
  const warningQueueAlerts = useMemo(
    () => queueAlerts.filter((alert) => alert.severity === 'warning'),
    [queueAlerts],
  )
  const runningQueueItems = useMemo(
    () => queueItems.filter((item) => item.status === 'running'),
    [queueItems],
  )
  const queuedQueueItems = useMemo(
    () => queueItems.filter((item) => item.status === 'queued'),
    [queueItems],
  )
  const visibleQueueItems = useMemo(
    () => queueItems
      .filter((item) => item.status === 'running' || item.status === 'queued' || item.status === 'blocked')
      .slice(0, 3),
    [queueItems],
  )
  const riskSummary = useMemo(
    () => describeRiskSummary(capabilityRisks),
    [capabilityRisks],
  )
  const governanceSummary = useMemo(
    () => summarizeGovernanceRegistry(governanceRegistry),
    [governanceRegistry],
  )
  const governanceSubjectLabelsById = useMemo(
    () => new Map((governanceRegistry?.subjects || []).map((subject) => [
      subject.subjectId,
      governanceSubjectLabel(subject) || subject.subjectId,
    ])),
    [governanceRegistry],
  )
  const highRiskCapabilityLabels = useMemo(
    () => capabilityRisks
      .filter((risk) => risk.risk === 'high')
      .map((risk) => formatCapabilityId(risk.capabilityId))
      .filter((label, index, labels) => labels.indexOf(label) === index)
      .slice(0, 5),
    [capabilityRisks],
  )
  const activeChannels = useMemo(
    () => channelState.channels.filter((channel) => channel.enabled),
    [channelState.channels],
  )
  const channelItemsNeedingReview = useMemo(
    () => channelState.inboundItems.filter((item) => item.status === 'needs_user' || item.status === 'queued' || item.status === 'drafted'),
    [channelState.inboundItems],
  )
  const deniedChannelItems = useMemo(
    () => channelState.inboundItems.filter((item) => item.status === 'denied' || item.status === 'failed'),
    [channelState.inboundItems],
  )
  const draftChannelDeliveries = useMemo(
    () => channelState.deliveries.filter((delivery) => delivery.status === 'draft' || delivery.status === 'approval_required' || delivery.status === 'sending'),
    [channelState.deliveries],
  )
  const channelSandboxQueueItems = useMemo(
    () => queueItems.filter((item) => item.authority.isolation.channelBound),
    [queueItems],
  )
  const visibleChannelItems = useMemo(
    () => channelState.inboundItems.slice(0, 3),
    [channelState.inboundItems],
  )
  const visibleChannelDeliveries = useMemo(
    () => draftChannelDeliveries.slice(0, 3),
    [draftChannelDeliveries],
  )
  const learningDisabledScopes = improvementSummary
    ? improvementSummary.policy.disabledAgentCount + improvementSummary.policy.disabledProjectCount + improvementSummary.policy.disabledCrewCount
    : 0
  const pendingImprovementItems = improvementSummary
    ? improvementSummary.memory.proposed + improvementSummary.proposals.proposed
    : 0
  const proposalPolicyLabel = !improvementSummary
    ? t('homepage.card.unknown', 'Unknown')
    : improvementSummary.policy.proposalsEnabled
      ? t('homepage.card.enabled', 'Enabled')
      : t('homepage.card.disabled', 'Disabled')
  const proposalPolicyTone = !improvementSummary
    ? 'muted'
    : improvementSummary.policy.proposalsEnabled ? 'accent' : 'muted'
  const dreamRunInFlight = Boolean(improvementSummary?.dreamRuns.running)
  const dreamStartDisabled = improvementActionId !== null
    || !improvementSummary?.policy.proposalsEnabled
    || dreamRunInFlight

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
      addGlobalError(t('pulse.createThreadFailed', 'Could not create a thread from Pulse. Please try again.'))
      reportPulseThreadError(err, directory)
      if (sessionId) setCurrentSession(null)
    }
  }

  async function openRecentThread(sessionId: string) {
    onOpenThread()
    await loadSessionMessages(sessionId)
  }

  async function reviewImprovement(
    id: string,
    action: PulseImprovementReviewAction,
  ) {
    setImprovementActionId(`${action}:${id}`)
    try {
      if (action === 'approve-memory') await window.coworkApi.improvements.approveMemory(id)
      else if (action === 'reject-memory') await window.coworkApi.improvements.rejectMemory(id)
      else if (action === 'approve-proposal') await window.coworkApi.improvements.approveProposal(id)
      else if (action === 'reject-proposal') await window.coworkApi.improvements.rejectProposal(id)
      else if (action === 'archive-proposal') await window.coworkApi.improvements.archiveProposal(id)
      else if (action === 'cancel-dream') await window.coworkApi.improvements.cancelDreamRun(id)
      else await window.coworkApi.improvements.archiveDreamRun(id)
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.improvementReviewFailed', 'Could not update the Improvement Inbox item. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to review improvement item ${id}: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics are best-effort from an action error handler.
      }
    } finally {
      setImprovementActionId(null)
    }
  }

  async function updateImprovementProposal(id: string, draft: ImprovementProposalDraft) {
    setImprovementActionId(`update-proposal:${id}`)
    try {
      await window.coworkApi.improvements.updateProposal(id, draft)
      await refreshDiagnostics({ silent: true })
      return true
    } catch (error) {
      addGlobalError(t('pulse.improvementUpdateFailed', 'Could not save the Improvement Inbox proposal. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to update improvement proposal ${id}: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics are best-effort from an action error handler.
      }
      return false
    } finally {
      setImprovementActionId(null)
    }
  }

  async function startDreamRun() {
    setImprovementActionId('start-dream:manual')
    try {
      await window.coworkApi.improvements.startDreamRun()
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.dreamRunFailed', 'Could not start memory consolidation. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to start dream run: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics failures should not mask the user-facing error.
      }
    } finally {
      setImprovementActionId(null)
    }
  }

  async function copyGovernanceAudit(format: GovernanceAuditExportFormat) {
    clearGovernanceExportResetTimer()
    setGovernanceExportStatus(format === 'otel-json' ? 'working-otel-json' : 'working-ndjson')
    try {
      const payload = await window.coworkApi.operations.exportGovernanceAudit({ format })
      if (!payload.body) {
        setGovernanceExportStatus('empty')
        scheduleGovernanceExportStatusReset()
        return
      }
      const copied = await writeTextToClipboard(payload.body)
      setGovernanceExportStatus(copied ? 'copied' : 'error')
      scheduleGovernanceExportStatusReset()
    } catch (error) {
      addGlobalError(t('pulse.governanceExportFailed', 'Could not export the governance audit. Please try again.'))
      reportPulseActionError(error, 'Failed to export governance audit')
      setGovernanceExportStatus('error')
      scheduleGovernanceExportStatusReset()
    }
  }

  async function runGovernanceIncidentControl(action: GovernanceIncidentActionSummary) {
    if (action.requiresConfirmation) {
      const confirmed = window.confirm(t(
        'pulse.governanceControlConfirm',
        'Run {{action}} for {{subject}}? This writes a governance audit event and may change runtime access.',
        { action: action.label.toLowerCase(), subject: action.subjectName },
      ))
      if (!confirmed) return
    }

    setGovernanceActionId(action.key)
    const reason = t('pulse.governanceControlReason', 'Triggered from Pulse governance operations.')
    try {
      switch (action.kind) {
        case 'pause_agent':
          await window.coworkApi.operations.pauseAgent({
            subjectId: action.subjectId,
            reason,
            context: action.directory ? { directory: action.directory } : undefined,
          })
          break
        case 'retire_agent':
          await window.coworkApi.operations.retireAgent({
            subjectId: action.subjectId,
            reason,
            context: action.directory ? { directory: action.directory } : undefined,
          })
          break
        case 'pause_crew':
          await window.coworkApi.operations.pauseCrew({
            crewId: decodeGovernanceSubjectId({ subjectId: action.subjectId, name: action.subjectName }, 'crew:'),
            reason,
          })
          break
        case 'retire_crew':
          await window.coworkApi.operations.retireCrew({
            crewId: decodeGovernanceSubjectId({ subjectId: action.subjectId, name: action.subjectName }, 'crew:'),
            reason,
          })
          break
        case 'quarantine_memory':
          await window.coworkApi.operations.quarantineMemory({
            memoryId: decodeGovernanceSubjectId({ subjectId: action.subjectId, name: action.subjectName }, 'memory:'),
            reason,
          })
          break
        case 'revoke_tool':
          await window.coworkApi.operations.revokeTool({
            toolId: decodeGovernanceSubjectId({ subjectId: action.subjectId, name: action.subjectName }, 'tool:'),
            reason,
            context: action.directory ? { directory: action.directory } : undefined,
          })
          break
        default:
          throw new Error(`Unsupported governance incident control ${action.kind}.`)
      }
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.governanceControlFailed', 'Could not run the governance incident control. Please try again.'))
      reportPulseActionError(error, `Failed to run governance incident control ${action.kind}`)
    } finally {
      setGovernanceActionId(null)
    }
  }

  function clearGovernanceExportResetTimer() {
    if (governanceExportResetTimerRef.current === null) return
    window.clearTimeout(governanceExportResetTimerRef.current)
    governanceExportResetTimerRef.current = null
  }

  function scheduleGovernanceExportStatusReset() {
    clearGovernanceExportResetTimer()
    governanceExportResetTimerRef.current = window.setTimeout(() => {
      governanceExportResetTimerRef.current = null
      setGovernanceExportStatus('idle')
    }, 3_000)
  }

  async function reviewChannelItem(item: ChannelInboundItem, action: 'approve' | 'dismiss') {
    setChannelActionId(`${action}:${item.id}`)
    try {
      if (action === 'approve') await window.coworkApi.channels.approveInboundItem(item.id)
      else await window.coworkApi.channels.dismissInboundItem(item.id, 'Dismissed from Pulse.')
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.channelReviewFailed', 'Could not update the channel item. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to review channel item ${item.id}: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics are best-effort from an action error handler.
      }
    } finally {
      setChannelActionId(null)
    }
  }

  async function createChannelDeliveryDraft(item: ChannelInboundItem) {
    setChannelActionId(`draft:${item.id}`)
    try {
      await window.coworkApi.channels.createDeliveryDraft(item.id)
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.channelDeliveryDraftFailed', 'Could not create the channel delivery draft. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to create channel delivery draft for ${item.id}: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics are best-effort from an action error handler.
      }
    } finally {
      setChannelActionId(null)
    }
  }

  async function reviewChannelDelivery(delivery: ChannelDeliveryRecord, action: 'send' | 'cancel') {
    setChannelActionId(`${action}-delivery:${delivery.id}`)
    try {
      if (action === 'send') await window.coworkApi.channels.sendDelivery(delivery.id)
      else await window.coworkApi.channels.cancelDelivery(delivery.id, 'Cancelled from Pulse.')
      await refreshDiagnostics({ silent: true })
    } catch (error) {
      addGlobalError(t('pulse.channelDeliveryFailed', 'Could not update the delivery draft. Please try again.'))
      try {
        window.coworkApi.diagnostics.reportRendererError({
          message: `Failed to review channel delivery ${delivery.id}: ${describePulseThreadError(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'pulse',
        })
      } catch {
        // Diagnostics are best-effort from an action error handler.
      }
    } finally {
      setChannelActionId(null)
    }
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

                  <MetricCard icon={<DatabaseIcon />} eyebrow={t('homepage.card.operationsEyebrow', 'Operations')} title={t('homepage.card.operations', 'Queues and authority')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.queueItems', 'Queue items'), value: formatInteger.format(queueItems.length), tone: queueAlerts.length > 0 ? 'accent' : undefined },
                        { label: t('homepage.card.runningQueue', 'Running'), value: formatInteger.format(runningQueueItems.length) },
                        { label: t('homepage.card.queuedQueue', 'Queued'), value: formatInteger.format(queuedQueueItems.length) },
                        { label: t('homepage.card.highRiskCaps', 'High risk caps'), value: formatInteger.format(riskSummary.high) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <div
                        className="rounded-2xl bg-surface px-4 py-3"
                        style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.governance.eyebrow', 'Governance map')}</div>
                            <div className="mt-1 text-[12px] font-semibold text-text truncate">{governanceSummary.organizationLabel}</div>
                          </div>
                          <div className="shrink-0 text-right text-[10px] uppercase tracking-[0.14em] text-text-muted">
                            {formatInteger.format(governanceSummary.principalCount)} {governanceSummary.principalCount === 1 ? t('homepage.governance.principal', 'principal') : t('homepage.governance.principals', 'principals')}
                            {' · '}
                            {formatInteger.format(governanceSummary.groupCount)} {governanceSummary.groupCount === 1 ? t('homepage.governance.group', 'group') : t('homepage.governance.groups', 'groups')}
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-5 gap-2 max-[980px]:grid-cols-2">
                          {[
                            { label: t('homepage.governance.agents', 'Agents'), value: formatInteger.format(governanceSummary.agentCount) },
                            { label: t('homepage.governance.crews', 'Crews'), value: formatInteger.format(governanceSummary.crewCount) },
                            { label: t('homepage.governance.dependencies', 'Dependencies'), value: formatInteger.format(governanceSummary.dependencyCount) },
                            { label: t('homepage.governance.controls', 'Controls'), value: formatInteger.format(governanceSummary.availableControls) },
                            {
                              label: t('homepage.governance.nodes', 'Nodes'),
                              value: governanceSummary.executionNodeCount > 0
                                ? `${formatInteger.format(governanceSummary.activeExecutionNodeCount)}/${formatInteger.format(governanceSummary.executionNodeCount)}`
                                : '0',
                            },
                          ].map((stat) => (
                            <div key={stat.label} className="rounded-xl border border-border-subtle px-2.5 py-2">
                              <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{stat.label}</div>
                              <div className="mt-1 text-[11px] font-semibold text-text">{stat.value}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3">
                          <TagRail
                            items={[
                              ...governanceSummary.dependencyHighlights,
                              ...(governanceSummary.evalSuiteCount > 0
                                ? [`${t('homepage.governance.evalGates', 'Eval gates')} · ${formatInteger.format(governanceSummary.evalSuiteCount)}`]
                                : []),
                              ...(governanceSummary.executionNodeCount > 0
                                ? [
                                    governanceSummary.backgroundExecutionReady
                                      ? t('homepage.governance.backgroundReady', 'Background execution ready')
                                      : t('homepage.governance.backgroundPlanned', 'Background workers planned'),
                                  ]
                                : []),
                            ].slice(0, 7)}
                            emptyLabel={t('homepage.governance.empty', 'No governed dependencies registered yet.')}
                          />
                        </div>
                        {governanceSummary.dependencyDetails.length > 0 ? (
                          <div className="mt-3 space-y-2" aria-label={t('homepage.governance.dependencyMap', 'Governance dependency map')}>
                            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
                              {t('homepage.governance.dependencyMap', 'Governance dependency map')}
                            </div>
                            {governanceSummary.dependencyDetails.map((dependency) => (
                              <div
                                key={dependency.key}
                                className="rounded-xl border border-border-subtle px-3 py-2"
                                style={{
                                  background: 'color-mix(in srgb, var(--color-surface) 76%, transparent)',
                                }}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{dependency.kindLabel}</div>
                                    <div className="mt-1 text-[12px] font-semibold text-text truncate">{dependency.label}</div>
                                  </div>
                                  <div className="shrink-0 text-right text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
                                    {formatGovernanceSubjectCount(dependency.subjectCount)}
                                  </div>
                                </div>
                                {dependency.subjectLabels.length > 0 ? (
                                  <div className="mt-1.5 text-[11px] text-text-secondary truncate">
                                    {dependency.subjectLabels.join(' · ')}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {governanceSummary.incidentActions.length > 0 ? (
                          <div className="mt-3 space-y-2" aria-label={t('homepage.governance.incidentControls', 'Governance incident controls')}>
                            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
                              {t('homepage.governance.incidentControls', 'Governance incident controls')}
                            </div>
                            {governanceSummary.incidentActions.map((action) => (
                              <div
                                key={action.key}
                                className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle px-3 py-2"
                                style={{
                                  background: 'color-mix(in srgb, var(--color-surface) 76%, transparent)',
                                }}
                              >
                                <div className="min-w-0">
                                  <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">
                                    {governanceIncidentSubjectLabel(action)}
                                  </div>
                                  <div className="mt-1 text-[12px] font-semibold text-text truncate">
                                    {action.scopeLabel} · {action.lifecycle}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="shrink-0 rounded-full border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                                  disabled={governanceActionId !== null}
                                  onClick={() => void runGovernanceIncidentControl(action)}
                                >
                                  {governanceActionId === action.key
                                    ? t('homepage.governance.controlWorking', 'Running...')
                                    : action.label}
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {governanceAuditEvents.length > 0 ? (
                          <div className="mt-3 space-y-2" aria-label={t('homepage.governance.recentIncidents', 'Recent governance incidents')}>
                            <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
                              {t('homepage.governance.recentIncidents', 'Recent governance incidents')}
                            </div>
                            {governanceAuditEvents.slice(0, 3).map((event) => (
                              <div
                                key={event.id}
                                className="rounded-xl border border-border-subtle px-3 py-2"
                                style={{
                                  background: 'color-mix(in srgb, var(--color-surface) 76%, transparent)',
                                }}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="truncate text-[10px] uppercase tracking-[0.1em] text-text-muted">
                                      {formatGovernanceAuditSubject(event, governanceSubjectLabelsById)}
                                    </div>
                                    <div className="mt-1 text-[12px] font-semibold text-text truncate">
                                      {formatGovernanceAuditAction(event.action)}
                                    </div>
                                  </div>
                                  <div className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.1em] ${event.outcome === 'failed' ? 'text-red' : 'text-accent'}`}>
                                    {event.outcome}
                                  </div>
                                </div>
                                <div className="mt-1.5 text-[11px] text-text-secondary truncate">
                                  {event.reason || t('homepage.governance.noIncidentReason', 'No incident reason recorded.')}
                                  {' · '}
                                  {formatChannelTime(event.createdAt)}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="rounded-full border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                            disabled={governanceExportStatus === 'working-ndjson' || governanceExportStatus === 'working-otel-json'}
                            onClick={() => void copyGovernanceAudit('ndjson')}
                          >
                            {governanceExportStatus === 'working-ndjson'
                              ? t('homepage.governance.exportPreparing', 'Preparing...')
                              : t('homepage.governance.copyNdjson', 'Copy audit NDJSON')}
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                            disabled={governanceExportStatus === 'working-ndjson' || governanceExportStatus === 'working-otel-json'}
                            onClick={() => void copyGovernanceAudit('otel-json')}
                          >
                            {governanceExportStatus === 'working-otel-json'
                              ? t('homepage.governance.exportPreparing', 'Preparing...')
                              : t('homepage.governance.copyOtel', 'Copy OTel JSON')}
                          </button>
                          {governanceExportStatus === 'copied' ? (
                            <span className="inline-flex items-center px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                              {t('homepage.governance.exportCopied', 'Copied')}
                            </span>
                          ) : governanceExportStatus === 'empty' ? (
                            <span className="inline-flex items-center px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
                              {t('homepage.governance.exportEmpty', 'No records')}
                            </span>
                          ) : governanceExportStatus === 'error' ? (
                            <span className="inline-flex items-center px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-red">
                              {t('homepage.governance.exportFailed', 'Export failed')}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {visibleQueueItems.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-2xl bg-surface px-4 py-3"
                          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{item.status}</span>
                            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
                              {item.effectiveAutonomy}
                            </span>
                          </div>
                          <div className="mt-2 text-[12px] font-semibold text-text">{item.title}</div>
                          <div className="mt-1 text-[11px] text-text-muted leading-relaxed">{describeQueueAuthority(item)}</div>
                          <div className="mt-3 grid grid-cols-4 gap-2 max-[860px]:grid-cols-2">
                            {queueCapStats(item).map((stat) => (
                              <div key={stat.label} className="rounded-xl border border-border-subtle px-2.5 py-2">
                                <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{stat.label}</div>
                                <div className="mt-1 text-[11px] font-semibold text-text">{stat.value}</div>
                              </div>
                            ))}
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
                            <span>{t('homepage.card.queueAttempt', 'Attempt')} {item.attempt}</span>
                            <span>{t('homepage.card.queueCost', 'Cost')} {formatCost(item.costUsd)}</span>
                            <span className="min-w-0 break-all">{describeQueueKeys(item)}</span>
                          </div>
                        </div>
                      ))}
                      {queueAlerts.length > 0
                        ? queueAlerts.slice(0, 3).map((alert) => (
                          <div
                            key={`${alert.queueItemId}:${alert.kind}:${alert.createdAt}`}
                            className="rounded-2xl bg-surface px-4 py-3"
                            style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{alert.kind.replace(/_/g, ' ')}</span>
                              <span className={alert.severity === 'critical' ? 'text-[10px] font-semibold uppercase tracking-[0.14em] text-red' : 'text-[10px] font-semibold uppercase tracking-[0.14em] text-amber'}>
                                {alert.severity}
                              </span>
                            </div>
                            <div className="mt-2 text-[12px] text-text-secondary leading-relaxed">{alert.message}</div>
                          </div>
                        ))
                        : null}
                      <TagRail
                        items={highRiskCapabilityLabels}
                        emptyLabel={t('homepage.card.noHighRiskCapabilities', 'No high-risk capabilities are currently registered.')}
                      />
                      <Row label={t('homepage.card.criticalAlerts', 'Critical alerts')} value={formatInteger.format(criticalQueueAlerts.length)} tone={criticalQueueAlerts.length > 0 ? 'accent' : undefined} />
                      <Row label={t('homepage.card.warningAlerts', 'Warning alerts')} value={formatInteger.format(warningQueueAlerts.length)} />
                      <Row label={t('homepage.card.writeCapabilities', 'Write-capable capabilities')} value={formatInteger.format(riskSummary.write)} />
                      <Row label={t('homepage.card.approvalGatedCapabilities', 'Approval-gated capabilities')} value={formatInteger.format(riskSummary.approval)} />
                      {visibleQueueItems.length === 0 && queueAlerts.length === 0 ? (
                        <div
                          className="rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                        >
                          {t('homepage.card.operationsHealthy', 'No stuck, blocked, or over-budget operational runs are waiting for attention.')}
                        </div>
                      ) : null}
                    </div>
                  </MetricCard>

                  <MetricCard icon={<CircuitIcon />} eyebrow={t('homepage.channels.eyebrow', 'Channels')} title={t('homepage.channels.title', 'Channel inbox and delivery')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.channels.activeChannels', 'Active channels'), value: formatInteger.format(activeChannels.length), tone: activeChannels.length > 0 ? 'accent' : undefined },
                        { label: t('homepage.channels.inboundItems', 'Inbound items'), value: formatInteger.format(channelState.inboundItems.length) },
                        { label: t('homepage.channels.needsReview', 'Needs review'), value: formatInteger.format(channelItemsNeedingReview.length), tone: channelItemsNeedingReview.length > 0 ? 'accent' : undefined },
                        { label: t('homepage.channels.deliveryDrafts', 'Delivery drafts'), value: formatInteger.format(draftChannelDeliveries.length), tone: draftChannelDeliveries.length > 0 ? 'accent' : undefined },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row
                        label={t('homepage.channels.localWebhook', 'Local webhook')}
                        value={localWebhookStatus?.listening
                          ? t('homepage.channels.listening', 'Listening')
                          : localWebhookStatus?.enabled
                            ? t('homepage.channels.notListening', 'Not listening')
                            : t('homepage.channels.disabled', 'Disabled')}
                        tone={localWebhookStatus?.listening ? 'accent' : 'muted'}
                      />
                      <Row label={t('homepage.channels.pairedChannels', 'Paired channels')} value={formatInteger.format(localWebhookStatus?.pairedChannels || 0)} />
                      <Row label={t('homepage.channels.deniedItems', 'Denied / failed')} value={formatInteger.format(deniedChannelItems.length)} tone={deniedChannelItems.length > 0 ? 'accent' : undefined} />
                      <Row label={t('homepage.channels.channelSandboxQueue', 'Channel sandbox queue')} value={formatInteger.format(channelSandboxQueueItems.length)} />
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted mb-2">{t('homepage.channels.configured', 'Configured channels')}</div>
                      <TagRail
                        items={channelState.channels.slice(0, 6).map((channel) => `${channel.name} · ${formatChannelRoute(channel.route.activationMode)}`)}
                        emptyLabel={t('homepage.channels.noChannels', 'No channels configured yet.')}
                      />
                    </div>

                    <div className="mt-4 space-y-3">
                      {visibleChannelItems.map((item) => (
                        <div
                          key={item.id}
                          className="rounded-2xl bg-surface px-4 py-3"
                          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{formatChannelProvider(item.provider)}</span>
                            <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${channelItemTone(item)}`}>
                              {item.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <div className="mt-2 text-[12px] font-semibold text-text truncate">{item.subject || item.sender}</div>
                          <div className="mt-1 text-[11px] text-text-muted leading-relaxed">
                            {item.sender} · {formatChannelRoute(item.route.activationMode)} · {formatChannelTime(item.receivedAt)}
                          </div>
                          {item.runKind && item.runId ? (
                            <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">
                              {item.runKind} · {item.runId}
                            </div>
                          ) : null}
                          {channelItemCanDispatch(item) ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-base transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={channelActionId !== null}
                                onClick={() => void reviewChannelItem(item, 'approve')}
                              >
                                {channelActionId === `approve:${item.id}` ? t('homepage.channels.approving', 'Approving...') : t('homepage.channels.approveRun', 'Approve run')}
                              </button>
                              <button
                                type="button"
                                className="rounded-full border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary transition hover:border-red hover:text-red disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={channelActionId !== null}
                                onClick={() => void reviewChannelItem(item, 'dismiss')}
                              >
                                {channelActionId === `dismiss:${item.id}` ? t('homepage.channels.dismissing', 'Dismissing...') : t('homepage.channels.dismiss', 'Dismiss')}
                              </button>
                            </div>
                          ) : null}
                          {channelItemCanCreateDeliveryDraft(item, channelState.deliveries) ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-base transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={channelActionId !== null}
                                onClick={() => void createChannelDeliveryDraft(item)}
                              >
                                {channelActionId === `draft:${item.id}` ? t('homepage.channels.draftingDelivery', 'Drafting...') : t('homepage.channels.draftDelivery', 'Draft delivery')}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {visibleChannelItems.length === 0 ? (
                        <div
                          className="rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                        >
                          {t('homepage.channels.noInbound', 'No channel inbox items recorded yet.')}
                        </div>
                      ) : null}
                    </div>

                    {visibleChannelDeliveries.length > 0 ? (
                      <div className="mt-4 space-y-3">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('homepage.channels.deliveryOutbox', 'Delivery outbox')}</div>
                        {visibleChannelDeliveries.map((delivery) => (
                          <div
                            key={delivery.id}
                            className="rounded-2xl bg-surface px-4 py-3"
                            style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{formatChannelProvider(delivery.provider)}</span>
                              <span className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${deliveryTone(delivery)}`}>
                                {delivery.status.replace(/_/g, ' ')}
                              </span>
                            </div>
                            <div className="mt-2 text-[12px] font-semibold text-text truncate">{delivery.title}</div>
                            <div className="mt-1 text-[11px] text-text-muted leading-relaxed">
                              {delivery.target} · {delivery.draftFirst ? t('homepage.channels.draftFirst', 'draft-first') : t('homepage.channels.direct', 'direct')} · {formatChannelTime(delivery.createdAt)}
                            </div>
                            {deliveryCanSend(delivery) || deliveryCanCancel(delivery) ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {deliveryCanSend(delivery) ? (
                                  <button
                                    type="button"
                                    className="rounded-full bg-accent px-3 py-1.5 text-[11px] font-semibold text-base transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                    disabled={channelActionId !== null}
                                    onClick={() => void reviewChannelDelivery(delivery, 'send')}
                                  >
                                    {channelActionId === `send-delivery:${delivery.id}` ? t('homepage.channels.sending', 'Sending...') : t('homepage.channels.sendWebhook', 'Send webhook')}
                                  </button>
                                ) : null}
                                {deliveryCanCancel(delivery) ? (
                                  <button
                                    type="button"
                                    className="rounded-full border border-border-subtle px-3 py-1.5 text-[11px] font-semibold text-text-secondary transition hover:border-red hover:text-red disabled:cursor-not-allowed disabled:opacity-60"
                                    disabled={channelActionId !== null}
                                    onClick={() => void reviewChannelDelivery(delivery, 'cancel')}
                                  >
                                    {channelActionId === `cancel-delivery:${delivery.id}` ? t('homepage.channels.cancelling', 'Cancelling...') : t('homepage.channels.cancelDraft', 'Cancel draft')}
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </MetricCard>

                  <MetricCard icon={<LayersIcon />} eyebrow={t('homepage.card.learningEyebrow', 'Learning')} title={t('homepage.card.learning', 'Governed improvements')}>
                    <StatGrid
                      items={[
                        { label: t('homepage.card.pendingImprovements', 'Pending review'), value: formatInteger.format(pendingImprovementItems), tone: pendingImprovementItems > 0 ? 'accent' : undefined },
                        { label: t('homepage.card.approvedMemory', 'Approved memory'), value: formatInteger.format(improvementSummary?.memory.approved || 0) },
                        { label: t('homepage.card.dreamRuns', 'Dream runs'), value: formatInteger.format((improvementSummary?.dreamRuns.running || 0) + (improvementSummary?.dreamRuns.completed || 0) + (improvementSummary?.dreamRuns.failed || 0) + (improvementSummary?.dreamRuns.cancelled || 0) + (improvementSummary?.dreamRuns.archived || 0)) },
                        { label: t('homepage.card.policyBlocks', 'Policy blocks'), value: formatInteger.format(learningDisabledScopes) },
                      ]}
                    />
                    <div className="mt-4 space-y-3">
                      <Row
                        label={t('homepage.card.proposalsPolicy', 'Proposal policy')}
                        value={proposalPolicyLabel}
                        tone={proposalPolicyTone}
                      />
                      <Row label={t('homepage.card.memoryConsidered', 'Memory considered')} value={formatInteger.format(improvementSummary?.memory.injection.consideredCount || 0)} />
                      <Row label={t('homepage.card.memoryInjected', 'Memory injected')} value={formatInteger.format(improvementSummary?.memory.injection.returnedCount || 0)} />
                      <Row label={t('homepage.card.restrictedExcluded', 'Restricted excluded')} value={formatInteger.format(improvementSummary?.memory.injection.excludedRestrictedCount || 0)} />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void startDreamRun()}
                        disabled={dreamStartDisabled}
                        aria-busy={improvementActionId === 'start-dream:manual'}
                        className="rounded-full border border-border-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent hover:border-accent disabled:opacity-50"
                      >
                        {t('homepage.card.runConsolidation', 'Run consolidation')}
                      </button>
                      {dreamRunInFlight ? (
                        <span className="text-[11px] text-text-muted">
                          {t('homepage.card.consolidationRunning', 'Consolidation is already running.')}
                        </span>
                      ) : null}
                    </div>
                    <PulseImprovementInbox
                      inbox={improvementInbox}
                      actionId={improvementActionId}
                      onReview={(id, action) => void reviewImprovement(id, action)}
                      onUpdateProposal={updateImprovementProposal}
                    />
                    <div
                      className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[12px] text-text-secondary leading-relaxed"
                      style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)' }}
                    >
                      {improvementSummary
                        ? t('homepage.card.learningNote', 'Learning stays proposal-only: memories and dream runs can surface candidates, but approved runtime behavior changes still require review.')
                        : t('homepage.card.learningUnavailable', 'Governed learning diagnostics are not available yet.')}
                    </div>
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

              <PulseSidebar
                busySessions={busySessions}
                dashboardSummary={dashboardSummary}
                diagnostics={diagnostics}
                leadAgent={leadAgent}
                recentSessions={recentSessions}
                onCreateThread={createThread}
                onOpenRecentThread={openRecentThread}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
