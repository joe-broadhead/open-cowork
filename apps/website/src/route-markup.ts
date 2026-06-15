import { cloudWebAdminSurfaceForRoute } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE, type CloudWebRoute, type CloudWebRouteGroup, type CloudWebRouteId } from './app-shell.ts'
import { escapeHtml } from './html-utils.ts'
import { cloudWebWorkbenchParityForRoute, type CloudWebWorkbenchParityAvailability } from './workbench-parity.ts'

const ROUTE_NAV_ICONS: Record<CloudWebRouteId, string> = {
  threads: 'P',
  chat: '+',
  approvals: '?',
  agents: 'T',
  capabilities: '*',
  workflows: 'W',
  channels: 'C',
  artifacts: 'A',
  settings: 'S',
  org: 'O',
  members: 'M',
  policy: 'P',
  byok: 'K',
  connections: 'N',
  billing: '$',
  gateway: 'G',
  audit: 'L',
  usage: 'U',
  diagnostics: 'D',
}

function routeNavMarkup(route: CloudWebRoute) {
  const authClass = route.requiresAuth ? ' signed-in-only' : ''
  const adminClass = route.requiresAdmin ? ' admin-route' : ''
  const alertBadge = route.id === 'approvals'
    ? '<span class="nav-alert-count" id="approvals-alert-count" aria-live="polite"></span>'
    : ''
  const label = escapeHtml(route.label)
  return `<a href="#${escapeHtml(route.id)}" data-route-link="${escapeHtml(route.id)}" data-route-surface="${escapeHtml(route.surface)}" data-requires-auth="${route.requiresAuth ? 'true' : 'false'}" data-requires-admin="${route.requiresAdmin ? 'true' : 'false'}" aria-label="${label}" title="${label}" class="${authClass.trim()}${adminClass}"><span class="nav-icon" data-icon="${escapeHtml(ROUTE_NAV_ICONS[route.id])}" aria-hidden="true"></span><span class="nav-label">${label}</span>${alertBadge}</a>`
}

export function routeGroupsMarkup(groupIds?: Array<CloudWebRouteGroup['id']>) {
  const groups = groupIds
    ? CLOUD_WEB_ROUTE_GROUPS.filter((group) => groupIds.includes(group.id))
    : CLOUD_WEB_ROUTE_GROUPS
  return groups.map((group) => {
    const links = group.routes.map(routeNavMarkup).join('')
    if (group.id === 'admin') {
      const label = `${escapeHtml(group.label)} controls`
      return `<details class="nav-group admin-nav" data-admin-nav data-nav-group="${escapeHtml(group.id)}">
          <summary aria-label="${label}" title="${label}"><span>${label}</span></summary>
          <div class="nav-links">${links}</div>
        </details>`
    }
    if (group.collapsible) {
      const label = escapeHtml(group.label)
      return `<details class="nav-group manage-nav" data-manage-nav data-nav-group="${escapeHtml(group.id)}" open>
          <summary aria-label="${label}" title="${label}"><span>${label}</span><small>Team · Playbooks · Tools</small></summary>
          <div class="nav-links">${links}</div>
        </details>`
    }
    return `<div class="nav-group" data-nav-group="${escapeHtml(group.id)}">
          <div class="nav-heading">${escapeHtml(group.label)}</div>
          <div class="nav-links">${links}</div>
        </div>`
  }).join('\n        ')
}

export function routePanelAttrs(routeId: string, options: { signedIn?: boolean, admin?: boolean } = {}) {
  const classes = ['section']
  if (options.signedIn !== false) classes.push('signed-in-only')
  if (options.admin) classes.push('admin-only-section')
  const route = CLOUD_WEB_ROUTES.find((entry) => entry.id === routeId)
  const hidden = routeId === DEFAULT_CLOUD_WEB_ROUTE ? '' : ' hidden'
  return `class="${classes.join(' ')}" id="${escapeHtml(routeId)}" data-route-panel="${escapeHtml(routeId)}" data-route-surface="${escapeHtml(route?.surface || 'workbench')}" data-requires-auth="${options.signedIn === false ? 'false' : 'true'}" data-requires-admin="${options.admin ? 'true' : 'false'}"${hidden}`
}

