import type { ToolCall } from '@open-cowork/shared'
import {
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

function cloneRuntimeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function cloneToolInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return cloneRuntimeValue(value) as Record<string, unknown>
}

export function createRootToolCall(id: string, update: Partial<ToolCall>, options: { order: number }): ToolCall {
  return {
    id,
    name: (update.name as string) || 'tool',
    input: cloneToolInput(update.input),
    status: (update.status as ToolCall['status']) || 'running',
    output: cloneRuntimeValue(update.output),
    attachments: cloneRuntimeValue(update.attachments),
    agent: update.agent || null,
    sourceSessionId: update.sourceSessionId || null,
    order: options.order,
  }
}
