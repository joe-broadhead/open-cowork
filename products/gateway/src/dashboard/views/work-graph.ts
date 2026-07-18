import { esc, escAttr } from '../html.js'
import { fmtNumber, formatDateTime, shortHash, shortId } from '../format.js'
import { card, metric, mini, headFig } from '../components.js'
import type { DashboardView, DashboardSourceContract, WorkGraphView, WorkGraphNode } from '../types.js'
import type { MissionControlDataPlaneV2 } from '../../mission-control-view-model.js'

function renderWorkGraph(view: DashboardView): string {
  const graph = view.workGraph
  const selected = graph.selected || graph.nodes[0]
  return `<section class="view" data-view="work-graph">
    <div class="view-head"><div><h1 class="page-h">Work Graph</h1><p class="page-sub">Channel Target to Session to Project, Issue, Run, Supervisor, Gate, Alert, Profile, and Team relationships.</p></div><div class="head-figs">
      ${headFig(String(graph.window.nodes.total), 'nodes')}${headFig(String(graph.window.edges.total), 'edges')}${headFig(String(graph.stats.blocked), 'attention')}
    </div></div>
    <div class="kpis">
      ${metric('Channels / Sessions', `${graph.stats.channels}/${graph.stats.sessions}`, 'conversation ownership')}
      ${metric('Projects / Initiatives', `${graph.stats.projects}/${graph.stats.initiatives}`, 'durable planning')}
      ${metric('Issues / Runs', `${graph.stats.issues}/${graph.stats.runs}`, 'execution chain')}
      ${metric('Gates / Alerts', `${graph.stats.gates}/${graph.stats.alerts}`, 'operator decisions')}
    </div>
    ${renderWorkGraphSources(graph)}
    ${card('Data Plane V2', 'D', `<span class="pill ${missionControlDataPlaneClass(view.dataPlane.status)}">${esc(view.dataPlane.status)}</span>`, renderMissionControlDataPlane(view.dataPlane))}
    ${card('Window Contracts', 'W', `<span class="pill ${view.sourceContracts.some(contract => contract.truncated) ? 'warn' : 'good'}">${view.sourceContracts.filter(contract => contract.truncated).length ? 'bounded' : 'complete'}</span>`, renderSourceContracts(view.sourceContracts))}
    ${view.sourceDiagnostics.some(row => !row.available) ? card('Source Diagnostics', '!', '<span class="pill warn">degraded</span>', renderSourceDiagnostics(view.sourceDiagnostics)) : ''}
    <div class="filter-bar" aria-label="Work graph filters">
      ${['attention', 'blocked', 'channel', 'session', 'project', 'issue', 'run', 'supervisor', 'gate', 'alert'].map(filter => `<span class="filter-chip">${esc(filter)}</span>`).join('')}
    </div>
    <div class="work-layout">
      <div class="stack">
        ${card('Relationship Edges', 'E', `<span class="pill ${graph.attentionEdges.length ? 'warn' : 'good'}">${graph.attentionEdges.length ? `${graph.attentionEdges.length} need attention` : 'clear'}</span>`, renderWorkGraphEdges(graph))}
        ${card('Adjacency Groups', 'A', `<span class="pill">${graph.nodes.length}/${graph.window.nodes.total} stable IDs</span>`, renderWorkGraphAdjacency(graph))}
      </div>
      <aside class="detail-panel">
        ${card('Selected Object', 'D', selected ? `<span class="pill ${severityClass(selected.severity)}">${esc(selected.kind)}</span>` : '', renderWorkGraphDetails(graph))}
      </aside>
    </div>
  </section>`
}
function renderWorkGraphSources(graph: WorkGraphView): string {
  const unavailable = graph.sources.filter(source => !source.available)
  const sourceRows = graph.sources.map(source => `${source.name} ${source.available ? source.count : 'unavailable'}`)
  const body = `<div class="grid-3">${graph.sources.slice(0, 6).map(source => mini(source.name, source.available ? fmtNumber(source.count) : 'unavailable')).join('')}</div>
    ${unavailable.length ? `<p class="empty" style="margin-top:10px">Partial data: ${esc(unavailable.map(source => `${source.name} unavailable from ${source.route}`).join('; '))}. Available Gateway-owned data is still shown.</p>` : ''}
    <div class="src-note">sources: ${esc(sourceRows.join(' / '))}. Credentials, permissions, and sensitive metadata are redacted before rendering.</div>`
  return card('Data Sources', 'S', `<span class="pill ${unavailable.length ? 'warn' : 'good'}">${unavailable.length ? 'partial' : 'complete'}</span>`, body)
}

function renderSourceDiagnostics(rows: DashboardView['sourceDiagnostics']): string {
  const failed = rows.filter(row => !row.available)
  if (!failed.length) return '<p class="empty good">All named Mission Control sources loaded.</p>'
  return `<div class="lane">${failed.map(row => `<div class="row compact"><span class="dot pending"></span><div><div class="title">${esc(row.source)}</div><div class="meta">${esc(row.summary || 'Source unavailable')}</div></div><span class="pill warn">unavailable</span></div>`).join('')}</div>`
}

