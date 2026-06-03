export type {
  CloudRuntimeStatus,
  CloudTransportConfig,
  CloudWorkspaceOverview,
} from '../contracts.js'

import type {
  CloudRuntimeStatus,
  CloudTransportConfig,
  CloudWorkspaceOverview,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'

export type CloudConfigClient = {
  getConfig(): Promise<CloudTransportConfig>
  getWorkspace(): Promise<CloudWorkspaceOverview>
  getRuntimeStatus(): Promise<CloudRuntimeStatus>
}

export function createCloudConfigClient({ request }: CloudDomainClientContext): CloudConfigClient {
  return {
    getConfig() {
      return request<CloudTransportConfig>('/api/config')
    },
    getWorkspace() {
      return request<CloudWorkspaceOverview>('/api/workspace')
    },
    getRuntimeStatus() {
      return request<CloudRuntimeStatus>('/api/runtime/status')
    },
  }
}
