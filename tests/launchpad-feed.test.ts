import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ArtifactIndexEntry,
  ArtifactIndexPayload,
  CoordinationBoardPayload,
  SessionView,
} from '@open-cowork/shared'
import {
  buildLaunchpadFeedFromSources,
  listLaunchpadCoordinationBoard,
  listLocalLaunchpadFeed,
  setLaunchpadRuntimeDepsForTests,
} from '../apps/desktop/src/main/launchpad/launchpad-service.ts'

function emptyView(partial: Partial<SessionView>): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    ...partial,
  }
}

const board: CoordinationBoardPayload = {
  projects: [
    {
      id: 'project-a',
      kind: 'project',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      title: 'Design parity',
      objective: 'Unify desktop and Cloud Web.',
      status: 'active',
      team: ['build'],
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T08:00:00.000Z',
    },
    {
      id: 'project-b',
      kind: 'project',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      title: 'Gateway polish',
      objective: 'Harden gateway.',
      status: 'active',
      team: ['review'],
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T08:00:00.000Z',
    },
  ],
  tasks: [
    {
      id: 'task-older',
      kind: 'task',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      projectId: 'project-a',
      title: 'Older running task',
      spec: 'Still in motion.',
      status: 'running',
      column: 'doing',
      priority: 'med',
      assigneeAgent: 'build',
      assignedSessionId: 'session-older',
      assignedRunId: 'run-older',
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T09:00:00.000Z',
    },
    {
      id: 'task-newer',
      kind: 'task',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      projectId: 'project-a',
      title: 'Newer running task',
      spec: 'Should sort first.',
      status: 'running',
      column: 'doing',
      priority: 'high',
      assigneeAgent: 'review',
      assignedSessionId: 'session-newer',
      assignedRunId: 'run-newer',
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T10:00:00.000Z',
    },
    {
      id: 'task-complete',
      kind: 'task',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      projectId: 'project-a',
      title: 'Done task',
      spec: 'Terminal rows should not appear in progress.',
      status: 'completed',
      column: 'done',
      priority: 'low',
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T11:00:00.000Z',
    },
    {
      id: 'task-other-project',
      kind: 'task',
      workspaceId: 'local',
      ownerAuthority: 'desktop_local',
      executionAuthority: 'desktop_local',
      stateOwner: 'desktop_local_store',
      projectId: 'project-b',
      title: 'Other project task',
      spec: 'Filtered out by project.',
      status: 'running',
      column: 'doing',
      priority: 'med',
      assigneeAgent: 'ops',
      assignedSessionId: 'session-other',
      assignedRunId: 'run-other',
      createdAt: '2026-06-09T08:00:00.000Z',
      updatedAt: '2026-06-09T12:00:00.000Z',
    },
  ],
}

const artifacts: ArtifactIndexEntry[] = [
  {
    id: 'artifact-older',
    toolId: 'tool-1',
    toolName: 'write',
    filePath: '/Users/joe/private/design.md',
    filename: 'design.md',
    order: 1,
    sessionId: 'session-older',
    sessionTitle: 'Older session',
    workspaceId: 'local',
    kind: 'document',
    status: 'draft',
    authorAgentId: 'build',
    projectId: 'project-a',
    taskId: 'task-older',
    createdAt: '2026-06-09T09:30:00.000Z',
    updatedAt: '2026-06-09T09:30:00.000Z',
  },
  {
    id: 'artifact-newer',
    toolId: 'tool-2',
    toolName: 'write',
    filePath: '/Users/joe/private/final.csv',
    filename: 'final.csv',
    order: 2,
    sessionId: 'session-newer',
    sessionTitle: 'Newer session',
    workspaceId: 'local',
    kind: 'spreadsheet',
    status: 'final',
    authorAgentId: 'review',
    projectId: 'project-a',
    taskId: 'task-newer',
    createdAt: '2026-06-09T10:30:00.000Z',
    updatedAt: '2026-06-09T10:30:00.000Z',
  },
]

