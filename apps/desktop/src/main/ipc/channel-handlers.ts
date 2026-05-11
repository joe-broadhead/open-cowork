import type { ChannelInboundItem, ChannelLinkedRunStatus, ChannelListPayload } from '@open-cowork/shared'
import {
  createLocalWebhookChannelPairing,
  listChannelDefinitions,
  listChannelDeliveryRecords,
  listChannelInboundItems,
  listChannelState,
  listLocalWebhookPairings,
  rotateLocalWebhookPairingToken,
} from '../channel-store.ts'
import {
  approveChannelInboundItem,
  dismissChannelInboundReview,
} from '../channel-dispatch.ts'
import {
  cancelChannelDelivery,
  createChannelRunDeliveryDraft,
  sendChannelDelivery,
} from '../channel-delivery.ts'
import { getLocalWebhookReceiverStatus } from '../channel-webhook-receiver.ts'
import { getCrewRunDetail } from '../crew-service.ts'
import { getSopRunDetail } from '../sop-service.ts'
import type { IpcHandlerContext } from './context.ts'

function assertString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string.`)
  if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new Error(`${label} is too large.`)
  return value.trim()
}

function optionalString(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  return assertString(value, label)
}

function linkedRunStatus(item: ChannelInboundItem): ChannelLinkedRunStatus | null {
  if (!item.runKind || !item.runId) return null
  try {
    if (item.runKind === 'sop') return getSopRunDetail(item.runId)?.run.status || null
    return getCrewRunDetail(item.runId)?.run.status || null
  } catch {
    return null
  }
}

function withLinkedRunStatus(item: ChannelInboundItem): ChannelInboundItem {
  return {
    ...item,
    runStatus: linkedRunStatus(item),
  }
}

function listChannelStateForRenderer(): ChannelListPayload {
  const state = listChannelState()
  return {
    ...state,
    inboundItems: state.inboundItems.map(withLinkedRunStatus),
  }
}

export function registerChannelHandlers(context: IpcHandlerContext) {
  const publishAutomationUpdated = () => {
    const win = context.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('automation:updated')
  }

  context.ipcMain.handle('channels:list', async () => {
    return listChannelStateForRenderer()
  })

  context.ipcMain.handle('channels:definitions', async () => {
    return listChannelDefinitions()
  })

  context.ipcMain.handle('channels:inbound-items', async () => {
    return listChannelInboundItems().map(withLinkedRunStatus)
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

  context.ipcMain.handle('channels:approve-inbound-item', async (_event, itemId) => {
    return approveChannelInboundItem(assertString(itemId, 'Channel inbound item id'), {
      publishAutomationUpdated,
    })
  })

  context.ipcMain.handle('channels:dismiss-inbound-item', async (_event, itemId, note) => {
    return dismissChannelInboundReview(
      assertString(itemId, 'Channel inbound item id'),
      optionalString(note, 'Channel review note'),
    )
  })

  context.ipcMain.handle('channels:create-delivery-draft', async (_event, itemId) => {
    return createChannelRunDeliveryDraft(assertString(itemId, 'Channel inbound item id'))
  })

  context.ipcMain.handle('channels:send-delivery', async (_event, deliveryId) => {
    return sendChannelDelivery(assertString(deliveryId, 'Channel delivery record id'))
  })

  context.ipcMain.handle('channels:cancel-delivery', async (_event, deliveryId, note) => {
    return cancelChannelDelivery(
      assertString(deliveryId, 'Channel delivery record id'),
      optionalString(note, 'Channel delivery note'),
    )
  })
}
