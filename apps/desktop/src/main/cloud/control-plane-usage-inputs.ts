import type { CloudBillingEntitlements } from '../config-types.ts'
import type { QuotaPolicyCode } from './control-plane-errors.ts'
import type { BillingSubscriptionStatus, UsageEventType, UsageUnit } from './control-plane-enums.ts'

// The control-plane's session / usage / billing / rate-limit / auth-backoff
// operation input shapes, extracted from the 4k-line in-memory store. Pure types
// depending only on the enum vocabulary plus the billing-entitlements and
// quota-policy-code contracts.

export type CreateSessionInput = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  title?: string | null
  createdAt?: Date
  quota?: {
    orgId?: string | null
    maxConcurrentSessionsPerOrg?: number | null
    policyCode?: QuotaPolicyCode | string
  } | null
}

export type ConsumeUsageQuotaInput = {
  orgId: string
  quotaKey: string
  limit: number
  quantity?: number
  windowMs: number
  now?: Date
  policyCode?: QuotaPolicyCode | string
}

export type RecordUsageEventInput = {
  eventId?: string
  orgId: string
  accountId?: string | null
  eventType: UsageEventType | string
  quantity?: number
  unit?: UsageUnit | string
  metadata?: Record<string, unknown>
  createdAt?: Date
}

export type UpsertBillingSubscriptionInput = {
  orgId: string
  planKey: string
  providerId: string
  providerCustomerId?: string | null
  providerSubscriptionId?: string | null
  status: BillingSubscriptionStatus
  seats?: number
  entitlements?: CloudBillingEntitlements
  currentPeriodEnd?: Date | string | null
  cancelAtPeriodEnd?: boolean
  metadata?: Record<string, unknown>
  updatedAt?: Date
}

export type ClaimRateLimitInput = {
  scope: string
  source: string
  limit: number
  windowMs: number
  now?: Date
  policyCode?: QuotaPolicyCode | string
}

export type CheckCloudAuthBackoffInput = {
  scope: string
  source?: string
  now?: Date
}

export type RecordCloudAuthFailureInput = {
  scope: string
  source: string
  windowMs: number
  limit: number
  backoffMs: number
  now?: Date
}
