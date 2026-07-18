import { html, trustedHtml } from '../html.js'
import { shortId, fmtNumber, formatDateTime } from '../format.js'
import { card, headFig, mini, stackedBar } from '../components.js'
import { renderArtifactLinks } from './shared.js'
import type { DashboardView } from '../types.js'

function renderEnvironments(view: DashboardView): string {
  const stateCounts = environmentStateCounts(view.environments)
  return `<section class="view" data-view="environments">
    <div class="view-head"><div><h1 class="page-h">Execution Environments</h1><p class="page-sub">Gateway-owned environment leases and cleanup state. OpenCode Sessions remain separate and are shown only as linked run context.</p></div><div class="head-figs">
      ${headFig(String(view.counts.environments), 'active')}${headFig(String(view.counts.retainedEnvironments), 'retained')}${headFig(String(view.counts.cleanupFailedEnvironments), 'cleanup failed')}
    </div></div>
    <div class="grid-2">
      ${card('Lifecycle State', 'E', `<span class="pill ${view.counts.cleanupFailedEnvironments ? 'bad' : view.counts.retainedEnvironments ? 'warn' : 'good'}">${view.environments.length} tracked</span>`, stackedBar([
        { label: 'Active', value: view.counts.environments, color: 'var(--cyan)' },
        { label: 'Retained', value: view.counts.retainedEnvironments, color: 'var(--orange)' },
        { label: 'Cleanup failed', value: view.counts.cleanupFailedEnvironments, color: 'var(--red)' },
        { label: 'Released', value: stateCounts['released'] ?? 0, color: 'var(--green)' },
      ]))}
      ${card('Cleanup Queue', 'C', `<span class="pill ${stateCounts['failed'] ? 'bad' : stateCounts['retained'] ? 'warn' : 'good'}">${stateCounts['pending']} pending</span>`, renderEnvironmentCleanup(view.environments, stateCounts))}
    </div>
    ${card('Environment Inventory', 'I', `<span class="pill">${view.environments.length} records</span>`, renderEnvironmentInventory(view.environments))}
  </section>`
}
function renderEnvironmentCleanup(environments: any[], counts: Record<string, number>): string {
  const failed = environments.filter(environment => environment.status === 'cleanup_failed' || environment.cleanup?.state === 'failed').slice(0, 5)
  const retained = environments.filter(environment => environment.status === 'retained' || environment.cleanup?.state === 'retained').slice(0, 5)
  const rows = [...failed, ...retained].slice(0, 6)
  const summary = `<div class="grid-3">${mini('Pending', fmtNumber(counts['pending'] || 0))}${mini('Retained', fmtNumber(counts['retained'] || 0))}${mini('Failed', fmtNumber(counts['failed'] || 0))}</div>`
  if (!rows.length) return `${summary}<p class="empty good" style="margin-top:10px">No retained or cleanup-failed environments need operator follow-up.</p>`
  return `${summary}<div class="lane" style="margin-top:10px">${rows.map(renderEnvironmentRow).join('')}</div>`
}

function renderEnvironmentInventory(environments: any[]): string {
  const rows = environments.slice().sort((a, b) => Date.parse(b.updatedAt || b.startedAt || '') - Date.parse(a.updatedAt || a.startedAt || '')).slice(0, 50)
  if (!rows.length) return '<p class="empty good">No environment-backed runs have been recorded yet.</p>'
  return html`<div class="table-wrap"><table class="table"><thead><tr><th>Environment</th><th>Backend</th><th>Run</th><th>Task</th><th>Status</th><th>Runtime</th><th>Cleanup</th><th>Lease</th><th>Artifacts</th><th>Updated</th></tr></thead><tbody>${rows.map(environment => {
    const backend = environment.backend ? `${environment.backend}${environment.runtime ? `/${environment.runtime}` : ''}` : '?'
    const lease = environment.leaseId || environment.runEnvironmentId || environment.provider || environment.imageDigest || '--'
    const title = environment.taskTitle || environment.taskId || environment.runId
    const runtime = environment.runtimeProfile
    const runtimeText = runtime ? `${runtime.filesystem?.policy || '?'} / ${runtime.network?.mode || '?'} / ${runtime.cwd?.redacted || '?'}` : '--'
    const runtimeClass = runtime?.validation?.ok === false ? 'bad' : runtime ? 'purple' : ''
    return html`<tr><td class="name">${environment.name || environment.id || '?'}</td><td>${backend}</td><td>${shortId(environment.runId)} / ${environment.stage || '?'}</td><td>${shortId(title)}</td><td><span class="pill ${environmentStatusClass(environment.status)}">${environment.status || '?'}</span></td><td><span class="pill ${runtimeClass}">${runtimeText}</span></td><td>${environment.cleanup?.state || '?'}</td><td>${shortId(lease)}</td><td>${trustedHtml(renderArtifactLinks(environment.artifacts))}</td><td>${environment.updatedAt ? formatDateTime(environment.updatedAt) : '--'}</td></tr>`
  })}</tbody></table></div><div class="src-note">source: Gateway run.environment and run.runtimeProfile snapshots. Secret-like metadata and local paths are redacted before rendering.</div>`.value
}
function renderEnvironmentRow(environment: any): string {
  const status = environment.status || environment.cleanup?.state || '?'
  const expires = environment.expiresAt ? ` / expires ${formatDateTime(environment.expiresAt)}` : ''
  const lease = environment.leaseId || environment.runEnvironmentId ? ` / lease ${environment.leaseId || environment.runEnvironmentId}` : ''
  return html`<div class="row compact"><span class="dot ${environmentStatusDot(status)}"></span><div><div class="title">${environment.name || environment.id || 'environment'} on ${environment.backend || '?'}</div><div class="meta">run ${shortId(environment.runId)} / ${environment.stage || '?'} / cleanup ${environment.cleanup?.state || '?'}${lease}${expires}</div></div><span class="pill ${environmentStatusClass(status)}">${status}</span></div>`.value
}

function environmentStateCounts(environments: any[]): Record<string, number> {
  const counts = { pending: 0, retained: 0, failed: 0, released: 0 }
  for (const environment of environments) {
    const state = environment.cleanup?.state || environment.status
    if (state === 'retained') counts['retained'] += 1
    else if (state === 'failed' || environment.status === 'cleanup_failed') counts['failed'] += 1
    else if (state === 'released' || environment.status === 'released') counts['released'] += 1
    else counts['pending'] += 1
  }
  return counts
}

function environmentStatusClass(status: string): string {
  if (status === 'cleanup_failed' || status === 'failed' || status === 'blocked') return 'bad'
  if (status === 'retained' || status === 'prepared') return 'warn'
  return 'good'
}

function environmentStatusDot(status: string): string {
  if (status === 'cleanup_failed' || status === 'failed' || status === 'blocked') return 'blocked'
  if (status === 'retained' || status === 'prepared') return 'pending'
  return 'done'
}

export { renderEnvironments }
