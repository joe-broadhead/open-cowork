import { cloudWebAdminSurfaceForRoute } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE, type CloudWebRoute, type CloudWebRouteGroup, type CloudWebRouteId } from './app-shell.ts'
import { escapeHtml } from './html-utils.ts'
import { cloudWebWorkbenchParityForRoute, type CloudWebWorkbenchParityAvailability } from './workbench-parity.ts'

// Inline-SVG nav glyphs. The cloud nav is a string SSR template (no React on the
// shell chrome), so we can't mount the shared `<Icon>` here. Instead each route
// maps to the SAME shared icon desktop's Sidebar uses for the equivalent view and
// we inline the EXACT lucide path data from that icon's entry in
// `@open-cowork/ui` `Icon.tsx`. `navIconSvg` reproduces lucide's SVG wrapper
// attributes (viewBox/fill/stroke + round caps) and the shared Icon stroke rung
// for size 16 (1.75), so these read identically to the desktop glyphs.
const ROUTE_NAV_ICON_NODES: Record<CloudWebRouteId, string> = {
  // chat -> Home (house)
  chat: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  // threads (Projects) -> folder
  threads: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  // knowledge -> book-open
  knowledge: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  // approvals -> circle-help (circle-question-mark)
  approvals: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  // agents (Team) -> users
  agents: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  // capabilities (Tools & Skills) -> blocks
  capabilities: '<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/>',
  // workflows (Playbooks) -> workflow
  workflows: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  // channels -> activity
  channels: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  // artifacts -> file
  artifacts: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  // settings -> settings-2
  settings: '<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  // org -> briefcase (briefcase-business)
  org: '<path d="M12 12h.01"/><path d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M22 13a18.15 18.15 0 0 1-20 0"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  // members -> user-round-check
  members: '<path d="M2 21a8 8 0 0 1 13.292-6"/><circle cx="10" cy="8" r="5"/><path d="m16 19 2 2 4-4"/>',
  // policy (Profiles & Policy) -> shield-check
  policy: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  // byok (bring your own key / credentials) -> wrench
  byok: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
  // connections -> network
  connections: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  // billing -> badge-check (plan/account status; no money glyph in the shared set)
  billing: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  // gateway -> radio (relay/broadcast)
  gateway: '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
  // audit -> list-checks
  audit: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
  // usage -> gauge
  usage: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  // diagnostics -> heart-pulse (matches desktop Sidebar diagnostics)
  diagnostics: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
}

