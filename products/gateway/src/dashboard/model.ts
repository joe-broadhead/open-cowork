import { asArray, shortId, fmtNumber, fmtPct } from './format.js'
import { buildUsageWindow, type OpenCodeUsageReport } from '../opencode-usage.js'
import { missionControlWindow as dashboardWindow, type OperationsCockpitSummary } from '../mission-control-view-model.js'
import type { HeartbeatStatus } from '../heartbeat.js'
import type { ServiceHealthReport } from '../service-health.js'
import type { OperatorSafetyReport } from '../operator-safety.js'
import type { MissionChannelSummary, MissionAgentTeamSummary } from '../mission-data.js'
import type { ChannelConnectorState } from '../channels/capabilities.js'
import type {
  DashboardView,
  AgentFactoryView,
  AgentFactoryProfileView,
  AgentFactoryTeamView,
  PromotionProjectionView,
  ArenaView,
  ArenaEvidenceView,
  ArenaRunView,
  PromotionHistoryEntryView,
  WorkGraphView,
  WorkGraphNode,
  WorkGraphEdge,
  WorkGraphSourceAvailability,
} from './types.js'

function buildAgentFactoryView(m: any): AgentFactoryView {
  const scorecards = asArray(m.promotionScorecards)
  const decisions = asArray(m.promotionDecisions)
  const runs = asArray(m.runs)
  const catalogProfiles = new Map(asArray(m.agentCatalog?.profiles).map((profile: any) => [profile.name, profile]))
  const catalogTeams = new Map(asArray(m.agentCatalog?.teams).map((team: any) => [team.name, team]))
  const profiles = Object.entries(m.profiles || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, profile]) => buildProfileFactoryRow(name, profile, scorecards, decisions, runs, catalogProfiles.get(name)))
  const teams = asArray(m.agentTeams?.teams).map((team: any) => buildTeamFactoryRow(team, scorecards, decisions, catalogTeams.get(team.name)))
  const blueprints = asArray(m.agentCatalog?.blueprints)
  const blueprintSources = asArray(m.agentCatalog?.sources?.blueprints)
  const blueprintGates = asArray(m.humanGates).filter((gate: any) => String(gate.scopeKey || '').startsWith('blueprint:apply:'))
  const blockedProfiles = profiles.filter(profile => profile.validation === 'blocked' || profile.promotion.state === 'blocked').length
  const deprecatedProfiles = profiles.filter(profile => profile.promotion.state === 'deprecated').length
  const blockedTeams = teams.filter(team => team.validation === 'blocked' || team.promotion.state === 'blocked' || team.promotion.state === 'deprecated').length
  return {
    profiles,
    teams,
    blueprints,
    blueprintSources,
    invalidReferences: asArray(m.agentTeams?.invalidReferences),
    scorecards,
    decisions,
    blueprintGates,
    totals: {
      profiles: profiles.length,
      teams: teams.length,
      blueprints: blueprints.length,
      blockedProfiles,
      deprecatedProfiles,
      blockedTeams,
      warnings: profiles.filter(profile => profile.validation !== 'valid').length + teams.filter(team => team.validation !== 'valid').length,
      scorecards: scorecards.length,
      blueprintGates: blueprintGates.length,
    },
  }
}

function buildProfileFactoryRow(name: string, profile: any, scorecards: any[], decisions: any[], runs: any[], catalog?: any): AgentFactoryProfileView {
  const permissions = Object.entries(profile?.permission || {}) as Array<[string, string]>
  const permissionCounts = { allow: 0, ask: 0, deny: 0 }
  for (const [, policy] of permissions) {
    if (policy === 'allow' || policy === 'ask' || policy === 'deny') permissionCounts[policy] += 1
  }
  const allowedPermissions = permissions.filter(([, policy]) => policy === 'allow').map(([key]) => key || '(default)')
  const riskyPermissions = allowedPermissions.filter(key => isRiskyPermission(key))
  const promotion = promotionProjection('profile', name, profile?.promotionState, scorecards, decisions)
  const inspection = catalog?.inspection || profile?.inspection
  const inspectionWarnings = asArray(inspection?.warnings).map((row: any) => `${row.code}: ${row.message}`)
  const warnings = inspectionWarnings.length ? [...inspectionWarnings, ...promotionWarnings(promotion.state)] : profileWarnings(profile, promotion, riskyPermissions)
  const profileRuns = runs.filter(run => (run.resolvedProfile || run.profile) === name)
  return {
    name,
    version: catalog?.version || profile?.version || 'configured',
    revision: catalog?.revision,
    lastUpdatedAt: catalog?.lastUpdatedAt || profile?.updatedAt,
    description: profile?.description,
    agent: profile?.agent || '?',
    model: `${profile?.model?.providerID || '?'}/${profile?.model?.modelID || '?'}${profile?.model?.variant ? `:${profile.model.variant}` : ''}`,
    role: profile?.role || '?',
    skills: asArray(profile?.skills).map(String),
    mcpServers: asArray(profile?.mcpServers).map(String),
    tools: asArray(profile?.tools).map(String),
    capabilities: asArray(profile?.capabilities).map(String),
    permissionCounts,
    allowedPermissions,
    riskyPermissions,
    environment: environmentLabel(profile?.environment),
    budget: {
      maxTokens: Number(profile?.maxTokens || 0),
      contractTokens: profile?.budget?.maxTokens,
      maxCostUsd: profile?.budget?.maxCostUsd,
      maxRuntimeMs: profile?.budget?.maxRuntimeMs,
      retryLimit: profile?.budget?.retryLimit,
      humanGate: profile?.budget?.humanGate,
    },
    outputContract: profile?.outputContract?.format || 'text',
    promotion,
    validation: inspection?.status === 'valid' || inspection?.status === 'warning' || inspection?.status === 'blocked'
      ? inspection.status
      : validationFromWarnings(promotion.state, warnings),
    warnings,
    runStats: {
      total: profileRuns.length,
      active: profileRuns.filter(run => run.status === 'running').length,
      failed: profileRuns.filter(run => run.status === 'failed' || run.status === 'errored').length,
      lastStatus: profileRuns.slice(-1)[0]?.status,
    },
  }
}

