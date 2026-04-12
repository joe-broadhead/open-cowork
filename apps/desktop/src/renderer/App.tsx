import { useState, useEffect, lazy, Suspense } from 'react'
import type { EffectiveAppSettings, PublicAppConfig } from '@open-cowork/shared'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ChatView } from './components/chat/ChatView'
import { LoginScreen } from './components/LoginScreen'
import { SetupScreen } from './components/SetupScreen'
import { HomePage } from './components/HomePage'

const PluginsPage = lazy(() => import('./components/plugins/PluginsPage').then((m) => ({ default: m.PluginsPage })))
const AgentsPage = lazy(() => import('./components/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'
import { loadSessionMessages } from './helpers/loadSessionMessages'

type View = 'home' | 'chat' | 'plugins' | 'agents'

function isSetupComplete(settings: EffectiveAppSettings, config: PublicAppConfig) {
  if (!settings.effectiveProviderId || !settings.effectiveModel) return false
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId)
  if (!provider) return false
  for (const credential of provider.credentials) {
    if (credential.required === false) continue
    const value = settings.providerCredentials?.[provider.id]?.[credential.key]
    if (typeof value !== 'string' || !value.trim()) return false
  }
  return true
}

export function App() {
  const sidebarCollapsed = useSessionStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useSessionStore((s) => s.toggleSidebar)
  const addSession = useSessionStore((s) => s.addSession)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setSessions = useSessionStore((s) => s.setSessions)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [view, setView] = useState<View>('home')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  useOpenCodeEvents()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === 'n') {
        e.preventDefault()
        window.openCowork.session.create().then((session) => {
          addSession(session)
          setCurrentSession(session.id)
          setView('chat')
        }).catch((err) => console.error('Failed to create session:', err))
      }

      if (mod && e.key === 'k') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('cowork:toggle-search'))
      }

      if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      if (mod && e.key === 'z' && !e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().isGenerating) {
          e.preventDefault()
          window.openCowork.session.revert(sid).then((ok: boolean) => {
            if (ok) loadSessionMessages(sid, { force: true })
          }).catch((err) => console.error('Failed to revert session:', err))
        }
      }

      if (mod && e.key === 'z' && e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().isGenerating) {
          e.preventDefault()
          window.openCowork.session.unrevert(sid).then((ok: boolean) => {
            if (ok) loadSessionMessages(sid, { force: true })
          }).catch((err) => console.error('Failed to unrevert session:', err))
        }
      }

      if (mod && e.shiftKey && e.key === 'p') {
        e.preventDefault()
        setShowCommandPalette((current) => !current)
      }

      if (e.key === 'Escape') {
        if (view !== 'home') setView(currentSessionId ? 'chat' : 'home')
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view, currentSessionId, addSession, setCurrentSession, toggleSidebar])

  useEffect(() => {
    const handler = () => setAuthenticated(false)
    window.addEventListener('cowork:auth-expired', handler)
    return () => window.removeEventListener('cowork:auth-expired', handler)
  }, [])

  useEffect(() => {
    const unsubAction = window.openCowork.on.menuAction((action) => {
      if (action === 'new-thread') {
        window.openCowork.session.create().then((session) => {
          addSession(session)
          setCurrentSession(session.id)
          setView('chat')
        }).catch((err) => console.error('Failed to create session from menu:', err))
      } else if (action === 'search') {
        window.dispatchEvent(new CustomEvent('cowork:toggle-search'))
      } else if (action === 'toggle-sidebar') {
        toggleSidebar()
      } else if (action === 'export') {
        const sid = useSessionStore.getState().currentSessionId
        if (sid) {
          window.openCowork.session.export(sid).then((md) => {
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
    const unsubNav = window.openCowork.on.menuNavigate((nextView) => {
      if (nextView === 'plugins') setView('plugins')
      if (nextView === 'agents') setView('agents')
      if (nextView === 'home') setView('home')
      if (nextView === 'settings') window.dispatchEvent(new CustomEvent('cowork:open-settings'))
    })
    return () => {
      unsubAction()
      unsubNav()
    }
  }, [addSession, setCurrentSession, toggleSidebar])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const [appConfig, authState, settings] = await Promise.all([
          window.openCowork.app.config(),
          window.openCowork.auth.status(),
          window.openCowork.settings.get(),
        ])
        if (cancelled) return

        setConfig(appConfig)
        setAuthenticated(authState.authenticated)
        setUserEmail(authState.email || '')
        setNeedsSetup(!isSetupComplete(settings, appConfig))
      } catch (err) {
        console.error('Failed to bootstrap app:', err)
      } finally {
        if (!cancelled) setAuthChecked(true)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const unsub = window.openCowork.on.runtimeReady(() => {
      loadSessions()
    })
    loadSessions()
    return unsub
  }, [])

  function loadSessions() {
    window.openCowork.session.list().then((sessions) => {
      if (!sessions || sessions.length === 0) return
      setSessions(sessions)
    }).catch((err) => console.error('Failed to load sessions:', err))
  }

  if (!authChecked || !config) {
    return (
      <div className="flex items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
        <span className="text-text-muted text-[13px]">Loading...</span>
      </div>
    )
  }

  if (config.auth.enabled && !authenticated) {
    return (
      <LoginScreen
        brandName={config.branding.name}
        onLoggedIn={(email) => {
          setAuthenticated(true)
          setUserEmail(email)
          window.openCowork.settings.get().then((settings) => {
            setNeedsSetup(!isSetupComplete(settings, config))
            if (isSetupComplete(settings, config)) loadSessions()
          }).catch((err) => console.error('Failed to load settings after login:', err))
        }}
      />
    )
  }

  if (needsSetup) {
    return (
      <SetupScreen
        brandName={config.branding.name}
        email={userEmail}
        providers={config.providers.available}
        defaultProviderId={config.providers.defaultProvider}
        defaultModelId={config.providers.defaultModel}
        onComplete={() => {
          setNeedsSetup(false)
          setTimeout(() => loadSessions(), 1000)
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
          {view === 'home' && <HomePage onOpenThread={() => setView('chat')} brandName={config.branding.name} />}
          {view === 'chat' && <ChatView brandName={config.branding.name} />}
          {view === 'plugins' && <Suspense fallback={null}><PluginsPage onClose={() => setView('chat')} /></Suspense>}
          {view === 'agents' && <Suspense fallback={null}><AgentsPage onClose={() => setView('chat')} onOpenPlugins={() => setView('plugins')} /></Suspense>}
        </main>
      </div>
      <StatusBar />
      {showCommandPalette && <Suspense fallback={null}><CommandPalette onClose={() => setShowCommandPalette(false)} /></Suspense>}
    </div>
  )
}
