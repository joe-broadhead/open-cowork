import { useState, useEffect } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ChatView } from './components/chat/ChatView'
import { LoginScreen } from './components/LoginScreen'
import { SetupScreen } from './components/SetupScreen'
import { PluginsPage } from './components/plugins/PluginsPage'
import { CommandPalette } from './components/CommandPalette'
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'
import { loadSessionMessages } from './helpers/loadSessionMessages'

type View = 'chat' | 'plugins'

export function App() {
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [view, setView] = useState<View>('chat')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  useOpenCodeEvents()

  const setSessions = useSessionStore((s) => s.setSessions)

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      // Cmd+N — new thread
      if (mod && e.key === 'n') {
        e.preventDefault()
        window.cowork.session.create().then(session => {
          addSession(session)
          setCurrentSession(session.id)
          clearMessages()
          setView('chat')
        })
      }

      // Cmd+K — toggle search (emit custom event for sidebar)
      if (mod && e.key === 'k') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('cowork:toggle-search'))
      }

      // Cmd+B — toggle sidebar
      if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      // Cmd+Z — undo last message
      if (mod && e.key === 'z' && !e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().isGenerating) {
          e.preventDefault()
          ;window.cowork.session.revert(sid).then((ok: boolean) => {
            if (ok) {
              // Reload messages after revert
              useSessionStore.getState().setCurrentSession(sid)
              loadSessionMessages(sid)
            }
          })
        }
      }

      // Cmd+Shift+Z — redo
      if (mod && e.key === 'z' && e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().isGenerating) {
          e.preventDefault()
          ;window.cowork.session.unrevert(sid).then((ok: boolean) => {
            if (ok) {
              useSessionStore.getState().setCurrentSession(sid)
              loadSessionMessages(sid)
            }
          })
        }
      }

      // Cmd+Shift+P — command palette
      if (mod && e.shiftKey && e.key === 'p') {
        e.preventDefault()
        setShowCommandPalette(s => !s)
      }

      // Escape — back to chat
      if (e.key === 'Escape') {
        if (view !== 'chat') setView('chat')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view])

  // Listen for auth expiry — show login screen
  useEffect(() => {
    const handler = () => setAuthenticated(false)
    window.addEventListener('cowork:auth-expired', handler)
    return () => window.removeEventListener('cowork:auth-expired', handler)
  }, [])

  // Listen for native menu actions
  useEffect(() => {
    const unsubAction = window.cowork.on.menuAction((action) => {
      if (action === 'new-thread') {
        window.cowork.session.create().then(session => {
          addSession(session); setCurrentSession(session.id); clearMessages(); setView('chat')
        })
      } else if (action === 'search') {
        window.dispatchEvent(new CustomEvent('cowork:toggle-search'))
      } else if (action === 'toggle-sidebar') {
        toggleSidebar()
      } else if (action === 'export') {
        const sid = useSessionStore.getState().currentSessionId
        if (sid) window.cowork.session.export(sid).then(md => {
          if (md) { const b = new Blob([md], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'thread.md'; a.click() }
        })
      }
    })
    const unsubNav = window.cowork.on.menuNavigate((v) => {
      if (v === 'plugins') setView('plugins')
      if (v === 'settings') window.dispatchEvent(new CustomEvent('cowork:open-settings'))
    })
    return () => { unsubAction(); unsubNav() }
  }, [])

  // Check auth + provider setup on mount
  useEffect(() => {
    window.cowork.auth.status().then((status) => {
      setAuthenticated(status.authenticated)
      setUserEmail(status.email || '')
      setAuthChecked(true)
      if (status.authenticated) {
        window.cowork.settings.get().then((s: any) => {
          const hasProvider = s.provider === 'vertex' ||
            (s.provider === 'databricks' && s.databricksHost && s.databricksToken)
          if (!hasProvider) {
            setNeedsSetup(true)
          }
          // Sessions are loaded when runtime:ready fires (see below)
        })
      }
    })
  }, [])

  // Load sessions when the runtime signals it's ready
  useEffect(() => {
    const unsub = window.cowork.on.runtimeReady(() => {
      loadSessions()
    })
    // Also try loading immediately in case the runtime is already running
    loadSessions()
    return unsub
  }, [])

  function loadSessions() {
    window.cowork.session.list().then((sessions) => {
      if (!sessions || sessions.length === 0) return
      setSessions(sessions)
      // Auto-select the most recent session if none selected
      if (!useSessionStore.getState().currentSessionId) {
        const latest = sessions[0]
        useSessionStore.getState().setCurrentSession(latest.id)
        loadSessionMessages(latest.id)
      }
    }).catch(() => {})
  }

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
        <span className="text-text-muted text-[13px]">Loading...</span>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <LoginScreen
        onLoggedIn={(email) => {
          setAuthenticated(true)
          setUserEmail(email)
          // Check if setup is needed
          window.cowork.settings.get().then((s: any) => {
            const hasProvider = s.provider === 'vertex' ||
              (s.provider === 'databricks' && s.databricksHost && s.databricksToken)
            if (!hasProvider) {
              setNeedsSetup(true)
            } else {
              loadSessions()
            }
          })
        }}
      />
    )
  }

  if (needsSetup) {
    return (
      <SetupScreen
        email={userEmail}
        onComplete={() => {
          setNeedsSetup(false)
          // Runtime will be booted by the main process after settings are saved
          // Give it a moment to start, then load sessions
          setTimeout(() => loadSessions(), 2000)
        }}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-base">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        {!sidebarCollapsed && <Sidebar currentView={view} onViewChange={setView} />}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          {view === 'chat' && <ChatView />}
          {view === 'plugins' && <PluginsPage onClose={() => setView('chat')} />}
        </main>
      </div>
      <StatusBar />
      {showCommandPalette && <CommandPalette onClose={() => setShowCommandPalette(false)} />}
    </div>
  )
}
