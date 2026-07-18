import { getMissionData, type DashboardMissionData } from './mission-data.js'
import { buildUsageWindow } from './opencode-usage.js'
import { explainWhyNotRunning } from './product-onboarding.js'
import { buildAlphaHealthSummary } from './alpha-health.js'
import { buildClaimRegistryReport } from './claim-registry.js'
import type { ObservabilitySloResult, SupportOperationsContract, TraceCorrelationIndex } from './observability-contract.js'
import {
  buildObservabilitySourceContract,
  buildMissionControlDataPlaneV2,
  buildOperationsCockpit,
  contractsByKey,
  buildMissionControlSourceSummary,
  isExplicitlyUnavailable,
  missionControlWindow as dashboardWindow,
  parseMissionControlWindowOptions,
  selectEvidenceWindowRows,
  type MissionControlSourceStateInput,
  type MissionControlSourceAvailabilityValue,
} from './mission-control-view-model.js'
import type { DashboardView, DashboardSourceContract, WorkGraphSourceAvailability, DashboardWindowOptionMap } from './dashboard/types.js'
import { esc } from './dashboard/html.js'
import { asArray } from './dashboard/format.js'
import { navLink } from './dashboard/components.js'
import { DASHBOARD_CSS } from './dashboard/document.js'
import {
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
} from './dashboard/model.js'
import { readinessLabel, operatorBadge, renderWindowForm } from './dashboard/views/shared.js'
import { renderOverview } from './dashboard/views/overview.js'
import { renderOperator } from './dashboard/views/operator.js'
import { renderAlphaHealth } from './dashboard/views/alpha-health.js'
import { renderWorkGraph } from './dashboard/views/work-graph.js'
import { renderAgentFactory } from './dashboard/views/agent-factory.js'
import { renderArena } from './dashboard/views/arena.js'
import { renderUsage } from './dashboard/views/usage.js'
import { renderPipeline } from './dashboard/views/pipeline.js'
import { renderEnvironments } from './dashboard/views/environments.js'
import { renderChannels } from './dashboard/views/channels.js'
import { renderHealth } from './dashboard/views/health.js'
import { renderReleaseClaims } from './dashboard/views/release.js'
import {
  renderAnalyticsDocument,
  renderRoadmapDetailDocument,
  renderTaskDetailDocument,
  renderRunDetailDocument,
} from './dashboard/views/detail.js'

