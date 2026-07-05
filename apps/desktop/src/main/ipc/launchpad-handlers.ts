import { listLocalLaunchpadFeed } from '@open-cowork/runtime-host/launchpad/launchpad-service'
import type { LaunchpadFeedPayload, LaunchpadFeedRequest } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { objectArg, registerIpcInvoke } from './schema.ts'
import { validateLaunchpadFeedRequest } from './object-validators.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

export function registerLaunchpadHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'launchpad:feed', objectArg<LaunchpadFeedRequest>('launchpad feed request', validateLaunchpadFeedRequest), async (event, request): Promise<LaunchpadFeedPayload> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return listLocalLaunchpadFeed(request)
    }
    return context.workspaceGateway.launchpadFeed(event, request, workspaceId)
  })
}
