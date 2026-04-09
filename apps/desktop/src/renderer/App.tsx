import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ChatView } from './components/chat/ChatView'
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'

export function App() {
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed)
  useOpenCodeEvents()

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-base">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        {!sidebarCollapsed && <Sidebar />}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          <ChatView />
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
