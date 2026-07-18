import { esc, escAttr } from '../html.js'
import { asArray, shortId, shortPath, compactNumber, fmtMoney, fmtNumber, formatDateTime } from '../format.js'
import { card, metric, headFig } from '../components.js'
import type { DashboardView, AgentFactoryView, AgentFactoryProfileView } from '../types.js'

function renderAgentFactory(view: DashboardView): string {
  const factory = view.agentFactory
  const blocked = factory.totals.blockedProfiles + factory.totals.blockedTeams
  return `<section class="view" data-view="agent-factory">
    <div class="view-head"><div><h1 class="page-h">Agent Factory</h1><p class="page-sub">Deterministic profile and team composition. Bounded tools, skills, MCP servers, permissions, environments, budgets, scorecards, and gates are shown together.</p></div><div class="head-figs">
      ${headFig(String(factory.totals.profiles), 'profiles')}${headFig(String(factory.totals.teams), 'teams')}${headFig(String(blocked), 'blocked')}
    </div></div>
    <div class="kpis">
      ${metric('Profiles', String(factory.totals.profiles), `${factory.totals.blockedProfiles} blocked / ${factory.totals.deprecatedProfiles} deprecated`)}
      ${metric('Teams', String(factory.totals.teams), `${factory.totals.blockedTeams} blocked / ${factory.invalidReferences.length} invalid references`)}
      ${metric('Blueprints', String(factory.totals.blueprints), `${factory.totals.blueprintGates} open gates`)}
      ${metric('Scorecards', String(factory.totals.scorecards), 'promotion evidence')}
      ${metric('Blueprint Gates', String(factory.totals.blueprintGates), 'preview/apply approvals')}
    </div>
    ${card('Profile Contracts', 'P', renderProfileFilter(factory), renderFactoryProfiles(factory.profiles))}
    <div class="grid-2">
      ${card('Teams And Stage Roles', 'T', `<span class="pill ${factory.invalidReferences.length || factory.totals.blockedTeams ? 'warn' : 'good'}">${factory.invalidReferences.length ? `${factory.invalidReferences.length} invalid refs` : 'validated'}</span>`, renderFactoryTeams(factory))}
      ${card('Blueprint Preview And Apply', 'B', '<span class="pill purple">gated</span>', renderBlueprintSurface(factory))}
    </div>
  </section>`
}
function renderProfileFilter(factory: AgentFactoryView): string {
  const states = [...new Set(factory.profiles.map(profile => profile.promotion.state))].sort()
  return `<div class="tabs" aria-label="Profile promotion filter"><button type="button" data-filter-group="profiles" data-filter-button="all" aria-pressed="true">All</button>${states.map(state => `<button type="button" data-filter-group="profiles" data-filter-button="${escAttr(state)}" aria-pressed="false">${esc(state)}</button>`).join('')}</div>`
}

