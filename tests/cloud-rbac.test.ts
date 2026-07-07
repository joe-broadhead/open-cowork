import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_ROLE_PERMISSIONS,
  CONTROL_PLANE_PERMISSIONS,
  builtinRolePermissions,
  hasPermission,
  normalizeControlPlanePermissions,
  normalizeCustomRoleKey,
  permissionsRemoved,
  resolveEffectivePermissions,
} from '@open-cowork/cloud-server/control-plane-store'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  CloudMemberService,
  CloudPrincipalService,
  CloudRoleService,
  type CloudIdentityPolicy,
} from '@open-cowork/cloud-server/services/index'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'

// -- Pure permission model -----------------------------------------------------

test('permission model: normalization, resolution, removal, and role-key validation', () => {
  // Catalog + built-in maps.
  assert.ok(CONTROL_PLANE_PERMISSIONS.includes('roles:manage'))
  assert.deepEqual(builtinRolePermissions('owner'), [...BUILTIN_ROLE_PERMISSIONS.owner])
  assert.equal(hasPermission(builtinRolePermissions('member'), 'sessions:write'), true)
  assert.equal(hasPermission(builtinRolePermissions('member'), 'roles:manage'), false)

  // normalize: dedupe + catalog order; reject unknown.
  assert.deepEqual(normalizeControlPlanePermissions(['sessions:write', 'sessions:read', 'sessions:read']), ['sessions:read', 'sessions:write'])
  assert.throws(() => normalizeControlPlanePermissions(['not:a:permission']), /unsupported permission/)
  assert.throws(() => normalizeControlPlanePermissions('nope' as unknown as string[]), /must be an array/)

  // A custom role's map REPLACES the built-in role map.
  const effective = resolveEffectivePermissions({
    role: 'admin',
    customRole: { orgId: 'o', roleKey: 'r', name: 'R', description: null, baseRole: 'admin', permissions: ['sessions:read'], createdAt: '', updatedAt: '' },
  })
  assert.deepEqual(effective, ['sessions:read'])
  assert.deepEqual(resolveEffectivePermissions({ role: 'member' }), builtinRolePermissions('member'))

  // permissionsRemoved reports the lost permissions.
  assert.deepEqual(permissionsRemoved(['sessions:read', 'sessions:write'], ['sessions:read']), ['sessions:write'])
  assert.deepEqual(permissionsRemoved(['sessions:read'], ['sessions:read', 'members:read']), [])

  // Role keys: slug rules + no collision with built-ins.
  assert.equal(normalizeCustomRoleKey('  Analyst_1 '), 'analyst_1')
  assert.throws(() => normalizeCustomRoleKey('owner'), /built-in role/)
  assert.throws(() => normalizeCustomRoleKey('1bad'), /Custom role key/)
})

// -- Service harness -----------------------------------------------------------

function makeServices(identityPolicy: CloudIdentityPolicy) {
  const store = new InMemoryControlPlaneStore()
  const principalService = new CloudPrincipalService({ store, identityPolicy })
  const ensurePrincipal = (principal: CloudPrincipal) => principalService.ensurePrincipal(principal)
  const principalOrgId = (principal: CloudPrincipal) => principalService.principalOrgId(principal)
  const memberService = new CloudMemberService({
    store,
    identityPolicy,
    inviteSigningSecret: 'rbac-test-secret',
    emailSender: null,
    ensurePrincipal,
    assertOrgAdmin: (principal) => principalService.assertOrgAdmin(principal),
    principalOrgId,
  })
  const roleService = new CloudRoleService({
    store,
    ensurePrincipal,
    assertPermission: (principal, permission) => principalService.assertPermission(principal, permission),
    principalOrgId,
    auditActor: (principal) => principalService.auditActor(principal),
  })
  return { store, principalService, memberService, roleService }
}

