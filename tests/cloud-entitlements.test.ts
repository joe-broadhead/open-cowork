import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, type CloudBillingConfig } from '@open-cowork/shared'
import {
  UnlimitedEntitlementResolver,
  EntitlementDeniedError,
  assertEntitled,
  registerEntitlementResolverProvider,
  getRegisteredEntitlementResolverProvider,
  clearRegisteredEntitlementResolverProviders,
  allEntitlementFeatures,
  ENTITLEMENT_FEATURES,
  type EntitlementResolver,
} from '@open-cowork/cloud-server/entitlements/entitlement-resolver'
import { MetadataEntitlementResolver } from '@open-cowork/cloud-server/entitlements/metadata-entitlement-resolver'
import { resolveEntitlementResolver } from '@open-cowork/cloud-server/entitlements/entitlement-provider'
import { CloudEntitlementService } from '@open-cowork/cloud-server/services/entitlement-service'
import { resolveCloudEntitlementsConfig } from '@open-cowork/cloud-server/cloud-config'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { CloudSessionService, CloudServiceError } from '@open-cowork/cloud-server/session-service'
import type { CloudRuntimeAdapter } from '@open-cowork/cloud-server/runtime-adapter'
import type { BillingSubscriptionRecord } from '@open-cowork/cloud-server/control-plane-store'

// A billing config whose DEFAULT plan is a restrictive free tier (blocks session
// creation) and whose `pro` plan unlocks everything. The metadata resolver reads
// these plan tiers plus stored subscription state — it never calls a provider.
function billingConfig(): CloudBillingConfig {
  return {
    ...DEFAULT_CONFIG.cloud.billing,
    enabled: false,
    provider: 'none',
    defaultPlanKey: 'free',
    plans: {
      free: {
        label: 'Free',
        entitlements: {
          allowNewSessions: false,
          maxConcurrentSessionsPerOrg: 1,
        },
      },
      pro: {
        label: 'Pro',
        entitlements: {
          allowNewSessions: true,
          allowPrompts: true,
          allowWorkers: true,
          allowedProfiles: ['full'],
          allowedProviders: ['anthropic'],
          maxConcurrentSessionsPerOrg: 25,
        },
      },
    },
  }
}

function subscription(overrides: Partial<BillingSubscriptionRecord> = {}): BillingSubscriptionRecord {
  return {
    orgId: 'org-1',
    planKey: 'pro',
    providerId: 'stripe',
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    status: 'active',
    seats: 3,
    entitlements: {},
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const context = { orgId: 'org-1', profileName: 'full' as string | null }

test('unlimited resolver is the complete, ungated product (`none`)', async () => {
  const resolver = new UnlimitedEntitlementResolver()
  assert.equal(resolver.provider, 'none')
  assert.equal(resolver.gating, false)
  for (const feature of ENTITLEMENT_FEATURES) {
    assert.deepEqual(await resolver.canUse(feature, context), { allowed: true })
  }
  assert.deepEqual(await resolver.checkQuota('seats', 10_000, context), { allowed: true, limit: null, remaining: null })
  const described = await resolver.describeEntitlements(context)
  assert.equal(described.gatingEnabled, false)
  assert.equal(described.billingEnabled, false)
  assert.deepEqual(described.features, allEntitlementFeatures(true))
  // assertEntitled never throws for the unlimited resolver.
  for (const feature of ENTITLEMENT_FEATURES) await assertEntitled(resolver, feature, context)
})

test('metadata resolver denies gated writes on the free/default plan', async () => {
  const resolver = new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => null,
  })
  assert.equal(resolver.provider, 'stripe')
  assert.equal(resolver.gating, true)
  const sessionsVerdict = await resolver.canUse('sessions', context)
  assert.equal(sessionsVerdict.allowed, false)
  assert.equal(sessionsVerdict.status, 402)
  assert.equal(sessionsVerdict.policyCode, 'entitlements.sessions_not_entitled')
  // A feature the free plan does not restrict is still allowed.
  assert.equal((await resolver.canUse('artifacts', context)).allowed, true)
})