function buildTeamFactoryRow(team: any, scorecards: any[], decisions: any[], catalog?: any): AgentFactoryTeamView {
  const promotion = promotionProjection('team', team.name, team.promotionState, scorecards, decisions)
  const inspection = catalog?.inspection || team.inspection
  const codedWarnings = asArray(inspection?.warnings).map((row: any) => `${row.code}: ${row.message}`)
  const baseWarnings = codedWarnings.length ? codedWarnings : asArray(catalog?.warnings ?? team.warnings).map(String)
  const warnings = [...baseWarnings, ...promotionWarnings(promotion.state)]
  const validation = inspection?.status === 'valid' || inspection?.status === 'warning' || inspection?.status === 'blocked'
    ? inspection.status
    : catalog?.status === 'valid' || catalog?.status === 'warning' || catalog?.status === 'blocked'
      ? catalog.status
    : validationFromWarnings(promotion.state, warnings)
  return {
    name: team.name,
    description: team.description,
    revision: team.revision || '',
    version: catalog?.version || team.version,
    lastUpdatedAt: catalog?.lastUpdatedAt || team.updatedAt,
    promotion,
    validation,
    warnings,
    roles: asArray(team.roles),
    capabilityRequirements: asArray(team.capabilityRequirements),
    qualitySpecDefaultKeys: asArray(team.qualitySpecDefaultKeys),
    references: team.references || { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 },
  }
}

function buildArenaView(input: { scorecards: any[]; decisions?: any[]; sourceAvailable?: boolean }): ArenaView {
  const scorecards = asArray(input.scorecards)
  const decisions = asArray(input.decisions)
  const evidence = asArray(input.scorecards)
    .filter(scorecard => scorecard.sourceKind === 'arena' || scorecard.sourceKind === 'eval')
    .map(scorecard => {
      const scoreMetric = asArray(scorecard.metrics).find((metric: any) => metric.id === 'arena.score') || asArray(scorecard.metrics)[0]
      const pct = scoreMetric?.maxScore ? Number(scoreMetric.score || 0) / Number(scoreMetric.maxScore || 1) : undefined
      const failedMetrics = asArray(scorecard.metrics).filter((metric: any) => metric.passed === false)
      return {
        scorecard,
        subject: `${scorecard.subjectKind}:${scorecard.subjectName}`,
        scoreLabel: scoreMetric ? `${fmtNumber(Number(scoreMetric.score || 0))}/${fmtNumber(Number(scoreMetric.maxScore || 0))}${pct !== undefined ? ` (${fmtPct(pct)})` : ''}` : '--',
        scorePct: pct,
        failedMetrics,
        artifacts: asArray(scorecard.evidence).filter(isArtifactRef),
      }
    })
    .sort((a, b) => Date.parse(b.scorecard.updatedAt || '') - Date.parse(a.scorecard.updatedAt || ''))
  const runs = evidence.map(row => buildArenaRun(row, decisions))
  const groups = new Map<string, ArenaEvidenceView[]>()
  for (const row of evidence) {
    const key = `${row.scorecard.sourceKind}:${row.scorecard.sourceId}:${row.scorecard.sourceVersion || ''}`
    const rows = groups.get(key) || []
    rows.push(row)
    groups.set(key, rows)
  }
  const comparisons = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ key, label: key.replace(/:$/, ''), rows: rows.slice().sort((a, b) => Number(b.scorePct || 0) - Number(a.scorePct || 0)) }))
  const promotionHistory = buildPromotionHistory(scorecards, decisions)
  const sourceAvailable = input.sourceAvailable !== false
  return {
    runs,
    evidence,
    comparisons,
    promotionHistory,
    source: {
      available: sourceAvailable,
      partial: sourceAvailable && scorecards.length > 0 && decisions.length === 0,
      scorecards: scorecards.length,
      decisions: decisions.length,
    },
    totals: {
      runs: evidence.length,
      passed: evidence.filter(row => row.scorecard.status !== 'blocked' && row.scorecard.recommendation !== 'block').length,
      failed: evidence.filter(row => row.scorecard.status === 'blocked' || row.scorecard.recommendation === 'block').length,
      artifacts: evidence.reduce((sum, row) => sum + row.artifacts.length, 0),
      comparisons: comparisons.length,
      history: promotionHistory.length,
    },
  }
}

