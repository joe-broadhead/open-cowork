import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { ProviderDescriptor } from '@open-cowork/shared'
import { LoginScreen } from './LoginScreen'
import { ApprovalCard } from './chat/ApprovalCard'
import { ChatInput } from './chat/ChatInput'
import { CommandPalette } from './CommandPalette'
import { HomePage } from './HomePage'
import { SetupScreen } from './SetupScreen'
import { useSessionStore } from '../stores/session'
import type { PendingApproval } from '../stores/session'
import { SettingsPanel } from './sidebar/SettingsPanel'
import { configureI18n } from '../helpers/i18n'
import { installRendererTestCoworkApi } from '../test/setup'
import { useWorkspaceSupportStore, WORKSPACE_SUPPORT_APIS } from '../stores/workspace-support'

async function expectNoA11yViolations(container: HTMLElement) {
  const result = await axe(container, {
    rules: {
      'color-contrast': { enabled: true },
    },
  })
  expect(result.violations).toEqual([])
}

afterEach(async () => {
  await configureI18n({ locale: 'en' })
})

const approval: PendingApproval = {
  id: 'permission-1',
  sessionId: 'session-1',
  tool: 'gmail_send_email',
  input: {
    to: 'user@example.com',
    subject: 'Launch notes',
  },
  description: 'Send a message',
  order: 0,
}

describe('focused accessibility smoke', () => {
  it('keeps the login screen structurally accessible', async () => {
    const { container } = render(<LoginScreen brandName="Open Cowork" onLoggedIn={() => undefined} />)

    expect(screen.getByRole('heading', { name: 'Open Cowork' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps approval cards structurally accessible', async () => {
    const { container } = render(<ApprovalCard approval={approval} />)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps the home shell structurally accessible (landmarks, contrast)', async () => {
    useSessionStore.getState().setActiveWorkspace('local')
    useSessionStore.getState().setSessions([])
    useSessionStore.getState().setCurrentSession(null)

    const { container } = render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={vi.fn(async () => undefined)}
        onOpenThread={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    await expectNoA11yViolations(container)
  })

  it('keeps the settings shell structurally accessible', async () => {
    const { container } = render(<SettingsPanel onClose={() => undefined} />)

    expect(await screen.findByText('Settings')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps the settings shell accessible when the active locale is RTL', async () => {
    await configureI18n({ locale: 'ar' })

    const { container } = render(<SettingsPanel onClose={() => undefined} />)

    expect(document.documentElement).toHaveAttribute('lang', 'ar')
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    expect(await screen.findByText('الإعدادات')).toBeInTheDocument()
    // The language option's accessible name now carries the honest partial-
    // coverage suffix ("العربية — NN٪ مترجم"), so match the stable lead.
    expect(screen.getByRole('button', { name: /^اللغة: العربية/ })).toHaveTextContent('العربية')
    await expectNoA11yViolations(container)
  })

  it('keeps chat composer + in-thread approval structurally accessible', async () => {
    installRendererTestCoworkApi()
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {
        local: WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          supported: true,
          reason: null,
          policyCode: null,
        })),
      },
      loadedByWorkspace: { local: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    useSessionStore.setState(useSessionStore.getInitialState(), true)
    useSessionStore.getState().setSessions([{
      id: 'session-1',
      title: 'Session 1',
      directory: '/tmp/project',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    }])
    useSessionStore.getState().setCurrentSession('session-1')

    const { container } = render(
      <div>
        <ApprovalCard approval={approval} />
        <ChatInput />
      </div>,
    )

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps Setup (provider → model path) structurally accessible', async () => {
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => ({
          selectedProviderId: 'openrouter',
          selectedModelId: 'anthropic/claude-sonnet-4',
          providerCredentials: {},
          integrationCredentials: {},
          integrationEnabled: {},
          bashPermission: 'ask',
          fileWritePermission: 'ask',
          webPermission: 'allow',
          webSearchEnabled: true,
          taskPermission: 'allow',
          externalDirectoryPermission: 'ask',
          mcpPermission: 'ask',
          requireApprovalBeforeSending: true,
          notificationVoiceReplies: false,
          notificationSmartSuggestions: false,
          notificationDailyDigest: false,
          notificationSounds: true,
          privacyKeepConversationHistory: true,
          privacyShareAnonymizedUsage: false,
          runtimeToolingBridgeEnabled: true,
          windowZoomFactor: 1,
          workflowLaunchAtLogin: false,
          workflowRunInBackground: false,
          workflowDesktopNotifications: true,
          workflowQuietHoursStart: null,
          workflowQuietHoursEnd: null,
          effectiveProviderId: 'openrouter',
          effectiveModel: 'anthropic/claude-sonnet-4',
        })),
        getProviderCredentials: vi.fn(async () => ({})),
      },
    })

    const providers: ProviderDescriptor[] = [{
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'OpenRouter models',
      connected: false,
      credentials: [{
        key: 'apiKey',
        label: 'API key',
        description: 'OpenRouter API key',
        placeholder: 'sk-or-...',
        secret: true,
        required: true,
      }],
      models: [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' }],
      defaultModel: 'anthropic/claude-sonnet-4',
    }]

    const { container } = render(
      <SetupScreen
        brandName="Open Cowork"
        providers={providers}
        defaultProviderId="openrouter"
        defaultModelId="anthropic/claude-sonnet-4"
        onComplete={() => undefined}
      />,
    )

    expect(await screen.findByRole('heading', { name: /Welcome/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps the command palette structurally accessible', async () => {
    installRendererTestCoworkApi()
    useSessionStore.setState(useSessionStore.getInitialState(), true)

    const { container } = render(
      <CommandPalette
        onClose={() => undefined}
        onNavigate={() => undefined}
        onCreateThread={async () => null}
        onEnsureSession={async () => true}
        onInsertComposer={() => undefined}
        onSetAgentMode={() => undefined}
        onStartAgentChat={() => undefined}
        onOpenSettings={() => undefined}
        onToggleSearch={() => undefined}
      />,
    )

    expect(screen.getByRole('searchbox', { name: 'Search command palette' })).toBeInTheDocument()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })
})