function renderFactoryProfiles(profiles: AgentFactoryProfileView[]): string {
  if (!profiles.length) return '<p class="empty">No scheduler profiles configured.</p>'
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Profile</th><th>Version</th><th>Model</th><th>Agent</th><th>Bounds</th><th>Permissions</th><th>Environment</th><th>Budget</th><th>Promotion</th></tr></thead><tbody>${profiles.map(profile => {
    const state = profile.promotion.state
    const statusClass = profileValidationClass(profile.validation)
    const permissionTitle = `${profile.permissionCounts.allow} allow / ${profile.permissionCounts.ask} ask / ${profile.permissionCounts.deny} deny`
    const bounds = [
      `${profile.skills.length} skills`,
      `${profile.mcpServers.length} mcp`,
      `${profile.tools.length} tools`,
      `${profile.capabilities.length} caps`,
    ].join(' / ')
    const budget = [
      `tokens ${compactNumber(profile.budget.contractTokens || profile.budget.maxTokens)}`,
      profile.budget.maxCostUsd !== undefined ? fmtMoney(profile.budget.maxCostUsd) : undefined,
      profile.budget.humanGate ? `gate ${profile.budget.humanGate}` : undefined,
    ].filter(Boolean).join(' / ')
    const profileMeta = [profile.role, profile.outputContract, profile.description, profile.warnings[0]].filter(Boolean).join(' / ')
    const versionMeta = [profile.revision ? `rev ${shortId(profile.revision)}` : undefined, profile.lastUpdatedAt ? `updated ${formatDateTime(profile.lastUpdatedAt)}` : undefined].filter(Boolean).join(' / ')
    return `<tr data-filter-row="profiles" data-filter-values="${escAttr(`${state} ${profile.validation}`)}"><td class="name"><div>${esc(profile.name)}</div><div class="meta">${esc(profileMeta)}</div></td><td>${esc(profile.version)}${versionMeta ? `<div class="meta">${esc(versionMeta)}</div>` : ''}</td><td>${esc(profile.model)}</td><td>${esc(profile.agent)}</td><td>${esc(bounds)}</td><td><span class="pill ${profile.riskyPermissions.length ? 'warn' : 'good'}" title="${escAttr(profile.allowedPermissions.join(', ') || 'no allow grants')}">${esc(permissionTitle)}</span></td><td>${esc(profile.environment)}</td><td>${esc(budget || '--')}</td><td><span class="pill ${statusClass}">${esc(state)}</span></td></tr>`
  }).join('')}</tbody></table></div><div class="src-note">Permissions are summarized by policy and allow-list keys. Secret values and channel credentials are never rendered.</div>`
}
function renderFactoryTeams(factory: AgentFactoryView): string {
  const invalidRows = asArray(factory.invalidReferences).map((ref: any) => `<div class="row compact"><span class="dot blocked"></span><div><div class="title">Missing team ${esc(ref.agentTeam)}</div><div class="meta">${esc(ref.kind)} ${esc(shortId(ref.id))}${ref.title ? ` / ${esc(ref.title)}` : ''} / ${esc(ref.reason || 'invalid reference')}</div></div><span class="pill bad">invalid</span></div>`)
  const rows = factory.teams.map(team => {
    const roleText = team.roles.map(role => `${role.stage}:${role.profile}${role.agent ? ` -> ${role.agent}` : ''}`).join(' / ') || 'no roles'
    const requirementText = team.capabilityRequirements.map(row => `${row.stage}:${row.capabilities.join(',')}`).join(' / ') || 'no capability requirements'
    const refs = team.references
    const version = team.version || `rev:${shortId(team.revision)}`
    const updated = team.lastUpdatedAt ? ` / updated ${formatDateTime(team.lastUpdatedAt)}` : ''
    return `<div class="row compact"><span class="dot ${team.validation === 'blocked' ? 'blocked' : team.validation === 'warning' ? 'pending' : 'done'}"></span><div><div class="title">${esc(team.name)}${team.description ? ` - ${esc(team.description)}` : ''}</div><div class="meta">version ${esc(version)} / revision ${esc(shortId(team.revision))}${esc(updated)}</div><div class="meta">${esc(roleText)} / ${esc(requirementText)}</div><div class="meta">${fmtNumber(refs.activeTasks)} active tasks / ${fmtNumber(refs.recentRuns)} runs${team.warnings.length ? ` / ${esc(team.warnings.join(' / '))}` : ''}</div></div><span class="pill ${profileValidationClass(team.validation)}">${esc(team.promotion.state)}</span></div>`
  })
  if (!invalidRows.length && !rows.length) return '<p class="empty">No agent teams are configured.</p>'
  return `<div class="lane">${[...invalidRows, ...rows].join('')}</div><div class="src-note">Validation uses stage role resolution plus capability requirements; blocked/deprecated promotion state is treated as operator risk.</div>`
}

function renderBlueprintSurface(factory: AgentFactoryView): string {
  const gates = factory.blueprintGates
  const blueprints = factory.blueprints
  const sourceRows = factory.blueprintSources.length ? `<div class="src-note">sources: ${factory.blueprintSources.map(source => `${esc(source.path || '?')} (${esc(source.status || '?')}, ${fmtNumber(source.count || 0)} files)`).join(' / ')}</div>` : ''
  const blueprintRows = !blueprints.length
    ? '<p class="empty">No persisted blueprint files found. Add JSON blueprints under the configured Agent Factory blueprint directory.</p>'
    : `<div class="table-wrap"><table class="table"><thead><tr><th>Blueprint</th><th>Version</th><th>Profiles / Teams</th><th>OpenCode Grants</th><th>Status</th><th>Updated</th></tr></thead><tbody>${blueprints.map(blueprint => {
      const title = blueprint.title || blueprint.name
      const source = blueprint.source?.path ? ` / ${shortPath(blueprint.source.path)}` : ''
      const grants = [
        `${asArray(blueprint.summary?.skills).length} skills`,
        `${asArray(blueprint.summary?.mcpServers).length} mcp`,
        `${asArray(blueprint.summary?.tools).length} tools`,
        `${blueprint.summary?.permissions?.allow || 0} allow`,
      ].join(' / ')
      const validation = blueprint.validation?.errors?.length ? `${blueprint.validation.errors.length} errors` : blueprint.validation?.warnings?.length ? `${blueprint.validation.warnings.length} warnings` : 'valid'
      return `<tr><td class="name"><div>${esc(title)}</div><div class="meta">${esc(blueprint.description || blueprint.owner || blueprint.id || '')}${esc(source)}</div></td><td>${esc(blueprint.version || '?')}<div class="meta">${blueprint.revision ? `rev ${esc(shortId(blueprint.revision))}` : esc(blueprint.id || '')}</div></td><td>${fmtNumber(asArray(blueprint.profiles).length)} / ${fmtNumber(asArray(blueprint.teams).length)}</td><td>${esc(grants)}</td><td><span class="pill ${profileValidationClass(blueprint.status || 'warning')}">${esc(validation)}</span></td><td>${blueprint.lastUpdatedAt ? esc(formatDateTime(blueprint.lastUpdatedAt)) : '--'}</td></tr>`
    }).join('')}</tbody></table></div>`
  const actionRows = `<div class="lane">
    <div class="row compact"><span class="dot done"></span><div><div class="title">Preview blueprint diff</div><div class="meta">POST /blueprints/preview or gateway_blueprint_preview_text</div></div><span class="pill good">read-only</span></div>
    <div class="row compact"><span class="dot pending"></span><div><div class="title">Apply after approval</div><div class="meta">POST /blueprints/apply creates or consumes a human gate; OpenCode assets remain references.</div></div><span class="pill purple">gated</span></div>
  </div>`
  const gateRows = !gates.length
    ? '<p class="empty good" style="margin-top:10px">No open blueprint apply gates. Full drag-and-drop editing is intentionally out of scope.</p>'
    : `<div class="lane" style="margin-top:10px">${gates.map(gate => `<div class="row compact"><span class="dot pending"></span><div><div class="title">${esc(gate.reason || gate.type || 'Blueprint apply gate')}</div><div class="meta">${esc(gate.scopeKey || gate.id)} / requested ${gate.requestedAt ? esc(formatDateTime(gate.requestedAt)) : '--'}</div></div><span class="pill warn">${esc(gate.status || 'pending')}</span></div>`).join('')}</div>`
  return `${blueprintRows}${sourceRows}<div style="height:12px"></div>${actionRows}${gateRows}`
}
function profileValidationClass(validation: string): string {
  if (validation === 'blocked') return 'bad'
  if (validation === 'warning') return 'warn'
  return 'good'
}

export { renderAgentFactory }