function buildArenaRun(row: ArenaEvidenceView, decisions: any[]): ArenaRunView {
  const scorecard = row.scorecard
  const scorecardDecisions = decisions.filter(decision => decision.scorecardId === scorecard.id)
  const relatedDecision = scorecardDecisions.sort(compareUpdatedDesc)[0]
  const passed = scorecard.status !== 'blocked' && scorecard.recommendation !== 'block'
  const sourceLabel = `${scorecard.sourceKind}:${scorecard.sourceId}${scorecard.sourceVersion ? `@${scorecard.sourceVersion}` : ''}`
  const subjectLabel = `${scorecard.subjectKind}:${scorecard.subjectName}`
  return {
    id: scorecard.id,
    status: scorecard.status || (passed ? 'evaluated' : 'blocked'),
    passed,
    sourceLabel,
    inputLabel: sourceLabel,
    candidateLabel: subjectLabel,
    candidateHref: agentFactorySubjectHref(scorecard.subjectKind, scorecard.subjectName),
    version: scorecard.subjectRevision || scorecard.sourceVersion || '--',
    scoreLabel: row.scoreLabel,
    conclusion: scorecard.conclusion || 'No conclusion recorded.',
    recommendation: scorecard.recommendation || 'hold',
    promotionOutcome: relatedDecision ? `${relatedDecision.action || 'decision'} ${relatedDecision.status || 'pending'} -> ${relatedDecision.toStatus || '?'}` : `${scorecard.recommendation || 'hold'} recommended`,
    regressionLabel: regressionLabel(scorecard.regression),
    gateResult: relatedDecision?.status || (scorecard.gateId ? 'gate pending' : scorecard.status || 'not gated'),
    failedMetrics: row.failedMetrics,
    thresholds: asArray(scorecard.thresholds),
    artifacts: row.artifacts,
    evidence: asArray(scorecard.evidence),
    updatedAt: scorecard.updatedAt,
    createdAt: scorecard.createdAt,
    scorecard,
    decision: relatedDecision,
  }
}

function buildPromotionHistory(scorecards: any[], decisions: any[]): PromotionHistoryEntryView[] {
  const scorecardRows = scorecards.map(scorecard => ({
    id: `scorecard:${scorecard.id}`,
    subjectLabel: `${scorecard.subjectKind}:${scorecard.subjectName}`,
    subjectHref: agentFactorySubjectHref(scorecard.subjectKind, scorecard.subjectName),
    version: scorecard.subjectRevision || scorecard.sourceVersion || '--',
    event: `scorecard ${scorecard.recommendation || 'hold'}`,
    gateResult: scorecard.status || 'evaluated',
    reviewer: `${scorecard.sourceKind || 'manual'}:${scorecard.sourceId || scorecard.id}`,
    rollbackEligibility: 'unknown',
    sourceLabel: scorecard.sourceVersion ? `${scorecard.sourceKind}:${scorecard.sourceId}@${scorecard.sourceVersion}` : `${scorecard.sourceKind}:${scorecard.sourceId}`,
    timestamp: scorecard.updatedAt || scorecard.createdAt,
    statusClass: scorecard.status === 'blocked' || scorecard.recommendation === 'block' ? 'bad' : 'good',
  }))
  const decisionRows = decisions.map(decision => ({
    id: `decision:${decision.id}`,
    subjectLabel: `${decision.subjectKind}:${decision.subjectName}`,
    subjectHref: agentFactorySubjectHref(decision.subjectKind, decision.subjectName),
    version: decision.subjectRevision || '--',
    event: `${decision.action || 'decision'} ${decision.fromStatus || '?'} -> ${decision.toStatus || '?'}`,
    gateResult: decision.status || 'pending',
    reviewer: [decision.actor, decision.source].filter(Boolean).join(' / ') || 'gateway.promotion',
    rollbackEligibility: rollbackEligibilityLabel(decision),
    sourceLabel: decision.scorecardId || decision.gateId || 'manual decision',
    timestamp: decision.updatedAt || decision.createdAt,
    statusClass: decision.status === 'rejected' ? 'bad' : decision.status === 'pending' || decision.status === 'approved' ? 'warn' : 'good',
  }))
  return [...scorecardRows, ...decisionRows].sort((a, b) => {
    const time = Date.parse(b.timestamp || '') - Date.parse(a.timestamp || '')
    if (Number.isFinite(time) && time !== 0) return time
    return a.id.localeCompare(b.id)
  })
}

function rollbackEligibilityLabel(decision: any): string {
  if (decision.status === 'applied' && decision.action === 'rollback') return 'applied'
  const rollback = decision.metadata?.rollback
  if (rollback?.status) return rollback.eligible ? 'eligible' : String(rollback.status).replace(/_/g, ' ')
  if (decision.status !== 'applied') return 'pending'
  if (decision.toStatus === 'deprecated' || decision.toStatus === 'blocked') return 'eligible'
  if (decision.toStatus === 'promoted') return 'not needed'
  return 'unknown'
}

function regressionLabel(regression: any): string {
  if (!regression?.status) return 'regression: no baseline'
  if (regression.status === 'not_applicable') return 'regression: not comparable'
  const delta = Number(regression.delta || 0)
  const suffix = Number.isFinite(delta) && delta > 0 ? ` (${Math.round(delta * 1000) / 10} pp)` : ''
  return `regression: ${String(regression.status).replace(/_/g, ' ')}${suffix}`
}

