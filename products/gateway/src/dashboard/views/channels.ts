import { esc, escAttr, html } from '../html.js'
import { asArray, shortId, fmtNumber, fmtDuration, formatDateTime } from '../format.js'
import { card, headFig, mini, stackedBar } from '../components.js'
import { renderEvents, renderCommand } from './shared.js'
import type { DashboardView } from '../types.js'
import type { MissionChannelSummary } from '../../mission-data.js'
import type { ChannelConnectorRegistry, ChannelConnectorStatus } from '../../channel-connectors.js'
import type { ChannelConnectorState, ChannelOnboardingAction } from '../../channels/capabilities.js'

function renderChannels(view: DashboardView): string {
  const channels = view.channels
  const pendingInbound = channels.sync.pendingInbound
  const connectors = orderedConnectors(channels.connectorRegistry)
  const providerCards = connectors.length ? connectors.map(connector => renderConnectorSetupCard(connector, view, channels)).join('') + renderFutureAdapterCard() : channels.providers.map(provider => renderProvider(provider)).join('')
  const bindingRows = renderChannelBindings(view, channels)
  const bindingCount = countVisibleChannelBindings(view, channels)
  const modeCounts = notificationModeCounts(view.projectBindings)
  const channelEvents = view.events.filter(event => /channel/i.test(String(event))).slice(-8).reverse()
  return `<section class="view" data-view="channels">
    <div class="view-head"><div><h1 class="page-h">Connect Channels</h1><p class="page-sub">Provider setup, trust, and binding status for Telegram, WhatsApp, Discord, and future adapters. Secrets and provider target identifiers stay redacted.</p></div><div class="head-figs">
      ${headFig(String(connectors.filter(connector => connector.enabled).length || channels.providers.filter(provider => provider.enabled).length), 'adapters')}${headFig(String(bindingCount), 'bindings')}${headFig(String(pendingInbound), 'pending in')}
    </div></div>
    ${renderUniversalSetupStrip()}
    ${connectors.length ? renderChannelSetupCockpit(connectors, view, channels) : ''}
    ${card('Operator Action Parity', 'A', `<span class="pill">${(channels.actionParity || []).length} actions</span>`, renderChannelActionParity(channels))}
    <div class="${connectors.length ? 'setup-grid' : 'providers'}">${providerCards}</div>
    <div class="grid-2">
      ${card('Channel Sync Bridge', 'C', `<span class="pill ${channels.sync.syncEnabled ? 'good' : 'warn'}">${channels.sync.syncEnabled ? 'enabled' : 'disabled'}</span>`, renderChannelSync(channels))}
      ${card('Notification Modes', 'N', `<span class="pill">${view.projectBindings.length} project bindings</span>`, stackedBar([
        { label: 'Immediate', value: modeCounts.immediate, color: 'var(--green)' },
        { label: 'Digest', value: modeCounts.digest, color: 'var(--orange)' },
        { label: 'Muted', value: modeCounts.muted, color: 'var(--faint)' },
      ]))}
    </div>
    ${card('Project And Channel Bindings', 'B', `<span class="pill">${bindingRows.count}</span>`, bindingRows.html)}
    ${card('Recent Channel Events', '~', '<span class="pill good">live</span>', renderEvents(channelEvents))}
  </section>`
}

function isChannelProjectBinding(binding: any): boolean {
  return Boolean(binding?.provider || ['telegram', 'whatsapp', 'discord'].includes(String(binding?.scope || '')) || isLocalProjectBinding(binding))
}

function isLocalProjectBinding(binding: any): boolean {
  const scope = String(binding?.scope || 'global')
  return Boolean(binding?.sessionId && !binding?.provider && !binding?.chatId && (scope === 'opencode' || scope === 'global'))
}

function countVisibleChannelBindings(view: DashboardView, channels: MissionChannelSummary): number {
  const projectBindings = view.projectBindings.filter(isChannelProjectBinding)
  const projectKeys = new Set(projectBindings.map(channelBindingIdentityKey).filter(Boolean))
  return projectBindings.length + channels.links.filter(link => !projectKeys.has(channelBindingIdentityKey(link))).length
}

