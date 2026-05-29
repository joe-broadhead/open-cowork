import type { CloudPrincipal } from '../session-service.ts'
import type { UsageEventRecord } from '../control-plane-store.ts'

export type CloudQuotaServiceDelegate = {
  assertArtifactUploadAllowed(principal: CloudPrincipal, bytes: number): Promise<void>
  recordArtifactUploaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number): Promise<void>
  recordWorkerMinutes(input: { tenantId: string, minutes: number, now?: Date }): Promise<void>
  listUsageEvents(principal: CloudPrincipal, limit?: number): Promise<UsageEventRecord[]>
  claimHttpRateLimit(input: { scope: string, source: string, now?: Date }): Promise<void>
  checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }): Promise<void>
  recordCloudAuthFailure(input: { scope: string, source: string, now?: Date }): Promise<void>
}

export class CloudQuotaService {
  private readonly delegate: CloudQuotaServiceDelegate

  constructor(delegate: CloudQuotaServiceDelegate) {
    this.delegate = delegate
  }

  assertArtifactUploadAllowed(principal: CloudPrincipal, bytes: number) {
    return this.delegate.assertArtifactUploadAllowed(principal, bytes)
  }

  recordArtifactUploaded(principal: CloudPrincipal, sessionId: string, artifactId: string, bytes: number) {
    return this.delegate.recordArtifactUploaded(principal, sessionId, artifactId, bytes)
  }

  recordWorkerMinutes(input: { tenantId: string, minutes: number, now?: Date }) {
    return this.delegate.recordWorkerMinutes(input)
  }

  listUsageEvents(principal: CloudPrincipal, limit?: number) {
    return this.delegate.listUsageEvents(principal, limit)
  }

  claimHttpRateLimit(input: { scope: string, source: string, now?: Date }) {
    return this.delegate.claimHttpRateLimit(input)
  }

  checkCloudAuthBackoff(input: { scope: string, source?: string, now?: Date }) {
    return this.delegate.checkCloudAuthBackoff(input)
  }

  recordCloudAuthFailure(input: { scope: string, source: string, now?: Date }) {
    return this.delegate.recordCloudAuthFailure(input)
  }
}
