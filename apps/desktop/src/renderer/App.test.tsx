import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createResourceDeepLink,
  createResourceIdentity,
  workspaceApiSupportContextForAuthority,
  type AuthState,
  type EffectiveAppSettings,
  type PublicAppConfig,
  type RuntimeStatus,
  type SessionInfo,
  type WorkspaceApiSupport,
  type WorkspaceInfo,
} from '@open-cowork/shared'
import { useSessionStore } from './stores/session'
import type { PrimaryAgentMode } from './stores/session'
import { useWorkspaceSupportStore } from './stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from './stores/session-workspace-keys'
import { installRendererTestCoworkApi } from './test/setup'
import { App } from './App'
import type { AppNavigationTarget } from './app-types'

const mockLoadSessionMessages = vi.hoisted(() => vi.fn(async (_sessionId: string) => undefined))
const mockUseOpenCodeEvents = vi.hoisted(() => vi.fn())
const mockSetBrandName = vi.hoisted(() => vi.fn())
const mockConfigureI18n = vi.hoisted(() => vi.fn())
const mockSubscribeLocale = vi.hoisted(() => vi.fn(() => undefined))
const mockRegisterExtraThemes = vi.hoisted(() => vi.fn())
const mockSetDefaultThemeId = vi.hoisted(() => vi.fn())
const mockApplyAppearancePreferences = vi.hoisted(() => vi.fn())
const mockRegisterExtraStarterTemplates = vi.hoisted(() => vi.fn())

vi.mock('./hooks/useOpenCodeEvents', () => ({
  useOpenCodeEvents: mockUseOpenCodeEvents,
}))

vi.mock('./helpers/loadSessionMessages', () => ({
  loadSessionMessages: mockLoadSessionMessages,
}))

vi.mock('./helpers/brand', () => ({
  setBrandName: mockSetBrandName,
}))

