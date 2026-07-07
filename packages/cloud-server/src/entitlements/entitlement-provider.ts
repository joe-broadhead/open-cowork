import type { CloudBillingConfig, CloudEntitlementsConfig } from '@open-cowork/shared'
import type { BillingSubscriptionRecord } from '../control-plane-usage-records.ts'
import {
  UnlimitedEntitlementResolver,
  getRegisteredEntitlementResolverProvider,
  type EntitlementResolver,
} from './entitlement-resolver.ts'
import { MetadataEntitlementResolver } from './metadata-entitlement-resolver.ts'

// Config-selected resolver construction. The kill switch is honoured HERE so it
// disables gating uniformly regardless of provider: `enabled: false` always
// yields the unlimited resolver.
export type ResolveEntitlementResolverInput = {
  config: CloudEntitlementsConfig
  billingConfig: CloudBillingConfig | null
  loadSubscription: (orgId: string) => Promise<BillingSubscriptionRecord | null>
}

export function resolveEntitlementResolver(input: ResolveEntitlementResolverInput): EntitlementResolver {
  // Kill switch: OFF ⇒ unlimited regardless of provider (safe rollout / instant
  // disable). This is the grandfather guarantee — existing orgs never break until
  // an operator explicitly opts in.
  if (!input.config.enabled) return new UnlimitedEntitlementResolver('none')

  switch (input.config.provider) {
    case 'stripe':
      return new MetadataEntitlementResolver({
        billingConfig: input.billingConfig,
        loadSubscription: input.loadSubscription,
      })
    case 'custom': {
      const factory = getRegisteredEntitlementResolverProvider('custom')
      if (!factory) {
        throw new Error(
          'OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER=custom but no custom entitlement resolver is registered. '
          + 'Call registerEntitlementResolverProvider("custom", factory) from a startup module.',
        )
      }
      return factory({
        billingConfig: input.billingConfig,
        loadSubscription: input.loadSubscription,
        enabled: true,
      })
    }
    case 'none':
    default:
      return new UnlimitedEntitlementResolver('none')
  }
}
