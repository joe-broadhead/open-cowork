import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { StatusBar } from './StatusBar'

describe('StatusBar', () => {
  it('renders active generation, context, MCP, and usage detail state', async () => {
    installRendererTestCoworkApi({
      settings: {
        get: vi.fn(async () => ({
          effectiveProviderId: 'openrouter',
          effectiveModel: 'openrouter/anthropic/claude-sonnet-4',
          selectedProviderId: null,
          selectedModelId: null,
        })),
      },
      model: {
        info: vi.fn(async () => ({
          contextLimits: {
            'openrouter/anthropic/claude-sonnet-4': 100_000,
          },
        })),
      },
      on: {
        runtimeReady: vi.fn(() => () => undefined),
      },
    })
    useSessionStore.setState((state) => ({
      mcpConnections: [
        { name: 'charts', connected: true },
        { name: 'github', connected: false },
      ],
      totalCost: 0.75,
      currentView: {
        ...state.currentView,
        isGenerating: true,
        activeAgent: 'data-analyst',
        isAwaitingPermission: false,
        isAwaitingQuestion: false,
        sessionCost: 0.25,
        sessionTokens: {
          input: 1_500,
          output: 250,
          reasoning: 0,
          cacheRead: 64,
          cacheWrite: 32,
        },
        lastInputTokens: 90_000,
        contextState: 'idle',
        compactionCount: 2,
        lastCompactedAt: '2026-05-09T12:00:00.000Z',
      },
    }))

    render(<StatusBar />)

    expect(screen.getByText('data analyst working...')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('openrouter/anthropic/claude sonnet 4')).toBeInTheDocument())
    expect(screen.getByText('90% · compacting soon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1\/2 MCPs 1 failed/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /1.8K tokens/i }))

    expect(screen.getByText('Session Usage')).toBeInTheDocument()
    expect(screen.getByText('Cache read')).toBeInTheDocument()
    expect(screen.getByText('Cache write')).toBeInTheDocument()
    expect(screen.getByText('Compactions')).toBeInTheDocument()
    expect(screen.getByText('Total (all sessions)')).toBeInTheDocument()
  })

  it('prioritizes approval and question waiting states over ready', () => {
    installRendererTestCoworkApi({
      model: { info: vi.fn(async () => ({ contextLimits: {} })) },
    })
    const baseView = useSessionStore.getState().currentView

    useSessionStore.setState({
      currentView: {
        ...baseView,
        isGenerating: false,
        isAwaitingPermission: true,
        isAwaitingQuestion: true,
        sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
      mcpConnections: [],
    })
    const { rerender } = render(<StatusBar />)
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument()

    useSessionStore.setState({
      currentView: {
        ...baseView,
        isGenerating: false,
        isAwaitingPermission: false,
        isAwaitingQuestion: true,
        sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      },
    })
    rerender(<StatusBar />)
    expect(screen.getByText('Awaiting answer')).toBeInTheDocument()
  })
})
