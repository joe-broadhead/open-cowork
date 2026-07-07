import test from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultOrgSsoConfig,
  mergeOrgSsoConfig,
  normalizeSsoProtocol,
  normalizeVerifiedDomains,
  scimRetryDelayMs,
  toPublicOrgSsoConfig,
  hashScimToken,
  verifyScimTokenHash,
  type OrgSsoConfigRecord,
} from '@open-cowork/cloud-server/control-plane-store'
import {
  createClaimsOidcVerifier,
  createSsoVerifierRegistry,
  createUnconfiguredSamlVerifier,
  mapAssertionToIdentity,
  ssoIdentityToPrincipal,
  ssoStableSubject,
  SsoVerificationError,
} from '@open-cowork/cloud-server/sso-assertion'
import {
  parseScimGroup,
  parseScimPatch,
  parseScimUser,
  scimListResponse,
  scimUserResource,
  ScimParseError,
} from '@open-cowork/cloud-server/scim-schema'

const NOW = '2026-05-01T00:00:00.000Z'

function baseConfig(overrides: Partial<OrgSsoConfigRecord> = {}): OrgSsoConfigRecord {
  return { ...defaultOrgSsoConfig('org-1', 'oidc', NOW), ...overrides }
}

test('SSO config: protocol + domain normalization and merge semantics', () => {
  assert.equal(normalizeSsoProtocol('saml'), 'saml')
  assert.throws(() => normalizeSsoProtocol('ldap'), /must be/)

  assert.deepEqual(normalizeVerifiedDomains(['Example.com', 'example.com', 'a.co']), ['a.co', 'example.com'])
  assert.deepEqual(normalizeVerifiedDomains(null), [])
  assert.throws(() => normalizeVerifiedDomains(['not a domain']), /valid domain/)
  assert.throws(() => normalizeVerifiedDomains(['*.evil.com']), /valid domain/)

  // merge: undefined preserves, null clears, https validated + trailing slash normalized.
  const created = mergeOrgSsoConfig(null, {
    orgId: 'org-1',
    protocol: 'oidc',
    enabled: true,
    oidcIssuer: 'https://idp.example.test',
    oidcClientSecretCiphertext: 'enc:v1:secret',
    verifiedDomains: ['example.test'],
  }, NOW)
  assert.equal(created.oidcIssuer, 'https://idp.example.test/')
  assert.equal(created.enabled, true)

  const merged = mergeOrgSsoConfig(created, { orgId: 'org-1', enforced: true }, '2026-05-02T00:00:00.000Z')
  assert.equal(merged.enforced, true)
  assert.equal(merged.oidcIssuer, 'https://idp.example.test/') // preserved
  assert.equal(merged.oidcClientSecretCiphertext, 'enc:v1:secret') // preserved
  assert.equal(merged.createdAt, created.createdAt) // createdAt preserved
  assert.equal(merged.updatedAt, '2026-05-02T00:00:00.000Z')

  const cleared = mergeOrgSsoConfig(created, { orgId: 'org-1', oidcClientSecretCiphertext: null }, NOW)
  assert.equal(cleared.oidcClientSecretCiphertext, null)

  assert.throws(() => mergeOrgSsoConfig(null, { orgId: 'org-1', oidcIssuer: 'http://insecure.test' }, NOW), /https/)
})

test('SSO config: public projection hides sealed material behind booleans', () => {
  const record = baseConfig({
    oidcClientSecretCiphertext: 'enc:v1:x',
    scimTokenHash: hashScimToken('t'),
    samlIdpCertificateCiphertext: null,
  })
  const pub = toPublicOrgSsoConfig(record)
  assert.equal(pub.hasOidcClientSecret, true)
  assert.equal(pub.hasScimToken, true)
  assert.equal(pub.hasSamlIdpCertificate, false)
  assert.equal('oidcClientSecretCiphertext' in pub, false)
  assert.equal('scimTokenHash' in pub, false)
})

test('SCIM token hashing verifies the right secret and rejects others', () => {
  const hash = hashScimToken('scim_abc')
  assert.equal(verifyScimTokenHash('scim_abc', hash), true)
  assert.equal(verifyScimTokenHash('scim_wrong', hash), false)
})

test('SCIM retry backoff grows exponentially and caps', () => {
  assert.equal(scimRetryDelayMs(1), 1_000)
  assert.equal(scimRetryDelayMs(2), 2_000)
  assert.equal(scimRetryDelayMs(3), 4_000)
  assert.equal(scimRetryDelayMs(50), 5 * 60 * 1_000) // capped
  assert.equal(scimRetryDelayMs(0), 1_000) // floor
})