test('metadata resolver denies each gated capability flag and reflects it in describe', async () => {
  const config: CloudBillingConfig = {
    ...billingConfig(),
    defaultPlanKey: 'locked',
    plans: {
      locked: {
        label: 'Locked',
        entitlements: {
          allowPrompts: false,
          allowWorkers: false,
          features: { artifacts: false },
        },
      },
    },
  }
  const resolver = new MetadataEntitlementResolver({ billingConfig: config, loadSubscription: async () => null })
  assert.equal((await resolver.canUse('prompts', context)).policyCode, 'entitlements.prompts_not_entitled')
  assert.equal((await resolver.canUse('workers', context)).policyCode, 'entitlements.workers_not_entitled')
  assert.equal((await resolver.canUse('artifacts', context)).policyCode, 'entitlements.feature_not_entitled')
  const status = await resolver.describeEntitlements(context)
  assert.equal(status.features.prompts, false)
  assert.equal(status.features.workers, false)
  assert.equal(status.features.artifacts, false)
  assert.equal(status.features.sessions, true)
})

test('metadata resolver unlocks writes with an active paid subscription', async () => {
  const resolver = new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => subscription({ planKey: 'pro' }),
  })
  assert.equal((await resolver.canUse('sessions', context)).allowed, true)
  // Profile allowlist: `full` is entitled, `restricted` is not.
  assert.equal((await resolver.canUse('sessions', { orgId: 'org-1', profileName: 'restricted' })).allowed, false)
  // BYOK provider allowlist.
  assert.equal((await resolver.canUse('byok', { orgId: 'org-1', providerId: 'anthropic' })).allowed, true)
  const denied = await resolver.canUse('byok', { orgId: 'org-1', providerId: 'openai' })
  assert.equal(denied.allowed, false)
  assert.equal(denied.policyCode, 'entitlements.provider_not_entitled')
})

test('metadata resolver denies writes for a lapsed subscription', async () => {
  const resolver = new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => subscription({ status: 'past_due' }),
  })
  const verdict = await resolver.canUse('artifacts', context)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.policyCode, 'entitlements.subscription_inactive')
})

test('metadata resolver models seat + usage quotas', async () => {
  const resolver = new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => subscription({ planKey: 'pro', seats: 3 }),
  })
  assert.equal((await resolver.checkQuota('seats', 3, context)).allowed, true)
  const overSeats = await resolver.checkQuota('seats', 4, context)
  assert.equal(overSeats.allowed, false)
  assert.equal(overSeats.limit, 3)
  assert.equal(overSeats.remaining, 0)
  // maxConcurrentSessionsPerOrg from the pro plan entitlements.
  assert.equal((await resolver.checkQuota('concurrent_sessions', 25, context)).allowed, true)
  assert.equal((await resolver.checkQuota('concurrent_sessions', 26, context)).allowed, false)
  // Unset entitlement limit ⇒ unlimited.
  assert.deepEqual(await resolver.checkQuota('active_workers', 10_000, context), { allowed: true, limit: null, remaining: null })
})

test('metadata resolver describes plan status for the admin plane', async () => {
  const resolver = new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => subscription({ planKey: 'pro', status: 'active', seats: 4 }),
  })
  const status = await resolver.describeEntitlements(context)
  assert.equal(status.provider, 'stripe')
  assert.equal(status.gatingEnabled, true)
  assert.equal(status.billingEnabled, true)
  assert.equal(status.planKey, 'pro')
  assert.equal(status.planLabel, 'Pro')
  assert.equal(status.subscriptionStatus, 'active')
  assert.equal(status.seats, 4)
  assert.equal(status.limits.concurrent_sessions, 25)
  assert.equal(status.features.sessions, true)
})

