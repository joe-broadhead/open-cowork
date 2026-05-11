import type { IpcHandlerContext } from './context.ts'
import {
  buildOperationalQueueAlerts,
  listOperationalQueueItems,
  listWorkspaceProfiles,
  recoverInterruptedOperationalQueueItems,
} from '../operational-queue-store.ts'
import { listCapabilityRiskMetadata } from '../operation-capability-risk.ts'
import { getGovernanceRegistry } from '../governance-registry.ts'

export function registerOperationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('operations:workspace-profiles', async () => {
    return listWorkspaceProfiles()
  })

  context.ipcMain.handle('operations:queue-items', async () => {
    recoverInterruptedOperationalQueueItems()
    return listOperationalQueueItems()
  })

  context.ipcMain.handle('operations:queue-alerts', async () => {
    recoverInterruptedOperationalQueueItems()
    return buildOperationalQueueAlerts()
  })

  context.ipcMain.handle('operations:capability-risks', async () => {
    return listCapabilityRiskMetadata()
  })

  context.ipcMain.handle('operations:governance-registry', async () => {
    return getGovernanceRegistry()
  })
}
