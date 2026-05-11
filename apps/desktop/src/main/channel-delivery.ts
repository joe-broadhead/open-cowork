import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  ChannelDeliveryProvider,
  ChannelDeliveryRecord,
  ChannelInboundItem,
  CrewRunDetail,
  SopRunDetail,
} from '@open-cowork/shared'
import { sendAutomationDesktopNotification, shouldSendAutomationDesktopNotification } from './automation-notifications.ts'
import {
  cancelChannelDeliveryRecord,
  claimChannelDeliveryForSend,
  createChannelDeliveryRecord,
  findChannelDeliveryRecordForInboundRun,
  getChannelDeliveryRecord,
  getChannelInboundItem,
  markChannelInboundDeliveryRecord,
  markChannelDeliveryDelivered,
  markChannelDeliveryFailed,
} from './channel-store.ts'
import { getCrewRunDetail } from './crew-service.ts'
import { evaluateHttpMcpUrlResolved, type McpDnsResolver } from './mcp-url-policy.ts'
import { getSopRunDetail } from './sop-service.ts'

const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000
const WEBHOOK_RESPONSE_ERROR_MAX_CHARS = 1_000
const RUN_DELIVERY_BODY_MAX_BYTES = 64 * 1024

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

type ChannelSopRunDeliveryDetail = Pick<SopRunDetail, 'run' | 'outputs' | 'artifacts' | 'approvals'>
type ChannelCrewRunDeliveryDetail = Pick<CrewRunDetail, 'run' | 'workItem' | 'artifacts' | 'approvals' | 'policyDecisions' | 'evaluations'>

type ChannelRunDeliveryDeps = {
  getSopRunDetail?: (runId: string) => ChannelSopRunDeliveryDetail | null
  getCrewRunDetail?: (runId: string) => ChannelCrewRunDeliveryDetail | null
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

function trimToUtf8Bytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const suffix = '\n\n[Draft truncated before delivery review.]'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  if (suffixBytes >= maxBytes) return value.slice(0, 0)
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') + suffixBytes <= maxBytes) low = mid
    else high = mid - 1
  }
  let prefix = value.slice(0, low)
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1)
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) {
    prefix = prefix.slice(0, -1)
  }
  return `${prefix}${suffix}`
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

function deliveryProviderForItem(item: ChannelInboundItem): ChannelDeliveryProvider {
  return item.provider === 'local_webhook' ? 'webhook' : item.provider
}

function deliveryTargetForItem(item: ChannelInboundItem) {
  return item.source.replyTarget || item.sender
}

function deliveryTitleForItem(item: ChannelInboundItem) {
  return item.subject ? `Delivery draft: ${item.subject}` : `Delivery draft for ${item.sender}`
}

function formatLinkedArtifacts(artifacts: Array<{ id: string; title: string; mime: string; uri: string }>) {
  if (artifacts.length === 0) return 'Artifacts: none recorded.'
  return [
    'Artifacts:',
    ...artifacts.map((artifact) => `- ${artifact.title} (${artifact.mime}) ${artifact.uri}`),
  ].join('\n')
}

function formatLinkedApprovals(approvals: Array<{ id: string; title: string; status: string }>) {
  if (approvals.length === 0) return 'Approvals: none recorded.'
  return [
    'Approvals:',
    ...approvals.map((approval) => `- ${approval.title}: ${approval.status}`),
  ].join('\n')
}

function formatLinkedPolicyDecisions(decisions: Array<{ id: string; status: string; reason: string; capabilityId: string | null }>) {
  if (decisions.length === 0) return 'Policy decisions: none recorded.'
  return [
    'Policy decisions:',
    ...decisions.map((decision) => `- ${decision.status}: ${decision.reason}${decision.capabilityId ? ` (${decision.capabilityId})` : ''}`),
  ].join('\n')
}

function sopDeliveryBody(item: ChannelInboundItem, detail: ChannelSopRunDeliveryDetail) {
  const sections = [
    `Channel: ${item.provider}/${item.source.sourceKey}`,
    `Sender: ${item.sender}`,
    item.source.externalMessageId ? `External message: ${item.source.externalMessageId}` : null,
    '',
    detail.outputs.summary || detail.run.summary || 'Run completed without a recorded summary.',
    '',
    formatLinkedArtifacts(detail.artifacts),
    '',
    formatLinkedApprovals(detail.approvals.map((approval) => ({
      id: approval.id,
      title: approval.title,
      status: approval.status,
    }))),
  ].filter((section): section is string => section !== null)
  return trimToUtf8Bytes(sections.join('\n'), RUN_DELIVERY_BODY_MAX_BYTES)
}

