import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createUnavailableRuntimeAdapter } from '@open-cowork/cloud-server/unavailable-runtime-adapter'
import {
  createEnvelopeSecretAdapter,
  createUnavailableSecretAdapter,
  type SecretAdapter,
} from '@open-cowork/cloud-server/secret-adapter'
import type {
  CloudLogRecord,
  CloudMetricRecord,
  CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'

const TENANT_ID = 'workflow-secret-migration-tenant'
const USER_ID = 'workflow-secret-migration-user'
const SENTINEL = 'legacy-workflow-webhook-secret-sentinel-1234567890'
const ENVELOPE_KEY = 'workflow-secret-migration-key-material-1234567890'

type LegacyWorkflowWebhookSecret = {
  tenantId: string
  workflowId: string
  triggerId: string
  plaintext: string
  updatedAt: string
}

function seedLegacyWebhookSecret(
  store: InMemoryControlPlaneStore,
  input: Omit<LegacyWorkflowWebhookSecret, 'updatedAt'>,
) {
  const domain = (store as unknown as {
    workflowsDomain: {
      snapshot(): unknown
      restore(snapshot: unknown): void
    }
  }).workflowsDomain
  const snapshot = domain.snapshot() as {
    legacyWorkflowWebhookSecrets: Array<[string, LegacyWorkflowWebhookSecret]>
  }
  snapshot.legacyWorkflowWebhookSecrets.push([
    [input.tenantId, input.workflowId, input.triggerId].join('\0'),
    { ...input, updatedAt: new Date().toISOString() },
  ])
  domain.restore(snapshot)
}

function webhookSecretAad(tenantId: string, workflowId: string, triggerId: string) {
  return `workflow-webhook:${tenantId}:${workflowId}:${triggerId}`
}

function workflowService(
  store: InMemoryControlPlaneStore,
  secretAdapter: SecretAdapter,
  observability: CloudObservabilityAdapter | null = null,
) {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  return new CloudSessionService(
    store,
    createUnavailableRuntimeAdapter(),
    {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        webhooks: true,
      },
    },
    undefined,
    undefined,
    undefined,
    null,
    {},
    undefined,
    null,
    null,
    undefined,
    null,
    null,
    null,
    undefined,
    observability,
    secretAdapter,
  )
}

function legacyStore() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: TENANT_ID, name: 'Workflow migration' })
  store.ensureUser({
    tenantId: TENANT_ID,
    userId: USER_ID,
    email: 'workflow-migration@example.test',
  })
  store.createWorkflow({
    tenantId: TENANT_ID,
    userId: USER_ID,
    workflowId: 'legacy-workflow',
    draft: {
      title: 'Legacy workflow',
      instructions: 'Run safely.',
      agentName: 'build',
      skillNames: [],
      toolIds: [],
      steps: [],
      triggers: [{
        id: 'legacy-webhook',
        type: 'webhook',
        enabled: true,
      }],
    },
  })
  seedLegacyWebhookSecret(store, {
    tenantId: TENANT_ID,
    workflowId: 'legacy-workflow',
    triggerId: 'legacy-webhook',
    plaintext: SENTINEL,
  })
  return store
}

