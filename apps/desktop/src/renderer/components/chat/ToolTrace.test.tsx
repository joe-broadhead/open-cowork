import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ToolTrace } from './ToolTrace'

const mockDispatchComposerCompose = vi.hoisted(() => vi.fn())

vi.mock('./composer-events', () => ({
  attachmentFromArtifact: (payload: { filename?: string; mime: string; url: string }) => ({
    filename: payload.filename,
    mime: payload.mime,
    url: payload.url,
  }),
  dispatchComposerCompose: mockDispatchComposerCompose,
}))

vi.mock('./MermaidChart', () => ({
  MermaidChart: ({ diagram, title }: { diagram: string; title?: string }) => (
    <figure data-testid="mermaid-chart">
      {title || 'Untitled'}: {diagram}
    </figure>
  ),
}))

vi.mock('./VegaChart', () => ({
  VegaChart: ({
    chartFormat,
    chartTitle,
    toolCallId,
    toolName,
  }: {
    chartFormat: string
    chartTitle?: string
    toolCallId: string
    toolName: string
  }) => (
    <figure data-testid="vega-chart">
      {chartFormat}: {chartTitle || 'Untitled'} ({toolName}/{toolCallId})
    </figure>
  ),
}))

function tool(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'read',
    input: {},
    status: 'complete',
    order: 1,
    ...overrides,
  }
}