function renderChannelActionParity(channels: MissionChannelSummary): string {
  const rows = (channels.actionParity || []).slice(0, 12)
  const coverage = (channels.nativeControlCoverage || []).map(row => `<tr><td class="name">${esc(row.provider)}</td><td>${statusPill(row.slash)}</td><td>${statusPill(row.nativeAction)}</td><td>${statusPill(row.presence)}</td><td>${esc(row.fallback.join(', '))}</td></tr>`).join('')
  const coverageTable = coverage
    ? `<div class="table-wrap"><table class="table"><thead><tr><th>Provider</th><th>Slash</th><th>Native</th><th>Presence</th><th>Fallback</th></tr></thead><tbody>${coverage}</tbody></table></div>`
    : ''
  if (!rows.length) return '<p class="empty">No channel action registry loaded.</p>'
  return `${coverageTable}<div class="table-wrap" style="margin-top:10px"><table class="table"><thead><tr><th>Action</th><th>Command</th><th>Trust</th><th>Safety</th><th>Typed</th><th>Slash</th><th>Native</th><th>Presence</th></tr></thead><tbody>${rows.map(row => {
    const telegram = row.providerControls?.telegram
    return `<tr><td>${esc(row.label)}</td><td><code>${esc(row.command)}</code><div class="meta">${esc(row.nativeUi?.fallbackCopy || row.command)}</div></td><td>${esc(row.trust)}</td><td>${esc(row.safetyClass || 'read_only')}</td><td>${statusPill(row.surfaces.typedCommand)}</td><td>${statusPill(telegram?.slash || row.surfaces.telegramSlash)}</td><td>${statusPill(telegram?.nativeAction || row.surfaces.richAction)}</td><td>${statusPill(row.presence?.status || 'not_applicable')}</td></tr>`
  }).join('')}</tbody></table></div><div class="src-note">Source: canonical channel action registry v2. Typed fallbacks, provider-native slash/native action coverage, bounded Telegram presence policy, menu actions, capability inventory, and this dashboard table are generated from the same contract. WhatsApp and Discord stay fallback/deferred until fresh provider proof exists.</div>`
}

function statusPill(status: string): string {
  const cls = status === 'supported' ? 'good' : status === 'blocked' ? 'bad' : status === 'partial' ? 'warn' : ''
  return `<span class="pill ${cls}">${esc(status)}</span>`
}

function channelBindingIdentityKey(binding: any): string {
  if (!binding?.provider || !binding?.chatId || !binding?.sessionId) return ''
  return `${binding.provider}:${binding.chatId}:${binding.threadId || ''}:${binding.sessionId}`
}
function renderProvider(provider: MissionChannelSummary['providers'][number]): string {
  const cls = provider.health === 'ok' ? 'good' : provider.health === 'degraded' ? 'warn' : 'bad'
  return html`<div class="provider ${cls}"><div class="provider-top"><div class="provider-name">${provider.provider}</div><span class="pill ${cls}">${provider.health}</span></div><div class="provider-stats"><div><b>${provider.bindings}</b><span>bindings</span></div><div><b class="${provider.configured ? 'good-text' : 'bad-text'}">${provider.configured ? 'yes' : 'no'}</b><span>configured</span></div><div><b class="${provider.enabled ? 'good-text' : 'warn-text'}">${provider.enabled ? 'on' : 'off'}</b><span>adapter</span></div></div><div class="provider-note">${provider.note}</div></div>`.value
}
const CONNECT_STEPS: Array<{ label: string; action: ChannelOnboardingAction | 'monitor' }> = [
  { label: 'Connect', action: 'connect' },
  { label: 'Verify', action: 'verify' },
  { label: 'Trust', action: 'trust' },
  { label: 'Bind', action: 'bind' },
  { label: 'Monitor', action: 'monitor' },
]

function orderedConnectors(registry?: ChannelConnectorRegistry): ChannelConnectorStatus[] {
  const connectors = asArray(registry?.connectors) as ChannelConnectorStatus[]
  const order = new Map(['telegram', 'whatsapp', 'discord'].map((provider, index) => [provider, index]))
  return connectors.slice().sort((a, b) => (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99) || a.displayName.localeCompare(b.displayName))
}

function renderUniversalSetupStrip(): string {
  return `<div class="connect-strip" aria-label="Universal channel setup steps">${CONNECT_STEPS.map(step => `<div class="setup-line"><div class="setup-label">${esc(step.label)}</div><div class="setup-copy">${esc(universalStepCopy(step.action))}</div></div>`).join('')}</div>`
}

