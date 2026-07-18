import { esc, escAttr } from '../html.js'
import { asArray, shortId, fmtNumber, fmtDuration, formatDateTime } from '../format.js'
import { card, statTile, mini, headFig } from '../components.js'
import { renderCommand } from './shared.js'
import type { DashboardView } from '../types.js'
import type { OperatorSafetyReport } from '../../operator-safety.js'
import type { OperationsCockpitSummary, OperationsCockpitStatus } from '../../mission-control-view-model.js'

function renderOperator(view: DashboardView): string {
  const report = view.operator
  const attentionCount = report.attention.gates + report.attention.questions + report.attention.permissions + report.attention.alerts + report.scheduler.expiredLeases
  return `<section class="view" data-view="operator" data-testid="operator-view">
    <div class="view-head"><div><h1 class="page-h">Operator Cockpit</h1><p class="page-sub">One redacted control surface for public-beta execution: scheduler safety, queue state, active attention, validated surfaces, and deferred release gates.</p></div><div class="head-figs">
      ${headFig(operatorStateLabel(report.state), 'state')}${headFig(String(report.scheduler.availableSlots), 'slots')}${headFig(String(attentionCount), 'attention')}
    </div></div>
    <div class="rollup">
      ${statTile('Operator state', operatorStateLabel(report.state), esc(report.summary), 'operator', operatorStateClass(report.state))}
      ${statTile('Scheduler', report.scheduler.enabled ? 'Enabled' : 'Paused', `${report.scheduler.runningRuns}/${report.scheduler.maxConcurrent} running, ${report.scheduler.expiredLeases} expired leases`, 'pipeline', report.scheduler.enabled ? 'good' : 'warn')}
      ${statTile('Queue', `${report.queue.pending}/${report.queue.running}`, `${report.queue.blocked} blocked, ${report.queue.paused} paused`, 'pipeline', report.queue.blocked ? 'bad' : report.queue.pending || report.queue.running ? 'warn' : 'good')}
      ${statTile('Release claim', 'Beta', esc(report.releaseClaim.scope), 'operator', 'cyan')}
    </div>
    ${card('Current Decision', 'D', `<span class="pill ${operatorStateClass(report.state)}">${esc(report.state)}</span>`, `<p class="empty ${report.state === 'ready_for_beta' ? 'good' : ''}">${esc(report.summary)}</p><div class="src-note">Production certified: ${report.releaseClaim.productionCertified ? 'yes' : 'no'}. ${report.releaseClaim.notes.map(note => esc(note)).join(' ')}</div>`)}
    ${renderOperationsCockpit(view.operationsCockpit)}
    <div class="grid-2">
      ${card('Queue And Leases', 'Q', `<span class="pill ${report.scheduler.expiredLeases ? 'bad' : 'good'}">${report.scheduler.expiredLeases ? `${report.scheduler.expiredLeases} expired` : 'clean'}</span>`, renderOperatorQueue(report))}
      ${card('Operator Attention', '!', `<span class="pill ${attentionCount ? 'warn' : 'good'}">${attentionCount ? `${attentionCount} signal${attentionCount === 1 ? '' : 's'}` : 'clear'}</span>`, renderOperatorAttention(report))}
    </div>
    ${card('Active Run Controls', 'R', `<span class="pill ${report.activeRuns.length ? 'warn' : 'good'}">${report.activeRuns.length} active</span>`, renderOperatorActiveRuns(report))}
    <div class="grid-2">
      ${card('Channel Scope', 'C', `<span class="pill purple">${report.channels.ready.length} ready</span>`, renderOperatorChannels(report))}
      ${card('Safe Commands', '>', '<span class="pill purple">copy/run</span>', renderOperatorActions(report))}
    </div>
    ${card('Deferred Gates', 'G', `<span class="pill warn">${report.channels.deferred.length} deferred</span>`, renderOperatorDeferred(report))}
  </section>`
}