test('workflow secret migration fails closed when envelope encryption is unavailable', async () => {
  const store = legacyStore()
  const logs: CloudLogRecord[] = []
  const metrics: CloudMetricRecord[] = []
  const service = workflowService(
    store,
    createUnavailableSecretAdapter('fault injection: key provider unavailable'),
    {
      log(record) { logs.push(record) },
      metric(record) { metrics.push(record) },
      span() {},
    },
  )

  await assert.rejects(
    () => service.domains.workflows.migrateLegacyWebhookSecrets(),
    /migration failed; unprocessed legacy records remain unchanged/,
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 1)
  assert.equal(await store.getWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow'), null)
  assert.equal(JSON.stringify(await store.findWorkflow('legacy-workflow')).includes(SENTINEL), false)
  const failureLog = logs.find((record) => record.name === 'cloud.workflow_secrets.operation_failed')
  assert.deepEqual(failureLog?.attributes, {
    operation: 'legacy_migration_batch',
    status: 'error',
    migrated_records: 0,
  })
  assert.equal(JSON.stringify(logs).includes(SENTINEL), false)
  assert.equal(
    metrics.some((record) => (
      record.name === 'open_cowork_cloud_workflow_secret_operations_total'
      && record.value === 1
      && record.attributes?.operation === 'legacy_migration_batch'
      && record.attributes?.status === 'error'
    )),
    true,
  )
})

test('workflow secret migration is resumable, idempotent, and removes plaintext from public records', async () => {
  const store = legacyStore()
  const service = workflowService(
    store,
    createEnvelopeSecretAdapter(ENVELOPE_KEY),
  )

  assert.deepEqual(await service.domains.workflows.migrateLegacyWebhookSecrets(), { migrated: 1 })
  assert.deepEqual(await service.domains.workflows.migrateLegacyWebhookSecrets(), { migrated: 0 })
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
  const secret = await store.getWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow')
  assert.match(secret?.ciphertext || '', /^enc:v1:/)
  assert.equal(secret?.ciphertext.includes(SENTINEL), false)
  assert.equal(JSON.stringify(await store.findWorkflow('legacy-workflow')).includes(SENTINEL), false)
})

test('workflow secret migration keeps archived credentials revoked until explicit rotation', async () => {
  const store = legacyStore()
  await store.updateWorkflowStatus({
    tenantId: TENANT_ID,
    userId: USER_ID,
    workflowId: 'legacy-workflow',
    status: 'archived',
    nextRunAt: null,
  })
  seedLegacyWebhookSecret(store, {
    tenantId: TENANT_ID,
    workflowId: 'legacy-workflow',
    triggerId: 'legacy-webhook',
    plaintext: SENTINEL,
  })
  const service = workflowService(store, createEnvelopeSecretAdapter(ENVELOPE_KEY))
  const principal: CloudPrincipal = {
    tenantId: TENANT_ID,
    tenantName: 'Workflow migration',
    orgId: TENANT_ID,
    userId: USER_ID,
    accountId: USER_ID,
    email: 'workflow-migration@example.test',
    role: 'owner',
    authSource: 'local',
  }

  assert.deepEqual(
    await service.domains.workflows.migrateLegacyWebhookSecrets(),
    { migrated: 1 },
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
  const migrated = await store.getWorkflowWebhookSecret(
    TENANT_ID,
    'legacy-workflow',
    'legacy-webhook',
  )
  assert.equal(migrated?.status, 'revoked')
  assert.match(migrated?.ciphertext || '', /^enc:v1:/)
  assert.equal(migrated?.ciphertext.includes(SENTINEL), false)
  await assert.rejects(
    () => service.domains.workflows.updateWorkflowStatus(
      principal,
      'legacy-workflow',
      'active',
    ),
    /Rotate the workflow webhook secret before activating this workflow/,
  )

  const replacement = await service.domains.workflows.rotateWorkflowWebhookSecret(
    principal,
    'legacy-workflow',
  )
  assert.equal(typeof replacement?.webhookSecretReveal.secret, 'string')
  assert.equal((
    await service.domains.workflows.updateWorkflowStatus(
      principal,
      'legacy-workflow',
      'active',
    )
  )?.status, 'active')
})

test('workflow secret migration resumes after a partial batch encryption failure', async () => {
  const store = legacyStore()
  store.createWorkflow({
    tenantId: TENANT_ID,
    userId: USER_ID,
    workflowId: 'legacy-workflow-two',
    draft: {
      title: 'Second legacy workflow',
      instructions: 'Resume this migration.',
      agentName: 'build',
      triggers: [{
        id: 'legacy-webhook-two',
        type: 'webhook',
        enabled: true,
      }],
    },
  })
  seedLegacyWebhookSecret(store, {
    tenantId: TENANT_ID,
    workflowId: 'legacy-workflow-two',
    triggerId: 'legacy-webhook-two',
    plaintext: `${SENTINEL}-two`,
  })
  const envelope = createEnvelopeSecretAdapter(ENVELOPE_KEY)
  let protectCalls = 0
  const interrupted: SecretAdapter = {
    mode: 'envelope-v1',
    protect(plaintext, context) {
      protectCalls += 1
      if (protectCalls === 2) throw new Error('fault injection after one record')
      return envelope.protect(plaintext, context)
    },
    reveal: envelope.reveal,
  }

  await assert.rejects(
    () => workflowService(store, interrupted).domains.workflows.migrateLegacyWebhookSecrets(),
    /migration failed; unprocessed legacy records remain unchanged/,
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 1)
  const migratedBeforeRetry = [
    await store.getWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow'),
    await store.getWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow-two'),
  ].filter(Boolean)
  assert.equal(migratedBeforeRetry.length, 1)

  assert.deepEqual(
    await workflowService(store, envelope).domains.workflows.migrateLegacyWebhookSecrets(),
    { migrated: 1 },
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
})

test('workflow migration re-encrypts legacy plaintext with the current adapter without revealing the existing envelope', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: TENANT_ID, name: 'Workflow migration' })
  store.ensureUser({
    tenantId: TENANT_ID,
    userId: USER_ID,
    email: 'workflow-migration@example.test',
  })
  const previousKey = 'previous-workflow-secret-key-material-2468013579'
  const envelope = createEnvelopeSecretAdapter(ENVELOPE_KEY, [previousKey])
  const existingCiphertext = createEnvelopeSecretAdapter(previousKey).protect(
    'existing-active-webhook-secret',
    webhookSecretAad(TENANT_ID, 'partially-migrated-workflow', 'legacy-webhook'),
  )
  store.createWorkflow({
    tenantId: TENANT_ID,
    userId: USER_ID,
    workflowId: 'partially-migrated-workflow',
    draft: {
      title: 'Partially migrated workflow',
      instructions: 'Finish migration safely.',
      agentName: 'build',
      triggers: [{
        id: 'legacy-webhook',
        type: 'webhook',
        enabled: true,
      }],
    },
    webhookSecrets: [{
      triggerId: 'legacy-webhook',
      ciphertext: existingCiphertext,
      envelopeVersion: 1,
    }],
  })
  seedLegacyWebhookSecret(store, {
    tenantId: TENANT_ID,
    workflowId: 'partially-migrated-workflow',
    triggerId: 'legacy-webhook',
    plaintext: SENTINEL,
  })
  let revealCalls = 0
  const migrationAdapter: SecretAdapter = {
    mode: 'envelope-v1',
    protect: envelope.protect,
    reveal() {
      revealCalls += 1
      throw new Error('migration must not reveal existing ciphertext')
    },
  }
  const service = workflowService(store, migrationAdapter)

  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 1)
  assert.deepEqual(await service.domains.workflows.migrateLegacyWebhookSecrets(), { migrated: 1 })
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
  const migrated = await store.getWorkflowWebhookSecret(TENANT_ID, 'partially-migrated-workflow')
  assert.notEqual(migrated?.ciphertext, existingCiphertext)
  assert.equal(
    envelope.reveal(
      migrated?.ciphertext || '',
      webhookSecretAad(TENANT_ID, 'partially-migrated-workflow', 'legacy-webhook'),
    ),
    SENTINEL,
  )
  assert.equal(revealCalls, 0)
})

