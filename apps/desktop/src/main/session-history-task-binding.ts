import type { NormalizedMessagePart } from './opencode-adapter.ts'
import type { BindingHints } from './task-binding-score.ts'
import {
  chooseTaskTitle,
  extractAgentName,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils.ts'
import { toHistorySortTime } from './session-history-projection-utils.ts'

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
  const agent = normalizeAgentName(part.agent)
    || extractAgentName(part.description, part.title, part.prompt, part.raw)
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

export function childBindingCandidates(candidateChildren: ChildSessionRecord[]) {
  return candidateChildren.map((child) => ({
    title: child.title,
    agent: extractAgentName(child.title),
  }))
}