function renderOperationsCockpit(cockpit: OperationsCockpitSummary): string {
  const rows = cockpit.items.map(item => {
    const commandOrRoute = item.command
      ? renderCommand(item.command)
      : item.route
        ? `<a class="session-link" href="${escAttr(item.route)}">${esc(item.route)}</a>`
        : '<span class="meta">source only</span>'
    const blockers = item.blockers.length
      ? `<div class="meta">${esc(item.blockers.slice(0, 4).join(' / '))}</div>`
      : '<div class="meta">no open blocker codes</div>'
    return `<tr data-testid="m27-cockpit-${escAttr(item.id)}"><td class="channel-cell"><b>${esc(item.label)}</b><div class="meta">${esc(item.source)}</div></td><td><span class="pill ${cockpitStatusClass(item.status)}">${esc(item.status)}</span><div class="meta">${esc(item.claim || '--')}${item.previewOnly ? ' / preview only' : ''}</div></td><td>${esc(item.summary)}${blockers}</td><td>${esc(item.nextAction)}</td><td class="command-cell">${commandOrRoute}</td></tr>`
  }).join('')
  return card('Operations Cockpit', 'Ops',`<span class="pill ${cockpitStatusClass(cockpit.status)}">${esc(cockpit.status)}</span>`, `<div class="grid-3">${mini('Ready', fmtNumber(cockpit.counts.ready))}${mini('Blocked', fmtNumber(cockpit.counts.blocked + cockpit.counts.unavailable))}${mini('Preview/deferred', fmtNumber(cockpit.counts.preview + cockpit.counts.deferred + cockpit.counts.unsupported))}</div><p class="empty" style="margin-top:10px">${esc(cockpit.summary)}</p><div class="table-wrap" style="margin-top:10px"><table class="table cockpit-table" data-testid="operations-cockpit"><thead><tr><th class="channel-cell">Area</th><th>Status</th><th>Evidence State</th><th>Next Action</th><th class="command-cell">Safe Action</th></tr></thead><tbody>${rows}</tbody></table></div><div class="src-note">${esc(cockpit.releaseClaimBoundary)} Unsupported claims: ${esc(cockpit.unsupportedClaims.slice(0, 8).join(' / '))}.</div>`)
}

function renderOperatorQueue(report: OperatorSafetyReport): string {
  const owners = Object.entries(report.scheduler.leaseOwners || {})
  const pressure = report.capacity?.dimensions?.filter(row => row.status !== 'ok').slice(0, 6) || []
  const backoff = report.capacity?.providerBackoff?.slice(0, 4) || []
  return `<div class="grid-3">${mini('Pending', fmtNumber(report.queue.pending))}${mini('Running', fmtNumber(report.queue.running))}${mini('Blocked', fmtNumber(report.queue.blocked))}</div>
    <div class="lane" style="margin-top:10px">
      <div class="row compact"><div><div class="title">Scheduler dispatch is ${report.scheduler.enabled ? 'enabled' : 'paused'}</div><div class="meta">max ${report.scheduler.maxConcurrent} / interval ${fmtDuration(report.scheduler.intervalMs)} / available slots ${report.scheduler.availableSlots}</div></div><span class="pill ${report.scheduler.enabled ? 'good' : 'warn'}">${report.scheduler.enabled ? 'dispatching' : 'paused'}</span></div>
      <div class="row compact"><div><div class="title">Lease health</div><div class="meta">${owners.length ? owners.map(([owner, count]) => `${shortId(owner)}:${count}`).join(' / ') : 'no active lease owners'}</div></div><span class="pill ${report.scheduler.expiredLeases ? 'bad' : 'good'}">${report.scheduler.expiredLeases} expired</span></div>
      ${pressure.map(row => `<div class="row compact"><div><div class="title">${esc(row.dimension)} ${esc(row.key)} capacity</div><div class="meta">${fmtNumber(row.used)}/${fmtNumber(row.limit)} used / ${fmtNumber(row.pending)} pending</div></div><span class="pill ${row.status === 'full' ? 'bad' : 'warn'}">${esc(row.status)}</span></div>`).join('')}
      ${backoff.map(row => `<div class="row compact"><div><div class="title">${esc(row.provider)} provider backoff</div><div class="meta">retry after ${esc(formatDateTime(row.retryAfter))} / ${fmtNumber(row.pending)} pending${row.lastError ? ` / ${esc(row.lastError)}` : ''}</div></div><span class="pill warn">backoff</span></div>`).join('')}
    </div>`
}

