import type { CloudBillingConfig, CloudBillingEntitlements, CloudFeatureKey } from '@open-cowork/shared'
import type { BillingSubscriptionRecord } from '../control-plane-usage-records.ts'
import { isBillingSubscriptionActive, resolvedBillingEntitlements } from '../billing-adapter.ts'
import {
  allEntitlementFeatures,
  type EntitlementContext,
  type EntitlementFeature,
  type EntitlementPlanStatus,
  type EntitlementQuotaVerdict,
  type EntitlementResolver,
  type EntitlementResource,
  type EntitlementVerdict,
} from './entitlement-resolver.ts'

// The `stripe`-style resolver. It decides entitlements PURELY from stored plan +
// subscription state (the same billing_subscriptions state the webhook adapter
// syncs) — it never calls Stripe or any payment provider. That sync boundary is
// the BillingAdapter, injected separately; this resolver only reads decisions.

// Each product feature maps to the deployment feature flag that gates it, mirroring
// the billing-action → feature map but in the resolver's feature vocabulary.
const FEATURE_KEY: Record<EntitlementFeature, CloudFeatureKey> = {
  sessions: 'chat',
  prompts: 'chat',
  workers: 'workflows',
  workflows: 'workflows',
  artifacts: 'artifacts',
  byok: 'byok',
  channels: 'channels',
}

function allowlist(value: string[] | null | undefined): Set<string> | null {
  const list = (value || []).map((entry) => entry.trim()).filter(Boolean)
  return list.length > 0 ? new Set(list) : null
}

function deny(reason: string, policyCode: string): EntitlementVerdict {
  return { allowed: false, status: 402, reason, policyCode }
}

export type MetadataEntitlementResolverOptions = {
  billingConfig: CloudBillingConfig | null
  loadSubscription: (orgId: string) => Promise<BillingSubscriptionRecord | null>
  provider?: string
}

export class MetadataEntitlementResolver implements EntitlementResolver {
  readonly provider: string
  readonly gating = true
  private readonly billingConfig: CloudBillingConfig | null
  private readonly loadSubscription: (orgId: string) => Promise<BillingSubscriptionRecord | null>

  constructor(options: MetadataEntitlementResolverOptions) {
    this.billingConfig = options.billingConfig
    this.loadSubscription = options.loadSubscription
    this.provider = options.provider || 'stripe'
  }

  async canUse(feature: EntitlementFeature, context: EntitlementContext): Promise<EntitlementVerdict> {
    // No plan catalog ⇒ nothing to price against, so nothing is gated.
    if (!this.billingConfig) return { allowed: true }
    const subscription = await this.loadSubscription(context.orgId)
    // A subscription that exists but has lapsed (past_due/canceled/incomplete)
    // denies gated writes — but reads/admin never reach here (write-only rule).
    if (subscription && !isBillingSubscriptionActive(subscription)) {
      return deny(`Billing subscription is ${subscription.status}.`, 'entitlements.subscription_inactive')
    }
    const entitlements = resolvedBillingEntitlements(this.billingConfig, subscription)
    return this.featureVerdict(feature, entitlements, context)
  }

  async checkQuota(
    resource: EntitlementResource,
    amount: number,
    context: EntitlementContext,
  ): Promise<EntitlementQuotaVerdict> {
    if (!this.billingConfig) return { allowed: true, limit: null, remaining: null }
    const subscription = await this.loadSubscription(context.orgId)
    const entitlements = resolvedBillingEntitlements(this.billingConfig, subscription)
    const limit = this.resourceLimit(resource, entitlements, subscription)
    if (limit === null || limit === undefined) return { allowed: true, limit: null, remaining: null }
    if (amount > limit) {
      return {
        ...deny(`This plan allows at most ${limit} ${resource.replace(/_/g, ' ')}.`, `entitlements.${resource}_quota_exceeded`),
        limit,
        remaining: 0,
      }
    }
    return { allowed: true, limit, remaining: Math.max(0, limit - amount) }
  }

