import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SessionInfo } from '@open-cowork/shared'

import type { AppView } from '../app-types'
import { t } from '../helpers/i18n'
import { loadSessionMessages } from '../helpers/loadSessionMessages'
import { useSessionStore } from '../stores/session'

type UseAppGlobalEventsOptions = {
  runtimeReady: boolean
  view: AppView
  currentSessionId: string | null
  toggleSidebar: () => void
  createAndActivateSession: (directory?: string) => Promise<SessionInfo | null>
  openSidebarSearch: () => void
  openSidebarSettings: () => void
  setView: (view: AppView) => void
  setAuthenticated: (authenticated: boolean) => void
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>
}

function describeGlobalActionError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportGlobalActionError(userMessage: string, diagnosticMessage: string, error: unknown) {
  useSessionStore.getState().addGlobalError(userMessage)
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${diagnosticMessage}: ${describeGlobalActionError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'global-actions',
    })
  } catch {
    // Diagnostics are best-effort from action error handlers.
  }
}

async function revertCurrentSession(sessionId: string) {
  const userMessage = t('globalActions.revertFailed', 'Could not revert this session. Please try again.')
  try {
    const ok = await window.coworkApi.session.revert(sessionId)
    if (!ok) {
      reportGlobalActionError(userMessage, `Failed to revert session ${sessionId}`, new Error('session.revert returned false'))
      return
    }
    await loadSessionMessages(sessionId, { force: true })
  } catch (err) {
    reportGlobalActionError(userMessage, `Failed to revert session ${sessionId}`, err)
  }
}

async function unrevertCurrentSession(sessionId: string) {
  const userMessage = t('globalActions.unrevertFailed', 'Could not unrevert this session. Please try again.')
  try {
    const ok = await window.coworkApi.session.unrevert(sessionId)
    if (!ok) {
      reportGlobalActionError(userMessage, `Failed to unrevert session ${sessionId}`, new Error('session.unrevert returned false'))
      return
    }
    await loadSessionMessages(sessionId, { force: true })
  } catch (err) {
    reportGlobalActionError(userMessage, `Failed to unrevert session ${sessionId}`, err)
  }
}

async function exportCurrentSession(sessionId: string) {
  try {
    const md = await window.coworkApi.session.export(sessionId)
    if (!md) return
    const blob = new Blob([md], { type: 'text/markdown' })
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(blob)
    anchor.download = 'thread.md'
    anchor.click()
  } catch (err) {
    reportGlobalActionError(
      t('globalActions.exportFailed', 'Could not export this thread. Please try again.'),
      `Failed to export session ${sessionId}`,
      err,
    )
  }
}

export function useAppGlobalEvents({
  runtimeReady,
  view,
  currentSessionId,
  toggleSidebar,
  createAndActivateSession,
  openSidebarSearch,
  openSidebarSettings,
  setView,
  setAuthenticated,
  setShowCommandPalette,
}: UseAppGlobalEventsOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === 'n') {
        if (!runtimeReady) return
        e.preventDefault()
        void createAndActivateSession()
      }

      if (mod && e.key === 'k') {
        e.preventDefault()
        openSidebarSearch()
      }

      if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      if (mod && e.key === 'z' && !e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().currentView.isGenerating) {
          e.preventDefault()
          void revertCurrentSession(sid)
        }
      }

      if (mod && e.key === 'z' && e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().currentView.isGenerating) {
          e.preventDefault()
          void unrevertCurrentSession(sid)
        }
      }

      if (e.key === 'Escape') {
        if (view !== 'home') setView(currentSessionId ? 'chat' : 'home')
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view, currentSessionId, toggleSidebar, runtimeReady, createAndActivateSession, openSidebarSearch, setView])

  useEffect(() => {
    const handleOpenSearch = () => openSidebarSearch()
    const handleOpenSettings = () => openSidebarSettings()
    window.addEventListener('open-cowork:toggle-search', handleOpenSearch)
    window.addEventListener('open-cowork:open-settings', handleOpenSettings)
    return () => {
      window.removeEventListener('open-cowork:toggle-search', handleOpenSearch)
      window.removeEventListener('open-cowork:open-settings', handleOpenSettings)
    }
  }, [openSidebarSearch, openSidebarSettings])

  useEffect(() => {
    // Both signals land us in the same UI state (signed-out banner, any
    // chrome that only makes sense with a user gone). The distinction
    // between "session expired involuntarily" and "user explicitly
    // logged out" lives in logs/analytics; the renderer just needs to
    // reflect the new auth state so stale windows don't keep claiming
    // someone is signed in.
    const handler = () => setAuthenticated(false)
    window.addEventListener('open-cowork:auth-expired', handler)
    window.addEventListener('open-cowork:auth-logout', handler)
    return () => {
      window.removeEventListener('open-cowork:auth-expired', handler)
      window.removeEventListener('open-cowork:auth-logout', handler)
    }
  }, [setAuthenticated])

  useEffect(() => {
    const unsubAction = window.coworkApi.on.menuAction((action) => {
      if (action === 'new-thread') {
        if (!runtimeReady) return
        void createAndActivateSession()
      } else if (action === 'command-palette') {
        setShowCommandPalette((current) => !current)
      } else if (action === 'search') {
        openSidebarSearch()
      } else if (action === 'toggle-sidebar') {
        toggleSidebar()
      } else if (action === 'export') {
        const sid = useSessionStore.getState().currentSessionId
        if (sid) {
          void exportCurrentSession(sid)
        }
      }
    })
    const unsubNav = window.coworkApi.on.menuNavigate((nextView) => {
      if (nextView === 'workflows') setView('workflows')
      if (nextView === 'agents') setView('agents')
      if (nextView === 'capabilities') setView('capabilities')
      if (nextView === 'home') setView('home')
      if (nextView === 'settings') openSidebarSettings()
    })
    return () => {
      unsubAction()
      unsubNav()
    }
  }, [
    toggleSidebar,
    runtimeReady,
    createAndActivateSession,
    openSidebarSearch,
    openSidebarSettings,
    setShowCommandPalette,
    setView,
  ])
}
