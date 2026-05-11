import { randomUUID } from 'node:crypto'
import type { AppSettings, ChannelDeliveryRecord, ChannelInboundItem } from '@open-cowork/shared'
import { sendAutomationDesktopNotification, shouldSendAutomationDesktopNotification } from './automation-notifications.ts'
import {
  cancelChannelDeliveryRecord,
  claimChannelDeliveryForSend,
  createChannelDeliveryRecord,
  getChannelDeliveryRecord,
  markChannelDeliveryDelivered,
  markChannelDeliveryFailed,
} from './channel-store.ts'
import { evaluateHttpMcpUrlResolved, type McpDnsResolver } from './mcp-url-policy.ts'

const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000
const WEBHOOK_RESPONSE_ERROR_MAX_CHARS = 1_000

type WebhookDeliveryPayload = ReturnType<typeof buildWebhookDeliveryPayload>

type WebhookDeliveryResult = {
  ok: boolean
  status: number
  body?: string
}

type ChannelDeliveryDeps = {
  reviewer?: string
  resolveHostname?: McpDnsResolver
  sendWebhook?: (record: ChannelDeliveryRecord, payload: WebhookDeliveryPayload) => Promise<WebhookDeliveryResult>
}

function notificationTitle(item: ChannelInboundItem) {
  return item.subject || `Channel item from ${item.sender}`
}

function notificationBody(item: ChannelInboundItem) {
  switch (item.status) {
    case 'needs_user':
      return 'Channel input needs review before work continues.'
    case 'queued':
      return 'Channel input is queued for supervised work.'
    case 'drafted':
      return 'Channel input created a draft reply.'
    case 'dispatching':
      return 'Channel input is being dispatched.'
    case 'dispatched':
      return 'Channel input was approved and dispatched.'
    case 'failed':
      return item.error || 'Channel input failed.'
    case 'received':
      return 'Channel input was received.'
    case 'denied':
      return item.error || 'Channel input was denied.'
  }
}

function shouldNotifyForChannelItem(item: ChannelInboundItem) {
  return item.status === 'needs_user'
    || item.status === 'queued'
    || item.status === 'drafted'
    || item.status === 'failed'
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown channel delivery error')
}

function reviewableDelivery(record: ChannelDeliveryRecord) {
  return record.status === 'draft' || record.status === 'approval_required'
}

function deliveryApprovalId(reviewer: string) {
  return `channel-delivery:${reviewer}:${randomUUID()}`
}

function normalizedReviewer(value: string | undefined) {
  const reviewer = (value || 'local-user').trim()
  if (!reviewer) return 'local-user'
  if (Buffer.byteLength(reviewer, 'utf8') > 128) throw new Error('Channel delivery reviewer is too large.')
  return reviewer
}

function buildWebhookDeliveryPayload(record: ChannelDeliveryRecord, approvalId: string) {
  return {
    schemaVersion: 1,
    deliveryId: record.id,
    channelId: record.channelId,
    inboundItemId: record.inboundItemId,
    workItemId: record.workItemId,
    runKind: record.runKind,
    runId: record.runId,
    title: record.title,
    body: record.body,
    artifactIds: record.artifactIds,
    policyDecisionIds: record.policyDecisionIds,
    approvalIds: [...record.approvalIds, approvalId],
    draftFirst: record.draftFirst,
    createdAt: record.createdAt,
    approvedAt: new Date().toISOString(),
  }
}

async function defaultWebhookSender(record: ChannelDeliveryRecord, payload: WebhookDeliveryPayload): Promise<WebhookDeliveryResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS)
  try {
    const response = await fetch(record.target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'Open-Cowork-Channel-Delivery/1',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    })
    let body: string | undefined
    try {
      body = (await response.text()).slice(0, WEBHOOK_RESPONSE_ERROR_MAX_CHARS)
    } catch {
      body = undefined
    }
    return { ok: response.ok, status: response.status, body }
  } finally {
    clearTimeout(timeout)
  }
}

async function validateWebhookTarget(record: ChannelDeliveryRecord, deps: ChannelDeliveryDeps) {
  const verdict = await evaluateHttpMcpUrlResolved(record.target, {
    resolveHostname: deps.resolveHostname,
    allowPrivateNetwork: false,
  })
  if (!verdict.ok) throw new Error(verdict.reason.replaceAll('MCP', 'channel delivery'))
  if (verdict.url.protocol !== 'https:') {
    throw new Error('Webhook delivery callbacks must use https URLs.')
  }
}

export function deliverChannelDesktopNotification(input: {
  item: ChannelInboundItem
  settings: Pick<AppSettings, 'automationDesktopNotifications' | 'automationQuietHoursStart' | 'automationQuietHoursEnd'>
}) {
  if (!shouldNotifyForChannelItem(input.item)) return null
  if (!shouldSendAutomationDesktopNotification(input.settings)) return null
  const title = notificationTitle(input.item)
  const body = notificationBody(input.item)
  const delivered = sendAutomationDesktopNotification({ title, body })
  return createChannelDeliveryRecord({
    channelId: input.item.channelId,
    inboundItemId: input.item.id,
    provider: 'desktop_notification',
    target: 'system-notification',
    status: delivered ? 'delivered' : 'failed',
    title,
    body,
    draftFirst: false,
    error: delivered ? null : 'Desktop notifications are not supported.',
  })
}

export async function sendChannelDelivery(deliveryId: string, deps: ChannelDeliveryDeps = {}) {
  const record = getChannelDeliveryRecord(deliveryId)
  if (!record) return null
  if (record.status === 'delivered') return record
  if (record.status === 'sending') return record
  if (!reviewableDelivery(record)) throw new Error('Channel delivery is not waiting for review.')
  if (record.provider !== 'webhook') {
    throw new Error(`${record.provider} delivery remains draft-only until that provider is configured.`)
  }

  const claimed = claimChannelDeliveryForSend(record.id)
  if (!claimed || claimed.status !== 'sending') return claimed

  try {
    await validateWebhookTarget(claimed, deps)
    const reviewer = normalizedReviewer(deps.reviewer)
    const approvalId = deliveryApprovalId(reviewer)
    const payload = buildWebhookDeliveryPayload(claimed, approvalId)
    const result = await (deps.sendWebhook || defaultWebhookSender)(claimed, payload)
    if (!result.ok) {
      const detail = result.body ? `: ${result.body}` : ''
      throw new Error(`Webhook callback returned HTTP ${result.status}${detail}`)
    }
    return markChannelDeliveryDelivered(claimed.id, approvalId)
  } catch (error) {
    return markChannelDeliveryFailed(claimed.id, safeErrorMessage(error))
  }
}

export function cancelChannelDelivery(deliveryId: string, note?: string | null) {
  return cancelChannelDeliveryRecord(deliveryId, note)
}
