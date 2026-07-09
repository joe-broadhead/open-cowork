import { useSessionStore } from '../stores/session'
import { t } from './i18n'
import { normalizeWorkspaceId } from '../stores/session-workspace-keys'

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

export type SwitchToSessionResult = 'opened' | 'failed' | 'stale'

/**
 * Switch to a session and hydrate it from history on first load.
 */
export async function switchToSession(sessionId: string, options?: { force?: boolean; workspaceId?: string }): Promise<SwitchToSessionResult> {
  const store = useSessionStore.getState()
  const requestedWorkspaceId = normalizeWorkspaceId(options?.workspaceId || store.activeWorkspaceId)
  const myToken = ++activateToken

  try {
    const view = await window.coworkApi.session.activate(sessionId, {
      ...options,
      workspaceId: requestedWorkspaceId,
    })
    if (myToken !== activateToken) return 'stale'
    const latestStore = useSessionStore.getState()
    if (normalizeWorkspaceId(latestStore.activeWorkspaceId) !== requestedWorkspaceId) return 'stale'
    latestStore.setCurrentSession(sessionId)
    latestStore.setSessionView(sessionId, view, requestedWorkspaceId)
    return 'opened'
  } catch (err) {
    if (myToken !== activateToken) return 'stale'
    reportSessionLoadError(sessionId, err)
    return 'failed'
  }
}
