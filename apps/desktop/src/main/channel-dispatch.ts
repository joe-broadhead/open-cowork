import type {
  ChannelInboundItem,
  CrewRunDetail,
  CrewRunDraft,
  SopRunLink,
  SopTriggerType,
} from '@open-cowork/shared'
import {
  claimChannelInboundItemForDispatch,
  dismissChannelInboundItem,
  getChannelInboundItem,
  markChannelInboundItemDispatched,
  markChannelInboundItemFailed,
} from './channel-store.ts'
import { startCrewRunWithOpenCode } from './crew-service.ts'
import {
  createOpenCodeCrewRuntimeDriver,
  type CrewRuntimeExecutionDriver,
} from './crew-runtime-execution.ts'
import { log } from './logger.ts'
import { finishOperationalQueueItem } from './operational-queue-store.ts'
import { runSopForTrigger } from './sop-service.ts'

const CHANNEL_EXECUTION_BODY_MAX_BYTES = 32 * 1024

type ChannelDispatchDeps = {
  reviewer?: string
  publishAutomationUpdated?: () => void
  runSopForTrigger?: typeof runSopForTrigger
  startCrewRunWithOpenCode?: typeof startCrewRunWithOpenCode
  createCrewRuntimeDriver?: () => CrewRuntimeExecutionDriver
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown channel dispatch error')
}

function trimToUtf8Bytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false }
  let end = value.length
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) {
    end = Math.max(0, Math.floor(end * 0.9))
  }
  return { text: value.slice(0, end), truncated: true }
}

function channelTriggerType(item: ChannelInboundItem): SopTriggerType {
  return item.provider === 'local_webhook' ? 'webhook' : 'inbox'
}

function buildChannelInputs(item: ChannelInboundItem) {
  const body = trimToUtf8Bytes(item.body, CHANNEL_EXECUTION_BODY_MAX_BYTES)
  return {
    source: 'channel',
    channel: {
      id: item.channelId,
      provider: item.provider,
      sourceKey: item.source.sourceKey,
      workspaceProfileId: item.workspaceProfileId,
      allowedCapabilityIds: item.allowedCapabilityIds,
    },
    inbound: {
      id: item.id,
      sender: item.sender,
      subject: item.subject,
      externalMessageId: item.source.externalMessageId,
      receivedAt: item.receivedAt,
      body: body.text,
      bodyTruncated: body.truncated,
    },
  }
}

function buildCrewRunDraft(item: ChannelInboundItem): CrewRunDraft {
  const title = item.subject || `Channel item from ${item.sender}`
  const body = trimToUtf8Bytes(item.body, CHANNEL_EXECUTION_BODY_MAX_BYTES)
  return {
    crewId: item.route.targetCrewId || '',
    title,
    workItemTitle: title,
    workItemSource: 'channel',
    workItemDescription: [
      `Channel: ${item.provider}/${item.source.sourceKey}`,
      `Sender: ${item.sender}`,
      item.source.externalMessageId ? `External message: ${item.source.externalMessageId}` : null,
      item.allowedCapabilityIds.length > 0 ? `Allowed capabilities: ${item.allowedCapabilityIds.join(', ')}` : null,
      body.truncated ? `Body was truncated to ${CHANNEL_EXECUTION_BODY_MAX_BYTES} bytes for execution input.` : null,
      '',
      body.text,
    ].filter((line): line is string => line !== null).join('\n'),
  }
}

function isDispatchableChannelItem(item: ChannelInboundItem) {
  if (item.status === 'dispatched' || item.status === 'dispatching') return false
  if (item.route.activationMode !== 'run_sop' && item.route.activationMode !== 'run_crew') return false
  return item.status === 'queued' || item.status === 'needs_user'
}

function isDismissibleChannelItem(item: ChannelInboundItem) {
  return item.status === 'queued' || item.status === 'needs_user' || item.status === 'drafted'
}

function finishChannelQueueItem(item: ChannelInboundItem, status: 'completed' | 'failed', error?: string | null) {
  if (!item.queueItemId) return
  try {
    finishOperationalQueueItem(item.queueItemId, status, { error })
  } catch (finishError) {
    log('channel', `Failed to mark channel queue item ${item.queueItemId} ${status}: ${safeErrorMessage(finishError)}`)
  }
}

export async function approveChannelInboundItem(
  itemId: string,
  deps: ChannelDispatchDeps = {},
): Promise<ChannelInboundItem | null> {
  const item = getChannelInboundItem(itemId)
  if (!item) return null
  if (item.status === 'dispatched') return item
  if (item.status === 'dispatching') return item
  if (!isDispatchableChannelItem(item)) {
    throw new Error('Channel item is not waiting for SOP or Crew approval.')
  }

  const reviewer = deps.reviewer || 'local-user'
  const claimed = claimChannelInboundItemForDispatch(item.id, reviewer)
  if (!claimed || claimed.status !== 'dispatching') {
    return claimed
  }
  try {
    if (claimed.route.activationMode === 'run_sop') {
      const sopId = claimed.route.targetSopId
      if (!sopId) throw new Error('Channel route is missing a SOP target.')
      const runSop = deps.runSopForTrigger || runSopForTrigger
      const link: SopRunLink = await runSop(
        sopId,
        channelTriggerType(claimed),
        buildChannelInputs(claimed),
        deps.publishAutomationUpdated || (() => {}),
      )
      const updated = markChannelInboundItemDispatched(claimed.id, {
        runKind: 'sop',
        runId: link.automationRunId,
        approvedBy: reviewer,
      })
      finishChannelQueueItem(claimed, 'completed')
      return updated
    }

    const crewId = claimed.route.targetCrewId
    if (!crewId) throw new Error('Channel route is missing a Crew target.')
    const startCrew = deps.startCrewRunWithOpenCode || startCrewRunWithOpenCode
    const driver = (deps.createCrewRuntimeDriver || createOpenCodeCrewRuntimeDriver)()
    const detail: CrewRunDetail = await startCrew(buildCrewRunDraft(claimed), driver)
    const updated = markChannelInboundItemDispatched(claimed.id, {
      runKind: 'crew',
      runId: detail.run.id,
      workItemId: detail.run.workItemId,
      approvedBy: reviewer,
    })
    finishChannelQueueItem(claimed, 'completed')
    return updated
  } catch (error) {
    const message = safeErrorMessage(error)
    finishChannelQueueItem(claimed, 'failed', message)
    return markChannelInboundItemFailed(claimed.id, message)
  }
}

export function dismissChannelInboundReview(itemId: string, note?: string | null): ChannelInboundItem | null {
  const item = getChannelInboundItem(itemId)
  if (!item) return null
  if (item.status === 'dispatched') throw new Error('Dispatched channel work cannot be dismissed.')
  if (!isDismissibleChannelItem(item)) throw new Error('Channel item is not waiting for review.')
  if (item.queueItemId) {
    try {
      finishOperationalQueueItem(item.queueItemId, 'cancelled', { error: note || 'Channel item dismissed by user.' })
    } catch (error) {
      log('channel', `Failed to cancel channel queue item ${item.queueItemId}: ${safeErrorMessage(error)}`)
    }
  }
  return dismissChannelInboundItem(item.id, note)
}
