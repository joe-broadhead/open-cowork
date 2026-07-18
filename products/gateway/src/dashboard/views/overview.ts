import { esc } from '../html.js'
import { asArray, fmtNumber, seriesValues } from '../format.js'
import { card, statTile, barChart } from '../components.js'
import {
  renderEvents,
  renderGatewaySession,
  renderTask,
  alphaStatusLabel,
  alphaStatusClass,
  serviceHealthLabel,
  serviceHealthNote,
  serviceHealthClass,
  heartbeatLabel,
  heartbeatNoteHtml,
  heartbeatClass,
} from './shared.js'
import type { DashboardView } from '../types.js'
import type { DashboardMissionData } from '../../mission-data.js'

function renderOverview(view: DashboardView, m: DashboardMissionData): string {
  const attentionRows = attentionRowsHtml(view, m)
  const usageValues = seriesValues(view.usage.series, 'sessions')
  return `<section class="view active" data-view="overview">
    <div class="view-head"><div><h1 class="page-h">${esc(view.headline)}</h1><p class="page-sub">Triage rollup for attention, live Gateway sessions, durable work, and recent routing events.</p></div></div>
    <div class="rollup">
      ${statTile('Alpha health', alphaStatusLabel(view.alphaHealth), esc(view.alphaHealth.summary), 'alpha-health', alphaStatusClass(view.alphaHealth.status))}
      ${statTile('System', serviceHealthLabel(view.serviceHealth), serviceHealthNote(view.serviceHealth), 'health', serviceHealthClass(view.serviceHealth))}
      ${statTile('Heartbeat', heartbeatLabel(view.heartbeat), heartbeatNoteHtml(view.heartbeat), 'health', heartbeatClass(view.heartbeat))}
      ${statTile('Work in flight', `${view.counts.running}/${view.counts.pending}`, `${view.counts.running} running, ${view.counts.pending} pending`, 'pipeline', view.counts.running ? 'warn' : 'cyan')}
    </div>
    <div class="grid-2">
      ${card('Needs Attention', '!', `<span class="pill ${view.counts.attention ? 'warn' : 'good'}">${view.counts.attention ? `${view.counts.attention} open` : 'clear'}</span>`, attentionRows)}
      <div class="stack">
        ${card('Now Running', '>', `<span class="pill ${view.activeSessions.length ? 'warn' : 'good'}">${view.activeSessions.length} sessions</span>`, view.activeSessions.length ? `<div class="lane">${view.activeSessions.map(renderGatewaySession).join('')}</div>` : '<p class="empty good">No active Gateway sessions.</p>')}
        ${card('Usage Activity', '#', `<span class="pill purple">${esc(view.usage.window.label)}</span>`, `${barChart(usageValues, 'var(--purple)', 46)}<div class="src-note">source: opencode.db daily message rollup; usage window only.</div>`)}
      </div>
    </div>
    ${card('Live Events', '~', `<span class="pill good"><span class="live-dot"></span>live</span>`, renderEvents(view.events.slice(-8).reverse()))}
  </section>`
}
function attentionRowsHtml(view: DashboardView, m: DashboardMissionData): string {
  const attention = m.attention
  const projectRows = asArray(attention?.projects).slice(0, 8).map((project: any) => `<div class="row compact"><span class="dot ${attentionDot(project.severity)}"></span><div><div class="title">${esc(project.roadmapTitle || project.roadmapId || 'Unscoped attention')}</div><div class="meta">${fmtNumber(asArray(project.items).length)} item${asArray(project.items).length === 1 ? '' : 's'}${project.channels ? ` / ${project.channels} channel${project.channels === 1 ? '' : 's'}` : ''} / ${esc(asArray(project.items)[0]?.summary || '')}</div></div><span class="pill ${attentionClass(project.severity)}">${esc(project.severity || '?')}</span></div>`)
  if (projectRows.length) return `<div class="lane">${projectRows.join('')}</div>`
  const rows = asArray(attention?.items).slice(0, 12).map((item: any) => `<div class="row compact"><span class="dot ${attentionDot(item.severity)}"></span><div><div class="title">${esc(item.title || item.kind || 'Attention')}</div><div class="meta">${esc(item.summary || '')} / ${esc(item.action || '')}${item.channels ? ` / ${item.channels} channel${item.channels === 1 ? '' : 's'}` : ''}</div></div><span class="pill ${attentionClass(item.severity)}">${esc(item.severity || '?')}</span></div>`)
  if (rows.length) return `<div class="lane">${rows.join('')}</div>`
  const fallbackRows: string[] = []
  if (asArray(m.questions).length) fallbackRows.push(`<div class="row compact"><div><div class="title">OpenCode questions waiting</div><div class="meta">Use gateway_question_list</div></div><span class="pill warn">${asArray(m.questions).length}</span></div>`)
  if (asArray(m.permissions).length) fallbackRows.push(`<div class="row compact"><div><div class="title">OpenCode permissions waiting</div><div class="meta">Use gateway_permission_list</div></div><span class="pill warn">${asArray(m.permissions).length}</span></div>`)
  fallbackRows.push(...view.attentionTasks.map(renderTask))
  return fallbackRows.length ? `<div class="lane">${fallbackRows.join('')}</div>` : '<p class="empty good">No blocked tasks, paused work, questions, permissions, gates, or stale runs.</p>'
}
function attentionClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'bad'
  if (severity === 'medium') return 'warn'
  return 'good'
}

function attentionDot(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'blocked'
  if (severity === 'medium') return 'pending'
  return 'done'
}

export { renderOverview }
