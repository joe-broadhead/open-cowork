import { esc } from '../html.js'
import { fmtNumber, formatDateTime } from '../format.js'
import { card, metric, headFig, mini } from '../components.js'
import { alphaStatusLabel, alphaStatusClass } from './shared.js'
import type { DashboardView } from '../types.js'
import type { AlphaHealthSummary, AlphaHealthIndicatorStatus } from '../../alpha-health.js'

function renderAlphaHealth(view: DashboardView): string {
  const alpha = view.alphaHealth
  const statusClass = alphaStatusClass(alpha.status)
  const openIndicators = alpha.indicators.filter(indicator => indicator.status !== 'ok').length
  return `<section class="view" data-view="alpha-health" data-testid="alpha-health-view">
    <div class="view-head"><div><h1 class="page-h">Local Beta Health</h1><p class="page-sub">Compact operator summary from durable Gateway evidence: runs, service health, scheduler recovery, channels, gates, eval scorecards, backups, recovery drills, and blockers.</p></div><div class="head-figs">
      ${headFig(alphaStatusLabel(alpha), 'status')}${headFig(String(alpha.blockers.length), 'blockers')}${headFig(alpha.alphaHealthy === true ? 'yes' : alpha.alphaHealthy === false ? 'no' : 'unknown', 'all healthy')}
    </div></div>
    <div class="kpis" data-testid="alpha-health-kpis">
      ${metric('Service Health', alphaIndicatorValue(alpha, 'service_health'), alphaIndicatorNote(alpha, 'service_health'))}
      ${metric('Open Gates', alphaIndicatorValue(alpha, 'open_gates'), alphaIndicatorNote(alpha, 'open_gates'))}
      ${metric('Backup / Drill', alphaIndicatorValue(alpha, 'backup_restore'), alphaIndicatorNote(alpha, 'backup_restore'))}
    </div>
    ${card('Readiness Summary', 'A', `<span class="pill ${statusClass}" data-testid="alpha-health-status">${esc(alpha.status)}</span>`, `<p class="empty ${statusClass === 'good' ? 'good' : ''}">${esc(alpha.summary)}</p><div class="src-note">Generated ${esc(formatDateTime(alpha.generatedAt))}. Healthy is true only when every indicator is backed by current durable evidence and no blockers are open.</div>`)}
    ${card('Health Indicators', 'H', `<span class="pill ${openIndicators ? 'warn' : 'good'}">${openIndicators ? `${openIndicators} review` : 'clear'}</span>`, renderAlphaIndicators(alpha))}
    <div class="grid-2">
      ${card('Recent Evidence', 'E', '<span class="pill purple">durable</span>', renderAlphaEvidence(alpha))}
      ${card('Unresolved Blockers', '!', `<span class="pill ${alpha.blockers.length ? 'bad' : 'good'}">${alpha.blockers.length ? `${alpha.blockers.length} open` : 'clear'}</span>`, renderAlphaBlockers(alpha))}
    </div>
    ${card('Evidence Sources', 'S', `<span class="pill ${alpha.sources.every(source => source.available) ? 'good' : 'warn'}">${alpha.sources.every(source => source.available) ? 'loaded' : 'partial'}</span>`, renderAlphaSources(alpha))}
  </section>`
}
function renderAlphaIndicators(alpha: AlphaHealthSummary): string {
  if (!alpha.indicators.length) return '<p class="empty">Alpha health indicators are unavailable. Durable Gateway sections remain visible elsewhere in Mission Control.</p>'
  return `<div class="table-wrap"><table class="table alpha-indicators" data-testid="alpha-health-indicators"><thead><tr><th>Indicator</th><th class="status-cell">Status</th><th>Meaning</th><th class="source-cell">Evidence Source</th><th class="updated-cell">Updated</th></tr></thead><tbody>${alpha.indicators.map(indicator => `<tr data-testid="alpha-health-indicator-row"><td class="name">${esc(indicator.label)}<div class="meta">${esc(indicator.detail)}</div></td><td class="status-cell"><span class="pill ${alphaIndicatorClass(indicator.status)}">${esc(indicator.status)}</span></td><td>${esc(indicator.summary)}${indicator.items.length ? `<div class="meta">${esc(indicator.items.slice(0, 3).map(item => `${item.label}: ${item.status}${item.detail ? ` - ${item.detail}` : ''}`).join(' / '))}</div>` : ''}</td><td class="source-cell">${esc(indicator.source)}</td><td class="updated-cell">${indicator.updatedAt ? esc(formatDateTime(indicator.updatedAt)) : '--'}</td></tr>`).join('')}</tbody></table></div>`
}

