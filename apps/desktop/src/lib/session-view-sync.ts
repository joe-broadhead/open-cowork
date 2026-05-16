import type { SessionViewState } from './session-view-model.ts'

import { finiteOrder } from './session-view-order.ts'

function maxOrder(current: number, value: number | null | undefined) {
  const order = finiteOrder(value)
  return order === null ? current : Math.max(current, order)
}

export function maxSessionViewOrder(state: SessionViewState) {
  let max = 0
  for (const messageId of state.messageIds) {
    const message = state.messageById[messageId]
    if (!message) continue
    max = maxOrder(max, message.order)
    for (const segmentId of message.segmentIds) {
      max = maxOrder(max, state.messagePartsById[segmentId]?.order)
    }
    for (const segmentId of message.reasoningIds) {
      max = maxOrder(max, state.messageReasoningById[segmentId]?.order)
    }
  }

  for (const tool of state.toolCalls) {
    max = maxOrder(max, tool.order)
  }

  for (const taskRun of state.taskRuns) {
    max = maxOrder(max, taskRun.order)
    for (const segment of taskRun.transcript) max = maxOrder(max, segment.order)
    for (const segment of taskRun.reasoning || []) max = maxOrder(max, segment.order)
    for (const tool of taskRun.toolCalls) max = maxOrder(max, tool.order)
    for (const notice of taskRun.compactions) max = maxOrder(max, notice.order)
  }

  for (const notice of state.compactions) max = maxOrder(max, notice.order)
  for (const approval of state.pendingApprovals) max = maxOrder(max, approval.order)
  for (const error of state.errors) max = maxOrder(max, error.order)
  return max
}
