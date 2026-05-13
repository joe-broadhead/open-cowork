import { describe, expect, it } from 'vitest'
import type { PendingApproval, PendingQuestion, TaskRun } from '@open-cowork/shared'
import {
  DEFAULT_MISSION_CONTROL_SCALE_STATE,
  MISSION_CONTROL_SCALE_FEATURE_GATE_KEY,
  buildMissionControlSummary,
  buildTaskReviewIndex,
  isMissionControlScaleEnabled,
  missionControlScaleStorageKey,
  missionControlStatusForTask,
  readMissionControlScaleState,
  reviewActivityForTask,
  selectMissionControlVisibleTasks,
  writeMissionControlScaleState,
} from './mission-control-scale-model'

const emptyTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function task(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'task-1',
    title: 'Work item',
    agent: 'worker',
    status: 'running',
    sourceSessionId: 'child-1',
    parentSessionId: null,
    content: '',
    transcript: [],
    toolCalls: [],
    compactions: [],
    todos: [],
    error: null,
    sessionCost: 0,
    sessionTokens: emptyTokens,
    order: 1,
    startedAt: '2026-05-07T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  }
}

function approval(overrides: Partial<PendingApproval>): PendingApproval {
  return {
    id: 'approval-1',
    sessionId: 'child-1',
    taskRunId: null,
    tool: 'bash',
    input: {},
    description: 'Run command',
    order: 10,
    ...overrides,
  }
}

function question(overrides: Partial<PendingQuestion>): PendingQuestion {
  return {
    id: 'question-1',
    sessionId: 'child-1',
    sourceSessionId: 'child-1',
    questions: [{ header: 'Scope', question: 'Continue?', options: [] }],
    ...overrides,
  }
}

describe('mission-control-scale-model', () => {
  it('keeps scaled Mission Control behind an explicit default-off feature gate', () => {
    window.localStorage.removeItem(MISSION_CONTROL_SCALE_FEATURE_GATE_KEY)
    expect(isMissionControlScaleEnabled()).toBe(false)

    window.localStorage.setItem(MISSION_CONTROL_SCALE_FEATURE_GATE_KEY, 'true')
    expect(isMissionControlScaleEnabled()).toBe(true)
  })

  it('persists normalized filter state per session group', () => {
    const key = missionControlScaleStorageKey('session-1', 'group-1')
    expect(readMissionControlScaleState(window.localStorage, key)).toEqual(DEFAULT_MISSION_CONTROL_SCALE_STATE)

    writeMissionControlScaleState(window.localStorage, key, {
      statusFilter: 'waiting',
      agentFilter: 'research',
      activityFilter: 'approvals',
    })

    expect(readMissionControlScaleState(window.localStorage, key)).toEqual({
      statusFilter: 'waiting',
      agentFilter: 'research',
      activityFilter: 'approvals',
    })
  })

  it('classifies waiting, blocked, errored, complete, and cancelled task states', () => {
    const waitingTask = task({ id: 'waiting', sourceSessionId: 'waiting-session' })
    const index = buildTaskReviewIndex([waitingTask], [approval({ taskRunId: 'waiting' })], [])
    expect(missionControlStatusForTask(waitingTask, reviewActivityForTask(index, 'waiting'))).toBe('waiting')

    expect(missionControlStatusForTask(task({ status: 'queued' }), { approvals: [], questions: [] })).toBe('blocked')
    expect(missionControlStatusForTask(task({ status: 'error', error: 'Tool failed' }), { approvals: [], questions: [] })).toBe('errored')
    expect(missionControlStatusForTask(task({ status: 'complete' }), { approvals: [], questions: [] })).toBe('complete')
    expect(missionControlStatusForTask(task({ status: 'error', error: 'User aborted task' }), { approvals: [], questions: [] })).toBe('cancelled')
  })

  it('filters by activity while retaining ancestor tasks for nested context', () => {
    const root = task({ id: 'root', agent: 'lead', sourceSessionId: 'root-session', order: 1 })
    const child = task({
      id: 'child',
      agent: 'research',
      sourceSessionId: 'child-session',
      parentSessionId: 'root-session',
      status: 'running',
      toolCalls: [{ id: 'tool-1', name: 'read', input: {}, status: 'complete', order: 2 }],
      order: 2,
    })
    const grandchild = task({
      id: 'grandchild',
      agent: 'writer',
      sourceSessionId: 'grandchild-session',
      parentSessionId: 'child-session',
      status: 'running',
      toolCalls: [{ id: 'tool-2', name: 'write', input: { filePath: '/tmp/report.md' }, status: 'complete', order: 3 }],
      order: 3,
    })
    const index = buildTaskReviewIndex([root, child, grandchild], [], [question({ sourceSessionId: 'grandchild-session' })])

    expect(selectMissionControlVisibleTasks([root, child, grandchild], {
      statusFilter: 'all',
      agentFilter: 'all',
      activityFilter: 'artifacts',
    }, index).map((entry) => entry.id)).toEqual(['root', 'child', 'grandchild'])

    expect(selectMissionControlVisibleTasks([root, child, grandchild], {
      statusFilter: 'waiting',
      agentFilter: 'all',
      activityFilter: 'questions',
    }, index).map((entry) => entry.id)).toEqual(['root', 'child', 'grandchild'])
  })

  it('summarizes status counts, review activity, artifacts, tools, and token cost', () => {
    const running = task({
      id: 'running',
      agent: 'research',
      toolCalls: [{ id: 'tool-1', name: 'write', input: { filePath: '/tmp/report.md' }, status: 'complete', order: 11 }],
      sessionTokens: { input: 100, output: 50, reasoning: 0, cacheRead: 25, cacheWrite: 0 },
      sessionCost: 0.03,
      finishedAt: '2026-05-07T00:02:00.000Z',
    })
    const complete = task({ id: 'complete', agent: 'write', status: 'complete', sourceSessionId: 'child-2', order: 2 })
    const index = buildTaskReviewIndex([running, complete], [approval({ taskRunId: 'running' })], [])

    const summary = buildMissionControlSummary([running, complete], [running], index, new Date('2026-05-07T00:03:00.000Z').getTime())

    expect(summary.statuses.waiting).toBe(1)
    expect(summary.statuses.complete).toBe(1)
    expect(summary.agents.map((agent) => agent.id)).toEqual(['research', 'write'])
    expect(summary.metrics.toolCount).toBe(1)
    expect(summary.metrics.artifactCount).toBe(1)
    expect(summary.metrics.approvalCount).toBe(1)
    expect(summary.metrics.tokenTotal).toBe(175)
    expect(summary.metrics.cost).toBe(0.03)
  })
})
