import test from 'node:test'
import assert from 'node:assert/strict'

import { createByokSecretStore } from '../apps/desktop/src/main/cloud/byok-secret-store.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import { createEnvelopeSecretAdapter } from '../apps/desktop/src/main/cloud/secret-adapter.ts'

const FIRST_KEY = 'credential-sample-first-1234567890'
const SECOND_KEY = 'credential-sample-second-abcdefghi'
const VALIDATION_KEY = ['sk', 'validation', 'secret', '1234567890abcdef'].join('-')
const CUSTOM_VALIDATION_KEY = 'custom-provider-key'

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
    validators: { anthropic: () => true },
  })

  const first = await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'Anthropic',
    plaintext: FIRST_KEY,
    createdByAccountId: 'owner-1',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(first.providerId, 'anthropic')
  assert.equal(first.status, 'pending_validation')
  assert.equal(first.last4, '7890')
  const validatedFirst = await byok.validateActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' })
  assert.equal(validatedFirst?.status, 'active')
  assert.equal(await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' }), FIRST_KEY)
  const revealAudit = await store.listAuditEvents('tenant-1')
  const revealed = revealAudit.find((event) => event.eventType === 'byok_secret.revealed')
  assert.equal(revealed?.targetType, 'byok_secret')
  assert.equal(revealed?.metadata.providerId, 'anthropic')
  assert.equal(JSON.stringify(revealed).includes(FIRST_KEY), false)

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
  assert.equal(second.status, 'pending_validation')
  assert.equal(second.last4, 'fghi')
  const validatedSecond = await byok.validateActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' })
  assert.equal(validatedSecond?.status, 'active')
  assert.equal(await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' }), SECOND_KEY)

  const records = await store.listByokSecrets('tenant-1')
  assert.equal(records.length, 2)
  assert.equal(records.filter((record) => record.providerId === 'anthropic' && record.status === 'active').length, 1)
  assert.equal(records.find((record) => record.secretId === first.secretId)?.status, 'disabled')
  assert.equal(records.find((record) => record.secretId === second.secretId)?.rotatedFromSecretId, first.secretId)

  const audit = await store.listAuditEvents('tenant-1')
  const rotationAudit = audit.find((event) => event.eventType === 'byok_secret.rotated')
  assert.equal(rotationAudit?.actorType, 'system')
  assert.equal(rotationAudit?.targetType, 'byok_secret')
  assert.equal(rotationAudit?.targetId, second.secretId)
  assert.equal(rotationAudit?.metadata.rotatedFromSecretId, '[redacted]')
})

test('BYOK disable prevents active reveal', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-disable' },
    validators: { openai: () => true },
  })

  await byok.setSecret({ orgId: 'tenant-1', providerId: 'openai', plaintext: FIRST_KEY })
  await byok.validateActiveSecret({ orgId: 'tenant-1', providerId: 'openai' })
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
    validators: { anthropic: () => true },
  })

  await byok.setSecret({ orgId: 'tenant-1', providerId: 'anthropic', plaintext: FIRST_KEY })
  await byok.validateActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' })
  const source = await store.getActiveByokSecret('tenant-1', 'anthropic')
  assert.ok(source?.ciphertext)

  await store.createByokSecret({
    secretId: 'byok_copied_ciphertext',
    orgId: 'tenant-2',
    providerId: 'anthropic',
    ciphertext: source.ciphertext,
    last4: source.last4,
    keyFingerprint: source.keyFingerprint,
    status: 'active',
  })
  await store.recordByokSecretValidation({
    orgId: 'tenant-2',
    providerId: 'anthropic',
    secretId: 'byok_copied_ciphertext',
    status: 'active',
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

test('BYOK secrets remain inactive without a provider validator until audited override', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-unsupported' },
  })

  const created = await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'unknown-provider',
    plaintext: FIRST_KEY,
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(created.status, 'pending_validation')
  await assert.rejects(
    () => byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'unknown-provider' }),
    /No active BYOK secret/,
  )

  const unsupported = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'unknown-provider',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(unsupported?.status, 'unsupported')
  assert.match(unsupported?.validationError || '', /No BYOK validator/)

  const overridden = await byok.activateWithoutValidation({
    orgId: 'tenant-1',
    providerId: 'unknown-provider',
    reason: `manual provider smoke test ${FIRST_KEY}`,
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(overridden?.status, 'active')
  assert.equal(typeof overridden?.lastValidatedAt, 'string')
  assert.equal(await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'unknown-provider' }), FIRST_KEY)

  const auditPayload = JSON.stringify(await store.listAuditEvents('tenant-1'))
  assert.equal(auditPayload.includes(FIRST_KEY), false)
  assert.match(auditPayload, /byok_secret.validation_override/)
  assert.match(auditPayload, /\[redacted\]/)
})

