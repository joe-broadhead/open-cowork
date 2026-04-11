import { useSessionStore } from '../stores/session'

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean }) {
  const store = useSessionStore.getState()

  store.setCurrentSession(sessionId)
  const existing = store.sessionStateById[sessionId]
  const hasRenderableContent = !!existing && (
    existing.messages.length > 0
    || existing.toolCalls.length > 0
    || existing.taskRuns.length > 0
    || existing.pendingApprovals.length > 0
    || existing.errors.length > 0
  )
  const shouldLoad = options?.force || !store.isSessionHydrated(sessionId) || !hasRenderableContent
  if (!shouldLoad) return

  try {
    const items = await window.cowork.session.messages(sessionId)
    if (Array.isArray(items) && items.length > 0) {
      useSessionStore.getState().hydrateSessionFromItems(sessionId, items as any[], true)
    }
  } catch (err) {
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
