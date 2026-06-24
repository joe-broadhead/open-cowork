import {
  type CloudProjectSnapshotUploadInput,
  type CloudProjectSnapshotUploadResult,
  type CloudProjectSource,
  type CloudProjectSourceInput,
  type CloudProjectSourcePolicyVerdict,
  normalizeCloudProjectSource,
} from '@open-cowork/shared'
import type { ControlPlaneStore } from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import {
  evaluateCloudProjectSourcePolicy,
  type CloudRuntimePolicy,
} from '../cloud-config.ts'
import {
  isCloudProjectSnapshotObjectKeyForTenant,
  type CloudProjectSourceService as CloudProjectSourceStore,
} from '../project-source-service.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudProjectSourceServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  projectSources: CloudProjectSourceStore | null
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
}

export class CloudProjectSourceService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly projectSources: CloudProjectSourceStore | null
  private readonly ensurePrincipal: CloudProjectSourceServiceOptions['ensurePrincipal']

  constructor(options: CloudProjectSourceServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.projectSources = options.projectSources
    this.ensurePrincipal = options.ensurePrincipal
  }

  validateProjectSource(source: CloudProjectSourceInput | null | undefined): CloudProjectSourcePolicyVerdict {
    return this.projectSources?.validateProjectSource(source) || evaluateCloudProjectSourcePolicy(source, this.policy)
  }

  async uploadProjectSnapshot(
    principal: CloudPrincipal,
    input: CloudProjectSnapshotUploadInput,
  ): Promise<CloudProjectSnapshotUploadResult> {
    await this.ensurePrincipal(principal)
    if (!this.projectSources) throw new CloudServiceError(503, 'Cloud project snapshot storage is not configured.')
    return this.projectSources.uploadSnapshot(principal, input)
  }

  async getSessionProjectSource(tenantId: string, sessionId: string): Promise<CloudProjectSource | null> {
    const projection = await this.store.getSessionProjection(tenantId, sessionId)
    return normalizeCloudProjectSource(projection?.view?.projectSource)
  }

  normalizeAndValidateProjectSource(
    source: CloudProjectSourceInput | null | undefined,
    tenantId: string,
  ) {
    if (source === undefined || source === null) return null
    const normalized = normalizeCloudProjectSource(source)
    const verdict = this.validateProjectSource(normalized)
    if (!normalized || !verdict.allowed) {
      throw new CloudServiceError(400, verdict.reason || 'Cloud project source is not allowed.', {
        policyCode: verdict.policyCode || 'project_source.denied',
      })
    }
    if (normalized.kind === 'snapshot' && !isCloudProjectSnapshotObjectKeyForTenant(tenantId, normalized.objectKey)) {
      throw new CloudServiceError(400, 'Project snapshot does not belong to this tenant.', {
        policyCode: 'project_source.snapshot.tenant',
      })
    }
    return normalized
  }
}