function renderOperatorActiveRuns(report: OperatorSafetyReport): string {
  const rows = asArray(report.activeRuns).slice(0, 12)
  if (!rows.length) return '<p class="empty good">No active Gateway runs need operator control.</p>'
  return `<div class="table-wrap"><table class="table" data-testid="operator-active-runs"><thead><tr><th>Run</th><th>Issue</th><th>Lease</th><th>Safe control</th></tr></thead><tbody>${rows.map((run: any) => {
    const command = run.cancellable
      ? `opencode-gateway operator run ${run.runId} cancel --lease-owner ${run.leaseOwner || ''}`.trim()
      : 'opencode-gateway operator recover'
    const last = run.lastOperatorAction ? ` / last ${run.lastOperatorAction.action}:${run.lastOperatorAction.outcome}` : ''
    return `<tr><td><b>${esc(run.stage || '--')}</b><div class="meta">${esc(shortId(run.runId || '--'))} / ${esc(run.status || '--')}</div></td><td>${esc(run.taskTitle || run.taskId || '--')}<div class="meta">${esc(run.taskId || '--')}</div></td><td><span class="pill ${run.heartbeatFreshness === 'fresh' ? 'good' : run.heartbeatFreshness === 'expired' || run.heartbeatFreshness === 'missing' ? 'bad' : 'warn'}">${esc(run.heartbeatFreshness || 'unknown')}</span><div class="meta">${esc(shortId(run.leaseOwner || 'missing'))}${last}</div></td><td>${renderCommand(command)}<div class="meta">${run.restartable ? 'retry/restart creates new durable dispatch; current OpenCode session is not reused.' : 'Recover stale ownership before mutating.'}</div></td></tr>`
  }).join('')}</tbody></table></div>`
}

function renderOperatorAttention(report: OperatorSafetyReport): string {
  if (!report.attention.items.length) return '<p class="empty good">No operator attention items are open.</p>'
  return `<div class="lane">${report.attention.items.map(item => `<div class="row compact"><span class="dot ${item.kind === 'alert' || item.kind === 'lease' ? 'blocked' : 'pending'}"></span><div><div class="title">${esc(item.title)}</div><div class="meta">${esc(item.summary)} / next: ${esc(item.nextAction)}</div></div><span class="pill ${item.kind === 'alert' || item.kind === 'lease' ? 'bad' : 'warn'}">${esc(item.kind)}</span></div>`).join('')}</div>`
}

function renderOperatorChannels(report: OperatorSafetyReport): string {
  const ready = report.channels.ready.length ? report.channels.ready : ['none']
  const attention = report.channels.needsAttention
  return `<div class="grid-2">${mini('Ready surfaces', ready.map(row => esc(row)).join(', '), true)}${mini('Needs setup', fmtNumber(attention.length))}</div>
    ${attention.length ? `<div class="lane" style="margin-top:10px">${attention.map(row => `<div class="row compact"><div><div class="title">${esc(row.provider)}: ${esc(row.state)}</div><div class="meta">${esc(row.nextAction || 'Open Connect Channels.')}</div></div><span class="pill warn">setup</span></div>`).join('')}</div>` : '<p class="empty good" style="margin-top:10px">No non-deferred channel blockers are open in this report.</p>'}
    <div class="src-note">Provider targets and credential values are intentionally redacted. WhatsApp live parity is shown under Deferred Gates until proof is captured.</div>`
}

function renderOperatorActions(report: OperatorSafetyReport): string {
  return `<div class="lane">${report.actions.map(action => `<div class="row compact"><div><div class="title">${esc(action.description)}</div><div class="meta"><span class="copyable-command">${esc(action.command)}</span></div></div><span class="pill purple">${esc(action.action)}</span></div>`).join('')}</div>`
}

function renderOperatorDeferred(report: OperatorSafetyReport): string {
  return `<div class="lane">${report.channels.deferred.map(gate => `<div class="row compact"><span class="dot pending"></span><div><div class="title">${esc(gate.gate)}</div><div class="meta">${esc(gate.reason)}</div></div><span class="pill warn">deferred</span></div>`).join('')}</div>`
}

function cockpitStatusClass(status: OperationsCockpitStatus): string {
  if (status === 'ready') return 'good'
  if (status === 'blocked' || status === 'unavailable') return 'bad'
  if (status === 'preview') return 'purple'
  if (status === 'unsupported') return 'cyan'
  return 'warn'
}
function operatorStateLabel(state: OperatorSafetyReport['state']): string {
  if (state === 'ready_for_beta') return 'Beta ready'
  if (state === 'paused') return 'Paused'
  if (state === 'blocked') return 'Blocked'
  return 'Attention'
}

function operatorStateClass(state: OperatorSafetyReport['state']): string {
  if (state === 'ready_for_beta') return 'good'
  if (state === 'blocked') return 'bad'
  return 'warn'
}

export { renderOperator }
