import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeNotification, SessionPatch, SessionView, WorkspaceSessionsUpdatedEvent } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { useSessionStore } from '../stores/session'
import { useOpenCodeEvents } from './useOpenCodeEvents'

function Harness() {
  useOpenCodeEvents()
  return null
}

describe('useOpenCodeEvents', () => {
  let notify: ((event: RuntimeNotification) => void) | null = null
  let sessionPatch: ((event: SessionPatch) => void) | null = null
  let sessionView: ((event: { sessionId: string; view: SessionView }) => void) | null = null
  let workspaceSessionsUpdated: ((event: WorkspaceSessionsUpdatedEvent) => void) | null = null
  let closeAudioContext: ReturnType<typeof vi.fn>

  const tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }

  function view(overrides: Partial<SessionView> = {}): SessionView {
    return {
      messages: [],
      toolCalls: [],
      taskRuns: [],
      compactions: [],
      pendingApprovals: [],
      pendingQuestions: [],
      errors: [],
      todos: [],
      executionPlan: [],
      sessionCost: 0,
      sessionTokens: tokens,
      lastInputTokens: 0,
      contextState: 'idle',
      compactionCount: 0,
      lastCompactedAt: null,
      activeAgent: null,
      lastItemWasTool: false,
      revision: 0,
      lastEventAt: 0,
      isGenerating: false,
      isAwaitingPermission: false,
      isAwaitingQuestion: false,
      ...overrides,
    }
  }

  function resetSessionStore() {
    useSessionStore.setState({
      activeWorkspaceId: 'local',
      sessionsByWorkspace: { local: [] },
      sessions: [],
      currentSessionId: 'session-1',
      currentView: view(),
      globalErrors: [],
    mcpConnections: [],
      agentMode: 'build',
      reasoningVariant: null,
      totalCost: 0,
      sidebarCollapsed: false,
      busySessions: new Set(),
      awaitingPermissionSessions: new Set(),
      awaitingQuestionSessions: new Set(),
      sessionStateById: {},
    chartArtifactsBySession: {},
    })
  }

  beforeEach(() => {
    notify = null
    sessionPatch = null
    sessionView = null
    workspaceSessionsUpdated = null
    closeAudioContext = vi.fn(async () => undefined)
    resetSessionStore()

    class TestAudioContext {
      currentTime = 0
      destination = {}
      close = closeAudioContext

      createOscillator() {
        return {
          connect: vi.fn(),
          frequency: { value: 0 },
          start: vi.fn(),
          stop: vi.fn(),
          type: 'sine',
        }
      }

      createGain() {
        return {
          connect: vi.fn(),
          gain: {
            value: 0,
            exponentialRampToValueAtTime: vi.fn(),
          },
        }
      }
    }

    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: TestAudioContext,
    })
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: TestAudioContext,
    })

    installRendererTestCoworkApi({
      on: {
        authExpired: vi.fn(() => vi.fn()),
        authLogout: vi.fn(() => vi.fn()),
        mcpStatus: vi.fn(() => vi.fn()),
        notification: vi.fn((callback: (event: RuntimeNotification) => void) => {
          notify = callback
          return vi.fn()
        }),
        permissionRequest: vi.fn(() => vi.fn()),
        sessionDeleted: vi.fn(() => vi.fn()),
        sessionPatch: vi.fn((callback: (event: SessionPatch) => void) => {
          sessionPatch = callback
          return vi.fn()
        }),
        sessionUpdated: vi.fn(() => vi.fn()),
        sessionView: vi.fn((callback: (event: { sessionId: string; view: SessionView }) => void) => {
          sessionView = callback
          return vi.fn()
        }),
        workspaceSessionsUpdated: vi.fn((callback: (event: WorkspaceSessionsUpdatedEvent) => void) => {
          workspaceSessionsUpdated = callback
          return vi.fn()
        }),
      },
    })
  })

  it('closes the notification AudioContext after the final hook unmounts', () => {
    const first = render(<Harness />)
    const second = render(<Harness />)

    act(() => {
      notify?.({ type: 'done' })
    })

    expect(closeAudioContext).not.toHaveBeenCalled()

    first.unmount()
    expect(closeAudioContext).not.toHaveBeenCalled()

    second.unmount()
    expect(closeAudioContext).toHaveBeenCalledTimes(1)
  })

  it('does not replay buffered text already covered by an intervening session view', () => {
    vi.useFakeTimers()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ))
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      window.clearTimeout(handle)
    })

    const rendered = render(<Harness />)

    act(() => {
      sessionPatch?.({
        type: 'message_text',
        sessionId: 'session-1',
        messageId: 'message-1',
        segmentId: 'segment-1',
        content: 'Before ',
        mode: 'append',
        role: 'assistant',
        eventAt: 1,
      })
      sessionPatch?.({
        type: 'message_text',
        sessionId: 'session-1',
        messageId: 'message-1',
        segmentId: 'segment-1',
        content: 'After',
        mode: 'append',
        role: 'assistant',
        eventAt: 3,
      })
      sessionView?.({
        sessionId: 'session-1',
        view: view({
          messages: [{
            id: 'message-1',
            role: 'assistant',
            content: 'Before ',
            segments: [{ id: 'segment-1', content: 'Before ', order: 1 }],
            order: 1,
          }],
          toolCalls: [{
            id: 'tool-1',
            name: 'read',
            input: {},
            status: 'complete',
            order: 2,
          }],
          lastItemWasTool: true,
          lastEventAt: 2,
          isGenerating: true,
        }),
      })
      vi.advanceTimersByTime(40)
      vi.runOnlyPendingTimers()
    })

    const message = useSessionStore.getState().currentView.messages[0]
    expect(message?.content).toBe('Before After')
    expect(message?.segments?.map((segment) => segment.content)).toEqual(['Before ', 'After'])

    rendered.unmount()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
    vi.useRealTimers()
  })

  it('applies workspace session-list updates only for the active workspace', () => {
    render(<Harness />)
    useSessionStore.getState().setActiveWorkspace('cloud:active')
    useSessionStore.getState().setSessions([])

    act(() => {
      workspaceSessionsUpdated?.({
        workspaceId: 'cloud:other',
        sessions: [{
          id: 'other-session',
          title: 'Other',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }],
        syncedAt: '2026-05-27T10:00:00.000Z',
      })
    })
    expect(useSessionStore.getState().sessions).toEqual([])

    act(() => {
      workspaceSessionsUpdated?.({
        workspaceId: 'cloud:active',
        sessions: [{
          id: 'active-session',
          title: 'Active',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:00:00.000Z',
        }],
        syncedAt: '2026-05-27T10:00:01.000Z',
      })
    })

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['active-session'])
  })

  it('flushes older buffered text before immediately committing a newer task patch', () => {
    vi.useFakeTimers()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ))
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      window.clearTimeout(handle)
    })

    const rendered = render(<Harness />)

    act(() => {
      sessionView?.({
        sessionId: 'session-1',
        view: view({
          messages: [{
            id: 'message-1',
            role: 'assistant',
            content: 'Intro ',
            segments: [{ id: 'segment-1', content: 'Intro ', order: 1 }],
            order: 1,
          }],
          lastEventAt: 0,
          isGenerating: true,
        }),
      })
      sessionPatch?.({
        type: 'message_text',
        sessionId: 'session-1',
        messageId: 'message-1',
        segmentId: 'segment-1',
        content: 'before task.',
        mode: 'append',
        role: 'assistant',
        eventAt: 1,
      })
      sessionPatch?.({
        type: 'task_text',
        sessionId: 'session-1',
        taskRunId: 'task-1',
        segmentId: 'task-segment-1',
        content: 'Task started.',
        mode: 'append',
        eventAt: 2,
      })
      vi.advanceTimersByTime(40)
      vi.runOnlyPendingTimers()
    })

    const state = useSessionStore.getState().currentView
    expect(state.messages[0]?.segments?.map((segment) => segment.content)).toEqual(['Intro before task.'])
    expect(state.taskRuns[0]?.content).toBe('Task started.')

    rendered.unmount()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
    vi.useRealTimers()
  })
})
