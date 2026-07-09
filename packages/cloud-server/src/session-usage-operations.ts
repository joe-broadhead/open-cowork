// Usage + artifact write paths, carved out of the CloudSessionService god class (ARCH
// god-class, P2). These methods carry real body logic — billing-entitlement gating,
// per-day artifact quota consumption, worker-minute reconciliation against the hourly
// quota, and product-event projection — moved verbatim so behavior is byte-identical;
// CloudSessionService keeps thin delegators. The pure pass-throughs to the usage
// governance sub-service (recordManagedWorkClaimed/recordManagedExecutionEvent) and the
// read-only summaries (getUsageSummary/listUsageEvents) stay on CloudSessionService.
import type {
  ArtifactUploadReservationRecord,
  ControlPlaneStore,
  SessionEventRecord,
} from './control-plane-store.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import type { BillingAction } from './billing-adapter.ts'
import type { CloudUsageGovernanceService } from './services/usage-governance-service.ts'
import type { AppendProjectedEventInput } from './session-projection-service.ts'
import type { CloudAbuseConfig, CloudProjectedSessionEventType } from '@open-cowork/shared'
import type { CloudPrincipal, CloudSessionView } from './session-service.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type CloudUsageOperationsServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  abuse: CloudAbuseConfig
  usageGovernance: CloudUsageGovernanceService
  principalOrgId: (principal: CloudPrincipal) => string
  assertBillingAllowed: (input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) => Promise<void>
  getSessionView: (principal: CloudPrincipal, sessionId: string) => Promise<CloudSessionView>
  appendProjectedEvent: (input: AppendProjectedEventInput) => Promise<SessionEventRecord>
}

