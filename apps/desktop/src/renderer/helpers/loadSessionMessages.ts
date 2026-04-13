import { useSessionStore } from '../stores/session'

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean }) {
  const store = useSessionStore.getState()
  store.setCurrentSession(sessionId)

  try {
    const view = await window.openCowork.session.activate(sessionId, options)
    store.setSessionView(sessionId, view)
  } catch (err) {
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