test('BYOK disable revokes non-active provider secrets', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-disable-unsupported' },
  })

  await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'unknown-provider',
    plaintext: CUSTOM_VALIDATION_KEY,
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  const unsupported = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'unknown-provider',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(unsupported?.status, 'unsupported')

  const disabled = await byok.disableSecret({ orgId: 'tenant-1', providerId: 'unknown-provider' })
  assert.equal(disabled?.status, 'disabled')
  assert.equal((await byok.getMetadata('tenant-1', 'unknown-provider'))?.status, 'disabled')
  assert.equal((await store.listByokSecrets('tenant-1')).filter((record) => record.status !== 'disabled').length, 0)
  assert.equal(JSON.stringify(await store.listAuditEvents('tenant-1')).includes(CUSTOM_VALIDATION_KEY), false)
})

test('BYOK provider validation hooks mark active and invalid without leaking raw provider errors', async () => {
  const store = seededStore()
  let shouldPass = true
  let observedPlaintext = ''
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-validation' },
    validators: {
      anthropic(input) {
        observedPlaintext = input.plaintext
        return shouldPass
          ? { valid: true }
          : { valid: false, error: `provider rejected ${input.plaintext}` }
      },
    },
  })

  await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    plaintext: VALIDATION_KEY,
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })

  const active = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(observedPlaintext, VALIDATION_KEY)
  assert.equal(active?.status, 'active')
  assert.equal(active?.validationError, null)

  shouldPass = false
  const invalid = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(invalid?.status, 'invalid')
  assert.equal(invalid?.validationError?.includes(VALIDATION_KEY), false)
  assert.match(invalid?.validationError || '', /\[redacted\]/)

  const auditPayload = JSON.stringify(await store.listAuditEvents('tenant-1'))
  assert.equal(auditPayload.includes(VALIDATION_KEY), false)
  assert.match(auditPayload, /\[redacted\]/)
})

test('BYOK provider validation redacts exact plaintext even when it is not token-shaped', async () => {
  const store = seededStore()
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-short-redaction' },
    validators: {
      custom(input) {
        throw new Error(`provider echoed ${input.plaintext}`)
      },
    },
  })

  await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'custom',
    plaintext: CUSTOM_VALIDATION_KEY,
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  const invalid = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'custom',
    actor: { actorType: 'user', actorId: 'owner-1', accountId: 'owner-1' },
  })
  assert.equal(invalid?.status, 'invalid')
  assert.equal(invalid?.validationError?.includes(CUSTOM_VALIDATION_KEY), false)
  assert.match(invalid?.validationError || '', /\[redacted\]/)
  assert.equal(JSON.stringify(await store.listAuditEvents('tenant-1')).includes(CUSTOM_VALIDATION_KEY), false)
})

test('BYOK KMS references reveal only through explicit worker-authorized paths', async () => {
  const store = seededStore()
  const kmsPlaintext = 'credential-kms-backed-1234567890'
  let resolvedRef = ''
  const byok = createByokSecretStore(store, createEnvelopeSecretAdapter('unit-test-byok-key'), {
    ids: { randomUUID: () => 'secret-kms' },
    kmsRefResolver(input) {
      resolvedRef = input.kmsRef
      assert.equal(input.orgId, 'tenant-1')
      assert.equal(input.providerId, 'anthropic')
      assert.equal(input.secretId, 'byok_secret-kms')
      return kmsPlaintext
    },
    validators: {
      anthropic(input) {
        return input.plaintext === kmsPlaintext
      },
    },
  })

  const created = await byok.setSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    kmsRef: 'gcp-sm://projects/acme/secrets/anthropic/versions/latest',
  })
  assert.equal(created.status, 'pending_validation')
  assert.equal(JSON.stringify(created).includes(kmsPlaintext), false)

  await assert.rejects(
    () => byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' }),
    /No active BYOK secret/,
  )
  const pending = await byok.validateActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic' })
  assert.equal(pending?.status, 'pending_validation')

  const validated = await byok.validateActiveSecret({
    orgId: 'tenant-1',
    providerId: 'anthropic',
    allowKmsRef: true,
  })
  assert.equal(validated?.status, 'active')
  assert.equal(
    await byok.revealActiveSecret({ orgId: 'tenant-1', providerId: 'anthropic', allowKmsRef: true }),
    kmsPlaintext,
  )
  assert.equal(resolvedRef, 'gcp-sm://projects/acme/secrets/anthropic/versions/latest')
})
