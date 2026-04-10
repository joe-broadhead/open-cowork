import { useState, useEffect } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ChatView } from './components/chat/ChatView'
import { LoginScreen } from './components/LoginScreen'
import { PluginsPage } from './components/plugins/PluginsPage'
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'

type View = 'chat' | 'plugins'

export function App() {
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [view, setView] = useState<View>('chat')
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

      // Shift+Tab — toggle Build/Plan mode
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        setAgentMode(agentMode === 'build' ? 'plan' : 'build')
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

  useEffect(() => {
    window.cowork.auth.status().then((status) => {
      setAuthenticated(status.authenticated)
      setAuthChecked(true)
      if (status.authenticated) {
        window.cowork.session.list().then(setSessions).catch(() => {})
      }
    })
  }, [])

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
        onLoggedIn={() => {
          setAuthenticated(true)
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
    </div>
  )
}
