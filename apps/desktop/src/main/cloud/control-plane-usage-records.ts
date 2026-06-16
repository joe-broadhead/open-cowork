import type { CloudBillingEntitlements } from '../config-types.ts'
import type { QuotaPolicyCode } from './control-plane-errors.ts'
import type { BillingSubscriptionStatus, UsageEventType, UsageUnit } from './control-plane-enums.ts'

// The control-plane's usage / billing / quota / rate-limit record shapes,
// extracted from the 4k-line in-memory store. Pure types that depend only on the
// enum vocabulary plus the billing entitlements + quota policy-code contracts.

export type UsageEventRecord = {
  eventId: string
  orgId: string
  accountId: string | null
  eventType: UsageEventType | string
  quantity: number
  unit: UsageUnit | string
  metadata: Record<string, unknown>
  createdAt: string
}

export type BillingSubscriptionRecord = {
  orgId: string
  planKey: string
  providerId: string
  providerCustomerId: string | null
  providerSubscriptionId: string | null
  status: BillingSubscriptionStatus
  seats: number
  entitlements: CloudBillingEntitlements
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type QuotaConsumptionRecord = {
  allowed: boolean
  orgId: string
  quotaKey: string
  limit: number
  used: number
  remaining: number
  resetAt: string
  retryAfterMs: number
  policyCode?: QuotaPolicyCode | string
}

export type UsageQuotaCounterRecord = {
  orgId: string
  quotaKey: string
  windowStartedAtMs: number
  quantity: number
}

export type RateLimitClaimRecord = {
  allowed: boolean
  scope: string
  source: string
  limit: number
  count: number
  resetAt: string
  retryAfterMs: number
  policyCode?: QuotaPolicyCode | string
}

export type CloudAuthBackoffRecord = {
  allowed: boolean
  scope: string
  source: string
  failureCount: number
  blockedUntilMs: number
  retryAfterMs: number
}
