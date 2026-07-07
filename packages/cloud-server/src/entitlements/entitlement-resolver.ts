import type { CloudBillingConfig } from '@open-cowork/shared'
import type { BillingSubscriptionRecord } from '../control-plane-usage-records.ts'

// Optional, pluggable monetization seam (#897). The application consults ONE
// typed EntitlementResolver for feature access + quotas. Billing is OPTIONAL:
// the default UnlimitedEntitlementResolver allows everything, so the `none`
// provider yields a complete, ungated product.
//
// Hard rule: feature/quota code asks the resolver — it MUST NEVER call a payment
// provider directly. The payment-provider sync boundary is the separate
// BillingAdapter (checkout/portal/webhook); a resolver decides purely from
// stored plan/subscription state.

// The product capabilities an entitlement decision can gate. These are all
// WRITE/creation verbs — reads, exports, deletes, and admin/RBAC/audit actions
// are intentionally absent so they can never be gated (see `assertEntitled`).
export type EntitlementFeature =
  | 'sessions'
  | 'prompts'
  | 'workers'
  | 'workflows'
  | 'artifacts'
  | 'byok'
  | 'channels'

export const ENTITLEMENT_FEATURES: readonly EntitlementFeature[] = [
  'sessions',
  'prompts',
  'workers',
  'workflows',
  'artifacts',
  'byok',
  'channels',
] as const

// Countable resources a plan can cap (seat/usage tiers).
export type EntitlementResource =
  | 'seats'
  | 'concurrent_sessions'
  | 'concurrent_workflow_runs'
  | 'active_workers'

export type EntitlementContext = {
  orgId: string
  // Optional runtime coordinates that some plans gate on (profile allowlist,
  // BYOK provider allowlist). Absent ⇒ that dimension is not checked.
  profileName?: string | null
  providerId?: string | null
}

export type EntitlementVerdict = {
  allowed: boolean
  // 402 for a plan/quota denial; a resolver may override for auth-style failures.
  status?: number
  reason?: string | null
  policyCode?: string | null
}

export type EntitlementQuotaVerdict = EntitlementVerdict & {
  limit?: number | null
  remaining?: number | null
}

// Read-only entitlement snapshot for the admin plane / future Billing UI. Safe
// to expose on any read path — carries NO secrets and never gates.
export type EntitlementPlanStatus = {
  provider: string
  // Whether gating is live (kill switch ON and a gating provider selected).
  gatingEnabled: boolean
  // Whether the admin plane should surface a Billing section for this deployment.
  billingEnabled: boolean
  planKey: string | null
  planLabel: string | null
  subscriptionStatus: string | null
  seats: number | null
  features: Record<EntitlementFeature, boolean>
  limits: Partial<Record<EntitlementResource, number | null>>
}

export interface EntitlementResolver {
  readonly provider: string
  // True only for resolvers that can deny. The unlimited resolver is `false`, so
  // callers and tests can assert "gating disabled ⇒ nothing is ever denied".
  readonly gating: boolean
  canUse(feature: EntitlementFeature, context: EntitlementContext): Promise<EntitlementVerdict> | EntitlementVerdict
  checkQuota(
    resource: EntitlementResource,
    amount: number,
    context: EntitlementContext,
  ): Promise<EntitlementQuotaVerdict> | EntitlementQuotaVerdict
  describeEntitlements(context: EntitlementContext): Promise<EntitlementPlanStatus> | EntitlementPlanStatus
}

// Thrown by `assertEntitled` on a gated WRITE denial. Carries a 402 by default so
// the HTTP layer can translate it into a payment-required response.
export class EntitlementDeniedError extends Error {
  readonly status: number
  readonly policyCode: string
  readonly publicMessage: string

  constructor(input: { status?: number, message: string, policyCode?: string }) {
    super(input.message)
    this.name = 'EntitlementDeniedError'
    this.status = input.status ?? 402
    this.policyCode = input.policyCode ?? 'entitlements.feature_not_entitled'
    this.publicMessage = input.message
  }
}

export function allEntitlementFeatures(value: boolean): Record<EntitlementFeature, boolean> {
  const map = {} as Record<EntitlementFeature, boolean>
  for (const feature of ENTITLEMENT_FEATURES) map[feature] = value
  return map
}

// The default resolver, and the `none` provider. Allows every feature/quota so a
// deployment that has not opted into billing gets the complete product. `gating`
// is false so the kill-switch/rollout contract is trivially satisfiable.
export class UnlimitedEntitlementResolver implements EntitlementResolver {
  readonly provider: string
  readonly gating = false

  constructor(provider = 'none') {
    this.provider = provider
  }

  canUse(): EntitlementVerdict {
    return { allowed: true }
  }

  checkQuota(): EntitlementQuotaVerdict {
    return { allowed: true, limit: null, remaining: null }
  }

  describeEntitlements(): EntitlementPlanStatus {
    return {
      provider: this.provider,
      gatingEnabled: false,
      billingEnabled: false,
      planKey: null,
      planLabel: null,
      subscriptionStatus: null,
      seats: null,
      features: allEntitlementFeatures(true),
      limits: {},
    }
  }
}

// The write-only gating convention. `assertEntitled` is called ONLY on
// create/write code paths — NEVER on reads, exports, deletes, or admin/RBAC/
// policy/audit actions. It throws EntitlementDeniedError (402 by default) when a
// resolver denies the feature.
export async function assertEntitled(
  resolver: EntitlementResolver,
  feature: EntitlementFeature,
  context: EntitlementContext,
): Promise<void> {
  const verdict = await resolver.canUse(feature, context)
  if (!verdict.allowed) {
    throw new EntitlementDeniedError({
      status: verdict.status ?? 402,
      message: verdict.reason || `The "${feature}" capability is not included in this plan.`,
      policyCode: verdict.policyCode ?? 'entitlements.feature_not_entitled',
    })
  }
}

// Custom-provider registration seam. A downstream fork wires its own resolver by
// registering a factory (typically under 'custom') from a small module at
// startup, then setting OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER=custom.
export type EntitlementResolverFactoryInput = {
  billingConfig: CloudBillingConfig | null
  loadSubscription: (orgId: string) => Promise<BillingSubscriptionRecord | null>
  enabled: boolean
}

export type EntitlementResolverFactory = (input: EntitlementResolverFactoryInput) => EntitlementResolver

const customFactories = new Map<string, EntitlementResolverFactory>()

export function registerEntitlementResolverProvider(name: string, factory: EntitlementResolverFactory): void {
  const key = name.trim().toLowerCase()
  if (!key) throw new Error('Entitlement resolver provider name must be a non-empty string.')
  customFactories.set(key, factory)
}

export function getRegisteredEntitlementResolverProvider(name: string): EntitlementResolverFactory | null {
  return customFactories.get(name.trim().toLowerCase()) || null
}

// Test/lifecycle helper: drop all registered custom factories.
export function clearRegisteredEntitlementResolverProviders(): void {
  customFactories.clear()
}