export class CloudUsageOperationsService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly abuse: CloudAbuseConfig
  private readonly usageGovernance: CloudUsageGovernanceService
  private readonly principalOrgId: CloudUsageOperationsServiceOptions['principalOrgId']
  private readonly assertBillingAllowed: CloudUsageOperationsServiceOptions['assertBillingAllowed']
  private readonly getSessionView: CloudUsageOperationsServiceOptions['getSessionView']
  private readonly appendProjectedEvent: CloudUsageOperationsServiceOptions['appendProjectedEvent']

  constructor(options: CloudUsageOperationsServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.abuse = options.abuse
    this.usageGovernance = options.usageGovernance
    this.principalOrgId = options.principalOrgId
    this.assertBillingAllowed = options.assertBillingAllowed
    this.getSessionView = options.getSessionView
    this.appendProjectedEvent = options.appendProjectedEvent
  }

  async appendProductEvent(
    principal: CloudPrincipal,
    sessionId: string,
    input: {
      eventId?: string
      type: CloudProjectedSessionEventType
      payload?: Record<string, unknown>
      createdAt?: Date
    },
  ) {
    await this.getSessionView(principal, sessionId)
    return this.appendProjectedEvent({
      tenantId: principal.tenantId,
      sessionId,
      eventId: input.eventId,
      type: input.type,
      payload: input.payload || {},
      createdAt: input.createdAt,
    })
  }

  async assertArtifactUploadAllowed(principal: CloudPrincipal, bytes: number) {
    const quota = await this.artifactUploadQuota(principal, bytes, new Date())
    if (!quota) return
    const result = await this.store.consumeUsageQuota(quota)
    if (!result.allowed) {
      throw this.usageGovernance.quotaError(
        'Cloud artifact upload quota exceeded.',
        'quota.artifact_bytes_per_day_exceeded',
        result.retryAfterMs,
      )
    }
  }

  private async artifactUploadQuota(principal: CloudPrincipal, bytes: number, now: Date) {
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'artifact.upload',
      profileName: this.policy.profileName,
    })
    const quota = await this.usageGovernance.usageQuotaForOrg({
      orgId: this.principalOrgId(principal),
      quotaKey: 'artifact_bytes:day',
      limit: this.abuse.maxArtifactBytesPerDay,
      entitlementLimitKey: 'maxArtifactBytesPerDay',
      quantity: bytes,
      windowMs: DAY_MS,
      policyCode: 'quota.artifact_bytes_per_day_exceeded',
    })
    return quota ? { ...quota, now } : null
  }

  async reserveArtifactUploadQuota(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    objectKey: string
    filename: string
    contentType: string | null
    expectedBytes: number
    expiresAt: string
  }): Promise<ArtifactUploadReservationRecord> {
    const now = new Date()
    const quota = await this.artifactUploadQuota(principal, input.expectedBytes, now)
    const result = await this.store.createArtifactUploadReservation({
      orgId: this.principalOrgId(principal),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      objectKey: input.objectKey,
      filename: input.filename,
      contentType: input.contentType,
      reservedBytes: input.expectedBytes,
      expiresAt: input.expiresAt,
      quota,
      createdAt: now,
    })
    if (result.quota && !result.quota.allowed) {
      throw this.usageGovernance.quotaError(
        'Cloud artifact upload quota exceeded.',
        'quota.artifact_bytes_per_day_exceeded',
        result.quota.retryAfterMs,
      )
    }
    if (!result.reservation) throw new CloudServiceError(409, 'Cloud artifact upload reservation could not be created.')
    return result.reservation
  }

  async getArtifactUploadReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
  }): Promise<ArtifactUploadReservationRecord | null> {
    return this.store.getArtifactUploadReservation({
      orgId: this.principalOrgId(principal),
      tenantId: principal.tenantId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
    })
  }

  async settleArtifactUploadQuotaReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    actualBytes: number
  }): Promise<ArtifactUploadReservationRecord> {
    const now = new Date()
    const quota = await this.artifactUploadQuota(principal, input.actualBytes, now)
    const result = await this.store.settleArtifactUploadReservation({
      orgId: this.principalOrgId(principal),
      tenantId: principal.tenantId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      actualBytes: input.actualBytes,
      quota,
      now,
    })
    if (result.quota && !result.quota.allowed) {
      throw this.usageGovernance.quotaError(
        'Cloud artifact upload quota exceeded.',
        'quota.artifact_bytes_per_day_exceeded',
        result.quota.retryAfterMs,
      )
    }
    if (!result.reservation) throw new CloudServiceError(409, 'Cloud artifact upload reservation was not found.')
    if (!result.settled && result.reservation.status !== 'settled') {
      throw new CloudServiceError(409, `Cloud artifact upload reservation is ${result.reservation.status}.`)
    }
    return result.reservation
  }

  async releaseArtifactUploadQuotaReservation(principal: CloudPrincipal, input: {
    sessionId: string
    artifactId: string
    status: 'expired' | 'failed'
  }): Promise<ArtifactUploadReservationRecord | null> {
    return this.store.releaseArtifactUploadReservation({
      orgId: this.principalOrgId(principal),
      tenantId: principal.tenantId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      status: input.status,
      now: new Date(),
    })
  }

  async recordArtifactUploaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    await this.usageGovernance.recordUsage({
      eventId: `artifact.uploaded:${principal.tenantId}:${sessionId}:${artifactId}`,
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      eventType: 'artifact.uploaded',
      quantity: bytes,
      unit: 'byte',
      metadata: { tenantId: principal.tenantId, sessionId, artifactId },
    })
  }

  async recordArtifactDownloaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    await this.usageGovernance.recordUsage({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      eventType: 'artifact.downloaded',
      quantity: bytes,
      unit: 'byte',
      metadata: { tenantId: principal.tenantId, sessionId, artifactId },
    })
  }

  async recordWorkerMinutes(input: {
    tenantId: string
    sessionId: string
    workerId: string
    elapsedMs: number
    reservedMinutes?: number
  }) {
    if (!this.abuse.enabled) return null
    const org = await this.store.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId })
    const minutes = Math.max(1, Math.ceil(input.elapsedMs / 60_000))
    const unreservedMinutes = Math.max(0, minutes - Math.max(0, Math.floor(input.reservedMinutes || 0)))
    const workerMinuteLimit = this.usageGovernance.quotaLimit(await this.usageGovernance.effectiveQuotaLimit(
      org.orgId,
      this.abuse.maxWorkerMinutesPerHour,
      'maxWorkerMinutesPerHour',
    ))
    if (workerMinuteLimit && unreservedMinutes > 0) {
      const now = new Date()
      const quota = await this.store.consumeUsageQuota({
        orgId: org.orgId,
        quotaKey: 'worker_minutes:hour',
        limit: workerMinuteLimit,
        quantity: unreservedMinutes,
        windowMs: HOUR_MS,
        now,
        policyCode: 'quota.worker_minutes_per_hour_exceeded',
      })
      if (!quota.allowed && quota.remaining > 0) {
        await this.store.consumeUsageQuota({
          orgId: org.orgId,
          quotaKey: 'worker_minutes:hour',
          limit: workerMinuteLimit,
          quantity: quota.remaining,
          windowMs: HOUR_MS,
          now,
          policyCode: 'quota.worker_minutes_per_hour_exceeded',
        })
      }
    }
    return this.store.recordUsageEvent({
      orgId: org.orgId,
      eventType: 'worker.minute',
      quantity: minutes,
      unit: 'minute',
      metadata: {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        workerId: input.workerId,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
      },
    })
  }
}