vi.mock('./helpers/i18n', () => ({
  configureI18n: mockConfigureI18n,
  subscribeLocale: mockSubscribeLocale,
  useI18n: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

vi.mock('./helpers/theme-presets', () => ({
  registerExtraThemes: mockRegisterExtraThemes,
  setDefaultThemeId: mockSetDefaultThemeId,
}))

vi.mock('./helpers/theme', () => ({
  applyAppearancePreferences: mockApplyAppearancePreferences,
}))

vi.mock('./components/agents/starter-templates', () => ({
  registerExtraStarterTemplates: mockRegisterExtraStarterTemplates,
}))

vi.mock('./components/layout/TitleBar', () => ({
  TitleBar: () => <header data-testid="title-bar">Title bar</header>,
}))

vi.mock('./components/layout/StatusBar', () => ({
  StatusBar: () => <footer data-testid="status-bar">Status bar</footer>,
}))

vi.mock('./components/layout/ViewErrorBoundary', () => ({
  ViewErrorBoundary: ({ children }: { children: React.ReactNode }) => <section data-testid="view-boundary">{children}</section>,
}))

vi.mock('./components/layout/RuntimeOfflineBanner', () => ({
  RuntimeOfflineBanner: ({ error, onRestart }: { error: string; onRestart: () => void }) => (
    <div data-testid="runtime-offline">
      <span>{error}</span>
      <button type="button" onClick={onRestart}>Restart runtime</button>
    </div>
  ),
}))

vi.mock('./components/layout/Sidebar', () => ({
  Sidebar: ({
    currentView,
    onViewChange,
    searchRequestNonce,
    settingsRequestNonce,
  }: {
    currentView: string
    onViewChange: (view: AppNavigationTarget) => void
    searchRequestNonce: number
    settingsRequestNonce: number
  }) => (
    <aside
      data-testid="sidebar"
      data-view={currentView}
      data-search-nonce={searchRequestNonce}
      data-settings-nonce={settingsRequestNonce}
    >
      <button type="button" onClick={() => onViewChange('team')}>Sidebar team</button>
      <button type="button" onClick={() => onViewChange('playbooks')}>Sidebar playbooks</button>
    </aside>
  ),
}))

vi.mock('./components/LoadingScreen', () => ({
  LoadingScreen: ({ brandName, stage, errorMessage }: { brandName: string; stage: string; errorMessage?: string | null }) => (
    <div data-testid="loading-screen">
      {brandName} loading {stage}
      {errorMessage ? ` ${errorMessage}` : ''}
    </div>
  ),
}))

vi.mock('./components/LoginScreen', () => ({
  LoginScreen: ({ brandName, onLoggedIn }: { brandName: string; onLoggedIn: (email: string) => void }) => (
    <div data-testid="login-screen">
      <span>{brandName} login</span>
      <button type="button" onClick={() => onLoggedIn('joe@example.com')}>Finish login</button>
    </div>
  ),
}))

vi.mock('./components/SetupScreen', () => ({
  SetupScreen: ({ brandName, email, onComplete }: { brandName: string; email: string; onComplete: () => void }) => (
    <div data-testid="setup-screen">
      <span>{brandName} setup {email}</span>
      <button type="button" onClick={onComplete}>Complete setup</button>
    </div>
  ),
}))

vi.mock('./components/HomePage', () => ({
  HomePage: ({
    brandName,
    onStartThread,
    onOpenThread,
  }: {
    brandName: string
    onStartThread: (text: string, attachments?: Array<{ mime: string; url: string; filename: string }>, agent?: string) => void
    onOpenThread: (sessionId: string) => void
  }) => (
    <div data-testid="home-page">
      <span>{brandName} home</span>
      <button
        type="button"
        onClick={() => onStartThread('Summarize this', [{ mime: 'text/plain', url: 'data:text/plain;base64,abc', filename: 'note.txt' }])}
      >
        Start from home
      </button>
      <button type="button" onClick={() => onOpenThread('existing-session')}>Open existing thread</button>
    </div>
  ),
}))

vi.mock('./components/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat-view">Chat view</div>,
}))

vi.mock('./components/workflows/WorkflowsPage', () => ({
  WorkflowsPage: ({ onOpenThread }: { onOpenThread: (sessionId: string) => void }) => (
    <div data-testid="workflows-page">
      <button type="button" onClick={() => onOpenThread('workflow-session')}>Open workflow thread</button>
    </div>
  ),
}))

vi.mock('./components/agents/AgentsPage', () => ({
  AgentsPage: ({ onClose, onOpenCapabilities }: { onClose: () => void; onOpenCapabilities: () => void }) => (
    <div data-testid="agents-page">
      <button type="button" onClick={onClose}>Close agents</button>
      <button type="button" onClick={onOpenCapabilities}>Open capabilities</button>
    </div>
  ),
}))

vi.mock('./components/capabilities/CapabilitiesPage', () => ({
  CapabilitiesPage: ({
    onClose,
    onCreateAgent,
  }: {
    onClose: () => void
    onCreateAgent: (seed: { name: string }) => void
  }) => (
    <div data-testid="capabilities-page">
      <button type="button" onClick={onClose}>Close capabilities</button>
      <button type="button" onClick={() => onCreateAgent({ name: 'Seeded agent' })}>Create agent from capability</button>
    </div>
  ),
}))

vi.mock('./components/health/HealthCenterPage', () => ({
  HealthCenterPage: () => <div data-testid="health-page">Health Center</div>,
}))

vi.mock('./components/CommandPalette', () => ({
  CommandPalette: ({
    onClose,
    onNavigate,
    onCreateThread,
    onEnsureSession,
    onInsertComposer,
    onSetAgentMode,
    onOpenSettings,
    onToggleSearch,
  }: {
    onClose: () => void
    onNavigate: (view: AppNavigationTarget) => void
    onCreateThread: () => void
    onEnsureSession: () => Promise<boolean>
    onInsertComposer: (text: string) => void
    onSetAgentMode: (mode: PrimaryAgentMode) => void
    onOpenSettings: () => void
    onToggleSearch: () => void
  }) => (
    <div data-testid="command-palette">
      <button type="button" onClick={onClose}>Close palette</button>
      <button type="button" onClick={() => onNavigate('team')}>Palette team</button>
      <button type="button" onClick={() => void onCreateThread()}>Palette new thread</button>
      <button type="button" onClick={() => void onEnsureSession()}>Palette ensure session</button>
      <button type="button" onClick={() => onInsertComposer('Inserted prompt')}>Palette insert</button>
      <button type="button" onClick={() => onSetAgentMode('plan')}>Palette plan mode</button>
      <button type="button" onClick={onOpenSettings}>Palette settings</button>
      <button type="button" onClick={onToggleSearch}>Palette search</button>
    </div>
  ),
}))

type AppListeners = {
  menuAction?: (action: string) => void
  menuNavigate?: (view: string) => void
  runtimeReady?: () => void
}

const completeSettings: EffectiveAppSettings = {
  selectedProviderId: 'openrouter',
  selectedModelId: 'anthropic/claude-sonnet-4',
  providerCredentials: {
    openrouter: {
      apiKey: 'sk-test',
    },
  },
  integrationCredentials: {},
  integrationEnabled: {},
  bashPermission: 'deny',
  fileWritePermission: 'deny',
  enableBash: false,
  enableFileWrite: false,
  runtimeToolingBridgeEnabled: true,
  workflowLaunchAtLogin: false,
  workflowRunInBackground: false,
  workflowDesktopNotifications: true,
  workflowQuietHoursStart: null,
  workflowQuietHoursEnd: null,
  effectiveProviderId: 'openrouter',
  effectiveModel: 'anthropic/claude-sonnet-4',
}

const config: PublicAppConfig = {
  branding: {
    name: 'Open Cowork',
    appId: 'com.opencowork.desktop',
    dataDirName: 'Open Cowork',
    helpUrl: 'https://github.com/joe-broadhead/open-cowork',
    defaultTheme: 'system',
    themes: [],
    sidebar: {},
    home: {},
  },
  auth: {
    mode: 'none',
    enabled: false,
  },
  providers: {
    defaultProvider: 'openrouter',
    defaultModel: 'anthropic/claude-sonnet-4',
    available: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        description: 'OpenRouter models',
        credentials: [
          {
            key: 'apiKey',
            label: 'API key',
            description: 'OpenRouter API key',
            placeholder: 'sk-or-...',
            secret: true,
            required: true,
          },
        ],
        models: [
          { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
        ],
      },
    ],
  },
  permissions: {
    bash: 'allow',
    fileWrite: 'allow',
  },
  agentStarterTemplates: [],
  i18n: {
    locale: 'en-US',
    strings: {},
  },
}

