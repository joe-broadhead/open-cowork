import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ThreadFacetSummary, ThreadListItem, ThreadSearchResult, ThreadTag, WorkLedgerEntry, WorkLedgerFacetSummary, WorkLedgerSearchResult } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ThreadsPage } from './ThreadsPage'
import { WORK_LEDGER_FEATURE_GATE_KEY } from './work-ledger-ui'

function thread(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    sessionId: overrides.sessionId || 'thread-1',
    title: overrides.title || 'Weekly chart report',
    directory: overrides.directory ?? '/workspace/revenue',
    projectLabel: overrides.projectLabel ?? 'revenue',
    providerId: overrides.providerId ?? 'openrouter',
    modelId: overrides.modelId ?? 'openrouter/sonnet',
    status: overrides.status || 'idle',
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-02T00:00:00.000Z',
    parentSessionId: overrides.parentSessionId ?? null,
    automationId: overrides.automationId ?? null,
    runId: overrides.runId ?? null,
    revertedMessageId: overrides.revertedMessageId ?? null,
    tags: overrides.tags || [],
    actualAgents: overrides.actualAgents || [{ name: 'research', count: 2 }],
    actualTools: overrides.actualTools || [{ name: 'charts.create', mcpName: 'charts', count: 1 }],
    suggestions: overrides.suggestions || [{
      id: 'suggestion-1',
      sessionId: overrides.sessionId || 'thread-1',
      label: 'reporting',
      reason: 'Actual chart usage.',
      evidence: [{ type: 'tool', value: 'charts.create' }],
      status: 'suggested',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }],
    usage: overrides.usage || {
      messages: 8,
      toolCalls: 1,
      taskRuns: 1,
      cost: 0.12,
      tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
    changeSummary: overrides.changeSummary ?? { files: 2, additions: 10, deletions: 1 },
  }
}

function facets(tag?: ThreadTag): ThreadFacetSummary {
  return {
    projects: [{ value: 'revenue', label: 'revenue', count: 1 }],
    providers: [{ value: 'openrouter', label: 'openrouter', count: 1 }],
    models: [{ value: 'openrouter/sonnet', label: 'openrouter/sonnet', count: 1 }],
    agents: [{ value: 'research', label: 'research', count: 2 }],
    tools: [{ value: 'charts.create', label: 'charts.create', count: 1 }],
    mcps: [{ value: 'charts', label: 'charts', count: 1 }],
    statuses: [{ value: 'idle', label: 'idle', count: 1 }],
    tags: tag ? [{ value: tag.id, label: tag.name, color: tag.color, count: 1 }] : [],
  }
}

