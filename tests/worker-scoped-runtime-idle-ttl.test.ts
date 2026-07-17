import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createByokSecretStore } from '@open-cowork/cloud-server/byok-secret-store'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
} from '@open-cowork/cloud-server/runtime-adapter'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createWorkerScopedRuntimeAdapter } from '@open-cowork/cloud-server/worker-scoped-runtime-adapter'

function seededStore() {
  return new InMemoryControlPlaneStore()
}

test('worker-scoped adapter reaps idle runtimes by TTL (JOE-866)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-idle-ttl-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-idle-ttl-test-key'))
  const closed: string[] = []
  let now = 1_000_000

  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    maxRuntimeEntries: 10,
    runtimeIdleTtlMs: 50,
    runtimeFactory(input) {
      return {
        async createSession() {
          return {
            id: `runtime-${input.execution.sessionId}`,
            title: 'Runtime session',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {},
        async abortSession() {},
        subscribeEvents() {
          return () => {}
        },
        async close() {
          closed.push(input.execution.sessionId)
        },
      } satisfies CloudRuntimeAdapter
    },
  })

  try {
    await runtime.promptSession({
      sessionId: 'runtime-a',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-idle' },
    })
    assert.deepEqual(closed, [])

    // Prefer polling over a fixed multi-second sleep (JOE-882 flake guidance).
    const deadline = Date.now() + 3_000
    while (!closed.includes('session-idle') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.ok(
      closed.includes('session-idle'),
      `expected idle session to be reaped, closed=${JSON.stringify(closed)}`,
    )
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped adapter remaps native session ids onto cowork session context (JOE-866)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-remap-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-remap-test-key'))
  const projected: CloudRuntimeEvent[] = []
  let innerListener: CloudRuntimeEventListener | null = null

  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory(input) {
      return {
        async createSession() {
          return {
            id: `native-root-${input.execution.sessionId}`,
            title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {},
        async abortSession() {},
        subscribeEvents(listener) {
          innerListener = listener
          return () => {
            innerListener = null
          }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })

  try {
    runtime.subscribeEvents((event) => {
      projected.push(event)
    })

    await runtime.promptSession({
      sessionId: 'runtime-map',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'cowork-session-1' },
    })

    assert.ok(innerListener, 'expected inner listener')
    innerListener!({
      type: 'assistant.message',
      payload: {
        sessionId: 'native-child-xyz',
        messageId: 'm1',
        content: 'hi',
      },
    })

    assert.ok(projected.length >= 1, 'expected projected event')
    const last = projected[projected.length - 1]!
    assert.equal(
      (last.payload as { sessionId?: string }).sessionId,
      'cowork-session-1',
      'native child session id should remap onto cowork session id',
    )
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})
