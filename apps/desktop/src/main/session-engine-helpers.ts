import type { ToolCall } from '@open-cowork/shared'
import {
  nextSeq,
  type HistoryItem,
} from '../lib/session-view-model.ts'

export function getLatestHistoryEventAt(items: HistoryItem[]) {
  let latest = 0
  for (const item of items) {
    const timestamp = Date.parse(item.timestamp)
    if (Number.isFinite(timestamp) && timestamp > latest) {
      latest = timestamp
    }
  }
  return latest
}

export function createRootToolCall(id: string, update: Partial<ToolCall>): ToolCall {
  return {
    id,
    name: (update.name as string) || 'tool',
    input: (update.input as Record<string, unknown>) || {},
    status: (update.status as ToolCall['status']) || 'running',
    output: update.output,
    attachments: update.attachments,
    agent: update.agent || null,
    sourceSessionId: update.sourceSessionId || null,
    order: nextSeq(),
  }
}
