import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SessionInfo } from '@open-cowork/shared'

import type { AppView } from '../app-types'
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
          window.coworkApi.session.revert(sid).then((ok: boolean) => {
            if (ok) loadSessionMessages(sid, { force: true })
          }).catch((err) => console.error('Failed to revert session:', err))
        }
      }

      if (mod && e.key === 'z' && e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().currentView.isGenerating) {
          e.preventDefault()
          window.coworkApi.session.unrevert(sid).then((ok: boolean) => {
            if (ok) loadSessionMessages(sid, { force: true })
          }).catch((err) => console.error('Failed to unrevert session:', err))
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
          window.coworkApi.session.export(sid).then((md) => {
            if (!md) return
            const blob = new Blob([md], { type: 'text/markdown' })
            const anchor = document.createElement('a')
            anchor.href = URL.createObjectURL(blob)
            anchor.download = 'thread.md'
            anchor.click()
          }).catch((err) => console.error('Failed to export session:', err))
        }
      }
    })
    const unsubNav = window.coworkApi.on.menuNavigate((nextView) => {
      if (nextView === 'automations') setView('automations')
      if (nextView === 'agents') setView('agents')
      if (nextView === 'capabilities') setView('capabilities')
      if (nextView === 'home') setView('home')
      if (nextView === 'pulse') setView('pulse')
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
