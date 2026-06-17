import test from 'node:test'
import assert from 'node:assert/strict'

import { CloudUsageGovernanceService } from '../apps/desktop/src/main/cloud/services/usage-governance-service.ts'
import { DEFAULT_CONFIG, type CloudBillingConfig } from '@open-cowork/shared'

function billingConfig(): CloudBillingConfig {
  return {
    ...DEFAULT_CONFIG.cloud.billing,
    enabled: true,
    provider: 'stripe',
    defaultPlanKey: 'pro',
    plans: {
      pro: {
        label: 'Pro',
        stripePriceId: 'price_pro',
        entitlements: {
          maxQueuedCommandsPerOrg: 5,
          maxQueueAgeMs: 60_000,
          maxConcurrentWorkflowRunsPerOrg: 3,
          maxWorkflowRunsPerHour: 9,
        },
      },
    },
    stripe: {
      defaultPriceId: 'price_pro',
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
      portalReturnUrl: 'https://app.example.test/billing',
    },
  }
}

function countingStore() {
  let fetches = 0
  const store = {
    async getBillingSubscription(orgId: string) {
      fetches += 1
      return {
        orgId,
        planKey: 'pro',
        providerId: 'stripe',
        providerCustomerId: 'cus_1',
        providerSubscriptionId: 'sub_1',
        status: 'active' as const,
        seats: 1,
        entitlements: {},
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
    },
  }
  return { store, fetches: () => fetches }
}

function service(store: unknown) {
  return new CloudUsageGovernanceService({
    store: store as never,
    abuse: { ...DEFAULT_CONFIG.cloud.abuse, enabled: true },
    billingConfig: billingConfig(),
  })
}

test('command queue quota resolves both entitlement limits with a single subscription fetch', async () => {
  const { store, fetches } = countingStore()
  const quota = await service(store).commandQueueQuotaForOrg('org-1')

  // Both limits come from the plan, but only one subscription round-trip occurs (was two).
  assert.equal(fetches(), 1)
  assert.equal(quota.maxQueuedCommandsPerOrg, 5)
  assert.equal(quota.maxQueueAgeMs, 60_000)
})

test('workflow run quota resolves both entitlement limits with a single subscription fetch', async () => {
  const { store, fetches } = countingStore()
  const quota = await service(store).workflowRunQuotaForOrg('org-1')

  assert.equal(fetches(), 1)
  assert.equal(quota.maxConcurrentWorkflowRunsPerOrg, 3)
  assert.equal(quota.maxWorkflowRunsPerHour, 9)
})

test('quota resolution skips the subscription fetch entirely when billing is not configured', async () => {
  const { store, fetches } = countingStore()
  const noBilling = new CloudUsageGovernanceService({
    store: store as never,
    abuse: { ...DEFAULT_CONFIG.cloud.abuse, enabled: true, maxQueuedCommandsPerOrg: 11 },
    billingConfig: null,
  })

  const quota = await noBilling.commandQueueQuotaForOrg('org-1')
  assert.equal(fetches(), 0)
  // Falls back to the abuse-config default when there is no plan to override it.
  assert.equal(quota.maxQueuedCommandsPerOrg, 11)
})
