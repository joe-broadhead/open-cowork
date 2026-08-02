export type ProgressWatchdogMode = 'off' | 'observe' | 'enforce'

export type ProgressWatchdogSource =
  | 'admission'
  | 'durable_sequence'
  | 'phase_transition'
  | 'tool_transition'
  | 'output_advance'
  | 'interaction_requested'
  | 'interaction_resolved'
  | 'scheduled_retry'
  | 'provider_backoff'
  | 'explicit_pause'
  | 'explicit_resume'
  | 'terminal'

export type ProgressWatchdogWaitingReason =
  | 'approval'
  | 'question'
  | 'explicit_pause'
  | 'scheduled_retry'
  | 'provider_backoff'

export type ProgressWatchdogDisposition = 'running' | 'waiting' | 'terminal'
export type ProgressWatchdogDecisionState = 'suspect' | 'stalled'
export type ProgressWatchdogStateName = 'healthy' | 'waiting' | ProgressWatchdogDecisionState

export type ProgressWatchdogIdentity = {
  /** Internal ownership scope. It is deliberately omitted from operator snapshots. */
  scopeId: string
  /** Internal product-session identity. It is deliberately omitted from operator snapshots. */
  sessionId: string
  /** Internal prompt/command identity. It is deliberately omitted from operator snapshots. */
  runId: string
  runtimeGeneration: number
  executionGeneration: number
  leaseOwner: string
  /** Opaque digest of the owning lease token, never the token itself. */
  leaseEpoch: string
}

export type ProgressWatchdogObservation = ProgressWatchdogIdentity & {
  source: ProgressWatchdogSource
  disposition: ProgressWatchdogDisposition
  waitingReason?: ProgressWatchdogWaitingReason | null
  /** Monotonic deadline for a scheduled retry/backoff. */
  resumeAtMs?: number | null
  /** Accepted OpenCode durable aggregate sequence. */
  sequence?: number | null
  /** Monotonic run-local output cursor/length when no durable sequence exists. */
  progressCursor?: number | null
  /** Bounded lifecycle fingerprint used only when no durable sequence exists. */
  semanticKey?: string | null
  /** Monotonic observation time. */
  observedAtMs: number
}

export type OpenCodeProgressEventInput = {
  type: string
  sequence?: number | null
  statusType?: string | null
  retryAtMs?: number | null
  /** Monotonic run-local cursor supplied by the owning composition layer. */
  progressCursor?: number | null
  /** Monotonic total output length; used when an explicit cursor is unavailable. */
  outputLength?: number | null
}

export type ClassifiedOpenCodeProgressEvent = Pick<
  ProgressWatchdogObservation,
  'source' | 'disposition' | 'waitingReason' | 'resumeAtMs' | 'sequence' | 'progressCursor' | 'semanticKey'
>

type VocabularyEntry = {
  source: ProgressWatchdogSource
  disposition: ProgressWatchdogDisposition
  waitingReason?: ProgressWatchdogWaitingReason
}

/**
 * Closed OpenCode/session-composition vocabulary. Read/list/poll/health events
 * are absent by design and therefore cannot reset the progress clock. Lease
 * renewal is also intentionally absent: renewed ownership without an
 * independent runtime sequence/cursor is a heartbeat, not proof of work.
 */
