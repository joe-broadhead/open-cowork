import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { normalizeVoicePttShortcut, VOICE_PTT_SHORTCUT, type SessionInfo } from '@open-cowork/shared'

import { normalizeAppView, type AppView } from '../app-types'
import { t } from '../helpers/i18n'
import { switchToSession } from '../helpers/switchToSession'
import { useSessionStore } from '../stores/session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from '../stores/session-workspace-keys'
import { matchesAccelerator, requestVoicePttToggle } from './voice-ptt-hotkey'

type UseAppGlobalEventsOptions = {
  runtimeReady: boolean
  voiceEnabled: boolean
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
    await switchToSession(sessionId, { force: true })
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
    await switchToSession(sessionId, { force: true })
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

async function switchProjectByIndex(index: number, setView: (view: AppView) => void) {
  const workspaceId = normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId)
  if (workspaceId !== LOCAL_WORKSPACE_ID) return
  try {
    const session = await window.coworkApi.projects.switchByIndex(index)
    if (!session) return
    const store = useSessionStore.getState()
    const workspaceSessions = store.sessionsByWorkspace[workspaceId] || []
    store.setSessions([session, ...workspaceSessions.filter((existing) => existing.id !== session.id)], workspaceId)
    if (normalizeWorkspaceId(store.activeWorkspaceId) !== workspaceId) return
    setView('chat')
    await switchToSession(session.id, { force: true })
  } catch (err) {
    reportGlobalActionError(
      t('globalActions.projectSwitchFailed', 'Could not switch projects. Please try again.'),
      `Failed to switch to project shortcut ${index}`,
      err,
    )
  }
}

export function useAppGlobalEvents({
  runtimeReady,
  voiceEnabled,
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
  const [voicePttShortcut, setVoicePttShortcut] = useState(VOICE_PTT_SHORTCUT)

  useEffect(() => {
    if (!voiceEnabled) {
      setVoicePttShortcut(VOICE_PTT_SHORTCUT)
      return
    }
    // Keep the saved accelerator while a previously-ready runtime recovers.
    // Resetting here would briefly reactivate the default alongside Electron's
    // persisted menu accelerator. Voice key handling is gated on runtimeReady.
    if (!runtimeReady) return
    let cancelled = false
    let shortcutEventGeneration = 0
    const applyShortcut = (value: unknown) => {
      const normalized = normalizeVoicePttShortcut(value)
      if (!cancelled && normalized) setVoicePttShortcut(normalized)
    }
    const handleShortcutChanged = (event: Event) => {
      const shortcut = (event as CustomEvent<{ shortcut?: unknown }>).detail?.shortcut
      const normalized = normalizeVoicePttShortcut(shortcut)
      if (!cancelled && normalized) {
        shortcutEventGeneration += 1
        setVoicePttShortcut(normalized)
      }
    }
    window.addEventListener('open-cowork:voice-shortcut-changed', handleShortcutChanged)
    const settingsReadGeneration = shortcutEventGeneration
    window.coworkApi.settings.get()
      .then((settings) => {
        if (shortcutEventGeneration === settingsReadGeneration) applyShortcut(settings.voicePttShortcut)
      })
      .catch(() => {
        // The shared default remains active if settings are temporarily unavailable.
      })
    return () => {
      cancelled = true
      window.removeEventListener('open-cowork:voice-shortcut-changed', handleShortcutChanged)
    }
  }, [runtimeReady, voiceEnabled])

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

      // Voice PTT stays app-focused. Settings are read only after runtime readiness,
      // so login shells do not gain a new settings IPC dependency.
      if (runtimeReady && voiceEnabled && matchesAccelerator(e, voicePttShortcut)) {
        e.preventDefault()
        void requestVoicePttToggle()
        return
      }

      if (e.key === 'Escape') {
        if (view !== 'home') setView(currentSessionId ? 'chat' : 'home')
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view, currentSessionId, toggleSidebar, runtimeReady, createAndActivateSession, openSidebarSearch, setView, voiceEnabled, voicePttShortcut])

  useEffect(() => {
    const handleToggleSidebar = () => toggleSidebar()
    const handleOpenSearch = () => openSidebarSearch()
    const handleOpenSettings = () => openSidebarSettings()
    window.addEventListener('open-cowork:toggle-sidebar', handleToggleSidebar)
    window.addEventListener('open-cowork:toggle-search', handleOpenSearch)
    window.addEventListener('open-cowork:open-settings', handleOpenSettings)
    return () => {
      window.removeEventListener('open-cowork:toggle-sidebar', handleToggleSidebar)
      window.removeEventListener('open-cowork:toggle-search', handleOpenSearch)
      window.removeEventListener('open-cowork:open-settings', handleOpenSettings)
    }
  }, [openSidebarSearch, openSidebarSettings, toggleSidebar])

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
      } else if (action === 'voice-ptt-toggle') {
        void requestVoicePttToggle()
      } else if (action.startsWith('project-switch:')) {
        const index = Number.parseInt(action.slice('project-switch:'.length), 10)
        if (Number.isInteger(index)) void switchProjectByIndex(index, setView)
      }
    })
    const unsubNav = window.coworkApi.on.menuNavigate((nextView) => {
      const normalized = normalizeAppView(nextView)
      if (normalized && normalized !== 'settings') setView(normalized)
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