function storeWithLegacyResidueAndCiphertext(ciphertext: string) {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: TENANT_ID, name: 'Workflow migration' })
  store.ensureUser({
    tenantId: TENANT_ID,
    userId: USER_ID,
    email: 'workflow-migration@example.test',
  })
  store.createWorkflow({
    tenantId: TENANT_ID,
    userId: USER_ID,
    workflowId: 'residue-validation-workflow',
    draft: {
      title: 'Residue validation',
      instructions: 'Keep plaintext until ciphertext is proven usable.',
      agentName: 'build',
      triggers: [{ id: 'legacy-webhook', type: 'webhook', enabled: true }],
    },
    webhookSecrets: [{
      triggerId: 'legacy-webhook',
      ciphertext,
      envelopeVersion: 1,
    }],
  })
  seedLegacyWebhookSecret(store, {
    tenantId: TENANT_ID,
    workflowId: 'residue-validation-workflow',
    triggerId: 'legacy-webhook',
    plaintext: SENTINEL,
  })
  return store
}

for (const scenario of [
  {
    name: 'invalid envelope',
    ciphertext: 'enc:v1:corrupt-envelope',
  },
  {
    name: 'retired key id',
    ciphertext: createEnvelopeSecretAdapter('retired-workflow-secret-key-material-0987654321').protect(
      'existing-active-webhook-secret',
      webhookSecretAad(TENANT_ID, 'residue-validation-workflow', 'legacy-webhook'),
    ),
  },
  {
    name: 'temporarily unavailable reveal provider',
    ciphertext: createEnvelopeSecretAdapter(ENVELOPE_KEY).protect(
      'existing-active-webhook-secret',
      webhookSecretAad(TENANT_ID, 'residue-validation-workflow', 'legacy-webhook'),
    ),
  },
] as const) {
  test(`workflow migration replaces an existing ${scenario.name} when current protection works`, async () => {
    const store = storeWithLegacyResidueAndCiphertext(scenario.ciphertext)
    const current = createEnvelopeSecretAdapter(ENVELOPE_KEY)
    let protectCalls = 0
    let revealCalls = 0
    const adapter: SecretAdapter = {
      mode: 'envelope-v1',
      protect(plaintext, context) {
        protectCalls += 1
        return current.protect(plaintext, context)
      },
      reveal() {
        revealCalls += 1
        throw new Error('migration must not reveal an existing ciphertext')
      },
    }

    assert.deepEqual(
      await workflowService(store, adapter).domains.workflows.migrateLegacyWebhookSecrets(),
      { migrated: 1 },
    )
    assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
    const migrated = await store.getWorkflowWebhookSecret(TENANT_ID, 'residue-validation-workflow')
    assert.notEqual(migrated?.ciphertext, scenario.ciphertext)
    assert.equal(
      current.reveal(
        migrated?.ciphertext || '',
        webhookSecretAad(TENANT_ID, 'residue-validation-workflow', 'legacy-webhook'),
      ),
      SENTINEL,
    )
    assert.equal(protectCalls, 1)
    assert.equal(revealCalls, 0)
  })
}