export function buildDashboardView(m: DashboardMissionData): DashboardView {
  const windowOptions: DashboardWindowOptionMap = m.dashboardWindowOptions || {}
  const sourceContracts: DashboardSourceContract[] = []
  const sourceFlags = { ...(m.sourceAvailability || {}), ...(m.workGraphSourceAvailable || {}) }
  const sourceState = (key: keyof WorkGraphSourceAvailability, fallback: boolean): MissionControlSourceAvailabilityValue => {
    const value = sourceFlags[key]
    if (typeof value === 'boolean') return value
    if (isMissionControlSourceStateInput(value)) return { ...value, available: value.available !== false && fallback !== false }
    return fallback
  }
  const sourceAvailable = (key: keyof WorkGraphSourceAvailability, fallback: boolean): boolean => {
    const value = sourceState(key, fallback)
    return typeof value === 'boolean' ? value : value.available !== false
  }
  const rawTasks = asArray(m.tasks)
  const rawRoadmaps = asArray(m.roadmaps)
  const rawProjectBindings = asArray(m.projectBindings)
  const rawRuns = asArray(m.runs)
  const rawSessions = asArray(m.sessions)
  const rawEnvironments = asArray(m.environments)
  const rawAlerts = asArray(m.alerts)
  const rawEvents = asArray(m.events)
  const rawSupervisors = asArray(m.supervisorObservability?.supervisors || m.supervisors)
  const rawGates = [...asArray(m.humanGates), ...asArray(m.completionProposals), ...asArray(m.questions), ...asArray(m.permissions)]
  const rawChannelLinks = asArray(m.channels?.links)
  const rawTeamAssignments = asArray(m.teamAssignments)
  const rawProfileEntries = Object.entries(m.profiles || {}).sort(([a], [b]) => a.localeCompare(b))
  const rawAgentTeamRows = asArray(m.agentTeams?.teams)
  const rawEvidenceRows = [...asArray(m.promotionScorecards), ...asArray(m.promotionDecisions), ...asArray(m.backups), ...asArray(m.recoveryDrills)]
  const traceCorrelation = m.traceCorrelation as TraceCorrelationIndex | undefined
  const observabilitySlo = asArray(m.observabilitySlo) as ObservabilitySloResult[]
  const supportOperations = m.supportOperations as SupportOperationsContract | undefined
  const taskWindow = dashboardWindow('tasks', rawTasks, windowOptions, sourceState('tasks', Array.isArray(m.tasks)))
  const roadmapWindow = dashboardWindow('roadmaps', rawRoadmaps, windowOptions, sourceState('roadmaps', Array.isArray(m.roadmaps)))
  const projectBindingWindow = dashboardWindow('projectBindings', rawProjectBindings, windowOptions, sourceState('projectBindings', Array.isArray(m.projectBindings)))
  const runWindow = dashboardWindow('runs', rawRuns, windowOptions, sourceState('runs', Array.isArray(m.runs)))
  const sessionWindow = dashboardWindow('sessions', rawSessions, windowOptions, sourceState('sessions', Array.isArray(m.sessions)))
  const environmentWindow = dashboardWindow('environments', rawEnvironments, windowOptions, sourceState('environments', Array.isArray(m.environments)))
  const alertWindow = dashboardWindow('alerts', rawAlerts, windowOptions, sourceState('alerts', Array.isArray(m.alerts)))
  const eventWindow = dashboardWindow('events', rawEvents, windowOptions, sourceState('events', Array.isArray(m.events)))
  const supervisorWindow = dashboardWindow('supervisors', rawSupervisors, windowOptions, sourceState('supervisors', Array.isArray(m.supervisors) || Array.isArray(m.supervisorObservability?.supervisors)))
  const gateSourcesAvailable = sourceAvailable('humanGates', Array.isArray(m.humanGates)) || sourceAvailable('completionProposals', Array.isArray(m.completionProposals)) || sourceAvailable('requests', m.requestSourceAvailable === true)
  const gateWindow = dashboardWindow('gates', rawGates, windowOptions, sourceState('gates', gateSourcesAvailable))
  const channelBindingWindow = dashboardWindow('channelBindings', rawChannelLinks, windowOptions, sourceState('channelBindings', sourceAvailable('channels', Array.isArray(m.channels?.links))))
  const teamAssignmentWindow = dashboardWindow('teamAssignments', rawTeamAssignments, windowOptions, sourceState('teamAssignments', Array.isArray(m.teamAssignments)))
  const profileWindow = dashboardWindow('agentProfiles', rawProfileEntries, windowOptions, sourceState('agentProfiles', Boolean(m.profiles && typeof m.profiles === 'object')))
  const teamWindow = dashboardWindow('agentTeams', rawAgentTeamRows, windowOptions, sourceState('agentTeams', Boolean(m.agentTeams)))
  const evidenceWindow = dashboardWindow('evidence', rawEvidenceRows, windowOptions, sourceState('evidence', Array.isArray(m.promotionScorecards) || Array.isArray(m.promotionDecisions)))
  sourceContracts.push(taskWindow.contract, roadmapWindow.contract, projectBindingWindow.contract, runWindow.contract, sessionWindow.contract, environmentWindow.contract, alertWindow.contract, eventWindow.contract, supervisorWindow.contract, gateWindow.contract, channelBindingWindow.contract, teamAssignmentWindow.contract, profileWindow.contract, teamWindow.contract, evidenceWindow.contract)
  sourceContracts.push(buildObservabilitySourceContract(traceCorrelation, observabilitySlo, windowOptions, sourceState('observability', Boolean(traceCorrelation))))
  const tasks = taskWindow.rows
  const roadmapRows = roadmapWindow.rows
  const roadmapTeamById = new Map(roadmapRows.map(roadmap => [roadmap.id, roadmap.agentTeam]).filter((row): row is [string, string] => Boolean(row[0] && row[1])))
  const allVisibleTasks = rawTasks.filter(task => task.status !== 'archived')
  const visibleTasks = tasks.filter(task => task.status !== 'archived').map(task => {
    const inheritedAgentTeam = task.agentTeam ? undefined : roadmapTeamById.get(task.roadmapId)
    return { ...task, effectiveAgentTeam: task.agentTeam || inheritedAgentTeam, inheritedAgentTeam }
  })
  const allTaskRoadmapTeamById = new Map(rawRoadmaps.map(roadmap => [roadmap.id, roadmap.agentTeam]).filter((row): row is [string, string] => Boolean(row[0] && row[1])))
  const allEffectiveTasks = allVisibleTasks.map(task => {
    const inheritedAgentTeam = task.agentTeam ? undefined : allTaskRoadmapTeamById.get(task.roadmapId)
    return { ...task, effectiveAgentTeam: task.agentTeam || inheritedAgentTeam, inheritedAgentTeam }
  })
  const activeTasks = visibleTasks.filter(task => task.status === 'pending' || task.status === 'running')
  const attentionTasks = visibleTasks.filter(task => task.status === 'blocked' || task.status === 'paused')
  const recentDoneTasks = visibleTasks.filter(task => task.status === 'done').slice(0, 6)
  const sessions = sessionWindow.rows
  const activeSessions = sessions.filter(session => session.status === 'running')
  const recentSessions = sessions.slice(0, 12)
  const requestCount = asArray(m.questions).length + asArray(m.permissions).length
  const attentionItemCount = m.attention ? asArray(m.attention.items).length : allEffectiveTasks.filter(task => task.status === 'blocked' || task.status === 'paused').length + requestCount
  const environments = environmentWindow.rows
  const activeEnvironmentCount = rawEnvironments.filter(environment => environment.status === 'prepared' || environment.status === 'blocked').length
  const retainedEnvironmentCount = rawEnvironments.filter(environment => environment.status === 'retained').length
  const cleanupFailedEnvironmentCount = rawEnvironments.filter(environment => environment.status === 'cleanup_failed').length
  const roadmaps = roadmapRows
    .filter(roadmap => roadmap.status !== 'archived')
    .map(roadmap => {
      const roadmapTasks = allEffectiveTasks.filter(task => task.roadmapId === roadmap.id)
      const doneTasks = roadmapTasks.filter(task => task.status === 'done').length
      const totalTasks = roadmapTasks.length
      return {
        ...roadmap,
        totalTasks,
        doneTasks,
        blockedTasks: roadmapTasks.filter(task => task.status === 'blocked').length,
        runningTasks: roadmapTasks.filter(task => task.status === 'running').length,
        progress: totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0,
      }
    })

  const counts = {
    pending: allEffectiveTasks.filter(task => task.status === 'pending').length,
    running: allEffectiveTasks.filter(task => task.status === 'running').length,
    done: allEffectiveTasks.filter(task => task.status === 'done').length,
    blocked: allEffectiveTasks.filter(task => task.status === 'blocked').length,
    paused: allEffectiveTasks.filter(task => task.status === 'paused').length,
    cancelled: allEffectiveTasks.filter(task => task.status === 'cancelled').length,
    attention: attentionItemCount,
    alerts: 0,
    environments: activeEnvironmentCount,
    retainedEnvironments: retainedEnvironmentCount,
    cleanupFailedEnvironments: cleanupFailedEnvironmentCount,
    healthAttention: 0,
    alphaBlockers: 0,
  }

  const usage = m.usage || emptyUsage()
  const heartbeat = m.heartbeat || emptyHeartbeat()
  const serviceHealth = m.serviceHealth || emptyServiceHealth()
  const alphaHealth = m.alphaHealth || buildAlphaHealthSummary({
    serviceHealth,
    readiness: m.readiness,
    heartbeat: m.heartbeat,
    scheduler: m.scheduler,
    channels: m.channels,
    humanGates: m.humanGates,
    questions: m.questions,
    permissions: m.permissions,
    requestSourceAvailable: m.requestSourceAvailable,
    completionProposals: m.completionProposals,
    promotionScorecards: m.promotionScorecards,
    backups: m.backups,
    recoveryDrills: m.recoveryDrills,
    runs: m.runs,
    tasks: allEffectiveTasks,
    supervisors: m.supervisors || m.supervisorObservability?.supervisors,
    alerts: m.alerts,
  })
  const readiness = m.readiness || { state: 'not_ready', summary: 'Readiness unavailable', checks: [] }
  const governance = m.governance || { enabled: true, status: 'ok', summary: 'Governance unavailable', totals: { costUsd: 0, tokens: 0, runtimeMs: 0 }, budgets: [] }
  const channels = { ...(m.channels || emptyChannels()), links: channelBindingWindow.rows }
  const operator = isOperatorSafetyReport(m.operator) ? { ...m.operator, activeRuns: m.operator.activeRuns || [] } : emptyOperator(readiness, governance, counts)
  const runExplanations = explainWhyNotRunning({ tasks: allEffectiveTasks, scheduler: m.scheduler, readiness, heartbeat, counts })
  const alerts = alertWindow.rows
  const metrics = m.metrics || {}
  const supervisorObservability = m.supervisorObservability || { summary: { total: 0, active: 0, due: 0, leased: 0, stale: 0, paused: 0, blocked: 0, completed: 0 }, supervisors: [], auditEvents: [] }
  const supervisors = supervisorWindow.rows
  const agentTeams = m.agentTeams ? { ...m.agentTeams, teams: teamWindow.rows } : emptyAgentTeams()
  const promotionScorecards = selectEvidenceWindowRows(asArray(m.promotionScorecards), evidenceWindow.rows)
  const promotionDecisions = selectEvidenceWindowRows(asArray(m.promotionDecisions), evidenceWindow.rows)
  const windowedProfiles = Object.fromEntries(profileWindow.rows)
  const agentFactory = buildAgentFactoryView({ ...m, profiles: windowedProfiles, agentTeams, runs: runWindow.rows, promotionScorecards, promotionDecisions, agentCatalog: m.agentCatalog })
  const promotionSourceAvailable = typeof m.promotionEvidenceSourceAvailable === 'boolean'
    ? m.promotionEvidenceSourceAvailable
    : Array.isArray(m.promotionScorecards) || Array.isArray(m.promotionDecisions)
  const arena = buildArenaView({ scorecards: promotionScorecards, decisions: promotionDecisions, sourceAvailable: promotionSourceAvailable })
  const workGraphSources: WorkGraphSourceAvailability = {
    tasks: sourceAvailable('tasks', Array.isArray(m.tasks)),
    roadmaps: sourceAvailable('roadmaps', Array.isArray(m.roadmaps)),
    projectBindings: sourceAvailable('projectBindings', Array.isArray(m.projectBindings)),
    runs: sourceAvailable('runs', Array.isArray(m.runs)),
    supervisors: sourceAvailable('supervisors', Array.isArray(m.supervisors) || Array.isArray(m.supervisorObservability?.supervisors)),
    sessions: sourceAvailable('sessions', Array.isArray(m.sessions)),
    channels: sourceAvailable('channels', Array.isArray(m.channels?.links)),
    humanGates: sourceAvailable('humanGates', Array.isArray(m.humanGates)),
    completionProposals: sourceAvailable('completionProposals', Array.isArray(m.completionProposals)),
    requests: sourceAvailable('requests', m.requestSourceAvailable === true),
    alerts: sourceAvailable('alerts', Array.isArray(m.alerts)),
  }
  const workGraph = buildWorkGraphView({ ...m, _windowOptions: windowOptions, _sourceAvailability: workGraphSources, tasks: visibleTasks, roadmaps, projectBindings: projectBindingWindow.rows, runs: runWindow.rows, supervisors, alerts, channels, agentTeams })
  sourceContracts.push(workGraph.window.nodes, workGraph.window.edges)
  const sourceSummary = buildMissionControlSourceSummary(sourceContracts)
  const dataPlane = buildMissionControlDataPlaneV2({
    sourceContracts,
    consumers: ['dashboard', 'mcp', 'support'],
    generatedAt: String(m.generatedAt || readiness.generatedAt || new Date().toISOString()),
  })
  const sourceDiagnostics = asArray(m.sourceDiagnostics).map(row => ({
    source: String(row?.source || 'unknown'),
    available: row?.available === true,
    summary: String(row?.summary || ''),
  }))
  for (const contract of sourceContracts) {
    if (!contract.available && isExplicitlyUnavailable(contract, sourceFlags) && !sourceDiagnostics.some(row => row.source === contract.key)) {
      sourceDiagnostics.push({ source: contract.key, available: false, summary: contract.diagnostic || `${contract.label} source unavailable.` })
    }
  }
  const operationsCockpit = isOperationsCockpitSummary(m.operationsCockpit)
    ? m.operationsCockpit
    : buildOperationsCockpit({ readiness, channels, operator, sourceDiagnostics })
  const releaseCockpit = buildClaimRegistryReport({ generatedAt: String(m.generatedAt || readiness.generatedAt || new Date().toISOString()) })
  counts.alerts = alerts.filter(alert => alert.status === 'active' || alert.status === 'acknowledged' || !alert.status).length
  counts.healthAttention = asArray(serviceHealth.attention).length
  counts.alphaBlockers = alphaHealth.blockers.length
  const headline = counts.attention > 0
    ? `${counts.attention} item${counts.attention === 1 ? '' : 's'} need attention`
    : serviceHealth.status !== 'ok'
      ? `Service health ${serviceHealth.status}: ${serviceHealth.summary || 'review components'}`
    : readiness.state !== 'ready'
      ? `${readinessLabel(readiness)}: ${readiness.summary || 'review health'}`
      : activeTasks.length || activeSessions.length || counts.running || counts.pending
        ? 'Gateway work is flowing'
        : 'Gateway is calm'

  return {
    headline,
    activeTasks,
    attentionTasks,
    recentDoneTasks,
    visibleTasks,
    events: eventWindow.rows,
    archivedCount: rawTasks.length - allVisibleTasks.length,
    activeSessions,
    recentSessions,
    roadmaps,
    projectBindings: projectBindingWindow.rows,
    environments,
    supervisors,
    supervisorObservability,
    requestCount,
    usage,
    heartbeat,
    serviceHealth,
    alphaHealth,
    readiness,
    governance,
    operator,
    operationsCockpit,
    releaseCockpit,
    runExplanations,
    alerts,
    metrics,
    profiles: windowedProfiles,
    runs: runWindow.rows,
    promotionScorecards,
    promotionDecisions,
    throughput: asArray(m.throughput),
    channels,
    agentTeams,
    agentFactory,
    arena,
    workGraph,
    sourceDiagnostics,
    sourceContracts,
    sourceSummary,
    dataPlane,
    traceCorrelation,
    observabilitySlo,
    supportOperations,
    windows: contractsByKey(sourceContracts),
    windowQuery: windowOptions.all?.search,
    pipeline: asArray(m.pipeline).length ? asArray(m.pipeline).map(String) : ['implement', 'review', 'verify'],
    counts,
  }
}