function agentFactorySubjectHref(_kind: string, _name: string): string {
  return `#/agent-factory`
}

function compareUpdatedDesc(a: any, b: any): number {
  const time = Date.parse(b?.updatedAt || b?.createdAt || '') - Date.parse(a?.updatedAt || a?.createdAt || '')
  if (Number.isFinite(time) && time !== 0) return time
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}

function promotionProjection(subjectKind: string, subjectName: string, configState: string | undefined, scorecards: any[], decisions: any[]): PromotionProjectionView {
  const subjectScorecards = scorecards.filter(scorecard => scorecard.subjectKind === subjectKind && scorecard.subjectName === subjectName).sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
  const appliedDecision = decisions.filter(decision => decision.subjectKind === subjectKind && decision.subjectName === subjectName && decision.status === 'applied').sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0]
  const latestScorecard = subjectScorecards[0]
  return {
    state: appliedDecision?.toStatus || latestScorecard?.status || configState || 'draft',
    scorecardId: latestScorecard?.id,
    recommendation: latestScorecard?.recommendation,
    sourceKind: latestScorecard?.sourceKind,
    sourceId: latestScorecard?.sourceId,
    sourceVersion: latestScorecard?.sourceVersion,
    decisionId: appliedDecision?.id,
    rollback: appliedDecision?.metadata?.rollback,
    regression: latestScorecard?.regression,
    updatedAt: appliedDecision?.updatedAt || latestScorecard?.updatedAt,
  }
}

function profileWarnings(profile: any, promotion: PromotionProjectionView, riskyPermissions: string[]): string[] {
  const warnings = [...promotionWarnings(promotion.state)]
  if (!asArray(profile?.skills).length) warnings.push('no skills declared')
  if (!asArray(profile?.tools).length && !asArray(profile?.mcpServers).length) warnings.push('no explicit tool or MCP bounds')
  if (riskyPermissions.length) warnings.push(`risky allow grants: ${riskyPermissions.slice(0, 4).join(', ')}`)
  if (Number(profile?.maxTokens || 0) >= 150000 && !profile?.budget?.maxTokens) warnings.push('large token ceiling without budget contract')
  if (!profile?.budget) warnings.push('no budget contract')
  return warnings
}

function promotionWarnings(state: string): string[] {
  if (state === 'blocked') return ['promotion state is blocked']
  if (state === 'deprecated') return ['promotion state is deprecated']
  return []
}

function validationFromWarnings(state: string, warnings: string[]): 'valid' | 'warning' | 'blocked' {
  if (state === 'blocked' || state === 'deprecated') return 'blocked'
  return warnings.length ? 'warning' : 'valid'
}
function isRiskyPermission(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === '(default)' || normalized === '*' || normalized.includes('credential') || normalized.includes('secret') || normalized.includes('token') || ['bash', 'edit', 'webfetch', 'websearch'].includes(normalized)
}

function environmentLabel(value: unknown): string {
  if (!value) return 'default'
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const row = value as Record<string, any>
    return [row['name'], row['backend']].filter(Boolean).join(':') || 'inline'
  }
  return String(value)
}

function isArtifactRef(value: unknown): boolean {
  const text = String(value || '')
  return /^(file|artifact|http|https):/i.test(text) || /\.(log|json|txt|md|html|png|jpg|jpeg|svg|zip)$/i.test(text)
}