function renderChannelSetupCockpit(connectors: ChannelConnectorStatus[], view: DashboardView, channels: MissionChannelSummary): string {
  const rows = connectors.map(connector => {
    const cls = connectorClass(connector.state)
    const bindings = connectorBindingVisibility(connector.provider, view, channels)
    const flow = connector.onboardingFlow
    const current = flow.steps.find(step => step.id === flow.currentStep)
    const blockers = connectorBlockers(connector)
    const evidenceLinks = connectorEvidenceLinks(connector, bindings)
    const command = flow.primaryAction.command ? renderCommand(flow.primaryAction.command) : '<span class="meta">No command required</span>'
    return `<tr data-testid="channel-cockpit-${escAttr(connector.provider)}">
      <td class="channel-cell"><b>${esc(connector.displayName)}</b><div class="meta">${esc(connector.provider)} / ${esc(connector.stage)}</div></td>
      <td><span class="pill ${cls}">${esc(connector.state)}</span><div class="meta">trusted ${esc(connector.trusted ? 'yes' : 'no')} / bindings ${esc(String(bindings.count || connector.bindingCount))}</div></td>
      <td><span class="pill ${current?.status === 'done' ? 'good' : current?.status === 'blocked' ? 'bad' : 'warn'}">${esc(flow.primaryAction.label)}</span><div class="meta">${esc(flow.primaryAction.summary)}</div></td>
      <td>${blockers.length ? renderBlockerList(blockers) : '<span class="pill good">none</span>'}</td>
      <td class="command-cell">${command}${flow.fallbackAction?.command ? `<div class="action-command">repair ${renderCommand(flow.fallbackAction.command)}</div>` : ''}</td>
      <td>${evidenceLinks.length ? `<div class="evidence-links">${evidenceLinks.map(link => `<a href="${escAttr(link.url)}">${esc(link.label)}</a>`).join('')}</div>` : '<div class="meta">no evidence link</div>'}</td>
    </tr>`
  }).join('')
  return card('Channel Setup Cockpit', 'C', `<span class="pill">${connectors.length} channels</span>`, `<div class="table-wrap"><table class="table cockpit-table"><thead><tr><th class="channel-cell">Channel</th><th>Health</th><th>Next Step</th><th>Blockers</th><th class="command-cell">Typed Action</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div><div class="src-note">Commands are rendered from the same redacted onboardingFlow contract used by CLI setup/status output.</div>`)
}

function renderConnectorSetupCard(connector: ChannelConnectorStatus, view: DashboardView, channels: MissionChannelSummary): string {
  const cls = connectorClass(connector.state)
  const bindings = connectorBindingVisibility(connector.provider, view, channels)
  const flow = connector.onboardingFlow
  const missing = connector.missingPrerequisites.slice(0, 5)
  const diagnostics = connector.diagnostics.slice(0, 4)
  const evidenceLinks = connectorEvidenceLinks(connector, bindings)
  const activePath = connector.setupPaths.find(path => path.active)
  return `<div class="provider setup-card ${cls}" data-testid="connector-${escAttr(connector.provider)}">
    <div class="setup-top">
      <div><div class="setup-name">${esc(connector.displayName)}</div><div class="setup-sub">${esc(connector.stage)} / ${esc(activePath ? `${activePath.label} ${activePath.implementationStatus}` : connector.modes.join(', ') || 'manual')} / ${esc(connector.stateSummary)}</div></div>
      <span class="pill ${cls}">${esc(connector.state)}</span>
    </div>
    ${renderSetupStepper(connector)}
    <div class="setup-sections">
      ${connector.setupPaths.length ? `<div class="setup-line"><div class="setup-label">Setup Options</div>${renderConnectorSetupPaths(connector)}</div>` : ''}
      <div class="setup-line"><div class="setup-label">Prerequisites</div><div class="setup-copy">${esc(providerPrerequisiteCopy(connector))}</div>${missing.length ? `<ul class="setup-list">${missing.map(row => `<li>${esc(row.label)}${row.env || row.configKey ? ` <span class="meta">${esc([row.env, row.configKey].filter(Boolean).join(' / '))}</span>` : ''}${row.secret ? ' <span class="pill warn">secret redacted</span>' : ''}</li>`).join('')}</ul>` : '<div class="setup-copy good-text">No missing setup prerequisites reported.</div>'}</div>
      <div class="setup-line"><div class="setup-label">Primary Action</div><div class="setup-copy">${esc(flow.primaryAction.summary)}</div>${flow.primaryAction.command ? `<div class="meta">${esc(flow.primaryAction.command)}</div>` : ''}${flow.fallbackAction ? `<div class="meta">fallback: ${esc(flow.fallbackAction.summary)}${flow.fallbackAction.command ? ` / ${esc(flow.fallbackAction.command)}` : ''}</div>` : ''}</div>
      <div class="setup-line"><div class="setup-label">Guided Actions</div>${renderConnectorActionRail(connector)}</div>
      <div class="setup-line"><div class="setup-label">Trust And Binding</div><div class="setup-copy">${esc(trustClaimCopy(connector))}</div>${bindings.html}</div>
      <div class="setup-line"><div class="setup-label">Evidence</div>${evidenceLinks.length ? `<div class="evidence-links">${evidenceLinks.map(link => `<a href="${escAttr(link.url)}">${esc(link.label)}</a>`).join('')}</div>` : '<div class="setup-copy warn-text">No redacted evidence bundle is linked yet.</div>'}</div>
      <div class="setup-line"><div class="setup-label">Redacted Diagnostics</div>${diagnostics.length ? `<ul class="setup-list">${diagnostics.map(row => `<li>${esc(row.summary)} <span class="meta">next: ${esc(row.remediation)}</span></li>`).join('')}</ul>` : '<div class="setup-copy good-text">No active diagnostics.</div>'}</div>
    </div>
  </div>`
}

