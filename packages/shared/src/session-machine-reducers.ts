/**
 * JOE-846: Shared pure reducers / helpers for the three session state machines.
 *
 * Live (SessionEngine), History (session-history-projector), and Cloud
 * (reduceCloudSessionProjectionEvent) remain separate machines — reopen parity
 * requires different inputs — but critical transcript decisions must not drift.
 */

/** Ownership matrix — which machine owns which surface. */
export const SESSION_STATE_MACHINE_OWNERSHIP = Object.freeze({
  live: Object.freeze({
    id: 'live' as const,
    name: 'SessionEngine',
    path: 'packages/runtime-host/src/session-engine.ts',
    inputs: 'RuntimeSessionEvent (normalized SDK / durable stream fan-out)',
    outputs: 'SessionView via session-view-model',
    owns: Object.freeze([
      'live streaming deltas and message segments',
      'busy / awaiting permission flags during active runs',
      'live tool.call and task.run upserts',
      'permission/question pending sets during interactive runs',
      'cost events seen in-flight',
    ]),
    doesNotOwn: Object.freeze([
      'durable cloud event log',
      'channel/gateway rendering contract',
      'offline history rebuild from OpenCode message store',
    ]),
  }),
  history: Object.freeze({
    id: 'history' as const,
    name: 'session-history-projector',
    path: 'packages/runtime-host/src/session-history-projector.ts',
    inputs: 'OpenCode session messages + parts (history API)',
    outputs: 'ProjectedHistoryItem[] → SessionEngine.setSessionFromHistory',
    owns: Object.freeze([
      'reopen/hydration of transcript from OpenCode-persisted history',
      'task binding from child sessions at reload',
      'tool status derivation for completed/interrupted history tools',
      'history cost/token projection from step-finish parts',
    ]),
    doesNotOwn: Object.freeze([
      'live SSE streaming',
      'cloud durable event sequences',
      'overwriting live state newer than history (SessionEngine race fence)',
    ]),
  }),
  cloud: Object.freeze({
    id: 'cloud' as const,
    name: 'cloud-session-projection',
    path: 'packages/shared/src/cloud-session-projection.ts',
    inputs: 'CloudSessionEventRecord product events',
    outputs: 'CloudSessionProjectionView → SessionView',
    owns: Object.freeze([
      'durable multi-device projection from product event log',
      'cloud web / gateway / paired desktop SessionView hydration',
      'append vs replace assistant.message modes for SSE',
      'permission/question resolution history on cloud sessions',
    ]),
    doesNotOwn: Object.freeze([
      'OpenCode SDK client objects',
      'desktop-only live message segment IDs',
      'local OpenCode history API reads',
    ]),
  }),
})

export type SessionStateMachineId = keyof typeof SESSION_STATE_MACHINE_OWNERSHIP

/**
 * Interaction flags shared by live SessionView and cloud→SessionView mapping.
 * Pending approvals/questions suppress isGenerating so the UI shows the prompt.
 */
export function deriveSessionInteractionFlags(input: {
  isBusyOrGenerating: boolean
  pendingApprovalCount: number
  pendingQuestionCount: number
}): {
  isGenerating: boolean
  isAwaitingPermission: boolean
  isAwaitingQuestion: boolean
} {
  const isAwaitingPermission = input.pendingApprovalCount > 0
  const isAwaitingQuestion = input.pendingQuestionCount > 0
  return {
    isGenerating: input.isBusyOrGenerating && !isAwaitingPermission && !isAwaitingQuestion,
    isAwaitingPermission,
    isAwaitingQuestion,
  }
}

/**
 * Assistant text projection: `append` concatenates streaming deltas; default
 * replaces with the full snapshot. Whitespace-only deltas are preserved.
 */
export function resolveAssistantMessageContent(input: {
  mode?: 'append' | 'replace' | string | null
  existingContent?: string | null
  content: unknown
}): string {
  const isAppend = input.mode === 'append'
  const deltaText = typeof input.content === 'string' ? input.content : ''
  if (isAppend) {
    return `${input.existingContent || ''}${deltaText}`
  }
  return typeof input.content === 'string' ? input.content : ''
}

/**
 * Pure id upsert used by live + cloud machines for tool/task/approval lists.
 * Merge defaults to replace; callers may preserve fields via `merge`.
 */
export function upsertProjectionById<T extends { id: string }>(
  entries: readonly T[],
  incoming: T,
  merge: (existing: T, next: T) => T = (_existing, next) => next,
): T[] {
  const index = entries.findIndex((entry) => entry.id === incoming.id)
  if (index < 0) return [...entries, incoming]
  return entries.map((entry, i) => (i === index ? merge(entry, incoming) : entry))
}

/** Plan toward fewer sources of truth without breaking reopen. */
export const SESSION_STATE_MACHINE_CONVERGENCE_PLAN = Object.freeze([
  'Keep three machines: live inputs ≠ history API ≠ durable product log.',
  'Share pure helpers here (flags, assistant content, tool status, upsert).',
  'All surfaces project through product event kinds from the shared translator (JOE-838).',
  'Parity tests cover critical transcript shapes (assistant, tool, permission, question).',
  'Do not collapse machines until reopen + multi-device sync stay proven.',
] as const)