function buildWorkGraphView(m: any): WorkGraphView {
  const nodes = new Map<string, WorkGraphNode>()
  const edges: WorkGraphEdge[] = []
  const tasks = asArray(m.tasks)
  const roadmaps = asArray(m.roadmaps)
  const projectBindings = asArray(m.projectBindings)
  const runs = asArray(m.runs)
  const supervisors = asArray(m.supervisors)
  const alerts = asArray(m.alerts)
  const questions = asArray(m.questions)
  const permissions = asArray(m.permissions)
  const gates = [...asArray(m.humanGates), ...asArray(m.gates), ...asArray(m.completionProposals), ...questions, ...permissions]
  const channels = m.channels || emptyChannels()
  const channelLinks = asArray(channels.links)
  const sourceAvailability = (m._sourceAvailability || {}) as WorkGraphSourceAvailability

  const addNode = (node: WorkGraphNode) => {
    if (!node.id) return
    const existing = nodes.get(node.id)
    nodes.set(node.id, existing ? mergeWorkGraphNode(existing, node) : node)
  }
  const addEdge = (edge: WorkGraphEdge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return
    edges.push(edge)
  }

  for (const roadmap of roadmaps) {
    addNode({ id: roadmap.id, kind: 'initiative', label: roadmap.title || roadmap.id, status: roadmap.status || 'active', severity: statusSeverity(roadmap.status), source: '/roadmaps', href: '#/pipeline', updatedAt: roadmap.updatedAt, alias: roadmap.id, summary: `${roadmap.totalTasks || 0} Issues, ${roadmap.blockedTasks || 0} blocked.` })
  }
  for (const task of tasks) {
    addNode({ id: task.id, kind: 'issue', label: task.title || task.id, status: task.status || 'unknown', severity: statusSeverity(task.status, task.priority), source: '/tasks', href: '#/pipeline', updatedAt: task.updatedAt, alias: task.id, summary: task.readiness?.reason || task.description || task.note })
    if (task.roadmapId) addEdge({ from: task.roadmapId, to: task.id, kind: 'owns issue', source: '/tasks', status: task.status || 'linked', severity: statusSeverity(task.status, task.priority), reason: task.readiness?.reason || 'task.roadmapId' })
    if (task.currentRunId) addEdge({ from: task.id, to: task.currentRunId, kind: 'current run', source: '/tasks', status: task.status || 'linked', severity: statusSeverity(task.status, task.priority), reason: 'task.currentRunId' })
  }
  for (const binding of projectBindings) {
    const projectId = binding.id || `project:${binding.alias || binding.roadmapId || binding.sessionId}`
    const channelId = channelTargetId(binding)
    addNode({ id: projectId, kind: 'project', label: binding.alias || binding.title || projectId, status: binding.notificationMode === 'muted' ? 'muted' : 'bound', severity: binding.notificationMode === 'muted' ? 'warning' : 'ok', source: '/project-bindings', href: '#/channels', updatedAt: binding.updatedAt, alias: binding.alias, summary: `notification mode ${binding.notificationMode || 'immediate'}` })
    if (binding.roadmapId) addEdge({ from: projectId, to: binding.roadmapId, kind: 'binds initiative', source: '/project-bindings', status: 'linked', severity: 'ok', reason: 'projectBinding.roadmapId' })
    if (binding.sessionId) {
      addNode({ id: binding.sessionId, kind: 'session', label: binding.sessionId, status: 'linked', severity: 'ok', source: '/project-bindings', href: '#/channels', alias: binding.sessionId, summary: 'Session referenced by project binding.' })
      addEdge({ from: projectId, to: binding.sessionId, kind: 'binds session', source: '/project-bindings', status: 'linked', severity: 'ok', reason: 'projectBinding.sessionId' })
    }
    if (channelId) {
      addNode({ id: channelId, kind: 'channel-target', label: channelLabel(binding), status: binding.notificationMode === 'muted' ? 'muted' : 'bound', severity: binding.notificationMode === 'muted' ? 'warning' : 'ok', source: '/project-bindings', href: '#/channels', alias: binding.provider || binding.scope, redacted: true, summary: 'Channel target identifiers are shown; credentials are redacted.' })
      addEdge({ from: channelId, to: projectId, kind: 'routes to project', source: '/project-bindings', status: binding.notificationMode || 'immediate', severity: binding.notificationMode === 'muted' ? 'warning' : 'ok', reason: 'provider/chatId/threadId' })
    }
  }
  for (const link of channelLinks) {
    const channelId = channelTargetId(link)
    if (!channelId) continue
    addNode({ id: channelId, kind: 'channel-target', label: channelLabel(link), status: link.mode || 'linked', severity: 'ok', source: '/channels/bindings', href: '#/channels', alias: link.provider, redacted: true, summary: 'Channel binding mirror from channel session storage.' })
    if (link.sessionId) {
      addNode({ id: link.sessionId, kind: 'session', label: link.sessionId, status: 'linked', severity: 'ok', source: '/channels/bindings', href: '#/channels', alias: link.sessionId })
      addEdge({ from: channelId, to: link.sessionId, kind: 'opens session', source: '/channels/bindings', status: link.mode || 'linked', severity: 'ok', reason: 'channelBinding.sessionId' })
    }
    if (link.roadmapId) addEdge({ from: channelId, to: link.roadmapId, kind: 'mentions initiative', source: '/channels/bindings', status: 'linked', severity: 'ok', reason: 'channelBinding.roadmapId' })
    if (link.taskId) addEdge({ from: channelId, to: link.taskId, kind: 'mentions issue', source: '/channels/bindings', status: 'linked', severity: 'ok', reason: 'channelBinding.taskId' })
  }
  for (const session of asArray(m.sessions)) {
    addNode({ id: session.id, kind: 'session', label: session.title || session.id, status: session.status || 'unknown', severity: statusSeverity(session.status), source: '/opencode/sessions', href: session.webUrl || '#/channels', updatedAt: session.created ? new Date(session.created).toISOString() : undefined, alias: session.agent, summary: session.webUrl ? 'OpenCode web link available.' : 'Gateway session projection.' })
  }
  for (const run of runs) {
    addNode({ id: run.id, kind: 'run', label: `${run.stage || 'run'} ${shortId(run.id)}`, status: run.status || 'unknown', severity: statusSeverity(run.status), source: '/runs', href: '#/pipeline', updatedAt: run.completedAt || run.startedAt, alias: run.profile || run.resolvedProfile, summary: run.result?.summary || run.result?.failureClass || `${run.stage || 'stage'} attempt ${run.attempt || 1}` })
    if (run.taskId) addEdge({ from: run.taskId, to: run.id, kind: 'has run', source: '/runs', status: run.status || 'linked', severity: statusSeverity(run.status), reason: 'run.taskId' })
    if (run.sessionId) {
      addNode({ id: run.sessionId, kind: 'session', label: run.sessionId, status: run.status === 'running' ? 'running' : 'linked', severity: run.status === 'running' ? 'warning' : 'ok', source: '/runs', href: '#/channels', alias: run.sessionId })
      addEdge({ from: run.id, to: run.sessionId, kind: 'uses session', source: '/runs', status: run.status || 'linked', severity: statusSeverity(run.status), reason: 'run.sessionId' })
    }
    const profile = run.resolvedProfile || run.profile
    if (profile) {
      const profileId = `profile:${profile}`
      addNode({ id: profileId, kind: 'profile', label: profile, status: 'resolved', severity: 'ok', source: '/agent-teams', href: '#/health', alias: run.resolvedAgent, summary: run.resolvedAgent ? `agent ${run.resolvedAgent}` : 'Profile resolved for run.' })
      addEdge({ from: run.id, to: profileId, kind: 'uses profile', source: '/runs', status: 'resolved', severity: 'ok', reason: 'run.profile/resolvedProfile' })
    }
    if (run.agentTeam) {
      const teamId = `team:${run.agentTeam}`
      addNode({ id: teamId, kind: 'team', label: run.agentTeam, status: 'resolved', severity: 'ok', source: '/agent-teams', href: '#/health', alias: run.agentTeamVersion, summary: run.agentTeamVersion ? `revision ${run.agentTeamVersion}` : 'Agent team selected for run.' })
      addEdge({ from: run.id, to: teamId, kind: 'uses team', source: '/runs', status: 'resolved', severity: 'ok', reason: 'run.agentTeam' })
    }
  }
  for (const supervisor of supervisors) {
    const supervisorId = supervisor.supervisorId || supervisor.id
    addNode({ id: supervisorId, kind: 'supervisor', label: supervisor.roadmapTitle || supervisorId, status: supervisor.health || supervisor.status || 'unknown', severity: statusSeverity(supervisor.health || supervisor.status), source: '/roadmap-supervisors', href: '#/health', updatedAt: supervisor.updatedAt || supervisor.lastResultAt || supervisor.nextReviewAt, alias: supervisor.sessionId, summary: supervisor.lastResultSummary || supervisor.reason || 'Roadmap supervisor projection.' })
    if (supervisor.roadmapId) addEdge({ from: supervisorId, to: supervisor.roadmapId, kind: 'supervises initiative', source: '/roadmap-supervisors', status: supervisor.health || supervisor.status || 'linked', severity: statusSeverity(supervisor.health || supervisor.status), reason: 'supervisor.roadmapId' })
    if (supervisor.sessionId) {
      addNode({ id: supervisor.sessionId, kind: 'session', label: supervisor.sessionId, status: 'linked', severity: 'ok', source: '/roadmap-supervisors', href: '#/channels', alias: supervisor.sessionId })
      addEdge({ from: supervisorId, to: supervisor.sessionId, kind: 'uses session', source: '/roadmap-supervisors', status: 'linked', severity: 'ok', reason: 'supervisor.sessionId' })
    }
  }
  for (const gate of gates) {
    const gateId = gate.id || gate.requestId
    if (!gateId) continue
    const isOpenCodeRequest = Boolean(gate.sessionID || gate.questions || gate.permission)
    const source = isOpenCodeRequest || gate.requestId ? '/opencode/requests' : '/human-gates'
    const target = gate.subjectId || gate.taskId || gate.runId || gate.roadmapId || gate.sessionID || gate.sessionId || gate.scopeKey
    const label = gate.title || gate.kind || gate.type || (gate.questions ? 'question' : gate.permission ? 'permission' : gateId)
    const summary = gate.summary || gate.recommendation || (gate.questions ? `${asArray(gate.questions).length} OpenCode question${asArray(gate.questions).length === 1 ? '' : 's'} pending.` : gate.permission ? 'OpenCode permission request pending; details are redacted.' : 'Gate or OpenCode request requires an operator decision.')
    addNode({ id: gateId, kind: 'gate', label, status: gate.status || 'pending', severity: statusSeverity(gate.status === 'pending' ? 'blocked' : gate.status), source, href: '#/health', updatedAt: gate.updatedAt || gate.createdAt, alias: gate.scopeKey || gate.sessionID, summary, redacted: true })
    if (target) addEdge({ from: gateId, to: target, kind: 'blocks subject', source, status: gate.status || 'pending', severity: statusSeverity(gate.status === 'pending' ? 'blocked' : gate.status), reason: gate.scopeKey || gate.subjectId || (isOpenCodeRequest ? 'OpenCode request sessionID' : 'request target') })
  }
  for (const alert of alerts) {
    const alertId = alert.id || alert.key || alert.dedupeKey
    if (!alertId) continue
    const target = (typeof alert.target === 'string' ? alert.target : alert.target?.id) || alert.targetId || alert.subjectId || alert.taskId || alert.runId || alert.roadmapId
    addNode({ id: alertId, kind: 'alert', label: alert.summary || alert.key || alertId, status: alert.status || 'active', severity: alertSeverity(alert.severity), source: '/alerts', href: '#/health', updatedAt: alert.updatedAt || alert.createdAt, alias: alert.dedupeKey || alert.key, summary: alert.nextAction || alert.source || 'Alert engine record.' })
    if (target) addEdge({ from: alertId, to: target, kind: 'alerts subject', source: '/alerts', status: alert.status || 'active', severity: alertSeverity(alert.severity), reason: alert.nextAction || alert.dedupeKey || 'alert target' })
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id))
  const sortedEdges = edges.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.from.localeCompare(b.from))
  const nodeWindow = dashboardWindow('workGraphNodes', sortedNodes, m._windowOptions || {}, true)
  const edgeWindow = dashboardWindow('workGraphEdges', sortedEdges, m._windowOptions || {}, true)
  const attentionEdges = sortedEdges.filter(edge => edge.severity !== 'ok')
  return {
    nodes: nodeWindow.rows,
    edges: edgeWindow.rows,
    attentionEdges,
    selected: nodeWindow.rows[0],
    sources: [
      { name: 'Issues', route: '/tasks', available: sourceAvailability.tasks === true, count: tasks.length },
      { name: 'Initiatives', route: '/roadmaps', available: sourceAvailability.roadmaps === true, count: roadmaps.length },
      { name: 'Projects', route: '/project-bindings', available: sourceAvailability.projectBindings === true, count: projectBindings.length },
      { name: 'Runs', route: '/runs', available: sourceAvailability.runs === true, count: runs.length },
      { name: 'Supervisors', route: '/roadmap-supervisors', available: sourceAvailability.supervisors === true, count: supervisors.length },
      { name: 'Sessions', route: '/opencode/sessions', available: sourceAvailability.sessions === true, count: asArray(m.sessions).length },
      { name: 'Channel Targets', route: '/channels/bindings', available: sourceAvailability.channels === true, count: channelLinks.length },
      { name: 'Local Gates', route: '/human-gates and /completion-proposals', available: sourceAvailability.humanGates === true || sourceAvailability.completionProposals === true, count: asArray(m.humanGates).length + asArray(m.completionProposals).length },
      { name: 'OpenCode Requests', route: '/opencode/requests', available: sourceAvailability.requests === true, count: asArray(m.questions).length + asArray(m.permissions).length },
      { name: 'Alerts', route: '/alerts', available: sourceAvailability.alerts === true, count: alerts.length },
    ],
    window: {
      nodes: nodeWindow.contract,
      edges: edgeWindow.contract,
    },
    stats: {
      channels: sortedNodes.filter(node => node.kind === 'channel-target').length,
      sessions: sortedNodes.filter(node => node.kind === 'session').length,
      projects: sortedNodes.filter(node => node.kind === 'project').length,
      initiatives: sortedNodes.filter(node => node.kind === 'initiative').length,
      issues: sortedNodes.filter(node => node.kind === 'issue').length,
      runs: sortedNodes.filter(node => node.kind === 'run').length,
      supervisors: sortedNodes.filter(node => node.kind === 'supervisor').length,
      gates: sortedNodes.filter(node => node.kind === 'gate').length,
      alerts: sortedNodes.filter(node => node.kind === 'alert').length,
      blocked: sortedNodes.filter(node => node.severity === 'critical' || node.severity === 'warning').length,
    },
  }
}