function renderSourceContracts(contracts: DashboardSourceContract[]): string {
  const rows = contracts
  if (!rows.length) return '<p class="empty">No Mission Control source contracts were projected.</p>'
  return `<div class="table-wrap"><table class="table" data-testid="source-contracts"><thead><tr><th>Source</th><th>View</th><th>Route</th><th>Window</th><th>Status</th></tr></thead><tbody>${rows.map(contract => {
    const shown = `${fmtNumber(contract.shown)} of ${fmtNumber(contract.matched)}${contract.matched !== contract.total ? ` matched / ${fmtNumber(contract.total)} total` : ''}`
    const page = `offset ${fmtNumber(contract.offset)} / limit ${fmtNumber(contract.limit)}${contract.hasMore ? ' / next available' : ''}`
    const cls = sourceSeverityClass(contract.severity)
    return `<tr data-testid="source-contract-${escAttr(contract.key)}"><td class="name">${esc(contract.label)}<div class="meta">${contract.search ? `search ${esc(contract.search)} / ` : ''}${esc(page)}</div></td><td>${esc(contract.view)}</td><td>${esc(contract.route)}</td><td>${esc(shown)}<div class="meta">${esc(contract.nextAction)}</div></td><td><span class="pill ${cls}">${esc(contract.state)}</span></td></tr>`
  }).join('')}</tbody></table></div><div class="src-note">Window query parameters: q/search for global search, plus source-specific keys such as runsLimit, runsOffset, sessionsSearch, and workGraphEdgesOffset. Counts show matched rows before the rendered window.</div>`
}

function renderMissionControlDataPlane(report: MissionControlDataPlaneV2): string {
  return `<div data-testid="mission-control-data-plane-v2">
    <div class="grid-4">${mini('Sources', fmtNumber(report.windowTotals.sources))}${mini('Shown rows', `${fmtNumber(report.windowTotals.shownRows)} / ${fmtNumber(report.windowTotals.matchedRows)}`)}${mini('Bounded', fmtNumber(report.windowTotals.truncatedSources))}${mini('Blocked/error', fmtNumber(report.windowTotals.blockedOrErrorSources))}</div>
    <p class="setup-copy" style="margin:10px 0 0">${esc(report.summary)}</p>
    <div class="lane" style="margin-top:10px">${report.consumers.map(consumer => `<div class="row compact"><span class="dot done"></span><div><div class="title">${esc(consumer.consumer)}</div><div class="meta">${esc(consumer.summary)}</div></div><span class="pill good">${consumer.readOnly ? 'read-only' : 'review'}</span></div>`).join('')}</div>
    <div class="src-note">${esc(report.releaseClaimBoundary)}. Unsupported: ${esc(report.unsupportedClaims.slice(0, 3).join(', '))}.</div>
  </div>`
}

function missionControlDataPlaneClass(status: MissionControlDataPlaneV2['status']): string {
  if (status === 'blocked') return 'bad'
  if (status === 'degraded') return 'warn'
  if (status === 'bounded') return 'cyan'
  return 'good'
}

function sourceSeverityClass(severity: DashboardSourceContract['severity']): string {
  if (severity === 'critical') return 'bad'
  if (severity === 'warning') return 'warn'
  if (severity === 'info') return 'cyan'
  return 'good'
}

function renderWorkGraphEdges(graph: WorkGraphView): string {
  if (!graph.edges.length) return '<p class="empty">No work graph edges yet. Source: `/tasks`, `/project-bindings`, `/runs`, `/roadmap-supervisors`, `/channels/bindings`.</p>'
  return `<div class="filter-box"><input type="search" data-filter-input="wg-edges" placeholder="Filter edges by node, kind, status, source" aria-label="Filter work graph edges"><span class="count" data-filter-count="wg-edges">${graph.edges.length}/${graph.edges.length}</span></div><div class="table-wrap"><table class="table"><thead><tr><th>From</th><th>Edge</th><th>To</th><th>Status</th><th>Reason</th><th>Source</th></tr></thead><tbody>${graph.edges.map((edge, index) => {
    const from = graph.nodes.find(node => node.id === edge.from)
    const to = graph.nodes.find(node => node.id === edge.to)
    const selectId = edge.severity === 'ok' ? edge.to : edge.from
    const fromLabel = workNodeDisplayLabel(from, edge.from)
    const toLabel = workNodeDisplayLabel(to, edge.to)
    return `<tr data-filter-row="wg-edges" data-filter-text="${escAttr(`${fromLabel} ${edge.kind} ${toLabel} ${edge.status} ${edge.source}`)}"><td class="name"><button class="edge-select" type="button" data-work-select="${escAttr(workNodeDomId(selectId))}" aria-pressed="${index === 0 ? 'true' : 'false'}">${esc(fromLabel)}</button></td><td>${esc(edge.kind)}</td><td class="name"><button class="edge-select" type="button" data-work-select="${escAttr(workNodeDomId(edge.to))}">${esc(toLabel)}</button></td><td><span class="pill ${severityClass(edge.severity)}">${esc(edge.status)}</span></td><td>${esc(edge.reason)}</td><td>${esc(edge.source)}</td></tr>`
  }).join('')}</tbody></table></div>`
}