test('launchpad feed aggregates in-progress tasks, waiting prompts, and fresh artifacts with caps', () => {
  const feed = buildLaunchpadFeedFromSources({
    request: {
      projectId: 'project-a',
      inProgressLimit: 1,
      waitingLimit: 1,
      artifactsLimit: 1,
    },
    board,
    sessions: [
      {
        sessionId: 'session-newer',
        updatedAt: '2026-06-09T10:10:00.000Z',
        runId: 'run-newer',
        view: emptyView({
          pendingApprovals: [{
            id: 'approval-1',
            sessionId: 'session-newer',
            taskRunId: 'run-newer',
            tool: 'bash',
            input: { token: 'SECRET_DO_NOT_LEAK' },
            description: 'Approve command',
            order: 12,
          }],
        }),
      },
      {
        sessionId: 'session-older',
        updatedAt: '2026-06-09T09:10:00.000Z',
        runId: 'run-older',
        view: emptyView({
          pendingQuestions: [{
            id: 'question-1',
            sessionId: 'session-older',
            sourceSessionId: 'session-older',
            questions: [{
              header: 'Choice',
              question: 'Pick an option',
              options: [{ label: 'A', description: 'First' }],
            }],
          }],
        }),
      },
    ],
    artifacts,
    artifactTotal: artifacts.length,
    generatedAt: '2026-06-09T12:00:00.000Z',
  })

  assert.deepEqual(feed.inProgress.map((item) => item.id), ['task-newer'])
  assert.deepEqual(feed.waitingOnYou.map((item) => item.id), ['permission:session-newer:approval-1'])
  assert.match(feed.freshArtifacts[0]?.artifactId || '', /^local-artifact-[a-f0-9]{16}$/)
  assert.equal(feed.inProgress[0].projectTitle, 'Design parity')
  assert.equal(feed.waitingOnYou[0].assigneeAgent, 'review')
  assert.equal(feed.freshArtifacts[0].kind, 'spreadsheet')
  assert.deepEqual(feed.totals, { inProgress: 2, waitingOnYou: 2, freshArtifacts: 2 })
  assert.deepEqual(feed.truncated, { inProgress: true, waitingOnYou: true, freshArtifacts: true })

  const serialized = JSON.stringify(feed)
  assert.doesNotMatch(serialized, /SECRET_DO_NOT_LEAK/)
  assert.doesNotMatch(serialized, /\/Users\/joe\/private/)
  assert.doesNotMatch(serialized, /artifact-newer/)
  assert.equal(Object.hasOwn(feed.freshArtifacts[0], 'filePath'), false)
})

test('launchpad feed preserves cloud artifact ids and propagates source truncation', () => {
  const feed = buildLaunchpadFeedFromSources({
    request: { artifactsLimit: 1 },
    board,
    sessions: [],
    artifacts: [{
      id: 'cloud-artifact-1',
      cloudArtifactId: 'cloud-artifact-1',
      source: 'cloud',
      toolId: 'tool-3',
      toolName: 'write',
      filePath: 'cloud-artifact://cloud-artifact-1/report.md',
      filename: 'report.md',
      order: 3,
      sessionId: 'session-newer',
      sessionTitle: 'Newer session',
      workspaceId: 'cloud:tenant-1',
      kind: 'document',
      status: 'draft',
      authorAgentId: 'review',
      projectId: 'project-a',
      taskId: 'task-newer',
      createdAt: '2026-06-09T10:45:00.000Z',
      updatedAt: '2026-06-09T10:45:00.000Z',
    }],
    artifactTotal: 1,
    artifactTruncated: true,
    generatedAt: '2026-06-09T12:00:00.000Z',
  })

  assert.equal(feed.freshArtifacts[0]?.artifactId, 'cloud-artifact-1')
  assert.equal(feed.totals.freshArtifacts, 2)
  assert.equal(feed.truncated.freshArtifacts, true)
})

