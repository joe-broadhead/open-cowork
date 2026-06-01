import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, type OpenCoworkConfig } from '../apps/desktop/src/main/config-types.ts'
import { createByokSecretStore } from '../apps/desktop/src/main/cloud/byok-secret-store.ts'
import { resolveCloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import type { CloudObservabilityAdapter } from '../apps/desktop/src/main/cloud/observability.ts'
import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeExecutionContext,
  CloudRuntimePromptPart,
} from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { createEnvelopeSecretAdapter } from '../apps/desktop/src/main/cloud/secret-adapter.ts'
import { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'
import { CloudWorker } from '../apps/desktop/src/main/cloud/worker.ts'
import { createWorkerScopedRuntimeAdapter, type WorkerScopedRuntimeFactoryInput } from '../apps/desktop/src/main/cloud/worker-scoped-runtime-adapter.ts'

const KEY_A = ['credential', 'tenant-a', 'runtime', '1234567890abcdef'].join('-')
const KEY_B = ['credential', 'tenant-b', 'runtime', 'abcdef1234567890'].join('-')

const BYOK_TEST_CONFIG: OpenCoworkConfig = {
  ...DEFAULT_CONFIG,
  providers: {
    ...DEFAULT_CONFIG.providers,
    available: ['openrouter'],
    defaultProvider: 'openrouter',
    defaultModel: 'openrouter/test-model',
    descriptors: {
      openrouter: {
        runtime: 'builtin',
        name: 'OpenRouter',
        description: 'OpenRouter test provider',
        credentials: [{
          key: 'apiKey',
          label: 'API key',
          description: 'Provider API key',
          secret: true,
          required: true,
        }],
        models: [{ id: 'test-model', name: 'Test model' }],
      },
    },
    custom: {},
  },
}

function principal(tenantId: string, userId: string) {
  return {
    tenantId,
    orgId: tenantId,
    tenantName: tenantId,
    userId,
    accountId: userId,
    email: `${userId}@example.test`,
    role: 'owner' as const,
    authSource: 'local' as const,
  }
}

class ConfigBackedRuntime implements CloudRuntimeAdapter {
  readonly context: CloudRuntimeExecutionContext
  readonly apiKey: string
  prompts: Array<{ sessionId: string, parts: CloudRuntimePromptPart[], agent: string }> = []

  constructor(input: WorkerScopedRuntimeFactoryInput) {
    this.context = input.execution
    const provider = input.runtimeConfig?.provider as Record<string, { options?: Record<string, unknown> }> | undefined
    this.apiKey = String(provider?.openrouter?.options?.apiKey || '')
  }

  async createSession() {
    return {
      id: `runtime-${this.context.tenantId}-${this.context.sessionId}`,
      title: 'Runtime session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    this.prompts.push(input)
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          sessionId: input.sessionId,
          messageId: `${input.sessionId}:assistant`,
          content: `used-byok:${this.apiKey.slice(-4)}`,
        },
      }],
    }
  }

  async abortSession() {}
}

class ClosableRuntime implements CloudRuntimeAdapter {
  readonly context: CloudRuntimeExecutionContext
  readonly onClose: (sessionId: string) => void

  constructor(input: WorkerScopedRuntimeFactoryInput, onClose: (sessionId: string) => void) {
    this.context = input.execution
    this.onClose = onClose
  }

  async createSession() {
    return {
      id: `runtime-${this.context.sessionId}`,
      title: 'Runtime session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession() {
    return { events: [] }
  }

  async abortSession() {}

  async close() {
    this.onClose(this.context.sessionId)
  }
}

function seededStore() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  store.ensureUser({ tenantId: 'tenant-a', userId: 'user-a', email: 'user-a@example.test', role: 'owner' })
  store.createTenant({ tenantId: 'tenant-b', name: 'Tenant B' })
  store.ensureUser({ tenantId: 'tenant-b', userId: 'user-b', email: 'user-b@example.test', role: 'owner' })
  return store
}

