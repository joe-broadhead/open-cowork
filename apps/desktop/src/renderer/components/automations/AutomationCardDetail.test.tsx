import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationInboxItem,
  AutomationRun,
  AutomationWorkItem,
  ExecutionBrief,
} from '@open-cowork/shared'
import { AutomationCardDetail } from './AutomationCardDetail'

type DetailProps = ComponentProps<typeof AutomationCardDetail>

function brief(overrides: Partial<ExecutionBrief> = {}): ExecutionBrief {
  return {
    version: 1,
    status: 'ready',
    goal: 'Keep the report ready.',
    deliverables: ['Report'],
    assumptions: ['Market data is available'],
    missingContext: [],
    successCriteria: ['Reviewed before Monday'],
    recommendedAgents: ['researcher'],
    workItems: [],
    approvalBoundary: 'Ask before execution.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: null,
    ...overrides,
  }
}

function automation(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: 'auto-1',
    title: 'Weekly report',
    goal: 'Prepare a weekly market report.',
    kind: 'recurring',
    status: 'ready',
    schedule: {
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    },
    heartbeatMinutes: 15,
    retryPolicy: {
      maxRetries: 3,
      baseDelayMinutes: 5,
      maxDelayMinutes: 60,
    },
    runPolicy: {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    },
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: null,
    preferredAgentNames: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextRunAt: null,
    lastRunAt: null,
    nextHeartbeatAt: null,
    lastHeartbeatAt: null,
    latestRunStatus: null,
    latestRunId: null,
    brief: brief({ approvedAt: '2026-01-01T00:30:00.000Z' }),
    latestSessionId: 'session-latest',
    deliveries: [],
    ...overrides,
  }
}

function inboxItem(overrides: Partial<AutomationInboxItem> = {}): AutomationInboxItem {
  return {
    id: 'inbox-1',
    automationId: 'auto-1',
    runId: 'run-1',
    sessionId: 'session-1',
    questionId: null,
    type: 'approval',
    status: 'open',
    title: 'Approve the brief',
    body: 'Review the proposed automation brief.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    sessionId: 'session-1',
    kind: 'execution',
    status: 'completed',
    title: 'Execute report',
    summary: 'Delivered the report.',
    error: null,
    failureCode: null,
    attempt: 1,
    retryOfRunId: null,
    nextRetryAt: null,
    createdAt: '2026-01-01T01:00:00.000Z',
    startedAt: '2026-01-01T01:00:00.000Z',
    finishedAt: '2026-01-01T01:30:00.000Z',
    ...overrides,
  }
}

