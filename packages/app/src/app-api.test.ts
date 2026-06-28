import { describe, expect, it, vi } from 'vitest'
import type { CoworkAPI } from '@open-cowork/shared'
import { createDesktopAppApi } from './app-api.ts'

function createMockCoworkApi(channels: Record<string, unknown>) {
  const noop = vi.fn(async () => null)
  const groupProxy = new Proxy({}, {
    get: () => noop,
  })
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'channels') return channels
      return groupProxy
    },
  }) as CoworkAPI
}

describe('createDesktopAppApi', () => {
  it('wraps channel IPC results in the same envelopes used by Cloud Web routes', async () => {
    const provider = { id: 'telegram', provider: 'telegram', label: 'Telegram', available: true, connected: true }
    const agent = { agentId: 'agent-1', name: 'Support' }
    const binding = { bindingId: 'binding-1', provider: 'telegram', credentialRefConfigured: true }
    const identity = { identityId: 'identity-1', externalUserId: 'user-1', role: 'member' }
    const delivery = { deliveryId: 'delivery-1', status: 'failed' }
    const watch = { id: 'watch-1', status: 'active' }
    const channels = {
      providers: vi.fn(async () => [provider]),
      agents: vi.fn(async () => [agent]),
      createAgent: vi.fn(async () => agent),
      updateAgent: vi.fn(async () => agent),
      bindings: vi.fn(async () => [binding]),
      connectBinding: vi.fn(async () => binding),
      updateBinding: vi.fn(async () => binding),
      disconnectBinding: vi.fn(async () => binding),
      people: vi.fn(async () => [identity]),
      resolvePerson: vi.fn(async () => identity),
      deliveries: vi.fn(async () => [delivery]),
      retryDelivery: vi.fn(async () => delivery),
      deadLetterDelivery: vi.fn(async () => delivery),
      watches: vi.fn(async () => [watch]),
      createWatch: vi.fn(async () => watch),
      updateWatch: vi.fn(async () => watch),
      pauseWatch: vi.fn(async () => watch),
      resumeWatch: vi.fn(async () => watch),
      deleteWatch: vi.fn(async () => true),
    }
    const api = createDesktopAppApi(createMockCoworkApi(channels))

    await expect(api.channels.providers()).resolves.toEqual({ providers: [provider] })
    await expect(api.channels.agents()).resolves.toEqual({ agents: [agent] })
    await expect(api.channels.createAgent({ name: 'Support' })).resolves.toEqual({ agent })
    await expect(api.channels.updateAgent('agent-1', { name: 'Support 2' })).resolves.toEqual({ agent })
    await expect(api.channels.bindings()).resolves.toEqual({ bindings: [binding] })
    await expect(api.channels.connectBinding({ agentId: 'agent-1', provider: 'telegram', displayName: 'Telegram' })).resolves.toEqual({ binding })
    await expect(api.channels.updateBinding('binding-1', { status: 'disabled' })).resolves.toEqual({ binding })
    await expect(api.channels.disconnectBinding('binding-1')).resolves.toEqual({ binding })
    await expect(api.channels.people()).resolves.toEqual({ identities: [identity] })
    await expect(api.channels.resolvePerson({ provider: 'telegram', externalUserId: 'user-1' })).resolves.toEqual({ identity })
    await expect(api.channels.deliveries()).resolves.toEqual({ deliveries: [delivery] })
    await expect(api.channels.retryDelivery('delivery-1')).resolves.toEqual({ delivery })
    await expect(api.channels.deadLetterDelivery('delivery-1', { lastError: 'confirmed' })).resolves.toEqual({ delivery })

    await expect(api.channels.watches()).resolves.toEqual([watch])
    await expect(api.channels.createWatch({ workspaceId: 'local', target: { kind: 'project', id: 'project-1' } })).resolves.toEqual(watch)
    await expect(api.channels.deleteWatch('watch-1')).resolves.toBe(true)
    await expect(api.admin.channels.agents()).resolves.toEqual({ agents: [agent] })
    await expect(api.admin.channels.createBinding({ agentId: 'agent-1', provider: 'telegram', displayName: 'Telegram' })).resolves.toEqual({ binding })
    expect(channels.connectBinding).toHaveBeenCalledTimes(2)
  })

  it('forwards coworkApi.on.* push channels into the shared {type,data,raw} event shape', () => {
    const listeners: Record<string, Array<(data: unknown) => void>> = {}
    const unsubscribed: string[] = []
    const on = new Proxy({}, {
      get: (_target, name: string) => (callback: (data: unknown) => void) => {
        ;(listeners[name] ||= []).push(callback)
        return () => unsubscribed.push(name)
      },
    })
    const emit = (name: string, data: unknown) => (listeners[name] || []).forEach((cb) => cb(data))
    const coworkApi = new Proxy({}, {
      get: (_target, prop) => (prop === 'on' ? on : new Proxy({}, { get: () => vi.fn() })),
    }) as CoworkAPI
    const api = createDesktopAppApi(coworkApi)

    // workspace.events forwards workspace-wide channels, normalizing arg-less
    // channels to null data and tearing subscriptions down on close().
    const workspaceMessages: Array<{ type: string; data: unknown }> = []
    const workspaceStream = api.workspace.events({
      message: (event) => workspaceMessages.push({ type: event.type, data: event.data }),
    })
    emit('knowledgeUpdated', undefined)
    emit('workspaceSessionsUpdated', { workspaceId: 'local' })
    expect(workspaceMessages).toEqual([
      { type: 'knowledgeUpdated', data: null },
      { type: 'workspaceSessionsUpdated', data: { workspaceId: 'local' } },
    ])
    workspaceStream.close()
    expect(unsubscribed).toContain('knowledgeUpdated')

    // sessions.events scopes id-bearing channels to the requested session.
    const sessionTypes: string[] = []
    api.sessions.events('s1', { message: (event) => sessionTypes.push(event.type) })
    emit('sessionView', { sessionId: 's2', view: {} }) // other session — ignored
    emit('sessionView', { sessionId: 's1', view: {} }) // forwarded
    emit('sessionPatch', { ops: [] }) // global patch — forwarded
    emit('sessionDeleted', { id: 's2' }) // other session — ignored
    emit('sessionDeleted', { id: 's1' }) // forwarded
    expect(sessionTypes).toEqual(['sessionView', 'sessionPatch', 'sessionDeleted'])
  })
})
