import {
  listChannelDefinitions,
  listChannelDeliveryRecords,
  listChannelInboundItems,
  listChannelState,
} from '../channel-store.ts'
import type { IpcHandlerContext } from './context.ts'

export function registerChannelHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('channels:list', async () => {
    return listChannelState()
  })

  context.ipcMain.handle('channels:definitions', async () => {
    return listChannelDefinitions()
  })

  context.ipcMain.handle('channels:inbound-items', async () => {
    return listChannelInboundItems()
  })

  context.ipcMain.handle('channels:deliveries', async () => {
    return listChannelDeliveryRecords()
  })
}
