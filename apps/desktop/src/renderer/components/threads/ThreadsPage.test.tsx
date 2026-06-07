import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ThreadFacetSummary, ThreadListItem, ThreadSearchResult, ThreadTag } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ThreadsPage } from './ThreadsPage'

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
    workflowId: overrides.workflowId ?? null,
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

    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'revenue')
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

  it('debounces free-text search before calling the thread index', async () => {
    vi.useFakeTimers()
    try {
      const api = installRendererTestCoworkApi()
      vi.mocked(api.threads.search).mockResolvedValue({
        threads: [thread()],
        nextCursor: null,
        totalEstimate: 1,
      })
      vi.mocked(api.threads.facets).mockResolvedValue(facets())

      render(<ThreadsPage onOpenThread={vi.fn()} />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByText('Weekly chart report')).toBeInTheDocument()
      vi.mocked(api.threads.search).mockClear()

      fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'rev' } })
      expect(api.threads.search).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(349)
      })
      expect(api.threads.search).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(1)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(api.threads.search).toHaveBeenCalledWith(expect.objectContaining({ text: 'rev' }))

      vi.mocked(api.threads.search).mockClear()
      fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'revenue' } })
      expect(api.threads.search).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(api.threads.search).toHaveBeenCalledWith(expect.objectContaining({ text: 'revenue' }))
    } finally {
      vi.useRealTimers()
    }
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
    await user.click(screen.getByRole('checkbox', { name: 'Select project chat' }))
    await user.click(screen.getByRole('button', { name: 'Add tag' }))
    await waitFor(() => expect(api.threads.tags.apply).toHaveBeenCalledWith(['thread-1'], ['tag-1']))

    await user.click(screen.getByRole('button', { name: 'Reports' }))
    await waitFor(() => expect(api.threads.search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'report', tagIds: ['tag-1'] })))

    await user.click(screen.getByRole('button', { name: /Weekly chart report/ }))
    const drawer = screen.getByRole('complementary', { name: 'Project detail' })
    await user.click(within(drawer).getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api.threads.suggestions.accept).toHaveBeenCalledWith('suggestion-1'))
  })

})
