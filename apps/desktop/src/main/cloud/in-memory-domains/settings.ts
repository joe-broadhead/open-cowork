import {
  clone,
  key,
  nowIso,
} from './store-helpers.ts'
import type { SettingMetadataRecord } from '../control-plane-store.ts'

// Setting-metadata domain extracted from in-memory-control-plane-store.ts. Owns the
// tenant/user setting records keyed by (tenant, user, key), and the set/get/list
// lifecycle. Tenant + tenant-user existence checks arrive via the injected host.
// Behaviour-preserving move; covered by the cloud-http-server settings suite.

type InMemorySettingsHost = {
  requireTenant(tenantId: string): void
  requireTenantUser(tenantId: string, userId: string): void
}

export class InMemorySettingsDomain {
  private readonly settings = new Map<string, SettingMetadataRecord>()
  private readonly host: InMemorySettingsHost

  constructor(host: InMemorySettingsHost) {
    this.host = host
  }

  setSettingMetadata(input: {
    tenantId: string
    userId?: string | null
    key: string
    value: Record<string, unknown>
    updatedAt?: Date
  }): SettingMetadataRecord {
    this.host.requireTenant(input.tenantId)
    if (input.userId) this.host.requireTenantUser(input.tenantId, input.userId)
    const record: SettingMetadataRecord = {
      tenantId: input.tenantId,
      userId: input.userId || null,
      key: input.key,
      value: input.value,
      updatedAt: nowIso(input.updatedAt),
    }
    this.settings.set(key(input.tenantId, input.userId || '', input.key), record)
    return clone(record)
  }

  getSettingMetadata(tenantId: string, keyName: string, userId?: string | null): SettingMetadataRecord | null {
    this.host.requireTenant(tenantId)
    return clone(this.settings.get(key(tenantId, userId || '', keyName)) || null)
  }

  listSettingMetadata(tenantId: string, userId?: string | null): SettingMetadataRecord[] {
    this.host.requireTenant(tenantId)
    if (userId) this.host.requireTenantUser(tenantId, userId)
    return Array.from(this.settings.values())
      .filter((setting) => setting.tenantId === tenantId && setting.userId === (userId || null))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((setting) => clone(setting))
  }
}