export const OPEN_CODE_PROGRESS_EVENT_VOCABULARY: Readonly<Record<string, VocabularyEntry>> = Object.freeze({
  'session.next.prompt.admitted': { source: 'admission', disposition: 'running' },
  'session.next.prompted': { source: 'admission', disposition: 'running' },
  'session.next.agent.switched': { source: 'phase_transition', disposition: 'running' },
  'session.next.moved': { source: 'phase_transition', disposition: 'running' },
  'session.next.synthetic': { source: 'phase_transition', disposition: 'running' },
  'session.next.shell.started': { source: 'tool_transition', disposition: 'running' },
  'session.next.shell.ended': { source: 'tool_transition', disposition: 'running' },
  'session.next.step.started': { source: 'phase_transition', disposition: 'running' },
  'session.next.step.ended': { source: 'phase_transition', disposition: 'running' },
  'session.next.text.started': { source: 'output_advance', disposition: 'running' },
  'session.next.text.delta': { source: 'output_advance', disposition: 'running' },
  'session.next.text.ended': { source: 'output_advance', disposition: 'running' },
  'session.next.reasoning.started': { source: 'output_advance', disposition: 'running' },
  'session.next.reasoning.delta': { source: 'output_advance', disposition: 'running' },
  'session.next.reasoning.ended': { source: 'output_advance', disposition: 'running' },
  'session.next.tool.input.started': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.input.delta': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.input.ended': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.called': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.progress': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.success': { source: 'tool_transition', disposition: 'running' },
  'session.next.tool.failed': { source: 'tool_transition', disposition: 'running' },
  'session.next.context.updated': { source: 'phase_transition', disposition: 'running' },
  'session.next.model.switched': { source: 'phase_transition', disposition: 'running' },
  'session.next.compaction.started': { source: 'phase_transition', disposition: 'running' },
  'session.next.compaction.delta': { source: 'phase_transition', disposition: 'running' },
  'session.next.compaction.ended': { source: 'phase_transition', disposition: 'running' },
  'session.next.revert.staged': { source: 'phase_transition', disposition: 'running' },
  'session.next.revert.cleared': { source: 'phase_transition', disposition: 'running' },
  'session.next.revert.committed': { source: 'phase_transition', disposition: 'running' },
  'session.compacted': { source: 'phase_transition', disposition: 'running' },
  'message.part.delta': { source: 'output_advance', disposition: 'running' },
  'message.part.updated': { source: 'output_advance', disposition: 'running' },
  'message.updated': { source: 'output_advance', disposition: 'running' },
  'todo.updated': { source: 'phase_transition', disposition: 'running' },
  'permission.asked': { source: 'interaction_requested', disposition: 'waiting', waitingReason: 'approval' },
  'permission.updated': { source: 'interaction_requested', disposition: 'waiting', waitingReason: 'approval' },
  'permission.v2.asked': { source: 'interaction_requested', disposition: 'waiting', waitingReason: 'approval' },
  'permission.replied': { source: 'interaction_resolved', disposition: 'running' },
  'permission.v2.replied': { source: 'interaction_resolved', disposition: 'running' },
  'question.asked': { source: 'interaction_requested', disposition: 'waiting', waitingReason: 'question' },
  'question.v2.asked': { source: 'interaction_requested', disposition: 'waiting', waitingReason: 'question' },
  'question.replied': { source: 'interaction_resolved', disposition: 'running' },
  'question.rejected': { source: 'interaction_resolved', disposition: 'running' },
  'question.v2.replied': { source: 'interaction_resolved', disposition: 'running' },
  'question.v2.rejected': { source: 'interaction_resolved', disposition: 'running' },
  'session.paused': { source: 'explicit_pause', disposition: 'waiting', waitingReason: 'explicit_pause' },
  'session.resumed': { source: 'explicit_resume', disposition: 'running' },
  'session.idle': { source: 'terminal', disposition: 'terminal' },
  'session.aborted': { source: 'terminal', disposition: 'terminal' },
  'runtime.error': { source: 'terminal', disposition: 'terminal' },
  'session.next.step.failed': { source: 'terminal', disposition: 'terminal' },
})