function channelTargetId(value: any): string {
  if (!value?.provider || !value?.chatId) return ''
  return `channel:${value.provider}:${value.chatId}${value.threadId ? `:${value.threadId}` : ''}`
}

function channelLabel(value: any): string {
  if (!value?.provider || !value?.chatId) return 'channel target'
  return `${value.provider}:${value.chatId}${value.threadId ? `:${value.threadId}` : ''}`
}

function statusSeverity(status: string, priority?: string): WorkGraphNode['severity'] {
  const value = String(status || '').toLowerCase()
  if (value === 'blocked' || value === 'failed' || value === 'errored' || value === 'critical' || value === 'due' || value === 'stale') return 'critical'
  if (value === 'paused' || value === 'pending' || value === 'running' || value === 'warning' || value === 'muted') return 'warning'
  if (String(priority || '').toUpperCase() === 'HIGH') return 'warning'
  if (!value || value === 'unknown') return 'info'
  return 'ok'
}

function mergeWorkGraphNode(existing: WorkGraphNode, next: WorkGraphNode): WorkGraphNode {
  const merged = { ...existing, ...next, severity: maxSeverity(existing.severity, next.severity) }
  if (existing.kind === 'session' && existing.source === '/opencode/sessions' && next.source !== '/opencode/sessions') {
    return {
      ...merged,
      label: existing.label,
      status: existing.status,
      source: existing.source,
      href: existing.href,
      updatedAt: existing.updatedAt,
      alias: existing.alias || next.alias,
      summary: existing.summary || next.summary,
    }
  }
  return merged
}