test('worker-scoped BYOK runtime injects provider options for the correct tenant session without env leakage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-byok-runtime-'))
  const store = seededStore()
  let nextId = 0
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-runtime-test-key'), {
    ids: { randomUUID: () => `secret-${nextId += 1}` },
    validators: { openrouter: () => true },
  })
  await byokSecrets.setSecret({ orgId: 'tenant-a', providerId: 'openrouter', plaintext: KEY_A })
  await byokSecrets.validateActiveSecret({ orgId: 'tenant-a', providerId: 'openrouter' })
  await byokSecrets.setSecret({ orgId: 'tenant-b', providerId: 'openrouter', plaintext: KEY_B })
  await byokSecrets.validateActiveSecret({ orgId: 'tenant-b', providerId: 'openrouter' })
  const captures: WorkerScopedRuntimeFactoryInput[] = []
  const runtimes: ConfigBackedRuntime[] = []
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    env: {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: 'stale-shell-value-must-not-be-used',
    },
    config: BYOK_TEST_CONFIG,
    byokSecrets,
    runtimeFactory(input) {
      captures.push(input)
      assert.equal(JSON.stringify(input.env).includes(KEY_A), false)
      assert.equal(JSON.stringify(input.env).includes(KEY_B), false)
      const next = new ConfigBackedRuntime(input)
      runtimes.push(next)
      return next
    },
  })
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    undefined,
    { randomUUID: () => `cowork-session-${nextId += 1}` },
    undefined,
    byokSecrets,
  )
  const worker = new CloudWorker(store, service, 'worker-a')

  try {
    const sessionA = await service.createSession(principal('tenant-a', 'user-a'))
    const sessionB = await service.createSession(principal('tenant-b', 'user-b'))
    assert.equal(captures.length, 0, 'session creation must not reveal BYOK credentials')

    await service.enqueuePrompt(principal('tenant-a', 'user-a'), sessionA.session.sessionId, { text: 'hello a', agent: 'build' })
    await service.enqueuePrompt(principal('tenant-b', 'user-b'), sessionB.session.sessionId, { text: 'hello b', agent: 'build' })
    assert.equal(captures.length, 0, 'web/control-plane prompt enqueue must not reveal BYOK credentials')

    assert.equal(await worker.processSessionCommands('tenant-a', sessionA.session.sessionId), 1)
    assert.equal(await worker.processSessionCommands('tenant-b', sessionB.session.sessionId), 1)

    assert.equal(captures[0]?.execution.tenantId, 'tenant-a')
    assert.equal(captures[0]?.execution.sessionId, sessionA.session.sessionId)
    assert.equal(runtimes[0]?.apiKey, KEY_A)
    assert.equal(captures[1]?.execution.tenantId, 'tenant-b')
    assert.equal(captures[1]?.execution.sessionId, sessionB.session.sessionId)
    assert.equal(runtimes[1]?.apiKey, KEY_B)

    const viewA = await service.getSessionView(principal('tenant-a', 'user-a'), sessionA.session.sessionId)
    const viewB = await service.getSessionView(principal('tenant-b', 'user-b'), sessionB.session.sessionId)
    assert.equal(viewA.projection.view.messages.at(-1)?.content, 'used-byok:cdef')
    assert.equal(viewB.projection.view.messages.at(-1)?.content, 'used-byok:7890')
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped runtime cache evicts least-recently-used idle runtimes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-cache-'))
  const store = seededStore()
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-runtime-test-key'))
  const created: string[] = []
  const closed: string[] = []
  const metrics: unknown[] = []
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) { metrics.push(record) },
    span() {},
  }
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    env: { PATH: process.env.PATH },
    config: DEFAULT_CONFIG,
    byokSecrets,
    observability,
    maxRuntimeEntries: 1,
    runtimeIdleTtlMs: 60_000,
    runtimeFactory(input) {
      created.push(input.execution.sessionId)
      return new ClosableRuntime(input, (sessionId) => closed.push(sessionId))
    },
  })

  try {
    await runtime.promptSession({
      sessionId: 'runtime-a',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-a' },
    })
    assert.deepEqual(created, ['session-a'])
    assert.deepEqual(closed, [])

    await runtime.promptSession({
      sessionId: 'runtime-b',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-b' },
    })
    assert.deepEqual(created, ['session-a', 'session-b'])
    assert.deepEqual(closed, ['session-a'])

    await runtime.promptSession({
      sessionId: 'runtime-b',
      parts: [],
      agent: 'build',
      context: { tenantId: 'tenant-a', sessionId: 'session-b' },
    })
    assert.deepEqual(created, ['session-a', 'session-b'])
    assert.equal(metrics.some((metric) => (
      (metric as Record<string, unknown>).name === 'open_cowork_cloud_runtime_cache_misses_total'
    )), true)
    assert.equal(metrics.some((metric) => (
      (metric as Record<string, unknown>).name === 'open_cowork_cloud_runtime_cache_hits_total'
    )), true)
    assert.equal(metrics.some((metric) => (
      (metric as Record<string, unknown>).name === 'open_cowork_cloud_runtime_cache_evictions_total'
      && ((metric as Record<string, unknown>).attributes as Record<string, unknown>)?.reason === 'max_entries'
    )), true)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
  assert.deepEqual(closed, ['session-a', 'session-b'])
})

