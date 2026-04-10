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
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [view, setView] = useState<View>('chat')
  useOpenCodeEvents()

  const setSessions = useSessionStore((s) => s.setSessions)

  useEffect(() => {
    window.cowork.auth.status().then((status) => {
      setAuthenticated(status.authenticated)
      setAuthChecked(true)
      // Load existing sessions if authenticated
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
