import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationListPayload,
  AutomationRun,
  AutomationSummary,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { AutomationsPage } from './AutomationsPage'

function automation(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: overrides.id || 'auto-1',
    title: overrides.title || 'Weekly report',
    goal: overrides.goal || 'Keep the weekly status report ready.',
    kind: overrides.kind || 'recurring',
    status: overrides.status || 'draft',
    schedule: overrides.schedule || {
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    },
    heartbeatMinutes: overrides.heartbeatMinutes ?? 15,
    retryPolicy: overrides.retryPolicy || {
      maxRetries: 3,
      baseDelayMinutes: 5,
      maxDelayMinutes: 60,
    },
    runPolicy: overrides.runPolicy || {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    },
    executionMode: overrides.executionMode || 'planning_only',
    autonomyPolicy: overrides.autonomyPolicy || 'review-first',
    projectDirectory: overrides.projectDirectory ?? '/work/project',
    preferredAgentNames: overrides.preferredAgentNames || ['researcher'],
    createdAt: overrides.createdAt || '2026-05-06T09:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-05-06T10:00:00.000Z',
    nextRunAt: overrides.nextRunAt ?? null,
    lastRunAt: overrides.lastRunAt ?? null,
    nextHeartbeatAt: overrides.nextHeartbeatAt ?? null,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    latestRunStatus: overrides.latestRunStatus ?? null,
    latestRunId: overrides.latestRunId ?? null,
  }
}

function detail(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  const summary = automation(overrides)
  return {
    ...summary,
    brief: overrides.brief ?? null,
    latestSessionId: overrides.latestSessionId ?? null,
    deliveries: overrides.deliveries ?? [],
  }
}

function payload(overrides: Partial<AutomationListPayload> = {}): AutomationListPayload {
  return {
    automations: [],
    inbox: [],
    workItems: [],
    runs: [],
    deliveries: [],
    ...overrides,
  }
}

function renderAutomationsPage(options: {
  initialPayload?: AutomationListPayload
  selectedDetail?: AutomationDetail
  createdAutomation?: AutomationDetail
  settingsGetError?: Error
  reportRendererError?: ReturnType<typeof vi.fn>
} = {}) {
  const currentPayload = options.initialPayload ?? payload({
    automations: [automation()],
  })
  const selectedDetail = options.selectedDetail ?? detail()
  const createdAutomation = options.createdAutomation ?? detail({
    id: 'auto-created',
    title: 'Created automation',
    goal: 'Created from the wizard.',
  })
  const list = vi.fn(async () => currentPayload)
  const get = vi.fn(async (automationId: string) => (
    automationId === createdAutomation.id ? createdAutomation : selectedDetail
  ))
  const create = vi.fn(async (_draft: AutomationDraft) => createdAutomation)
  const previewBrief = vi.fn(async () => selectedDetail)
  const runNow = vi.fn(async (): Promise<AutomationRun | null> => null)
  const unsubscribeAutomationUpdated = vi.fn()
  const automationUpdated = vi.fn(() => unsubscribeAutomationUpdated)
  const onOpenThread = vi.fn()
  const reportRendererError = options.reportRendererError || vi.fn()

  installRendererTestCoworkApi({
    automation: {
      list,
      get,
      create,
      update: vi.fn(async () => selectedDetail),
      pause: vi.fn(async () => selectedDetail),
      resume: vi.fn(async () => selectedDetail),
      archive: vi.fn(async () => selectedDetail),
      runNow,
      retryRun: vi.fn(async () => null),
      cancelRun: vi.fn(async () => true),
      previewBrief,
      approveBrief: vi.fn(async () => selectedDetail),
      inboxRespond: vi.fn(async () => true),
      inboxDismiss: vi.fn(async () => true),
    },
    app: {
      builtinAgents: vi.fn(async () => [
        {
          name: 'researcher',
          label: 'Researcher',
          source: 'open-cowork',
          mode: 'specialist',
          hidden: false,
          disabled: false,
          color: 'accent',
          description: 'Finds source material.',
          instructions: 'Research carefully.',
          skills: [],
          toolAccess: [],
          nativeToolIds: [],
          configuredToolIds: [],
          model: null,
          variant: null,
          temperature: null,
          top_p: null,
          steps: null,
          options: null,
        },
      ]),
    },
    agents: {
      list: vi.fn(async () => []),
    },
    diagnostics: {
      reportRendererError,
    },
    settings: {
      get: vi.fn(async () => {
        if (options.settingsGetError) throw options.settingsGetError
        return {
          selectedProviderId: null,
          selectedModelId: null,
          providerCredentials: {},
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
          defaultAutomationExecutionMode: 'planning_only',
          effectiveProviderId: null,
          effectiveModel: null,
        }
      }),
    },
    on: {
      automationUpdated,
    },
  })

  const view = render(<AutomationsPage onOpenThread={onOpenThread} />)

  return {
    list,
    get,
    create,
    previewBrief,
    automationUpdated,
    reportRendererError,
    unsubscribeAutomationUpdated,
    unmount: view.unmount,
    onOpenThread,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
})

describe('AutomationsPage', () => {
  it('surfaces automation default load failures through the chat error channel and diagnostics', async () => {
    const api = renderAutomationsPage({
      settingsGetError: new Error('settings unavailable'),
    })

    expect(await screen.findByRole('heading', { name: 'Always-on work' })).toBeInTheDocument()
    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not load automation defaults. New automations will use standard defaults.')
    })
    expect(api.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('settings unavailable'),
      view: 'automations',
    }))
  })

  it('loads the board, opens a card detail, runs preview, and cleans up the update listener', async () => {
    const user = userEvent.setup()
    const api = renderAutomationsPage()

    expect(await screen.findByRole('heading', { name: 'Always-on work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Weekly report/ })).toBeInTheDocument()
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.automationUpdated).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Weekly report/ }))
    expect(await screen.findByRole('dialog', { name: 'Weekly report' })).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('auto-1')

    await user.click(screen.getByRole('button', { name: 'Preview brief' }))
    await waitFor(() => expect(api.previewBrief).toHaveBeenCalledWith('auto-1'))
    expect(api.list).toHaveBeenCalledTimes(2)

    api.unmount()
    expect(api.unsubscribeAutomationUpdated).toHaveBeenCalledTimes(1)
  })

  it('creates an automation through the page-level wizard and refreshes the board', async () => {
    const user = userEvent.setup()
    const api = renderAutomationsPage({
      initialPayload: payload(),
    })

    await screen.findByRole('heading', { name: 'Turn repeatable work into a standing agent program' })
    await user.click(screen.getByRole('button', { name: 'New automation' }))

    await user.type(screen.getByLabelText('Title'), 'Weekly market review')
    await user.type(screen.getByLabelText('Goal'), 'Summarize market movement before the planning meeting.')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({
      title: 'Weekly market review',
      goal: 'Summarize market movement before the planning meeting.',
      schedule: expect.objectContaining({ type: 'weekly' }),
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    })
    expect(api.list).toHaveBeenCalledTimes(2)
  })
})
