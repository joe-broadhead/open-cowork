import { createHmac, timingSafeEqual } from 'node:crypto'
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
import {
  BillingAdapterError,
  BillingWebhookAuthError,
  planEntitlements,
  subscriptionPlanKeyForPrice,
} from './billing-adapter.ts'

type FetchLike = typeof fetch

export type StripeBillingAdapterOptions = {
  config: CloudBillingConfig
  apiKey?: string | null
  webhookSecret?: string | null
  fetch?: FetchLike
  now?: () => Date
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readBoolean(value: unknown) {
  return value === true
}

function firstHeader(headers: Record<string, string | undefined>, name: string) {
  return headers[name.toLowerCase()] || headers[name] || null
}

function stripeStatus(value: unknown, deleted = false): CloudSubscriptionStatus {
  if (deleted) return 'canceled'
  const status = readString(value)
  if (status === 'trialing' || status === 'active' || status === 'past_due' || status === 'canceled' || status === 'incomplete') {
    return status
  }
  return 'incomplete'
}

function metadataObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstSubscriptionPriceId(subscription: Record<string, unknown>) {
  const items = metadataObject(subscription.items)
  const data = Array.isArray(items.data) ? items.data : []
  const first = data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])
    ? data[0] as Record<string, unknown>
    : null
  const price = first?.price && typeof first.price === 'object' && !Array.isArray(first.price)
    ? first.price as Record<string, unknown>
    : null
  return readString(price?.id)
}

function verifyStripeSignature(input: {
  rawBody: string
  signatureHeader: string | null
  webhookSecret: string
  now: Date
}) {
  const header = input.signatureHeader
  if (!header) throw new BillingWebhookAuthError('Stripe-Signature header is required.')
  const values = new Map<string, string[]>()
  for (const entry of header.split(',')) {
    const [key, value] = entry.split('=')
    if (!key || !value) continue
    const bucket = values.get(key) || []
    bucket.push(value)
    values.set(key, bucket)
  }
  const timestamp = values.get('t')?.[0]
  const signatures = values.get('v1') || []
  if (!timestamp || signatures.length === 0) throw new BillingWebhookAuthError('Stripe webhook signature is malformed.')
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isFinite(timestampMs) || Math.abs(input.now.getTime() - timestampMs) > 5 * 60 * 1000) {
    throw new BillingWebhookAuthError('Stripe webhook timestamp is outside the replay window.')
  }
  const expected = createHmac('sha256', input.webhookSecret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest('hex')
  const expectedBytes = Buffer.from(expected)
  const accepted = signatures.some((signature) => {
    const actualBytes = Buffer.from(signature)
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
  })
  if (!accepted) throw new BillingWebhookAuthError()
}