function workItem(overrides: Partial<AutomationWorkItem> = {}): AutomationWorkItem {
  return {
    id: 'item-1',
    automationId: 'auto-1',
    runId: 'run-1',
    title: 'Draft report',
    description: 'Create the first report draft.',
    status: 'ready',
    blockingReason: null,
    ownerAgent: 'researcher',
    dependsOn: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function delivery(overrides: Partial<AutomationDeliveryRecord> = {}): AutomationDeliveryRecord {
  return {
    id: 'delivery-1',
    automationId: 'auto-1',
    runId: 'run-1',
    provider: 'in_app',
    target: 'automation-inbox',
    status: 'delivered',
    title: 'Report ready',
    body: 'The weekly report is ready.',
    createdAt: '2026-01-01T02:00:00.000Z',
    ...overrides,
  }
}

function renderDetail(overrides: Partial<DetailProps> = {}) {
  const props: DetailProps = {
    automation: automation(),
    inbox: [],
    workItems: [],
    runs: [],
    deliveries: [],
    agentOptions: [],
    onClose: vi.fn(),
    onOpenThread: vi.fn(),
    onPatch: vi.fn(async () => undefined),
    onPreviewBrief: vi.fn(async () => undefined),
    onApproveBrief: vi.fn(async () => undefined),
    onRunNow: vi.fn(async () => undefined),
    onPause: vi.fn(async () => undefined),
    onResume: vi.fn(async () => undefined),
    onArchive: vi.fn(async () => undefined),
    onCancelRun: vi.fn(async () => undefined),
    onRetryRun: vi.fn(async () => undefined),
    onInboxRespond: vi.fn(async () => undefined),
    onInboxDismiss: vi.fn(async () => undefined),
    ...overrides,
  }

  render(<AutomationCardDetail {...props} />)
  return props
}

describe('AutomationCardDetail', () => {
  it('renders the current automation state and routes primary actions', async () => {
    const user = userEvent.setup()
    const props = renderDetail({
      deliveries: [delivery()],
      runs: [run()],
      workItems: [
        workItem({ status: 'completed' }),
        workItem({
          id: 'item-2',
          title: 'Find source data',
          status: 'blocked',
          blockingReason: 'Need source confirmation.',
        }),
      ],
    })

    expect(screen.getByRole('dialog', { name: 'Weekly report' })).toBeInTheDocument()
    expect(screen.getByText('Run now')).toBeInTheDocument()
    expect(screen.getByText('Report ready')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Work' }))
    expect(screen.getByText('Draft report')).toBeInTheDocument()
    expect(screen.getByText('Find source data')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Run now' }))
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    await user.click(screen.getByRole('button', { name: 'Close automation details' }))

    expect(props.onRunNow).toHaveBeenCalledTimes(1)
    expect(props.onPause).toHaveBeenCalledTimes(1)
    expect(props.onArchive).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('handles approval and question inbox actions without leaving the drawer', async () => {
    const user = userEvent.setup()
    const approval = inboxItem()
    const question = inboxItem({
      id: 'question-1',
      questionId: 'sdk-question-1',
      type: 'clarification',
      title: 'Need data source',
      body: 'Which market should be covered?',
    })
    const props = renderDetail({
      automation: automation({ status: 'needs_user', brief: brief() }),
      inbox: [approval, question],
    })

    await user.click(screen.getAllByRole('button', { name: 'Approve brief' })[0]!)
    await user.type(screen.getByPlaceholderText('Reply to continue'), 'Cover public equities.')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await user.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]!)

    expect(props.onApproveBrief).toHaveBeenCalledTimes(1)
    expect(props.onInboxRespond).toHaveBeenCalledWith('question-1', 'Cover public equities.')
    expect(props.onInboxDismiss).toHaveBeenCalledWith('question-1')
  })

  it('saves quick settings with edited copy, project directory, run policy, and specialists', async () => {
    const user = userEvent.setup()
    vi.mocked(window.coworkApi.dialog.selectDirectory).mockResolvedValue('/project/reporting')
    const props = renderDetail({
      agentOptions: [{
        id: 'researcher',
        label: 'Researcher',
        description: 'Finds source material.',
        source: 'builtin',
      }],
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'Monday report')
    await user.clear(screen.getByLabelText('Goal'))
    await user.type(screen.getByLabelText('Goal'), 'Prepare a Monday planning report.')
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    fireEvent.change(screen.getByLabelText('Daily run cap'), { target: { value: '4' } })
    await user.click(screen.getByRole('button', { name: /Researcher/ }))
    await user.click(screen.getByRole('button', { name: 'Save edits' }))

    await waitFor(() => expect(props.onPatch).toHaveBeenCalledTimes(1))
    expect(props.onPatch).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Monday report',
      goal: 'Prepare a Monday planning report.',
      projectDirectory: '/project/reporting',
      preferredAgentNames: ['researcher'],
      runPolicy: {
        dailyRunCap: 4,
        maxRunDurationMinutes: 120,
      },
    }))
  })

  it('exposes history actions for failed and linked runs', async () => {
    const user = userEvent.setup()
    const props = renderDetail({
      runs: [
        run({
          id: 'failed-run',
          status: 'failed',
          title: 'Failed execution',
          error: 'Provider capacity.',
          sessionId: 'session-failed',
        }),
      ],
    })

    await user.click(screen.getByRole('button', { name: 'History' }))
    await user.click(screen.getByRole('button', { name: 'Retry run' }))
    await user.click(screen.getByRole('button', { name: 'Open thread' }))

    expect(props.onRetryRun).toHaveBeenCalledWith('failed-run')
    expect(props.onOpenThread).toHaveBeenCalledWith('session-failed')
  })
})
