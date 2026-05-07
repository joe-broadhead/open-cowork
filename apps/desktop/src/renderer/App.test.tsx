import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthState, EffectiveAppSettings, PublicAppConfig, RuntimeStatus, SessionInfo } from '@open-cowork/shared'
import { useSessionStore } from './stores/session'
import { installRendererTestCoworkApi } from './test/setup'
import { App } from './App'

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
    onViewChange: (view: 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse') => void
    searchRequestNonce: number
    settingsRequestNonce: number
  }) => (
    <aside
      data-testid="sidebar"
      data-view={currentView}
      data-search-nonce={searchRequestNonce}
      data-settings-nonce={settingsRequestNonce}
    >
      <button type="button" onClick={() => onViewChange('agents')}>Sidebar agents</button>
      <button type="button" onClick={() => onViewChange('automations')}>Sidebar automations</button>
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
    onOpenPulse,
    onOpenThread,
  }: {
    brandName: string
    onStartThread: (text: string, attachments?: Array<{ mime: string; url: string; filename: string }>) => void
    onOpenPulse: () => void
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
      <button type="button" onClick={onOpenPulse}>Open pulse</button>
      <button type="button" onClick={() => onOpenThread('existing-session')}>Open existing thread</button>
    </div>
  ),
}))

vi.mock('./components/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat-view">Chat view</div>,
}))

vi.mock('./components/automations/AutomationsPage', () => ({
  AutomationsPage: ({ onOpenThread }: { onOpenThread: (sessionId: string) => void }) => (
    <div data-testid="automations-page">
      <button type="button" onClick={() => onOpenThread('automation-session')}>Open automation thread</button>
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

vi.mock('./components/PulsePage', () => ({
  PulsePage: ({ brandName, onOpenThread }: { brandName: string; onOpenThread: () => void }) => (
    <div data-testid="pulse-page">
      <span>{brandName} pulse</span>
      <button type="button" onClick={onOpenThread}>Open pulse thread</button>
    </div>
  ),
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
    onNavigate: (view: 'home' | 'chat' | 'automations' | 'agents' | 'capabilities' | 'pulse') => void
    onCreateThread: () => void
    onEnsureSession: () => Promise<boolean>
    onInsertComposer: (text: string) => void
    onSetAgentMode: (mode: 'build' | 'plan') => void
    onOpenSettings: () => void
    onToggleSearch: () => void
  }) => (
    <div data-testid="command-palette">
      <button type="button" onClick={onClose}>Close palette</button>
      <button type="button" onClick={() => onNavigate('agents')}>Palette agents</button>
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
  enableBash: false,
  enableFileWrite: false,
  runtimeToolingBridgeEnabled: true,
  automationLaunchAtLogin: false,
  automationRunInBackground: false,
  automationDesktopNotifications: true,
  automationQuietHoursStart: null,
  automationQuietHoursEnd: null,
  defaultAutomationAutonomyPolicy: 'review-first',
  defaultAutomationExecutionMode: 'scoped_execution',
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

function resetSessionStore() {
  useSessionStore.setState({
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
      dashboardSummaryUpdated: vi.fn(() => vi.fn()),
      sessionUpdated: vi.fn(() => vi.fn()),
      sessionDeleted: vi.fn(() => vi.fn()),
      automationUpdated: vi.fn(() => vi.fn()),
    },
  })
  return { api, listeners }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
  mockLoadSessionMessages.mockImplementation(async (sessionId: string) => {
    useSessionStore.getState().setCurrentSession(sessionId)
  })
})

describe('App', () => {
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
    ])
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
  })

  it('wires menu navigation, keyboard shortcuts, and command palette callbacks', async () => {
    const user = userEvent.setup()
    const { api, listeners } = installAppApi()

    render(<App />)
    await screen.findByTestId('home-page')

    act(() => listeners.menuNavigate?.('pulse'))
    expect(await screen.findByTestId('pulse-page')).toHaveTextContent('Open Cowork pulse')

    act(() => listeners.menuNavigate?.('agents'))
    expect(await screen.findByTestId('agents-page')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByTestId('sidebar')).toHaveAttribute('data-search-nonce', '1'))

    act(() => listeners.menuAction?.('command-palette'))
    expect(await screen.findByTestId('command-palette')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Palette settings' }))
    await waitFor(() => expect(screen.getByTestId('sidebar')).toHaveAttribute('data-settings-nonce', '1'))

    await user.click(screen.getByRole('button', { name: 'Palette agents' }))
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
})
