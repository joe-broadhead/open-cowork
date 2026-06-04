import { canManageOrg, type WebsiteRole } from './roles.ts'
import { CLOUD_WEB_ADMIN_SURFACE_MATRIX, cloudWebAdminSurfaceForRoute } from './admin-surface-matrix.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE, type CloudWebRoute, type CloudWebRouteId } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import { DEFAULT_WEBSITE_PUBLIC_BRANDING, brandLinksMarkup, brandLogoMarkup, resolvePublicBranding } from './branding.ts'
import { cloudWebsiteClientScript } from './client-script.ts'
import { escapeHtml, jsonScript } from './html-utils.ts'
import { cloudWebsiteStyles } from './styles.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { CLOUD_WEB_WORKBENCH_PARITY_MATRIX, cloudWebWorkbenchParityForRoute, type CloudWebWorkbenchParityAvailability } from './workbench-parity.ts'
import { CLOUD_SESSION_EVENT_TYPES, type PublicBrandingConfig } from '@open-cowork/shared'

export { cloudWebsiteClientScript } from './client-script.ts'

export type WebsiteBootstrapPolicy = {
  role: string
  profileName: string
  features: Record<string, boolean>
  publicBranding?: PublicBrandingConfig | null
}

function routeNavMarkup(route: CloudWebRoute) {
  const authClass = route.requiresAuth ? ' signed-in-only' : ''
  const adminClass = route.requiresAdmin ? ' admin-route' : ''
  return `<a href="#${escapeHtml(route.id)}" data-route-link="${escapeHtml(route.id)}" data-route-surface="${escapeHtml(route.surface)}" data-requires-auth="${route.requiresAuth ? 'true' : 'false'}" data-requires-admin="${route.requiresAdmin ? 'true' : 'false'}" class="${authClass.trim()}${adminClass}">${escapeHtml(route.label)}</a>`
}

function routeGroupsMarkup() {
  return CLOUD_WEB_ROUTE_GROUPS.map((group) => `<div class="nav-group" data-nav-group="${escapeHtml(group.id)}">
          <div class="nav-heading">${escapeHtml(group.label)}</div>
          <div class="nav-links">${group.routes.map(routeNavMarkup).join('')}</div>
        </div>`).join('\n        ')
}

