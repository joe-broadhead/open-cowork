import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MANAGED_POLICY,
  applyManagedPolicyInput,
  effectiveManagedPolicy,
  managedPolicyDisabledControls,
  toManagedDesktopPolicyView,
} from '@open-cowork/cloud-server/control-plane-store'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  CloudPolicyService,
  CloudPrincipalService,
  type CloudIdentityPolicy,
} from '@open-cowork/cloud-server/services/index'
import { MANAGED_POLICY_DISABLED_REASON } from '@open-cowork/shared'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'

// -- Pure policy model ---------------------------------------------------------

test('managed policy model: merge, normalization, effective, and disabledByPolicy', () => {
  // A partial input MERGES onto the defaults; unset fields keep the unrestricted value.
  const first = applyManagedPolicyInput(DEFAULT_MANAGED_POLICY, {
    orgId: 'o',
    permissionCeilings: { bash: 'deny', web: 'ask' },
    allowedProviders: ['openai', 'openai', 'anthropic'],
    deniedModels: ['gpt-legacy'],
    keyManagement: 'byok_required',
    extensions: { customSkills: false },
    updateChannel: '  stable  ',
  })
  assert.equal(first.permissionCeilings.bash, 'deny')
  assert.equal(first.permissionCeilings.task, 'allow')
  // Allow-lists are deduped + sorted; update channel is trimmed.
  assert.deepEqual(first.allowedProviders, ['anthropic', 'openai'])
  assert.equal(first.updateChannel, 'stable')
  assert.equal(first.extensions.customSkills, false)
  assert.equal(first.extensions.customProviders, true)

  // A second merge preserves prior fields and can clear a nullable list back to null.
  const merged = applyManagedPolicyInput(first, { orgId: 'o', permissionCeilings: { task: 'ask' }, allowedProviders: null })
  assert.equal(merged.permissionCeilings.bash, 'deny')
  assert.equal(merged.permissionCeilings.task, 'ask')
  assert.equal(merged.allowedProviders, null)
  assert.equal(merged.keyManagement, 'byok_required')

  // Validation rejects bad shapes.
  assert.throws(() => applyManagedPolicyInput(DEFAULT_MANAGED_POLICY, { orgId: 'o', permissionCeilings: { bash: 'nope' } }), /allow.*ask.*deny/)
  assert.throws(() => applyManagedPolicyInput(DEFAULT_MANAGED_POLICY, { orgId: 'o', permissionCeilings: { unknown: 'deny' } }), /permission dimension/)
  assert.throws(() => applyManagedPolicyInput(DEFAULT_MANAGED_POLICY, { orgId: 'o', keyManagement: 'bogus' }), /keyManagement/)
  assert.throws(() => applyManagedPolicyInput(DEFAULT_MANAGED_POLICY, { orgId: 'o', features: { 'bad key': true } }), /feature key/)

  // effective(null) == unrestricted defaults.
  assert.deepEqual(effectiveManagedPolicy(null).permissionCeilings.bash, 'allow')

  // disabledByPolicy marks exactly the restricted controls with the reason string.
  const controls = managedPolicyDisabledControls(merged)
  assert.equal(controls.bash?.reason, MANAGED_POLICY_DISABLED_REASON)
  assert.equal(controls.task?.disabledByPolicy, true)
  assert.equal(controls.customSkills?.disabledByPolicy, true)
  assert.equal(controls.keyManagement?.disabledByPolicy, true)
  assert.equal(controls.models?.disabledByPolicy, true)
  // allowedProviders was cleared to null and no deny list ⇒ providers is NOT restricted.
  assert.equal(controls.providers, undefined)
  // web ceiling is 'ask' ⇒ restricted; unset dimensions are absent.
  assert.equal(controls.web?.disabledByPolicy, true)
  assert.equal(controls.mcp, undefined)

  // The delivered view carries the transparency map alongside the policy fields.
  const view = toManagedDesktopPolicyView(null)
  assert.deepEqual(view.disabledByPolicy, {})
  assert.equal(view.permissionCeilings.bash, 'allow')
})

// -- Service: permission gating, effective read, and audit ---------------------

function makeServices(identityPolicy: CloudIdentityPolicy) {
  const store = new InMemoryControlPlaneStore()
  const principalService = new CloudPrincipalService({ store, identityPolicy })
  const policyService = new CloudPolicyService({
    store,
    ensurePrincipal: (principal: CloudPrincipal) => principalService.ensurePrincipal(principal),
    assertPermission: (principal, permission) => principalService.assertPermission(principal, permission),
    principalOrgId: (principal) => principalService.principalOrgId(principal),
    auditActor: (principal) => principalService.auditActor(principal),
  })
  return { store, principalService, policyService }
}

test('policy service: policy:manage gates set/get, member enforces effective, changes audit', async () => {
  const { store, principalService, policyService } = makeServices({ allowSelfServiceSignup: true })
  await store.createTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
  await store.ensureUser({ tenantId: 't1', userId: 'owner', email: 'owner@example.test', role: 'owner' })
  const owner: CloudPrincipal = { tenantId: 't1', userId: 'owner', email: 'owner@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(owner)

  // policy:manage is in the catalog and held by owner/admin, not member.
  assert.ok(principalService.principalHasPermission(owner, 'policy:manage'))

  // No policy set yet ⇒ admin read is null, effective is the unrestricted default view.
  assert.equal(await policyService.getManagedPolicy(owner), null)
  const emptyEffective = await policyService.getEffectiveManagedPolicy(owner)
  assert.equal(emptyEffective.permissionCeilings.bash, 'allow')
  assert.deepEqual(emptyEffective.disabledByPolicy, {})

  // Owner sets a tightening policy.
  const set = await policyService.setManagedPolicy(owner, {
    permissionCeilings: { bash: 'deny' },
    allowedProviders: ['openai'],
    extensions: { customMcps: false },
  })
  assert.equal(set.permissionCeilings.bash, 'deny')

  // The effective read (open to any member) reflects it and carries disabledByPolicy.
  await store.createAccount({ accountId: 'mem-1', email: 'mem-1@example.test' })
  await store.upsertMembership({ orgId: 'org-1', accountId: 'mem-1', role: 'member', status: 'active' })
  const member: CloudPrincipal = { tenantId: 't1', userId: 'mem-1', accountId: 'mem-1', email: 'mem-1@example.test', authSource: 'user' }
  await principalService.ensurePrincipal(member)
  const memberEffective = await policyService.getEffectiveManagedPolicy(member)
  assert.equal(memberEffective.permissionCeilings.bash, 'deny')
  assert.equal(memberEffective.disabledByPolicy.bash?.reason, MANAGED_POLICY_DISABLED_REASON)
  assert.equal(memberEffective.disabledByPolicy.customMcps?.disabledByPolicy, true)

  // A plain member cannot read or write the managed (admin) policy.
  await assert.rejects(() => policyService.getManagedPolicy(member), /policy:manage/)
  await assert.rejects(() => policyService.setManagedPolicy(member, { permissionCeilings: { bash: 'allow' } }), /policy:manage/)

  // Each set emits a managed_policy.updated audit event.
  const events = await store.listAuditEvents('org-1', 50)
  assert.ok(events.some((event) => event.eventType === 'managed_policy.updated' && event.targetId === 'org-1'))
})
