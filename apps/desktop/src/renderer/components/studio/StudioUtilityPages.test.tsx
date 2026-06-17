import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { useSessionStore } from '../../stores/session'
import { StudioApprovalsPage, StudioArtifactsPage, StudioChannelsPage } from './StudioUtilityPages'

function resetSessionStore() {
  useSessionStore.setState({
    activeWorkspaceId: LOCAL_WORKSPACE_ID,
    sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: [] },
    sessions: [],
    currentSessionId: null,
    currentView: useSessionStore.getInitialState().currentView,
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

describe('StudioApprovalsPage', () => {
  beforeEach(() => {
    resetSessionStore()
  })

  it('aggregates waiting inputs across active-workspace chats only', () => {
    const baseView = useSessionStore.getInitialState().currentView
    const localSessions = [
      { id: 'active-session', title: 'Active chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'review-session', title: 'Review chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    useSessionStore.setState({
      sessions: localSessions,
      sessionsByWorkspace: {
        [LOCAL_WORKSPACE_ID]: localSessions,
        'cloud:other': [{ id: 'other-session', title: 'Other workspace chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
      },
      currentSessionId: 'active-session',
    })
    useSessionStore.getState().setSessionView('active-session', {
      ...baseView,
      pendingApprovals: [{
        id: 'approval-1',
        sessionId: 'active-session',
        tool: 'bash',
        input: { command: 'pnpm test' },
        description: 'Run command',
        order: 2,
      }],
      pendingQuestions: [],
    }, LOCAL_WORKSPACE_ID)
    useSessionStore.getState().setSessionView('review-session', {
      ...baseView,
      pendingApprovals: [],
      pendingQuestions: [{
        id: 'question-1',
        sessionId: 'review-session',
        questions: [{
          header: 'Confirm',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Continue' }],
        }],
      }],
    }, LOCAL_WORKSPACE_ID)
    useSessionStore.getState().setSessionView('other-session', {
      ...baseView,
      pendingApprovals: [{
        id: 'other-approval',
        sessionId: 'other-session',
        workspaceId: 'cloud:other',
        tool: 'bash',
        input: {},
        description: 'Other workspace command',
        order: 3,
      }],
      pendingQuestions: [],
    }, 'cloud:other')

    render(<StudioApprovalsPage onOpenChat={vi.fn()} onOpenHome={vi.fn()} />)

    expect(screen.getByText('Run command')).toBeInTheDocument()
    expect(screen.getAllByText('Continue?').length).toBeGreaterThan(0)
    expect(screen.queryByText('Other workspace command')).toBeNull()
  })

  it('responds to permissions and questions from the standalone queue', async () => {
    const permissionRespond = vi.fn(async () => undefined)
    const questionReply = vi.fn(async () => undefined)
    const questionReject = vi.fn(async () => undefined)
    installRendererTestCoworkApi({
      permission: { respond: permissionRespond },
      question: { reply: questionReply, reject: questionReject },
    })
    const baseView = useSessionStore.getInitialState().currentView
    const localSessions = [{ id: 'active-session', title: 'Active chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    useSessionStore.setState({
      sessions: localSessions,
      sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: localSessions },
      currentSessionId: 'active-session',
    })
    useSessionStore.getState().setSessionView('active-session', {
      ...baseView,
      pendingApprovals: [{
        id: 'approval-1',
        sessionId: 'active-session',
        tool: 'bash',
        input: { command: 'pnpm test' },
        description: 'Run command',
        order: 1,
      }],
      pendingQuestions: [{
        id: 'question-1',
        sessionId: 'active-session',
        questions: [
          {
            header: 'Confirm',
            question: 'Continue?',
            options: [{ label: 'Yes', description: 'Continue' }],
          },
          {
            header: 'Scope',
            question: 'Choose a scope',
            options: [{ label: 'Smoke', description: 'Smoke only' }],
            custom: false,
          },
        ],
      }],
    }, LOCAL_WORKSPACE_ID)

    render(<StudioApprovalsPage onOpenChat={vi.fn()} onOpenHome={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Always allow' })).toBeDisabled()
    expect(screen.getByText('Persistent allow rules must be changed in Settings so the runtime can restart safely.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(permissionRespond).toHaveBeenCalledWith('approval-1', true, 'active-session', { workspaceId: LOCAL_WORKSPACE_ID }))

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(permissionRespond).toHaveBeenCalledWith('approval-1', false, 'active-session', { workspaceId: LOCAL_WORKSPACE_ID }))

    const customAnswer = screen.getByLabelText('Custom answer for Confirm')
    fireEvent.change(customAnswer, { target: { value: 'Use a custom answer' } })
    fireEvent.click(screen.getByText('Yes'))
    await waitFor(() => expect(customAnswer).toHaveValue(''))
    expect(questionReply).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled()
    fireEvent.click(screen.getByText('Smoke'))
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(questionReply).toHaveBeenCalledWith('active-session', 'question-1', [['Yes'], ['Smoke']], { workspaceId: LOCAL_WORKSPACE_ID }))

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(questionReject).toHaveBeenCalledWith('active-session', 'question-1', { workspaceId: LOCAL_WORKSPACE_ID }))
  })
})

describe('StudioArtifactsPage', () => {
  beforeEach(() => {
    resetSessionStore()
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  it('keeps the Open chat action enabled when an active chat exists', () => {
    useSessionStore.setState({ currentSessionId: 'active-session' })

    render(<StudioArtifactsPage onOpenChat={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Open chat' })).not.toBeDisabled()
  })

  it('renders the cross-project artifact index with provenance and actions', async () => {
    const sessions = [
      { id: 'session-1', title: 'Q2 board review', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T10:30:00.000Z' },
      { id: 'session-2', title: 'Revenue packet', directory: '/Users/joe/project', createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-06-02T10:30:00.000Z' },
    ]
    useSessionStore.setState({
      sessions,
      sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: sessions },
      currentSessionId: 'session-1',
      chartArtifactsBySession: {
        'session-1': [{
          id: 'chart:/workspace/acme/private/board-chart.png',
          filePath: '/workspace/acme/private/board-chart.png',
          filename: 'board-chart.png',
          toolId: 'chart-tool',
          toolName: 'render_chart',
          order: 3,
          mime: 'image/png',
          size: 1024,
          chart: { format: 'vega-lite', spec: { mark: 'bar' }, title: 'Board chart' },
        }],
      },
    })
    const indexArtifacts = vi.fn(async () => ({
      artifacts: [
        {
          id: 'session:write:/Users/joe/private/objectKey/report.md',
          sessionId: 'session-1',
          sessionTitle: 'Q2 board review',
          workspaceId: LOCAL_WORKSPACE_ID,
          filePath: '/Users/joe/private/objectKey/report.md',
          filename: 'board-review.md',
          toolId: 'write',
          toolName: 'Writer',
          order: 1,
          mime: 'text/markdown',
          size: 4096,
          kind: 'document',
          status: 'in-review',
          authorAgentId: 'Cleo',
          projectId: 'project-alpha',
          updatedAt: '2026-06-01T10:30:00.000Z',
        },
        {
          id: 'artifact-deck',
          sessionId: 'session-1',
          sessionTitle: 'Q2 board review',
          workspaceId: LOCAL_WORKSPACE_ID,
          filePath: '/Users/joe/private/board-deck.pptx',
          filename: 'board-deck.pptx',
          toolId: 'write',
          toolName: 'Writer',
          order: 2,
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          size: 8192,
          kind: 'deck',
          status: 'draft',
          authorAgentId: 'Cleo',
          projectId: 'project-alpha',
          updatedAt: '2026-06-01T11:30:00.000Z',
        },
        {
          id: 'artifact-2',
          sessionId: 'session-2',
          sessionTitle: 'Revenue packet',
          workspaceId: LOCAL_WORKSPACE_ID,
          filePath: '/Users/joe/project/revenue.csv',
          filename: 'revenue.csv',
          toolId: 'spreadsheet',
          toolName: 'Analyst',
          order: 2,
          mime: 'text/csv',
          size: 2048,
          kind: 'spreadsheet',
          status: 'final',
          authorAgentId: 'Analyst',
          projectId: 'project-beta',
          updatedAt: '2026-06-02T10:30:00.000Z',
        },
      ],
      total: 3,
    }))
    const openArtifact = vi.fn(async () => '/tmp/board-review.md')
    const exportArtifact = vi.fn(async () => '/tmp/board-review.md')
    const updateStatus = vi.fn(async () => ({ id: 'artifact-deck', status: 'in-review' }))
    installRendererTestCoworkApi({
      artifact: {
        index: indexArtifacts,
        open: openArtifact,
        export: exportArtifact,
        updateStatus,
      },
    })

    render(<StudioArtifactsPage onOpenChat={vi.fn()} />)

    expect(await screen.findByText('board-review.md')).toBeInTheDocument()
    expect(indexArtifacts).toHaveBeenCalledWith({ workspaceId: undefined, limit: 200 })
    expect(screen.getAllByText('In review').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cleo').length).toBeGreaterThan(0)
    expect(screen.getAllByText('project-alpha').length).toBeGreaterThan(0)
    expect(screen.getByText('board-deck.pptx')).toBeInTheDocument()
    expect(screen.getByText('revenue.csv')).toBeInTheDocument()
    expect(screen.getByText('board-chart.png')).toBeInTheDocument()
    const pageText = document.body.textContent || ''
    expect(pageText).not.toContain('/Users/joe/private')
    expect(pageText).not.toContain('/Users/joe/project')
    expect(pageText).not.toContain('/workspace/acme/private')
    expect(pageText).not.toContain('objectKey')
    expect(screen.getByRole('button', { name: 'Export all' })).not.toBeDisabled()

    const card = screen.getByText('board-review.md').closest('.studio-artifact-card') as HTMLElement
    const deckCard = screen.getByText('board-deck.pptx').closest('.studio-artifact-card') as HTMLElement
    const revenueCard = screen.getByText('revenue.csv').closest('.studio-artifact-card') as HTMLElement
    expect(within(deckCard).getByRole('button', { name: 'Open' })).toBeDisabled()
    expect(within(deckCard).getByRole('button', { name: 'Export' })).not.toBeDisabled()
    expect(within(revenueCard).getByRole('button', { name: 'Open' })).toBeDisabled()
    expect(within(revenueCard).getByRole('button', { name: 'Export' })).toBeDisabled()

    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith({
      sessionId: 'session-1',
      filePath: '/Users/joe/private/objectKey/report.md',
      suggestedName: 'board-review.md',
      workspaceId: undefined,
    }))

    fireEvent.click(within(card).getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(exportArtifact).toHaveBeenCalledWith({
      sessionId: 'session-1',
      filePath: '/Users/joe/private/objectKey/report.md',
      suggestedName: 'board-review.md',
      workspaceId: undefined,
    }))

    // The final artifact is terminal (no advance control); the draft deck advances
    // to in-review through the shared lifecycle backed by the existing IPC.
    expect(within(revenueCard).queryByRole('button', { name: /Advance to/ })).toBeNull()
    fireEvent.click(within(deckCard).getByRole('button', { name: 'Advance to In review' }))
    await waitFor(() => expect(updateStatus).toHaveBeenCalledWith({
      sessionId: 'session-1',
      artifactId: 'artifact-deck',
      status: 'in-review',
      workspaceId: undefined,
    }))
  })

  it('ignores stale artifact index responses after switching workspaces', async () => {
    const first = deferred<Awaited<ReturnType<typeof window.coworkApi.artifact.index>>>()
    const second = deferred<Awaited<ReturnType<typeof window.coworkApi.artifact.index>>>()
    const indexArtifacts = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    installRendererTestCoworkApi({
      artifact: {
        index: indexArtifacts,
      },
    })
    useSessionStore.setState({ activeWorkspaceId: 'cloud:first' })

    render(<StudioArtifactsPage onOpenChat={vi.fn()} />)
    await waitFor(() => expect(indexArtifacts).toHaveBeenCalledWith({ workspaceId: 'cloud:first', limit: 200 }))

    act(() => {
      useSessionStore.setState({ activeWorkspaceId: 'cloud:second' })
    })
    await waitFor(() => expect(indexArtifacts).toHaveBeenCalledWith({ workspaceId: 'cloud:second', limit: 200 }))

    await act(async () => {
      second.resolve({
        artifacts: [{
          id: 'artifact-second',
          sessionId: 'session-second',
          filePath: 'cloud-artifact://artifact-second/result.md',
          filename: 'second-workspace.md',
          toolId: 'write',
          toolName: 'Writer',
          order: 1,
          kind: 'document',
          status: 'draft',
          projectId: 'second-project',
        }],
        total: 1,
      })
      await second.promise
    })
    expect(await screen.findByText('second-workspace.md')).toBeInTheDocument()

    await act(async () => {
      first.resolve({
        artifacts: [{
          id: 'artifact-first',
          sessionId: 'session-first',
          filePath: 'cloud-artifact://artifact-first/result.md',
          filename: 'first-workspace.md',
          toolId: 'write',
          toolName: 'Writer',
          order: 1,
          kind: 'document',
          status: 'draft',
          projectId: 'first-project',
        }],
        total: 1,
      })
      await first.promise
    })

    expect(screen.getByText('second-workspace.md')).toBeInTheDocument()
    expect(screen.queryByText('first-workspace.md')).toBeNull()
  })

  it('hides the previous workspace artifact index while the next workspace loads', async () => {
    const second = deferred<Awaited<ReturnType<typeof window.coworkApi.artifact.index>>>()
    const indexArtifacts = vi.fn()
      .mockResolvedValueOnce({
        artifacts: [{
          id: 'artifact-first',
          sessionId: 'session-first',
          filePath: 'cloud-artifact://artifact-first/result.md',
          filename: 'first-workspace.md',
          toolId: 'write',
          toolName: 'Writer',
          order: 1,
          kind: 'document',
          status: 'draft',
          projectId: 'first-project',
        }],
        total: 1,
      })
      .mockReturnValueOnce(second.promise)
    installRendererTestCoworkApi({
      artifact: {
        index: indexArtifacts,
      },
    })
    useSessionStore.setState({ activeWorkspaceId: 'cloud:first' })

    render(<StudioArtifactsPage onOpenChat={vi.fn()} />)
    expect(await screen.findByText('first-workspace.md')).toBeInTheDocument()

    act(() => {
      useSessionStore.setState({ activeWorkspaceId: 'cloud:second' })
    })

    await waitFor(() => expect(indexArtifacts).toHaveBeenCalledWith({ workspaceId: 'cloud:second', limit: 200 }))
    expect(screen.queryByText('first-workspace.md')).toBeNull()

    await act(async () => {
      second.resolve({ artifacts: [], total: 0 })
      await second.promise
    })
    expect(screen.queryByText('first-workspace.md')).toBeNull()
  })
})

describe('StudioChannelsPage', () => {
  beforeEach(() => {
    resetSessionStore()
  })

  it('renders provider reach, People roles, Watches, and desktop channel actions', async () => {
    const connectBinding = vi.fn(async () => ({ bindingId: 'binding-new', agentId: 'agent-1', provider: 'whatsapp', displayName: 'WhatsApp channel', status: 'auth_required', settings: {} }))
    const createWatch = vi.fn(async () => ({
      id: 'watch-2',
      kind: 'watch',
      workspaceId: LOCAL_WORKSPACE_ID,
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      status: 'active',
      target: { kind: 'project', id: 'project-2' },
      events: ['task.moved', 'needs_input'],
      channel: { provider: 'telegram', agentId: 'agent-1', channelBindingId: 'binding-1', target: { chatId: 'chat-1', externalChatId: 'chat-1' } },
      recipient: { role: 'approver', label: 'Approver' },
      deliverySurface: 'gateway_channel',
      verbosity: 'normal',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    const pauseWatch = vi.fn(async () => ({
      id: 'watch-1',
      kind: 'watch',
      workspaceId: LOCAL_WORKSPACE_ID,
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      status: 'paused',
      target: { kind: 'project', id: 'project-1' },
      events: ['needs_input'],
      channel: { provider: 'telegram', agentId: 'agent-1', channelBindingId: 'binding-1', target: {} },
      recipient: { role: 'approver', label: 'Approver' },
      deliverySurface: 'gateway_channel',
      verbosity: 'normal',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    installRendererTestCoworkApi({
      channels: {
        providers: vi.fn(async () => [
          { id: 'whatsapp', provider: 'whatsapp', label: 'WhatsApp', available: true, connected: false, bindingCount: 0, activeBindingCount: 0, status: 'available' },
          { id: 'telegram', provider: 'telegram', label: 'Telegram', available: true, connected: true, bindingCount: 1, activeBindingCount: 1, status: 'connected' },
          { id: 'slack', provider: 'slack', label: 'Slack', available: true, connected: false, bindingCount: 1, activeBindingCount: 0, status: 'available' },
          { id: 'discord', provider: 'discord', label: 'Discord', available: true, connected: false, bindingCount: 1, activeBindingCount: 0, status: 'available' },
          { id: 'signal', provider: 'signal', label: 'Signal', available: true, connected: false, bindingCount: 0, activeBindingCount: 0, status: 'available' },
          { id: 'email', provider: 'email', label: 'Email', available: true, connected: false, bindingCount: 0, activeBindingCount: 0, status: 'available' },
          { id: 'webhook', provider: 'webhook', label: 'Webhook', available: true, connected: false, bindingCount: 0, activeBindingCount: 0, status: 'available' },
        ]),
        agents: vi.fn(async () => [{ agentId: 'agent-1', name: 'On-call coding agent', profileName: 'default', status: 'active' }]),
        bindings: vi.fn(async () => [
          { bindingId: 'binding-1', agentId: 'agent-1', provider: 'telegram', displayName: 'Team Telegram', status: 'active', settings: { defaultChatId: 'chat-1' } },
          { bindingId: 'binding-pending', agentId: 'agent-1', provider: 'slack', displayName: 'Slack setup', status: 'auth_required', settings: {} },
          { bindingId: 'binding-disabled', agentId: 'agent-1', provider: 'discord', displayName: 'Old Discord', status: 'disabled', settings: {} },
        ]),
        connectBinding,
        people: vi.fn(async () => [
          { identityId: 'identity-owner', provider: 'telegram', externalUserId: '@owner', role: 'owner', status: 'active', metadata: { handle: '@owner' } },
          { identityId: 'identity-admin', provider: 'slack', externalUserId: '@admin', role: 'admin', status: 'active', metadata: { handle: '@admin' } },
          { identityId: 'identity-member', provider: 'discord', externalUserId: '@member', role: 'member', status: 'active', metadata: { handle: '@member' } },
          { identityId: 'identity-approver', provider: 'telegram', externalUserId: '@approver', role: 'approver', status: 'active', metadata: { handle: '@approver' } },
          { identityId: 'identity-viewer', provider: 'email', externalUserId: 'viewer@example.test', role: 'viewer', status: 'active', metadata: { handle: 'viewer@example.test' } },
        ]),
        deliveries: vi.fn(async () => [{ deliveryId: 'delivery-1', eventType: 'needs_input', status: 'sent', provider: 'telegram', channelBindingId: 'binding-1', attemptCount: 1, sessionId: null }]),
        watches: vi.fn(async () => [{
          id: 'watch-1',
          kind: 'watch',
          workspaceId: LOCAL_WORKSPACE_ID,
          ownerAuthority: 'desktop_local',
          executionAuthority: 'desktop_local',
          stateOwner: 'desktop_local_store',
          status: 'active',
          target: { kind: 'project', id: 'project-1' },
          events: ['needs_input'],
          channel: { provider: 'telegram', agentId: 'agent-1', channelBindingId: 'binding-1', target: {} },
          recipient: { role: 'approver', label: 'Approver' },
          deliverySurface: 'gateway_channel',
          verbosity: 'normal',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }]),
        createWatch,
        pauseWatch,
      },
    })

    render(<StudioChannelsPage onOpenSettings={vi.fn()} />)

    expect(await screen.findByText('Team Telegram')).toBeInTheDocument()
    expect(screen.getByText('Start work')).toBeInTheDocument()
    expect(screen.getByText('Get updates')).toBeInTheDocument()
    expect(screen.getByText('Approve on the go')).toBeInTheDocument()
    for (const label of ['WhatsApp', 'Telegram', 'Slack', 'Discord', 'Signal', 'Email', 'Webhook']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    for (const role of ['Owner', 'Admin', 'Member', 'Approver', 'Viewer']) {
      expect(screen.getAllByText(role).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('project / project-1')).toBeInTheDocument()
    const providerCard = (label: string) => [...document.querySelectorAll('#channel-add-grid article')]
      .find((card) => card.querySelector('h3')?.textContent === label)
    const slackCard = providerCard('Slack')
    expect(slackCard).not.toBeNull()
    expect(within(slackCard as HTMLElement).getByRole('button', { name: 'Pending' })).toBeDisabled()
    const discordCard = providerCard('Discord')
    expect(discordCard).not.toBeNull()
    const discordConnect = within(discordCard as HTMLElement).getByRole('button', { name: 'Connect' })
    expect(discordConnect).not.toBeDisabled()
    fireEvent.click(discordConnect)

    await waitFor(() => expect(connectBinding).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', provider: 'discord' })))

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))

    await waitFor(() => expect(pauseWatch).toHaveBeenCalledWith('watch-1', { workspaceId: LOCAL_WORKSPACE_ID }))

    fireEvent.change(screen.getByLabelText('Target id'), { target: { value: 'project-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add watch' }))

    await waitFor(() => expect(createWatch).toHaveBeenCalled())
    expect(createWatch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: LOCAL_WORKSPACE_ID,
      target: { kind: 'project', id: 'project-2' },
      channel: expect.objectContaining({
        provider: 'telegram',
        channelBindingId: 'binding-1',
        target: expect.objectContaining({ chatId: 'chat-1', externalChatId: 'chat-1' }),
      }),
    }))
    expect(connectBinding).not.toHaveBeenCalledWith(expect.objectContaining({ provider: 'slack' }))
  })
})
