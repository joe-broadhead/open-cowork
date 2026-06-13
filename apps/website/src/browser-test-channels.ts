import { iso } from './browser-test-fixtures.ts'
import type { BrowserHarnessMockRequest } from './browser-test-coordination.ts'

type BrowserChannelHarnessState = Record<string, any>

type BrowserChannelRequestInput = {
  request: BrowserHarnessMockRequest
  state: BrowserChannelHarnessState
  jsonResponse(body: unknown, status?: number): Response
  limitFromRequest(request: BrowserHarnessMockRequest, fallback: number, max?: number): number
}

export function makeBrowserChannelState() {
  return {
    agents: [
      { agentId: 'agent-1', name: 'On-call coding agent', profileName: 'default', status: 'active' },
    ],
    bindings: [
      { bindingId: 'binding-1', agentId: 'agent-1', provider: 'telegram', displayName: 'Team Telegram', status: 'active', settings: { defaultChatId: 'chat-1' } },
    ],
    identities: [
      { identityId: 'identity-owner', provider: 'telegram', externalWorkspaceId: null, externalUserId: '@owner', role: 'owner', status: 'active', metadata: { handle: '@owner' }, createdAt: iso(1), updatedAt: iso(1) },
      { identityId: 'identity-admin', provider: 'slack', externalWorkspaceId: 'T0123', externalUserId: '@admin', role: 'admin', status: 'active', metadata: { handle: '@admin' }, createdAt: iso(2), updatedAt: iso(2) },
      { identityId: 'identity-member', provider: 'discord', externalWorkspaceId: null, externalUserId: '@member', role: 'member', status: 'active', metadata: { handle: '@member' }, createdAt: iso(3), updatedAt: iso(3) },
      { identityId: 'identity-approver', provider: 'telegram', externalWorkspaceId: null, externalUserId: '@approver', role: 'approver', status: 'active', metadata: { handle: '@approver' }, createdAt: iso(4), updatedAt: iso(4) },
      { identityId: 'identity-viewer', provider: 'email', externalWorkspaceId: null, externalUserId: 'viewer@example.test', role: 'viewer', status: 'active', metadata: { handle: 'viewer@example.test' }, createdAt: iso(5), updatedAt: iso(5) },
    ],
  }
}

function channelProviderStatuses(state: BrowserChannelHarnessState) {
  const labels: Record<string, string> = {
    whatsapp: 'WhatsApp',
    telegram: 'Telegram',
    slack: 'Slack',
    discord: 'Discord',
    signal: 'Signal',
    email: 'Email',
    webhook: 'Webhook',
  }
  return Object.entries(labels).map(([provider, label]) => {
    const providerBindings = state.bindings.filter((binding: Record<string, any>) => String(binding.provider || '').startsWith(provider))
    const activeBindingCount = providerBindings.filter((binding: Record<string, any>) => binding.status === 'active').length
    return {
      id: provider,
      provider,
      label,
      available: true,
      connected: activeBindingCount > 0,
      bindingCount: providerBindings.length,
      activeBindingCount,
      status: activeBindingCount > 0 ? 'connected' : 'available',
    }
  })
}

export function handleBrowserChannelRequest(input: BrowserChannelRequestInput) {
  const { request, state, jsonResponse, limitFromRequest } = input
  if (request.method === 'GET' && request.pathname === '/api/channels/providers') {
    return jsonResponse({ providers: channelProviderStatuses(state) })
  }
  if (request.method === 'GET' && request.pathname === '/api/channels/agents') {
    return jsonResponse({ agents: state.agents.slice(0, limitFromRequest(request, 100)) })
  }
  if (request.method === 'POST' && request.pathname === '/api/channels/agents') {
    const body = request.body as Record<string, unknown>
    const agent = {
      agentId: `agent-${state.agents.length + 1}`,
      name: body?.name || 'Agent',
      profileName: body?.profileName || 'default',
      status: 'active',
    }
    state.agents = [agent, ...state.agents]
    return jsonResponse({ agent })
  }
  if (request.method === 'GET' && request.pathname === '/api/channels/bindings') {
    return jsonResponse({ bindings: state.bindings.slice(0, limitFromRequest(request, 100)) })
  }
  if (request.method === 'POST' && request.pathname === '/api/channels/bindings') {
    const binding = { bindingId: `binding-${state.bindings.length + 1}`, ...(request.body as Record<string, unknown>), status: 'auth_required' }
    state.bindings = [binding, ...state.bindings]
    return jsonResponse({ binding })
  }
  const channelBindingMatch = request.pathname.match(/^\/api\/channels\/bindings\/([^/]+)$/)
  if (request.method === 'PATCH' && channelBindingMatch) {
    const bindingId = decodeURIComponent(channelBindingMatch[1])
    state.bindings = state.bindings.map((binding: Record<string, any>) => binding.bindingId === bindingId ? { ...binding, ...(request.body as Record<string, unknown>), updatedAt: iso(15) } : binding)
    return jsonResponse({ binding: state.bindings.find((binding: Record<string, any>) => binding.bindingId === bindingId) || null })
  }
  if (request.method === 'GET' && request.pathname === '/api/channels/identities') {
    return jsonResponse({ identities: state.identities.slice(0, limitFromRequest(request, 100)) })
  }
  if (request.method === 'POST' && request.pathname === '/api/channels/identities/resolve') {
    const body = request.body as Record<string, unknown>
    const identity = {
      identityId: `identity-${state.identities.length + 1}`,
      provider: body.provider,
      channelBindingId: body.channelBindingId,
      externalWorkspaceId: body.externalWorkspaceId || null,
      externalUserId: body.externalUserId,
      role: body.role || 'viewer',
      status: body.status || 'active',
      metadata: body.metadata || {},
      createdAt: iso(16),
      updatedAt: iso(16),
    }
    state.identities = [identity, ...state.identities]
    return jsonResponse({ identity })
  }
  if (request.method === 'GET' && request.pathname === '/api/channels/deliveries') {
    return jsonResponse({ deliveries: state.deliveries.slice(0, limitFromRequest(request, 50)) })
  }
  if (request.method === 'POST' && request.pathname.includes('/retry')) {
    state.deliveries = state.deliveries.map((delivery: Record<string, any>) => ({ ...delivery, status: delivery.deliveryId === request.pathname.split('/')[4] ? 'pending' : delivery.status }))
    return jsonResponse({ delivery: state.deliveries[0] })
  }
  if (request.method === 'POST' && request.pathname.includes('/dead-letter')) {
    state.deliveries = state.deliveries.map((delivery: Record<string, any>) => ({ ...delivery, status: delivery.deliveryId === request.pathname.split('/')[4] ? 'dead' : delivery.status }))
    return jsonResponse({ delivery: state.deliveries[0] })
  }
  return null
}
