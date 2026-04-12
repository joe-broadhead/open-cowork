import { useSessionStore } from '../stores/session'
import { hasRenderableHistoryState, hasVisibleRootMessages, historyLooksRicher } from './session-history'

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean }) {
  const store = useSessionStore.getState()
  const revisionAtRequest = store.getSessionRevision(sessionId)

  store.setCurrentSession(sessionId)
  const existing = store.sessionStateById[sessionId]
  const hasRenderableContent = hasRenderableHistoryState(existing)
  const hasRootMessages = hasVisibleRootMessages(existing)
  // Avoid force-refreshing busy threads with stale persisted history.
  // Live event updates keep hot sessions current in memory.
  const shouldLoad = options?.force || !store.isSessionHydrated(sessionId) || !hasRenderableContent || !hasRootMessages
  if (!shouldLoad) return

  try {
    const items = await window.openCowork.session.messages(sessionId)
    if (Array.isArray(items)) {
      const latest = useSessionStore.getState()
      const current = latest.sessionStateById[sessionId]
      if (
        latest.busySessions.has(sessionId)
        && latest.getSessionRevision(sessionId) > revisionAtRequest
        && !historyLooksRicher(current, items as any[])
      ) {
        return
      }
      latest.hydrateSessionFromItems(sessionId, items as any[], true)
    }
  } catch (err) {
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
