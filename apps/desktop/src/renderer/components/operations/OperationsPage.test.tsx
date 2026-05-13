import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { OperationsSummary, OperationsWorkItem } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { OperationsPage } from './OperationsPage'

function workItem(overrides: Partial<OperationsWorkItem> = {}): OperationsWorkItem {
  const route = overrides.route || { surface: 'automations' as const, automationId: 'automation-1', automationRunId: 'run-1' }
  const sourceRef = overrides.sourceRef || { kind: 'automation_run' as const, id: 'run-1', automationId: 'automation-1', automationRunId: 'run-1' }
  return {
    schemaVersion: 1,
    id: overrides.id || 'automation_run:run-1',
    sourceKind: overrides.sourceKind || 'automation_run',
    sourceId: overrides.sourceId || 'run-1',
    title: overrides.title || 'Weekly automation run',
    summary: overrides.summary ?? 'Waiting for review.',
    queueStatus: overrides.queueStatus || 'running',
    status: overrides.status || 'running',
    statusLabel: overrides.statusLabel || 'running',
    sourceLabel: overrides.sourceLabel || 'Weekly report',
    owner: overrides.owner ?? '/workspace/revenue',
    agents: overrides.agents || ['analyst'],
    capabilities: overrides.capabilities || ['github.write'],
    costUsd: overrides.costUsd ?? 1.25,
    tokenCount: overrides.tokenCount ?? 1234,
    riskLabels: overrides.riskLabels || ['policy'],
    governanceLabels: overrides.governanceLabels || ['approval'],
    reviewState: overrides.reviewState || 'none',
    needsUserAttention: overrides.needsUserAttention ?? false,
    sourceRef,
    route,
    actions: overrides.actions || [
      {
        schemaVersion: 1,
        id: 'automation_run:run-1:open_source',
        kind: 'open_source',
        label: 'Open source',
        supported: true,
        disabledReason: null,
        destructive: false,
        requiresConfirmation: false,
        target: {
          route,
          sourceRef,
          automationId: 'automation-1',
          automationRunId: 'run-1',
        },
      },
      {
        schemaVersion: 1,
        id: 'automation_run:run-1:cancel_automation_run',
        kind: 'cancel_automation_run',
        label: 'Cancel run',
        supported: true,
        disabledReason: null,
        destructive: true,
        requiresConfirmation: false,
        target: {
          route,
          sourceRef,
          automationId: 'automation-1',
          automationRunId: 'run-1',
        },
      },
    ],
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-02T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
  }
}