function renderConnectorActionRail(connector: ChannelConnectorStatus): string {
  const flow = connector.onboardingFlow
  const items = flow.steps.map(step => {
    const cls = step.status === 'done' ? 'good' : step.status === 'blocked' ? 'bad' : step.status === 'current' ? 'warn' : ''
    const showCommand = step.status !== 'done' && step.primaryAction.command
    return `<div class="action-item" data-testid="connector-${escAttr(connector.provider)}-action-${escAttr(step.id)}">
      <div class="action-top"><span class="action-name">${esc(step.label)}</span><span class="pill ${cls}">${esc(step.status)}</span></div>
      <div class="action-copy">${esc(step.primaryAction.summary)}</div>
      ${step.blockers.length ? `<div class="blocker-list">${renderBlockerList(step.blockers)}</div>` : ''}
      ${showCommand ? `<div class="action-command">${renderCommand(step.primaryAction.command || '')}</div>` : ''}
    </div>`
  })
  if (flow.fallbackAction) {
    items.push(`<div class="action-item" data-testid="connector-${escAttr(connector.provider)}-action-repair">
      <div class="action-top"><span class="action-name">Repair</span><span class="pill warn">fallback</span></div>
      <div class="action-copy">${esc(flow.fallbackAction.summary)}</div>
      ${flow.fallbackAction.command ? `<div class="action-command">${renderCommand(flow.fallbackAction.command)}</div>` : ''}
    </div>`)
  }
  return `<div class="action-rail">${items.join('')}</div>`
}

function connectorBlockers(connector: ChannelConnectorStatus): string[] {
  return [...new Set([
    ...connector.onboardingFlow.steps.flatMap(step => step.blockers),
    ...connector.diagnostics.map(row => row.code),
  ])].slice(0, 6)
}

function renderBlockerList(blockers: string[]): string {
  return blockers.map(blocker => `<span class="pill ${/unsafe|missing|blocked|failed/i.test(blocker) ? 'bad' : 'warn'}">${esc(blocker)}</span>`).join('')
}
function renderConnectorSetupPaths(connector: ChannelConnectorStatus): string {
  return `<ul class="setup-list">${connector.setupPaths.map(path => {
    const cls = path.available ? 'good' : path.implementationStatus === 'scaffolded' ? 'warn' : 'bad'
    const refs = [...path.env, ...path.configKeys].slice(0, 8).join(' / ')
    const next = path.nextActions[0] || 'Follow provider setup docs.'
    return `<li>${path.active ? '<b>Selected:</b> ' : ''}${esc(path.label)} <span class="pill ${cls}">${esc(path.implementationStatus)}</span> <span class="meta">${esc(path.state)} / ${esc(path.configured ? 'configured' : 'not configured')}${refs ? ` / ${refs}` : ''}. Next: ${esc(next)}</span></li>`
  }).join('')}</ul>`
}

