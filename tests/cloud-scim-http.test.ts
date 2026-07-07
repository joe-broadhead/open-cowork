import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createCloudHttpServer } from '@open-cowork/cloud-server/http-server'
import { createUnavailableRuntimeAdapter } from '@open-cowork/cloud-server/unavailable-runtime-adapter'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'

// End-to-end SCIM 2.0 HTTP surface (#895): drive /scim/v2/Users over real HTTP with a
// per-org SCIM bearer token, covering provision → get → deactivate (which suspends the
// membership + revokes the member's credential) and unauthorized access.

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

async function makeFixture() {
  const store = new InMemoryControlPlaneStore()
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const service = new CloudSessionService(store, createUnavailableRuntimeAdapter(), policy, undefined, {
    randomUUID: () => `id-${Math.random().toString(36).slice(2)}`,
  }, undefined, null, undefined, undefined, null, null, { allowSelfServiceSignup: true })

  await store.createTenant({ tenantId: 'org-1', name: 'Org One', orgId: 'org-1' })
  await store.ensureUser({ tenantId: 'org-1', userId: 'owner', email: 'owner@example.test', role: 'owner' })
  const owner: CloudPrincipal = { tenantId: 'org-1', userId: 'owner', email: 'owner@example.test', authSource: 'user' }
  await service.ensurePrincipal(owner)
  await service.upsertSsoConfig(owner, { protocol: 'oidc', enabled: true, verifiedDomains: ['example.test'] })
  const { scimToken } = await service.rotateScimToken(owner)

  const server = createCloudHttpServer({ service, policy, publicBranding: DEFAULT_CONFIG.cloud.publicBranding })
  const baseUrl = await server.listen()
  return { store, service, server, baseUrl, scimToken }
}

test('SCIM HTTP: unauthorized without a valid bearer token', async () => {
  const fixture = await makeFixture()
  try {
    const anon = await fetch(`${fixture.baseUrl}/scim/v2/Users`)
    assert.equal(anon.status, 401)
    const body = await readJson(anon)
    assert.ok(Array.isArray(body.schemas))

    const bad = await fetch(`${fixture.baseUrl}/scim/v2/Users`, { headers: { authorization: 'Bearer scim_nope' } })
    assert.equal(bad.status, 401)
  } finally {
    await fixture.server.close()
  }
})

test('SCIM HTTP: provision, fetch, and deactivate a user (suspend + revoke)', async () => {
  const fixture = await makeFixture()
  const auth = { authorization: `Bearer ${fixture.scimToken}`, 'content-type': 'application/scim+json' }
  try {
    const created = await fetch(`${fixture.baseUrl}/scim/v2/Users`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'newhire@example.test',
        externalId: 'idp-100',
        emails: [{ value: 'newhire@example.test', primary: true }],
        active: true,
      }),
    })
    assert.equal(created.status, 201)
    const createdBody = await readJson(created)
    assert.equal(createdBody.active, true)
    const accountId = String(createdBody.id)

    // The provisioned member holds a credential.
    const token = await fixture.store.issueApiToken({ orgId: 'org-1', accountId, name: 'scim-token', scopes: ['desktop'] })
    assert.ok(await fixture.store.findApiTokenByPlaintext(token.plaintext))

    // Filtered list finds the user by userName.
    const listed = await readJson(await fetch(
      `${fixture.baseUrl}/scim/v2/Users?filter=${encodeURIComponent('userName eq "newhire@example.test"')}`,
      { headers: auth },
    ))
    assert.equal(listed.totalResults, 1)

    // Deactivate via PATCH → 200 active:false, membership disabled, credential revoked.
    const patched = await fetch(`${fixture.baseUrl}/scim/v2/Users/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }),
    })
    assert.equal(patched.status, 200)
    assert.equal((await readJson(patched)).active, false)
    assert.equal(await fixture.store.findApiTokenByPlaintext(token.plaintext), null)

    // PUT replaces the resource (reactivate the user).
    const replaced = await fetch(`${fixture.baseUrl}/scim/v2/Users/${encodeURIComponent(accountId)}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ userName: 'newhire@example.test', emails: [{ value: 'newhire@example.test', primary: true }], active: true }),
    })
    assert.equal(replaced.status, 200)
    assert.equal((await readJson(replaced)).active, true)

    // GET a single user by id, and an unknown id → 404 SCIM error.
    const fetched = await fetch(`${fixture.baseUrl}/scim/v2/Users/${encodeURIComponent(accountId)}`, { headers: auth })
    assert.equal(fetched.status, 200)
    const missing = await fetch(`${fixture.baseUrl}/scim/v2/Users/does-not-exist`, { headers: auth })
    assert.equal(missing.status, 404)

    // DELETE is idempotent-safe (already active) and returns 204.
    const deleted = await fetch(`${fixture.baseUrl}/scim/v2/Users/${encodeURIComponent(accountId)}`, { method: 'DELETE', headers: auth })
    assert.equal(deleted.status, 204)

    // ServiceProviderConfig + Group sync are reachable with the same token.
    const spc = await fetch(`${fixture.baseUrl}/scim/v2/ServiceProviderConfig`, { headers: auth })
    assert.equal(spc.status, 200)
    const group = await fetch(`${fixture.baseUrl}/scim/v2/Groups`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'admin', members: [{ value: 'idp-100' }] }),
    })
    assert.equal(group.status, 201)
    assert.equal((await readJson(group)).displayName, 'admin')
  } finally {
    await fixture.server.close()
  }
})
