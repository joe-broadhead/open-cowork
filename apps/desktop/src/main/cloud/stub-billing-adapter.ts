import type { CloudBillingConfig, CloudSubscriptionStatus } from '../config-types.ts'
import type {
  BillingAdapter,
  BillingCheckoutInput,
  BillingCheckoutResult,
  BillingPortalInput,
  BillingPortalResult,
  BillingWebhookInput,
  BillingWebhookResult,
} from './billing-adapter.ts'
import { planEntitlements } from './billing-adapter.ts'

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createStubBillingAdapter(config: CloudBillingConfig): BillingAdapter {
  return {
    providerId: 'stub',
    enabled: true,

    createCheckoutSession(input: BillingCheckoutInput): BillingCheckoutResult {
      const planKey = input.planKey || config.defaultPlanKey
      return {
        providerId: 'stub',
        providerSessionId: `stub_checkout_${input.orgId}_${planKey}`,
        url: `https://billing.local/checkout?orgId=${encodeURIComponent(input.orgId)}&plan=${encodeURIComponent(planKey)}`,
        subscription: {
          orgId: input.orgId,
          providerId: 'stub',
          providerCustomerId: `stub_customer_${input.orgId}`,
          providerSubscriptionId: `stub_subscription_${input.orgId}`,
          planKey,
          status: 'active',
          seats: 1,
          entitlements: planEntitlements(config, planKey),
          metadata: {
            source: 'stub_checkout',
            accountId: input.accountId,
          },
        },
      }
    },

    createPortalSession(input: BillingPortalInput): BillingPortalResult {
      return {
        providerId: 'stub',
        url: `https://billing.local/portal?orgId=${encodeURIComponent(input.orgId)}`,
      }
    },

    handleWebhook(input: BillingWebhookInput): BillingWebhookResult {
      const body = input.body
      const subscription = body.subscription && typeof body.subscription === 'object' && !Array.isArray(body.subscription)
        ? body.subscription as Record<string, unknown>
        : body
      const orgId = readString(subscription.orgId)
      if (!orgId) {
        return {
          providerId: 'stub',
          eventId: readString(body.id) || `stub_event_${Date.now()}`,
          eventType: readString(body.type) || 'stub.ignored',
        }
      }
      const planKey = readString(subscription.planKey) || config.defaultPlanKey
      const eventId = readString(body.id) || `stub_event_${orgId}_${planKey}`
      return {
        providerId: 'stub',
        eventId,
        eventType: readString(body.type) || 'customer.subscription.updated',
        subscription: {
          orgId,
          providerId: 'stub',
          providerCustomerId: readString(subscription.providerCustomerId) || `stub_customer_${orgId}`,
          providerSubscriptionId: readString(subscription.providerSubscriptionId) || `stub_subscription_${orgId}`,
          planKey,
          status: (readString(subscription.status) || 'active') as CloudSubscriptionStatus,
          seats: Number(subscription.seats) || 1,
          entitlements: planEntitlements(config, planKey),
          metadata: {
            eventId,
            source: 'stub_webhook',
          },
        },
      }
    },
  }
}
