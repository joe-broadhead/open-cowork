import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import type { AppMetadata, CustomAgentConfig, EffectiveAppSettings, PublicAppConfig, SessionInfo } from '@open-cowork/shared'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ViewErrorBoundary } from './components/layout/ViewErrorBoundary'
import { RuntimeOfflineBanner } from './components/layout/RuntimeOfflineBanner'
import { LoginScreen } from './components/LoginScreen'
import { LoadingScreen } from './components/LoadingScreen'
import { SetupScreen } from './components/SetupScreen'
import { HomePage } from './components/HomePage'

const ChatView = lazy(() => import('./components/chat/ChatView').then((m) => ({ default: m.ChatView })))
const AutomationsPage = lazy(() => import('./components/automations/AutomationsPage').then((m) => ({ default: m.AutomationsPage })))
const AgentsPage = lazy(() => import('./components/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const CapabilitiesPage = lazy(() => import('./components/capabilities/CapabilitiesPage').then((m) => ({ default: m.CapabilitiesPage })))
// Pulse is the diagnostic workspace view — runtime pills, MCP status, usage
// metrics, perf. Lazy-loaded because most users landing on Home don't need it
// right away, and it pulls a lot of formatting helpers that would otherwise
// inflate the first-paint chunk.
const PulsePage = lazy(() => import('./components/PulsePage').then((m) => ({ default: m.PulsePage })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'
import { loadSessionMessages } from './helpers/loadSessionMessages'
import { setBrandName } from './helpers/brand'
import { configureI18n, subscribeLocale } from './helpers/i18n'
import { registerExtraThemes, setDefaultThemeId } from './helpers/theme-presets'
import { applyAppearancePreferences } from './helpers/theme'
import { registerExtraStarterTemplates } from './components/agents/starter-templates'

type View = 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse'
type AgentBuilderSeed = Partial<CustomAgentConfig> | null

function previewDismissed(version: string) {
  try {
    return window.localStorage.getItem(`open-cowork.preview-dismissed.${version}`) === 'true'
  } catch {
    return false
  }
}

function dismissPreview(version: string) {
  try {
    window.localStorage.setItem(`open-cowork.preview-dismissed.${version}`, 'true')
  } catch {
    // localStorage can be unavailable in restricted renderer contexts.
  }
}

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
  const [metadata, setMetadata] = useState<AppMetadata | null>(null)
  const [previewNoticeDismissed, setPreviewNoticeDismissed] = useState(false)
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
  const [sidebarSearchNonce, setSidebarSearchNonce] = useState(0)
  const [sidebarSettingsNonce, setSidebarSettingsNonce] = useState(0)
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

  const openExistingThread = useCallback(async (sessionId: string) => {
    setView('chat')
    await loadSessionMessages(sessionId)
  }, [])

  const ensureSidebarVisible = useCallback(() => {
    const state = useSessionStore.getState()
    if (state.sidebarCollapsed) state.toggleSidebar()
  }, [])

  const openSidebarSearch = useCallback(() => {
    ensureSidebarVisible()
    setSidebarSearchNonce((current) => current + 1)
  }, [ensureSidebarVisible])

  const openSidebarSettings = useCallback(() => {
    ensureSidebarVisible()
    setSidebarSettingsNonce((current) => current + 1)
  }, [ensureSidebarVisible])

  // Home composer path: create + activate a fresh session, switch to the
  // chat view, then fire the prompt straight at the runtime. We
  // deliberately skip the chat composer's state — the user already hit
  // send on Home and expects their message to be in flight, not waiting
  // for them to press send again.
  const startThreadFromHome = useCallback(async (
    text: string,
    attachments?: Array<{ mime: string; url: string; filename: string }>,
  ) => {
    const session = await createAndActivateSession()
    if (!session) return
    try {
      const files = attachments && attachments.length > 0
        ? attachments.map((attachment) => ({
            mime: attachment.mime,
            url: attachment.url,
            filename: attachment.filename,
          }))
        : undefined
      // Send an explicit prompt even when the user only dropped a file.
      // Matching ChatInput's UX: an image-only message still needs a
      // textual hint for the model, so default to "Describe this image."
      // if the user didn't type anything — they can always edit the
      // thread after.
      const promptText = text.trim() || (files ? 'Describe this image.' : text)
      await window.coworkApi.session.prompt(session.id, promptText, files)
    } catch (err) {
      console.error('Failed to send Home prompt:', err)
    }
  }, [createAndActivateSession])

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
  }, [view, currentSessionId, isGenerating, toggleSidebar, runtimeReady, createAndActivateSession, openSidebarSearch])

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
  }, [])

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
  }, [toggleSidebar, runtimeReady, createAndActivateSession, openSidebarSearch, openSidebarSettings])

  // If the current thread disappears while the chat view is active —
  // deleted from the sidebar, reset, or reverted to null by a runtime
  // error — bounce back to Home rather than rendering an empty chat.
  // ChatView returns null in that state, so without this nudge the
  // user would see a blank pane with no way back.
  useEffect(() => {
    if (view === 'chat' && !currentSessionId) {
      setView('home')
    }
  }, [view, currentSessionId])

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

        const [appConfig, authState, settings, appMetadata] = await Promise.all([
          window.coworkApi.app.config(),
          window.coworkApi.auth.status(),
          window.coworkApi.settings.get(),
          window.coworkApi.app.metadata(),
        ])
        if (cancelled) return

        setConfig(appConfig)
        setMetadata(appMetadata)
        setPreviewNoticeDismissed(previewDismissed(appMetadata.version))
        setBrandName(appConfig?.branding?.name)
        void configureI18n(appConfig?.i18n)
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
  const showPreviewNotice = Boolean(metadata?.preview && !previewNoticeDismissed)
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-base">
      <TitleBar />
      {showPreviewNotice && metadata ? (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-50 px-4 py-2 text-[12px] text-amber-950 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-100">
          <span className="font-semibold">Public preview {metadata.version}</span>
          <span className="min-w-0 flex-1 text-amber-800 dark:text-amber-100/80">
            This v0.x build may change quickly. macOS preview artifacts can be unsigned until signing is configured.
          </span>
          <button
            type="button"
            className="rounded border border-amber-600/30 px-2 py-1 text-[11px] text-amber-900 hover:bg-amber-200/50 dark:border-amber-300/30 dark:text-amber-50 dark:hover:bg-amber-200/10"
            onClick={() => {
              dismissPreview(metadata.version)
              setPreviewNoticeDismissed(true)
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {runtimeWasReady && runtimeError ? (
        <RuntimeOfflineBanner error={runtimeError} onRestart={handleRuntimeRestart} />
      ) : null}
      <div className="flex flex-1 min-h-0">
        {!sidebarCollapsed && (
          <Sidebar
            currentView={view}
            onViewChange={setView}
            searchRequestNonce={sidebarSearchNonce}
            settingsRequestNonce={sidebarSettingsNonce}
            branding={config.branding.sidebar}
          />
        )}
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          <ViewErrorBoundary resetKey={view} onBackHome={() => setView('home')}>
            {view === 'home' && (
              <HomePage
                brandName={config.branding.name}
                homeBranding={config.branding.home}
                onStartThread={startThreadFromHome}
                onOpenPulse={() => setView('pulse')}
                onOpenThread={(sessionId) => void openExistingThread(sessionId)}
              />
            )}
            {view === 'chat' && (
              <Suspense fallback={null}>
                <ChatView />
              </Suspense>
            )}
            {view === 'automations' && (
              <Suspense fallback={null}>
                <AutomationsPage onOpenThread={(sessionId) => void openExistingThread(sessionId)} />
              </Suspense>
            )}
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
            {view === 'pulse' && (
              <Suspense fallback={null}>
                <PulsePage onOpenThread={() => setView('chat')} brandName={config.branding.name} />
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
            onOpenSettings={openSidebarSettings}
            onToggleSearch={openSidebarSearch}
          />
        </Suspense>
      )}
    </div>
  )
}