function isMissionControlSourceStateInput(value: unknown): value is MissionControlSourceStateInput {
  return Boolean(value && typeof value === 'object')
}

export async function renderDashboard(searchParams?: URLSearchParams): Promise<string> {
  // Drill-down and analytics are query-param driven, server-rendered pages that
  // reuse the existing read-only work-store/analytics functions. They render a
  // dedicated document (shared shell + safe `html` template) so a full SSE reload
  // preserves the ?view=...&id=... URL and the drill-down survives live updates.
  const view = searchParams?.get('view')
  if (view === 'analytics') return renderAnalyticsDocument(searchParams!)
  if (view === 'roadmap') return renderRoadmapDetailDocument(searchParams!)
  if (view === 'task') return renderTaskDetailDocument(searchParams!)
  if (view === 'run') return renderRunDetailDocument(searchParams!)
  const usageWindow = buildUsageWindow(searchParams)
  const dashboardWindowOptions = parseMissionControlWindowOptions(searchParams)
  const missionData = await getMissionData({ usageWindow, dashboardWindowOptions })
  return renderDashboardDocument(missionData)
}
export function renderDashboardDocument(missionData: DashboardMissionData): string {
  const view = buildDashboardView(missionData)
  const usage = view.usage
  return `<!DOCTYPE html>
<html lang="en" data-route="overview">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gateway Mission Control</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="mark">GW</div><div><div class="brand-title">Gateway</div><div class="brand-sub">Mission Control</div></div></div>
    <nav class="nav" aria-label="Dashboard scopes">
      ${navLink('overview', 'Overview', view.counts.attention ? String(view.counts.attention) : '')}
      ${navLink('operator', 'Operator', operatorBadge(view.operator))}
      ${navLink('alpha-health', 'Alpha Health', view.counts.alphaBlockers ? String(view.counts.alphaBlockers) : view.alphaHealth.status === 'healthy' ? '' : '!')}
      ${navLink('work-graph', 'Work Graph', view.workGraph.stats.blocked ? String(view.workGraph.stats.blocked) : '')}
      ${navLink('agent-factory', 'Agent Factory', view.agentFactory.totals.blockedProfiles + view.agentFactory.totals.blockedTeams ? String(view.agentFactory.totals.blockedProfiles + view.agentFactory.totals.blockedTeams) : '')}
      ${navLink('arena', 'Arena', view.arena.totals.failed ? String(view.arena.totals.failed) : '')}
      <a class="nav-link" href="/dashboard?view=analytics" data-nav-external="analytics"><span>Analytics</span></a>
      ${navLink('usage', 'Usage')}
      ${navLink('pipeline', 'Pipeline')}
      ${navLink('environments', 'Environments', view.counts.cleanupFailedEnvironments ? String(view.counts.cleanupFailedEnvironments) : view.counts.retainedEnvironments ? String(view.counts.retainedEnvironments) : '')}
      ${navLink('channels', 'Channels')}
      ${navLink('health', 'Health', view.counts.alerts + view.counts.healthAttention ? String(view.counts.alerts + view.counts.healthAttention) : '')}
      ${navLink('release-cockpit', 'Release Claims', view.releaseCockpit.claims.filter(claim => claim.state !== 'allowed').length ? String(view.releaseCockpit.claims.filter(claim => claim.state !== 'allowed').length) : '')}
    </nav>
    <div class="sidebar-note mono">OpenCode owns sessions, agents, tokens, and costs. Gateway owns durable work, routing, and scheduler decisions.</div>
  </aside>
  <main class="main">
    <div class="topbar">
      <div class="top-left"><div class="live"><span class="live-dot"></span><span>Live</span></div><div class="clock" data-clock>${esc(new Date().toLocaleTimeString())}</div></div>
      ${renderWindowForm(usage, view)}
    </div>
    ${renderOverview(view, missionData)}
    ${renderOperator(view)}
    ${renderAlphaHealth(view)}
    ${renderWorkGraph(view)}
    ${renderAgentFactory(view)}
    ${renderArena(view)}
    ${renderUsage(view)}
    ${renderPipeline(view)}
    ${renderEnvironments(view)}
    ${renderChannels(view)}
    ${renderHealth(view)}
    ${renderReleaseClaims(view)}
  </main>
</div>
<script>
(function(){
  const routes = ['overview','operator','alpha-health','work-graph','agent-factory','arena','usage','pipeline','environments','channels','health','release-cockpit']
  const storageKey = 'gateway:aura:window'
  const form = document.querySelector('[data-window-form]')
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!location.search && saved && saved.range && routes.includes((location.hash || '#/overview').slice(2) || 'overview')) {
      const params = new URLSearchParams()
      params.set('range', saved.range)
      if (saved.range === 'custom' && saved.from && saved.to) { params.set('from', saved.from); params.set('to', saved.to) }
      location.replace('/dashboard?' + params.toString() + (location.hash || '#/overview'))
      return
    }
  } catch {}
  function routeFromHash(){ const r = (location.hash || '#/overview').replace('#/',''); return routes.includes(r) ? r : 'overview' }
  function applyRoute(){
    const route = routeFromHash()
    document.documentElement.dataset.route = route
    document.querySelectorAll('[data-view]').forEach(view => view.classList.toggle('active', view.getAttribute('data-view') === route))
    document.querySelectorAll('[data-nav]').forEach(link => {
      const active = link.getAttribute('data-nav') === route
      link.classList.toggle('active', active)
      if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current')
    })
    document.title = 'Gateway Mission Control - ' + route.charAt(0).toUpperCase() + route.slice(1)
  }
  window.addEventListener('hashchange', applyRoute)
  applyRoute()
  const range = form?.querySelector('select[name="range"]')
  const from = form?.querySelector('input[name="from"]')
  const to = form?.querySelector('input[name="to"]')
  range?.addEventListener('change', () => { if (range.value !== 'custom') form?.requestSubmit ? form.requestSubmit() : form?.submit() })
  ;[from,to].forEach(input => input?.addEventListener('input', () => { if (range) range.value = 'custom' }))
  form?.addEventListener('submit', event => {
    const value = range?.value || 'today'
    if (value === 'custom' && (!from?.value || !to?.value || to.value < from.value)) {
      event.preventDefault(); alert(!from?.value || !to?.value ? 'Choose both start and end dates.' : 'End date must be on or after start date.'); return
    }
    localStorage.setItem(storageKey, JSON.stringify({ range: value, from: from?.value || '', to: to?.value || '' }))
  })
  function tickClock(){ const el = document.querySelector('[data-clock]'); if (el) el.textContent = new Date().toLocaleTimeString() }
  function duration(ms){ if (!Number.isFinite(ms)) return '--'; if (ms <= 0) return 'due now'; const s = Math.ceil(ms/1000); const m = Math.floor(s/60); const r = s%60; return m ? m + 'm ' + String(r).padStart(2,'0') + 's' : s + 's' }
  function tickCountdowns(){ document.querySelectorAll('[data-countdown]').forEach(el => { const ts = Date.parse(el.getAttribute('data-countdown') || ''); el.textContent = duration(ts - Date.now()) }) }
  setInterval(tickClock, 1000); setInterval(tickCountdowns, 1000); tickCountdowns()
  document.querySelectorAll('[data-metric-tab]').forEach(button => button.addEventListener('click', () => {
    const metric = button.getAttribute('data-metric-tab')
    document.querySelectorAll('[data-metric-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === button)))
    document.querySelectorAll('[data-metric-panel]').forEach(panel => panel.classList.toggle('active', panel.getAttribute('data-metric-panel') === metric))
  }))
  document.querySelectorAll('[data-work-select]').forEach(button => button.addEventListener('click', () => {
    const id = button.getAttribute('data-work-select')
    document.querySelectorAll('[data-work-detail]').forEach(panel => panel.classList.toggle('active', panel.getAttribute('data-work-detail') === id))
    document.querySelectorAll('[data-work-select]').forEach(row => row.setAttribute('aria-pressed', String(row === button)))
  }))
  document.querySelectorAll('[data-arena-select]').forEach(button => button.addEventListener('click', () => {
    const id = button.getAttribute('data-arena-select')
    document.querySelectorAll('[data-arena-detail]').forEach(panel => panel.classList.toggle('active', panel.getAttribute('data-arena-detail') === id))
    document.querySelectorAll('[data-arena-select]').forEach(row => row.setAttribute('aria-pressed', String(row === button)))
  }))
  document.querySelectorAll('[data-filter-input]').forEach(input => {
    const target = input.getAttribute('data-filter-input')
    const rows = Array.prototype.slice.call(document.querySelectorAll('[data-filter-row="' + target + '"]'))
    const count = document.querySelector('[data-filter-count="' + target + '"]')
    input.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase()
      let shown = 0
      rows.forEach(row => {
        const hay = (row.getAttribute('data-filter-text') || row.textContent || '').toLowerCase()
        const match = !query || hay.indexOf(query) !== -1
        row.toggleAttribute('hidden', !match)
        if (match) shown++
      })
      if (count) count.textContent = shown + '/' + rows.length
    })
  })
  document.querySelectorAll('[data-filter-button]').forEach(button => button.addEventListener('click', () => {
    const group = button.getAttribute('data-filter-group')
    const value = button.getAttribute('data-filter-button') || 'all'
    document.querySelectorAll('[data-filter-group="' + group + '"]').forEach(item => {
      if (item.hasAttribute('data-filter-button')) item.setAttribute('aria-pressed', String(item === button))
    })
    document.querySelectorAll('[data-filter-row="' + group + '"]').forEach(row => {
      const values = (row.getAttribute('data-filter-values') || '').split(' ')
      row.toggleAttribute('hidden', value !== 'all' && !values.includes(value))
    })
  }))
  try {
    const ev = new EventSource('/live/events')
    ev.onmessage = event => { try { const data = JSON.parse(event.data); if (data.type !== 'connected') location.reload() } catch {} }
    ev.onerror = () => document.querySelector('.live-dot')?.classList.add('inactive')
  } catch {}
  setInterval(() => { if (!document.querySelector('.live-dot.inactive')) location.reload() }, 60000)
})()
</script>
</body></html>`
}

export { html, attr, trustedHtml } from './dashboard/html.js'
export { renderAnalyticsView, renderRoadmapDetailView, renderTaskDetailView, renderRunDetailView } from './dashboard/views/detail.js'
