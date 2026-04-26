import { useSessionStore } from '../stores/session'

// When the user clicks through sessions quickly (A → B → A), each call
// kicks off an activate IPC + view hydrate. The store keys views by
// sessionId so they land in the right per-session slot, but we still
// avoid writing view state from a stale activate that lost its race:
// only the latest switch's response wins.
let activateToken = 0

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean }) {
  const store = useSessionStore.getState()
  store.setCurrentSession(sessionId)
  const myToken = ++activateToken

  try {
    const view = await window.coworkApi.session.activate(sessionId, options)
    if (myToken !== activateToken) return
    store.setSessionView(sessionId, view)
  } catch (err) {
    if (myToken !== activateToken) return
    console.error('[switchToSession] Failed to load messages:', err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
