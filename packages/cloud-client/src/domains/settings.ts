export type {
  CloudTransportSettingMetadata,
} from '../contracts.js'

import type { CloudTransportSettingMetadata } from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import {
  asRecord,
  encodePath,
  readNullableString,
  readString,
} from './shared.js'

export type CloudSettingsClient = {
  listSettings(): Promise<CloudTransportSettingMetadata[]>
  getSetting(key: string): Promise<CloudTransportSettingMetadata | null>
  setSetting(key: string, value: Record<string, unknown>): Promise<CloudTransportSettingMetadata>
}

function normalizeSettingMetadata(value: unknown): CloudTransportSettingMetadata | null {
  const record = asRecord(value)
  const key = readString(record.key)
  if (!key) return null
  return {
    tenantId: readNullableString(record.tenantId) || undefined,
    userId: readNullableString(record.userId),
    key,
    value: asRecord(record.value),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

export function createCloudSettingsClient({ request }: CloudDomainClientContext): CloudSettingsClient {
  return {
    async listSettings() {
      return (await request<{ settings: unknown[] }>('/api/settings')).settings
        .map(normalizeSettingMetadata)
        .filter((setting): setting is CloudTransportSettingMetadata => Boolean(setting))
    },
    async getSetting(key) {
      return normalizeSettingMetadata((await request<{ setting: unknown | null }>(`/api/settings/${encodePath(key)}`)).setting)
    },
    async setSetting(key, value) {
      const setting = normalizeSettingMetadata((await request<{ setting: unknown }>(`/api/settings/${encodePath(key)}`, {
        method: 'PUT',
        body: { value },
      })).setting)
      if (!setting) throw new Error('Cloud setting response was invalid.')
      return setting
    },
  }
}
