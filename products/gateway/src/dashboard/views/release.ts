import { esc, escAttr } from '../html.js'
import { card, statTile } from '../components.js'
import type { DashboardView } from '../types.js'

function renderReleaseClaims(view: DashboardView): string {
  const registry = view.releaseCockpit
  const stateClass = (state: string): string => state === 'allowed' ? 'good' : state === 'deferred' ? 'warn' : 'bad'
  const rows = registry.claims.map(claim => {
    const blocked = claim.state !== 'allowed' ? `<div class="meta">${esc(claim.blockedWording)}</div>` : ''
    return `<tr data-testid="release-claim-${escAttr(claim.id)}"><td class="name">${esc(claim.id.replace(/_/g, ' '))}<div class="meta">${esc(claim.id)}</div></td><td><span class="pill ${stateClass(claim.state)}">${esc(claim.state)}</span></td><td>${esc(claim.allowedWording)}${blocked}</td><td>${esc(claim.safeNextAction)}</td></tr>`
  }).join('')
  const issues = registry.issues.length
    ? `<div class="lane">${registry.issues.map(issue => `<div class="row compact"><div><div class="title">${esc(issue.code)}</div><div class="meta">${esc(issue.summary)}</div></div><span class="pill bad">fail</span></div>`).join('')}</div>`
    : ''
  return `<section class="view" data-view="release-cockpit" data-testid="release-claims">
    <div class="view-head"><h2>Release Claims</h2><div class="meta">${esc(registry.decision)}</div></div>
    <div class="grid-3">
      ${statTile('Claim registry', registry.status, esc(registry.status === 'pass' ? 'Boundary intact' : 'Registry invariants failing'), 'release-cockpit', registry.status === 'pass' ? 'good' : 'bad')}
      ${statTile('Allowed', String(registry.claims.filter(claim => claim.state === 'allowed').length), 'claims usable in public copy', 'release-cockpit', 'good')}
      ${statTile('Blocked / deferred', String(registry.claims.filter(claim => claim.state !== 'allowed').length), 'claims requiring evidence first', 'release-cockpit', 'warn')}
    </div>
    ${card('Claim Boundary', 'registry', `<span class="pill ${registry.status === 'pass' ? 'good' : 'bad'}">${esc(registry.status)}</span>`, `<table class="table"><thead><tr><th>Claim</th><th>State</th><th>Boundary</th><th>Safe next action</th></tr></thead><tbody>${rows}</tbody></table>`)}
    ${issues}
  </section>`
}

export { renderReleaseClaims }
