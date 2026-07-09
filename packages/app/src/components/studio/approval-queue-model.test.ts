import { describe, expect, it } from 'vitest'
import type { SessionView } from '@open-cowork/shared'
import type { SessionViewState } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import {
  buildDesktopApprovalQueueItems,
  countDesktopApprovalQueueItems,
} from './approval-queue-model'

function queueState(
  pendingApprovals: SessionViewState['pendingApprovals'] = [],
  pendingQuestions: SessionViewState['pendingQuestions'] = [],
) {
  return {
    pendingApprovals,
    pendingQuestions,
  } as SessionViewState
}

function queueView(
  pendingApprovals: SessionView['pendingApprovals'] = [],
  pendingQuestions: SessionView['pendingQuestions'] = [],
) {
  return {
    ...useSessionStore.getInitialState().currentView,
    pendingApprovals,
    pendingQuestions,
  } as SessionView
}

describe('approval queue model', () => {
  it('counts active-workspace queue entries without building decorated items', () => {
    const sessionsByWorkspace = {
      [LOCAL_WORKSPACE_ID]: [
        { id: 'session-a', title: 'Session A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'session-b', title: 'Session B', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'session-current', title: 'Current', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      'cloud:other': [
        { id: 'cloud-session', title: 'Cloud', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    }
    const input = {
      activeWorkspaceId: LOCAL_WORKSPACE_ID,
      sessionsByWorkspace,
      sessionStateById: {
        [sessionWorkspaceKey(LOCAL_WORKSPACE_ID, 'session-a')]: queueState([{
          id: 'approval-a',
          sessionId: 'session-a',
          tool: 'bash',
          input: {},
          description: 'Run command',
          order: 1,
        }], []),
        [sessionWorkspaceKey(LOCAL_WORKSPACE_ID, 'session-b')]: queueState([], [{
          id: 'question-b',
          sessionId: 'session-b',
          questions: [{ header: 'Confirm', question: 'Continue?', options: [] }],
        }]),
        [sessionWorkspaceKey(LOCAL_WORKSPACE_ID, 'excluded-local')]: queueState([{
          id: 'approval-cross-workspace',
          sessionId: 'excluded-local',
          workspaceId: 'cloud:other',
          tool: 'bash',
          input: {},
          description: 'Other workspace command',
          order: 2,
        }], []),
        [sessionWorkspaceKey('cloud:other', 'cloud-session')]: queueState([{
          id: 'approval-cloud',
          sessionId: 'cloud-session',
          workspaceId: 'cloud:other',
          tool: 'bash',
          input: {},
          description: 'Cloud command',
          order: 3,
        }], []),
      },
      currentSessionId: 'session-current',
      currentView: queueView([{
        id: 'approval-current',
        sessionId: 'session-current',
        tool: 'bash',
        input: {},
        description: 'Current command',
        order: 4,
      }], [{
        id: 'question-current',
        sessionId: 'session-current',
        questions: [{ header: 'Confirm', question: 'Proceed?', options: [] }],
      }]),
    }

    const items = buildDesktopApprovalQueueItems(input)

    expect(countDesktopApprovalQueueItems(input)).toBe(4)
    expect(items).toHaveLength(4)
    expect(items.map((item) => item.id).sort()).toEqual([
      'approval-a',
      'approval-current',
      'question-b',
      'question-current',
    ])
  })

  it('counts queue entries from the real session store shape used by Sidebar', () => {
    const baseView = useSessionStore.getInitialState().currentView
    const sessions = [{ id: 'active-session', title: 'Active chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    useSessionStore.setState(useSessionStore.getInitialState(), true)
    useSessionStore.setState({
      activeWorkspaceId: LOCAL_WORKSPACE_ID,
      sessions,
      sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: sessions },
      currentSessionId: 'active-session',
    })
    useSessionStore.getState().setSessionView('active-session', {
      ...baseView,
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
        questions: [{ header: 'Confirm', question: 'Continue?', options: [] }],
      }],
    }, LOCAL_WORKSPACE_ID)

    const state = useSessionStore.getState()

    expect(countDesktopApprovalQueueItems({
      activeWorkspaceId: state.activeWorkspaceId,
      sessionsByWorkspace: state.sessionsByWorkspace,
      sessionStateById: state.sessionStateById,
      currentSessionId: state.currentSessionId,
      currentView: state.currentView,
    })).toBe(2)
  })
})
