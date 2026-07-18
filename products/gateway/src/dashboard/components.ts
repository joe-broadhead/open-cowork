import { esc, escAttr } from './html.js'
import { fmtNumber, fmtPct, normalizeSeries } from './format.js'

function navLink(route: string, label: string, badge = ''): string {
  return `<a class="nav-link" href="#/${escAttr(route)}" data-nav="${escAttr(route)}"><span>${esc(label)}</span>${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</a>`
}

function card(title: string, hi: string, right: string, body: string): string {
  return `<div class="card"><div class="card-head"><div class="card-title"><span class="hi">${esc(hi)}</span><span>${esc(title)}</span></div>${right || ''}</div><div class="card-body">${body}</div></div>`
}

function statTile(label: string, value: string, noteHtml: string, route: string, cls: string): string {
  return `<a class="stat ${escAttr(cls)}" href="#/${escAttr(route)}"><div class="stat-label"><span>${esc(label)}</span><span>open</span></div><div class="stat-value">${esc(value)}</div><div class="stat-note">${noteHtml}</div></a>`
}

function headFig(value: string, label: string): string {
  return `<div class="hf"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`
}

function metric(label: string, value: string, note: string): string {
  return `<div class="metric"><div class="metric-value">${esc(value)}</div><div class="metric-label">${esc(label)}</div><div class="metric-note">${esc(note)}</div></div>`
}

function renderMetricTabs(): string {
  return `<div class="tabs"><button type="button" data-metric-tab="cost" aria-pressed="true">Cost</button><button type="button" data-metric-tab="tokens" aria-pressed="false">Tokens</button><button type="button" data-metric-tab="sessions" aria-pressed="false">Sessions</button></div>`
}
function mini(label: string, value: string, html = false): string {
  return `<div class="mini"><div class="mini-value">${html ? value : esc(value)}</div><div class="mini-label">${esc(label)}</div></div>`
}

function stackedBar(segments: Array<{ label: string; value: number; color: string }>): string {
  const active = segments.filter(segment => Number(segment.value || 0) > 0)
  const total = active.reduce((sum, segment) => sum + segment.value, 0)
  if (!active.length || total <= 0) return '<p class="empty">No values to display.</p>'
  return `<div class="stack-bar tall">${active.map(segment => `<span style="width:${Math.max(1, (segment.value / total) * 100)}%;background:${segment.color}" title="${escAttr(segment.label)}"></span>`).join('')}</div><div class="legend">${active.map(segment => `<div class="legend-row"><span class="legend-name"><span class="sw" style="background:${segment.color}"></span><span>${esc(segment.label)}</span></span><span>${fmtNumber(segment.value)} (${fmtPct(segment.value / total)})</span></div>`).join('')}</div>`
}

function gauge(pct: number, color: string, label: string, sub: string): string {
  const safePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const radius = 38
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - safePct / 100)
  return `<div class="gauge"><svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="${escAttr(label)} ${safePct}%"><circle cx="52" cy="52" r="${radius}" fill="none" stroke="var(--raised)" stroke-width="9"></circle><circle cx="52" cy="52" r="${radius}" fill="none" stroke="${escAttr(color)}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 52 52)"></circle><text x="52" y="58" text-anchor="middle" fill="var(--text)" font-family="JetBrains Mono" font-size="18" font-weight="700">${safePct}%</text></svg><div class="gauge-label">${esc(label)}</div><div class="gauge-sub">${esc(sub)}</div></div>`
}

function barChart(values: number[], color: string, height: number): string {
  const data = normalizeSeries(values)
  const max = Math.max(1, ...data)
  const width = 180
  const step = width / data.length
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${data.map((value, index) => {
    const barHeight = Math.max(2, (value / max) * (height - 4))
    return `<rect x="${index * step + 1}" y="${height - barHeight}" width="${Math.max(1, step - 2)}" height="${barHeight}" rx="2" fill="${escAttr(color)}" opacity="${0.38 + (index / data.length) * 0.55}"></rect>`
  }).join('')}</svg>`
}

function areaChart(values: number[], color: string, height = 160): string {
  const data = normalizeSeries(values)
  const width = 640
  const pad = 14
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const step = data.length > 1 ? width / (data.length - 1) : width
  const points = data.map((value, index) => [index * step, height - pad - ((value - min) / range) * (height - pad * 2)])
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]!.toFixed(2)} ${point[1]!.toFixed(2)}`).join(' ')
  const fill = `${line} L ${width} ${height} L 0 ${height} Z`
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${fill}" fill="${escAttr(color)}" opacity=".14"></path><path d="${line}" fill="none" stroke="${escAttr(color)}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>`
}

export { navLink, card, statTile, headFig, metric, renderMetricTabs, mini, stackedBar, gauge, barChart, areaChart }