function renderAlphaEvidence(alpha: AlphaHealthSummary): string {
  const scorecards = alpha.recent.scorecards.map(scorecard => `<div class="row compact"><span class="dot ${scorecard.status === 'blocked' || scorecard.recommendation === 'block' ? 'blocked' : 'done'}"></span><div><div class="title">${esc(scorecard.subjectKind || 'subject')}:${esc(scorecard.subjectName || scorecard.id)}</div><div class="meta">${esc(scorecard.sourceKind || 'scorecard')}:${esc(scorecard.sourceId || '?')} / ${scorecard.updatedAt ? esc(formatDateTime(scorecard.updatedAt)) : '--'}</div></div><span class="pill ${scorecard.status === 'blocked' || scorecard.recommendation === 'block' ? 'bad' : 'good'}">${esc(scorecard.recommendation || scorecard.status || '?')}</span></div>`)
  const drills = alpha.recent.recoveryDrills.map(drill => `<div class="row compact"><span class="dot ${drill.status === 'pass' ? 'done' : 'blocked'}"></span><div><div class="title">${esc(drill.id)}</div><div class="meta">${esc(drill.evidencePath || drill.path)} / ${drill.checks.passed}/${drill.checks.total} checks passed</div></div><span class="pill ${drill.status === 'pass' ? 'good' : 'bad'}">${esc(drill.status)}</span></div>`)
  const backups = alpha.recent.backups.map(backup => `<div class="row compact"><span class="dot ${backup.ok === false ? 'blocked' : 'done'}"></span><div><div class="title">${esc(backup.id)}</div><div class="meta">${esc(backup.path)} / ${backup.counts?.tasks || 0} tasks / ${backup.counts?.runs || 0} runs</div></div><span class="pill ${backup.ok === false ? 'bad' : 'good'}">${backup.ok === false ? 'bad' : 'ok'}</span></div>`)
  const rows = [...scorecards, ...drills, ...backups].slice(0, 12)
  return rows.length ? `<div class="lane">${rows.join('')}</div>` : '<p class="empty">No eval scorecards, backups, or recovery drill evidence recorded yet. First-run setup is visible, but alpha health is not proven.</p>'
}

function renderAlphaBlockers(alpha: AlphaHealthSummary): string {
  if (!alpha.blockers.length) return '<p class="empty good">No unresolved alpha blockers found in durable Gateway evidence.</p>'
  return `<div class="lane">${alpha.blockers.map(blocker => `<div class="row compact"><span class="dot blocked"></span><div><div class="title">${esc(blocker.label)}</div><div class="meta">${esc(blocker.detail || '')}${blocker.source ? ` / ${esc(blocker.source)}` : ''}</div></div><span class="pill bad">${esc(blocker.status)}</span></div>`).join('')}</div>`
}

function renderAlphaSources(alpha: AlphaHealthSummary): string {
  return `<div class="grid-3">${alpha.sources.map(source => mini(source.label, source.available ? fmtNumber(source.count) : 'unavailable')).join('')}</div><div class="src-note">Missing sources are first-run or partial-data states, not hidden pass/fail assumptions. Each indicator names the route, table, or local evidence directory it used.</div>`
}

function alphaIndicatorValue(alpha: AlphaHealthSummary, id: AlphaHealthSummary['indicators'][number]['id']): string {
  const indicator = alpha.indicators.find(row => row.id === id)
  if (!indicator) return '--'
  if (indicator.count !== undefined) return String(indicator.count)
  return indicator.status
}

function alphaIndicatorNote(alpha: AlphaHealthSummary, id: AlphaHealthSummary['indicators'][number]['id']): string {
  return alpha.indicators.find(row => row.id === id)?.summary || 'indicator unavailable'
}
function alphaIndicatorClass(status: AlphaHealthIndicatorStatus): string {
  if (status === 'ok') return 'good'
  if (status === 'blocked') return 'bad'
  return 'warn'
}

export { renderAlphaHealth }