test('worker-scoped BYOK runtime resolves KMS references only during worker config injection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-byok-runtime-kms-'))
  const store = seededStore()
  let nextId = 0
  const kmsKey = 'credential-kms-runtime-abcdef1234567890'
  let resolverCalls = 0
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-runtime-test-key'), {
    ids: { randomUUID: () => `secret-${nextId += 1}` },
    kmsRefResolver(input) {
      resolverCalls += 1
      assert.equal(input.orgId, 'tenant-a')
      assert.equal(input.providerId, 'openrouter')
      assert.equal(input.kmsRef, 'aws-sm://open-cowork/test/openrouter')
      return kmsKey
    },
  })
  await byokSecrets.setSecret({ orgId: 'tenant-a', providerId: 'openrouter', kmsRef: 'aws-sm://open-cowork/test/openrouter' })
  await byokSecrets.activateWithoutValidation({
    orgId: 'tenant-a',
    providerId: 'openrouter',
    reason: 'unit test uses explicit KMS override to exercise worker-only reveal',
  })
  await assert.rejects(
    () => byokSecrets.revealActiveSecret({ orgId: 'tenant-a', providerId: 'openrouter' }),
    /worker-authorized reveal path/,
  )

  const runtimes: ConfigBackedRuntime[] = []
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    env: { PATH: process.env.PATH },
    config: BYOK_TEST_CONFIG,
    byokSecrets,
    runtimeFactory(input) {
      assert.equal(JSON.stringify(input.env).includes(kmsKey), false)
      const next = new ConfigBackedRuntime(input)
      runtimes.push(next)
      return next
    },
  })
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    undefined,
    { randomUUID: () => `cowork-session-${nextId += 1}` },
    undefined,
    byokSecrets,
  )
  const worker = new CloudWorker(store, service, 'worker-kms')

  try {
    const session = await service.createSession(principal('tenant-a', 'user-a'))
    await service.enqueuePrompt(principal('tenant-a', 'user-a'), session.session.sessionId, { text: 'hello kms', agent: 'build' })
    assert.equal(resolverCalls, 0, 'web/control-plane operations must not resolve KMS refs')

    assert.equal(await worker.processSessionCommands('tenant-a', session.session.sessionId), 1)
    assert.equal(resolverCalls, 1)
    assert.equal(runtimes[0]?.apiKey, kmsKey)
    const view = await service.getSessionView(principal('tenant-a', 'user-a'), session.session.sessionId)
    assert.equal(view.projection.view.messages.at(-1)?.content, 'used-byok:7890')
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker-scoped BYOK runtime enforces provider policy before revealing active secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-byok-runtime-policy-'))
  const store = seededStore()
  let nextId = 0
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-runtime-test-key'), {
    ids: { randomUUID: () => `secret-${nextId += 1}` },
    validators: { openrouter: () => true },
  })
  await byokSecrets.setSecret({ orgId: 'tenant-a', providerId: 'openrouter', plaintext: KEY_A })
  await byokSecrets.validateActiveSecret({ orgId: 'tenant-a', providerId: 'openrouter' })
  let factoryCalls = 0
  const metrics: unknown[] = []
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) { metrics.push(record) },
    span() {},
  }
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    env: { PATH: process.env.PATH },
    config: BYOK_TEST_CONFIG,
    byokSecrets,
    byokPolicy: {
      allowedProviderIds: ['anthropic'],
      checkEntitlement() {
        throw new Error('entitlement checker should not run for an unavailable provider')
      },
    },
    observability,
    runtimeFactory() {
      factoryCalls += 1
      throw new Error('runtime factory should not be called')
    },
  })
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    undefined,
    { randomUUID: () => `cowork-session-${nextId += 1}` },
    undefined,
    byokSecrets,
  )
  const worker = new CloudWorker(store, service, 'worker-policy')

  try {
    const session = await service.createSession(principal('tenant-a', 'user-a'))
    await service.enqueuePrompt(principal('tenant-a', 'user-a'), session.session.sessionId, { text: 'hello policy', agent: 'build' })
    await assert.rejects(
      () => worker.processSessionCommands('tenant-a', session.session.sessionId),
      /not available for cloud BYOK execution/,
    )
    assert.equal(factoryCalls, 0)
    assert.equal(metrics.some((metric) => (
      (metric as Record<string, unknown>).name === 'open_cowork_cloud_byok_reveal_failures_total'
      && (((metric as Record<string, unknown>).attributes as Record<string, unknown>)?.reason === 'provider_not_allowed')
    )), true)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing or disabled required BYOK key fails before runtime spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-byok-runtime-missing-'))
  const store = seededStore()
  let nextId = 0
  const byokSecrets = createByokSecretStore(store, createEnvelopeSecretAdapter('byok-runtime-test-key'), {
    ids: { randomUUID: () => `secret-${nextId += 1}` },
    validators: { openrouter: () => true },
  })
  await byokSecrets.setSecret({ orgId: 'tenant-a', providerId: 'openrouter', plaintext: KEY_A })
  await byokSecrets.validateActiveSecret({ orgId: 'tenant-a', providerId: 'openrouter' })
  await byokSecrets.disableSecret({ orgId: 'tenant-a', providerId: 'openrouter' })
  let factoryCalls = 0
  const metrics: unknown[] = []
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) { metrics.push(record) },
    span() {},
  }
  const runtime = createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    env: { PATH: process.env.PATH },
    config: BYOK_TEST_CONFIG,
    byokSecrets,
    observability,
    runtimeFactory() {
      factoryCalls += 1
      throw new Error('runtime factory should not be called')
    },
  })
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(BYOK_TEST_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker', OPEN_COWORK_CLOUD_PROFILE: 'full' }),
    undefined,
    { randomUUID: () => `cowork-session-${nextId += 1}` },
    undefined,
    byokSecrets,
  )
  const worker = new CloudWorker(store, service, 'worker-a')

  try {
    const session = await service.createSession(principal('tenant-a', 'user-a'))
    await service.enqueuePrompt(principal('tenant-a', 'user-a'), session.session.sessionId, { text: 'hello', agent: 'build' })
    await assert.rejects(
      () => worker.processSessionCommands('tenant-a', session.session.sessionId),
      /requires an active BYOK credential/,
    )
    assert.equal(factoryCalls, 0)
    const events = await service.listEvents(principal('tenant-a', 'user-a'), session.session.sessionId)
    assert.equal(events.some((event) => (
      event.type === 'runtime.error'
      && JSON.stringify(event.payload).includes('requires an active BYOK credential')
    )), true)
    assert.equal(metrics.some((metric) => (
      (metric as Record<string, unknown>).name === 'open_cowork_cloud_byok_reveal_failures_total'
      && (((metric as Record<string, unknown>).attributes as Record<string, unknown>)?.reason === 'missing_required_byok')
    )), true)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})
