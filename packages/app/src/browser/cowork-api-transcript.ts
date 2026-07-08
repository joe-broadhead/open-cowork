import type { SessionPatch } from '@open-cowork/shared'

export type CloudTranscriptProjector = {
  patchFor(record: Record<string, unknown>, sessionId: string, workspaceId: string | null): SessionPatch | null
  /** Drop the accumulator for a session whose stream is being closed/evicted (#905). */
  forget(sessionId: string): void
}

/**
 * Project cloud `assistant.message` SSE events into renderer `SessionPatch`es so the
 * streamed transcript flows through the SAME batched path the desktop uses (the 32ms
 * coalescer in useOpenCodeEvents + the incremental session-view-reducer) instead of an
 * O(M²) full-view rebuild per event (PERF-2). `record` is the full SSE data envelope
 * `{ sessionId, sequence, payload: { messageId, content, mode } }`.
 *
 * Byte-identical guarantee: the cloud projection models each message as ONE monolithic
 * content blob built by plain concatenation of the append deltas (see
 * reduceCloudSessionProjectionEvent → 'assistant.message'). We mirror that exactly: this
 * projector accumulates the deltas by plain concatenation and emits a REPLACE patch
 * carrying the FULL message text each time. The reducer's replace branch sets the segment
 * content directly — it does NOT run the desktop's `mergeStreamingText` overlap heuristic,
 * which is tuned for cumulative SDK text and would otherwise dedupe a coincidental
 * delta-boundary overlap. The streamed transcript is therefore identical to the canonical
 * `/view`, regardless of how the deltas were chunked or coalesced upstream (PERF-1). A
 * full snapshot (`mode` absent) carries the canonical text and is adopted verbatim.
 * eventAt is the projection `sequence`, matching the cloud session view's `lastEventAt`
 * scale so buffer pruning and the streaming-state merge stay consistent. Exported for
 * white-box reducer tests.
 */
export function createCloudTranscriptProjector(): CloudTranscriptProjector {
  // One accumulator per session — overwritten when a new message starts, so memory is
  // bounded by the number of tracked sessions rather than the message count.
  const bySession = new Map<string, { messageId: string; content: string }>()

  const patchFor = (
    record: Record<string, unknown>,
    sessionId: string,
    workspaceId: string | null,
  ): SessionPatch | null => {
    if (!sessionId) return null
    const projected = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {}
    const messageId = typeof projected.messageId === 'string' && projected.messageId ? projected.messageId : ''
    if (!messageId) return null
    const delta = typeof projected.content === 'string' ? projected.content : ''
    const isAppend = projected.mode === 'append'
    const sequence = typeof record.sequence === 'number' && Number.isFinite(record.sequence) ? record.sequence : 0

    const prior = bySession.get(sessionId)
    const content = isAppend
      ? (prior && prior.messageId === messageId ? prior.content + delta : delta)
      : delta
    // An append delta that hasn't produced any text yet carries no transcript change.
    if (isAppend && !content) return null
    bySession.set(sessionId, { messageId, content })

    return {
      type: 'message_text',
      sessionId,
      workspaceId,
      messageId,
      segmentId: messageId,
      content,
      mode: 'replace',
      role: 'assistant',
      eventAt: sequence,
    }
  }

  const forget = (sessionId: string) => {
    bySession.delete(sessionId)
  }

  return { patchFor, forget }
}