const readyRuntime: RuntimeStatus = {
  ready: true,
}

const newSession: SessionInfo = {
  id: 'new-session',
  title: 'New thread',
  directory: '/tmp/project',
  createdAt: '2026-05-07T00:00:00.000Z',
  updatedAt: '2026-05-07T00:00:00.000Z',
}

function resourceEvent(identity: ReturnType<typeof createResourceIdentity>) {
  return new CustomEvent('open-cowork:open-resource', {
    detail: {
      deepLink: createResourceDeepLink(identity),
    },
  })
}

function resetSessionStore() {
  useSessionStore.setState({
    activeWorkspaceId: LOCAL_WORKSPACE_ID,
    sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: [] },
    sessions: [],
    currentSessionId: null,
    globalErrors: [],
    mcpConnections: [],
    totalCost: 0,
    sidebarCollapsed: false,
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
  const localSupport = useWorkspaceSupportStore.getState().supportByWorkspace[LOCAL_WORKSPACE_ID] || []
  useWorkspaceSupportStore.setState({
    supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport },
    loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true },
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
}

function installAppApi(options: {
  appConfig?: PublicAppConfig
  authState?: AuthState
  settings?: EffectiveAppSettings
  metadata?: { version: string; preview: boolean }
  runtimeStatuses?: RuntimeStatus[]
} = {}) {
  const listeners: AppListeners = {}
  const runtimeStatuses = [...(options.runtimeStatuses || [readyRuntime])]
  const runtimeStatus = vi.fn(async () => runtimeStatuses.shift() || readyRuntime)
  const api = installRendererTestCoworkApi({
    app: {
      config: vi.fn(async () => options.appConfig || config),
      metadata: vi.fn(async () => options.metadata || { version: '0.0.0', preview: true }),
    },
    auth: {
      status: vi.fn(async () => options.authState || { authenticated: true, email: 'joe@example.com' }),
      login: vi.fn(async () => ({ authenticated: true, email: 'joe@example.com' })),
      logout: vi.fn(async () => ({ authenticated: false, email: null })),
    },
    settings: {
      get: vi.fn(async () => options.settings || completeSettings),
      set: vi.fn(async (updates) => ({ ...completeSettings, ...updates })),
      getProviderCredentials: vi.fn(async () => completeSettings.providerCredentials.openrouter || {}),
      getIntegrationCredentials: vi.fn(async () => ({})),
    },
    runtime: {
      status: runtimeStatus,
      restart: vi.fn(async () => readyRuntime),
    },
    session: {
      list: vi.fn(async () => [
        {
          id: 'existing-session',
          title: 'Existing thread',
          directory: '/tmp/project',
          createdAt: '2026-05-06T00:00:00.000Z',
          updatedAt: '2026-05-06T00:00:00.000Z',
        },
      ]),
      create: vi.fn(async () => newSession),
      activate: vi.fn(async () => ({})),
      prompt: vi.fn(async () => undefined),
      revert: vi.fn(async () => true),
      unrevert: vi.fn(async () => true),
      export: vi.fn(async () => '# Exported thread'),
    },
    diagnostics: {
      reportRendererError: vi.fn(),
    },
    on: {
      menuAction: vi.fn((callback: (action: string) => void) => {
        listeners.menuAction = callback
        return vi.fn()
      }),
      menuNavigate: vi.fn((callback: (view: string) => void) => {
        listeners.menuNavigate = callback
        return vi.fn()
      }),
      runtimeReady: vi.fn((callback: () => void) => {
        listeners.runtimeReady = callback
        return vi.fn()
      }),
      sessionPatch: vi.fn(() => vi.fn()),
      notification: vi.fn(() => vi.fn()),
      sessionView: vi.fn(() => vi.fn()),
      permissionRequest: vi.fn(() => vi.fn()),
      mcpStatus: vi.fn(() => vi.fn()),
      authExpired: vi.fn(() => vi.fn()),
      authLogout: vi.fn(() => vi.fn()),
      sessionUpdated: vi.fn(() => vi.fn()),
      sessionDeleted: vi.fn(() => vi.fn()),
      workflowUpdated: vi.fn(() => vi.fn()),
    },
  })
  return { api, listeners }
}

function installMatchMedia(matchesInitial: boolean) {
  let matches = matchesInitial
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mediaQueryList = {
    media: '(max-width: 860px)',
    get matches() {
      return matches
    },
    onchange: null,
    addEventListener: vi.fn((event: string, callback: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.add(callback)
    }),
    removeEventListener: vi.fn((event: string, callback: (event: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.delete(callback)
    }),
    addListener: vi.fn((callback: (event: MediaQueryListEvent) => void) => listeners.add(callback)),
    removeListener: vi.fn((callback: (event: MediaQueryListEvent) => void) => listeners.delete(callback)),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => mediaQueryList),
  })

  return {
    mediaQueryList,
    setMatches(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches, media: mediaQueryList.media } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: undefined,
  })
  resetSessionStore()
  mockLoadSessionMessages.mockImplementation(async (sessionId: string) => {
    useSessionStore.getState().setCurrentSession(sessionId)
  })
})

