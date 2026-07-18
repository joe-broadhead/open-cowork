import { esc, escAttr } from '../html.js'
import { shortPath, cleanSessionTitle, fmtMoney, fmtNumber, compactNumber, fmtPct, seriesValues } from '../format.js'
import { card, metric, headFig, mini, gauge, areaChart, renderMetricTabs, stackedBar } from '../components.js'
import type { DashboardView } from '../types.js'
import type { OpenCodeUsageReport, UsageBreakdownRow, UsageSessionRow } from '../../opencode-usage.js'

function renderUsage(view: DashboardView): string {
  const usage = view.usage
  const spendPerSession = usage.totals.sessions ? usage.totals.cost / usage.totals.sessions : 0
  return `<section class="view" data-view="usage">
    <div class="view-head"><div><h1 class="page-h">Cost and Usage</h1><p class="page-sub">OpenCode-native token and dollar burn from ${esc(usage.source)}${usage.dbPath ? ` at ${esc(shortPath(usage.dbPath))}` : ''}. Separate from Gateway governance budgets.</p></div><div class="head-figs">
      ${headFig(fmtMoney(usage.totals.cost), 'spend')}${headFig(compactNumber(usage.totals.tokenBurn), 'tokens')}${headFig(fmtMoney(spendPerSession), 'per session')}
    </div></div>
    <div class="kpis">
      ${metric('Input', compactNumber(usage.totals.input), 'prompt tokens')}
      ${metric('Output', compactNumber(usage.totals.output), 'completion tokens')}
      ${metric('Reasoning', compactNumber(usage.totals.reasoning), 'reasoning tokens')}
      ${metric('Messages', fmtNumber(usage.totals.messages), `${fmtNumber(usage.totals.sessions)} sessions`)}
    </div>
    ${card('Spend Over Time', '$', renderMetricTabs(), renderUsageTrend(usage))}
    <div class="grid-2">
      ${card('Cost By Model', 'M', `<span class="pill purple">${usage.byModel.length} models</span>`, renderModelDonut(usage))}
      ${card('Token Composition', 'T', `<span class="pill">${compactNumber(usage.totals.tokenBurn)} total</span>`, renderTokenComposition(usage))}
    </div>
    ${card('Token Burn By Agent', 'A', `<span class="pill">${usage.byAgent.length} agents</span>`, renderBreakdownBars(usage.byAgent, Math.max(1, ...usage.byAgent.map(row => row.tokenBurn))))}
    ${card('Top Sessions By Spend', 'S', '<span class="pill">OpenCode Session drilldown</span>', renderTopSessions(usage.topSessions))}
  </section>`
}
function renderUsageTrend(usage: OpenCodeUsageReport): string {
  if (!usage.available) return `<p class="empty bad-text">OpenCode usage is unavailable: ${esc(usage.error || 'unknown error')}</p>`
  const panels = [
    { key: 'cost', label: 'total spend', value: fmtMoney(usage.totals.cost), values: seriesValues(usage.series, 'cost'), color: 'var(--purple)' },
    { key: 'tokens', label: 'tokens burned', value: compactNumber(usage.totals.tokenBurn), values: seriesValues(usage.series, 'tokens'), color: 'var(--cyan)' },
    { key: 'sessions', label: 'sessions', value: fmtNumber(usage.totals.sessions), values: seriesValues(usage.series, 'sessions'), color: 'var(--orange)' },
  ]
  return `${panels.map((panel, index) => `<div class="chart-panel ${index === 0 ? 'active' : ''}" data-metric-panel="${escAttr(panel.key)}"><div class="chart-meta">${mini('Value', panel.value)}${mini('Input', compactNumber(usage.totals.input))}${mini('Output', compactNumber(usage.totals.output))}${mini('Cache Read', compactNumber(usage.totals.cacheRead))}</div>${areaChart(panel.values, panel.color, 178)}<div class="src-note">${esc(panel.label)} daily series from message.time_created for ${esc(usage.window.label)}.</div></div>`).join('')}`
}

function renderModelDonut(usage: OpenCodeUsageReport): string {
  if (!usage.byModel.length) return '<p class="empty">No model spend in this window.</p>'
  const colors = ['var(--purple)', 'var(--cyan)', 'var(--green)', 'var(--orange)', 'var(--pink)']
  const total = usage.byModel.reduce((sum, row) => sum + row.cost, 0) || 1
  let cursor = 0
  const segments = usage.byModel.map((row, index) => {
    const next = cursor + (row.cost / total) * 100
    const segment = `${colors[index % colors.length]} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`
    cursor = next
    return segment
  }).join(',')
  return `<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${segments})"><div class="donut-center"><div>${fmtMoney(total)}</div><small>spend</small></div></div><div class="legend">${usage.byModel.map((row, index) => `<div class="legend-row"><span class="legend-name"><span class="sw" style="background:${colors[index % colors.length]}"></span><span>${esc(row.label)}</span></span><span>${fmtMoney(row.cost)} (${fmtPct(row.cost / total)})</span></div>`).join('')}</div></div>`
}

function renderTokenComposition(usage: OpenCodeUsageReport): string {
  const totals = usage.totals
  const segments = [
    { label: 'Input', value: totals.input, color: 'var(--purple)' },
    { label: 'Output', value: totals.output, color: 'var(--cyan)' },
    { label: 'Reasoning', value: totals.reasoning, color: 'var(--pink)' },
    { label: 'Cache read', value: totals.cacheRead, color: 'var(--green)' },
    { label: 'Cache write', value: totals.cacheWrite, color: 'var(--orange)' },
  ]
  return `<div class="grid-2"><div>${stackedBar(segments)}</div>${gauge(Math.round(totals.cacheHitRate * 100), 'var(--green)', 'Cache hit', `${fmtNumber(totals.cacheHits)} cached messages`)}</div>`
}

function renderBreakdownBars(rows: UsageBreakdownRow[], maxTokens: number): string {
  if (!rows.length) return '<p class="empty">No agent usage in this window.</p>'
  return `<div class="lane">${rows.map((row, index) => {
    const colors = ['var(--purple)', 'var(--cyan)', 'var(--green)', 'var(--orange)', 'var(--pink)']
    const width = maxTokens ? Math.max(3, Math.round((row.tokenBurn / maxTokens) * 100)) : 0
    return `<div><div class="legend-row"><span class="legend-name"><span class="sw" style="background:${colors[index % colors.length]}"></span><span>${esc(row.label)}</span></span><span>${fmtMoney(row.cost)} / ${compactNumber(row.tokenBurn)} tok / ${fmtNumber(row.sessions)} sessions</span></div><div class="track"><span style="width:${width}%;background:${colors[index % colors.length]}"></span></div></div>`
  }).join('')}</div>`
}

function renderTopSessions(sessions: UsageSessionRow[]): string {
  if (!sessions.length) return '<p class="empty">No OpenCode usage in this window.</p>'
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>Agent</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${sessions.map(session => `<tr><td class="name">${session.webUrl ? `<a href="${escAttr(session.webUrl)}" target="_blank" rel="noreferrer">${esc(cleanSessionTitle(session.title))}</a>` : esc(cleanSessionTitle(session.title))}</td><td>${esc(session.agent)}</td><td>${esc(session.model)}</td><td class="num">${compactNumber(session.tokenBurn)}</td><td class="num">${fmtMoney(session.cost)}</td></tr>`).join('')}</tbody></table></div>`
}

export { renderUsage }