test('launchpad feed reports capped session scans for waiting items', () => {
  const feed = buildLaunchpadFeedFromSources({
    request: { waitingLimit: 4 },
    board,
    sessions: [],
    sessionsTruncated: true,
    artifacts: [],
    generatedAt: '2026-06-09T12:00:00.000Z',
  })

  assert.deepEqual(feed.waitingOnYou, [])
  assert.equal(feed.totals.waitingOnYou, 1)
  assert.equal(feed.truncated.waitingOnYou, true)
})

test('launchpad project filter excludes unrelated work', () => {
  const feed = buildLaunchpadFeedFromSources({
    request: { projectId: 'project-b', limit: 5 },
    board,
    sessions: [
      {
        sessionId: 'session-newer',
        updatedAt: '2026-06-09T10:10:00.000Z',
        runId: 'run-newer',
        view: emptyView({
          pendingApprovals: [{
            id: 'approval-1',
            sessionId: 'session-newer',
            taskRunId: 'run-newer',
            tool: 'bash',
            input: {},
            description: 'Approve command',
            order: 12,
          }],
        }),
      },
    ],
    artifacts,
  })

  assert.deepEqual(feed.inProgress.map((item) => item.id), ['task-other-project'])
  assert.deepEqual(feed.waitingOnYou, [])
  assert.deepEqual(feed.freshArtifacts, [])
})

test('local launchpad feed fetches one extra artifact to report overflow', async () => {
  let requestedArtifactLimit: number | null | undefined = null
  const deps: NonNullable<Parameters<typeof listLaunchpadCoordinationBoard>[1]> = {
    listSessionRecords: () => [],
    isHydrated: () => false,
    getSessionView: () => emptyView({}),
    syncSessionView: async () => emptyView({}),
    listCoordinationBoard: () => board,
    listCoordinationProjects: () => board.projects,
    listCoordinationTasks: ({ projectId }) => board.tasks.filter((task) => !projectId || task.projectId === projectId),
    listArtifactIndex: async (request): Promise<ArtifactIndexPayload> => {
      requestedArtifactLimit = request.limit
      return {
        artifacts,
        total: artifacts.length,
        truncated: false,
      }
    },
    nowIso: () => '2026-06-09T12:00:00.000Z',
  }
  setLaunchpadRuntimeDepsForTests(deps)
  try {
    const feed = await listLocalLaunchpadFeed({
      projectId: 'project-a',
      artifactsLimit: 1,
    })

    assert.equal(requestedArtifactLimit, 2)
    assert.equal(feed.freshArtifacts.length, 1)
    assert.equal(feed.freshArtifacts[0]?.title, 'final.csv')
    assert.equal(feed.totals.freshArtifacts, 2)
    assert.equal(feed.truncated.freshArtifacts, true)
  } finally {
    setLaunchpadRuntimeDepsForTests(null)
  }
})

test('launchpad project board loads project-scoped tasks outside workspace board caps', () => {
  const deps: NonNullable<Parameters<typeof listLaunchpadCoordinationBoard>[1]> = {
    listSessionRecords: () => [],
    isHydrated: () => false,
    getSessionView: () => emptyView({}),
    syncSessionView: async () => emptyView({}),
    listCoordinationBoard: () => ({
      projects: [board.projects[0]!],
      tasks: [board.tasks[0]!],
    }),
    listCoordinationProjects: () => board.projects,
    listCoordinationTasks: ({ projectId }) => board.tasks.filter((task) => task.projectId === projectId),
    listArtifactIndex: async (): Promise<ArtifactIndexPayload> => ({
      artifacts: [],
      total: 0,
      truncated: false,
    }),
    nowIso: () => '2026-06-09T12:00:00.000Z',
  }

  const scoped = listLaunchpadCoordinationBoard({
    workspaceId: 'local',
    projectId: 'project-b',
    limit: 1,
  }, deps)

  assert.deepEqual(scoped.projects.map((project) => project.id), ['project-b'])
  assert.deepEqual(scoped.tasks.map((task) => task.id), ['task-other-project'])
})