describe('App', () => {
  it('auto-collapses the sidebar below the narrow-window breakpoint', async () => {
    const matchMedia = installMatchMedia(true)
    installAppApi()

    render(<App />)

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    await waitFor(() => {
      expect(useSessionStore.getState().sidebarCollapsed).toBe(true)
    })

    act(() => {
      useSessionStore.getState().toggleSidebar()
    })
    expect(useSessionStore.getState().sidebarCollapsed).toBe(false)

    act(() => {
      matchMedia.setMatches(false)
    })
    expect(useSessionStore.getState().sidebarCollapsed).toBe(false)

    act(() => {
      matchMedia.setMatches(true)
    })
    expect(useSessionStore.getState().sidebarCollapsed).toBe(true)
    expect(matchMedia.mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('bootstraps the shell, applies config side effects, and reports renderer errors', async () => {
    const user = userEvent.setup()
    const { api } = installAppApi()

    render(<App />)

    expect(await screen.findByTestId('home-page')).toHaveTextContent('Open Cowork home')
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-view', 'home')
    expect(screen.getByText('Public preview 0.0.0')).toBeInTheDocument()
    expect(api.session.list).toHaveBeenCalled()
    expect(api.runtime.status).toHaveBeenCalled()
    expect(mockSetBrandName).toHaveBeenCalledWith('Open Cowork')
    expect(mockConfigureI18n).toHaveBeenCalledWith(config.i18n)
    expect(mockRegisterExtraThemes).toHaveBeenCalledWith([])
    expect(mockSetDefaultThemeId).toHaveBeenCalledWith('system')
    expect(mockRegisterExtraStarterTemplates).toHaveBeenCalledWith([])

    fireEvent(window, new ErrorEvent('error', { message: 'render failed', error: new Error('render failed') }))
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'render failed',
    }))
    const appError = screen.getByRole('alert')
    expect(appError).toHaveTextContent('App error')
    expect(appError).toHaveTextContent('render failed')
    await user.click(within(appError).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rejection, 'reason', { value: new Error('IPC failed') })
    fireEvent(window, rejection)
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'unhandled rejection: IPC failed',
    }))
    const rejectionAlert = screen.getByRole('alert')
    expect(rejectionAlert).toHaveTextContent('IPC failed')
    await user.click(within(rejectionAlert).getByRole('button', { name: 'Dismiss' }))

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Public preview 0.0.0')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('open-cowork.preview-dismissed.0.0.0')).toBe('true')
  })

  it('routes incomplete installs through setup and resumes runtime refresh after completion', async () => {
    const user = userEvent.setup()
    const { api } = installAppApi({
      settings: {
        ...completeSettings,
        providerCredentials: {},
      },
    })

    render(<App />)

    expect(await screen.findByTestId('setup-screen')).toHaveTextContent('Open Cowork setup joe@example.com')
    await user.click(screen.getByRole('button', { name: 'Complete setup' }))

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(api.runtime.status).toHaveBeenCalled()
  })

  it('routes authenticated apps through login before showing the workspace', async () => {
    const user = userEvent.setup()
    const authConfig: PublicAppConfig = {
      ...config,
      auth: {
        mode: 'google-oauth',
        enabled: true,
      },
    }
    const { api } = installAppApi({
      appConfig: authConfig,
      authState: {
        authenticated: false,
        email: null,
      },
    })

    render(<App />)

    expect(await screen.findByTestId('login-screen')).toHaveTextContent('Open Cowork login')
    await user.click(screen.getByRole('button', { name: 'Finish login' }))

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    expect(api.settings.get).toHaveBeenCalled()
    expect(api.runtime.status).toHaveBeenCalled()
  })

  it('mounts global error toasts outside the chat view', async () => {
    installAppApi()

    render(<App />)

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    act(() => {
      useSessionStore.getState().addGlobalError('Settings could not be saved.')
    })

    expect(await screen.findByRole('alert', { name: 'App error: Settings could not be saved.' })).toBeInTheDocument()
  })

  it('surfaces transient runtime status IPC failures without blocking the shell', async () => {
    const { api } = installAppApi()
    vi.mocked(api.runtime.status).mockRejectedValueOnce(new Error('ipc down'))

    render(<App />)

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Could not .*runtime status/)
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('ipc down'),
      view: 'runtime',
    }))
  })

  it('does not call session.list when the active workspace defers session listing', async () => {
    const support: WorkspaceApiSupport[] = [{
      api: 'sessions.list',
      status: 'deferred',
      verdict: {
        allowed: false,
        reason: 'Standalone Gateway session listing is deferred.',
      },
      context: workspaceApiSupportContextForAuthority('gateway_standalone', {
        surface: 'gateway_standalone',
        onlineState: 'auth_required',
        status: 'deferred',
      }),
    }]
    useSessionStore.setState({
      activeWorkspaceId: 'gateway:test',
      sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: [], 'gateway:test': [{ ...newSession, id: 'stale-gateway-session' }] },
      sessions: [{ ...newSession, id: 'stale-gateway-session' }],
    })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: useWorkspaceSupportStore.getState().supportByWorkspace[LOCAL_WORKSPACE_ID] || [], 'gateway:test': support },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true, 'gateway:test': true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    const { api } = installAppApi()
    vi.mocked(api.workspace.support).mockResolvedValue(support)

    render(<App />)

    expect(await screen.findByTestId('home-page')).toBeInTheDocument()
    await waitFor(() => expect(api.runtime.status).toHaveBeenCalled())
    expect(api.session.list).not.toHaveBeenCalled()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('creates and prompts a new session from the Home composer path', async () => {
    const user = userEvent.setup()
    const { api } = installAppApi()

    render(<App />)

    await screen.findByTestId('home-page')
    await user.click(screen.getByRole('button', { name: 'Start from home' }))

    await waitFor(() => expect(api.session.create).toHaveBeenCalledWith(undefined))
    expect(api.session.activate).toHaveBeenCalledWith('new-session')
    expect(api.session.prompt).toHaveBeenCalledWith('new-session', 'Summarize this', [
      {
        mime: 'text/plain',
        url: 'data:text/plain;base64,abc',
        filename: 'note.txt',
      },
    ], 'build')
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
  })

  it('surfaces recoverable Home prompt failures through the app error notice', async () => {
    const user = userEvent.setup()
    const { api } = installAppApi()
    vi.mocked(api.session.prompt).mockRejectedValueOnce(new Error('provider offline'))

    render(<App />)

    await screen.findByTestId('home-page')
    await user.click(screen.getByRole('button', { name: 'Start from home' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not send the Home prompt. Try again from the thread.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('provider offline'),
      view: 'home',
    }))
  })

  it('wires menu navigation, keyboard shortcuts, and command palette callbacks', async () => {
    const user = userEvent.setup()
    const { api, listeners } = installAppApi()

    render(<App />)
    await screen.findByTestId('home-page')

    act(() => listeners.menuNavigate?.('workflows'))
    expect(await screen.findByTestId('workflows-page')).toBeInTheDocument()

    act(() => listeners.menuNavigate?.('agents'))
    expect(await screen.findByTestId('agents-page')).toBeInTheDocument()

    act(() => listeners.menuNavigate?.('health'))
    expect(await screen.findByTestId('health-page')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('sidebar')).toHaveAttribute('data-search-nonce', '1'))

    act(() => listeners.menuAction?.('command-palette'))
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Palette settings' }))
    await waitFor(() => expect(screen.getByTestId('sidebar')).toHaveAttribute('data-settings-nonce', '1'))

    await user.click(screen.getByRole('button', { name: 'Palette team' }))
    expect(await screen.findByTestId('agents-page')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Palette ensure session' }))
    await waitFor(() => expect(api.session.create).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Palette insert' }))
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
    expect(api.session.create).toHaveBeenCalledTimes(1)

    act(() => listeners.menuAction?.('new-thread'))
    await waitFor(() => expect(api.session.create).toHaveBeenCalledTimes(2))
  })

  it('opens existing threads through the shared session loader', async () => {
    const user = userEvent.setup()
    installAppApi()

    render(<App />)

    await screen.findByTestId('home-page')
    await user.click(screen.getByRole('button', { name: 'Open existing thread' }))

    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
    expect(mockLoadSessionMessages).toHaveBeenCalledWith('existing-session')
  })

  it('opens exact local session resource links without falling back across workspaces', async () => {
    const { api } = installAppApi()
    vi.mocked(api.session.get).mockResolvedValueOnce({
      id: 'existing-session',
      title: 'Existing thread',
      directory: '/tmp/project',
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    })

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'desktop-local',
      kind: 'session',
      workspaceId: LOCAL_WORKSPACE_ID,
      sessionId: 'existing-session',
    })))

    await waitFor(() => expect(api.session.get).toHaveBeenCalledWith('existing-session', undefined))
    await waitFor(() => expect(mockLoadSessionMessages).toHaveBeenCalledWith('existing-session', { workspaceId: LOCAL_WORKSPACE_ID }))
    expect(api.workspace.activate).toHaveBeenCalledWith(LOCAL_WORKSPACE_ID)
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-navigation-notice')).not.toBeInTheDocument()
  })

  it('opens exact artifact resource links to the containing thread', async () => {
    const { api } = installAppApi()
    vi.mocked(api.artifact.list).mockResolvedValueOnce([{
      id: 'artifact-1',
      toolId: 'tool-1',
      toolName: 'chart',
      filename: 'chart.png',
      filePath: '/tmp/chart.png',
      order: 0,
      mime: 'image/png',
    }])

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'desktop-local',
      kind: 'artifact',
      workspaceId: LOCAL_WORKSPACE_ID,
      sessionId: 'existing-session',
      artifactId: 'artifact-1',
    })))

    await waitFor(() => expect(api.artifact.list).toHaveBeenCalledWith({ sessionId: 'existing-session' }))
    await waitFor(() => expect(mockLoadSessionMessages).toHaveBeenCalledWith('existing-session', { workspaceId: LOCAL_WORKSPACE_ID }))
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
    expect(screen.queryByTestId('resource-navigation-notice')).not.toBeInTheDocument()
  })

  it('opens exact cloud session resource links with workspace-scoped activation', async () => {
    const cloudWorkspace: WorkspaceInfo = {
      id: 'cloud:test',
      kind: 'cloud',
      authority: 'cloud_worker',
      label: 'Cloud Test',
      status: 'online',
      active: false,
      lastSyncedAt: null,
    }
    const { api } = installAppApi()
    vi.mocked(api.workspace.list).mockResolvedValue([{
      id: LOCAL_WORKSPACE_ID,
      kind: 'local',
      label: 'Local',
      status: 'online',
      active: true,
      lastSyncedAt: null,
    }, cloudWorkspace])
    vi.mocked(api.workspace.activate).mockResolvedValue({
      ...cloudWorkspace,
      active: true,
    })
    vi.mocked(api.workspace.support).mockResolvedValue([{
      api: 'sessions.list',
      status: 'deferred',
      verdict: { allowed: false, reason: 'Cloud listing is deferred.' },
      context: workspaceApiSupportContextForAuthority('cloud_worker', {
        surface: 'desktop_cloud',
        onlineState: 'online',
        status: 'deferred',
      }),
    }])
    vi.mocked(api.session.get).mockResolvedValueOnce({
      id: 'cloud-session',
      title: 'Cloud thread',
      directory: null,
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    })

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'desktop-cloud',
      kind: 'session',
      workspaceId: 'cloud:test',
      sessionId: 'cloud-session',
    })))

    await waitFor(() => expect(api.session.get).toHaveBeenCalledWith('cloud-session', { workspaceId: 'cloud:test' }))
    await waitFor(() => expect(mockLoadSessionMessages).toHaveBeenCalledWith('cloud-session', { workspaceId: 'cloud:test' }))
    expect(api.workspace.activate).toHaveBeenCalledWith('cloud:test')
    expect(useSessionStore.getState().activeWorkspaceId).toBe('cloud:test')
  })

  it('shows not-found state for missing resources without opening a stale thread', async () => {
    const { api } = installAppApi()
    vi.mocked(api.session.get).mockResolvedValueOnce(null)

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'desktop-local',
      kind: 'session',
      workspaceId: LOCAL_WORKSPACE_ID,
      sessionId: 'missing-session',
    })))

    const notice = await screen.findByTestId('resource-navigation-notice')
    expect(notice).toHaveAttribute('data-status', 'not-found')
    expect(notice).toHaveTextContent('missing-session')
    expect(mockLoadSessionMessages).not.toHaveBeenCalled()
  })

  it('refuses unsupported cloud-web deep links instead of falling back to Desktop Cloud', async () => {
    const cloudWorkspace: WorkspaceInfo = {
      id: 'cloud:test',
      kind: 'cloud',
      authority: 'cloud_worker',
      label: 'Cloud Test',
      status: 'online',
      active: false,
      lastSyncedAt: null,
    }
    const { api } = installAppApi()
    vi.mocked(api.workspace.list).mockResolvedValue([cloudWorkspace])

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'cloud-web',
      kind: 'session',
      workspaceId: 'cloud:test',
      sessionId: 'cloud-session',
    })))

    const notice = await screen.findByTestId('resource-navigation-notice')
    expect(notice).toHaveAttribute('data-status', 'unsupported-authority')
    expect(notice).toHaveTextContent('cloud-web')
    expect(api.workspace.activate).not.toHaveBeenCalled()
    expect(mockLoadSessionMessages).not.toHaveBeenCalled()
  })

  it('reports Gateway session resource links as unavailable while auth is pending', async () => {
    const gatewayWorkspace: WorkspaceInfo = {
      id: 'gateway:test',
      kind: 'gateway',
      authority: 'gateway_standalone',
      label: 'Gateway Test',
      status: 'auth_required',
      active: false,
      lastSyncedAt: null,
    }
    const { api } = installAppApi()
    vi.mocked(api.workspace.list).mockResolvedValue([gatewayWorkspace])

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'standalone-gateway',
      kind: 'session',
      workspaceId: 'gateway:test',
      sessionId: 'gateway-session',
    })))

    const notice = await screen.findByTestId('resource-navigation-notice')
    expect(notice).toHaveAttribute('data-status', 'unavailable')
    expect(notice).toHaveTextContent('auth required')
    expect(api.session.get).not.toHaveBeenCalledWith('gateway-session', expect.anything())
  })

  it('activates exact paired Desktop workspace links without rewriting authority', async () => {
    const pairedWorkspace: WorkspaceInfo = {
      id: 'paired-desktop:device-1',
      kind: 'paired_desktop',
      authority: 'desktop_paired',
      label: 'Paired Desktop',
      status: 'offline',
      active: false,
      lastSyncedAt: null,
    }
    const { api } = installAppApi()
    vi.mocked(api.workspace.list).mockResolvedValue([pairedWorkspace])
    vi.mocked(api.workspace.activate).mockResolvedValue({ ...pairedWorkspace, active: true })

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'paired-desktop',
      kind: 'workspace',
      workspaceId: 'paired-desktop:device-1',
    })))

    await waitFor(() => expect(api.workspace.activate).toHaveBeenCalledWith('paired-desktop:device-1'))
    expect(useSessionStore.getState().activeWorkspaceId).toBe('paired-desktop:device-1')
    expect(screen.queryByTestId('resource-navigation-notice')).not.toBeInTheDocument()
  })

  it('opens exact workflow-run resource links to the workflow surface', async () => {
    const { api } = installAppApi()
    vi.mocked(api.workflows.get).mockResolvedValueOnce({
      id: 'workflow-1',
      title: 'Workflow',
      instructions: 'Run it',
      agentName: 'build',
      skillNames: [],
      toolIds: [],
      status: 'active',
      projectDirectory: null,
      draftSessionId: null,
      triggers: [],
      createdAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      latestRunId: 'run-1',
      latestRunStatus: 'completed',
      latestRunSessionId: 'run-session',
      latestRunSummary: null,
      webhookUrl: null,
      runs: [{
        id: 'run-1',
        workflowId: 'workflow-1',
        sessionId: 'run-session',
        triggerType: 'manual',
        triggerPayload: null,
        status: 'completed',
        title: 'Run 1',
        summary: null,
        error: null,
        createdAt: '2026-05-06T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      }],
    })

    render(<App />)
    await screen.findByTestId('home-page')

    fireEvent(window, resourceEvent(createResourceIdentity({
      authority: 'desktop-local',
      kind: 'workflow-run',
      workspaceId: LOCAL_WORKSPACE_ID,
      workflowId: 'workflow-1',
      runId: 'run-1',
    })))

    await waitFor(() => expect(api.workflows.get).toHaveBeenCalledWith('workflow-1', undefined))
    expect(await screen.findByTestId('workflows-page')).toBeInTheDocument()
  })
})
