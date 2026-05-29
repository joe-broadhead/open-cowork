import type { ControlPlaneStore } from '../control-plane-store.ts'

export type BillingControlPlaneStore = Pick<ControlPlaneStore,
  | 'upsertBillingSubscription'
  | 'getBillingSubscription'
  | 'findBillingSubscriptionByProvider'
>

export type UsageControlPlaneStore = Pick<ControlPlaneStore,
  | 'recordUsageEvent'
  | 'listUsageEvents'
>

export type QuotaControlPlaneStore = Pick<ControlPlaneStore,
  | 'consumeUsageQuota'
  | 'recordUsageEvent'
  | 'listUsageEvents'
  | 'claimRateLimit'
  | 'checkCloudAuthBackoff'
  | 'recordCloudAuthFailure'
>
