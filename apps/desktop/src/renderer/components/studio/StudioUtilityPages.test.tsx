import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { useSessionStore } from '../../stores/session'
import { StudioApprovalsPage, StudioArtifactsPage } from './StudioUtilityPages'

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

  it('scopes the waiting session count to the active chat queue', () => {
    const unrelatedPermissionSession = sessionWorkspaceKey('cloud:other', 'other-permission-session')
    const unrelatedQuestionSession = sessionWorkspaceKey('gateway:other', 'other-question-session')
    useSessionStore.setState({
      currentSessionId: 'active-session',
      currentView: {
        ...useSessionStore.getState().currentView,
        pendingApprovals: [],
        pendingQuestions: [],
      },
      awaitingPermissionSessions: new Set([unrelatedPermissionSession]),
      awaitingQuestionSessions: new Set([unrelatedQuestionSession]),
    })

    render(<StudioApprovalsPage onOpenChat={vi.fn()} onOpenHome={vi.fn()} />)

    const waitingStat = screen.getByText('Sessions waiting').parentElement
    expect(waitingStat).not.toBeNull()
    expect(within(waitingStat as HTMLElement).getByText('0')).toBeInTheDocument()
    expect(screen.getByText('No approvals waiting')).toBeInTheDocument()
  })

  it('counts one active chat even when permission and question queues overlap', () => {
    useSessionStore.setState({
      currentSessionId: 'active-session',
      currentView: {
        ...useSessionStore.getState().currentView,
        pendingApprovals: [{
          id: 'approval-1',
          sessionId: 'active-session',
          tool: 'bash',
          input: {},
          description: 'Run command',
          order: 1,
        }],
        pendingQuestions: [{
          id: 'question-1',
          sessionId: 'active-session',
          questions: [{
            header: 'Confirm',
            question: 'Continue?',
            options: [{ label: 'Yes', description: 'Continue' }],
          }],
        }],
      },
      awaitingPermissionSessions: new Set(['active-session']),
      awaitingQuestionSessions: new Set(['active-session']),
    })

    render(<StudioApprovalsPage onOpenChat={vi.fn()} onOpenHome={vi.fn()} />)

    const waitingStat = screen.getByText('Sessions waiting').parentElement
    expect(waitingStat).not.toBeNull()
    expect(within(waitingStat as HTMLElement).getByText('1')).toBeInTheDocument()
  })
})

describe('StudioArtifactsPage', () => {
  beforeEach(() => {
    resetSessionStore()
  })

  it('keeps the Open chat action enabled when an active chat exists', () => {
    useSessionStore.setState({ currentSessionId: 'active-session' })

    render(<StudioArtifactsPage onOpenChat={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Open chat' })).not.toBeDisabled()
  })
})