function alertSeverity(severity: string): WorkGraphNode['severity'] {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning' || severity === 'high' || severity === 'medium') return 'warning'
  if (severity) return 'info'
  return 'warning'
}

function maxSeverity(a: WorkGraphNode['severity'], b: WorkGraphNode['severity']): WorkGraphNode['severity'] {
  return severityRank(a) >= severityRank(b) ? a : b
}

function severityRank(severity: WorkGraphNode['severity']): number {
  if (severity === 'critical') return 4
  if (severity === 'warning') return 3
  if (severity === 'info') return 2
  return 1
}

function kindRank(kind: string): number {
  return ['alert', 'gate', 'channel-target', 'session', 'project', 'initiative', 'issue', 'run', 'supervisor', 'team', 'profile'].indexOf(kind)
}
function emptyUsage(): OpenCodeUsageReport {
  const totals = { sessions: 0, messages: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheHits: 0, tokenBurn: 0, cacheHitRate: 0 }
  return { available: false, source: 'unavailable', window: buildUsageWindow(), totals, byModel: [], byAgent: [], topSessions: [], series: [] }
}

function emptyHeartbeat(): HeartbeatStatus {
  return { enabled: false, schedulerEnabled: false, intervalMs: 0, running: false, status: 'never', tickCount: 0, skippedTicks: 0 }
}