test('SSO assertion: OIDC claims verifier + pure mapping to principal', async () => {
  const config = baseConfig({ enabled: true, verifiedDomains: ['example.test'] })
  const verifier = createClaimsOidcVerifier()
  const assertion = await verifier.verify({
    rawAssertion: JSON.stringify({ sub: 'idp-sub-1', email: 'User@Example.test', name: 'A User', iss: 'https://idp' }),
    config,
  })
  assert.equal(assertion.subject, 'idp-sub-1')
  assert.equal(assertion.email, 'user@example.test')

  const identity = mapAssertionToIdentity(config, assertion)
  assert.equal(identity.orgId, 'org-1')
  assert.equal(identity.email, 'user@example.test')
  assert.equal(identity.idpSubject, ssoStableSubject('https://idp', 'idp-sub-1'))

  const principal = ssoIdentityToPrincipal(identity, 'Org One')
  assert.equal(principal.ssoVerified, true)
  assert.equal(principal.authSource, 'user')
  assert.equal(principal.orgId, 'org-1')
  assert.equal(principal.email, 'user@example.test')
})

test('SSO assertion: gating rejects wrong protocol / disabled / unverified domain', () => {
  const config = baseConfig({ enabled: true, protocol: 'oidc', verifiedDomains: ['example.test'] })
  assert.throws(() => mapAssertionToIdentity(config, { protocol: 'saml', subject: 's', email: 'a@example.test' }), /protocol/)
  assert.throws(() => mapAssertionToIdentity(baseConfig({ enabled: false }), { protocol: 'oidc', subject: 's', email: 'a@example.test' }), /not enabled/)
  assert.throws(() => mapAssertionToIdentity(config, { protocol: 'oidc', subject: 's', email: 'a@other.test' }), /not verified/)
})

test('SSO assertion: default SAML verifier is a fail-closed seam; registry resolves both', () => {
  const registry = createSsoVerifierRegistry()
  assert.equal(registry.oidc.protocol, 'oidc')
  assert.equal(registry.saml.protocol, 'saml')
  assert.throws(() => createUnconfiguredSamlVerifier().verify({ rawAssertion: '<xml/>', config: baseConfig({ protocol: 'saml' }) }), SsoVerificationError)

  // Operator override wins.
  const custom = { protocol: 'saml' as const, verify: () => ({ protocol: 'saml' as const, subject: 's', email: 'a@b.co' }) }
  assert.equal(createSsoVerifierRegistry({ saml: custom }).saml, custom)
})

test('SCIM schema: parse User / PATCH / Group and render resources', () => {
  const user = parseScimUser({
    userName: 'jane@example.test',
    name: { givenName: 'Jane', familyName: 'Doe' },
    emails: [{ value: 'work@example.test', primary: true }, { value: 'alt@example.test' }],
    externalId: 'ext-1',
  })
  assert.equal(user.email, 'work@example.test')
  assert.equal(user.displayName, 'Jane Doe')
  assert.equal(user.active, true)
  assert.equal(user.externalId, 'ext-1')
  assert.throws(() => parseScimUser({ name: {} }), ScimParseError)

  const patch = parseScimPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] })
  assert.equal(patch.active, false)
  const pathless = parseScimPatch({ Operations: [{ op: 'replace', value: { active: true, displayName: 'New' } }] })
  assert.equal(pathless.active, true)
  assert.equal(pathless.displayName, 'New')
  assert.throws(() => parseScimPatch({ Operations: [] }), ScimParseError)

  const group = parseScimGroup({ displayName: 'admin', members: [{ value: 'ext-1' }, { value: 'ext-2' }] })
  assert.equal(group.displayName, 'admin')
  assert.deepEqual(group.memberExternalIds, ['ext-1', 'ext-2'])

  const resource = scimUserResource({
    orgId: 'org-1', accountId: 'acct-1', email: 'jane@example.test', displayName: 'Jane',
    role: 'member', customRoleKey: null, status: 'disabled', createdAt: NOW, updatedAt: NOW,
  }, 'https://cloud.test/scim/v2')
  assert.equal(resource.active, false)
  assert.equal(resource.userName, 'jane@example.test')
  const list = scimListResponse([resource], 1)
  assert.equal(list.totalResults, 1)
})
