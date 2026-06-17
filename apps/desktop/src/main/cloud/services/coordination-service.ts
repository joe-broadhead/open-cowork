import type {
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchEvent,
  CoordinationWatchInput,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
} from '@open-cowork/shared'
import type { ControlPlaneStore } from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudCoordinationServiceOptions = {
  store: ControlPlaneStore
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
  deliverCloudCoordinationWatchEvent: (event: CoordinationWatchEvent) => Promise<void>
}

export class CloudCoordinationService {
  private readonly store: ControlPlaneStore
  private readonly ensurePrincipal: CloudCoordinationServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudCoordinationServiceOptions['principalOrgId']
  private readonly deliverCloudCoordinationWatchEvent: CloudCoordinationServiceOptions['deliverCloudCoordinationWatchEvent']

  constructor(options: CloudCoordinationServiceOptions) {
    this.store = options.store
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.deliverCloudCoordinationWatchEvent = options.deliverCloudCoordinationWatchEvent
  }

  async createCloudCoordinationWatch(
    principal: CloudPrincipal,
    input: CoordinationWatchInput & { workspaceId: string },
  ): Promise<CoordinationWatch> {
    await this.ensurePrincipal(principal)
    this.assertCloudCoordinationWorkspace(principal, input.workspaceId)
    return this.store.createCloudCoordinationWatch(input)
  }

  async updateCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
    patch: CoordinationWatchUpdateInput,
  ): Promise<CoordinationWatch | null> {
    await this.ensurePrincipal(principal)
    this.assertCloudCoordinationWorkspace(principal, workspaceId)
    return this.store.updateCloudCoordinationWatch({ workspaceId, watchId, patch })
  }

  async getCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
  ): Promise<CoordinationWatch | null> {
    await this.ensurePrincipal(principal)
    this.assertCloudCoordinationWorkspace(principal, workspaceId)
    return this.store.getCloudCoordinationWatch(workspaceId, watchId)
  }

  async listCloudCoordinationWatches(
    principal: CloudPrincipal,
    input: {
      workspaceId: string
      target?: CoordinationTarget | null
      status?: CoordinationWatchStatus | null
      limit?: number | null
    },
  ): Promise<CoordinationWatch[]> {
    await this.ensurePrincipal(principal)
    this.assertCloudCoordinationWorkspace(principal, input.workspaceId)
    return this.store.listCloudCoordinationWatches(input)
  }

  async deleteCloudCoordinationWatch(
    principal: CloudPrincipal,
    workspaceId: string,
    watchId: string,
  ): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertCloudCoordinationWorkspace(principal, workspaceId)
    return this.store.deleteCloudCoordinationWatch(workspaceId, watchId)
  }

  async emitCloudCoordinationWatchEvent(
    principal: CloudPrincipal,
    event: CoordinationWatchEvent,
  ): Promise<void> {
    await this.ensurePrincipal(principal)
    const workspaceId = event.workspaceId?.trim() || `cloud:${principal.tenantId.trim() || this.principalOrgId(principal) || principal.userId || 'default'}`
    this.assertCloudCoordinationWorkspace(principal, workspaceId)
    await this.deliverCloudCoordinationWatchEvent({
      ...event,
      workspaceId,
      occurredAt: event.occurredAt || new Date().toISOString(),
    })
  }

  private assertCloudCoordinationWorkspace(principal: CloudPrincipal, workspaceId: string) {
    const expected = `cloud:${principal.tenantId.trim() || this.principalOrgId(principal) || principal.userId || 'default'}`
    if (workspaceId !== expected) throw new CloudServiceError(404, 'Coordination workspace was not found.')
  }
}
