import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import { DEFAULT_CONFIG, type CloudBillingConfig } from '../apps/desktop/src/main/config-types.ts'
import { evaluateBillingEntitlement } from '../apps/desktop/src/main/cloud/billing-adapter.ts'
import { createStripeBillingAdapter } from '../apps/desktop/src/main/cloud/stripe-billing-adapter.ts'
import { createStubBillingAdapter } from '../apps/desktop/src/main/cloud/stub-billing-adapter.ts'

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
          allowNewSessions: true,
          allowPrompts: true,
          allowWorkers: true,
          allowedProviders: ['anthropic'],
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

function signedStripePayload(secret: string, body: string, timestamp = 1_778_000_000) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

test('stub billing adapter creates an active local subscription checkout', async () => {
  const config = {
    ...billingConfig(),
    provider: 'stub' as const,
  }
  const adapter = createStubBillingAdapter(config)
  const checkout = await adapter.createCheckoutSession({
    orgId: 'org-1',
    accountId: 'account-1',
    email: 'owner@example.test',
    planKey: 'pro',
  })

  assert.equal(checkout.providerId, 'stub')
  assert.match(checkout.url, /billing\.local/)
  assert.equal(checkout.subscription?.status, 'active')
  assert.equal(checkout.subscription?.entitlements.allowedProviders?.[0], 'anthropic')
})

test('stripe billing adapter creates checkout and verifies subscription webhooks without importing Stripe', async () => {
  const config = billingConfig()
  const requests: Array<{ url: string, body: string }> = []
  const adapter = createStripeBillingAdapter({
    config,
    apiKey: 'sk_test_secret',
    webhookSecret: 'whsec_test',
    now: () => new Date(1_778_000_000_000),
    fetch: (async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response(JSON.stringify({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.test/session',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })

  const checkout = await adapter.createCheckoutSession({
    orgId: 'org-1',
    accountId: 'account-1',
    email: 'owner@example.test',
    planKey: 'pro',
  })
  assert.equal(checkout.url, 'https://checkout.stripe.test/session')
  assert.equal(requests[0]?.url, 'https://api.stripe.com/v1/checkout/sessions')
  assert.match(requests[0]?.body || '', /metadata%5BorgId%5D=org-1/)

  const updatedBody = JSON.stringify({
    id: 'evt_updated',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        quantity: 3,
        current_period_end: 1779000000,
        metadata: { orgId: 'org-1', planKey: 'pro' },
        items: { data: [{ price: { id: 'price_pro' } }] },
      },
    },
  })
  const updated = await adapter.handleWebhook({
    headers: { 'stripe-signature': signedStripePayload('whsec_test', updatedBody) },
    rawBody: updatedBody,
    body: JSON.parse(updatedBody) as Record<string, unknown>,
  })
  assert.equal(updated.subscription?.status, 'active')
  assert.equal(updated.subscription?.seats, 3)
  assert.equal(updated.subscription?.entitlements.allowedProviders?.[0], 'anthropic')

  const deletedBody = JSON.stringify({
    id: 'evt_deleted',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        metadata: { orgId: 'org-1', planKey: 'pro' },
      },
    },
  })
  const deleted = await adapter.handleWebhook({
    headers: { 'stripe-signature': signedStripePayload('whsec_test', deletedBody) },
    rawBody: deletedBody,
    body: JSON.parse(deletedBody) as Record<string, unknown>,
  })
  assert.equal(deleted.subscription?.status, 'canceled')

  assert.throws(() => adapter.handleWebhook({
    headers: { 'stripe-signature': 't=1778000000,v1=bad' },
    rawBody: updatedBody,
    body: JSON.parse(updatedBody) as Record<string, unknown>,
  }), /authorization/i)
})

test('stripe billing adapter rejects webhooks without a configured signing secret', async () => {
  const body = JSON.stringify({ id: 'evt_unsigned', type: 'customer.subscription.updated', data: { object: {} } })
  const adapter = createStripeBillingAdapter({
    config: billingConfig(),
    apiKey: 'sk_test_secret',
  })

  assert.throws(() => adapter.handleWebhook({
    headers: {},
    rawBody: body,
    body: JSON.parse(body) as Record<string, unknown>,
  }), /webhook secret is required/i)
})

test('billing entitlement evaluator returns machine-readable 402 decisions', () => {
  const config = billingConfig()
  assert.equal(evaluateBillingEntitlement({
    config,
    subscription: null,
    action: 'session.create',
  }).policyCode, 'billing.subscription_required')

  const inactive = evaluateBillingEntitlement({
    config,
    subscription: {
      orgId: 'org-1',
      planKey: 'pro',
      providerId: 'stripe',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      status: 'past_due',
      seats: 1,
      entitlements: {},
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    action: 'worker.execute',
  })
  assert.equal(inactive.status, 402)
  assert.equal(inactive.policyCode, 'billing.subscription_inactive')
})

test('billing entitlement evaluator enforces per-plan feature entitlements', () => {
  const config: CloudBillingConfig = {
    ...billingConfig(),
    plans: {
      pro: {
        label: 'Pro',
        stripePriceId: 'price_pro',
        entitlements: {
          allowNewSessions: true,
          allowPrompts: true,
          allowWorkers: true,
          features: { workflows: false, byok: false },
        },
      },
    },
  }
  const subscription = {
    orgId: 'org-1',
    planKey: 'pro',
    providerId: 'stripe',
    providerCustomerId: 'cus_123',
    providerSubscriptionId: 'sub_123',
    status: 'active' as const,
    seats: 1,
    entitlements: {},
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  // worker.execute maps to the plan-disabled `workflows` feature → denied.
  const workers = evaluateBillingEntitlement({ config, subscription, action: 'worker.execute' })
  assert.equal(workers.allowed, false)
  assert.equal(workers.status, 402)
  assert.equal(workers.policyCode, 'billing.feature_not_entitled')

  // byok.provider maps to the plan-disabled `byok` feature → denied.
  assert.equal(
    evaluateBillingEntitlement({ config, subscription, action: 'byok.provider', providerId: 'anthropic' }).policyCode,
    'billing.feature_not_entitled',
  )

  // chat-mapped actions are unset in `features` → still allowed (default-allow).
  assert.equal(evaluateBillingEntitlement({ config, subscription, action: 'session.create' }).allowed, true)
  assert.equal(evaluateBillingEntitlement({ config, subscription, action: 'prompt.enqueue' }).allowed, true)

  // A plan with no `features` block is unaffected.
  assert.equal(
    evaluateBillingEntitlement({ config: billingConfig(), subscription, action: 'worker.execute' }).allowed,
    true,
  )
})
