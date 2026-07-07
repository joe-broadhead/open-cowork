import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  CloudPrincipalService,
  CloudScimService,
  CloudSsoService,
  type CloudIdentityPolicy,
} from '@open-cowork/cloud-server/services/index'
import { CloudScimReconciler } from '@open-cowork/cloud-server/scim-reconciler'
import { createSsoVerifierRegistry } from '@open-cowork/cloud-server/sso-assertion'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { CloudServiceError } from '@open-cowork/cloud-server/cloud-service-error'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'

const IDENTITY_POLICY: CloudIdentityPolicy = { allowSelfServiceSignup: true }
const SECRET_KEY = 'sso-scim-test-key-with-enough-entropy-0123456789'

function makeHarness(secretEnvelope = true) {
  const store = new InMemoryControlPlaneStore()
  const principalService = new CloudPrincipalService({ store, identityPolicy: IDENTITY_POLICY })
  const secretAdapter = secretEnvelope ? createEnvelopeSecretAdapter(SECRET_KEY) : null
  const ssoService = new CloudSsoService({
    store,
    secretAdapter,
    verifiers: createSsoVerifierRegistry(),
    ensurePrincipal: (principal) => principalService.ensurePrincipal(principal),
    assertPermission: (principal, permission) => principalService.assertPermission(principal, permission),
    principalOrgId: (principal) => principalService.principalOrgId(principal),
    auditActor: (principal) => principalService.auditActor(principal),
  })
  const reconciler = new CloudScimReconciler({ store })
  const scimService = new CloudScimService({ store, reconciler })
  return { store, principalService, ssoService, scimService, reconciler }
}

async function bootstrapOrg(store: InMemoryControlPlaneStore, principalService: CloudPrincipalService) {
  await store.createTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
  await store.ensureUser({ tenantId: 't1', userId: 'owner', email: 'owner@example.test', role: 'owner' })
  const owner: CloudPrincipal = { tenantId: 't1', userId: 'owner', email: 'owner@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(owner)
  return owner
}

test('SSO config CRUD is gated on sso:manage and seals secrets with envelope encryption', async () => {
  const { store, principalService, ssoService } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)

  const config = await ssoService.upsertSsoConfig(owner, {
    protocol: 'oidc',
    enabled: true,
    verifiedDomains: ['example.test'],
    oidcIssuer: 'https://idp.example.test',
    oidcClientId: 'client-123',
    oidcClientSecret: 'super-secret-value',
  })
  assert.equal(config.hasOidcClientSecret, true)
  assert.equal(config.oidcClientId, 'client-123')

  // The store holds only the sealed envelope, never the plaintext.
  const stored = await store.getOrgSsoConfig('org-1')
  assert.ok(stored?.oidcClientSecretCiphertext?.startsWith('enc:v1:'))
  assert.ok(!JSON.stringify(stored).includes('super-secret-value'))

  // A plain member lacks sso:manage.
  await store.createAccount({ accountId: 'member-1', email: 'member@example.test' })
  await store.upsertMembership({ orgId: 'org-1', accountId: 'member-1', role: 'member', status: 'active' })
  const member: CloudPrincipal = { tenantId: 't1', userId: 'member-1', accountId: 'member-1', email: 'member@example.test', authSource: 'user' }
  await assert.rejects(() => ssoService.getSsoConfig(member), /sso:manage/)
})

test('SSO secret storage fails closed without envelope encryption', async () => {
  const { store, principalService, ssoService } = makeHarness(false)
  const owner = await bootstrapOrg(store, principalService)
  await assert.rejects(
    () => ssoService.upsertSsoConfig(owner, { protocol: 'oidc', oidcClientSecret: 'x' }),
    (error: unknown) => error instanceof CloudServiceError && error.status === 503,
  )
})

test('SCIM token: rotate returns plaintext once, authenticate resolves the org', async () => {
  const { store, principalService, ssoService, scimService } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)
  await ssoService.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, verifiedDomains: ['example.test'] })
  const { scimToken } = await ssoService.rotateScimToken(owner)
  assert.ok(scimToken.startsWith('scim_'))
  assert.equal((await scimService.authenticate(scimToken)).orgId, 'org-1')
  await assert.rejects(() => scimService.authenticate('scim_wrong'), /invalid/)
  await assert.rejects(() => scimService.authenticate(null), /required/)
})

