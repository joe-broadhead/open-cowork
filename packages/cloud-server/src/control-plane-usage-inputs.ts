import type { CloudBillingEntitlements } from '@open-cowork/shared'
import type { QuotaPolicyCode } from './control-plane-errors.ts'
import type { BillingSubscriptionStatus, UsageEventType, UsageUnit } from './control-plane-enums.ts'
import type {
  ArtifactUploadCleanupReason,
  ArtifactUploadPublicationMetadata,
} from './control-plane-usage-records.ts'

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

export type UsageQuotaReservation = {
  quotaKey: string
  windowStartedAtMs: number
  quantity: number
}

export type CreateArtifactUploadReservationInput = {
  orgId: string
  tenantId: string
  userId: string
  sessionId: string
  artifactId: string
  objectKey: string
  stagingObjectKey?: string
  finalObjectKey?: string
  filename: string
  contentType?: string | null
  checksumSha256?: string | null
  /** Optional only while the pre-saga upload caller is being migrated. */
  publication?: ArtifactUploadPublicationMetadata
  reservedBytes: number
  expiresAt: Date | string
  quota?: ConsumeUsageQuotaInput | null
  createdAt?: Date
}

export type ArtifactUploadReservationIdentity = {
  orgId: string
  tenantId: string
  sessionId: string
  artifactId: string
}

export type ClaimArtifactUploadFinalizationInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  claimTtlMs: number
  now?: Date
}

export type CompleteArtifactUploadFinalizationInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  now?: Date
}

export type ReleaseArtifactUploadClaimInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  errorCode: string
  retryAt: Date | string
  cleanupNotBefore: Date | string
  maxAttempts: number
  /**
   * Provider/publication uncertainty must remain retryable instead of eventually
   * authorizing destructive cleanup of an object that may already be published.
   */
  cleanupOnExhaustion?: boolean
  now?: Date
}

export type RequestArtifactUploadCleanupInput = ArtifactUploadReservationIdentity & {
  reason: ArtifactUploadCleanupReason
  claimOwner: string
  claimToken: string
  claimTtlMs: number
  cleanupNotBefore?: Date | string | null
  expectedFinalizationClaimOwner?: string | null
  expectedFinalizationClaimToken?: string | null
  now?: Date
}

export type CompleteArtifactUploadCleanupInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  now?: Date
}

export type DeferArtifactUploadCleanupInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  retryAt: Date | string
  now?: Date
}

export type FailArtifactUploadCleanupInput = ArtifactUploadReservationIdentity & {
  claimOwner: string
  claimToken: string
  errorCode: string
  retryAt: Date | string
  now?: Date
}

export type ClaimArtifactUploadReconciliationInput = {
  claimOwner: string
  claimToken: string
  claimTtlMs: number
  limit: number
  now?: Date
}

export type PruneArtifactUploadReservationsInput = {
  olderThan: Date
  limit: number
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