function resetSessionStore(options: {
  directory?: string | null
  activeAgent?: string | null
} = {}) {
  const currentView = useSessionStore.getState().currentView
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        title: 'Private thread',
        directory: options.directory ?? null,
        createdAt: '2026-05-07T00:00:00.000Z',
        updatedAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    currentSessionId: 'session-1',
    currentView: {
      ...currentView,
      activeAgent: options.activeAgent ?? 'explore',
    },
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

function installArtifactApi() {
  return installRendererTestCoworkApi({
    artifact: {
      readAttachment: vi.fn(async () => ({
        filename: 'report.md',
        mime: 'text/markdown',
        url: 'data:text/markdown;base64,cmVwb3J0',
      })),
      export: vi.fn(async () => '/tmp/report.md'),
      reveal: vi.fn(async () => true),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDispatchComposerCompose.mockClear()
  resetSessionStore()
  installArtifactApi()
})

describe('ToolTrace', () => {
  it('renders compact sub-agent badges and summarized tool categories', () => {
    render(
      <ToolTrace
        compact
        tools={[
          tool({
            name: 'mcp__github__create_issue',
            agent: 'explore',
          }),
        ]}
      />,
    )

    expect(screen.getByText('Sub-Agent')).toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('1 github issue action')).toBeInTheDocument()
  })

  it('uses custom MCP trace labels from app-owned metadata', async () => {
    resetSessionStore({ directory: '/tmp/project-with-ticketing' })
    installRendererTestCoworkApi({
      custom: {
        listMcps: vi.fn(async () => [{
          scope: 'project',
          directory: '/tmp/project-with-ticketing',
          name: 'ticketing',
          label: 'Ticketing',
          traceLabel: 'ticket update',
          tracePluralLabel: 'ticket updates',
          type: 'stdio',
        }]),
      },
    })

    render(
      <ToolTrace
        compact
        tools={[
          tool({
            name: 'mcp__ticketing__create_issue',
          }),
          tool({
            id: 'tool-2',
            name: 'ticketing_transition_issue',
            order: 2,
          }),
        ]}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('2 ticket updates')).toBeInTheDocument()
    })
  })

  it('renders chart outputs and image attachments outside the expanded details', () => {
    render(
      <ToolTrace
        tools={[
          tool({
            id: 'chart-tool',
            name: 'mcp__charts__bar',
            output: JSON.stringify({
              type: 'vega-lite',
              title: 'Pipeline by stage',
              spec: { mark: 'bar', data: { values: [{ stage: 'Lead', count: 2 }] } },
            }),
          }),
          tool({
            id: 'mermaid-tool',
            name: 'mcp__charts__mermaid',
            order: 2,
            output: {
              type: 'mermaid',
              title: 'Flow',
              diagram: 'graph TD; A-->B',
            },
          }),
          tool({
            id: 'image-tool',
            name: 'read',
            order: 3,
            attachments: [
              {
                filename: 'chart.png',
                mime: 'image/png',
                url: 'data:image/png;base64,abc',
              },
            ],
          }),
        ]}
      />,
    )

    expect(screen.getByTestId('vega-chart')).toHaveTextContent('vega-lite: Pipeline by stage (mcp__charts__bar/chart-tool)')
    expect(screen.getByTestId('mermaid-chart')).toHaveTextContent('Flow: graph TD; A-->B')
    expect(screen.getByRole('img', { name: 'chart.png' })).toHaveAttribute('src', 'data:image/png;base64,abc')
  })

  it('sends, reveals, and exports private-workspace artifacts', async () => {
    const user = userEvent.setup()
    const api = installArtifactApi()

    render(
      <ToolTrace
        tools={[
          tool({
            id: 'write-report',
            name: 'write',
            input: { filePath: '/tmp/open-cowork/report.md', content: '# Report' },
            output: 'Wrote report.md',
          }),
        ]}
      />,
    )

    const artifactCard = screen.getByText('report.md').closest('div')?.parentElement?.parentElement
    expect(artifactCard).not.toBeNull()
    const artifactControls = within(artifactCard as HTMLElement)

    await user.click(artifactControls.getByRole('button', { name: 'Send to thread' }))
    await waitFor(() => {
      expect(api.artifact.readAttachment).toHaveBeenCalledWith({
        sessionId: 'session-1',
        filePath: '/tmp/open-cowork/report.md',
      })
    })
    expect(mockDispatchComposerCompose).toHaveBeenCalledWith({
      attachments: [
        {
          filename: 'report.md',
          mime: 'text/markdown',
          url: 'data:text/markdown;base64,cmVwb3J0',
        },
      ],
    })

    await user.click(artifactControls.getByRole('button', { name: 'Reveal' }))
    await waitFor(() => {
      expect(api.artifact.reveal).toHaveBeenCalledWith({
        sessionId: 'session-1',
        filePath: '/tmp/open-cowork/report.md',
      })
    })

    await user.click(artifactControls.getByRole('button', { name: /Save As/ }))
    await waitFor(() => {
      expect(api.artifact.export).toHaveBeenCalledWith({
        sessionId: 'session-1',
        filePath: '/tmp/open-cowork/report.md',
        suggestedName: 'report.md',
      })
    })
  })

  it('expands completed tool details and redacts artifact paths in displayed input', async () => {
    const user = userEvent.setup()

    render(
      <ToolTrace
        tools={[
          tool({
            id: 'write-report',
            name: 'write',
            input: { filePath: '/tmp/open-cowork/report.md', content: '# Report' },
            output: 'Wrote report.md',
          }),
        ]}
      />,
    )

    await user.click(screen.getByRole('button', { name: /1 file edit/ }))
    await user.click(screen.getByRole('button', { name: /write/ }))

    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText(/artifact:\/\/report.md/)).toBeInTheDocument()
    expect(screen.queryByText(/\/tmp\/open-cowork\/report.md/)).not.toBeInTheDocument()
    expect(screen.getByText('Output')).toBeInTheDocument()
    expect(screen.getByText('Wrote report.md')).toBeInTheDocument()
  })

  it('does not expose artifact controls for project-backed sessions', async () => {
    const user = userEvent.setup()
    resetSessionStore({ directory: '/tmp/project' })

    render(
      <ToolTrace
        tools={[
          tool({
            id: 'write-report',
            name: 'write',
            input: { filePath: '/tmp/project/report.md', content: '# Report' },
            output: 'Wrote report.md',
          }),
        ]}
      />,
    )

    expect(screen.queryByText('Artifact')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send to thread' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /1 file edit/ }))
    await user.click(screen.getByRole('button', { name: /write/ }))

    expect(screen.getByText(/\/tmp\/project\/report.md/)).toBeInTheDocument()
  })
})