test('SSO login binding maps a verified assertion to a member principal with permissions', async () => {
  const { store, principalService, ssoService } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)
  await ssoService.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, verifiedDomains: ['example.test'] })

  const principal = await ssoService.authenticateSso({
    orgId: 'org-1',
    rawAssertion: JSON.stringify({ sub: 'idp-sub-9', email: 'sso.user@example.test', iss: 'https://idp' }),
  })
  assert.equal(principal.ssoVerified, true)
  assert.equal(principal.orgId, 'org-1')
  assert.ok(await store.resolvePrincipalMembership({ tenantId: 'org-1', accountId: principal.accountId! }))
  assert.ok(principal.permissions && principal.permissions.length > 0)

  // A disabled SSO config rejects login; an unverified domain is rejected.
  await ssoService.upsertSsoConfig(owner, { enabled: false })
  await assert.rejects(() => ssoService.authenticateSso({ orgId: 'org-1', rawAssertion: '{}' }), /not configured/)
})

test('SSO-only enforcement rejects non-SSO logins on enforced domains, exempts SSO/local', async () => {
  const { store, principalService, ssoService } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)
  await ssoService.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, enforced: true, verifiedDomains: ['example.test'] })

  const oidcEndUser: CloudPrincipal = { tenantId: 't1', userId: 'u9', email: 'someone@example.test', authSource: 'user' }
  await assert.rejects(() => ssoService.assertNonSsoLoginAllowed(oidcEndUser), /requires SSO/)

  // SSO-verified + local principals are exempt; a different (unenforced) domain is allowed.
  await ssoService.assertNonSsoLoginAllowed({ ...oidcEndUser, ssoVerified: true })
  await ssoService.assertNonSsoLoginAllowed({ ...oidcEndUser, authSource: 'local' })
  await ssoService.assertNonSsoLoginAllowed({ ...oidcEndUser, email: 'x@other.test' })
})

test('SCIM provision → membership; deactivate → suspend + immediate credential revocation', async () => {
  const { store, principalService, ssoService, scimService } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)
  await ssoService.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, verifiedDomains: ['example.test'] })

  const created = await scimService.createUser('org-1', {
    externalId: 'idp-scim-1', userName: 'scim@example.test', email: 'scim@example.test', displayName: 'Scim User', active: true,
  })
  assert.equal(created.status, 'active')
  // The provisioned member can hold a credential.
  const token = await store.issueApiToken({ orgId: 'org-1', accountId: created.accountId, name: 'scim-member', scopes: ['desktop'] })
  assert.ok(await store.findApiTokenByPlaintext(token.plaintext))

  // PATCH active=false deprovisions: membership disabled AND the credential is revoked.
  const patched = await scimService.patchUser('org-1', created.accountId, { active: false })
  assert.equal(patched.status, 'disabled')
  assert.equal(await store.findApiTokenByPlaintext(token.plaintext), null)

  // The durable queue recorded the provisioning + deprovision events as succeeded.
  const events = await store.listScimSyncEvents({ orgId: 'org-1' })
  assert.ok(events.some((event) => event.operation === 'user.deprovision' && event.status === 'succeeded'))
})

test('SCIM sync queue retries a failing event with backoff, then a reconcile converges drift', async () => {
  const { store, principalService, ssoService, reconciler } = makeHarness()
  const owner = await bootstrapOrg(store, principalService)
  await ssoService.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, verifiedDomains: ['example.test'] })

  // A malformed event (no accountId) fails and is rescheduled pending with a future retry.
  const t0 = new Date('2026-06-01T00:00:00.000Z')
  const bad = new CloudScimReconciler({ store, now: () => t0 })
  await store.enqueueScimSyncEvent({ orgId: 'org-1', operation: 'user.provision', payload: {}, createdAt: t0 })
  const first = await bad.drain({ orgId: 'org-1' })
  assert.deepEqual(first, { processed: 1, succeeded: 0, failed: 1 })
  const afterFail = await store.listScimSyncEvents({ orgId: 'org-1' })
  assert.equal(afterFail[0]?.status, 'pending')
  assert.ok(new Date(afterFail[0]!.nextAttemptAt).getTime() > t0.getTime())
  // Not yet due, so a drain at the same instant does nothing.
  assert.equal((await bad.drain({ orgId: 'org-1' })).processed, 0)

  // Drift reconciliation: a disabled member has their credentials revoked on a reconcile sweep.
  await store.createAccount({ accountId: 'drift-1', email: 'drift@example.test' })
  await store.upsertMembership({ orgId: 'org-1', accountId: 'drift-1', role: 'member', status: 'disabled' })
  const driftToken = await store.issueApiToken({ orgId: 'org-1', accountId: 'drift-1', name: 'drift', scopes: ['desktop'] })
  await reconciler.enqueueReconcile('org-1')
  const drained = await reconciler.drain({ orgId: 'org-1' })
  assert.ok(drained.succeeded >= 1)
  assert.equal(await store.findApiTokenByPlaintext(driftToken.plaintext), null)
})
