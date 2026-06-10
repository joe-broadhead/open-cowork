export type {
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
} from '../contracts.js'

import type {
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { queryString } from './shared.js'

export type CloudLaunchpadClient = {
  launchpadFeed(query?: LaunchpadFeedRequest): Promise<LaunchpadFeedPayload>
}

export function createCloudLaunchpadClient({ request }: CloudDomainClientContext): CloudLaunchpadClient {
  return {
    launchpadFeed(query = {}) {
      return request<LaunchpadFeedPayload>(`/api/launchpad/feed${queryString({
        projectId: query.projectId || undefined,
        limit: query.limit || undefined,
        inProgressLimit: query.inProgressLimit || undefined,
        waitingLimit: query.waitingLimit || undefined,
        artifactsLimit: query.artifactsLimit || undefined,
      })}`)
    },
  }
}