export function classifyOpenCodeProgressEvent(
  input: OpenCodeProgressEventInput,
): ClassifiedOpenCodeProgressEvent | null {
  const type = input.type.trim()
  const statusType = input.statusType?.trim().toLowerCase() || null
  let entry = OPEN_CODE_PROGRESS_EVENT_VOCABULARY[type]
  if (type === 'session.next.retried') {
    entry = { source: 'scheduled_retry', disposition: 'waiting', waitingReason: 'scheduled_retry' }
  } else if (type === 'session.status') {
    if (statusType === 'retry') {
      entry = { source: 'provider_backoff', disposition: 'waiting', waitingReason: 'provider_backoff' }
    } else if (statusType === 'idle') {
      entry = { source: 'terminal', disposition: 'terminal' }
    } else if (statusType === 'busy' || statusType === 'running') {
      entry = { source: 'phase_transition', disposition: 'running' }
    } else {
      return null
    }
  }
  if (!entry) return null
  const sequence = Number.isSafeInteger(input.sequence) && Number(input.sequence) >= 0
    ? Number(input.sequence)
    : undefined
  const resumeAtMs = entry.disposition === 'waiting'
    && (entry.waitingReason === 'scheduled_retry' || entry.waitingReason === 'provider_backoff')
    && typeof input.retryAtMs === 'number'
    && Number.isFinite(input.retryAtMs)
      ? Math.max(0, input.retryAtMs)
      : undefined
  const requiresDeadline = entry.waitingReason === 'scheduled_retry'
    || entry.waitingReason === 'provider_backoff'
  const disposition = entry.disposition === 'waiting' && requiresDeadline && resumeAtMs === undefined
    ? 'running'
    : entry.disposition
  const cursorInput = input.progressCursor ?? input.outputLength
  const progressCursor = typeof cursorInput === 'number'
    && Number.isSafeInteger(cursorInput)
    && cursorInput >= 0
      ? cursorInput
      : undefined
  const baseSemanticKey = `${type}${type === 'session.status' ? `:${statusType}` : ''}`
  return {
    source: entry.source,
    disposition,
    ...(entry.waitingReason && disposition === 'waiting' ? { waitingReason: entry.waitingReason } : {}),
    ...(resumeAtMs !== undefined ? { resumeAtMs } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(progressCursor !== undefined ? { progressCursor } : {}),
    semanticKey: `${baseSemanticKey}${progressCursor !== undefined ? `:${progressCursor}` : ''}`,
  }
}

type ProgressWatchdogEntry = ProgressWatchdogIdentity & {
  source: ProgressWatchdogSource
  disposition: Exclude<ProgressWatchdogDisposition, 'terminal'>
  waitingReason: ProgressWatchdogWaitingReason | null
  resumeAtMs: number | null
  lastSequence: number | null
  lastProgressCursor: number | null
  lastSemanticKey: string | null
  lastProgressAtMs: number
  revision: number
  acknowledgedDecisions: readonly ProgressWatchdogDecisionState[]
}

export type ProgressWatchdogState = {
  readonly entries: ReadonlyMap<string, ProgressWatchdogEntry>
}

export type ProgressWatchdogDecision = ProgressWatchdogIdentity & {
  state: ProgressWatchdogDecisionState
  source: ProgressWatchdogSource
  ageMs: number
  revision: number
}

export type ProgressWatchdogSnapshot = {
  counts: Record<ProgressWatchdogStateName, number>
  samples: Array<{
    state: ProgressWatchdogStateName
    ageMs: number
    source: ProgressWatchdogSource
    generation: number
  }>
  truncated: boolean
}

export type ProgressWatchdogEvaluation = {
  decisions: ProgressWatchdogDecision[]
  snapshot: ProgressWatchdogSnapshot
}

export type ProgressWatchdogThresholds = {
  suspectAfterMs: number
  stalledAfterMs: number
  maxEntries: number
  maxSnapshotEntries: number
}

export function createProgressWatchdogState(): ProgressWatchdogState {
  return { entries: new Map() }
}

function entryKey(identity: Pick<ProgressWatchdogIdentity, 'scopeId' | 'sessionId'>) {
  return `${identity.scopeId}\0${identity.sessionId}`
}

function sameGeneration(left: ProgressWatchdogIdentity, right: ProgressWatchdogIdentity) {
  return left.runtimeGeneration === right.runtimeGeneration
    && left.executionGeneration === right.executionGeneration
    && left.runId === right.runId
    && left.leaseOwner === right.leaseOwner
    && left.leaseEpoch === right.leaseEpoch
}

function compareGeneration(left: ProgressWatchdogIdentity, right: ProgressWatchdogIdentity) {
  if (left.runtimeGeneration !== right.runtimeGeneration) {
    return left.runtimeGeneration - right.runtimeGeneration
  }
  return left.executionGeneration - right.executionGeneration
}

function semanticKey(observation: ProgressWatchdogObservation) {
  return observation.semanticKey?.trim()
    || [
      observation.source,
      observation.disposition,
      observation.waitingReason || '',
      observation.resumeAtMs ?? '',
    ].join(':')
}

export function recordProgressWatchdogObservation(
  state: ProgressWatchdogState,
  observation: ProgressWatchdogObservation,
  maxEntries: number,
): ProgressWatchdogState {
  if (!Number.isFinite(observation.observedAtMs)) return state
  const key = entryKey(observation)
  const current = state.entries.get(key)
  if (current) {
    const generationOrder = compareGeneration(observation, current)
    if (generationOrder < 0) return state
    if (generationOrder === 0 && !sameGeneration(observation, current)) return state
    if (
      observation.disposition === 'terminal'
      && generationOrder === 0
      && observation.sequence !== undefined
      && observation.sequence !== null
      && current.lastSequence !== null
      && observation.sequence <= current.lastSequence
    ) return state
    if (observation.disposition === 'terminal') {
      const entries = new Map(state.entries)
      entries.delete(key)
      return { entries }
    }
    if (generationOrder === 0 && observation.observedAtMs < current.lastProgressAtMs) return state
    if (generationOrder === 0) {
      if (
        observation.sequence !== undefined
        && observation.sequence !== null
        && current.lastSequence !== null
        && observation.sequence <= current.lastSequence
      ) return state
      if (
        (observation.sequence === undefined || observation.sequence === null)
        && observation.progressCursor !== undefined
        && observation.progressCursor !== null
        && current.lastProgressCursor !== null
        && observation.progressCursor <= current.lastProgressCursor
      ) return state
      if (
        (observation.sequence === undefined || observation.sequence === null)
        && (observation.progressCursor === undefined || observation.progressCursor === null)
        && semanticKey(observation) === current.lastSemanticKey
      ) return state
    }
  }

  if (observation.disposition === 'terminal') return state
  const entries = new Map(state.entries)

  const next: ProgressWatchdogEntry = {
    scopeId: observation.scopeId,
    sessionId: observation.sessionId,
    runId: observation.runId,
    runtimeGeneration: observation.runtimeGeneration,
    executionGeneration: observation.executionGeneration,
    leaseOwner: observation.leaseOwner,
    leaseEpoch: observation.leaseEpoch,
    source: observation.source,
    disposition: observation.disposition,
    waitingReason: observation.waitingReason || null,
    resumeAtMs: observation.resumeAtMs ?? null,
    lastSequence: observation.sequence ?? (current && sameGeneration(observation, current) ? current.lastSequence : null),
    lastProgressCursor: observation.progressCursor
      ?? (current && sameGeneration(observation, current) ? current.lastProgressCursor : null),
    lastSemanticKey: semanticKey(observation),
    lastProgressAtMs: observation.observedAtMs,
    revision: current && sameGeneration(observation, current) ? current.revision + 1 : 1,
    acknowledgedDecisions: [],
  }
  entries.set(key, next)

  const limit = Math.max(1, Math.floor(maxEntries))
  while (entries.size > limit) {
    const oldest = [...entries.entries()]
      .sort(([, left], [, right]) => left.lastProgressAtMs - right.lastProgressAtMs)[0]
    if (!oldest) break
    entries.delete(oldest[0])
  }
  return { entries }
}

function entryState(entry: ProgressWatchdogEntry, nowMs: number, thresholds: ProgressWatchdogThresholds) {
  const indefiniteWait = entry.waitingReason === 'approval'
    || entry.waitingReason === 'question'
    || entry.waitingReason === 'explicit_pause'
  if (
    entry.disposition === 'waiting'
    && (indefiniteWait || (entry.resumeAtMs !== null && nowMs < entry.resumeAtMs))
  ) {
    return { state: 'waiting' as const, ageMs: Math.max(0, nowMs - entry.lastProgressAtMs) }
  }
  const baseline = entry.disposition === 'waiting' && entry.resumeAtMs !== null
    ? entry.resumeAtMs
    : entry.lastProgressAtMs
  const ageMs = Math.max(0, nowMs - baseline)
  if (ageMs >= thresholds.stalledAfterMs) return { state: 'stalled' as const, ageMs }
  if (ageMs >= thresholds.suspectAfterMs) return { state: 'suspect' as const, ageMs }
  return { state: 'healthy' as const, ageMs }
}

export function evaluateProgressWatchdog(
  state: ProgressWatchdogState,
  nowMs: number,
  thresholds: ProgressWatchdogThresholds,
): ProgressWatchdogEvaluation {
  const counts: ProgressWatchdogSnapshot['counts'] = {
    healthy: 0,
    waiting: 0,
    suspect: 0,
    stalled: 0,
  }
  const decisions: ProgressWatchdogDecision[] = []
  const samples: ProgressWatchdogSnapshot['samples'] = []
  for (const entry of state.entries.values()) {
    const evaluated = entryState(entry, nowMs, thresholds)
    counts[evaluated.state] += 1
    samples.push({
      state: evaluated.state,
      ageMs: evaluated.ageMs,
      source: entry.source,
      generation: entry.runtimeGeneration,
    })
    if (
      (evaluated.state === 'suspect' || evaluated.state === 'stalled')
      && !entry.acknowledgedDecisions.includes(evaluated.state)
    ) {
      decisions.push({
        scopeId: entry.scopeId,
        sessionId: entry.sessionId,
        runId: entry.runId,
        runtimeGeneration: entry.runtimeGeneration,
        executionGeneration: entry.executionGeneration,
        leaseOwner: entry.leaseOwner,
        leaseEpoch: entry.leaseEpoch,
        source: entry.source,
        state: evaluated.state,
        ageMs: evaluated.ageMs,
        revision: entry.revision,
      })
    }
  }
  const severity: Record<ProgressWatchdogStateName, number> = {
    stalled: 0,
    suspect: 1,
    waiting: 2,
    healthy: 3,
  }
  samples.sort((left, right) => severity[left.state] - severity[right.state] || right.ageMs - left.ageMs)
  const sampleLimit = Math.max(0, Math.floor(thresholds.maxSnapshotEntries))
  return {
    decisions,
    snapshot: {
      counts,
      samples: samples.slice(0, sampleLimit),
      truncated: samples.length > sampleLimit,
    },
  }
}

export function isProgressWatchdogDecisionCurrent(
  state: ProgressWatchdogState,
  decision: ProgressWatchdogDecision,
) {
  const current = state.entries.get(entryKey(decision))
  return Boolean(current && sameGeneration(current, decision) && current.revision === decision.revision)
}

export function acknowledgeProgressWatchdogDecision(
  state: ProgressWatchdogState,
  decision: ProgressWatchdogDecision,
): ProgressWatchdogState {
  const key = entryKey(decision)
  const current = state.entries.get(key)
  if (!current || !sameGeneration(current, decision) || current.revision !== decision.revision) return state
  if (current.acknowledgedDecisions.includes(decision.state)) return state
  const entries = new Map(state.entries)
  entries.set(key, {
    ...current,
    acknowledgedDecisions: [...current.acknowledgedDecisions, decision.state],
  })
  return { entries }
}