async function postStripeForm(input: {
  apiKey: string
  path: string
  form: URLSearchParams
  fetchImpl: FetchLike
}) {
  const response = await input.fetchImpl(`https://api.stripe.com/v1/${input.path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: input.form,
  })
  const json = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const error = metadataObject(json.error)
    throw new BillingAdapterError(response.status, readString(error.message) || 'Stripe billing request failed.')
  }
  return json
}

export function createStripeBillingAdapter(options: StripeBillingAdapterOptions): BillingAdapter {
  const fetchImpl = options.fetch || fetch
  const now = options.now || (() => new Date())
  const stripeConfig = options.config.stripe || {}

  return {
    providerId: 'stripe',
    enabled: true,

    async createCheckoutSession(input: BillingCheckoutInput): Promise<BillingCheckoutResult> {
      if (!options.apiKey) throw new BillingAdapterError(503, 'Stripe API key is not configured.')
      const plan = options.config.plans[input.planKey]
      const priceId = plan?.stripePriceId || stripeConfig.defaultPriceId
      if (!priceId) throw new BillingAdapterError(400, `No Stripe price is configured for plan "${input.planKey}".`)
      const successUrl = input.successUrl || stripeConfig.successUrl
      const cancelUrl = input.cancelUrl || stripeConfig.cancelUrl
      if (!successUrl || !cancelUrl) throw new BillingAdapterError(400, 'Stripe checkout requires success and cancel URLs.')

      const form = new URLSearchParams()
      form.set('mode', 'subscription')
      form.set('success_url', successUrl)
      form.set('cancel_url', cancelUrl)
      form.set('client_reference_id', input.orgId)
      form.set('customer_email', input.email)
      form.set('metadata[orgId]', input.orgId)
      form.set('metadata[accountId]', input.accountId || '')
      form.set('metadata[planKey]', input.planKey)
      form.set('subscription_data[metadata][orgId]', input.orgId)
      form.set('subscription_data[metadata][accountId]', input.accountId || '')
      form.set('subscription_data[metadata][planKey]', input.planKey)
      form.set('line_items[0][price]', priceId)
      form.set('line_items[0][quantity]', '1')

      const json = await postStripeForm({
        apiKey: options.apiKey,
        path: 'checkout/sessions',
        form,
        fetchImpl,
      })
      const url = readString(json.url)
      if (!url) throw new BillingAdapterError(502, 'Stripe checkout did not return a URL.')
      return {
        providerId: 'stripe',
        providerSessionId: readString(json.id),
        url,
      }
    },

    async createPortalSession(input: BillingPortalInput): Promise<BillingPortalResult> {
      if (!options.apiKey) throw new BillingAdapterError(503, 'Stripe API key is not configured.')
      const customerId = input.subscription?.providerCustomerId
      if (!customerId) throw new BillingAdapterError(404, 'No Stripe customer is associated with this org.')
      const returnUrl = input.returnUrl || stripeConfig.portalReturnUrl
      if (!returnUrl) throw new BillingAdapterError(400, 'Stripe portal requires a return URL.')
      const form = new URLSearchParams()
      form.set('customer', customerId)
      form.set('return_url', returnUrl)
      const json = await postStripeForm({
        apiKey: options.apiKey,
        path: 'billing_portal/sessions',
        form,
        fetchImpl,
      })
      const url = readString(json.url)
      if (!url) throw new BillingAdapterError(502, 'Stripe portal did not return a URL.')
      return {
        providerId: 'stripe',
        url,
      }
    },

    handleWebhook(input: BillingWebhookInput): BillingWebhookResult {
      if (options.webhookSecret) {
        verifyStripeSignature({
          rawBody: input.rawBody,
          signatureHeader: firstHeader(input.headers, 'stripe-signature'),
          webhookSecret: options.webhookSecret,
          now: now(),
        })
      }
      const event = input.body
      const eventId = readString(event.id)
      const eventType = readString(event.type)
      if (!eventId || !eventType) throw new BillingAdapterError(400, 'Stripe webhook event id and type are required.')
      const data = metadataObject(event.data)
      const object = metadataObject(data.object)

      if (eventType === 'checkout.session.completed') {
        const metadata = metadataObject(object.metadata)
        const orgId = readString(metadata.orgId) || readString(object.client_reference_id)
        const planKey = readString(metadata.planKey) || options.config.defaultPlanKey
        if (!orgId) {
          return { providerId: 'stripe', eventId, eventType }
        }
        return {
          providerId: 'stripe',
          eventId,
          eventType,
          subscription: {
            orgId,
            providerId: 'stripe',
            providerCustomerId: readString(object.customer),
            providerSubscriptionId: readString(object.subscription),
            planKey,
            status: 'active',
            seats: 1,
            entitlements: planEntitlements(options.config, planKey),
            metadata: { stripeEventType: eventType },
          },
        }
      }

      if (eventType.startsWith('customer.subscription.')) {
        const metadata = metadataObject(object.metadata)
        const priceId = firstSubscriptionPriceId(object)
        const planKey = readString(metadata.planKey) || subscriptionPlanKeyForPrice(options.config, priceId)
        const orgId = readString(metadata.orgId)
        if (!orgId) {
          return { providerId: 'stripe', eventId, eventType }
        }
        const currentPeriodEndSeconds = Number(object.current_period_end)
        return {
          providerId: 'stripe',
          eventId,
          eventType,
          subscription: {
            orgId,
            providerId: 'stripe',
            providerCustomerId: readString(object.customer),
            providerSubscriptionId: readString(object.id),
            planKey,
            status: stripeStatus(object.status, eventType === 'customer.subscription.deleted'),
            seats: Number(object.quantity) || 1,
            entitlements: planEntitlements(options.config, planKey),
            currentPeriodEnd: Number.isFinite(currentPeriodEndSeconds)
              ? new Date(currentPeriodEndSeconds * 1000)
              : null,
            cancelAtPeriodEnd: readBoolean(object.cancel_at_period_end),
            metadata: {
              stripeEventType: eventType,
              priceId,
            },
          },
        }
      }

      return { providerId: 'stripe', eventId, eventType }
    },
  }
}
