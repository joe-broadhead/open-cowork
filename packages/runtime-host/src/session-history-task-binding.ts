import type { NormalizedMessagePart } from './opencode-adapter.js'
import type { BindingHints } from './task-binding-policy.js'
import {
  chooseTaskTitle,
  extractAgentName,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.js'
import { toHistorySortTime } from './session-history-projection-utils.js'

export type TaskStatus = 'queued' | 'running' | 'complete' | 'error'

export type ChildSessionRecord = {
  id: string
  title?: string
  time?: {
    created?: number
    updated?: number
  }
  parentSessionId?: string | null
}

export function timingFromChild(child: ChildSessionRecord | null, status: TaskStatus) {
  if (!child) return { startedAt: null, finishedAt: null }
  const startedAt = child.time?.created ? toIsoTimestamp(toHistorySortTime(child.time.created)) : null
  const isTerminal = status === 'complete' || status === 'error'
  const finishedAt = isTerminal && child.time?.updated
    ? toIsoTimestamp(toHistorySortTime(child.time.updated))
    : null
  return { startedAt, finishedAt }
}

export function bindingHintsForSubtask(part: NormalizedMessagePart): BindingHints {
  // Agent identity is OpenCode-owned: derive it from structured/labeled fields only,
  // never from user prompt/raw content (which can carry a stray "@name"). Prompt/raw
  // still feed the human-readable title below.
  const agent = normalizeAgentName(part.agent)
    || extractAgentName(part.description, part.title)
    || null
  return {
    agent,
    title: chooseTaskTitle(
      agent,
      part.description,
      part.title,
      part.prompt,
      part.raw,
    ),
  }
}