test('metadata resolver with no billing catalog gates nothing', async () => {
  const resolver = new MetadataEntitlementResolver({ billingConfig: null, loadSubscription: async () => null })
  assert.equal((await resolver.canUse('sessions', context)).allowed, true)
  assert.deepEqual(await resolver.checkQuota('seats', 999, context), { allowed: true, limit: null, remaining: null })
  const status = await resolver.describeEntitlements(context)
  assert.equal(status.planKey, null)
})

test('resolveEntitlementResolver kill switch: disabled ⇒ unlimited regardless of provider', () => {
  const resolver = resolveEntitlementResolver({
    config: { enabled: false, provider: 'stripe' },
    billingConfig: billingConfig(),
    loadSubscription: async () => null,
  })
  assert.ok(resolver instanceof UnlimitedEntitlementResolver)
  assert.equal(resolver.gating, false)
})

test('resolveEntitlementResolver selects none/stripe by config', () => {
  const none = resolveEntitlementResolver({ config: { enabled: true, provider: 'none' }, billingConfig: null, loadSubscription: async () => null })
  assert.ok(none instanceof UnlimitedEntitlementResolver)
  const stripe = resolveEntitlementResolver({ config: { enabled: true, provider: 'stripe' }, billingConfig: billingConfig(), loadSubscription: async () => null })
  assert.ok(stripe instanceof MetadataEntitlementResolver)
  assert.equal(stripe.gating, true)
})

test('custom provider registration seam', () => {
  clearRegisteredEntitlementResolverProviders()
  assert.throws(
    () => resolveEntitlementResolver({ config: { enabled: true, provider: 'custom' }, billingConfig: null, loadSubscription: async () => null }),
    /no custom entitlement resolver is registered/,
  )
  let received: unknown = null
  const custom: EntitlementResolver = {
    provider: 'custom',
    gating: true,
    canUse: () => ({ allowed: false, status: 402, reason: 'custom denial', policyCode: 'custom.denied' }),
    checkQuota: () => ({ allowed: true, limit: null, remaining: null }),
    describeEntitlements: () => ({
      provider: 'custom', gatingEnabled: true, billingEnabled: true, planKey: 'enterprise', planLabel: 'Enterprise',
      subscriptionStatus: 'active', seats: null, features: allEntitlementFeatures(true), limits: {},
    }),
  }
  registerEntitlementResolverProvider('Custom', (input) => { received = input; return custom })
  assert.ok(getRegisteredEntitlementResolverProvider('custom'))
  const resolver = resolveEntitlementResolver({ config: { enabled: true, provider: 'custom' }, billingConfig: null, loadSubscription: async () => null })
  assert.equal(resolver.provider, 'custom')
  assert.ok(received)
  clearRegisteredEntitlementResolverProviders()
})

test('assertEntitled + EntitlementDeniedError carry a 402', async () => {
  const resolver = new MetadataEntitlementResolver({ billingConfig: billingConfig(), loadSubscription: async () => null })
  await assert.rejects(() => assertEntitled(resolver, 'sessions', context), (error: unknown) => {
    assert.ok(error instanceof EntitlementDeniedError)
    assert.equal(error.status, 402)
    assert.equal(error.policyCode, 'entitlements.sessions_not_entitled')
    return true
  })
  assert.throws(() => registerEntitlementResolverProvider('  ', () => new UnlimitedEntitlementResolver()), /non-empty/)
})

test('CloudEntitlementService gates write actions and passes reads through', async () => {
  const gated = new CloudEntitlementService({
    resolver: new MetadataEntitlementResolver({ billingConfig: billingConfig(), loadSubscription: async () => null }),
  })
  assert.equal(gated.provider, 'stripe')
  assert.equal(gated.gatingEnabled, true)
  await assert.rejects(() => gated.assertAction('session.create', context), (error: unknown) => {
    assert.ok(error instanceof CloudServiceError)
    assert.equal(error.status, 402)
    assert.equal(error.policyCode, 'entitlements.sessions_not_entitled')
    return true
  })
  // A non-gated action on the free plan still passes.
  await gated.assertAction('artifact.upload', context)
  const status = await gated.describe(context)
  assert.equal(status.gatingEnabled, true)
  assert.equal((await gated.checkQuota('concurrent_sessions', 1, context)).allowed, true)

  const ungated = new CloudEntitlementService({ resolver: new UnlimitedEntitlementResolver() })
  assert.equal(ungated.gatingEnabled, false)
  await ungated.assertAction('session.create', context)
})

