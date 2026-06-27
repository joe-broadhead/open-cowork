import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { flushSync } from 'react-dom'
import type { AppMetadata, CustomAgentConfig, DesktopFeatureKey, EffectiveAppSettings, PublicAppConfig, SessionInfo, SessionPromptOptions } from '@open-cowork/shared'
import { isDesktopFeatureEnabled } from '@open-cowork/shared'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { StatusBar } from './components/layout/StatusBar'
import { ViewErrorBoundary } from './components/layout/ViewErrorBoundary'
import { RuntimeOfflineBanner } from './components/layout/RuntimeOfflineBanner'
import { Toaster } from './components/ui/Toaster'
import { Button } from './components/ui'
import { LoginScreen } from './components/LoginScreen'
import { LoadingScreen } from './components/LoadingScreen'
import { SetupScreen } from './components/SetupScreen'
import { HomePage } from './components/HomePage'
import { normalizeAppView, type AppNavigationTarget, type AppView } from './app-types'

const ChatView = lazy(() => import('./components/chat/ChatView').then((m) => ({ default: m.ChatView })))
const ProjectsBoardPage = lazy(() => import('./components/projects/ProjectsBoardPage').then((m) => ({ default: m.ProjectsBoardPage })))
const KnowledgePage = lazy(() => import('./components/studio/KnowledgePage').then((m) => ({ default: m.KnowledgePage })))
const WorkflowsPage = lazy(() => import('./components/workflows/WorkflowsPage').then((m) => ({ default: m.WorkflowsPage })))
const AgentsPage = lazy(() => import('./components/agents/AgentsPage').then((m) => ({ default: m.AgentsPage })))
const CapabilitiesPage = lazy(() => import('./components/capabilities/CapabilitiesPage').then((m) => ({ default: m.CapabilitiesPage })))
const HealthCenterPage = lazy(() => import('./components/health/HealthCenterPage').then((m) => ({ default: m.HealthCenterPage })))
const StudioApprovalsPage = lazy(() => import('./components/studio/StudioUtilityPages').then((m) => ({ default: m.StudioApprovalsPage })))
const StudioArtifactsPage = lazy(() => import('./components/studio/StudioUtilityPages').then((m) => ({ default: m.StudioArtifactsPage })))
const StudioChannelsPage = lazy(() => import('./components/studio/StudioUtilityPages').then((m) => ({ default: m.StudioChannelsPage })))
const PrimitiveGallery = lazy(() => import('./components/ui/PrimitiveGallery').then((m) => ({ default: m.PrimitiveGallery })))
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
import { useSessionStore } from './stores/session'
import { useOpenCodeEvents } from './hooks/useOpenCodeEvents'
import { useAppGlobalEvents } from './hooks/useAppGlobalEvents'
import { useRendererErrorNotice } from './hooks/useRendererErrorNotice'
import { useRuntimeHealth } from './hooks/useRuntimeHealth'
import { loadSessionMessages } from './helpers/loadSessionMessages'
import { setBrandName, setDocsBaseUrl } from './helpers/brand'
import { configureI18n, subscribeLocale, t } from './helpers/i18n'
import { registerExtraThemes, setDefaultThemeId } from './helpers/theme-presets'
import { applyAppearancePreferences } from './helpers/theme'
import { registerExtraStarterTemplates } from './components/agents/starter-templates'
import { supportAllows, supportEntry, useWorkspaceSupportStore } from './stores/workspace-support'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from './stores/session-workspace-keys'
import {
  parseResourceNavigationEventDetail,
  resolveDesktopResourceNavigationAction,
  type ResourceNavigationAction,
} from './resource-navigation'

type AgentBuilderSeed = Partial<CustomAgentConfig> | null

const UI_PRIMITIVES_HASH = '#/ui-primitives'
// The primitive gallery is an internal visual-QA surface; only expose it in dev
// builds so it never ships as a reachable route in production.
const UI_PRIMITIVES_ENABLED = import.meta.env.DEV

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

