import { esc, escAttr, html, attr } from '../html.js'
import { asArray, shortId, fmtMoney, timeUntil } from '../format.js'
import { usagePresetOptions, type OpenCodeUsageReport, type UsageRangePreset } from '../../opencode-usage.js'
import { artifactLinksForRefs } from '../../product-onboarding.js'
import type { DashboardView } from '../types.js'
import type { AlphaHealthSummary } from '../../alpha-health.js'
import type { ServiceHealthReport } from '../../service-health.js'
import type { HeartbeatStatus } from '../../heartbeat.js'
import type { OperatorSafetyReport } from '../../operator-safety.js'

function renderWindowForm(usage: OpenCodeUsageReport, view: DashboardView): string {
  return `<form class="window-form" method="GET" action="/dashboard" data-window-form>
    <label for="usage-range">Window</label>
    <select id="usage-range" name="range">
      ${usagePresetOptions().map(preset => renderRangeOption(preset, usage.window.preset)).join('')}
      <option value="custom" ${usage.window.preset === 'custom' ? 'selected' : ''}>Custom range</option>
    </select>
    <input type="date" name="from" value="${escAttr(usage.window.startDate)}" aria-label="Start date">
    <input type="date" name="to" value="${escAttr(usage.window.endDate)}" aria-label="End date">
    <input type="search" name="q" value="${escAttr(view.windowQuery || '')}" aria-label="Search Mission Control windows" placeholder="Search windows">
    <button type="submit">Update</button>
  </form>`
}
function renderTask(task: any): string {
  const priority = String(task.priority || 'LOW').toLowerCase()
  const status = String(task.status || 'unknown')
  const stage = task.currentStage || task.lastRun?.stage || 'complete'
  const reason = task.readiness?.reason ? ` / ${task.readiness.reason}` : ''
  const result = task.lastRun?.result
  const evidence = result?.failureClass ? ` / ${result.failureClass}` : asArray(result?.evidence).length ? ` / ${asArray(result.evidence).length} evidence` : ''
  const team = task.effectiveAgentTeam || task.agentTeam
  const teamMeta = team ? ` / team ${team}${task.inheritedAgentTeam ? ' inherited' : ''}` : ''
  const runProfile = task.lastRun?.resolvedProfile || task.lastRun?.profile
  const runAgent = task.lastRun?.resolvedAgent
  const runMeta = runProfile ? ` / last ${runProfile}${runAgent ? ` -> ${runAgent}` : ''}` : ''
  const env = task.activeRun?.environment || task.lastRun?.environment
  const envMeta = env ? ` / env ${env.name || '?'}:${env.backend || '?'}` : task.environment ? ` / env ${typeof task.environment === 'string' ? task.environment : task.environment.name || task.environment.backend || 'inline'}` : ''
  const label = task.title || task.description || task.id
  const title = task.id ? html`<a class="detail-link" href="/dashboard?view=task&id=${encodeURIComponent(task.id)}">${label}</a>` : html`${label}`
  return html`<div class="row"><span class="priority ${attr(priority)}">${task.priority || '?'}</span><div><div class="title">${title}</div><div class="meta">${status} / ${stage} / ${shortId(task.id)}${teamMeta}${runMeta}${envMeta}${reason}${evidence}</div></div><span class="dot ${attr(status)}"></span></div>`.value
}
function renderRunAttribution(runs: any[]): string {
  const rows = asArray(runs).slice(-8).reverse()
  if (!rows.length) return '<p class="empty">No Gateway runs recorded yet.</p>'
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Stage</th><th>Team</th><th>Environment</th><th>Runtime</th><th>Profile</th><th>Agent</th><th>Status</th></tr></thead><tbody>${rows.map(run => {
    const profile = run.resolvedProfile || run.profile || '?'
    const agent = run.resolvedAgent || '?'
    const env = run.environment ? `${run.environment.name || '?'}:${run.environment.backend || '?'}` : 'default'
    const envClass = run.environment?.preflight?.ok === false ? 'bad' : run.environment ? 'purple' : ''
    const runtime = run.runtimeProfile ? `${run.runtimeProfile.filesystem?.policy || '?'} / ${run.runtimeProfile.network?.mode || '?'}` : '--'
    const runId = run.id ? html`<a class="detail-link" href="/dashboard?view=run&id=${encodeURIComponent(run.id)}">${shortId(run.id)}</a>` : html`${shortId(run.id)}`
    return html`<tr><td class="name">${runId}</td><td>${run.stage || '?'}</td><td>${run.agentTeam || 'default'}</td><td><span class="pill ${envClass}">${env}</span></td><td>${runtime}</td><td>${profile}</td><td>${agent}</td><td><span class="pill ${run.status === 'passed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${run.status || '?'}</span></td></tr>`
  })}</tbody></table></div>`.value
}
function renderArtifactLinks(refs: unknown[]): string {
  const links = artifactLinksForRefs(asArray(refs))
  if (!links.length) return '0'
  return links.slice(0, 4).map(link => html`<a class="pill purple" href="${attr(link.url)}" target="_blank" rel="noreferrer" title="${attr(link.ref)}">${link.label}</a>`.value).join(' ')
}
function renderGatewaySession(session: any): string {
  const inner = html`<span class="dot ${attr(session.status || 'idle')}"></span><div><div class="title">${session.title || session.id || 'session'}</div><div class="meta">${session.agent || 'agent'} / ${shortId(session.id)}${session.cost ? ` / ${fmtMoney(session.cost)}` : ''}</div></div><span class="pill ${session.status === 'running' ? 'warn' : 'good'}">${session.status || '?'}</span>`
  return session.webUrl ? html`<a class="row clickable" href="${attr(session.webUrl)}" target="_blank" rel="noreferrer">${inner}</a>`.value : html`<div class="row">${inner}</div>`.value
}
function renderCommand(command: string): string {
  return `<code class="copyable-command">${esc(command)}</code>`
}
function alphaStatusLabel(alpha: AlphaHealthSummary): string {
  if (alpha.status === 'healthy') return 'Healthy'
  if (alpha.status === 'blocked') return 'Blocked'
  if (alpha.status === 'attention') return 'Attention'
  return 'Not proven'
}

function alphaStatusClass(status: AlphaHealthSummary['status']): string {
  if (status === 'healthy') return 'good'
  if (status === 'blocked') return 'bad'
  return 'warn'
}
function renderEvents(events: any[]): string {
  if (!events.length) return '<p class="empty">No recent events.</p>'
  return `<div class="timeline">${events.map((event, index) => `<div class="event"><span class="event-time">-${index}m</span><span class="event-text">${esc(String(event))}</span></div>`).join('')}</div>`
}
function renderRangeOption(preset: UsageRangePreset, active: UsageRangePreset): string {
  return `<option value="${escAttr(preset)}" ${preset === active ? 'selected' : ''}>${esc(rangeLabel(preset))}</option>`
}

function rangeLabel(preset: UsageRangePreset): string {
  const labels: Record<UsageRangePreset, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    'this-week': 'This week',
    'last-week': 'Last week',
    'this-month': 'This month',
    'last-month': 'Last month',
    ytd: 'Year to date',
    'last-year': 'Last year',
    all: 'All time',
    custom: 'Custom range',
  }
  return labels[preset]
}
function readinessLabel(readiness: any): string {
  if (readiness?.state === 'ready') return 'Ready'
  if (readiness?.state === 'degraded') return 'Degraded'
  return 'Not Ready'
}
function operatorBadge(report: OperatorSafetyReport): string {
  if (report.state === 'ready_for_beta') return ''
  if (report.state === 'blocked') return '!'
  if (report.state === 'paused') return 'P'
  const count = report.attention.gates + report.attention.questions + report.attention.permissions + report.attention.alerts + report.scheduler.expiredLeases
  return count ? String(count) : '!'
}

function serviceHealthLabel(report: ServiceHealthReport): string {
  if (report.status === 'ok') return 'Healthy'
  if (report.status === 'degraded') return 'Degraded'
  return 'Down'
}

function serviceHealthNote(report: ServiceHealthReport): string {
  return esc(report.summary || 'service health unavailable')
}

function serviceHealthClass(report: ServiceHealthReport): string {
  if (report.status === 'ok') return 'good'
  if (report.status === 'degraded') return 'warn'
  return 'bad'
}

function heartbeatLabel(heartbeat: HeartbeatStatus): string {
  if (heartbeat.running) return 'Running'
  if (heartbeat.status === 'ok') return 'Healthy'
  if (heartbeat.status === 'error') return 'Error'
  if (heartbeat.status === 'skipped') return 'Skipped'
  return 'Waiting'
}

function heartbeatNoteHtml(heartbeat: HeartbeatStatus): string {
  if (heartbeat.nextDueAt) return `next <span data-countdown="${escAttr(heartbeat.nextDueAt)}">${esc(timeUntil(heartbeat.nextDueAt))}</span>`
  return esc(heartbeat.enabled ? 'waiting for first tick' : 'not started')
}

function heartbeatClass(heartbeat: HeartbeatStatus): string {
  if (heartbeat.status === 'error') return 'bad'
  if (heartbeat.running || heartbeat.status === 'skipped') return 'warn'
  if (heartbeat.status === 'ok') return 'good'
  return 'warn'
}

export {
  renderEvents,
  renderGatewaySession,
  renderTask,
  renderRunAttribution,
  renderCommand,
  renderArtifactLinks,
  alphaStatusLabel,
  alphaStatusClass,
  serviceHealthLabel,
  serviceHealthNote,
  serviceHealthClass,
  heartbeatLabel,
  heartbeatNoteHtml,
  heartbeatClass,
  readinessLabel,
  operatorBadge,
  renderWindowForm,
}
