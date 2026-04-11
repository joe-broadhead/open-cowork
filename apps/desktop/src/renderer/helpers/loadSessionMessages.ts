import { useSessionStore } from '../stores/session'

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean }) {
  const store = useSessionStore.getState()

  store.setCurrentSession(sessionId)
  const shouldLoad = options?.force || !store.isSessionHydrated(sessionId)
  if (!shouldLoad) return

  try {
    const items = await window.cowork.session.messages(sessionId)
    useSessionStore.getState().hydrateSessionFromItems(sessionId, items as any[], options?.force)
  } catch (err) {
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