function renderFutureAdapterCard(): string {
  return `<div class="provider setup-card warn" data-testid="connector-future">
    <div class="setup-top"><div><div class="setup-name">Future adapters</div><div class="setup-sub">planned / provider contract / awaiting registry metadata</div></div><span class="pill warn">planned</span></div>
    <div class="setup-stepper">${CONNECT_STEPS.map((step, index) => `<div class="step ${index === 0 ? 'current' : ''}">${esc(step.label)}</div>`).join('')}</div>
    <div class="setup-sections">
      <div class="setup-line"><div class="setup-label">Prerequisites</div><div class="setup-copy">Implement the channel adapter contract, declare capabilities, diagnostics, and trust mode before exposing setup.</div></div>
      <div class="setup-line"><div class="setup-label">Safe Next Action</div><div class="setup-copy">Register the adapter with redacted onboarding metadata; keep target identifiers and provider secrets out of Mission Control.</div></div>
    </div>
  </div>`
}

function renderSetupStepper(connector: ChannelConnectorStatus): string {
  return `<div class="setup-stepper">${connector.onboardingFlow.steps.map(step => {
    const stateClass = step.status === 'done' ? 'done' : step.status === 'current' || step.status === 'blocked' ? 'current' : ''
    return `<div class="step ${stateClass}" title="${escAttr(step.primaryAction.summary)}">${esc(step.label)}</div>`
  }).join('')}</div>`
}

function connectorBindingVisibility(provider: string, view: DashboardView, channels: MissionChannelSummary): { count: number; html: string; sessionIds: string[]; projectIds: string[] } {
  const projectBindings = view.projectBindings.filter(binding => binding.provider === provider || binding.scope === provider)
  const projectKeys = new Set(projectBindings.map(channelBindingIdentityKey).filter(Boolean))
  const channelLinks = channels.links.filter(link => link.provider === provider && !projectKeys.has(channelBindingIdentityKey(link)))
  const rows = [
    ...projectBindings.map((binding, index) => ({ kind: 'project', label: binding.alias || binding.title || shortId(binding.id), target: redactedTargetLabel(provider, index), sessionId: binding.sessionId, projectId: binding.roadmapId, mode: binding.notificationMode || 'immediate' })),
    ...channelLinks.map((link, index) => ({ kind: 'channel', label: link.title || link.mode || provider, target: redactedTargetLabel(provider, projectBindings.length + index), sessionId: link.sessionId, projectId: '', mode: link.mode || 'chat' })),
  ]
  const sessionIds = [...new Set(rows.map(row => row.sessionId).filter(Boolean).map(String))]
  const projectIds = [...new Set(rows.map(row => row.projectId).filter(Boolean).map(String))]
  const html = rows.length
    ? `<ul class="setup-list">${rows.slice(0, 4).map(row => `<li>${esc(row.kind)} ${esc(row.label)} / ${esc(row.target)} / ${sessionRefHtml(row.sessionId, view)} / ${esc(row.mode)}</li>`).join('')}</ul>`
    : '<div class="setup-copy warn-text">No Project/Session binding visible yet. Bind from a trusted target or local Session when ready.</div>'
  return { count: rows.length, html, sessionIds, projectIds }
}