test('resolveCloudEntitlementsConfig reads env overrides and defaults', () => {
  assert.deepEqual(resolveCloudEntitlementsConfig(DEFAULT_CONFIG, {}), { enabled: false, provider: 'none' })
  assert.deepEqual(
    resolveCloudEntitlementsConfig(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ENTITLEMENTS_ENABLED: 'true',
      OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER: 'stripe',
    }),
    { enabled: true, provider: 'stripe' },
  )
  // An unknown provider falls back to the config default.
  assert.equal(
    resolveCloudEntitlementsConfig(DEFAULT_CONFIG, { OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER: 'paypal' }).provider,
    'none',
  )
})

// ---- Gating discipline: writes gate, reads/exports/admin never do ----

class MinimalRuntime implements CloudRuntimeAdapter {
  async createSession() {
    return { id: 'oc-1', title: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  }

  async promptSession() {
    return { events: [] }
  }

  async abortSession() {}
}

function makeService(resolver: EntitlementResolver) {
  let counter = 0
  return new CloudSessionService(
    new InMemoryControlPlaneStore(),
    new MinimalRuntime(),
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => `id-${counter++}` },
    undefined,
    null,
    undefined,
    undefined,
    null,
    null,
    undefined,
    null,
    null,
    null,
    resolver,
  )
}

const owner = {
  tenantId: 'tenant-a',
  orgId: 'tenant-a',
  tenantName: 'tenant-a',
  userId: 'user-a',
  accountId: 'user-a',
  email: 'user-a@example.test',
  role: 'owner' as const,
  authSource: 'local' as const,
}

test('write-only gating: with a lapsed/free plan reads/exports/admin succeed but a create is denied', async () => {
  const service = makeService(new MetadataEntitlementResolver({
    billingConfig: billingConfig(),
    loadSubscription: async () => null, // free/default plan, no active subscription
  }))

  // WRITE is gated with a structured 402.
  await assert.rejects(() => service.createSession(owner), (error: unknown) => {
    assert.ok(error instanceof CloudServiceError)
    assert.equal(error.status, 402)
    assert.equal(error.policyCode, 'entitlements.sessions_not_entitled')
    return true
  })

  // READS still succeed.
  assert.deepEqual(await service.listSessions(owner), [])
  const usage = await service.getUsageSummary(owner)
  assert.ok(usage)

  // ADMIN action still succeeds.
  const audit = await service.listAuditEvents(owner)
  assert.ok(Array.isArray(audit))

  // The read-only entitlement status the admin plane consults.
  const status = await service.describeEntitlements(owner)
  assert.equal(status.gatingEnabled, true)
  assert.equal(status.billingEnabled, true)
  assert.equal(status.features.sessions, false)
})

test('provider none (and kill switch off) never denies a create', async () => {
  // `none` selection.
  const noneService = makeService(new UnlimitedEntitlementResolver())
  const created = await noneService.createSession(owner)
  assert.ok(created.session.sessionId)

  // Kill switch OFF while provider is stripe ⇒ unlimited resolver ⇒ create allowed.
  const killSwitchResolver = resolveEntitlementResolver({
    config: { enabled: false, provider: 'stripe' },
    billingConfig: billingConfig(),
    loadSubscription: async () => null,
  })
  const killSwitchService = makeService(killSwitchResolver)
  const created2 = await killSwitchService.createSession(owner)
  assert.ok(created2.session.sessionId)
})
