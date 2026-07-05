import type {
  CloudBillingConfig,
  CloudBillingEntitlements,
  CloudFeatureKey,
  CloudSubscriptionStatus,
} from '@open-cowork/shared'
import type {
  BillingSubscriptionRecord,
  UpsertBillingSubscriptionInput,
} from './control-plane-store.ts'

export type BillingAction =
  | 'session.create'
  | 'prompt.enqueue'
  | 'worker.execute'
  | 'byok.provider'
  | 'artifact.upload'
  | 'gateway.session.bind'
  | 'channel.manage'

export type BillingEntitlementVerdict = {
  allowed: boolean
  status?: number
  reason?: string | null
  policyCode?: string | null
}

// Maps each billing-metered action to the product feature its plan must
// include. A plan's `entitlements.features` can exclude a feature per-tenant
// (independently of the deployment-wide `policy.features` gate). Only an
// explicit `false` denies — an unset feature stays allowed, so plans without a
// `features` block keep their existing behaviour.
const BILLING_ACTION_FEATURE: Partial<Record<BillingAction, CloudFeatureKey>> = {
  'session.create': 'chat',
  'prompt.enqueue': 'chat',
  'worker.execute': 'workflows',
  'artifact.upload': 'artifacts',
  'byok.provider': 'byok',
  'channel.manage': 'channels',
  'gateway.session.bind': 'channels',
}

export type BillingCheckoutInput = {
  orgId: string
  accountId: string | null
  email: string
  planKey: string
  successUrl?: string | null
  cancelUrl?: string | null
}

export type BillingCheckoutResult = {
  providerId: string
  providerSessionId: string | null
  url: string
  subscription?: UpsertBillingSubscriptionInput | null
}

export type BillingPortalInput = {
  orgId: string
  email: string
  subscription: BillingSubscriptionRecord | null
  returnUrl?: string | null
}

export type BillingPortalResult = {
  providerId: string
  url: string
}

export type BillingWebhookInput = {
  headers: Record<string, string | undefined>
  rawBody: string
  body: Record<string, unknown>
}

export type BillingWebhookResult = {
  providerId: string
  eventId: string
  eventType: string
  subscription?: UpsertBillingSubscriptionInput | null
}

export type BillingAdapter = {
  readonly providerId: string
  readonly enabled: boolean
  createCheckoutSession(input: BillingCheckoutInput): Promise<BillingCheckoutResult> | BillingCheckoutResult
  createPortalSession(input: BillingPortalInput): Promise<BillingPortalResult> | BillingPortalResult
  handleWebhook(input: BillingWebhookInput): Promise<BillingWebhookResult> | BillingWebhookResult
}

export class BillingAdapterError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
}

export class BillingWebhookAuthError extends BillingAdapterError {
  constructor(message = 'Billing webhook authorization failed.') {
    super(401, message)
  }
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<CloudSubscriptionStatus>(['active', 'trialing'])

function entitlementList(value: string[] | null | undefined) {
  const list = (value || []).map((entry) => entry.trim()).filter(Boolean)
  return list.length > 0 ? new Set(list) : null
}

export function isBillingConfigured(config: CloudBillingConfig) {
  return config.enabled === true && config.provider !== 'none'
}

export function isBillingSubscriptionActive(subscription: BillingSubscriptionRecord | null | undefined) {
  return Boolean(subscription && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status))
}

export function planEntitlements(config: CloudBillingConfig, planKey: string | null | undefined): CloudBillingEntitlements {
  return {
    ...(config.plans[planKey || config.defaultPlanKey]?.entitlements || {}),
  }
}

export function resolvedBillingEntitlements(
  config: CloudBillingConfig,
  subscription: BillingSubscriptionRecord | null | undefined,
): CloudBillingEntitlements {
  return {
    ...planEntitlements(config, subscription?.planKey || config.defaultPlanKey),
    ...(subscription?.entitlements || {}),
  }
}

export function subscriptionPlanKeyForPrice(config: CloudBillingConfig, priceId: string | null | undefined) {
  if (!priceId) return config.defaultPlanKey
  for (const [planKey, plan] of Object.entries(config.plans)) {
    if (plan.stripePriceId === priceId) return planKey
  }
  return config.defaultPlanKey
}

export function evaluateBillingEntitlement(input: {
  config: CloudBillingConfig
  subscription: BillingSubscriptionRecord | null
  action: BillingAction
  profileName?: string | null
  providerId?: string | null
}): BillingEntitlementVerdict {
  if (!isBillingConfigured(input.config)) return { allowed: true }

  if (!input.subscription) {
    return {
      allowed: false,
      status: 402,
      reason: 'A billing subscription is required for this cloud org.',
      policyCode: 'billing.subscription_required',
    }
  }

  if (!isBillingSubscriptionActive(input.subscription)) {
    return {
      allowed: false,
      status: 402,
      reason: `Billing subscription is ${input.subscription.status}.`,
      policyCode: 'billing.subscription_inactive',
    }
  }

  const entitlements = resolvedBillingEntitlements(input.config, input.subscription)

  const gatedFeature = BILLING_ACTION_FEATURE[input.action]
  if (gatedFeature && entitlements.features?.[gatedFeature] === false) {
    return {
      allowed: false,
      status: 402,
      reason: `The "${gatedFeature}" feature is not included in this plan.`,
      policyCode: 'billing.feature_not_entitled',
    }
  }

  const allowedProfiles = entitlementList(entitlements.allowedProfiles)
  if (input.profileName && allowedProfiles && !allowedProfiles.has(input.profileName)) {
    return {
      allowed: false,
      status: 402,
      reason: `Cloud profile "${input.profileName}" is not included in this plan.`,
      policyCode: 'billing.profile_not_entitled',
    }
  }

  if (input.action === 'byok.provider' && input.providerId) {
    const allowedProviders = entitlementList(entitlements.allowedProviders)
    if (allowedProviders && !allowedProviders.has(input.providerId)) {
      return {
        allowed: false,
        status: 402,
        reason: `Provider "${input.providerId}" is not included in this plan.`,
        policyCode: 'billing.provider_not_entitled',
      }
    }
  }

  if (input.action === 'session.create' && entitlements.allowNewSessions === false) {
    return {
      allowed: false,
      status: 402,
      reason: 'Creating new cloud sessions is not included in this plan.',
      policyCode: 'billing.sessions_not_entitled',
    }
  }
  if (input.action === 'prompt.enqueue' && entitlements.allowPrompts === false) {
    return {
      allowed: false,
      status: 402,
      reason: 'Cloud prompts are not included in this plan.',
      policyCode: 'billing.prompts_not_entitled',
    }
  }
  if (input.action === 'worker.execute' && entitlements.allowWorkers === false) {
    return {
      allowed: false,
      status: 402,
      reason: 'Cloud worker execution is not included in this plan.',
      policyCode: 'billing.workers_not_entitled',
    }
  }

  return { allowed: true }
}
