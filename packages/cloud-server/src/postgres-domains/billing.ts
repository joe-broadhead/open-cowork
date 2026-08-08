import type { ArtifactUploadReservationRecord, BillingSubscriptionRecord, UsageEventRecord } from '../control-plane-store.ts'
import { normalizeArtifactUploadPublicationMetadata } from '../artifact-upload-publication.ts'
import { iso, isoOrNull, jsonRecord, numberValue, stringOrNull, type QueryRow } from './shared.ts'

export function usageEventFromRow(row: QueryRow): UsageEventRecord {
  return {
    eventId: String(row.event_id),
    orgId: String(row.org_id),
    accountId: stringOrNull(row.account_id),
    eventType: String(row.event_type),
    quantity: numberValue(row.quantity),
    unit: String(row.unit),
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
  }
}

export function billingSubscriptionFromRow(row: QueryRow): BillingSubscriptionRecord {
  return {
    orgId: String(row.org_id),
    planKey: String(row.plan_key),
    providerId: String(row.provider_id),
    providerCustomerId: stringOrNull(row.provider_customer_id),
    providerSubscriptionId: stringOrNull(row.provider_subscription_id),
    status: String(row.status) as BillingSubscriptionRecord['status'],
    seats: numberValue(row.seats),
    entitlements: jsonRecord(row.entitlements) as BillingSubscriptionRecord['entitlements'],
    currentPeriodEnd: isoOrNull(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function artifactUploadReservationFromRow(row: QueryRow): ArtifactUploadReservationRecord {
  return {
    orgId: String(row.org_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    artifactId: String(row.artifact_id),
    objectKey: String(row.object_key),
    stagingObjectKey: String(row.staging_object_key),
    finalObjectKey: String(row.final_object_key),
    filename: String(row.filename),
    contentType: stringOrNull(row.content_type),
    checksumSha256: stringOrNull(row.checksum_sha256),
    stagingCleanedAt: isoOrNull(row.staging_cleaned_at),
    publication: normalizeArtifactUploadPublicationMetadata(
      jsonRecord(row.publication_metadata) as ArtifactUploadReservationRecord['publication'],
    ),
    quotaKey: stringOrNull(row.quota_key),
    quotaWindowMs: row.quota_window_ms === null || row.quota_window_ms === undefined ? null : numberValue(row.quota_window_ms),
    quotaWindowStartedAtMs: row.quota_window_started_at_ms === null || row.quota_window_started_at_ms === undefined ? null : numberValue(row.quota_window_started_at_ms),
    reservedBytes: numberValue(row.reserved_bytes),
    status: String(row.status) as ArtifactUploadReservationRecord['status'],
    cleanupReason: stringOrNull(row.cleanup_reason) as ArtifactUploadReservationRecord['cleanupReason'],
    cleanupRequestedAt: isoOrNull(row.cleanup_requested_at),
    claimOwner: stringOrNull(row.claim_owner),
    claimToken: stringOrNull(row.claim_token),
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    cleanupAttempts: numberValue(row.cleanup_attempts),
    cleanupPasses: numberValue(row.cleanup_passes),
    finalizationAttempts: numberValue(row.finalization_attempts),
    nextCleanupAttemptAt: isoOrNull(row.next_cleanup_attempt_at),
    lastErrorCode: stringOrNull(row.last_error_code),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}
