import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import type { CloudRuntimeAdapter, CloudRuntimePromptPart } from '@open-cowork/cloud-server/runtime-adapter'

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

// Runtime that gates the `oc-slow` session on a manually released promise and lets every
// other session complete immediately, recording the order sessions finish.
class GatedRuntime implements CloudRuntimeAdapter {
  readonly completed: string[] = []
  readonly slowGate = deferred()

  async createSession() {
    return { id: 'oc-created', title: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string, messageId?: string }) {
    if (input.sessionId === 'oc-slow') await this.slowGate.promise
    this.completed.push(input.sessionId)
    return {
      events: [
        { type: 'assistant.message', payload: { messageId: `${input.sessionId}:${input.messageId}`, content: 'done' } },
        { type: 'session.idle', payload: { sessionId: input.sessionId } },
      ],
    }
  }

  async abortSession() {}
}

function makeService(store: InMemoryControlPlaneStore, runtime: CloudRuntimeAdapter) {
  let counter = 0
  return new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => `id-${counter++}` },
  )
}

function seedSession(store: InMemoryControlPlaneStore, tenantId: string, sessionId: string, opencodeSessionId: string, commandIds: string[]) {
  store.createTenant({ tenantId, name: tenantId })
  store.ensureUser({ tenantId, userId: `${tenantId}-user`, email: `${tenantId}@example.com`, role: 'owner' })
  store.createSession({ tenantId, userId: `${tenantId}-user`, sessionId, opencodeSessionId, profileName: 'default' })
  for (const commandId of commandIds) {
    store.enqueueSessionCommand({
      tenantId,
      userId: `${tenantId}-user`,
      sessionId,
      commandId,
      kind: 'prompt',
      payload: { text: 'prompt', agent: 'build' },
    })
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('worker processes independent sessions concurrently so a slow command does not head-of-line-block other tenants (P3-16)', async () => {
  const store = new InMemoryControlPlaneStore()
  seedSession(store, 'tenant-slow', 'session-slow', 'oc-slow', ['slow-cmd'])
  seedSession(store, 'tenant-fast', 'session-fast', 'oc-fast', ['fast-cmd'])
  const runtime = new GatedRuntime()
  const worker = new CloudWorker(store, makeService(store, runtime), 'worker-1', 30_000, {}, null, null, { sessionConcurrency: 2 })

  const run = worker.processAllSessionCommands()
  // The fast tenant completes while the slow tenant is still blocked mid-command.
  await waitFor(() => runtime.completed.includes('oc-fast'))
  assert.deepEqual(runtime.completed, ['oc-fast'])

  runtime.slowGate.resolve()
  const processed = await run
  assert.equal(processed, 2)
  assert.deepEqual([...runtime.completed].sort(), ['oc-fast', 'oc-slow'])
})

test('worker caps the commands a single session drains per tick (P3-16)', async () => {
  const store = new InMemoryControlPlaneStore()
  seedSession(store, 'tenant-1', 'session-1', 'oc-session-1', ['cmd-1', 'cmd-2', 'cmd-3'])
  const runtime = new GatedRuntime()
  const worker = new CloudWorker(store, makeService(store, runtime), 'worker-1', 30_000, {}, null, null, { maxCommandsPerSessionPerTick: 2 })

  // First tick drains at most the cap; the remaining command is left for the next pass.
  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 2)
  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 1)
  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 0)
})