function sessionRefHtml(sessionId: unknown, view: DashboardView): string {
  const value = String(sessionId || '')
  if (!value) return 'session pending'
  const label = `session ${shortId(value)}`
  const session = view.recentSessions.find(row => String(row.id || '') === value)
  return session?.webUrl ? `<a class="session-link" href="${escAttr(session.webUrl)}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label)
}

function connectorEvidenceLinks(connector: ChannelConnectorStatus, bindings: { sessionIds: string[]; projectIds: string[] }): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = []
  for (const sessionId of bindings.sessionIds.slice(0, 2)) links.push({ label: `redacted session ${shortId(sessionId)}`, url: `/evidence/export?sessionId=${encodeURIComponent(sessionId)}` })
  for (const projectId of bindings.projectIds.slice(0, 2)) links.push({ label: `redacted project ${shortId(projectId)}`, url: `/evidence/export?projectId=${encodeURIComponent(projectId)}` })
  if (!links.length && connector.evidenceRefs.some(ref => ref.startsWith('proof:') || ref.startsWith('dogfood:'))) links.push({ label: 'redacted proof bundle', url: '/evidence/export' })
  return links
}

function connectorClass(state: ChannelConnectorState): string {
  if (state === 'ready' || state === 'bound') return 'good'
  if (state === 'blocked' || state === 'credentials_needed' || state === 'webhook_needed' || state === 'verification_pending') return 'bad'
  return 'warn'
}

function providerPrerequisiteCopy(connector: ChannelConnectorStatus): string {
  if (connector.provider === 'whatsapp') return 'Meta Cloud API direct setup needs access token, phone number ID, verify token, and app secret.'
  if (connector.provider === 'telegram') return 'Create a bot with BotFather, configure the bot token locally, then trust a chat or topic target before binding it to a Gateway Session or Project.'
  if (connector.provider === 'discord') return 'Discord is private-alpha: enable it deliberately, configure bot token and public key, expose only the signed interaction route, then trust a channel or thread target.'
  return 'Follow the connector capability declaration for credentials, trust, and binding.'
}

function trustClaimCopy(connector: ChannelConnectorStatus): string {
  if (connector.trusted && connector.unsafeAllowAll) return 'Trust is satisfied by an unsafe allow-all override. Replace it with an explicit target allowlist before production.'
  if (connector.trusted) return 'Trusted target claim is satisfied by an accepted claim code, explicit allowlist, or accepted local configuration. Raw target identifiers are hidden.'
  return `Trusted target claim is pending. Generate a short-lived claim code with opencode-gateway channel claim ${connector.provider}, send it from the provider target, or use manual allowlist; do not paste raw IDs into Mission Control.`
}

function universalStepCopy(action: ChannelOnboardingAction | 'monitor'): string {
  if (action === 'connect') return 'Configure provider or local surface prerequisites.'
  if (action === 'verify') return 'Confirm callback, polling, challenge, or signature readiness.'
  if (action === 'trust') return 'Claim or allowlist the target without exposing raw IDs.'
  if (action === 'bind') return 'Attach the target to a Session, Issue, or Project.'
  if (action === 'monitor') return 'Watch delivery health and pending inbound work.'
  return 'Repair the connector using redacted diagnostics.'
}

function redactedTargetLabel(provider: string, index: number): string {
  return `${provider}:target-${index + 1} (redacted)`
}

function renderChannelSync(channels: MissionChannelSummary): string {
  const sync = channels.sync
  return `<div class="grid-3">${mini('Active', sync.active ? 'yes' : 'no')}${mini('Interval', fmtDuration(sync.intervalMs))}${mini('Pending In', fmtNumber(sync.pendingInbound))}</div><div class="lane" style="margin-top:10px"><div class="row compact"><div><div class="title">${fmtNumber(sync.deliveriesTracked)} delivery checkpoints tracked</div><div class="meta">include user messages ${sync.includeUserMessages ? 'on' : 'off'} / last sync ${sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : 'not recorded'}</div></div><span class="pill ${sync.pendingInbound ? 'warn' : 'good'}">${sync.pendingInbound ? 'draining' : 'idle'}</span></div></div><div class="src-note">source: channel-sync state file and active bridge summary.</div>`
}

function renderChannelBindings(view: DashboardView, channels: MissionChannelSummary): { html: string; count: number } {
  const rows = [
    ...view.projectBindings.map((binding, index) => ({
      alias: binding.alias || binding.title || binding.id,
      scope: binding.scope,
      surface: binding.provider && binding.chatId ? redactedTargetLabel(binding.provider, index) : binding.scope,
      roadmap: binding.roadmapId,
      sessionId: binding.sessionId,
      mode: binding.notificationMode || 'immediate',
    })),
    ...channels.links.map((link, index) => ({
      alias: link.title || link.mode || link.provider,
      scope: link.provider,
      surface: redactedTargetLabel(link.provider, view.projectBindings.length + index),
      roadmap: link.roadmapId || link.taskId || 'chat',
      sessionId: link.sessionId,
      mode: link.mode,
    })),
  ]
  if (!rows.length) return { count: 0, html: '<p class="empty good">No channel adapters, chat links, or project notification bindings configured.</p>' }
  return { count: rows.length, html: `<div class="table-wrap"><table class="table"><thead><tr><th>Alias</th><th>Scope</th><th>Surface</th><th>Initiative</th><th>Session</th><th>Mode</th></tr></thead><tbody>${rows.map(row => `<tr><td class="name">${esc(row.alias)}</td><td><span class="pill">${esc(row.scope)}</span></td><td>${esc(row.surface)}</td><td>${esc(shortId(row.roadmap))}</td><td>${esc(shortId(row.sessionId))}</td><td>${esc(row.mode)}</td></tr>`).join('')}</tbody></table></div>` }
}

function notificationModeCounts(bindings: any[]): Record<'immediate' | 'digest' | 'muted', number> {
  const counts = { immediate: 0, digest: 0, muted: 0 }
  for (const binding of bindings) {
    if (binding.notificationMode === 'digest') counts.digest += 1
    else if (binding.notificationMode === 'muted') counts.muted += 1
    else counts.immediate += 1
  }
  return counts
}

export { renderChannels }
