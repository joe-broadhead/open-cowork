import { useState, useEffect, lazy, Suspense } from 'react'
import type { EffectiveAppSettings, PublicAppConfig } from '@open-cowork/shared'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ViewErrorBoundary } from './components/layout/ViewErrorBoundary'
import { ChatView } from './components/chat/ChatView'
import { LoginScreen } from './components/LoginScreen'
import { LoadingScreen } from './components/LoadingScreen'
import { SetupScreen } from './components/SetupScreen'
import { HomePage } from './components/HomePage'

const AgentsPage = lazy(() => import('./components/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const CapabilitiesPage = lazy(() => import('./components/capabilities/CapabilitiesPage').then((m) => ({ default: m.CapabilitiesPage })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'
import { loadSessionMessages } from './helpers/loadSessionMessages'

type View = 'home' | 'chat' | 'agents' | 'capabilities'

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
  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const setSessions = useSessionStore((s) => s.setSessions)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [view, setView] = useState<View>('home')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  useOpenCodeEvents()

  async function loadSessions() {
    return window.openCowork.session.list().then((sessions) => {
      setSessions(sessions || [])
    }).catch((err) => console.error('Failed to load sessions:', err))
  }

  async function refreshRuntimeState() {
    return window.openCowork.runtime.status().then(async (status) => {
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        await loadSessions()
      }
    }).catch((err) => console.error('Failed to query runtime status:', err))
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === 'n') {
        if (!runtimeReady) return
        e.preventDefault()
        window.openCowork.session.create().then(async (session) => {
          addSession(session)
          setCurrentSession(session.id)
          await window.openCowork.session.activate(session.id)
          setView('chat')
        }).catch((err) => console.error('Failed to create session:', err))
      }

      if (mod && e.key === 'k') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('open-cowork:toggle-search'))
      }

      if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      if (mod && e.key === 'z' && !e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().currentView.isGenerating) {
          e.preventDefault()
          window.openCowork.session.revert(sid).then((ok: boolean) => {
            if (ok) loadSessionMessages(sid, { force: true })
          }).catch((err) => console.error('Failed to revert session:', err))
        }
      }

      if (mod && e.key === 'z' && e.shiftKey) {
        const sid = useSessionStore.getState().currentSessionId
        if (sid && !useSessionStore.getState().currentView.isGenerating) {
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
  }, [view, currentSessionId, isGenerating, addSession, setCurrentSession, toggleSidebar, runtimeReady])

  useEffect(() => {
    const handler = () => setAuthenticated(false)
    window.addEventListener('open-cowork:auth-expired', handler)
    return () => window.removeEventListener('open-cowork:auth-expired', handler)
  }, [])

  useEffect(() => {
    const unsubAction = window.openCowork.on.menuAction((action) => {
      if (action === 'new-thread') {
        if (!runtimeReady) return
        window.openCowork.session.create().then(async (session) => {
          addSession(session)
          setCurrentSession(session.id)
          await window.openCowork.session.activate(session.id)
          setView('chat')
        }).catch((err) => console.error('Failed to create session from menu:', err))
      } else if (action === 'search') {
        window.dispatchEvent(new CustomEvent('open-cowork:toggle-search'))
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
      if (nextView === 'agents') setView('agents')
      if (nextView === 'capabilities') setView('capabilities')
      if (nextView === 'home') setView('home')
      if (nextView === 'settings') window.dispatchEvent(new CustomEvent('open-cowork:open-settings'))
    })
    return () => {
      unsubAction()
      unsubNav()
    }
  }, [addSession, setCurrentSession, toggleSidebar, runtimeReady])

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
    let cancelled = false
    const unsub = window.openCowork.on.runtimeReady(() => {
      if (cancelled) return
      setRuntimeReady(true)
      setRuntimeError(null)
      void loadSessions()
    })

    void window.openCowork.runtime.status().then((status) => {
      if (cancelled) return
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        void loadSessions()
      }
    }).catch((err) => console.error('Failed to initialize runtime status:', err))

    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!config || !authChecked) return
    if (config.auth.enabled && !authenticated) return
    if (needsSetup) return
    void refreshRuntimeState()
  }, [authChecked, authenticated, config, needsSetup])

  const loadingStage = !authChecked
    ? 'boot'
    : !config
      ? 'config'
      : (config.auth.enabled && !authenticated)
        ? null
        : needsSetup
          ? null
          : !runtimeReady
            ? 'runtime'
            : null

  if (!authChecked || !config || loadingStage) {
    return (
      <LoadingScreen
        brandName={config?.branding.name || 'Open Cowork'}
        stage={(!authChecked ? 'boot' : !config ? 'config' : loadingStage || 'runtime') as 'boot' | 'auth' | 'config' | 'runtime'}
        errorMessage={runtimeError}
      />
    )
  }

  if (runtimeError) {
    return (
      <LoadingScreen
        brandName={config.branding.name}
        stage="runtime"
        errorMessage={runtimeError}
      />
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
            if (isSetupComplete(settings, config)) void refreshRuntimeState()
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
          void refreshRuntimeState()
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
          <ViewErrorBoundary resetKey={view} onBackHome={() => setView('home')}>
            {view === 'home' && <HomePage onOpenThread={() => setView('chat')} brandName={config.branding.name} />}
            {view === 'chat' && <ChatView brandName={config.branding.name} />}
            {view === 'agents' && <Suspense fallback={null}><AgentsPage onClose={() => setView('chat')} onOpenCapabilities={() => setView('capabilities')} /></Suspense>}
            {view === 'capabilities' && <Suspense fallback={null}><CapabilitiesPage onClose={() => setView('chat')} /></Suspense>}
          </ViewErrorBoundary>
        </main>
      </div>
      <StatusBar />
      {showCommandPalette && <Suspense fallback={null}><CommandPalette onClose={() => setShowCommandPalette(false)} /></Suspense>}
    </div>
  )
}