  async describeEntitlements(context: EntitlementContext): Promise<EntitlementPlanStatus> {
    const subscription = this.billingConfig ? await this.loadSubscription(context.orgId) : null
    const entitlements = this.billingConfig ? resolvedBillingEntitlements(this.billingConfig, subscription) : {}
    const planKey = subscription?.planKey || this.billingConfig?.defaultPlanKey || null
    const planLabel = planKey ? this.billingConfig?.plans?.[planKey]?.label ?? planKey : null
    return {
      provider: this.provider,
      gatingEnabled: true,
      billingEnabled: true,
      planKey,
      planLabel,
      subscriptionStatus: subscription?.status ?? null,
      seats: subscription?.seats ?? null,
      features: this.featureMap(entitlements),
      limits: {
        seats: subscription?.seats ?? null,
        concurrent_sessions: entitlements.maxConcurrentSessionsPerOrg ?? null,
        concurrent_workflow_runs: entitlements.maxConcurrentWorkflowRunsPerOrg ?? null,
        active_workers: entitlements.maxActiveWorkersPerOrg ?? null,
      },
    }
  }

  private featureVerdict(
    feature: EntitlementFeature,
    entitlements: CloudBillingEntitlements,
    context: EntitlementContext,
  ): EntitlementVerdict {
    if (entitlements.features?.[FEATURE_KEY[feature]] === false) {
      return deny(`The "${feature}" feature is not included in this plan.`, 'entitlements.feature_not_entitled')
    }
    if (feature === 'sessions' && entitlements.allowNewSessions === false) {
      return deny('Creating new cloud sessions is not included in this plan.', 'entitlements.sessions_not_entitled')
    }
    if (feature === 'prompts' && entitlements.allowPrompts === false) {
      return deny('Cloud prompts are not included in this plan.', 'entitlements.prompts_not_entitled')
    }
    if (feature === 'workers' && entitlements.allowWorkers === false) {
      return deny('Cloud worker execution is not included in this plan.', 'entitlements.workers_not_entitled')
    }
    if ((feature === 'sessions' || feature === 'prompts') && context.profileName) {
      const profiles = allowlist(entitlements.allowedProfiles)
      if (profiles && !profiles.has(context.profileName)) {
        return deny(`Cloud profile "${context.profileName}" is not included in this plan.`, 'entitlements.profile_not_entitled')
      }
    }
    if (feature === 'byok' && context.providerId) {
      const providers = allowlist(entitlements.allowedProviders)
      if (providers && !providers.has(context.providerId)) {
        return deny(`Provider "${context.providerId}" is not included in this plan.`, 'entitlements.provider_not_entitled')
      }
    }
    return { allowed: true }
  }

  private resourceLimit(
    resource: EntitlementResource,
    entitlements: CloudBillingEntitlements,
    subscription: BillingSubscriptionRecord | null,
  ): number | null | undefined {
    switch (resource) {
      case 'seats':
        return subscription && subscription.seats > 0 ? subscription.seats : null
      case 'concurrent_sessions':
        return entitlements.maxConcurrentSessionsPerOrg
      case 'concurrent_workflow_runs':
        return entitlements.maxConcurrentWorkflowRunsPerOrg
      case 'active_workers':
        return entitlements.maxActiveWorkersPerOrg
    }
  }

  private featureMap(entitlements: CloudBillingEntitlements): Record<EntitlementFeature, boolean> {
    const map = allEntitlementFeatures(true)
    for (const feature of Object.keys(map) as EntitlementFeature[]) {
      if (entitlements.features?.[FEATURE_KEY[feature]] === false) map[feature] = false
    }
    if (entitlements.allowNewSessions === false) map.sessions = false
    if (entitlements.allowPrompts === false) map.prompts = false
    if (entitlements.allowWorkers === false) map.workers = false
    return map
  }
}
