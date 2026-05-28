import test from 'node:test'
import assert from 'node:assert/strict'

import { createByokSecretStore } from '../apps/desktop/src/main/cloud/byok-secret-store.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import { createEnvelopeSecretAdapter } from '../apps/desktop/src/main/cloud/secret-adapter.ts'

const FIRST_KEY = 'credential-sample-first-1234567890'
const SECOND_KEY = 'credential-sample-second-abcdefghi'

function seededStore() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'owner-1', email: 'owner@example.test', role: 'owner' })
  store.createTenant({ tenantId: 'tenant-2', name: 'Other' })
  store.ensureUser({ tenantId: 'tenant-2', userId: 'owner-2', email: 'owner2@example.test', role: 'owner' })
  return store
}

test('BYOK secret store encrypts keys, returns metadata only, rotates active records, and reveals active plaintext', async () => {
  const store = seededStore()
  let nextId = 0
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => `secret-${nextId += 1}` },
  })

  const first = await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'Anthropic',
    plaintext: FIRST_KEY,
    createdByAccountId: 'owner-1',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(first.providerId, 'anthropic')
  assert.equal(first.status, 'active')
  assert.equal(first.last4, '7890')
  assert.equal(await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' }), FIRST_KEY)

  const rawFirst = await store.getActiveByokSecret('tenant-1', 'anthropic')
  assert.ok(rawFirst?.ciphertext)
  assert.notEqual(rawFirst.ciphertext, FIRST_KEY)
  assert.equal(JSON.stringify(first).includes(FIRST_KEY), false)
  assert.equal(JSON.stringify(await byok.listMetadata('tenant-1')).includes(FIRST_KEY), false)

  const second = await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    plaintext: SECOND_KEY,
    createdByAccountId: 'owner-1',
  })
  assert.equal(second.status, 'active')
  assert.equal(second.last4, 'fghi')
  assert.equal(await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' }), SECOND_KEY)

  const records = await store.listByokSecrets('tenant-1')
  assert.equal(records.length, 2)
  assert.equal(records.filter((record) => record.providerId === 'anthropic' && record.status === 'active').length, 1)
  assert.equal(records.find((record) => record.secretId === first.secretId)?.status, 'disabled')
  assert.equal(records.find((record) => record.secretId === second.secretId)?.rotatedFromSecretId, first.secretId)
})

test('BYOK disable prevents active reveal', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-disable' },
  })

  await byok.setSecret({ orgId: 'tenant-1', providerId: 'openai', plaintext: FIRST_KEY })
  const disabled = await byok.disableSecret({ orgId: 'tenant-1', providerId: 'openai' })
  assert.equal(disabled?.status, 'disabled')
  await assert.rejects(
    () => byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'openai' }),
    /No active BYOK secret/,
  )
})

test('BYOK ciphertext is bound to org provider and secret context', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-cross-org' },
  })

  await byok.setSecret({ orgId: 'tenant-1', providerId: 'anthropic', plaintext: FIRST_KEY })
  const source = await store.getActiveByokSecret('tenant-1', 'anthropic')
  assert.ok(source?.ciphertext)

  await store.createByokSecret({
    secretId: 'byok_copied_ciphertext',
    orgId: 'tenant-2',
    providerId: 'anthropic',
    ciphertext: source.ciphertext,
    last4: source.last4,
    keyFingerprint: source.keyFingerprint,
  })

  await assert.rejects(
    () => byok.revealActiveSecret({ orgId: 'tenant-2', providerId: 'anthropic' }),
    /authenticate|Unsupported state|bad decrypt|unable to authenticate/i,
  )
})

test('BYOK validation audit metadata is redacted', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-audit' },
  })

  const created = await byok.setSecret({ orgId: 'tenant-1', providerId: 'anthropic', plaintext: FIRST_KEY })
  await byok.recordValidation({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    secretId: created.secretId,
    status: 'invalid',
    validationError: `provider rejected ${FIRST_KEY}`,
  })

  const audit = await store.listAuditEvents('tenant-1')
  assert.equal(audit.some((event) => event.eventType === 'byok_secret.created'), true)
  assert.equal(audit.some((event) => event.eventType === 'byok_secret.validated'), true)
  assert.equal(JSON.stringify(audit).includes(FIRST_KEY), false)
  assert.match(JSON.stringify(audit), /\[redacted\]/)
})