test('workflow migration preserves the existing ciphertext and last usable plaintext when current protection is unavailable', async () => {
  const existingCiphertext = createEnvelopeSecretAdapter(
    'retired-workflow-secret-key-material-0987654321',
  ).protect(
    'existing-active-webhook-secret',
    webhookSecretAad(TENANT_ID, 'residue-validation-workflow', 'legacy-webhook'),
  )
  const store = storeWithLegacyResidueAndCiphertext(existingCiphertext)
  const legacyBefore = await store.getLegacyWorkflowWebhookSecret(
    TENANT_ID,
    'residue-validation-workflow',
    'legacy-webhook',
  )
  const ciphertextBefore = await store.getWorkflowWebhookSecret(
    TENANT_ID,
    'residue-validation-workflow',
    'legacy-webhook',
  )

  await assert.rejects(
    () => workflowService(
      store,
      createUnavailableSecretAdapter('fault injection: current key provider unavailable'),
    ).domains.workflows.migrateLegacyWebhookSecrets(),
    /migration failed; unprocessed legacy records remain unchanged/,
  )

  assert.deepEqual(
    await store.getLegacyWorkflowWebhookSecret(
      TENANT_ID,
      'residue-validation-workflow',
      'legacy-webhook',
    ),
    legacyBefore,
  )
  assert.deepEqual(
    await store.getWorkflowWebhookSecret(
      TENANT_ID,
      'residue-validation-workflow',
      'legacy-webhook',
    ),
    ciphertextBefore,
  )
  assert.deepEqual(Buffer.from(legacyBefore?.plaintext || ''), Buffer.from(SENTINEL))
})

test('workflow migration fails closed when a batch cannot make progress', async () => {
  const store = legacyStore()
  store.migrateLegacyWorkflowWebhookSecret = () => false
  const service = workflowService(
    store,
    createEnvelopeSecretAdapter(ENVELOPE_KEY),
  )

  await assert.rejects(
    () => service.domains.workflows.migrateLegacyWebhookSecrets(),
    /could not make progress; legacy records remain unchanged/,
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 1)
})

test('workflow migration retries one unchanged batch after a concurrent write race', async () => {
  const store = legacyStore()
  const migrate = store.migrateLegacyWorkflowWebhookSecret.bind(store)
  let raced = false
  store.migrateLegacyWorkflowWebhookSecret = (input) => {
    if (!raced) {
      raced = true
      return false
    }
    return migrate(input)
  }

  assert.deepEqual(
    await workflowService(
      store,
      createEnvelopeSecretAdapter(ENVELOPE_KEY),
    ).domains.workflows.migrateLegacyWebhookSecrets(),
    { migrated: 1 },
  )
  assert.equal((await store.listLegacyWorkflowWebhookSecrets()).length, 0)
})

