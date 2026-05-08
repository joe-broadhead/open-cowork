import type { SessionViewState } from './session-view-model.ts'

import { observeSeq } from './session-view-sequence.ts'

export function syncSessionSequence(state: SessionViewState) {
  for (const messageId of state.messageIds) {
    const message = state.messageById[messageId]
    if (!message) continue
    observeSeq(message.order)
    for (const segmentId of message.segmentIds) {
      observeSeq(state.messagePartsById[segmentId]?.order)
    }
  }

  for (const tool of state.toolCalls) {
    observeSeq(tool.order)
  }

  for (const taskRun of state.taskRuns) {
    observeSeq(taskRun.order)
    for (const segment of taskRun.transcript) observeSeq(segment.order)
    for (const tool of taskRun.toolCalls) observeSeq(tool.order)
    for (const notice of taskRun.compactions) observeSeq(notice.order)
  }

  for (const notice of state.compactions) observeSeq(notice.order)
  for (const approval of state.pendingApprovals) observeSeq(approval.order)
  for (const error of state.errors) observeSeq(error.order)
}