function summary(items: OperationsWorkItem[]): OperationsSummary {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-06T00:00:00.000Z',
    totalWorkItems: items.length,
    needsAttention: items.filter((item) => item.needsUserAttention || item.queueStatus === 'needs_review').length,
    running: items.filter((item) => item.queueStatus === 'running').length,
    failed: items.filter((item) => item.queueStatus === 'failed').length,
    delivered: items.filter((item) => item.queueStatus === 'delivered').length,
    queue: [
      { status: 'needs_review', label: 'Needs review', count: items.filter((item) => item.queueStatus === 'needs_review').length },
      { status: 'waiting_on_user', label: 'Waiting on user', count: items.filter((item) => item.queueStatus === 'waiting_on_user').length },
      { status: 'running', label: 'Running', count: items.filter((item) => item.queueStatus === 'running').length },
      { status: 'blocked', label: 'Blocked', count: items.filter((item) => item.queueStatus === 'blocked').length },
      { status: 'failed', label: 'Failed', count: items.filter((item) => item.queueStatus === 'failed').length },
      { status: 'delivered', label: 'Delivered', count: items.filter((item) => item.queueStatus === 'delivered').length },
      { status: 'quiet_paused', label: 'Quiet / paused', count: items.filter((item) => item.queueStatus === 'quiet_paused').length },
    ],
    items,
    healthSignals: [{
      schemaVersion: 1,
      id: 'risk-1',
      severity: 'critical',
      kind: 'capability_risk',
      title: 'High-risk capability: github.write',
      message: 'Write-capable GitHub operation.',
      sourceLabel: 'github:*',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('OperationsPage', () => {
  it('loads the command center summary, filters rows, opens sources, and runs safe actions', async () => {
    const api = installRendererTestCoworkApi()
    const onOpenThread = vi.fn()
    const onOpenRoute = vi.fn()
    const onOpenDiagnostics = vi.fn()
    const items = [
      workItem({ title: 'Weekly automation run', queueStatus: 'running' }),
      workItem({
        id: 'approval:approval-1',
        title: 'Approve weekly report',
        queueStatus: 'needs_review',
        status: 'approval_required',
        needsUserAttention: true,
        actions: [{
          schemaVersion: 1,
          id: 'approval:approval-1:open_source',
          kind: 'open_source',
          label: 'Open source',
          supported: true,
          target: {
            route: { surface: 'automations', automationId: 'automation-1' },
            sourceRef: { kind: 'approval', id: 'approval-1', automationId: 'automation-1' },
            automationId: 'automation-1',
          },
        }],
      }),
    ]
    vi.mocked(api.operations.summary).mockResolvedValue(summary(items))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const user = userEvent.setup()
    render(<OperationsPage onOpenThread={onOpenThread} onOpenRoute={onOpenRoute} onOpenDiagnostics={onOpenDiagnostics} />)

    expect(await screen.findByText('Approve weekly report')).toBeInTheDocument()
    expect(screen.getByText('High-risk capability: github.write')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All work' }))
    await user.type(screen.getByRole('textbox', { name: 'Search operations' }), 'weekly automation')
    expect(screen.getByText('Weekly automation run')).toBeInTheDocument()
    expect(screen.queryByText('Approve weekly report')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /All lanes\s*2/ }))
    await user.clear(screen.getByRole('textbox', { name: 'Search operations' }))
    await user.click(screen.getByRole('button', { name: /Running\s*1/ }))
    expect(screen.getByText('Weekly automation run')).toBeInTheDocument()

    const row = screen.getByText('Weekly automation run').closest('[class*="grid"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Open source' }))
    expect(onOpenRoute).toHaveBeenCalledWith(expect.objectContaining({ surface: 'automations', automationRunId: 'run-1' }))

    await user.click(within(row).getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(api.automation.cancelRun).toHaveBeenCalledWith('run-1'))
    expect(api.operations.summary).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Diagnostics' }))
    expect(onOpenDiagnostics).toHaveBeenCalled()
  })

  it('ignores stale summary responses when refreshes resolve out of order', async () => {
    const api = installRendererTestCoworkApi()
    const slow = deferred<OperationsSummary>()
    const fast = deferred<OperationsSummary>()
    vi.mocked(api.operations.summary)
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise)

    render(<OperationsPage onOpenThread={vi.fn()} onOpenRoute={vi.fn()} onOpenDiagnostics={vi.fn()} />)

    await waitFor(() => expect(api.operations.summary).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(api.operations.summary).toHaveBeenCalledTimes(2))

    await act(async () => {
      fast.resolve(summary([
        workItem({
          id: 'approval:fresh',
          title: 'Fresh review request',
          queueStatus: 'needs_review',
          status: 'approval_required',
          needsUserAttention: true,
        }),
      ]))
      await Promise.resolve()
    })
    expect(await screen.findByText('Fresh review request')).toBeInTheDocument()

    await act(async () => {
      slow.resolve(summary([
        workItem({
          id: 'approval:stale',
          title: 'Stale review request',
          queueStatus: 'needs_review',
          status: 'approval_required',
          needsUserAttention: true,
        }),
      ]))
      await Promise.resolve()
    })

    expect(screen.getByText('Fresh review request')).toBeInTheDocument()
    expect(screen.queryByText('Stale review request')).not.toBeInTheDocument()
  })
})
