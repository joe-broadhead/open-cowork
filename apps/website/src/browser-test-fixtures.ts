export function iso(index = 0) {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString()
}

export function makeSession(index: number) {
  const status = index % 37 === 0 ? 'running' : 'idle'
  return {
    sessionId: `session-${index}`,
    title: `Cloud thread ${index}`,
    profileName: index % 3 === 0 ? 'data-analyst' : 'default',
    status,
    updatedAt: iso(index % 60),
    tags: index % 5 === 0 ? ['finance'] : [],
    smartFilters: index % 7 === 0 ? ['recent'] : [],
  }
}

export function makeSessionView(session: ReturnType<typeof makeSession>, sequence = 10, artifactCount = 1): any {
  return {
    session,
    projection: {
      sequence,
      view: {
        title: session.title,
        profileName: session.profileName,
        status: session.status,
        updatedAt: session.updatedAt,
        messages: [
          { id: `${session.sessionId}-user`, role: 'user', content: 'Summarize the workspace.', order: 1 },
          { id: `${session.sessionId}-assistant`, role: 'assistant', content: `Workspace summary for ${session.title}.`, order: 2 },
        ],
        toolCalls: [
          { id: `${session.sessionId}-tool`, name: 'repo.search', status: 'completed', input: { query: 'todo' }, output: { matches: 2 }, order: 3 },
        ],
        taskRuns: [
          {
            id: `${session.sessionId}-task`,
            title: 'Analysis task',
            agent: 'data-analyst',
            status: 'completed',
            content: 'Checked repository context.',
            sourceSessionId: `${session.sessionId}-child`,
            order: 4,
            artifacts: [
              {
                artifactId: `${session.sessionId}-task-artifact`,
                filename: 'task-summary.txt',
                signedUrl: 'https://object.example.test/task-signed?token=leaked-secret',
                objectKey: `tenant/session/${session.sessionId}/task-artifact`,
              },
            ],
          },
        ],
        pendingApprovals: [
          { id: `${session.sessionId}-approval`, tool: 'shell', description: 'Run read-only tests', input: { command: 'pnpm test' }, order: 5 },
        ],
        pendingQuestions: [
          {
            id: `${session.sessionId}-question`,
            questions: [{ header: 'Scope', question: 'Continue with deployment smoke?', options: [{ label: 'Yes' }, { label: 'No' }] }],
            order: 6,
          },
        ],
        resolvedApprovals: [],
        resolvedQuestions: [],
        artifacts: Array.from({ length: artifactCount }, (_, index) => ({
          artifactId: index === 0 ? `${session.sessionId}-artifact` : `${session.sessionId}-artifact-${index + 1}`,
          filename: index === 0 ? 'summary.txt' : `artifact-${index + 1}.txt`,
          contentType: 'text/plain',
          size: 24 + index,
          order: 7 + index,
          signedUrl: index === 0 ? 'https://object.example.test/signed?token=leaked-secret' : undefined,
          objectKey: `tenant/session/${session.sessionId}/artifact-${index + 1}`,
        })),
        todos: [{ id: 'todo-1', content: 'Verify browser workbench', status: 'done', priority: 'high' }],
        errors: [],
        sessionCost: 0.0123,
        sessionTokens: { input: 1000, output: 250, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        contextState: 'idle',
        compactionCount: 0,
        projectSource: session.sessionId.endsWith('0')
          ? { kind: 'git', repositoryUrl: 'https://github.com/example/repo.git' }
          : null,
        tags: session.tags,
        smartFilters: session.smartFilters,
      },
    },
  }
}

export function makeLaunchpadFeed(sessions: Array<ReturnType<typeof makeSession>>, views: Record<string, any>) {
  const firstSession = sessions[0]
  const firstView = firstSession ? views[firstSession.sessionId] : null
  const firstArtifact = firstView?.projection?.view?.artifacts?.[0]
  const firstApproval = firstView?.projection?.view?.pendingApprovals?.[0]
  return {
    generatedAt: iso(15),
    inProgress: firstSession ? [{
      id: 'task:launchpad',
      kind: 'task',
      title: 'Implement cloud launchpad',
      projectId: 'project-cloud',
      projectTitle: 'Studio redesign',
      taskId: 'task-launchpad',
      taskTitle: 'Cloud launchpad parity',
      sessionId: firstSession.sessionId,
      runId: 'run-launchpad',
      assigneeAgent: firstSession.profileName || 'build',
      status: 'running',
      priority: 'high',
      when: iso(16),
      updatedAt: iso(16),
    }] : [],
    waitingOnYou: firstSession && firstApproval ? [{
      id: `permission:${firstSession.sessionId}:${firstApproval.id}`,
      kind: 'permission',
      status: 'pending',
      title: String(firstApproval.description || 'Approve pending work'),
      projectId: 'project-cloud',
      projectTitle: 'Studio redesign',
      taskId: 'task-approval',
      taskTitle: 'Review launchpad',
      sessionId: firstSession.sessionId,
      runId: 'run-approval',
      assigneeAgent: firstSession.profileName || 'build',
      when: iso(17),
      updatedAt: iso(17),
    }] : [],
    freshArtifacts: firstSession && firstArtifact ? [{
      id: `artifact:${firstSession.sessionId}:${firstArtifact.artifactId}`,
      artifactId: firstArtifact.artifactId,
      kind: 'document',
      status: 'draft',
      title: firstArtifact.filename || 'summary.txt',
      projectId: 'project-cloud',
      projectTitle: 'Studio redesign',
      taskId: 'task-artifact',
      taskTitle: 'Document launchpad',
      sessionId: firstSession.sessionId,
      runId: 'run-artifact',
      assigneeAgent: firstSession.profileName || 'build',
      authorAgentId: firstSession.profileName || 'build',
      when: iso(18),
      createdAt: iso(18),
      updatedAt: iso(18),
    }] : [],
    totals: {
      inProgress: firstSession ? 1 : 0,
      waitingOnYou: firstSession && firstApproval ? 1 : 0,
      freshArtifacts: firstSession && firstArtifact ? 1 : 0,
    },
    truncated: { inProgress: false, waitingOnYou: false, freshArtifacts: false },
  }
}

export function makeMembers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    accountId: `acct-${index + 1}`,
    email: index === 0 ? 'owner@example.test' : index === 1 ? 'member@example.test' : `member-${index + 1}@example.test`,
    role: index === 0 ? 'owner' : index % 5 === 0 ? 'admin' : 'member',
    status: index % 13 === 0 && index !== 0 ? 'invited' : 'active',
    updatedAt: iso(index + 1),
  }))
}