const parityAvailabilityLabels: Record<CloudWebWorkbenchParityAvailability, { label: string, kind: string }> = {
  shared: { label: 'Shared with Desktop', kind: 'ok' },
  'cloud-only': { label: 'Cloud-only', kind: 'info' },
  'desktop-only': { label: 'Desktop-only', kind: 'warn' },
  'intentionally-unavailable': { label: 'Unavailable in Cloud', kind: 'warn' },
}

export function routeParityMarkup(routeId: CloudWebRouteId) {
  const entries = cloudWebWorkbenchParityForRoute(routeId)
  if (!entries.length) return ''
  return `<div class="parity-grid" data-parity-route="${escapeHtml(routeId)}" aria-label="Desktop and Cloud Web parity for ${escapeHtml(routeId)}">
            ${entries.map((entry) => {
              const availability = parityAvailabilityLabels[entry.availability]
              const reason = entry.disabledReason ? `<small>${escapeHtml(entry.disabledReason)}</small>` : ''
              return `<article class="parity-card" data-parity-concept="${escapeHtml(entry.conceptId)}" data-parity-availability="${escapeHtml(entry.availability)}">
                <div class="runtime-card-header">
                  <span class="pill" data-kind="${escapeHtml(availability.kind)}">${escapeHtml(availability.label)}</span>
                  <strong>${escapeHtml(entry.label)}</strong>
                </div>
                <p>${escapeHtml(entry.cloudAffordance)}</p>
                <small>${escapeHtml(entry.boundary)}</small>
                ${reason}
              </article>`
            }).join('')}
          </div>`
}

export function routeAdminSurfaceMarkup(routeId: CloudWebRouteId) {
  const entry = cloudWebAdminSurfaceForRoute(routeId)
  if (!entry) return ''
  return `<div class="surface-grid" data-admin-surface-route="${escapeHtml(routeId)}" aria-label="Cloud Web admin surface contract for ${escapeHtml(routeId)}">
            <article class="surface-card">
              <div class="runtime-card-header">
                <span class="pill" data-kind="info">Admin surface</span>
                <strong>${escapeHtml(entry.label)}</strong>
              </div>
              <p>${escapeHtml(entry.cloudAffordance)}</p>
              <small>${escapeHtml(entry.sensitiveBoundary)}</small>
              <small>${escapeHtml(entry.disabledReason)}</small>
            </article>
          </div>`
}

export function cloudLaunchpadStaticMarkup() {
  return `<div class="cloud-launchpad-home signed-in-only" id="cloud-launchpad-home" aria-label="Home launchpad">
                <div class="cloud-launchpad-suggestions" aria-label="Task suggestions">
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" aria-hidden="true">-&gt;</span><span class="cloud-launchpad-suggestion__text"><strong>Plan a release</strong><span>Draft a release plan for the next milestone.</span><small>@plan can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" aria-hidden="true">~</span><span class="cloud-launchpad-suggestion__text"><strong>Review a change</strong><span>Review the recent changes and call out production risks.</span><small>@build can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" aria-hidden="true">*</span><span class="cloud-launchpad-suggestion__text"><strong>Create a workflow</strong><span>Help me turn a repeated task into a saved workflow.</span><small>@chief-of-staff can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" aria-hidden="true">?</span><span class="cloud-launchpad-suggestion__text"><strong>Investigate an issue</strong><span>Trace this bug from symptoms to a concrete fix.</span><small>@build can take this</small></span></button>
                </div>
                <section class="cloud-launchpad-motion" aria-busy="true">
                  <div class="cloud-launchpad-motion__head"><span>In motion</span><span aria-hidden="true"></span><span class="pill">Loading</span></div>
                  <div class="cloud-launchpad-motion-grid">
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span aria-hidden="true">P</span> In progress</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No active tasks yet.</div></div></div>
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span aria-hidden="true">!</span> Waiting on you</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No approvals or questions waiting.</div></div></div>
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span aria-hidden="true">A</span> Fresh artifacts</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No new artifacts yet.</div></div></div>
                  </div>
                </section>
                <button class="cloud-launchpad-team-strip" type="button" disabled><span>Your team</span><span class="cloud-launchpad-team-strip__avatars" aria-hidden="true"><span>B</span><span>P</span><span>CS</span></span><span>3 coworkers · manage</span></button>
              </div>`
}
