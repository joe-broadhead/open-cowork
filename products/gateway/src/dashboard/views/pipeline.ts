import { esc, html } from '../html.js'
import { asArray, shortId, fmtNumber, seriesValues } from '../format.js'
import { card, headFig, stackedBar, areaChart } from '../components.js'
import { renderTask, renderRunAttribution, renderGatewaySession } from './shared.js'
import type { DashboardView } from '../types.js'
import type { RunExplanation } from '../../product-onboarding.js'

function renderPipeline(view: DashboardView): string {
  const openCount = view.counts.pending + view.counts.running + view.counts.blocked + view.counts.paused + view.counts.cancelled
  return `<section class="view" data-view="pipeline">
    <div class="view-head"><div><h1 class="page-h">Issue Pipeline</h1><p class="page-sub">Durable Gateway Issue queue, scheduler stages, Projects, agent teams, and Gateway OpenCode Sessions.</p></div><div class="head-figs">
      ${headFig(String(view.counts.pending + view.counts.running), 'in flight')}${headFig(String(view.counts.blocked), 'blocked')}${headFig(String(view.counts.done), 'completed')}
    </div></div>
    <div class="grid-2">
      ${card('Queue Composition', 'Q', `<span class="pill">${openCount} open</span>`, stackedBar([
        { label: 'Running', value: view.counts.running, color: 'var(--orange)' },
        { label: 'Pending', value: view.counts.pending, color: 'var(--cyan)' },
        { label: 'Blocked', value: view.counts.blocked, color: 'var(--red)' },
        { label: 'Paused', value: view.counts.paused, color: 'var(--pink)' },
        { label: 'Cancelled', value: view.counts.cancelled, color: 'var(--faint)' },
      ]))}
      ${card('Throughput', '+', `<span class="pill good">${view.throughput.reduce((sum, point) => sum + point.done, 0)} passed runs</span>`, `${areaChart(seriesValues(view.throughput, 'done'), 'var(--green)', 126)}<div class="src-note">source: Gateway run.completedAt daily rollup, last ${view.throughput.length || 14} days.</div>`)}
    </div>
    ${card(`Scheduler Stages`, '>', `<span class="pill purple">${esc(view.pipeline.join(' -> '))}</span>`, renderStageFunnel(view))}
    ${card('Why Is This Not Running?', '?', `<span class="pill ${view.runExplanations.some(row => row.severity === 'critical') ? 'bad' : view.runExplanations.some(row => row.severity === 'warning') ? 'warn' : 'good'}">${view.runExplanations.length} explanation${view.runExplanations.length === 1 ? '' : 's'}</span>`, renderRunExplanations(view.runExplanations))}
    <div class="grid-2">
      ${card('Active Issues', '>', `<span class="pill">${view.activeTasks.length} issues</span>`, view.activeTasks.length ? `<div class="lane">${view.activeTasks.map(renderTask).join('')}</div>` : '<p class="empty good">Queue clear. No pending or running durable Issues.</p>')}
      ${card('Projects', 'R', `<span class="pill">${view.roadmaps.length} active</span>`, view.roadmaps.length ? `<div class="lane">${view.roadmaps.map(renderRoadmap).join('')}</div>` : '<p class="empty">No active Projects.</p>')}
    </div>
    ${card('Recent Run Attribution', 'A', `<span class="pill">${view.runs.length} runs</span>`, renderRunAttribution(view.runs))}
    ${card('Gateway Sessions', 'G', `<span class="pill ${view.activeSessions.length ? 'warn' : 'good'}">${view.activeSessions.length} running</span>`, view.recentSessions.length ? `<div class="lane">${view.recentSessions.map(renderGatewaySession).join('')}</div>` : '<p class="empty">No Gateway OpenCode Sessions.</p>')}
  </section>`
}
function renderStageFunnel(view: DashboardView): string {
  const stageCounts = Object.fromEntries(view.pipeline.map(stage => [stage, 0])) as Record<string, number>
  let queued = 0
  for (const task of view.visibleTasks) {
    if (task.status !== 'pending' && task.status !== 'running') continue
    const stage = task.currentStage || task.pipeline?.[0]
    if (stage && stageCounts[stage] !== undefined) stageCounts[stage] += 1
    else queued += 1
  }
  const max = Math.max(1, queued, view.counts.done, ...Object.values(stageCounts))
  const colors = ['var(--purple)', 'var(--cyan)', 'var(--green)', 'var(--orange)', 'var(--pink)']
  const stageRows = view.pipeline.map((stage, index) => ({ label: stage, value: stageCounts[stage] || 0, color: colors[index % colors.length] }))
  return `<div class="grid-3">${[{ label: 'Queued', value: queued, color: 'var(--cyan)' }, ...stageRows, { label: 'Done', value: view.counts.done, color: 'var(--green)' }].map(row => `<div class="mini"><div class="mini-value">${fmtNumber(row.value)}</div><div class="mini-label">${esc(row.label)}</div><div class="track"><span style="width:${Math.max(3, Math.round((row.value / max) * 100))}%;background:${row.color}"></span></div></div>`).join('')}</div>`
}
function renderRoadmap(roadmap: any): string {
  const statusClass = roadmap.blockedTasks ? 'bad' : roadmap.runningTasks ? 'warn' : 'good'
  const teamMeta = roadmap.agentTeam ? ` / team ${roadmap.agentTeam}` : ''
  const label = roadmap.title || roadmap.id
  const title = roadmap.id ? html`<a class="detail-link" href="/dashboard?view=roadmap&id=${encodeURIComponent(roadmap.id)}">${label}</a>` : html`${label}`
  return html`<div class="row compact"><div><div class="title">${title}</div><div class="meta">${roadmap.doneTasks}/${roadmap.totalTasks} Issues done / ${roadmap.status || 'active'} / roadmap ${shortId(roadmap.id)}${teamMeta}</div><div class="progress"><span style="width:${Math.max(0, Math.min(100, roadmap.progress))}%"></span></div></div><span class="pill ${statusClass}">${roadmap.progress}%</span></div>`.value
}
function renderRunExplanations(rows: RunExplanation[]): string {
  if (!rows.length) return '<p class="empty good">No scheduler blockers detected.</p>'
  return `<div class="lane">${rows.map(row => `<div class="row compact"><span class="dot ${row.severity === 'critical' ? 'blocked' : row.severity === 'warning' ? 'pending' : 'done'}"></span><div><div class="title">${esc(row.title)}</div><div class="meta">${esc(row.summary)}${row.taskId ? ` / task ${esc(shortId(row.taskId))}` : ''}</div><div class="meta">${asArray(row.actions).map(action => esc(action)).join(' / ')}</div></div><span class="pill ${row.severity === 'critical' ? 'bad' : row.severity === 'warning' ? 'warn' : 'good'}">${esc(row.severity)}</span></div>`).join('')}</div>`
}

export { renderPipeline }