export function makeTokens(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    tokenId: `token-${index + 1}`,
    name: index === 0 ? 'Desktop connection' : `Connection ${index + 1}`,
    last4: String(index + 1000).slice(-4),
    scopes: [index % 2 === 0 ? 'desktop' : 'gateway'],
    lastUsedAt: null,
    revokedAt: null,
  }))
}

export function makeDeliveries(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    deliveryId: `delivery-${index + 1}`,
    provider: index % 2 === 0 ? 'telegram' : 'slack',
    channelBindingId: 'binding-1',
    status: index % 3 === 0 ? 'failed' : 'pending',
    eventType: 'session.completed',
    attemptCount: index % 4,
    lastError: index === 0 ? 'failed with token=leaked-secret' : null,
    nextAttemptAt: iso(index + 3),
    updatedAt: iso(index + 4),
    target: { chatId: `chat-${index + 1}`, token: 'leaked-secret' },
    payload: { text: 'delivery payload', signedUrl: 'https://object.example.test/signed?token=leaked-secret' },
  }))
}

export function makeWorkers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    workerId: `worker-${index + 1}`,
    poolId: 'pool-1',
    displayName: index === 0 ? 'Worker one' : `Worker ${index + 1}`,
    status: index % 5 === 0 && index !== 0 ? 'paused' : 'active',
    version: 'test',
    currentLoad: index % 3,
    lastHeartbeatAt: iso(index + 5),
    lastErrorCode: null,
    lastErrorSummary: null,
  }))
}

export function makeWorkflows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `workflow-${index + 1}`,
    title: index === 0 ? 'Daily review' : `Workflow ${index + 1}`,
    instructions: 'Review changed work.',
    agentName: 'build',
    status: index % 7 === 0 && index !== 0 ? 'paused' : 'active',
    latestRunStatus: index % 3 === 0 ? 'completed' : 'queued',
    triggers: [{ type: 'manual', enabled: true }],
    updatedAt: iso(index + 5),
  }))
}

export function makeAuditEvents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `audit-${index + 1}`,
    eventType: index === 0 ? 'byok.updated' : 'session.prompted',
    actorType: 'user',
    actorId: 'user-1',
    targetType: index === 0 ? 'byok' : 'session',
    targetId: index === 0 ? 'anthropic' : `session-${index + 1}`,
    metadata: { token: 'leaked-secret', signedUrl: 'https://object.example.test/signed?token=leaked-secret', safe: `event-${index + 1}` },
    createdAt: iso(index + 8),
  }))
}

export function makeUsageEvents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `usage-${index + 1}`,
    eventType: 'prompt',
    quantity: 1,
    unit: 'count',
    createdAt: iso(index + 7),
    metadata: { token: 'leaked-secret' },
  }))
}