// Reproduces lucide's SVG wrapper (matching `@open-cowork/ui` Icon.tsx output):
// 24-unit viewBox, no fill, currentColor stroke with round caps/joins, and the
// shared Icon stroke rung for the requested size (16->1.75, 20->1.5). The `nodes`
// are static, already-valid markup copied verbatim from the shared icon set, so
// they are not re-escaped. Used for the SSR nav rail and the launchpad shell.
function lucideSvg(nodes: string, size: 16 | 20) {
  const strokeWidth = size <= 16 ? '1.75' : '1.5'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${nodes}</svg>`
}

function navIconSvg(routeId: CloudWebRouteId) {
  return lucideSvg(ROUTE_NAV_ICON_NODES[routeId], 16)
}

// Launchpad shell glyphs (the pre-hydration SSR markup mirrored by
// `react-workbench-launchpad.tsx`). Each uses the same shared lucide icon the
// React launchpad renders, so the static shell and the hydrated portal match.
const LAUNCHPAD_ICON_NODES = {
  // kanban (in-progress / "Plan a release" suggestion)
  kanban: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  // file-diff ("Review a change")
  'file-diff': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/>',
  // workflow ("Create a workflow")
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  // search ("Investigate an issue")
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  // bell (waiting on you)
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  // file (fresh artifacts)
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
} as const

function launchpadIconSvg(name: keyof typeof LAUNCHPAD_ICON_NODES, size: 16 | 20) {
  return lucideSvg(LAUNCHPAD_ICON_NODES[name], size)
}

// Composer control glyphs for the pre-hydration SSR shell (mirrored by the
// React `CloudComposerPortal`, which mounts the shared `<Icon>` for the same
// names). Path data copied verbatim from the shared icon set.
const COMPOSER_ICON_NODES = {
  paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
} as const

// SSR composer icon (size 16, matching the React composer's `<Icon size={16}>`).
export function composerIconSvg(name: keyof typeof COMPOSER_ICON_NODES) {
  return lucideSvg(COMPOSER_ICON_NODES[name], 16)
}

// The same composer glyph as a parsed DOM node, for the controller's imperative
// signed-out fallback composer (so it matches the SSR + React composers). The
// markup is static and always yields one <svg>, so the cast is safe.
export function composerIconElement(name: keyof typeof COMPOSER_ICON_NODES): Element {
  const template = document.createElement('template')
  template.innerHTML = composerIconSvg(name)
  return template.content.firstElementChild as Element
}

function routeNavMarkup(route: CloudWebRoute) {
  const authClass = route.requiresAuth ? ' signed-in-only' : ''
  const adminClass = route.requiresAdmin ? ' admin-route' : ''
  const alertBadge = route.id === 'approvals'
    ? '<span class="nav-alert-count" id="approvals-alert-count" aria-live="polite"></span>'
    : ''
  const label = escapeHtml(route.label)
  return `<a href="#${escapeHtml(route.id)}" data-route-link="${escapeHtml(route.id)}" data-route-surface="${escapeHtml(route.surface)}" data-requires-auth="${route.requiresAuth ? 'true' : 'false'}" data-requires-admin="${route.requiresAdmin ? 'true' : 'false'}" aria-label="${label}" title="${label}" class="${authClass.trim()}${adminClass}"><span class="nav-icon" aria-hidden="true">${navIconSvg(route.id)}</span><span class="nav-label">${label}</span>${alertBadge}</a>`
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

// A literal `.studio-page-header` matching what the shared `StudioPageHeader`
// React primitive emits (StudioPrimitives.tsx): an accent eyebrow Badge, an
// `h1` title with a one-line `p` description, an optional `__meta` row, and a
// `.studio-actions` toolbar. The cloud markup layer is a string SSR template, so
// we emit the same class structure here — the shared `.studio-page-header`,
// `.ui-badge--accent`, `.ui-button*`, and `.studio-actions` CSS (single-sourced
// in @open-cowork/ui and embedded on the website) styles it identically to
// desktop. `actionsMarkup`/`metaMarkup` accept already-escaped markup so callers
// can place existing controls (filters, refresh buttons) into the header slots
// without re-escaping; `title`/`eyebrow`/`description` are escaped here.
export function cloudStudioPageHeaderMarkup(options: {
  eyebrow: string
  title: string
  description: string
  metaMarkup?: string
  actionsMarkup?: string
}) {
  const meta = options.metaMarkup
    ? `<div class="studio-page-header__meta">${options.metaMarkup}</div>`
    : ''
  const actions = options.actionsMarkup
    ? `<div class="studio-actions" role="toolbar" aria-label="Studio actions">${options.actionsMarkup}</div>`
    : ''
  return `<header class="studio-page-header">
            <div class="studio-page-header__copy">
              <span class="ui-badge ui-badge--accent">${escapeHtml(options.eyebrow)}</span>
              <div>
                <h1>${escapeHtml(options.title)}</h1>
                <p>${escapeHtml(options.description)}</p>
              </div>
              ${meta}
            </div>
            ${actions}
          </header>`
}

// A header action button matching the shared `Button` primitive markup
// (Button.tsx wraps the label in a `<span>` so the `.ui-button` flex/gap rules
// apply). Defaults to the secondary variant like `StudioActions`. `attrs` carries
// the existing id / data-*-control wiring the React controllers bind to, so the
// handlers and disabled-state plumbing are preserved untouched.
export function cloudStudioHeaderButtonMarkup(options: {
  label: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  attrs?: string
}) {
  const variant = options.variant || 'secondary'
  const attrs = options.attrs ? ` ${options.attrs}` : ''
  return `<button type="button" class="ui-button ui-button--${variant} ui-button--sm"${attrs}><span>${escapeHtml(options.label)}</span></button>`
}

// A header-hosted filter field. The cloud filter controls are wired by element id
// (e.g. `#channel-filter`), so the input keeps its id + data-*-control attrs while
// the label adopts the studio header label class so it sits cleanly in the actions
// row alongside the buttons.
export function cloudStudioHeaderFilterMarkup(options: {
  inputId: string
  label: string
  placeholder: string
  controlAttr: string
}) {
  return `<label class="studio-page-header__filter"><span>${escapeHtml(options.label)}</span><input id="${escapeHtml(options.inputId)}" autocomplete="off" placeholder="${escapeHtml(options.placeholder)}" ${options.controlAttr}></label>`
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
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" data-tone="accent" aria-hidden="true">${launchpadIconSvg('kanban', 20)}</span><span class="cloud-launchpad-suggestion__text"><strong>Plan a release</strong><span>Draft a release plan for the next milestone.</span><small>@plan can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" data-tone="green" aria-hidden="true">${launchpadIconSvg('file-diff', 20)}</span><span class="cloud-launchpad-suggestion__text"><strong>Review a change</strong><span>Review the recent changes and call out production risks.</span><small>@build can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" data-tone="amber" aria-hidden="true">${launchpadIconSvg('workflow', 20)}</span><span class="cloud-launchpad-suggestion__text"><strong>Create a workflow</strong><span>Help me turn a repeated task into a saved workflow.</span><small>@chief-of-staff can take this</small></span></button>
                  <button class="cloud-launchpad-suggestion" type="button" disabled><span class="cloud-launchpad-suggestion__icon" data-tone="info" aria-hidden="true">${launchpadIconSvg('search', 20)}</span><span class="cloud-launchpad-suggestion__text"><strong>Investigate an issue</strong><span>Trace this bug from symptoms to a concrete fix.</span><small>@build can take this</small></span></button>
                </div>
                <section class="cloud-launchpad-motion" aria-busy="true">
                  <div class="cloud-launchpad-motion__head"><span>In motion</span><span aria-hidden="true"></span><span class="pill">Loading</span></div>
                  <div class="cloud-launchpad-motion-grid">
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span class="cloud-launchpad-motion-col__icon" data-tone="accent" aria-hidden="true">${launchpadIconSvg('kanban', 16)}</span> In progress</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No active tasks yet.</div></div></div>
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span class="cloud-launchpad-motion-col__icon" data-tone="amber" aria-hidden="true">${launchpadIconSvg('bell', 16)}</span> Waiting on you</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No approvals or questions waiting.</div></div></div>
                    <div class="cloud-launchpad-motion-col"><div class="cloud-launchpad-motion-col__head"><span><span class="cloud-launchpad-motion-col__icon" data-tone="info" aria-hidden="true">${launchpadIconSvg('file', 16)}</span> Fresh artifacts</span><span class="pill">0</span></div><div class="cloud-launchpad-motion-list"><div class="cloud-launchpad-motion-empty">No new artifacts yet.</div></div></div>
                  </div>
                </section>
                <button class="cloud-launchpad-team-strip" type="button" disabled><span>Your team</span><span class="cloud-launchpad-team-strip__avatars" aria-hidden="true"><span>B</span><span>P</span><span>CS</span></span><span>3 coworkers · manage</span></button>
              </div>`
}

const WORKFLOW_SCHEDULE_WEEKDAYS: ReadonlyArray<{ value: number, label: string }> = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
]

// The configurable schedule controls for the playbook-create form (frequency,
// time, and the weekly day). Extracted from render.ts to keep its SSR template
// within the module budget; `workflowTriggersFromForm` reads these on submit and
// resolves the viewer's own timezone (replacing the former hard-coded daily/09:00/UTC).
export function cloudWorkflowScheduleFieldsMarkup() {
  const days = WORKFLOW_SCHEDULE_WEEKDAYS.map((day) => `<option value="${day.value}">${day.label}</option>`).join('')
  return `<label><span>Schedule frequency</span><select name="scheduleFrequency" data-workflow-control="true"><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>`
    + `<label><span>Schedule time</span><input type="time" name="scheduleTime" value="09:00" data-workflow-control="true"></label>`
    + `<label><span>Schedule day (weekly)</span><select name="scheduleDayOfWeek" data-workflow-control="true">${days}</select></label>`
}
