import type { ControlPlaneStore } from '../control-plane-store.ts'
import type { CloudRuntimePolicy } from '../cloud-config.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudSettingMetadataServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
}

export class CloudSettingMetadataService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly ensurePrincipal: CloudSettingMetadataServiceOptions['ensurePrincipal']

  constructor(options: CloudSettingMetadataServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.ensurePrincipal = options.ensurePrincipal
  }

  async listSettingMetadata(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.listSettingMetadata(principal.tenantId, principal.userId)
  }

  async getSettingMetadata(principal: CloudPrincipal, key: string) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.getSettingMetadata(principal.tenantId, key, principal.userId)
  }

  async setSettingMetadata(
    principal: CloudPrincipal,
    input: { key: string, value: Record<string, unknown> },
  ) {
    await this.ensurePrincipal(principal)
    this.assertSettingsEnabled()
    return this.store.setSettingMetadata({
      tenantId: principal.tenantId,
      userId: principal.userId,
      key: input.key,
      value: input.value,
    })
  }

  private assertSettingsEnabled() {
    if (!this.policy.features.settings) {
      throw new Error('Settings are disabled for this cloud profile.')
    }
  }
}