function renderWorkGraphAdjacency(graph: WorkGraphView): string {
  if (!graph.nodes.length) return '<p class="empty">No active Issues. Source: `/tasks`.</p>'
  const owners = graph.nodes.filter(node => ['channel-target', 'session', 'project', 'initiative', 'issue'].includes(node.kind)).slice(0, 10)
  return `<div class="lane">${owners.map(node => {
    const out = graph.edges.filter(edge => edge.from === node.id)
    const into = graph.edges.filter(edge => edge.to === node.id)
    const related = [...out.map(edge => `-> ${edge.kind} ${workNodeDisplayLabel(graph.nodes.find(node => node.id === edge.to), edge.to)}`), ...into.map(edge => `<- ${edge.kind} ${workNodeDisplayLabel(graph.nodes.find(node => node.id === edge.from), edge.from)}`)].slice(0, 5)
    return `<div class="row compact"><span class="dot ${nodeDot(node)}"></span><div><div class="title"><button class="edge-select" type="button" data-work-select="${escAttr(workNodeDomId(node.id))}">${esc(workNodeDisplayName(node))}</button></div><div class="meta">${esc(node.kind)} / ${esc(workNodeDisplayLabel(node, node.id))} / ${related.length ? related.join(' / ') : 'no linked edges yet'}</div></div><span class="pill ${severityClass(node.severity)}">${esc(node.status)}</span></div>`
  }).join('')}</div>`
}

function renderWorkGraphDetails(graph: WorkGraphView): string {
  if (!graph.nodes.length) return '<p class="empty">No graph objects are available yet.</p>'
  return graph.nodes.map((node, index) => {
    const outgoing = graph.edges.filter(edge => edge.from === node.id)
    const incoming = graph.edges.filter(edge => edge.to === node.id)
    const related = [...incoming.map(edge => `${workNodeDisplayLabel(graph.nodes.find(node => node.id === edge.from), edge.from)} -> ${edge.kind}`), ...outgoing.map(edge => `${edge.kind} -> ${workNodeDisplayLabel(graph.nodes.find(node => node.id === edge.to), edge.to)}`)]
    return `<div class="work-detail ${index === 0 ? 'active' : ''}" data-work-detail="${escAttr(workNodeDomId(node.id))}">
      <div class="title">${esc(workNodeDisplayName(node))}</div>
      <div class="meta">${esc(workNodeDisplayLabel(node, node.id))}</div>
      <dl class="detail-kv">
        <dt>Kind</dt><dd>${esc(node.kind)}</dd>
        <dt>Status</dt><dd>${esc(node.status)}</dd>
        <dt>Severity</dt><dd>${esc(node.severity)}</dd>
        <dt>Source</dt><dd>${esc(node.source)}</dd>
        <dt>Updated</dt><dd>${node.updatedAt ? esc(formatDateTime(node.updatedAt)) : '--'}</dd>
        <dt>Link</dt><dd><a href="${escAttr(node.href)}">${esc(node.href)}</a></dd>
        <dt>Alias</dt><dd>${esc(node.alias || '--')}</dd>
      </dl>
      <div class="src-note">${node.redacted ? 'Redacted: sensitive metadata exists but is not shown. ' : ''}${esc(node.summary || 'No additional summary available.')}</div>
      ${related.length ? `<div class="lane" style="margin-top:10px">${related.slice(0, 8).map(item => `<div class="row compact"><div><div class="meta">${esc(item)}</div></div></div>`).join('')}</div>` : '<p class="empty" style="margin-top:10px">No incoming or outgoing links for this object yet.</p>'}
    </div>`
  }).join('')
}
function severityClass(severity: WorkGraphNode['severity']): string {
  if (severity === 'critical') return 'bad'
  if (severity === 'warning') return 'warn'
  if (severity === 'ok') return 'good'
  return 'purple'
}

function nodeDot(node: WorkGraphNode): string {
  if (node.severity === 'critical') return 'blocked'
  if (node.severity === 'warning') return 'pending'
  if (node.severity === 'ok') return 'done'
  return ''
}

function workNodeLabel(node: WorkGraphNode | undefined, fallback: string): string {
  return node ? `${node.kind}:${shortId(node.id)}` : shortId(fallback)
}

function workNodeDisplayLabel(node: WorkGraphNode | undefined, fallback: string): string {
  if (node?.redacted && node.kind === 'channel-target') return `${node.kind}:redacted-target`
  return workNodeLabel(node, fallback)
}

function workNodeDisplayName(node: WorkGraphNode): string {
  if (node.redacted && node.kind === 'channel-target') return `${node.alias || 'channel'} target (redacted)`
  return node.label
}

function workNodeDomId(id: string): string {
  const text = String(id || '')
  return text.startsWith('channel:') ? `channel-redacted-${shortHash(text)}` : text
}

export { renderWorkGraph }
