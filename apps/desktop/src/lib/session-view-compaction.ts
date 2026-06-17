import type { CompactionNotice, TaskRun } from '@open-cowork/shared'

import { nextOrderFrom } from './session-view-order.ts'

export function cloneCompactionNotice(notice: CompactionNotice): CompactionNotice {
  return {
    id: notice.id,
    status: notice.status,
    auto: notice.auto,
    overflow: notice.overflow,
    sourceSessionId: notice.sourceSessionId || null,
    order: notice.order,
  }
}

export function hasPendingCompactions(taskRuns: TaskRun[], compactions: CompactionNotice[]) {
  return compactions.some((notice) => notice.status === 'compacting')
    || taskRuns.some((taskRun) => taskRun.compactions.some((notice) => notice.status === 'compacting'))
}

export function beginCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean; generateId?: () => string },
): CompactionNotice[] {
  const order = nextOrderFrom(notices)
  const id = input.id || input.generateId?.() || nextCompactionId(notices, input.sourceSessionId, order)
  const existing = notices.find((notice) => notice.id === id)
  if (existing) {
    return notices.map((notice) => notice.id === id
      ? {
          ...notice,
          status: 'compacting' as const,
          auto: input.auto ?? notice.auto,
          overflow: input.overflow ?? notice.overflow,
          sourceSessionId: input.sourceSessionId ?? notice.sourceSessionId ?? null,
        }
      : notice)
  }

  return [
    ...notices,
    {
      id,
      status: 'compacting' as const,
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order,
    },
  ]
}

export function finishCompactionNotice(
  notices: CompactionNotice[],
  input: { id?: string; sourceSessionId?: string | null; auto?: boolean; overflow?: boolean; generateId?: () => string },
): CompactionNotice[] {
  if (input.id) {
    const existing = notices.find((notice) => notice.id === input.id)
    if (existing) {
      return notices.map((notice) => notice.id === input.id
        ? {
            ...notice,
            status: 'compacted' as const,
            auto: input.auto ?? notice.auto,
            overflow: input.overflow ?? notice.overflow,
            sourceSessionId: input.sourceSessionId ?? notice.sourceSessionId ?? null,
          }
        : notice)
    }
  }

  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index]!
    if (notice.status !== 'compacting') continue
    if (input.sourceSessionId && notice.sourceSessionId && notice.sourceSessionId !== input.sourceSessionId) continue
    return notices.map((entry, entryIndex) => entryIndex === index
      ? {
          ...entry,
          status: 'compacted' as const,
          auto: input.auto ?? entry.auto,
          overflow: input.overflow ?? entry.overflow,
          sourceSessionId: input.sourceSessionId ?? entry.sourceSessionId ?? null,
        }
      : entry)
  }

  return [
    ...notices,
    {
      id: input.id || input.generateId?.() || nextCompactionId(notices, input.sourceSessionId, nextOrderFrom(notices)),
      status: 'compacted' as const,
      auto: input.auto ?? true,
      overflow: input.overflow ?? false,
      sourceSessionId: input.sourceSessionId ?? null,
      order: nextOrderFrom(notices),
    },
  ]
}

function nextCompactionId(notices: CompactionNotice[], sourceSessionId: string | null | undefined, order: number) {
  const prefix = sourceSessionId ? `${sourceSessionId}:compaction` : 'compaction'
  let next = order
  let id = `${prefix}:${next}`
  const existingIds = new Set(notices.map((notice) => notice.id))
  while (existingIds.has(id)) {
    next += 1
    id = `${prefix}:${next}`
  }
  return id
}
