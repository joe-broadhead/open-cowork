import {
  createLocalWebhookChannelPairing,
  listChannelDefinitions,
  listChannelDeliveryRecords,
  listChannelInboundItems,
  listChannelState,
  listLocalWebhookPairings,
  rotateLocalWebhookPairingToken,
} from '../channel-store.ts'
import { getLocalWebhookReceiverStatus } from '../channel-webhook-receiver.ts'
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

  context.ipcMain.handle('channels:local-webhook-status', async () => {
    return getLocalWebhookReceiverStatus()
  })

  context.ipcMain.handle('channels:local-webhook-pairings', async () => {
    return listLocalWebhookPairings()
  })

  context.ipcMain.handle('channels:create-local-webhook', async (_event, draft) => {
    return createLocalWebhookChannelPairing(draft)
  })

  context.ipcMain.handle('channels:rotate-local-webhook-token', async (_event, channelId) => {
    return rotateLocalWebhookPairingToken(channelId)
  })
}