test('anonymous webhook compatibility migration is bounded to its exact tenant workflow trigger', async () => {
  const store = legacyStore()
  const unrelatedTenantId = 'workflow-secret-unrelated-tenant'
  const unrelatedUserId = 'workflow-secret-unrelated-user'
  store.createTenant({ tenantId: unrelatedTenantId, name: 'Unrelated tenant' })
  store.ensureUser({
    tenantId: unrelatedTenantId,
    userId: unrelatedUserId,
    email: 'unrelated-workflow@example.test',
  })
  store.createWorkflow({
    tenantId: unrelatedTenantId,
    userId: unrelatedUserId,
    workflowId: 'unrelated-legacy-workflow',
    draft: {
      title: 'Unrelated legacy workflow',
      instructions: 'Do not migrate from another tenant webhook request.',
      agentName: 'build',
      triggers: [{ id: 'unrelated-webhook', type: 'webhook', enabled: true }],
    },
  })
  seedLegacyWebhookSecret(store, {
    tenantId: unrelatedTenantId,
    workflowId: 'unrelated-legacy-workflow',
    triggerId: 'unrelated-webhook',
    plaintext: `${SENTINEL}-unrelated`,
  })
  const service = workflowService(store, createEnvelopeSecretAdapter(ENVELOPE_KEY))

  await assert.rejects(
    () => service.domains.workflows.runWorkflowWebhook({
      workflowId: 'legacy-workflow',
      auth: {
        kind: 'signature',
        timestamp: new Date().toISOString(),
        signature: 'invalid-signature',
        rawBody: '{}',
      },
      payload: {},
      securityStore: {
        claimRequest: () => true,
        checkAuthBackoff: () => true,
        recordAuthFailure: () => ({
          authWindowStartedAt: 0,
          authFailureCount: 1,
          blockedUntil: 0,
        }),
        claimSignature: () => null,
        clear() {},
      },
    }),
    /authorization failed/,
  )

  assert.equal(
    await store.getLegacyWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow', 'legacy-webhook'),
    null,
  )
  assert.ok(await store.getWorkflowWebhookSecret(TENANT_ID, 'legacy-workflow', 'legacy-webhook'))
  assert.ok(await store.getLegacyWorkflowWebhookSecret(
    unrelatedTenantId,
    'unrelated-legacy-workflow',
    'unrelated-webhook',
  ))
  assert.equal(
    await store.getWorkflowWebhookSecret(
      unrelatedTenantId,
      'unrelated-legacy-workflow',
      'unrelated-webhook',
    ),
    null,
  )
})

test('workflow creation refuses plaintext persistence when encryption is unavailable', async () => {
  const store = legacyStore()
  const service = workflowService(
    store,
    createUnavailableSecretAdapter('fault injection: key provider unavailable'),
  )

  await assert.rejects(
    () => service.domains.workflows.createWorkflow({
      tenantId: TENANT_ID,
      tenantName: 'Workflow migration',
      orgId: TENANT_ID,
      userId: USER_ID,
      accountId: USER_ID,
      email: 'workflow-migration@example.test',
      role: 'owner',
      authSource: 'local',
    }, {
      title: 'Must not persist',
      instructions: 'Fail before writing.',
      agentName: 'build',
      triggers: [{ id: 'new-webhook', type: 'webhook', enabled: true }],
    }),
    /require envelope-encrypted Cloud secret storage/,
  )
  assert.equal((await store.listWorkflows(TENANT_ID, USER_ID)).some((workflow) => workflow.title === 'Must not persist'), false)
})

test('workflow secret lookup remains tenant-scoped when workflow ids collide', async () => {
  const store = new InMemoryControlPlaneStore()
  for (const [tenantId, userId, ciphertext] of [
    ['tenant-a', 'user-a', 'enc:v1:tenant-a-ciphertext'],
    ['tenant-b', 'user-b', 'enc:v1:tenant-b-ciphertext'],
  ] as const) {
    store.createTenant({ tenantId, name: tenantId })
    store.ensureUser({ tenantId, userId, email: `${userId}@example.test` })
    store.createWorkflow({
      tenantId,
      userId,
      workflowId: 'shared-workflow-id',
      draft: {
        title: `${tenantId} workflow`,
        instructions: 'Remain tenant scoped.',
        agentName: 'build',
        triggers: [{ id: 'shared-webhook-id', type: 'webhook', enabled: true }],
      },
      webhookSecrets: [{
        triggerId: 'shared-webhook-id',
        ciphertext,
        envelopeVersion: 1,
      }],
    })
  }

  assert.equal(
    (await store.getWorkflowWebhookSecret('tenant-a', 'shared-workflow-id'))?.ciphertext,
    'enc:v1:tenant-a-ciphertext',
  )
  assert.equal(
    (await store.getWorkflowWebhookSecret('tenant-b', 'shared-workflow-id'))?.ciphertext,
    'enc:v1:tenant-b-ciphertext',
  )
  assert.equal(await store.getWorkflowWebhookSecret('tenant-c', 'shared-workflow-id'), null)
})