function emptyServiceHealth(): ServiceHealthReport {
  return { status: 'down', generatedAt: new Date(0).toISOString(), summary: 'Service health unavailable', components: [], counts: { ok: 0, degraded: 0, down: 1 }, attention: [], deferred: [] }
}

function emptyOperator(readiness: any, governance: any, counts: DashboardView['counts']): OperatorSafetyReport {
  return {
    generatedAt: new Date(0).toISOString(),
    state: readiness?.state === 'ready' ? 'attention' : 'blocked',
    summary: 'Operator report unavailable from mission data.',
    releaseClaim: {
      scope: 'Public local beta readiness for one trusted operator using OpenCode Web/TUI and validated trusted channel surfaces.',
      productionCertified: false,
      notes: ['The public release decision supports public local beta only; local production, hosted/team, and WhatsApp live-parity claims remain separate gates.'],
    },
    scheduler: { enabled: true, maxConcurrent: counts.running || 0, intervalMs: 0, runningRuns: counts.running || 0, expiredLeases: 0, availableSlots: 0, leaseOwners: {} },
    capacity: {
      generatedAt: new Date(0).toISOString(),
      scheduler: { running: counts.running || 0, starting: 0, maxConcurrent: counts.running || 0, availableSlots: 0, pending: counts.pending || 0 },
      dimensions: [],
      providerBackoff: [],
      humanGatePressure: 0,
    },
    queue: { total: 0, pending: counts.pending || 0, running: counts.running || 0, done: counts.done || 0, blocked: counts.blocked || 0, paused: counts.paused || 0, cancelled: counts.cancelled || 0, archived: 0, high: 0, medium: 0, low: 0 },
    activeRuns: [],
    readiness: { state: readiness?.state || 'unknown', summary: readiness?.summary || 'Readiness unavailable', critical: 0, warnings: 0 },
    requests: { questionsAvailable: false, permissionsAvailable: false, errors: ['Operator report unavailable'] },
    governance: { status: governance?.status || 'unknown', summary: governance?.summary || 'Governance unavailable' },
    channels: { ready: [], needsAttention: [], deferred: [{ gate: 'whatsapp_live_parity', reason: 'Deferred.' }, { gate: 'production_soak', reason: 'Deferred.' }] },
    hygiene: { status: 'attention', summary: 'Live-state hygiene unavailable from mission data.', staleSignals: 0, resettable: 0 },
    attention: { gates: 0, questions: 0, permissions: 0, alerts: 0, criticalAlerts: 0, items: [] },
    actions: [
      { action: 'status', command: 'opencode-gateway operator status', description: 'Print a redacted operator report.' },
      { action: 'recover', command: 'opencode-gateway operator recover', description: 'Recover expired leases and missing sessions.' },
    ],
  }
}

function isOperatorSafetyReport(value: any): value is OperatorSafetyReport {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.generatedAt === 'string' &&
    typeof value.state === 'string' &&
    value.releaseClaim &&
    value.scheduler &&
    value.queue &&
    value.readiness &&
    value.governance &&
    value.channels &&
    value.attention &&
    (value.activeRuns === undefined || Array.isArray(value.activeRuns)) &&
    Array.isArray(value.actions),
  )
}

function isOperationsCockpitSummary(value: any): value is OperationsCockpitSummary {
  return Boolean(
    value &&
    value.mode === 'operations_cockpit' &&
    typeof value.status === 'string' &&
    typeof value.summary === 'string' &&
    Array.isArray(value.items) &&
    value.counts &&
    typeof value.releaseClaimBoundary === 'string',
  )
}

function emptyChannels(): MissionChannelSummary {
  return {
    providers: [
      { provider: 'telegram', configured: false, enabled: false, bindings: 0, health: 'down', note: 'telegram credentials are not configured; adapter disabled.' },
      { provider: 'whatsapp', configured: false, enabled: false, bindings: 0, health: 'down', note: 'whatsapp credentials are not configured; adapter disabled.' },
      { provider: 'discord', configured: false, enabled: false, bindings: 0, health: 'down', note: 'discord credentials are not configured; adapter disabled.' },
    ],
    sync: { active: false, syncEnabled: false, intervalMs: 0, includeUserMessages: false, deliveriesTracked: 0, pendingInbound: 0 },
    links: [],
    connectorRegistry: { generatedAt: new Date(0).toISOString(), connectors: [], counts: {} as Record<ChannelConnectorState, number> },
    actionParity: [],
    nativeControlCoverage: [],
  }
}

function emptyAgentTeams(): MissionAgentTeamSummary {
  return { totals: { teams: 0, referencedTeams: 0, invalidReferences: 0, activeTasks: 0, recentRuns: 0 }, teams: [], invalidReferences: [], recentRuns: [] }
}

export {
  buildAgentFactoryView,
  buildArenaView,
  buildWorkGraphView,
  emptyUsage,
  emptyHeartbeat,
  emptyServiceHealth,
  emptyChannels,
  emptyAgentTeams,
  emptyOperator,
  isOperatorSafetyReport,
  isOperationsCockpitSummary,
}
