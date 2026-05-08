import { useSessionStore } from '../stores/session'
import { t } from './i18n'

function describeSessionLoadError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportSessionLoadError(sessionId: string, error: unknown) {
  const message = t('session.loadFailed', 'Could not load this thread. Try reopening it.')
  useSessionStore.getState().addGlobalError(message)
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `Failed to load session ${sessionId}: ${describeSessionLoadError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'chat',
    })
  } catch {
    // Diagnostics reporting must never make navigation failure worse.
  }
}

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
    reportSessionLoadError(sessionId, err)
  }
}

// Backward compat alias
export const loadSessionMessages = switchToSession
