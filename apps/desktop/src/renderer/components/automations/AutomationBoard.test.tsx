import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationListPayload, AutomationRun, AutomationSummary } from '@open-cowork/shared'
import { AutomationBoard } from './AutomationBoard'
import {
  buildAutomationBoard,
  buildAutomationCardModel,
  resolveAutomationDropAction,
} from './automation-board-support'

function automation(overrides: Partial<AutomationSummary>): AutomationSummary {
  return {
    id: overrides.id || 'auto-1',
    title: overrides.title || 'Weekly report',
    goal: overrides.goal || 'Keep a weekly report ready for review.',
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
    projectDirectory: overrides.projectDirectory ?? null,
    preferredAgentNames: overrides.preferredAgentNames || [],
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-01T00:00:00.000Z',
    nextRunAt: overrides.nextRunAt ?? null,
    lastRunAt: overrides.lastRunAt ?? null,
    nextHeartbeatAt: overrides.nextHeartbeatAt ?? null,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? null,
    latestRunStatus: overrides.latestRunStatus ?? null,
    latestRunId: overrides.latestRunId ?? null,
  }
}

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: overrides.id || 'run-1',
    automationId: overrides.automationId || 'auto-1',
    sessionId: overrides.sessionId ?? null,
    kind: overrides.kind || 'execution',
    status: overrides.status || 'running',
    title: overrides.title || 'Execute report',
    summary: overrides.summary ?? null,
    error: overrides.error ?? null,
    failureCode: overrides.failureCode ?? null,
    attempt: overrides.attempt ?? 1,
    retryOfRunId: overrides.retryOfRunId ?? null,
    nextRetryAt: overrides.nextRetryAt ?? null,
    createdAt: overrides.createdAt || '2026-01-01T01:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
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

describe('AutomationBoard support', () => {
  it('groups automations into lifecycle columns by priority', () => {
    const data = payload({
      automations: [
        automation({ id: 'draft', title: 'Draft task', status: 'draft' }),
        automation({ id: 'planning', title: 'Planning task', status: 'running' }),
        automation({ id: 'review', title: 'Review task', status: 'needs_user' }),
        automation({ id: 'ready', title: 'Ready task', status: 'ready' }),
        automation({ id: 'delivered', title: 'Delivered task', status: 'completed' }),
        automation({ id: 'paused', title: 'Paused task', status: 'paused' }),
      ],
      inbox: [{
        id: 'inbox-1',
        automationId: 'review',
        runId: null,
        sessionId: null,
        questionId: null,
        type: 'approval',
        status: 'open',
        title: 'Approve',
        body: 'Approve the brief.',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      runs: [run({ automationId: 'planning', kind: 'enrichment' })],
      deliveries: [{
        id: 'delivery-1',
        automationId: 'delivered',
        runId: null,
        provider: 'in_app',
        target: 'automation-inbox',
        status: 'delivered',
        title: 'Output ready',
        body: 'Done.',
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })

    const board = buildAutomationBoard(data)

    expect(board.find((column) => column.id === 'draft')?.cards.map((card) => card.automation.id)).toEqual(['draft'])
    expect(board.find((column) => column.id === 'planning')?.cards.map((card) => card.automation.id)).toEqual(['planning'])
    expect(board.find((column) => column.id === 'needs-review')?.cards.map((card) => card.automation.id)).toEqual(['review'])
    expect(board.find((column) => column.id === 'ready-running')?.cards.map((card) => card.automation.id)).toEqual(['ready'])
    expect(board.find((column) => column.id === 'delivered')?.cards.map((card) => card.automation.id)).toEqual(['delivered'])
    expect(board.find((column) => column.id === 'paused')?.cards.map((card) => card.automation.id)).toEqual(['paused'])
  })

  it('maps supported drops to existing automation actions', () => {
    const draftPayload = payload({ automations: [automation({ id: 'draft', status: 'draft' })] })
    const draftAction = resolveAutomationDropAction(buildAutomationCardModel(draftPayload, draftPayload.automations[0]!), 'planning')
    expect(draftAction).toMatchObject({ valid: true, type: 'previewBrief', confirm: false })

    const reviewPayload = payload({
      automations: [automation({ id: 'review', status: 'needs_user' })],
      inbox: [{
        id: 'approval',
        automationId: 'review',
        runId: null,
        sessionId: null,
        questionId: null,
        type: 'approval',
        status: 'open',
        title: 'Approve',
        body: 'Approve.',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    const approveAction = resolveAutomationDropAction(buildAutomationCardModel(reviewPayload, reviewPayload.automations[0]!), 'ready-running')
    expect(approveAction).toMatchObject({ valid: true, type: 'approveBrief', confirm: true })

    const invalidAction = resolveAutomationDropAction(buildAutomationCardModel(draftPayload, draftPayload.automations[0]!), 'delivered')
    expect(invalidAction.valid).toBe(false)
  })
})

describe('AutomationBoard', () => {
  it('renders stats, columns, and cards', () => {
    render(
      <AutomationBoard
        payload={payload({ automations: [automation({ title: 'Weekly report' })] })}
        selectedAutomationId={null}
        onSelectAutomation={vi.fn()}
        onDropAutomation={vi.fn()}
        onNewAutomation={vi.fn()}
        onLearnMore={vi.fn()}
      />,
    )

    expect(screen.getByText('1 active')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Weekly report/ })).toBeInTheDocument()
  })
})
