import type {
  ControlPlaneStore,
  ThreadSmartFilterRecord,
  ThreadTagRecord,
} from './control-plane-store.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudPrincipal } from './session-service.ts'

export type CloudThreadOrganizationServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  ids: { randomUUID: () => string }
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
}

export class CloudThreadOrganizationService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly ids: { randomUUID: () => string }
  private readonly ensurePrincipal: CloudThreadOrganizationServiceOptions['ensurePrincipal']

  constructor(options: CloudThreadOrganizationServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.ids = options.ids
    this.ensurePrincipal = options.ensurePrincipal
  }

  async listThreadTags(principal: CloudPrincipal): Promise<ThreadTagRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadTags(principal.tenantId)
  }

  async createThreadTag(
    principal: CloudPrincipal,
    input: { name: string, color?: string | null },
  ): Promise<ThreadTagRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadTag({
      tenantId: principal.tenantId,
      tagId: this.ids.randomUUID(),
      name: input.name,
      color: input.color,
    })
  }

  async updateThreadTag(
    principal: CloudPrincipal,
    tagId: string,
    input: { name?: string, color?: string | null },
  ): Promise<ThreadTagRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadTag({
      tenantId: principal.tenantId,
      tagId,
      name: input.name,
      color: input.color,
    })
  }

  async deleteThreadTag(principal: CloudPrincipal, tagId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadTag(principal.tenantId, tagId)
  }

  async applyThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.applyThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async removeThreadTag(principal: CloudPrincipal, tagId: string, sessionIds: string[]): Promise<void> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    await this.requireOwnedSessions(principal, sessionIds)
    await this.store.removeThreadTags({
      tenantId: principal.tenantId,
      sessionIds,
      tagIds: [tagId],
    })
  }

  async listThreadMetadata(principal: CloudPrincipal, input: { tagIds?: string[], limit?: number } = {}) {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      tagIds: input.tagIds,
      limit: input.limit,
    })
  }

  async listThreadSmartFilters(principal: CloudPrincipal): Promise<ThreadSmartFilterRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.listThreadSmartFilters(principal.tenantId)
  }

  async createThreadSmartFilter(
    principal: CloudPrincipal,
    input: { name: string, query: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.createThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId: this.ids.randomUUID(),
      name: input.name,
      query: input.query,
    })
  }

  async updateThreadSmartFilter(
    principal: CloudPrincipal,
    filterId: string,
    input: { name?: string, query?: Record<string, unknown> },
  ): Promise<ThreadSmartFilterRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.updateThreadSmartFilter({
      tenantId: principal.tenantId,
      filterId,
      name: input.name,
      query: input.query,
    })
  }

  async deleteThreadSmartFilter(principal: CloudPrincipal, filterId: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertThreadIndexEnabled()
    return this.store.deleteThreadSmartFilter(principal.tenantId, filterId)
  }

  private assertThreadIndexEnabled() {
    if (!this.policy.features.threadIndex) {
      throw new Error('Thread index is disabled for this cloud profile.')
    }
  }

  private async requireOwnedSessions(principal: CloudPrincipal, sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      const session = await this.store.getSession(principal.tenantId, principal.userId, sessionId)
      if (!session) throw new Error(`Unknown session ${sessionId}.`)
    }
  }
}
