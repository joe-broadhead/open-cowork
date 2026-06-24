export const MAX_SEEN_COST_EVENT_IDS_PER_SESSION = 1_000

export class SessionCostEventTracker {
  private seenEventIdsBySession = new Map<string, Set<string>>()

  mark(sessionId: string, eventId?: string | null) {
    if (!eventId) return true
    const seen = this.seenEventIdsBySession.get(sessionId) || new Set<string>()
    if (seen.has(eventId)) return false
    seen.add(eventId)
    while (seen.size > MAX_SEEN_COST_EVENT_IDS_PER_SESSION) {
      const oldest = seen.values().next().value
      if (typeof oldest !== 'string') break
      seen.delete(oldest)
    }
    this.seenEventIdsBySession.set(sessionId, seen)
    return true
  }

  forgetSession(sessionId: string) {
    this.seenEventIdsBySession.delete(sessionId)
  }
}
