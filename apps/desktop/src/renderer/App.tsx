import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import type { CustomAgentConfig, EffectiveAppSettings, PublicAppConfig, SessionInfo } from '@open-cowork/shared'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ViewErrorBoundary } from './components/layout/ViewErrorBoundary'
import { RuntimeOfflineBanner } from './components/layout/RuntimeOfflineBanner'
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
import { setBrandName } from './helpers/brand'
import { configureI18n, subscribeLocale } from './helpers/i18n'
import { registerExtraThemes, setDefaultThemeId } from './helpers/theme-presets'
import { applyAppearancePreferences } from './helpers/theme'
import { registerExtraStarterTemplates } from './components/agents/starter-templates'

type View = 'home' | 'chat' | 'agents' | 'capabilities'
type AgentBuilderSeed = Partial<CustomAgentConfig> | null

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
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const setSessions = useSessionStore((s) => s.setSessions)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  // Flipped to true the first time the runtime is successfully ready.
  // Distinguishes "we're still booting" (show LoadingScreen) from
  // "we were running and the runtime dropped" (show an inline banner
  // so the user's chat context doesn't vanish behind a full-screen
  // takeover).
  const [runtimeWasReady, setRuntimeWasReady] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [view, setView] = useState<View>('home')
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [agentBuilderSeed, setAgentBuilderSeed] = useState<AgentBuilderSeed>(null)
  const [pendingComposerInsert, setPendingComposerInsert] = useState<string | null>(null)
  // Force the whole tree to re-render when the active locale changes.
  // Every `t(key, fallback)` is resolved at render time from the i18n
  // module's module-level cache, so bumping this counter is enough to
  // flush stale English strings from memoized components without a
  // page reload (which would collapse the Settings panel mid-edit).
  const [localeVersion, setLocaleVersion] = useState(0)
  useEffect(() => subscribeLocale(() => setLocaleVersion((n) => n + 1)), [])
  useOpenCodeEvents()

  async function loadSessions() {
    return window.coworkApi.session.list().then((sessions) => {
      setSessions(sessions || [])
    }).catch((err) => console.error('Failed to load sessions:', err))
  }

  async function refreshRuntimeState() {
    return window.coworkApi.runtime.status().then(async (status) => {
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        setRuntimeWasReady(true)
        await loadSessions()
      }
    }).catch((err) => console.error('Failed to query runtime status:', err))
  }

  // Poll runtime health so a mid-session drop (network loss, OpenCode
  // crash, disk full) surfaces as the offline banner instead of
  // silently hanging the next prompt. Poll is cheap (a single IPC)
  // and paused while the window is hidden — no point checking a
  // background app.
  useEffect(() => {
    if (!runtimeWasReady) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const status = await window.coworkApi.runtime.status()
        setRuntimeReady(status.ready)
        setRuntimeError(status.error || null)
      } catch {
        /* transient IPC failures shouldn't trip the banner */
      }
    }
    const interval = window.setInterval(() => { void check() }, 10_000)
    const onFocus = () => { void check() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [runtimeWasReady])

  const handleRuntimeRestart = useCallback(async () => {
    try {
      const status = await window.coworkApi.runtime.restart()
      setRuntimeReady(status.ready)
      setRuntimeError(status.error || null)
      if (status.ready) {
        setRuntimeWasReady(true)
        await loadSessions()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Runtime restart failed.'
      setRuntimeError(message)
    }
  }, [])

  const createAndActivateSession = useCallback(async (directory?: string): Promise<SessionInfo | null> => {
    try {
      const session = await window.coworkApi.session.create(directory)
      addSession(session)
      setCurrentSession(session.id)
      await window.coworkApi.session.activate(session.id)
      setView('chat')
      return session
    } catch (err) {
      console.error('Failed to create session:', err)
      return null
    }
  }, [addSession, setCurrentSession])

  const ensureActiveSession = useCallback(async (): Promise<boolean> => {
    if (useSessionStore.getState().currentSessionId) return true
    const session = await createAndActivateSession()
    return !!session
  }, [createAndActivateSession])

  // Global window-level error capture. The React ErrorBoundary catches
  // render-time panics; this covers the gaps — uncaught exceptions in
  // async handlers, rejected promises from event listeners, etc. Both
  // feed the same `reportRendererError` IPC so the sanitized diagnostics
  // bundle sees every runtime issue a downstream bug report needs.
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      try {
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: event.message || event.error?.message || 'window error',
          stack: event.error?.stack,
        })
      } catch { /* diagnostics reporting must never throw */ }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        const reason = event.reason
        const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'unhandled rejection'
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: `unhandled rejection: ${message}`,
          stack: reason instanceof Error ? reason.stack : undefined,
        })
      } catch { /* never throw */ }
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

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
  }, [view, currentSessionId, isGenerating, toggleSidebar, runtimeReady, createAndActivateSession])

  useEffect(() => {
    const handler = () => setAuthenticated(false)
    window.addEventListener('open-cowork:auth-expired', handler)
    return () => window.removeEventListener('open-cowork:auth-expired', handler)
  }, [])

  useEffect(() => {
    const unsubAction = window.coworkApi.on.menuAction((action) => {
      if (action === 'new-thread') {
        if (!runtimeReady) return
        void createAndActivateSession()
      } else if (action === 'command-palette') {
        setShowCommandPalette((current) => !current)
      } else if (action === 'search') {
        window.dispatchEvent(new CustomEvent('open-cowork:toggle-search'))
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
      if (nextView === 'agents') setView('agents')
      if (nextView === 'capabilities') setView('capabilities')
      if (nextView === 'home') setView('home')
      if (nextView === 'settings') window.dispatchEvent(new CustomEvent('open-cowork:open-settings'))
    })
    return () => {
      unsubAction()
      unsubNav()
    }
  }, [toggleSidebar, runtimeReady, createAndActivateSession])

  useEffect(() => {
    if (view !== 'chat' || !pendingComposerInsert) return
    const text = pendingComposerInsert
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('open-cowork:composer-insert', { detail: { text } }))
      setPendingComposerInsert((current) => (current === text ? null : current))
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingComposerInsert, view])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        // Session records live in the local registry on disk, so we can
        // populate the thread list the moment auth/config resolves — no
        // need to wait for the OpenCode runtime to boot (2–3s later).
        void loadSessions()

        const [appConfig, authState, settings] = await Promise.all([
          window.coworkApi.app.config(),
          window.coworkApi.auth.status(),
          window.coworkApi.settings.get(),
        ])
        if (cancelled) return

        setConfig(appConfig)
        setBrandName(appConfig?.branding?.name)
        configureI18n(appConfig?.i18n)
        registerExtraThemes(appConfig?.branding?.themes)
        setDefaultThemeId(appConfig?.branding?.defaultTheme)
        registerExtraStarterTemplates(appConfig?.agentStarterTemplates)
        // Re-apply preferences so a downstream-provided default theme takes
        // effect immediately if the user hasn't picked one locally yet.
        applyAppearancePreferences()
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
    const unsub = window.coworkApi.on.runtimeReady(() => {
      if (cancelled) return
      setRuntimeReady(true)
      setRuntimeError(null)
      void loadSessions()
    })

    void window.coworkApi.runtime.status().then((status) => {
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
          : null

  if (!authChecked || !config || loadingStage) {
    return (
      <LoadingScreen
        brandName={config?.branding.name || 'Cowork'}
        stage={(!authChecked ? 'boot' : !config ? 'config' : loadingStage || 'runtime') as 'boot' | 'auth' | 'config' | 'runtime'}
        errorMessage={runtimeError}
      />
    )
  }

  // Initial-boot failure: full LoadingScreen. Once we've successfully
  // reached runtime-ready at least once, drops are surfaced inline
  // via RuntimeOfflineBanner below so the user's chat context stays
  // visible while they retry.
  if (runtimeError && !runtimeWasReady) {
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
          window.coworkApi.settings.get().then((settings) => {
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

  // `localeVersion` is read (not used as a key) so the compiler keeps
  // the state binding. Its sole purpose is to re-render App when the
  // locale changes — React cascades that render through every
  // non-memoized descendant, so each `t(key, fallback)` call resolves
  // fresh against the updated catalog and the active Intl formatters
  // pick up the new locale. Using it as a `key` would remount the
  // tree and reset local UI state (e.g. Settings panel visibility in
  // Sidebar), which was the bug this replaced.
  void localeVersion
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-base">
      <TitleBar />
      {runtimeWasReady && runtimeError ? (
        <RuntimeOfflineBanner error={runtimeError} onRestart={handleRuntimeRestart} />
      ) : null}
      <div className="flex flex-1 min-h-0">
        {!sidebarCollapsed && <Sidebar currentView={view} onViewChange={setView} />}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          <ViewErrorBoundary resetKey={view} onBackHome={() => setView('home')}>
            {view === 'home' && <HomePage onOpenThread={() => setView('chat')} brandName={config.branding.name} />}
            {view === 'chat' && <ChatView brandName={config.branding.name} />}
            {view === 'agents' && (
              <Suspense fallback={null}>
                <AgentsPage
                  initialDraft={agentBuilderSeed}
                  onClearDraft={() => setAgentBuilderSeed(null)}
                  onClose={() => setView('chat')}
                  onOpenCapabilities={() => setView('capabilities')}
                />
              </Suspense>
            )}
            {view === 'capabilities' && (
              <Suspense fallback={null}>
                <CapabilitiesPage
                  onClose={() => setView('chat')}
                  onCreateAgent={(seed) => {
                    setAgentBuilderSeed(seed)
                    setView('agents')
                  }}
                />
              </Suspense>
            )}
          </ViewErrorBoundary>
        </main>
      </div>
      <StatusBar />
      {showCommandPalette && (
        <Suspense fallback={null}>
          <CommandPalette
            onClose={() => setShowCommandPalette(false)}
            onNavigate={setView}
            onCreateThread={createAndActivateSession}
            onEnsureSession={ensureActiveSession}
            onInsertComposer={(text) => {
              setPendingComposerInsert(text)
              setView('chat')
            }}
            onSetAgentMode={setAgentMode}
          />
        </Suspense>
      )}
    </div>
  )
}
