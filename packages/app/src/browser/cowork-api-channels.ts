// Browser (cloud web) implementation of the `CoworkAPI['channels']` surface.
//
// Extracted from cowork-api.ts (JOE-884) to keep the browser cloud API facade
// within its documented size budget.

import type { ChannelApiSurface, CoordinationWatch } from '@open-cowork/shared'

type QueryValue = string | number | boolean | null | undefined | Array<string | null | undefined>

export type ChannelsTransport = {
  request: <T = unknown>(
    path: string,
    options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
  ) => Promise<T>
  endpoint: (id: string, params?: Record<string, string>) => string
  withQuery: (path: string, params?: Record<string, QueryValue>) => string
}

function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
    const next = (value as Record<string, unknown>)[key]
    return (next ?? fallback) as T
  }
  return fallback
}

export function createBrowserChannelsApi(transport: ChannelsTransport): ChannelApiSurface {
  const { request, endpoint, withQuery } = transport
  return {
    providers: async (options) =>
      unwrap(await request(withQuery(endpoint('channelProviders'), { workspaceId: options?.workspaceId })), 'providers', []),
    agents: async (options) =>
      unwrap(await request(withQuery(endpoint('channelAgents'), { workspaceId: options?.workspaceId, limit: options?.limit ?? 100 })), 'agents', []),
    createAgent: async (input) => unwrap(await request(endpoint('channelAgentCreate'), { method: 'POST', body: input }), 'agent', null as never),
    updateAgent: async (agentId, input) =>
      unwrap(await request(endpoint('channelAgentUpdate', { agentId }), { method: 'PATCH', body: input }), 'agent', null),
    bindings: async (options) =>
      unwrap(await request(withQuery(endpoint('channelBindings'), { workspaceId: options?.workspaceId, agentId: options?.agentId, limit: options?.limit ?? 100 })), 'bindings', []),
    connectBinding: async (input) => unwrap(await request(endpoint('channelBindingCreate'), { method: 'POST', body: input }), 'binding', null as never),
    updateBinding: async (bindingId, input) =>
      unwrap(await request(endpoint('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: input }), 'binding', null),
    disconnectBinding: async (bindingId) =>
      unwrap(await request(endpoint('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }), 'binding', null),
    people: async (options) =>
      unwrap(await request(withQuery(endpoint('channelIdentities'), {
        workspaceId: options?.workspaceId,
        provider: options?.provider,
        externalWorkspaceId: options?.externalWorkspaceId,
        role: options?.role,
        status: options?.status,
        limit: options?.limit ?? 100,
      })), 'identities', []),
    resolvePerson: async (input) => unwrap(await request(endpoint('channelIdentityResolve'), { method: 'POST', body: input }), 'identity', null as never),
    deliveries: async (options) =>
      unwrap(await request(withQuery(endpoint('channelDeliveries'), {
        workspaceId: options?.workspaceId,
        deliveryId: options?.deliveryId,
        status: options?.status,
        channelBindingId: options?.channelBindingId,
        limit: options?.limit ?? 50,
      })), 'deliveries', []),
    retryDelivery: async (deliveryId) => unwrap(await request(endpoint('channelDeliveryRetry', { deliveryId }), { method: 'POST' }), 'delivery', null),
    deadLetterDelivery: async (deliveryId, input) =>
      unwrap(await request(endpoint('channelDeliveryDeadLetter', { deliveryId }), { method: 'POST', body: input || {} }), 'delivery', null),
    watches: (options) =>
      request<CoordinationWatch[]>(withQuery(endpoint('coordinationWatches'), {
        workspaceId: options?.workspaceId,
        targetKind: options?.targetKind,
        targetId: options?.targetId,
        status: options?.status,
        limit: options?.limit ?? 500,
      })),
    createWatch: (input) => request<CoordinationWatch>(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
    updateWatch: (watchId, input) => request<CoordinationWatch | null>(endpoint('coordinationWatch', { watchId }), { method: 'POST', body: input }),
    pauseWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchPause', { watchId }), { method: 'POST' }),
    resumeWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchResume', { watchId }), { method: 'POST' }),
    deleteWatch: async (watchId) =>
      Boolean(unwrap(await request(endpoint('coordinationWatchDelete', { watchId }), { method: 'DELETE' }), 'deleted', true)),
  }

}