function routePanelAttrs(routeId: string, options: { signedIn?: boolean, admin?: boolean } = {}) {
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

function routeParityMarkup(routeId: CloudWebRouteId) {
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

function routeAdminSurfaceMarkup(routeId: CloudWebRouteId) {
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

export function cloudWebsiteHtml(policy: WebsiteBootstrapPolicy, publicBranding?: PublicBrandingConfig | null, cspNonce = '') {
  const branding = resolvePublicBranding(publicBranding || policy.publicBranding)
  const copy = branding.dashboard || DEFAULT_WEBSITE_PUBLIC_BRANDING.dashboard || {}
  const labels = branding.managedOrgConnectionLabels || DEFAULT_WEBSITE_PUBLIC_BRANDING.managedOrgConnectionLabels || {}
  const bootstrap: CloudWebClientBootstrap = {
    role: policy.role,
    profileName: policy.profileName,
    features: policy.features,
    publicBranding: branding,
    routes: CLOUD_WEB_ROUTES,
    defaultRoute: DEFAULT_CLOUD_WEB_ROUTE,
    api: CLOUD_WEB_CLIENT_ENDPOINTS,
    routeMatrix: CLOUD_WEB_ROUTE_API_MATRIX,
    adminSurfaces: CLOUD_WEB_ADMIN_SURFACE_MATRIX,
    workbenchParity: CLOUD_WEB_WORKBENCH_PARITY_MATRIX,
    sessionEventTypes: [...CLOUD_SESSION_EVENT_TYPES],
  }
  const adminDefault = canManageOrg(policy.role as WebsiteRole)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(branding.productName)}</title>
  <style${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''}>
${cloudWebsiteStyles(branding)}
  </style>
</head>
<body data-auth="loading">
  <div class="shell">
    <aside class="nav">
      <div class="brand">
        ${brandLogoMarkup(branding)}
        <div>
          <div class="brand-title">${escapeHtml(branding.productName)}</div>
          <div class="meta" id="profile-name">${escapeHtml(policy.profileName)}</div>
        </div>
      </div>
      <nav class="nav-sections" aria-label="Cloud Web sections">
        ${routeGroupsMarkup()}
      </nav>
      <div>
        <div class="meta">Role</div>
        <strong id="role-name">${adminDefault ? 'admin' : 'member'}</strong>
      </div>
      ${brandLinksMarkup(branding)}
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <h1 id="org-name">${escapeHtml(branding.productName)}</h1>
          <div class="meta" id="org-meta">Loading workspace</div>
        </div>
        <div class="topbar-actions">
          <span class="status" id="status" data-kind="warn">Loading</span>
          <button id="refresh" type="button">Refresh</button>
          <button id="signin" class="primary signed-out-only" type="button">Sign in</button>
          <button id="logout" class="signed-in-only" type="button">Sign out</button>
        </div>
      </header>
      <div class="content">
        <p class="notice" id="admin-notice" hidden>Admin actions are disabled for this role. Ask an org owner or admin to manage keys, tokens, billing, and channel setup.</p>

        <section ${routePanelAttrs('threads')}>
          <div class="section-header">
            <div>
              <h2>Threads</h2>
              <div class="meta">Cloud workspace threads</div>
            </div>
            <button class="primary" id="new-thread-shortcut" type="button" data-chat-control="true">New thread</button>
          </div>
          <div class="workbench-split">
            ${routeParityMarkup('threads')}
            <div class="panel">
              <div class="toolbar" aria-label="Thread filters">
                <label><span>Search</span><input id="thread-query" autocomplete="off" placeholder="title, profile, project, tag"></label>
                <label><span>Status</span><select id="thread-status">
                  <option value="all">All</option>
                  <option value="running">Running</option>
                  <option value="approval">Awaiting approval</option>
                  <option value="question">Awaiting answer</option>
                  <option value="idle">Idle</option>
                  <option value="errored">Error</option>
                  <option value="closed">Closed</option>
                </select></label>
                <label><span>Profile</span><input id="thread-profile" autocomplete="off" placeholder="${escapeHtml(policy.profileName)}"></label>
                <label><span>Project</span><select id="thread-project">
                  <option value="all">All</option>
                  <option value="chat">Chat-only</option>
                  <option value="git">Git</option>
                  <option value="snapshot">Uploaded snapshot</option>
                </select></label>
                <label><span>Tag/filter</span><input id="thread-tag" autocomplete="off" placeholder="tag or smart filter"></label>
                <button id="refresh-threads" type="button">Refresh</button>
              </div>
              <div class="table-shell" role="table" aria-label="Cloud threads">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Thread</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Project</span>
                  <span role="columnheader">Updated</span>
                </div>
                <div id="thread-list"></div>
              </div>
              <div class="section-header">
                <div class="meta"><span id="thread-count">0</span> thread(s). <span id="thread-limit-status">No threads loaded</span>.</div>
                <button id="thread-load-more" type="button" hidden>Load more</button>
              </div>
            </div>
            <form class="panel" id="session-form">
              <h3>Create cloud thread</h3>
              <div class="form-grid">
                <label><span>Profile</span><input name="profileName" autocomplete="off" value="${escapeHtml(policy.profileName)}" data-chat-control="true"></label>
                <label><span>Git repository URL</span><input name="repositoryUrl" autocomplete="off" placeholder="https://github.com/org/repo.git" data-chat-control="true"></label>
                <label><span>Ref</span><input name="ref" autocomplete="off" placeholder="main" data-chat-control="true"></label>
                <label><span>Subdirectory</span><input name="subdirectory" autocomplete="off" placeholder="optional" data-chat-control="true"></label>
                <label class="span"><span>Credential ref</span><input name="credentialRef" autocomplete="off" placeholder="secret://git/github-readonly" data-chat-control="true"></label>
                <label><span>Snapshot title</span><input name="snapshotTitle" autocomplete="off" placeholder="Browser upload" data-chat-control="true"></label>
                <label><span>Uploaded snapshot</span><input name="snapshotFiles" type="file" multiple webkitdirectory data-chat-control="true"></label>
                <button class="primary span" type="submit" data-chat-control="true">Create thread</button>
              </div>
              <p class="empty">Cloud policy validates git and uploaded snapshot sources before execution. Local desktop paths and local MCP details are not uploaded implicitly.</p>
            </form>
          </div>
        </section>

        <section ${routePanelAttrs('chat')}>
          <div class="section-header">
            <div>
              <h2>Chat</h2>
              <div class="meta">Selected cloud session</div>
            </div>
            <span class="pill" data-kind="${policy.features.chat ? 'ok' : 'warn'}">${policy.features.chat ? 'enabled' : 'disabled'}</span>
          </div>
          <div class="workbench-split">
            ${routeParityMarkup('chat')}
            <div class="panel chat-shell">
              <div class="section-header">
                <div>
                  <h3 id="chat-session-title">No thread selected</h3>
                  <div class="meta" id="chat-session-meta">Select a cloud thread</div>
                </div>
                <span class="pill" id="chat-event-status">idle</span>
              </div>
              <div class="timeline" id="chat-timeline" aria-live="polite">
                <p class="empty">No thread selected.</p>
              </div>
            </div>
            <form class="panel" id="prompt-form">
              <h3>Composer</h3>
              <label class="span"><span>Message</span><textarea name="text" disabled placeholder="Select a cloud thread"></textarea></label>
              <label><span>Agent</span><input name="agent" autocomplete="off" placeholder="optional agent override" disabled></label>
              <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Policy</strong><span>${policy.features.chat ? 'chat enabled' : 'chat disabled'}</span></div>
              <button class="primary" type="submit" disabled>Send</button>
            </form>
          </div>
        </section>

        <section ${routePanelAttrs('agents')}>
          <div class="section-header">
            <div>
              <h2>Agents</h2>
              <div class="meta">Profile-allowed execution choices</div>
            </div>
            <button id="refresh-capabilities" type="button" data-capability-control="true">Refresh</button>
          </div>
          <div class="grid">
            ${routeParityMarkup('agents')}
            <div class="panel">
              <h3>Available agents</h3>
              <div class="list" id="workbench-agent-list">
                <p class="empty">No agents loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy</h3>
              <div class="list" id="agent-policy-list">
                <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
                <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('capabilities')}>
          <div class="section-header">
            <div>
              <h2>Tools & Skills</h2>
              <div class="meta">Capability policy verdicts</div>
            </div>
            <label><span>Filter</span><input id="capability-filter" autocomplete="off" placeholder="tool, skill, agent, source" data-capability-control="true"></label>
          </div>
          <div class="grid">
            ${routeParityMarkup('capabilities')}
            <div class="panel">
              <h3>Tools</h3>
              <div class="list" id="tool-list">
                <p class="empty">No tools loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Skills and MCPs</h3>
              <div class="list" id="skill-list">
                <p class="empty">No skills loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy notes</h3>
              <div class="list" id="capability-policy-note">
                <p class="empty">Cloud-safe capability metadata loads after sign-in.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('workflows')}>
          <div class="section-header">
            <div>
              <h2>Workflows</h2>
              <div class="meta">Definitions and runs</div>
            </div>
            <div class="row-actions">
              <label><span>Filter</span><input id="workflow-filter" autocomplete="off" placeholder="title, agent, trigger, status" data-workflow-control="true"></label>
              <button id="refresh-workflows" type="button" data-workflow-control="true">Refresh</button>
              <span class="pill" data-kind="${policy.features.workflows ? 'ok' : 'warn'}">${policy.features.workflows ? 'enabled' : 'disabled'}</span>
            </div>
          </div>
          <div class="workbench-split">
            ${routeParityMarkup('workflows')}
            <div class="panel">
              <div class="table-shell" role="table" aria-label="Cloud workflows">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Workflow</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Last run</span>
                  <span role="columnheader">Next run</span>
                </div>
                <div id="workflow-list">
                  <div class="table-row empty-row" role="row">
                    <span role="cell">No workflows loaded.</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                  </div>
                </div>
              </div>
              <h3>Runs</h3>
              <div class="list" id="workflow-run-list">
                <p class="empty">No runs loaded.</p>
              </div>
            </div>
            <div class="panel">
              <form id="workflow-form">
                <h3>Create workflow</h3>
                <div class="form-grid">
                  <label class="span"><span>Title</span><input name="title" autocomplete="off" placeholder="Daily review" data-workflow-control="true"></label>
                  <label><span>Agent</span><input name="agentName" autocomplete="off" placeholder="build" data-workflow-control="true"></label>
                  <label><span>Trigger</span><select name="triggerType" data-workflow-control="true">
                    <option value="manual">Manual</option>
                    <option value="schedule">Daily schedule</option>
                    <option value="webhook">Webhook</option>
                  </select></label>
                  <label><span>Tools</span><input name="toolIds" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label><span>Skills</span><input name="skillNames" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label class="span"><span>Instructions</span><textarea name="instructions" placeholder="What this workflow should do" data-workflow-control="true"></textarea></label>
                  <button class="primary span" type="submit" data-workflow-control="true">Create workflow</button>
                </div>
              </form>
              <h3>Selected workflow</h3>
              <div class="list" id="workflow-detail">
                <p class="empty">Select or create a workflow.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('artifacts')}>
          <div class="section-header">
            <div>
              <h2>Artifacts</h2>
              <div class="meta">Cloud artifact metadata</div>
            </div>
          </div>
          <div class="grid">
            ${routeParityMarkup('artifacts')}
            <div class="panel">
              <h3>Selected thread artifacts</h3>
              <div class="list" id="artifact-list">
                <p class="empty">No artifacts loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Artifact history</h3>
              <div class="list" id="artifact-history">
                <p class="empty">No artifact history loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Inspector</h3>
              <div class="list" id="artifact-detail">
                <p class="empty">Choose Inspect on an artifact to load metadata.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('org', { signedIn: false })}>
          <div class="section-header">
            <div>
              <h2>${escapeHtml(copy.title || 'Workspace')}</h2>
              <div class="meta">${escapeHtml(copy.subtitle || 'Cloud control plane state for this signed-in org.')}</div>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('org')}
          <div class="grid">
            <div class="panel">
              <h3>Profile and policy</h3>
              <div class="row compact"><strong>Profile</strong><span id="profile-summary">${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
              <div class="row compact"><strong>Workflows</strong><span>${policy.features.workflows ? 'enabled' : 'disabled'}</span></div>
            </div>
            <div class="panel signed-out-only">
              <h3>${escapeHtml(copy.signInTitle || 'Sign in')}</h3>
              <p class="empty">${escapeHtml(copy.signInBody || 'Use the configured cloud auth provider to open your org dashboard.')}</p>
              <button id="signin-inline" class="primary" type="button">Sign in</button>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('members', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Members</h2>
              <div class="meta">Roles and invites</div>
            </div>
            <div class="row-actions">
              <label><span>Filter</span><input id="member-filter" autocomplete="off" placeholder="email, role, status" data-admin-control="true"></label>
              <button id="refresh-admin" type="button" data-admin-control="true">Refresh admin</button>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('members')}
          <div class="workbench-split">
            <div class="panel">
              <div class="section-header">
                <h3>Org members</h3>
                <div class="meta"><span id="member-count">0</span> member(s)</div>
              </div>
              <div class="table-shell" role="table" aria-label="Org members">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Member</span>
                  <span role="columnheader">Role</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Actions</span>
                </div>
                <div id="member-list">
                  <div class="table-row empty-row" role="row">
                    <span role="cell">No member records loaded.</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                  </div>
                </div>
              </div>
            </div>
            <form class="panel" id="member-invite-form">
              <h3>Invite member</h3>
              <p class="empty" id="member-invite-notice">Invite availability loads after sign-in.</p>
              <div class="form-grid">
                <label class="span"><span>Email</span><input name="email" type="email" autocomplete="off" placeholder="teammate@example.com" data-admin-control="true"></label>
                <label><span>Role</span><select name="role" data-admin-control="true">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select></label>
                <button class="primary" type="submit" data-admin-control="true">Create invite</button>
              </div>
            </form>
          </div>
        </section>

        <section ${routePanelAttrs('policy')}>
          <div class="section-header">
            <div>
              <h2>Profiles & Policy</h2>
              <div class="meta">Runtime profile and feature flags</div>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('policy')}
          <div class="grid">
            <div class="panel">
              <h3>Runtime profile</h3>
              <div class="list" id="admin-policy-overview">
                <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
                <div class="row compact"><strong>Role</strong><span>${escapeHtml(policy.role)}</span></div>
              </div>
            </div>
            <div class="panel">
              <h3>Features</h3>
              <div class="list" id="admin-policy-features">
                <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
                <div class="row compact"><strong>Workflows</strong><span>${policy.features.workflows ? 'enabled' : 'disabled'}</span></div>
              </div>
            </div>
            <div class="panel">
              <h3>Project sources</h3>
              <div class="list" id="admin-project-policy">
                <p class="empty">Project-source policy loads after sign-in.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Runtime and gateway</h3>
              <div class="list" id="admin-runtime-policy">
                <p class="empty">Runtime policy loads after sign-in.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Worker health</h3>
              <div class="list" id="admin-worker-summary">
                <p class="empty">Worker summaries load after sign-in.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('byok', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>BYOK</h2>
              <div class="meta">${escapeHtml(copy.byokDescription || 'Provider keys are write-only. The dashboard stores status metadata only.')}</div>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('byok')}
          <div class="grid">
            <form class="panel" id="byok-form">
              <h3>Add or rotate key</h3>
              <div class="form-grid">
                <label><span>Provider</span><input name="providerId" autocomplete="off" placeholder="anthropic" data-admin-control="true"></label>
                <label><span>API key</span><input name="apiKey" type="password" autocomplete="off" placeholder="provider key" data-admin-control="true"></label>
                <label class="span"><span>KMS secret ref</span><input name="kmsRef" autocomplete="off" placeholder="gcp-sm://projects/acme/secrets/anthropic/versions/latest" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Save key</button>
              </div>
              <p class="empty" id="byok-policy-note">BYOK policy loads after sign-in.</p>
            </form>
            <div class="panel">
              <h3>Configured providers</h3>
              <div class="list" id="byok-list"></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('connections', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Connections</h2>
              <div class="meta">${escapeHtml(copy.connectionsDescription || 'Issue scoped tokens for desktop and gateway clients. Plaintext is shown once.')}</div>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('connections')}
          <div class="grid">
            <form class="panel" id="token-form">
              <h3>Create ${escapeHtml(labels.apiToken || 'API token')}</h3>
              <div class="form-grid">
                <label class="span"><span>Name</span><input name="name" autocomplete="off" placeholder="Desktop connection" data-admin-control="true"></label>
                <div class="check-row span">
                  <label><input type="checkbox" name="scopes" value="desktop" checked data-admin-control="true"> Desktop</label>
                  <label><input type="checkbox" name="scopes" value="gateway" data-admin-control="true"> Gateway</label>
                  <label><input type="checkbox" name="scopes" value="admin" data-admin-control="true"> Admin</label>
                </div>
                <button class="primary" type="submit" data-admin-control="true">Create token</button>
                <button type="button" id="desktop-token" data-admin-control="true">${escapeHtml(labels.desktopToken || 'Desktop token')}</button>
                <button type="button" id="gateway-token" data-admin-control="true">${escapeHtml(labels.gatewayToken || 'Gateway token')}</button>
              </div>
            </form>
            <div class="panel">
              <h3>Issued tokens</h3>
              <div class="list" id="token-list"></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('gateway', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Headless gateway</h2>
              <div class="meta">${escapeHtml(copy.gatewayDescription || 'Headless agents route chat channels into cloud sessions.')}</div>
            </div>
            <button id="refresh-gateway" type="button" data-admin-control="true">Refresh gateway</button>
          </div>
          ${routeAdminSurfaceMarkup('gateway')}
          <div class="grid">
            <div class="panel">
              <h3>Setup guide</h3>
              <div class="list" id="gateway-setup-guide">
                <p class="empty">Gateway setup guidance loads after sign-in.</p>
              </div>
            </div>
            <form class="panel" id="agent-form">
              <h3>Create headless agent</h3>
              <div class="form-grid">
                <label><span>Name</span><input name="name" autocomplete="off" placeholder="On-call coding agent" data-admin-control="true"></label>
                <label><span>Profile</span><input name="profileName" autocomplete="off" value="${escapeHtml(policy.profileName)}" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Create agent</button>
              </div>
            </form>
            <form class="panel" id="binding-form">
              <h3>Add channel binding</h3>
              <div class="form-grid">
                <label><span>Agent</span><select id="binding-agent" name="agentId" data-admin-control="true"></select></label>
                <label><span>Provider</span><select name="provider" data-admin-control="true">
                  <option value="telegram">Telegram</option>
                  <option value="slack">Slack</option>
                  <option value="email">Email</option>
                  <option value="discord">Discord Bridge</option>
                  <option value="webhook">Webhook</option>
                </select></label>
                <label><span>Display name</span><input name="displayName" autocomplete="off" placeholder="Team Slack" data-admin-control="true"></label>
                <label><span>External workspace</span><input name="externalWorkspaceId" autocomplete="off" placeholder="optional" data-admin-control="true"></label>
                <label class="span"><span>Credential ref</span><input name="credentialRef" autocomplete="off" placeholder="secret://gateway/slack-bot" data-admin-control="true"></label>
                <label data-provider-field="slack"><span>Slack team ID</span><input name="slackTeamId" autocomplete="off" placeholder="T0123ABC" data-admin-control="true"></label>
                <label data-provider-field="slack"><span>Slack channel ID</span><input name="slackChannelId" autocomplete="off" placeholder="C0123ABC" data-admin-control="true"></label>
                <label class="span" data-provider-field="slack"><span>Slack API base URL</span><input name="slackApiBaseUrl" autocomplete="off" placeholder="https://slack.com/api" data-admin-control="true"></label>
                <label data-provider-field="email"><span>Inbound address</span><input name="emailAddress" autocomplete="off" placeholder="agent@example.com" data-admin-control="true"></label>
                <label data-provider-field="email"><span>Email domain</span><input name="emailDomain" autocomplete="off" placeholder="example.com" data-admin-control="true"></label>
                <label class="span" data-provider-field="email"><span>SMTP host</span><input name="emailSmtpHost" autocomplete="off" placeholder="smtp.example.com" data-admin-control="true"></label>
                <label class="span" data-provider-field="webhook"><span>Webhook delivery URL</span><input name="webhookDeliveryUrl" autocomplete="off" placeholder="https://bridge.example.com/open-cowork" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Create binding</button>
              </div>
            </form>
            <div class="panel">
              <h3>Agents</h3>
              <div class="list" id="agent-list"></div>
            </div>
            <div class="panel">
              <h3>Channel bindings</h3>
              <div class="list" id="binding-list"></div>
            </div>
            <div class="panel">
              <h3>Delivery backlog</h3>
              <div class="list" id="delivery-list">
                <p class="empty">No gateway deliveries loaded.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('billing', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Billing</h2>
              <div class="meta">${escapeHtml(copy.billingDescription || 'Manage hosted plan state and entitlements for this org.')}</div>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('billing')}
          <div class="grid">
            <form class="panel" id="billing-form">
              <h3>Plan</h3>
              <div id="billing-summary" class="list"></div>
              <div class="form-grid">
                <label><span>Available plan</span><select id="billing-plan-select" name="planKey" data-admin-control="true" data-billing-control="true"></select></label>
                <button class="primary" type="submit" data-admin-control="true" data-billing-control="true">Start checkout</button>
                <button type="button" id="billing-portal" data-admin-control="true" data-billing-control="true">Open portal</button>
              </div>
            </form>
            <div class="panel">
              <h3>Entitlements</h3>
              <div class="list" id="billing-entitlements">
                <p class="empty">Billing entitlements are enforced by the cloud API and worker. The dashboard reflects the current subscription status.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('audit', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Audit</h2>
              <div class="meta">Redacted administrative events</div>
            </div>
            <div class="row-actions">
              <label><span>Search</span><input id="audit-filter" autocomplete="off" placeholder="actor, action, entity" data-admin-control="true"></label>
              <button id="export-audit" type="button" data-admin-control="true">Export</button>
            </div>
          </div>
          ${routeAdminSurfaceMarkup('audit')}
          <div class="panel">
            <div class="section-header">
              <h3>Events</h3>
              <div class="meta"><span id="audit-count">0</span> event(s)</div>
            </div>
            <div class="list" id="audit-list">
              <p class="empty">No audit events loaded.</p>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('usage')}>
          <div class="section-header">
            <div>
              <h2>Usage</h2>
              <div class="meta">${escapeHtml(copy.usageDescription || 'Recent metering events for this org.')}</div>
            </div>
            <button id="export-usage" type="button">Export usage</button>
          </div>
          ${routeAdminSurfaceMarkup('usage')}
          <div class="grid">
            <div class="panel">
              <h3>Quota windows</h3>
              <div class="list" id="usage-quota-list"></div>
            </div>
            <div class="panel">
              <h3>Recent totals</h3>
              <div class="list" id="usage-total-list"></div>
            </div>
            <div class="panel">
              <h3>Recent events</h3>
              <div class="list" id="usage-list"></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('diagnostics', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Diagnostics</h2>
              <div class="meta">Redacted operational state</div>
            </div>
            <button id="prepare-diagnostics" type="button" data-admin-control="true">Prepare bundle</button>
          </div>
          ${routeAdminSurfaceMarkup('diagnostics')}
          <div class="grid">
            <div class="panel">
              <h3>Health</h3>
              <div class="list" id="diagnostics-health">
                <p class="empty">No diagnostics loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Support bundle</h3>
              <div class="list" id="diagnostics-bundle">
                <p class="empty">Prepare a bundle to inspect redacted support data.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
  <script${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''} id="open-cowork-cloud-bootstrap" type="application/json">${jsonScript(bootstrap)}</script>
  <script${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''}>${cloudWebsiteClientScript()}</script>
</body>
</html>`
}
