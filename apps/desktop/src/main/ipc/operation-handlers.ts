import type { IpcHandlerContext } from './context.ts'
import {
  buildOperationalQueueAlerts,
  listOperationalQueueItems,
  listWorkspaceProfiles,
} from '../operational-queue-store.ts'
import { listCapabilityRiskMetadata } from '../operation-capability-risk.ts'

export function registerOperationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('operations:workspace-profiles', async () => {
    return listWorkspaceProfiles()
  })

  context.ipcMain.handle('operations:queue-items', async () => {
    return listOperationalQueueItems()
  })

  context.ipcMain.handle('operations:queue-alerts', async () => {
    return buildOperationalQueueAlerts()
  })

  context.ipcMain.handle('operations:capability-risks', async () => {
    return listCapabilityRiskMetadata()
  })
}
