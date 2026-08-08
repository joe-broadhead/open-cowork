import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createByokSecretStore } from '@open-cowork/cloud-server/byok-secret-store'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { subscribeToOpencodeCloudRuntimeEvents } from '@open-cowork/cloud-server/opencode-runtime-adapter'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import { createCloudProgressWatchdogComposition } from '../packages/cloud-server/src/progress-watchdog-composition.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimeProgressEvent,
} from '@open-cowork/cloud-server/runtime-adapter'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import {
  CloudRuntimeCapacityError,
  createWorkerScopedRuntimeAdapter,
} from '@open-cowork/cloud-server/worker-scoped-runtime-adapter'

function seededStore() {
  const store = new InMemoryControlPlaneStore()
  // JOE-866 tests: BYOK secret listing requires an org row for the tenant.
  store.ensureOrgForTenant({
    tenantId: 'tenant-a',
    name: 'Tenant A',
  })
  return store
}

async function* waitForAbortStream(signal?: AbortSignal): AsyncGenerator<unknown> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  yield* []
}

test('worker-scoped adapter reaps idle runtimes by TTL (JOE-866)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-idle-ttl-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-idle-ttl-test-key'))
  const closed: string[] = []
  const restored: string[] = []

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
    async prepareProvision(input) {
      restored.push(input.execution.sessionId)
    },
    runtimeFactory(input) {
      // No subscribeEvents: synchronous fake adapters own execution for the
      // prompt call and clear executionActive when it returns (idle-TTL reaps).
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
    // Sweep interval is max(1000, ttl/2) so wait past at least one tick.
    const deadline = Date.now() + 4_000
    while (!closed.includes('session-idle') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    assert.ok(
      closed.includes('session-idle'),
      `expected idle session to be reaped, closed=${JSON.stringify(closed)}`,
    )
    await runtime.promptSession({
      sessionId: 'runtime-a',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-idle' },
    })
    assert.deepEqual(restored, ['session-idle', 'session-idle'])
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
  let innerProgressInstalled = false

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
        subscribeEvents(listener, options) {
          innerListener = listener
          innerProgressInstalled = Boolean(options?.onProgress)
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
    assert.equal(innerProgressInstalled, false, 'no inner progress classifier is installed without an observer')
    const delivery = Promise.resolve(innerListener!({
      type: 'assistant.message',
      payload: {
        sessionId: 'native-child-xyz',
        messageId: 'm1',
        content: 'hi',
      },
    }))

    assert.ok(projected.length >= 1, 'expected projected event')
    const last = projected[projected.length - 1]!
    assert.equal(
      (last.payload as { sessionId?: string }).sessionId,
      'cowork-session-1',
      'native child session id should remap onto cowork session id',
    )
    // Close deliberately races the still-settling async event callback. The
    // adapter must observe its active-use drain and must not deadlock.
    await Promise.all([delivery, runtime.close!()])
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('recoverable OpenCode errors preserve worker execution until authoritative terminal settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-watchdog-terminal-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('watchdog-terminal-test-key'))
  let releaseRunning: () => void = () => {}
  const runningGate = new Promise<void>((resolve) => { releaseRunning = resolve })
  let releaseTerminal: () => void = () => {}
  const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve })
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return {
            stream: (async function* stream() {
              await runningGate
              yield {
                payload: {
                  id: 'event-running',
                  type: 'session.status',
                  properties: { sessionID: 'native-root', status: { type: 'busy' } },
                },
              }
              yield {
                payload: {
                  id: 'event-recoverable-error',
                  type: 'session.error',
                  properties: {
                    sessionID: 'native-root',
                    error: { message: 'context overflow; compacting' },
                  },
                },
              }
              yield {
                payload: {
                  id: 'event-progress-after-error',
                  type: 'session.next.compaction.started',
                  properties: {
                    sessionID: 'native-root',
                    assistantMessageID: 'assistant-1',
                    messageID: 'message-1',
                    reason: 'auto',
                  },
                },
              }
              await terminalGate
              yield {
                payload: {
                  id: 'event-terminal',
                  type: 'session.idle',
                  properties: { sessionID: 'native-root' },
                },
              }
              yield* waitForAbortStream(signal)
            })(),
          }
        },
      },
    },
  }
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory() {
      return {
        async createSession() {
          return {
            id: 'native-root',
            title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() { releaseRunning() },
        async abortSession() {},
        subscribeEvents(listener, options) {
          return subscribeToOpencodeCloudRuntimeEvents(client as any, listener, options)
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const watchdog = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' },
    observability: null,
    worker: {
      async recoverStalledSession() {
        throw new Error('observe mode must not recover')
      },
    },
  })
  const progress: CloudRuntimeProgressEvent[] = []
  const projected: CloudRuntimeEvent[] = []
  const context = {
    tenantId: 'tenant-a',
    sessionId: 'cowork-watchdog-terminal',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }

  try {
    await runtime.subscribeEvents?.((event) => { projected.push(event) }, {
      onProgress(event) {
        progress.push(event)
        watchdog.observe(event)
      },
    })
    await runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root',
      parts: [],
      agent: 'build',
      messageId: 'run-terminal',
      context,
    }))
    const runningDeadline = Date.now() + 2_000
    while (watchdog.snapshot().counts.healthy !== 1 && Date.now() < runningDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(watchdog.snapshot().counts.healthy, 1)
    assert.equal(progress.some((event) => event.semanticKey?.startsWith('session.error')), false)
    assert.equal(
      progress.some((event) => event.semanticKey?.startsWith('session.next.compaction.started')),
      true,
      'progress after a recoverable error must retain the active execution provenance',
    )
    assert.equal(projected.some((event) => event.type === 'runtime.error'), false)

    releaseTerminal()
    const terminalDeadline = Date.now() + 2_000
    while (watchdog.snapshot().counts.healthy !== 0 && Date.now() < terminalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    const terminal = progress.find((event) => event.disposition === 'terminal')
    assert.deepEqual(terminal?.provenance, {
      scopeId: 'tenant-a',
      sessionId: 'cowork-watchdog-terminal',
      runId: 'run-terminal',
      runtimeGeneration: 1,
      executionGeneration: 1,
      leaseOwner: 'worker-a',
      leaseEpoch: 'lease-digest-a',
    })
  } finally {
    releaseRunning()
    releaseTerminal()
    await watchdog.close()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode authoritative wait terminal clears the worker-scoped watchdog before settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-watchdog-wait-terminal-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('watchdog-wait-terminal-test-key'))
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  const client = {
    v2: {
      event: {
        async subscribe({ signal }: { signal?: AbortSignal } = {}) {
          return { stream: waitForAbortStream(signal) }
        },
      },
      session: {
        async events(_input: unknown, options: { signal?: AbortSignal }) {
          return { stream: waitForAbortStream(options.signal) }
        },
        async wait() { await waitGate },
        async active() { return { data: { data: {} } } },
        async history() { return { data: { data: [], hasMore: false } } },
      },
    },
  }
  let subscription: ReturnType<typeof subscribeToOpencodeCloudRuntimeEvents> | null = null
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory() {
      return {
        async createSession() {
          return {
            id: 'native-root', title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession(input) {
          subscription?.markSessionAdmitted('native-root', input.messageId, 1)
        },
        async abortSession() {},
        subscribeEvents(listener, options) {
          subscription = subscribeToOpencodeCloudRuntimeEvents(client as any, listener, options)
          return subscription
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const watchdog = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' },
    observability: null,
    worker: { async recoverStalledSession() { throw new Error('observe mode must not recover') } },
  })
  const progress: CloudRuntimeProgressEvent[] = []
  const context = {
    tenantId: 'tenant-a', sessionId: 'cowork-watchdog-wait-terminal',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }

  try {
    await runtime.subscribeEvents?.(() => undefined, {
      onProgress(event) { progress.push(event); watchdog.observe(event) },
    })
    await runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root', parts: [], agent: 'build', messageId: 'run-wait-terminal', context,
    }))
    assert.equal(watchdog.snapshot().counts.healthy, 1)
    releaseWait()
    const deadline = Date.now() + 2_000
    while (watchdog.snapshot().counts.healthy !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    assert.equal(progress.at(-1)?.source, 'terminal')
    assert.equal(progress.at(-1)?.provenance?.runId, 'run-wait-terminal')
  } finally {
    releaseWait()
    await watchdog.close()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped explicit abort and unexpected exit clear watchdog state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-watchdog-local-terminals-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('watchdog-local-terminals-test-key'))
  let emitProgress: ((event: CloudRuntimeProgressEvent) => void) | null = null
  let unexpectedExit: (() => void) | null = null
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory(input) {
      unexpectedExit = () => { input.onUnexpectedExit?.() }
      return {
        async createSession() {
          return {
            id: 'native-root', title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {},
        async abortSession() {},
        subscribeEvents(_listener, options) {
          emitProgress = options?.onProgress || null
          return () => { emitProgress = null }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const watchdog = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' },
    observability: null,
    worker: { async recoverStalledSession() { throw new Error('observe mode must not recover') } },
  })
  const context = {
    tenantId: 'tenant-a', sessionId: 'cowork-watchdog-local-terminals',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }
  const begin = async (runId: string) => {
    await runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root', parts: [], agent: 'build', messageId: runId, context,
    }))
    emitProgress?.({
      source: 'phase_transition', disposition: 'running', semanticKey: `run:${runId}`,
      observedAtMs: 100, runtimeSessionId: 'native-root',
    })
    assert.equal(watchdog.snapshot().counts.healthy, 1)
  }

  try {
    await runtime.subscribeEvents?.(() => undefined, { onProgress: (event) => { watchdog.observe(event) } })
    await begin('run-abort')
    await runtime.abortSession({ sessionId: 'native-root', context })
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })

    await begin('run-exit')
    unexpectedExit?.()
    const deadline = Date.now() + 2_000
    while (watchdog.snapshot().counts.healthy !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
  } finally {
    await watchdog.close()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped prompt response loss settles only after exact-session abort succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-prompt-abort-success-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('prompt-abort-success-test-key'))
  const progress: CloudRuntimeProgressEvent[] = []
  const aborts: Array<Parameters<CloudRuntimeAdapter['abortSession']>[0]> = []
  let emitProgress: ((event: CloudRuntimeProgressEvent) => void) | null = null
  let prompts = 0
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH }, config: DEFAULT_CONFIG, byokSecrets,
    runtimeFactory() {
      return {
        async createSession() {
          return {
            id: 'native-root', title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {
          prompts += 1
          if (prompts === 1) {
            emitProgress?.({
              source: 'admission', disposition: 'running', semanticKey: 'prompt.admitted',
              observedAtMs: 100, runtimeSessionId: 'native-root',
            })
            throw new Error('prompt response lost')
          }
          return { events: [{ type: 'session.idle', payload: { sessionId: 'native-root' } }] }
        },
        async abortSession(input) { aborts.push(input) },
        subscribeEvents(_listener, options) {
          emitProgress = options?.onProgress || null
          return () => { emitProgress = null }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const watchdog = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' }, observability: null,
    worker: { async recoverStalledSession() { throw new Error('observe mode must not recover') } },
  })
  const context = {
    tenantId: 'tenant-a', sessionId: 'cowork-prompt-abort-success',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }
  const prompt = (runId: string) => runtime.withExecutionScope?.(context, () => runtime.promptSession({
    sessionId: 'native-root', parts: [], agent: 'build', messageId: runId, context,
  }))

  try {
    await runtime.subscribeEvents?.(() => undefined, {
      onProgress(event) { progress.push(event); watchdog.observe(event) },
    })
    await assert.rejects(prompt('run-lost-response'), /prompt response lost/)
    assert.equal(progress[0]?.provenance?.runId, 'run-lost-response')
    assert.equal(progress.at(-1)?.disposition, 'terminal')
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    assert.deepEqual(aborts, [{ sessionId: 'native-root', context }])

    await prompt('run-after-confirmed-abort')
    assert.equal(prompts, 2, 'confirmed abort permits the replacement execution')
  } finally {
    await watchdog.close()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a delayed terminal listener cannot settle a replacement worker execution generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-delayed-terminal-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('delayed-terminal-test-key'))
  let emitEvent: CloudRuntimeEventListener | null = null
  let releaseOldTerminal: () => void = () => {}
  const oldTerminalGate = new Promise<void>((resolve) => { releaseOldTerminal = resolve })
  let oldTerminalReachedListener: () => void = () => {}
  const listenerStarted = new Promise<void>((resolve) => { oldTerminalReachedListener = resolve })
  const prompted: string[] = []
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH }, config: DEFAULT_CONFIG, byokSecrets,
    runtimeFactory() {
      return {
        async createSession() {
          return {
            id: 'native-root', title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession(input) { prompted.push(input.messageId || '') },
        async abortSession() {},
        subscribeEvents(listener) {
          emitEvent = listener
          return () => { emitEvent = null }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const context = {
    tenantId: 'tenant-a', sessionId: 'cowork-delayed-terminal',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }
  const prompt = (runId: string) => runtime.withExecutionScope?.(context, () => runtime.promptSession({
    sessionId: 'native-root', parts: [], agent: 'build', messageId: runId, context,
  }))

  try {
    await runtime.subscribeEvents?.(async (event) => {
      if (event.eventId !== 'old-terminal') return
      oldTerminalReachedListener()
      await oldTerminalGate
    })
    await prompt('run-1')
    const oldDelivery = emitEvent?.({
      eventId: 'old-terminal', type: 'runtime.error',
      payload: { sessionId: 'native-root', message: 'old failure' },
    })
    await listenerStarted

    await runtime.abortSession({ sessionId: 'native-root', context })
    await prompt('run-2')
    releaseOldTerminal()
    await oldDelivery

    await assert.rejects(prompt('run-3-too-early'), (error: unknown) => (
      error instanceof CloudRuntimeCapacityError && error.reason === 'execution_active'
    ))
    assert.deepEqual(prompted, ['run-1', 'run-2'])

    await emitEvent?.({
      eventId: 'current-terminal', type: 'session.idle', payload: { sessionId: 'native-root' },
    })
    await prompt('run-3')
    assert.deepEqual(prompted, ['run-1', 'run-2', 'run-3'])
  } finally {
    releaseOldTerminal()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped prompt response loss preserves provenance and rejects retries when abort fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-prompt-abort-failure-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('prompt-abort-failure-test-key'))
  const progress: CloudRuntimeProgressEvent[] = []
  let emitProgress: ((event: CloudRuntimeProgressEvent) => void) | null = null
  let emitEvent: CloudRuntimeEventListener | null = null
  let prompts = 0
  let aborts = 0
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH }, config: DEFAULT_CONFIG, byokSecrets,
    runtimeFactory() {
      return {
        async createSession() {
          return {
            id: 'native-root', title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession() {
          prompts += 1
          if (prompts === 1) {
            emitProgress?.({
              source: 'admission', disposition: 'running', semanticKey: 'prompt.admitted',
              observedAtMs: 100, runtimeSessionId: 'native-root',
            })
            throw new Error('prompt response lost')
          }
          return { events: [{ type: 'session.idle', payload: { sessionId: 'native-root' } }] }
        },
        async abortSession() { aborts += 1; throw new Error('abort transport unavailable') },
        subscribeEvents(listener, options) {
          emitEvent = listener
          emitProgress = options?.onProgress || null
          return () => { emitEvent = null; emitProgress = null }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })
  const watchdog = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' }, observability: null,
    worker: { async recoverStalledSession() { throw new Error('observe mode must not recover') } },
  })
  const context = {
    tenantId: 'tenant-a', sessionId: 'cowork-prompt-abort-failure',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }
  const prompt = (runId: string) => runtime.withExecutionScope?.(context, () => runtime.promptSession({
    sessionId: 'native-root', parts: [], agent: 'build', messageId: runId, context,
  }))

  try {
    await runtime.subscribeEvents?.(() => undefined, {
      onProgress(event) { progress.push(event); watchdog.observe(event) },
    })
    await assert.rejects(prompt('run-unresolved'), /prompt response lost/)
    assert.equal(watchdog.snapshot().counts.healthy, 1)
    assert.equal(progress.at(-1)?.provenance?.runId, 'run-unresolved')
    assert.equal(aborts, 1)

    await assert.rejects(prompt('run-must-not-overwrite'), (error: unknown) => (
      error instanceof CloudRuntimeCapacityError && error.reason === 'execution_active'
    ))
    assert.equal(prompts, 1, 'retry never reaches the unresolved runtime generation')
    assert.equal(progress.at(-1)?.provenance?.runId, 'run-unresolved')

    emitProgress?.({
      source: 'terminal', disposition: 'terminal', semanticKey: 'session.idle',
      observedAtMs: 200, runtimeSessionId: 'native-root',
    })
    await emitEvent?.({ type: 'session.idle', payload: { sessionId: 'native-root' } })
    assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    await prompt('run-after-durable-terminal')
    assert.equal(prompts, 2)
  } finally {
    await watchdog.close()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped recovery is generation-fenced, lease-provenanced, and never provisions a replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-watchdog-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('watchdog-runtime-test-key'))
  const progress: CloudRuntimeProgressEvent[] = []
  const projected: CloudRuntimeEvent[] = []
  const aborted: string[] = []
  const prompted: string[] = []
  let provisions = 0
  let emitInnerProgress: ((event: CloudRuntimeProgressEvent) => void) | null = null
  let emitInnerEvent: CloudRuntimeEventListener | null = null
  const unexpectedExits: Array<() => void> = []
  let releaseRecovery: () => void = () => {}
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve })

  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    runtimeFactory(factoryInput) {
      provisions += 1
      unexpectedExits.push(() => factoryInput.onUnexpectedExit?.())
      return {
        async createSession() {
          return {
            id: 'native-root',
            title: 'Native root',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }
        },
        async promptSession(input) {
          prompted.push(input.messageId || 'anonymous')
        },
        async abortSession(input) {
          aborted.push(input.sessionId)
          await recoveryGate
        },
        subscribeEvents(listener, options) {
          emitInnerEvent = listener
          emitInnerProgress = options?.onProgress || null
          return () => {
            emitInnerEvent = null
            emitInnerProgress = null
          }
        },
        async close() {},
      } satisfies CloudRuntimeAdapter
    },
  })

  const context = {
    tenantId: 'tenant-a',
    sessionId: 'cowork-watchdog',
    lease: { owner: 'worker-a', epoch: 'lease-digest-a' },
  }
  try {
    await runtime.subscribeEvents?.((event) => { projected.push(event) }, {
      onProgress(event) { progress.push(event) },
    })
    await runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root',
      parts: [],
      agent: 'build',
      messageId: 'run-1',
      context,
    }))
    assert.ok(emitInnerProgress)
    emitInnerProgress!({
      source: 'durable_sequence',
      disposition: 'running',
      sequence: 7,
      semanticKey: 'session.next.reasoning.delta',
      observedAtMs: 100,
      runtimeSessionId: 'native-root',
    })
    const rootProgressCount = progress.length
    emitInnerProgress!({
      source: 'terminal',
      disposition: 'terminal',
      semanticKey: 'session.idle:child',
      observedAtMs: 101,
      runtimeSessionId: 'native-child',
    })
    assert.equal(progress.length, rootProgressCount, 'a delegated child terminal must not settle the root watchdog')
    emitInnerProgress!({
      source: 'durable_sequence',
      disposition: 'running',
      sequence: 100,
      semanticKey: 'child:100',
      observedAtMs: 102,
      runtimeSessionId: 'native-child',
    })
    emitInnerProgress!({
      source: 'durable_sequence',
      disposition: 'running',
      sequence: 8,
      semanticKey: 'root:8',
      observedAtMs: 103,
      runtimeSessionId: 'native-root',
    })
    assert.deepEqual(progress.slice(-2).map((event) => event.sequence), [null, 8], 'child aggregate cursors must not poison the root sequence')
    assert.ok(emitInnerEvent)
    await emitInnerEvent!({
      type: 'assistant.message',
      payload: { sessionId: 'native-root', messageId: 'm1', content: 'hello' },
    })

    const provenance = progress[0]?.provenance
    assert.ok(provenance)
    assert.equal(provenance.scopeId, 'tenant-a')
    assert.equal(provenance.sessionId, 'cowork-watchdog')
    assert.equal(provenance.runId, 'run-1')
    assert.equal(provenance.runtimeGeneration, 1)
    assert.equal(provenance.executionGeneration, 1)
    assert.deepEqual(
      { owner: provenance.leaseOwner, epoch: provenance.leaseEpoch },
      context.lease,
    )
    assert.deepEqual(projected[0]?.provenance, provenance)
    assert.equal(runtime.isRuntimeGenerationCurrent?.({
      context,
      expected: {
        runtimeGeneration: provenance.runtimeGeneration,
        executionGeneration: provenance.executionGeneration,
        runId: provenance.runId,
      },
    }), true)

    const stale = await runtime.recoverStalledSession?.({
      sessionId: 'native-root',
      context,
      expected: {
        runtimeGeneration: 999,
        executionGeneration: 1,
        runId: 'run-1',
      },
      isDecisionCurrent: () => true,
    })
    assert.equal(stale, 'fenced-stale')
    assert.deepEqual(aborted, [])
    assert.equal(provisions, 1)

    const wrongLease = await runtime.recoverStalledSession?.({
      sessionId: 'native-root',
      context: { ...context, lease: { ...context.lease, epoch: 'replacement-lease' } },
      expected: {
        runtimeGeneration: provenance.runtimeGeneration,
        executionGeneration: provenance.executionGeneration,
        runId: provenance.runId,
      },
      isDecisionCurrent: () => true,
    })
    assert.equal(wrongLease, 'fenced-stale')
    assert.deepEqual(aborted, [])

    const staleRevision = await runtime.recoverStalledSession?.({
      sessionId: 'native-root',
      context,
      expected: {
        runtimeGeneration: provenance.runtimeGeneration,
        executionGeneration: provenance.executionGeneration,
        runId: provenance.runId,
      },
      isDecisionCurrent: () => false,
    })
    assert.equal(staleRevision, 'fenced-stale')
    assert.deepEqual(aborted, [], 'the final watchdog revision fence must run at the abort boundary')

    const recoveryInput = {
      sessionId: 'native-root',
      context,
      expected: {
        runtimeGeneration: provenance.runtimeGeneration,
        executionGeneration: provenance.executionGeneration,
        runId: provenance.runId,
      },
      isDecisionCurrent: () => true,
    }
    const firstRecovery = runtime.recoverStalledSession?.(recoveryInput)
    const duplicateRecovery = runtime.recoverStalledSession?.(recoveryInput)
    const conflictingRecovery = runtime.recoverStalledSession?.({
      ...recoveryInput,
      context: { ...context, lease: { ...context.lease, epoch: 'conflicting-lease' } },
    })
    await Promise.resolve()
    assert.deepEqual(aborted, ['native-root'])
    const replacementPrompt = runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root',
      parts: [],
      agent: 'build',
      messageId: 'run-after-recovery',
      context,
    }))
    await Promise.resolve()
    assert.deepEqual(prompted, ['run-1'], 'replacement admission must wait for the exact old OpenCode abort')
    releaseRecovery()
    assert.deepEqual(await Promise.all([firstRecovery, duplicateRecovery]), ['recovered', 'recovered'])
    assert.equal(await conflictingRecovery, 'fenced-stale')
    await replacementPrompt
    assert.deepEqual(prompted, ['run-1', 'run-after-recovery'])
    assert.deepEqual(aborted, ['native-root'])
    await emitInnerEvent!({
      type: 'session.idle',
      payload: { sessionId: 'native-root' },
    })

    const missing = await runtime.recoverStalledSession?.({
      sessionId: 'missing-native',
      context: { ...context, sessionId: 'missing-cowork' },
      expected: {
        runtimeGeneration: 1,
        executionGeneration: 1,
        runId: 'missing-run',
      },
      isDecisionCurrent: () => true,
    })
    assert.equal(missing, 'fenced-stale')
    assert.equal(provisions, 1, 'watchdog recovery must never provision a missing runtime')

    unexpectedExits[0]?.()
    await runtime.withExecutionScope?.(context, () => runtime.promptSession({
      sessionId: 'native-root',
      parts: [],
      agent: 'build',
      messageId: 'run-2',
      context,
    }))
    emitInnerProgress?.({
      source: 'phase_transition',
      disposition: 'running',
      semanticKey: 'session.next.step.started',
      observedAtMs: 200,
      runtimeSessionId: 'native-root',
    })
    assert.equal(provisions, 2)
    const replacementProvenance = progress.at(-1)?.provenance
    assert.equal(replacementProvenance?.runtimeGeneration, 2)
    assert.equal(replacementProvenance?.executionGeneration, 1)
    assert.equal(runtime.isRuntimeGenerationCurrent?.({
      context,
      expected: {
        runtimeGeneration: provenance.runtimeGeneration,
        executionGeneration: provenance.executionGeneration,
        runId: provenance.runId,
      },
    }), false, 'a process-restart generation must reject events from the replaced runtime')

    const contextB = {
      tenantId: 'tenant-a',
      sessionId: 'cowork-watchdog-b',
      lease: { owner: 'worker-a', epoch: 'lease-digest-b' },
    }
    await runtime.withExecutionScope?.(contextB, () => runtime.promptSession({
      sessionId: 'native-root-b',
      parts: [],
      agent: 'build',
      messageId: 'run-b',
      context: contextB,
    }))
    emitInnerProgress?.({
      source: 'phase_transition',
      disposition: 'running',
      semanticKey: 'session.next.step.started',
      observedAtMs: 300,
      runtimeSessionId: 'native-root-b',
    })
    const sessionBProvenance = progress.at(-1)?.provenance
    assert.ok(sessionBProvenance)
    assert.equal(await runtime.recoverStalledSession?.({
      sessionId: 'native-root-b',
      context: contextB,
      expected: {
        runtimeGeneration: sessionBProvenance.runtimeGeneration,
        executionGeneration: sessionBProvenance.executionGeneration,
        runId: sessionBProvenance.runId,
      },
      isDecisionCurrent: () => true,
    }), 'recovered')
    assert.equal(aborted.at(-1), 'native-root-b')
    assert.equal(runtime.isRuntimeGenerationCurrent?.({
      context,
      expected: {
        runtimeGeneration: replacementProvenance!.runtimeGeneration,
        executionGeneration: replacementProvenance!.executionGeneration,
        runId: replacementProvenance!.runId,
      },
    }), true, 'recovering one session must not settle an unrelated runtime')
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})