function ledgerEntry(overrides: Partial<WorkLedgerEntry> = {}): WorkLedgerEntry {
  return {
    schemaVersion: overrides.schemaVersion || 1,
    id: overrides.id || 'approval:automation_inbox-1',
    sourceKind: overrides.sourceKind || 'approval',
    sourceId: overrides.sourceId || 'automation_inbox:approval-1',
    title: overrides.title || 'Approve weekly report',
    summary: overrides.summary ?? null,
    status: overrides.status || 'approval_required',
    sourceLabel: overrides.sourceLabel || 'Weekly automation',
    owner: overrides.owner ?? '/workspace/revenue',
    agents: overrides.agents || ['analyst'],
    capabilities: overrides.capabilities || ['github.write'],
    usage: overrides.usage || {
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
    riskLabels: overrides.riskLabels || ['policy'],
    governanceLabels: overrides.governanceLabels || ['approval'],
    reviewState: overrides.reviewState || 'approval_requested',
    needsUserAttention: overrides.needsUserAttention ?? true,
    sourceRef: overrides.sourceRef || {
      kind: 'approval',
      id: 'approval-1',
      automationId: 'automation-1',
      automationRunId: 'run-1',
      sessionId: 'thread-1',
      approvalId: 'approval-1',
    },
    route: overrides.route || {
      surface: 'automations',
      automationId: 'automation-1',
      automationRunId: 'run-1',
      sessionId: 'thread-1',
    },
    createdAt: overrides.createdAt || '2026-01-03T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-03T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
    indexedAt: overrides.indexedAt || '2026-01-03T00:00:00.000Z',
  }
}

function ledgerFacets(): WorkLedgerFacetSummary {
  return {
    sourceKinds: [{ value: 'approval', label: 'approval', count: 1 }],
    statuses: [{ value: 'approval_required', label: 'approval_required', count: 1 }],
    owners: [{ value: '/workspace/revenue', label: '/workspace/revenue', count: 1 }],
    agents: [{ value: 'analyst', label: 'analyst', count: 1 }],
    capabilities: [{ value: 'github.write', label: 'github.write', count: 1 }],
    riskLabels: [{ value: 'policy', label: 'policy', count: 1 }],
    governanceLabels: [{ value: 'approval', label: 'approval', count: 1 }],
    reviewStates: [{ value: 'approval_requested', label: 'approval_requested', count: 1 }],
  }
}

describe('ThreadsPage', () => {
  it('loads indexed threads, filters through IPC, and opens a selected result', async () => {
    const onOpenThread = vi.fn()
    const api = installRendererTestCoworkApi()
    vi.mocked(api.threads.search).mockResolvedValue({
      threads: [thread()],
      nextCursor: null,
      totalEstimate: 1,
    } satisfies ThreadSearchResult)
    vi.mocked(api.threads.facets).mockResolvedValue(facets())

    const user = userEvent.setup()
    render(<ThreadsPage onOpenThread={onOpenThread} />)

    expect(await screen.findByText('Weekly chart report')).toBeInTheDocument()
    expect(screen.getByText('Tool: charts.create')).toBeInTheDocument()
    expect(screen.getByText('Suggested: reporting')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Search threads' }), 'revenue')
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'revenue' })))

    await user.click(screen.getAllByRole('button', { name: /openrouter/ })[0]!)
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({ providerIds: ['openrouter'] })))

    await user.click(screen.getByRole('button', { name: 'revenue (1)' }))
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({ projectLabels: ['revenue'] })))

    await user.click(screen.getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({
      dateRange: expect.objectContaining({ from: expect.any(String) }),
    })))

    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenThread).toHaveBeenCalledWith('thread-1')
  })

  it('supports keyboard tagging, smart filters, and suggestion actions without drag only flows', async () => {
    const tag: ThreadTag = {
      id: 'tag-1',
      name: 'Revenue',
      color: '#22c55e',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const api = installRendererTestCoworkApi()
    vi.mocked(api.threads.tags.list).mockResolvedValue([tag])
    vi.mocked(api.threads.smartFilters.list).mockResolvedValue([{
      id: 'filter-1',
      name: 'Reports',
      query: { text: 'report', tagIds: [tag.id] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])
    vi.mocked(api.threads.search).mockResolvedValue({
      threads: [thread({ tags: [tag] })],
      nextCursor: null,
      totalEstimate: 1,
    })
    vi.mocked(api.threads.facets).mockResolvedValue(facets(tag))

    const user = userEvent.setup()
    render(<ThreadsPage onOpenThread={vi.fn()} />)

    await screen.findByText('Weekly chart report')
    await user.click(screen.getByRole('checkbox', { name: 'Select thread' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(api.threads.tags.apply).toHaveBeenCalledWith(['thread-1'], ['tag-1']))

    await user.click(screen.getByRole('button', { name: 'Reports' }))
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'report', tagIds: ['tag-1'] })))

    await user.click(screen.getByRole('button', { name: /Weekly chart report/ }))
    const drawer = screen.getByRole('complementary', { name: 'Thread detail' })
    await user.click(within(drawer).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api.threads.suggestions.accept).toHaveBeenCalledWith('suggestion-1'))
  })

  it('keeps the work ledger gated and supports search, facets, pagination, and source drill-down when enabled', async () => {
    const onOpenThread = vi.fn()
    const onOpenRoute = vi.fn()
    const api = installRendererTestCoworkApi()
    vi.mocked(api.threads.search).mockResolvedValue({
      threads: [thread()],
      nextCursor: null,
      totalEstimate: 1,
    })
    vi.mocked(api.threads.facets).mockResolvedValue(facets())

    const firstRender = render(<ThreadsPage onOpenThread={onOpenThread} onOpenRoute={onOpenRoute} />)
    expect(screen.queryByRole('button', { name: 'Work ledger' })).not.toBeInTheDocument()
    expect(api.workLedger.search).not.toHaveBeenCalled()
    firstRender.unmount()

    window.localStorage.setItem(WORK_LEDGER_FEATURE_GATE_KEY, 'true')
    vi.mocked(api.workLedger.search).mockResolvedValue({
      entries: [ledgerEntry()],
      nextCursor: 'cursor-2',
      totalEstimate: 2,
    } satisfies WorkLedgerSearchResult)
    vi.mocked(api.workLedger.facets).mockResolvedValue(ledgerFacets())

    const user = userEvent.setup()
    render(<ThreadsPage onOpenThread={onOpenThread} onOpenRoute={onOpenRoute} />)

    await user.click(screen.getByRole('button', { name: 'Work ledger' }))
    expect(await screen.findByText('Approve weekly report')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Search work ledger' }), 'approve')
    await waitFor(() => expect(api.workLedger.search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'approve' })))

    await user.click(screen.getByRole('button', { name: 'Approvals (1)' }))
    await waitFor(() => expect(api.workLedger.search).toHaveBeenLastCalledWith(expect.objectContaining({ sourceKinds: ['approval'] })))

    await user.click(screen.getByRole('button', { name: 'Needs user attention' }))
    await waitFor(() => expect(api.workLedger.search).toHaveBeenLastCalledWith(expect.objectContaining({ needsUserAttention: true })))

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(api.workLedger.search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-2' })))

    await user.click(screen.getAllByRole('button', { name: 'Open' })[0]!)
    expect(onOpenThread).toHaveBeenCalledWith('thread-1')
  })
})
