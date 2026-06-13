import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTaskRunAgentBySourceSession,
  resolveConversationTaskContext,
  resolveTaskRunHandoffAgent,
  type CoordinationBoardPayload,
  type TaskRun,
} from '../packages/shared/dist/index.js'

const now = '2026-06-13T00:00:00.000Z'

const board: CoordinationBoardPayload = {
  projects: [{
    id: 'project-1',
    kind: 'project',
    workspaceId: 'local',
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    createdAt: now,
    updatedAt: now,
    title: 'Studio redesign',
    objective: 'Ship Studio parity',
    status: 'active',
    team: ['chief-of-staff'],
  }],
  tasks: [{
    id: 'task-1',
    kind: 'task',
    workspaceId: 'local',
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    createdAt: now,
    updatedAt: now,
    projectId: 'project-1',
    title: 'Conversation polish',
    spec: 'Add handoff and review affordances',
    status: 'running',
    column: 'doing',
    priority: 'high',
    assignedSessionId: 'session-1',
    assignedRunId: 'run-1',
    assigneeAgent: 'chief-of-staff',
  }],
}

function task(overrides: Partial<TaskRun>): TaskRun {
  return {
    id: 'task-run-1',
    title: 'Research',
    agent: 'researcher',
    status: 'running',
    sourceSessionId: 'source-session',
    parentSessionId: null,
    content: '',
    transcript: [],
    toolCalls: [],
    compactions: [],
    todos: [],
    error: null,
    sessionCost: 0,
    sessionTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    order: 1,
    ...overrides,
  }
}

test('resolves conversation project/task context from assigned session id', () => {
  assert.deepEqual(resolveConversationTaskContext(board, 'session-1'), {
    projectId: 'project-1',
    projectTitle: 'Studio redesign',
    taskId: 'task-1',
    taskTitle: 'Conversation polish',
    taskStatus: 'running',
    taskColumn: 'doing',
    taskPriority: 'high',
    assignedSessionId: 'session-1',
    assignedRunId: 'run-1',
    assigneeAgent: 'chief-of-staff',
  })
  assert.equal(resolveConversationTaskContext(board, 'missing-session'), null)
})

test('derives task handoff agent from parent session lineage', () => {
  const root = task({ id: 'root', agent: 'research-agent', sourceSessionId: 'root-session' })
  const child = task({
    id: 'child',
    agent: 'writer-agent',
    sourceSessionId: 'child-session',
    parentSessionId: 'root-session',
  })
  const map = buildTaskRunAgentBySourceSession([root, child])

  assert.deepEqual(map, {
    'root-session': 'research-agent',
    'child-session': 'writer-agent',
  })
  assert.equal(resolveTaskRunHandoffAgent(child, map), 'research-agent')
  assert.equal(resolveTaskRunHandoffAgent(root, map), null)
})
