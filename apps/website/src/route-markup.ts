import { cloudWebAdminSurfaceForRoute } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, type CloudWebRoute, type CloudWebRouteId } from './app-shell.ts'
import { escapeHtml } from './html-utils.ts'
import { cloudWebWorkbenchParityForRoute, type CloudWebWorkbenchParityAvailability } from './workbench-parity.ts'

function routeNavMarkup(route: CloudWebRoute) {
  const authClass = route.requiresAuth ? ' signed-in-only' : ''
  const adminClass = route.requiresAdmin ? ' admin-route' : ''
  return `<a href="#${escapeHtml(route.id)}" data-route-link="${escapeHtml(route.id)}" data-route-surface="${escapeHtml(route.surface)}" data-requires-auth="${route.requiresAuth ? 'true' : 'false'}" data-requires-admin="${route.requiresAdmin ? 'true' : 'false'}" class="${authClass.trim()}${adminClass}">${escapeHtml(route.label)}</a>`
}

export function routeGroupsMarkup() {
  return CLOUD_WEB_ROUTE_GROUPS.map((group) => {
    const links = group.routes.map(routeNavMarkup).join('')
    if (group.id === 'admin') {
      return `<details class="nav-group admin-nav" data-admin-nav data-nav-group="${escapeHtml(group.id)}">
          <summary><span>${escapeHtml(group.label)} controls</span></summary>
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
  return `class="${classes.join(' ')}" id="${escapeHtml(routeId)}" data-route-panel="${escapeHtml(routeId)}" data-route-surface="${escapeHtml(route?.surface || 'workbench')}" data-requires-auth="${options.signedIn === false ? 'false' : 'true'}" data-requires-admin="${options.admin ? 'true' : 'false'}"`
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
