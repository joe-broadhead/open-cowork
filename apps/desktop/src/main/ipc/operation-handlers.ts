import type { IpcHandlerContext } from './context.ts'
import {
  buildOperationalQueueAlerts,
  listWorkspaceProfiles,
} from '../operational-queue-store.ts'

export function registerOperationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('operations:workspace-profiles', async () => {
    return listWorkspaceProfiles()
  })

  context.ipcMain.handle('operations:queue-alerts', async () => {
    return buildOperationalQueueAlerts()
  })
}