function crewDeliveryBody(item: ChannelInboundItem, detail: ChannelCrewRunDeliveryDetail) {
  const evaluationLines = detail.evaluations.length === 0
    ? 'Evaluations: none recorded.'
    : [
      'Evaluations:',
      ...detail.evaluations.map((evaluation) => `- ${evaluation.status}: score ${evaluation.score}; recommendation ${evaluation.recommendation}`),
    ].join('\n')
  const sections = [
    `Channel: ${item.provider}/${item.source.sourceKey}`,
    `Sender: ${item.sender}`,
    item.source.externalMessageId ? `External message: ${item.source.externalMessageId}` : null,
    '',
    detail.run.summary || 'Crew run completed without a recorded summary.',
    '',
    formatLinkedArtifacts(detail.artifacts),
    '',
    formatLinkedApprovals(detail.approvals),
    '',
    formatLinkedPolicyDecisions(detail.policyDecisions),
    '',
    evaluationLines,
  ].filter((section): section is string => section !== null)
  return trimToUtf8Bytes(sections.join('\n'), RUN_DELIVERY_BODY_MAX_BYTES)
}

function assertDispatchedRunItem(item: ChannelInboundItem) {
  if (item.status !== 'dispatched' || !item.runKind || !item.runId) {
    throw new Error('Channel item has no dispatched SOP or Crew run.')
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

export function createChannelRunDeliveryDraft(itemId: string, deps: ChannelRunDeliveryDeps = {}) {
  const item = getChannelInboundItem(itemId)
  if (!item) return null
  assertDispatchedRunItem(item)
  const runKind = item.runKind
  const runId = item.runId
  if (!runKind || !runId) throw new Error('Channel item has no dispatched SOP or Crew run.')
  const existing = findChannelDeliveryRecordForInboundRun({
    inboundItemId: item.id,
    runKind,
    runId,
  })
  if (existing) return existing

  if (runKind === 'sop') {
    const detail = (deps.getSopRunDetail || getSopRunDetail)(runId)
    if (!detail) throw new Error(`SOP run ${runId} was not found.`)
    if (detail.run.status !== 'completed') throw new Error('SOP run is not completed yet.')
    const delivery = createChannelDeliveryRecord({
      channelId: item.channelId,
      inboundItemId: item.id,
      provider: deliveryProviderForItem(item),
      target: deliveryTargetForItem(item),
      status: 'draft',
      title: deliveryTitleForItem(item),
      body: sopDeliveryBody(item, detail),
      draftFirst: true,
      workItemId: item.workItemId,
      runKind: 'sop',
      runId: detail.run.id,
      artifactIds: detail.artifacts.map((artifact) => artifact.id),
      approvalIds: detail.approvals.map((approval) => approval.id),
    })
    markChannelInboundDeliveryRecord(item.id, delivery.id)
    return delivery
  }

  const detail = (deps.getCrewRunDetail || getCrewRunDetail)(runId)
  if (!detail) throw new Error(`Crew run ${runId} was not found.`)
  if (detail.run.status !== 'completed') throw new Error('Crew run is not completed yet.')
  const delivery = createChannelDeliveryRecord({
    channelId: item.channelId,
    inboundItemId: item.id,
    provider: deliveryProviderForItem(item),
    target: deliveryTargetForItem(item),
    status: 'draft',
    title: deliveryTitleForItem(item),
    body: crewDeliveryBody(item, detail),
    draftFirst: true,
    workItemId: detail.workItem?.id || item.workItemId,
    runKind: 'crew',
    runId: detail.run.id,
    artifactIds: detail.artifacts.map((artifact) => artifact.id),
    policyDecisionIds: detail.policyDecisions.map((decision) => decision.id),
    approvalIds: detail.approvals.map((approval) => approval.id),
  })
  markChannelInboundDeliveryRecord(item.id, delivery.id)
  return delivery
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