async function bootstrapOrg(store: InMemoryControlPlaneStore, principalService: CloudPrincipalService) {
  await store.createTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
  await store.ensureUser({ tenantId: 't1', userId: 'owner', email: 'owner@example.test', role: 'owner' })
  const owner: CloudPrincipal = { tenantId: 't1', userId: 'owner', email: 'owner@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(owner)
  return owner
}

async function seedMember(store: InMemoryControlPlaneStore, accountId: string) {
  await store.createAccount({ accountId, email: `${accountId}@example.test` })
  await store.upsertMembership({ orgId: 'org-1', accountId, role: 'member', status: 'active' })
  return store.issueApiToken({ orgId: 'org-1', accountId, name: `${accountId}-token`, scopes: ['desktop'] })
}

// -- Single-org self-host mode -------------------------------------------------

test('single-org mode funnels every principal into the one bootstrapped org', async () => {
  const { store, principalService } = makeServices({ allowSelfServiceSignup: true, orgMode: 'single-org', singleOrgId: 'solo', singleOrgName: 'Solo Inc' })
  const principal: CloudPrincipal = { tenantId: 'ignored-tenant', userId: 'u1', email: 'u1@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(principal)
  assert.equal(principal.tenantId, 'solo')
  assert.equal(principal.orgId, 'solo')
  assert.equal(principal.tenantName, 'Solo Inc')
  assert.ok(await store.resolvePrincipalMembership({ tenantId: 'solo', accountId: 'u1' }))

  // multi-org (default) preserves the incoming tenant.
  const { principalService: multi } = makeServices({ allowSelfServiceSignup: true })
  const other: CloudPrincipal = { tenantId: 'tenant-x', userId: 'u2', email: 'u2@example.test', authSource: 'user' }
  await multi.ensurePrincipal(other)
  assert.equal(other.tenantId, 'tenant-x')
})

// -- Custom roles + permission enforcement + revocation ------------------------

test('custom roles: CRUD, effective permissions on the principal, and permission enforcement', async () => {
  const { store, principalService, roleService } = makeServices({ allowSelfServiceSignup: true })
  const owner = await bootstrapOrg(store, principalService)

  const role = await roleService.createCustomRole(owner, { roleKey: 'analyst', name: 'Analyst', baseRole: 'member', permissions: ['sessions:read', 'members:read'] })
  assert.deepEqual(role.permissions, ['members:read', 'sessions:read'])
  assert.deepEqual((await roleService.listCustomRoles(owner)).map((entry) => entry.roleKey), ['analyst'])
  assert.ok(roleService.listPermissionCatalog().includes('roles:manage'))

  // A plain member lacks roles:manage — enforcement via the effective permission set.
  await seedMember(store, 'mem-1')
  const member: CloudPrincipal = { tenantId: 't1', userId: 'mem-1', accountId: 'mem-1', email: 'mem-1@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(member)
  assert.deepEqual(member.permissions, builtinRolePermissions('member'))
  await assert.rejects(() => roleService.listCustomRoles(member), /roles:manage/)

  // Assigning a custom role that GRANTS members:manage upgrades the member past assertOrgAdmin.
  await roleService.createCustomRole(owner, { roleKey: 'team-lead', name: 'Team Lead', baseRole: 'member', permissions: ['members:manage', 'members:read', 'sessions:read'] })
  await roleService.assignMemberRole(owner, 'mem-1', { roleKey: 'team-lead' })
  await principalService.ensurePrincipal(member)
  assert.equal(member.customRoleKey, 'team-lead')
  assert.doesNotThrow(() => principalService.assertOrgAdmin(member))

  // A base admin whose custom role OMITS org-management is downgraded below assertOrgAdmin.
  await store.createAccount({ accountId: 'adm-1', email: 'adm-1@example.test' })
  await store.upsertMembership({ orgId: 'org-1', accountId: 'adm-1', role: 'admin', status: 'active' })
  await roleService.createCustomRole(owner, { roleKey: 'limited', name: 'Limited', baseRole: 'admin', permissions: ['members:read'] })
  await roleService.assignMemberRole(owner, 'adm-1', { roleKey: 'limited' })
  const limitedAdmin: CloudPrincipal = { tenantId: 't1', userId: 'adm-1', accountId: 'adm-1', email: 'adm-1@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(limitedAdmin)
  assert.throws(() => principalService.assertOrgAdmin(limitedAdmin), /org:manage/)
})

test('credential revocation: assigning a narrower role revokes the member\'s tokens immediately', async () => {
  const { store, principalService, roleService } = makeServices({ allowSelfServiceSignup: true })
  const owner = await bootstrapOrg(store, principalService)
  const issued = await seedMember(store, 'mem-1')
  assert.ok(await store.findApiTokenByPlaintext(issued.plaintext), 'token resolves before downgrade')

  // 'restricted' grants fewer permissions than the built-in member map ⇒ downgrade ⇒ revoke.
  await roleService.createCustomRole(owner, { roleKey: 'restricted', name: 'Restricted', baseRole: 'member', permissions: ['sessions:read'] })
  await roleService.assignMemberRole(owner, 'mem-1', { roleKey: 'restricted' })
  assert.equal(await store.findApiTokenByPlaintext(issued.plaintext), null, 'downgraded member loses access on the next request')
})

test('credential revocation: reducing a role\'s permission set revokes every holder\'s tokens', async () => {
  const { store, principalService, roleService } = makeServices({ allowSelfServiceSignup: true })
  const owner = await bootstrapOrg(store, principalService)
  const issued = await seedMember(store, 'mem-1')
  await roleService.createCustomRole(owner, { roleKey: 'analyst', name: 'Analyst', baseRole: 'member', permissions: ['sessions:read', 'sessions:write', 'members:read', 'org:read'] })
  await roleService.assignMemberRole(owner, 'mem-1', { roleKey: 'analyst' })
  // Not a downgrade vs built-in member (superset) — token survives the assignment.
  assert.ok(await store.findApiTokenByPlaintext(issued.plaintext))

  await roleService.updateCustomRole(owner, 'analyst', { permissions: ['sessions:read'] })
  assert.equal(await store.findApiTokenByPlaintext(issued.plaintext), null, 'shrinking the role revokes assigned members\' tokens')
})

// -- Member lifecycle ----------------------------------------------------------

test('member lifecycle: invite → accept → suspend → deprovision revokes access immediately', async () => {
  const { store, principalService, memberService } = makeServices({ allowSelfServiceSignup: false, signupMode: 'invite' })
  const owner = await bootstrapOrg(store, principalService)

  const invited = await memberService.inviteOrgMember(owner, { email: 'newbie@example.test', role: 'member' })
  assert.equal(invited.member.status, 'invited')
  assert.ok(invited.inviteToken)

  const accepted = await memberService.acceptMembershipInvite(invited.inviteToken!)
  assert.equal(accepted.status, 'active')

  // The accepted member holds a token; suspending them revokes it on the next request.
  const token = await store.issueApiToken({ orgId: 'org-1', accountId: invited.member.accountId, name: 'invitee-token', scopes: ['desktop'] })
  const suspended = await memberService.updateOrgMember(owner, invited.member.accountId, { status: 'disabled', confirm: invited.member.accountId })
  assert.equal(suspended.status, 'disabled')
  assert.equal(await store.findApiTokenByPlaintext(token.plaintext), null)
})

test('role service: resolve member permissions, clear assignment, and delete a role', async () => {
  const { store, principalService, roleService } = makeServices({ allowSelfServiceSignup: true })
  const owner = await bootstrapOrg(store, principalService)
  await seedMember(store, 'mem-1')
  await roleService.createCustomRole(owner, { roleKey: 'analyst', name: 'Analyst', baseRole: 'member', permissions: ['sessions:read', 'members:read'] })
  await roleService.assignMemberRole(owner, 'mem-1', { roleKey: 'analyst' })

  const resolved = await roleService.resolveMemberPermissions(owner, 'mem-1')
  assert.equal(resolved.customRoleKey, 'analyst')
  assert.deepEqual(resolved.permissions, ['members:read', 'sessions:read'])
  await assert.rejects(() => roleService.resolveMemberPermissions(owner, 'missing-account'), /not be found|not found/i)

  // Clearing the assignment restores the built-in member map.
  const cleared = await roleService.assignMemberRole(owner, 'mem-1', { roleKey: null })
  assert.equal(cleared.customRoleKey, null)
  assert.deepEqual(cleared.permissions, builtinRolePermissions('member'))

  // Assigning an unknown role is rejected; deleting removes the role.
  await assert.rejects(() => roleService.assignMemberRole(owner, 'mem-1', { roleKey: 'ghost' }), /not.*found/i)
  assert.equal(await roleService.deleteCustomRole(owner, 'analyst'), true)
  assert.deepEqual(await roleService.listCustomRoles(owner), [])
  await assert.rejects(() => roleService.updateCustomRole(owner, 'analyst', { name: 'X' }), /not.*found/i)
})

test('member lifecycle: deprovision disables the membership and revokes tokens', async () => {
  const { store, principalService, memberService } = makeServices({ allowSelfServiceSignup: true })
  const owner = await bootstrapOrg(store, principalService)
  const issued = await seedMember(store, 'dep-1')

  const deprovisioned = await memberService.deprovisionOrgMember(owner, 'dep-1')
  assert.equal(deprovisioned.status, 'disabled')
  assert.equal(await store.findApiTokenByPlaintext(issued.plaintext), null)
})