function canUseViewTransition() {
  return Boolean(
    (document as ViewTransitionDocument).startViewTransition
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}

function initialAppView(): AppView {
  if (UI_PRIMITIVES_ENABLED && typeof window !== 'undefined' && window.location.hash === UI_PRIMITIVES_HASH) return 'ui-primitives'
  return 'home'
}

type ResourceNavigationNotice = {
  status: ResourceNavigationAction['status'] | 'invalid'
  message: string
}

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

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function errorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined
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
  const setActiveWorkspace = useSessionStore((s) => s.setActiveWorkspace)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setSessions = useSessionStore((s) => s.setSessions)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [metadata, setMetadata] = useState<AppMetadata | null>(null)
  const [previewNoticeDismissed, setPreviewNoticeDismissed] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [view, setView] = useState<AppView>(initialAppView)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [agentBuilderSeed, setAgentBuilderSeed] = useState<AgentBuilderSeed>(null)
  const [pendingComposerInsert, setPendingComposerInsert] = useState<string | null>(null)
  const [sidebarSearchNonce, setSidebarSearchNonce] = useState(0)
  const [sidebarSettingsNonce, setSidebarSettingsNonce] = useState(0)
  const [resourceNavigationNotice, setResourceNavigationNotice] = useState<ResourceNavigationNotice | null>(null)
  // Force the whole tree to re-render when the active locale changes.
  // Every `t(key, fallback)` is resolved at render time from the i18n
  // module's module-level cache, so bumping this counter is enough to
  // flush stale English strings from memoized components without a
  // page reload (which would collapse the Settings panel mid-edit).
  const [localeVersion, setLocaleVersion] = useState(0)
  useEffect(() => subscribeLocale(() => setLocaleVersion((n) => n + 1)), [])
  const navigateView = useCallback((target: AppNavigationTarget) => {
    const nextView = normalizeAppView(target)
    if (!nextView || nextView === 'settings') return
    // Block navigating to a product area this deployment has disabled (defence in depth
    // behind the sidebar already hiding it). Non-gated views are never in `features`, so
    // isDesktopFeatureEnabled returns true for them.
    if (!isDesktopFeatureEnabled(config?.features, nextView as DesktopFeatureKey)) return
    const apply = () => setView(nextView)
    if (canUseViewTransition()) {
      ;(document as ViewTransitionDocument).startViewTransition?.(() => {
        flushSync(apply)
      })
      return
    }
    apply()
  }, [config?.features])
  useOpenCodeEvents()
  const [rendererErrorNotice, setRendererErrorNotice] = useRendererErrorNotice()
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)
  const workspaceActivationGenerationRef = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 860px)')
    const collapseForNarrowWindow = () => {
      if (!media.matches) return
      const state = useSessionStore.getState()
      if (!state.sidebarCollapsed) state.toggleSidebar()
    }
    collapseForNarrowWindow()
    media.addEventListener('change', collapseForNarrowWindow)
    return () => media.removeEventListener('change', collapseForNarrowWindow)
  }, [])

  const reportAppError = useCallback((notice: string, error: unknown, viewName = 'app') => {
    setRendererErrorNotice(notice)
    try {
      window.coworkApi?.diagnostics?.reportRendererError?.({
        message: `${notice}: ${describeError(error)}`,
        stack: errorStack(error),
        view: viewName,
      })
    } catch {
      // Diagnostics reporting must not become another renderer failure.
    }
  }, [setRendererErrorNotice])

  const loadSessions = useCallback(async () => {
    const workspaceId = normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId)
    try {
      if (workspaceId !== LOCAL_WORKSPACE_ID) {
        const support = await useWorkspaceSupportStore.getState().loadWorkspaceSupport(workspaceId)
        const listSupport = supportEntry(support, 'sessions.list')
        if (!listSupport || !supportAllows(listSupport)) {
          if (normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId) === workspaceId) setSessions([])
          return
        }
      }
      const sessions = workspaceId === LOCAL_WORKSPACE_ID
        ? await window.coworkApi.session.list()
        : await window.coworkApi.session.list({ workspaceId })
      if (normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId) === workspaceId) {
        setSessions(sessions || [])
      }
    } catch (err) {
      reportAppError('Could not load your projects. Try refreshing the app.', err, 'sessions')
    }
  }, [reportAppError, setSessions])

  const {
    runtimeReady,
    runtimeWasReady,
    runtimeError,
    refreshRuntimeState,
    handleRuntimeRestart,
  } = useRuntimeHealth(loadSessions, reportAppError)

  const createAndActivateSession = useCallback(async (directory?: string, options?: SessionPromptOptions): Promise<SessionInfo | null> => {
    try {
      const workspaceOptions = options?.workspaceId ? { workspaceId: options.workspaceId } : undefined
      const session = workspaceOptions
        ? await window.coworkApi.session.create(directory, workspaceOptions)
        : await window.coworkApi.session.create(directory)
      addSession(session)
      setCurrentSession(session.id)
      if (workspaceOptions) {
        await window.coworkApi.session.activate(session.id, workspaceOptions)
      } else {
        await window.coworkApi.session.activate(session.id)
      }
      navigateView('chat')
      return session
    } catch (err) {
      reportAppError('Could not create a new project chat. Try again.', err, 'session-create')
      return null
    }
  }, [addSession, navigateView, reportAppError, setCurrentSession])

  const openExistingThread = useCallback(async (sessionId: string, workspaceId?: string) => {
    navigateView('chat')
    if (workspaceId) {
      await loadSessionMessages(sessionId, { workspaceId })
    } else {
      await loadSessionMessages(sessionId)
    }
  }, [navigateView])

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

  const activateExactWorkspace = useCallback(async (workspaceId: string) => {
    const generation = workspaceActivationGenerationRef.current + 1
    workspaceActivationGenerationRef.current = generation
    const isCurrentActivation = () => workspaceActivationGenerationRef.current === generation
    const normalized = normalizeWorkspaceId(workspaceId)
    const activated = await window.coworkApi.workspace.activate(normalized)
    if (!isCurrentActivation()) return null
    const activeId = normalizeWorkspaceId(activated?.id || normalized)
    setActiveWorkspace(activeId)
    await useWorkspaceSupportStore.getState().loadWorkspaceSupport(activeId, { force: true })
    if (!isCurrentActivation()) return null
    await loadSessions()
    if (!isCurrentActivation()) return null
    return activeId
  }, [loadSessions, setActiveWorkspace])

  const applyResourceNavigationAction = useCallback(async (action: ResourceNavigationAction) => {
    if (action.status !== 'open') {
      setResourceNavigationNotice({
        status: action.status,
        message: action.message || 'Resource is not available in this Open Cowork surface.',
      })
      return
    }

    const workspaceId = action.routeParams.workspaceId
    if (workspaceId) {
      const activeId = await activateExactWorkspace(workspaceId)
      if (!activeId) return
    }

    setResourceNavigationNotice(null)

    if (action.routeKey === 'workspace') {
      navigateView('home')
      return
    }

    if (action.routeKey === 'session' || action.routeKey === 'artifact') {
      const sessionId = action.routeParams.sessionId
      if (sessionId) await openExistingThread(sessionId, workspaceId)
      return
    }

    if (action.routeKey === 'workflow' || action.routeKey === 'workflow-run') {
      navigateView('playbooks')
      return
    }

    if (action.routeKey === 'settings') {
      openSidebarSettings()
      return
    }

    if (action.routeKey === 'diagnostics') {
      navigateView('health')
      return
    }

    if (action.routeKey === 'capability') {
      navigateView('tools')
      return
    }

    setResourceNavigationNotice({
      status: 'unavailable',
      message: action.message || 'Exact navigation for this resource is not available yet.',
    })
  }, [activateExactWorkspace, navigateView, openExistingThread, openSidebarSettings])

  const openResourceNavigationTarget = useCallback(async (detail: unknown) => {
    try {
      const identity = parseResourceNavigationEventDetail(detail)
      const action = await resolveDesktopResourceNavigationAction(window.coworkApi, identity)
      await applyResourceNavigationAction(action)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setResourceNavigationNotice({
        status: 'invalid',
        message,
      })
      reportAppError('Could not open this Open Cowork link.', error, 'resource-navigation')
    }
  }, [applyResourceNavigationAction, reportAppError])

  // Home composer path: create + activate a fresh session, switch to the
  // chat view, then fire the prompt straight at the runtime. We
  // deliberately skip the chat composer's state — the user already hit
  // send on Home and expects their message to be in flight, not waiting
  // for them to press send again.
  const startThreadFromHome = useCallback(async (
    text: string,
    attachments?: Array<{ mime: string; url: string; filename: string }>,
    agent?: string,
    options?: SessionPromptOptions,
  ) => {
    const session = await createAndActivateSession(undefined, options)
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
      const promptAgent = agent || useSessionStore.getState().agentMode
      if (options) {
        await window.coworkApi.session.prompt(session.id, promptText, files, promptAgent, options)
      } else {
        await window.coworkApi.session.prompt(session.id, promptText, files, promptAgent)
      }
    } catch (err) {
      reportAppError('Could not send the Home prompt. Try again from the thread.', err, 'home')
    }
  }, [createAndActivateSession, reportAppError])

  const ensureActiveSession = useCallback(async (): Promise<boolean> => {
    if (useSessionStore.getState().currentSessionId) return true
    const session = await createAndActivateSession()
    return !!session
  }, [createAndActivateSession])

  const testAgentInNewThread = useCallback(async (agentName: string, directory?: string | null) => {
    const trimmed = agentName.trim()
    if (!trimmed) return
    const session = await createAndActivateSession(directory || undefined)
    if (!session) return
    setPendingComposerInsert(`@${trimmed} `)
  }, [createAndActivateSession])

  const startPrimaryCustomAgentThread = useCallback(async (agentName: string, directory?: string | null) => {
    const trimmed = agentName.trim()
    if (!trimmed) return
    const activeWorkspaceId = normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId)
    if (activeWorkspaceId !== LOCAL_WORKSPACE_ID) {
      reportAppError(
        'Custom coworker chats currently start from Desktop Local only. Switch to the local workspace and try again.',
        new Error(`Cannot start local custom coworker "${trimmed}" in workspace "${activeWorkspaceId}".`),
        'agents',
      )
      return
    }
    let sessionId: string | null = null
    try {
      const session = await createAndActivateSession(directory || undefined)
      if (!session) return
      sessionId = session.id
      useSessionStore.getState().setSessionPrimaryAgent(session.id, trimmed)
      await window.coworkApi.session.setComposerPreferences(session.id, { agentName: trimmed })
      await window.coworkApi.session.prompt(
        session.id,
        'Introduce yourself and ask how you can help.',
        undefined,
        trimmed,
      )
    } catch (err) {
      if (sessionId) {
        useSessionStore.getState().setSessionPrimaryAgent(sessionId, null)
        void window.coworkApi.session.setComposerPreferences(sessionId, { agentName: null }).catch(() => undefined)
      }
      reportAppError('Could not start coworker chat. Try again from the thread.', err, 'agents')
    }
  }, [createAndActivateSession, reportAppError])

  useAppGlobalEvents({
    runtimeReady,
    view,
    currentSessionId,
    toggleSidebar,
    createAndActivateSession,
    openSidebarSearch,
    openSidebarSettings,
    setView: navigateView,
    setAuthenticated,
    setShowCommandPalette,
  })

  useEffect(() => {
    const listener = (event: Event) => {
      void openResourceNavigationTarget((event as CustomEvent).detail)
    }
    window.addEventListener('open-cowork:open-resource', listener)
    return () => window.removeEventListener('open-cowork:open-resource', listener)
  }, [openResourceNavigationTarget])

  useEffect(() => {
    const listener = () => {
      if (UI_PRIMITIVES_ENABLED && window.location.hash === UI_PRIMITIVES_HASH) navigateView('ui-primitives')
    }
    window.addEventListener('hashchange', listener)
    return () => window.removeEventListener('hashchange', listener)
  }, [navigateView])

  // If the current thread disappears while the chat view is active —
  // deleted from the sidebar, reset, or reverted to null by a runtime
  // error — bounce back to Home rather than rendering an empty chat.
  // ChatView returns null in that state, so without this nudge the
  // user would see a blank pane with no way back.
  useEffect(() => {
    if (view === 'chat' && !currentSessionId) {
      navigateView('home')
    }
  }, [currentSessionId, navigateView, view])

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

        setBootstrapError(null)
        setConfig(appConfig)
        setMetadata(appMetadata)
        setPreviewNoticeDismissed(previewDismissed(appMetadata.version))
        setBrandName(appConfig?.branding?.name)
        setDocsBaseUrl(appConfig?.branding?.docsBaseUrl)
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
        const message = 'Could not finish loading the app shell. Restart the app and try again.'
        setBootstrapError(message)
        reportAppError(message, err, 'bootstrap')
      } finally {
        if (!cancelled) setAuthChecked(true)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [loadSessions, reportAppError])

  useEffect(() => {
    if (!config || !authChecked) return
    if (config.auth.enabled && !authenticated) return
    if (needsSetup) return
    void refreshRuntimeState()
  }, [authChecked, authenticated, config, needsSetup, refreshRuntimeState])

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
      <>
        <LoadingScreen
          brandName={config?.branding.name || 'Cowork'}
          stage={(!authChecked ? 'boot' : !config ? 'config' : loadingStage || 'runtime') as 'boot' | 'auth' | 'config' | 'runtime'}
          errorMessage={bootstrapError || runtimeError}
          onRetry={runtimeError ? handleRuntimeRestart : null}
        />
        <Toaster />
      </>
    )
  }

  // Initial-boot failure: full LoadingScreen. Once we've successfully
  // reached runtime-ready at least once, drops are surfaced inline
  // via RuntimeOfflineBanner below so the user's chat context stays
  // visible while they retry.
  if (runtimeError && !runtimeWasReady) {
    return (
      <>
        <LoadingScreen
          brandName={config.branding.name}
          stage="runtime"
          errorMessage={runtimeError}
          onRetry={handleRuntimeRestart}
        />
        <Toaster />
      </>
    )
  }

  if (config.auth.enabled && !authenticated) {
    return (
      <>
        <LoginScreen
          brandName={config.branding.name}
          onLoggedIn={(email) => {
            setAuthenticated(true)
            setUserEmail(email)
            window.coworkApi.settings.get().then((settings) => {
              setNeedsSetup(!isSetupComplete(settings, config))
              if (isSetupComplete(settings, config)) void refreshRuntimeState()
            }).catch((err) => reportAppError('Could not load settings after sign-in. Try again.', err, 'login'))
          }}
        />
        <Toaster />
      </>
    )
  }

  if (needsSetup) {
    return (
      <>
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
        <Toaster />
      </>
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
  const previewNoticeStyle = {
    borderColor: 'color-mix(in srgb, var(--color-amber) 34%, var(--color-border-subtle))',
    background: 'color-mix(in srgb, var(--color-amber) 10%, var(--color-surface))',
    color: 'var(--color-text)',
  }
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-base">
      <TitleBar view={view} />
      {showPreviewNotice && metadata ? (
        <div className="flex items-center gap-3 border-b px-4 py-2 text-xs" style={previewNoticeStyle}>
          <span className="font-semibold">Public preview {metadata.version}</span>
          <span className="min-w-0 flex-1 text-text-muted">
            This v0.x build may change quickly. macOS preview artifacts can be unsigned until signing is configured.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dismissPreview(metadata.version)
              setPreviewNoticeDismissed(true)
            }}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {runtimeWasReady && runtimeError ? (
        <RuntimeOfflineBanner error={runtimeError} onRestart={handleRuntimeRestart} />
      ) : null}
      {rendererErrorNotice ? (
        <div role="alert" className="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-xs text-red shadow-card">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">App error</div>
            <div className="mt-0.5 text-red/85">{rendererErrorNotice}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="no-drag"
            onClick={() => setRendererErrorNotice(null)}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      {resourceNavigationNotice ? (
        <div
          role="alert"
          data-testid="resource-navigation-notice"
          data-status={resourceNavigationNotice.status}
          className="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber shadow-card"
        >
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Resource unavailable</div>
            <div className="mt-0.5 text-amber/85">{resourceNavigationNotice.message}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="no-drag"
            onClick={() => setResourceNavigationNotice(null)}
          >
            {t('common.dismiss', 'Dismiss')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-1 min-h-0">
        <Sidebar
          currentView={view}
          onViewChange={navigateView}
          searchRequestNonce={sidebarSearchNonce}
          settingsRequestNonce={sidebarSettingsNonce}
          branding={config.branding.sidebar}
          features={config.features}
          collapsed={sidebarCollapsed}
          onExpandSidebar={ensureSidebarVisible}
        />
        <main className="flex-1 flex flex-col min-h-0 min-w-0">
          <ViewErrorBoundary resetKey={view} onBackHome={() => navigateView('home')}>
            {view === 'home' && (
              <HomePage
                brandName={config.branding.name}
                homeBranding={config.branding.home}
                onStartThread={startThreadFromHome}
                onOpenThread={(sessionId) => void openExistingThread(sessionId)}
                onNavigate={navigateView}
              />
            )}
            {view === 'chat' && (
              <Suspense fallback={null}>
                <ChatView onNavigate={navigateView} />
              </Suspense>
            )}
            {view === 'projects' && (
              <Suspense fallback={null}>
                <ProjectsBoardPage onOpenThread={(sessionId) => void openExistingThread(sessionId)} />
              </Suspense>
            )}
            {view === 'knowledge' && (
              <Suspense fallback={null}>
                <KnowledgePage />
              </Suspense>
            )}
            {view === 'approvals' && (
              <Suspense fallback={null}>
                <StudioApprovalsPage onOpenChat={() => navigateView('chat')} onOpenHome={() => navigateView('home')} />
              </Suspense>
            )}
            {view === 'playbooks' && (
              <Suspense fallback={null}>
                <WorkflowsPage onOpenThread={(sessionId) => void openExistingThread(sessionId)} />
              </Suspense>
            )}
            {view === 'team' && (
              <Suspense fallback={null}>
                <AgentsPage
                  initialDraft={agentBuilderSeed}
                  onClearDraft={() => setAgentBuilderSeed(null)}
                  onClose={() => navigateView('chat')}
                  onOpenCapabilities={() => navigateView('tools')}
                  onTestAgent={(agentName, directory) => void testAgentInNewThread(agentName, directory)}
                  onStartAgentChat={(agentName, directory) => void startPrimaryCustomAgentThread(agentName, directory)}
                />
              </Suspense>
            )}
            {view === 'channels' && (
              <Suspense fallback={null}>
                <StudioChannelsPage onOpenSettings={openSidebarSettings} />
              </Suspense>
            )}
            {view === 'tools' && (
              <Suspense fallback={null}>
                <CapabilitiesPage
                  onClose={() => navigateView('chat')}
                  onCreateAgent={(seed) => {
                    setAgentBuilderSeed(seed)
                    navigateView('team')
                  }}
                />
              </Suspense>
            )}
            {view === 'artifacts' && (
              <Suspense fallback={null}>
                <StudioArtifactsPage onOpenChat={() => navigateView('chat')} />
              </Suspense>
            )}
            {view === 'health' && (
              <Suspense fallback={null}>
                <HealthCenterPage />
              </Suspense>
            )}
            {view === 'ui-primitives' && (
              <Suspense fallback={null}>
                <PrimitiveGallery />
              </Suspense>
            )}
          </ViewErrorBoundary>
        </main>
      </div>
      <StatusBar />
      {showCommandPalette && (
        <ViewErrorBoundary
          resetKey="command-palette"
          onBackHome={() => {
            setShowCommandPalette(false)
            navigateView('home')
          }}
        >
          <Suspense fallback={null}>
            <CommandPalette
              onClose={() => setShowCommandPalette(false)}
              onNavigate={navigateView}
              onCreateThread={createAndActivateSession}
              onEnsureSession={ensureActiveSession}
              onInsertComposer={(text) => {
                setPendingComposerInsert(text)
                navigateView('chat')
              }}
              onSetAgentMode={setAgentMode}
              onStartAgentChat={startPrimaryCustomAgentThread}
              onOpenSettings={openSidebarSettings}
              onToggleSearch={openSidebarSearch}
            />
          </Suspense>
        </ViewErrorBoundary>
      )}
      <Toaster />
    </div>
  )
}
