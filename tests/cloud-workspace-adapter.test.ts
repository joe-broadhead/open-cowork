import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  CloudWorkspaceAdapter,
  cloudWorkspaceCacheKey,
} from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { FileCloudWorkspaceCache } from '../apps/desktop/src/main/cloud-workspace-cache.ts'
import type { CloudTransportAdapter } from '../apps/desktop/src/main/cloud/transport-adapter.ts'
import type { WorkflowRun, WorkflowStatus } from '@open-cowork/shared'

function workflowSummary(status: WorkflowStatus = 'active') {
  return {
    id: 'workflow-1',
    title: 'Daily report',
    instructions: 'Report',
    agentName: 'data-analyst',
    skillNames: [],
    toolIds: [],
    status,
    projectDirectory: null,
    draftSessionId: null,
    triggers: [],
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    nextRunAt: null,
    lastRunAt: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunSessionId: null,
    latestRunSummary: null,
    webhookUrl: null,
  }
}

function workflowDetail(status: WorkflowStatus = 'active') {
  return {
    ...workflowSummary(status),
    runs: [],
  }
}

function workflowRun(workflowId: string): WorkflowRun {
  return {
    id: 'run-1',
    workflowId,
    sessionId: 'session-1',
    triggerType: 'manual',
    triggerPayload: null,
    status: 'running',
    title: 'Daily report',
    summary: null,
    error: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    startedAt: '2026-05-27T10:00:00.000Z',
    finishedAt: null,
  }
}

function threadTag(name = 'Important') {
  return {
    id: 'tag-1',
    name,
    color: '#123456',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }
}

function smartFilter(name = 'Mine') {
  return {
    id: 'filter-1',
    name,
    query: { tagIds: ['tag-1'] },
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }
}

function transport(): CloudTransportAdapter {
  return {
    getConfig: async () => ({
      role: 'web',
      profileName: 'default',
      features: { sessions: true },
      allowedAgents: ['data-analyst'],
      allowedTools: ['read'],
      allowedMcps: [],
    }),
    getRuntimeStatus: async () => ({
      role: 'web',
      profileName: 'default',
      canExecute: false,
      commandProcessing: 'delegated',
      checkpoints: true,
      heartbeats: [],
    }),
    listSessions: async () => [{
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      opencodeSessionId: 'opencode-session-1',
      profileName: 'default',
      status: 'idle',
      title: 'Cloud session',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }],
    createSession: async () => ({
      session: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-2',
        opencodeSessionId: 'opencode-session-2',
        profileName: 'default',
        status: 'idle',
        title: 'New cloud session',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      },
      projection: null,
    }),
    getSession: async (sessionId) => ({
      session: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId,
        opencodeSessionId: `opencode-${sessionId}`,
        profileName: 'default',
        status: 'running',
        title: 'Cloud session',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:01:00.000Z',
      },
      projection: {
        tenantId: 'tenant-1',
        sessionId,
        sequence: 7,
        updatedAt: '2026-05-27T10:01:00.000Z',
        view: {
          sessionId,
          title: 'Cloud session',
          status: 'running',
          profileName: 'default',
          isGenerating: true,
          messages: [
            { id: 'm1', role: 'user', content: 'Hello', createdAt: '2026-05-27T10:00:01.000Z' },
            { id: 'm2', role: 'assistant', content: 'Hi', createdAt: '2026-05-27T10:00:02.000Z' },
          ],
          toolCalls: [{
            id: 'tool-1',
            name: 'read',
            input: { file: 'README.md' },
            status: 'complete',
            output: 'contents',
            order: 3,
          }],
          taskRuns: [],
          pendingApprovals: [{
            id: 'permission-1',
            sessionId,
            tool: 'bash',
            input: { command: 'git status' },
            description: 'Run git status',
            order: 4,
          }],
          pendingQuestions: [{
            id: 'question-1',
            sessionId,
            questions: [{
              header: 'Pick',
              question: 'Proceed?',
              options: [{ label: 'Yes', description: 'Continue' }],
            }],
          }],
          artifacts: [{
            id: 'artifact-1',
            toolId: 'cloud-artifact',
            toolName: 'cloud.artifact',
            filePath: 'cloud-artifact://artifact-1/result.txt',
            filename: 'result.txt',
            order: 5,
            source: 'cloud',
            cloudArtifactId: 'artifact-1',
            mime: 'text/plain',
          }],
          todos: [{ id: 'todo-1', content: 'Ship sync', status: 'in_progress', priority: 'high' }],
          errors: [],
          sessionCost: 0.42,
          sessionTokens: { input: 11, output: 7, reasoning: 3, cacheRead: 2, cacheWrite: 1 },
          lastInputTokens: 11,
          lastError: null,
          updatedAt: '2026-05-27T10:01:00.000Z',
        },
      },
    }),
    promptSession: async () => ({
      command: {
        commandId: 'command-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
        kind: 'prompt',
        payload: {},
        targetLeaseToken: null,
        createdSequence: 1,
        createdAt: '2026-05-27T10:00:00.000Z',
        status: 'acked',
        claimedBy: null,
        claimedLeaseToken: null,
        ackedAt: null,
        error: null,
      },
      processed: 1,
      view: {
        session: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'session-1',
          opencodeSessionId: 'opencode-session-1',
          profileName: 'default',
          status: 'running',
          title: 'Cloud session',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:01:00.000Z',
        },
        projection: null,
      },
    }),
    abortSession: async () => ({
      command: {
        commandId: 'command-2',
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
        kind: 'abort',
        payload: {},
        targetLeaseToken: null,
        createdSequence: 2,
        createdAt: '2026-05-27T10:00:00.000Z',
        status: 'acked',
        claimedBy: null,
        claimedLeaseToken: null,
        ackedAt: null,
        error: null,
      },
      processed: 1,
      view: {
        session: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'session-1',
          opencodeSessionId: 'opencode-session-1',
          profileName: 'default',
          status: 'idle',
          title: 'Cloud session',
          createdAt: '2026-05-27T10:00:00.000Z',
          updatedAt: '2026-05-27T10:01:00.000Z',
        },
        projection: null,
      },
    }),
    replyToQuestion: async () => ({ command: {} as never, processed: 1 }),
    respondToPermission: async () => ({ command: {} as never, processed: 1 }),
    listWorkflows: async () => ({
      workflows: [workflowSummary()],
      runs: [],
    }),
    getWorkflow: async () => workflowDetail(),
    runWorkflow: async (workflowId) => workflowRun(workflowId),
    pauseWorkflow: async () => workflowDetail('paused'),
    resumeWorkflow: async () => workflowDetail('active'),
    archiveWorkflow: async () => workflowDetail('archived'),
    searchThreads: async () => ({
      threads: [{
        sessionId: 'session-1',
        title: 'Cloud thread',
        directory: null,
        projectLabel: null,
        providerId: null,
        modelId: null,
        status: 'running',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:01:00.000Z',
        parentSessionId: null,
        workflowId: null,
        runId: null,
        revertedMessageId: null,
        tags: [threadTag()],
        actualAgents: [],
        actualTools: [],
        suggestions: [],
        usage: {
          messages: 0,
          toolCalls: 0,
          taskRuns: 0,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        },
        changeSummary: null,
      }],
      nextCursor: null,
      totalEstimate: 1,
    }),
    threadFacets: async () => ({
      projects: [],
      providers: [],
      models: [],
      agents: [],
      tools: [],
      mcps: [],
      statuses: [],
      tags: [{ value: 'tag-1', label: 'Important', color: '#123456', count: 1 }],
    }),
    listThreadTags: async () => [threadTag()],
    createThreadTag: async (input) => ({ ...threadTag(input.name), color: input.color || '#123456' }),
    updateThreadTag: async (_tagId, input) => ({ ...threadTag(input.name), color: input.color || '#123456' }),
    deleteThreadTag: async () => true,
    applyThreadTags: async () => true,
    removeThreadTags: async () => true,
    listThreadSmartFilters: async () => [smartFilter()],
    createThreadSmartFilter: async (input) => ({ ...smartFilter(input.name), query: input.query }),
    updateThreadSmartFilter: async (_filterId, input) => ({ ...smartFilter(input.name), query: input.query }),
    deleteThreadSmartFilter: async () => true,
    listArtifacts: async () => [{
      id: 'artifact-1',
      toolId: 'cloud-artifact',
      toolName: 'cloud.artifact',
      filePath: 'cloud-artifact://artifact-1/result.txt',
      filename: 'result.txt',
      order: 0,
      source: 'cloud',
      cloudArtifactId: 'artifact-1',
      mime: 'text/plain',
    }],
    uploadArtifact: async (_sessionId, input) => ({
      id: 'artifact-2',
      toolId: 'cloud-artifact',
      toolName: 'cloud.artifact',
      filePath: 'cloud-artifact://artifact-2/upload.txt',
      filename: input.filename,
      order: 0,
      source: 'cloud',
      cloudArtifactId: 'artifact-2',
      mime: input.contentType || undefined,
    }),
    readArtifactAttachment: async () => ({
      mime: 'text/plain',
      filename: 'result.txt',
      url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
    }),
    listCapabilityTools: async () => [{
      id: 'read',
      name: 'Read',
      description: 'Read files',
      kind: 'built-in',
      source: 'builtin',
      patterns: ['read'],
      agentNames: ['build'],
    }],
    getCapabilityTool: async () => ({
      id: 'read',
      name: 'Read',
      description: 'Read files',
      kind: 'built-in',
      source: 'builtin',
      patterns: ['read'],
      agentNames: ['build'],
    }),
    listCapabilitySkills: async () => [{
      name: 'analysis',
      label: 'Analysis',
      description: 'Analyze data',
      source: 'builtin',
      toolIds: ['read'],
      agentNames: ['data-analyst'],
    }],
    getCapabilitySkillBundle: async () => ({
      name: 'analysis',
      source: 'builtin',
      content: '# Analysis',
      files: [{ path: 'examples/report.md' }],
    }),
    readCapabilitySkillBundleFile: async () => 'report example',
    listSettings: async () => [{
      key: 'portable-settings',
      value: { selectedProviderId: 'anthropic' },
      updatedAt: '2026-05-27T10:00:00.000Z',
    }],
    getSetting: async () => ({
      key: 'portable-settings',
      value: { selectedProviderId: 'anthropic' },
      updatedAt: '2026-05-27T10:00:00.000Z',
    }),
    setSetting: async (_key, value) => ({
      key: 'portable-settings',
      value,
      updatedAt: '2026-05-27T10:01:00.000Z',
    }),
    workspaceEventsUrl: () => 'https://cloud.example.test/api/events',
    sessionEventsUrl: () => 'https://cloud.example.test/api/sessions/session-1/events',
    subscribeWorkspaceEvents: () => ({ close() {} }),
    subscribeSessionEvents: () => ({ close() {} }),
  }
}

function failingTransport(): CloudTransportAdapter {
  const fail = async () => {
    throw new Error('offline')
  }
  return {
    getConfig: fail,
    getRuntimeStatus: fail,
    listSessions: fail,
    createSession: fail,
    getSession: fail,
    promptSession: fail,
    abortSession: fail,
    replyToQuestion: fail,
    respondToPermission: fail,
    listWorkflows: fail,
    getWorkflow: fail,
    runWorkflow: fail,
    pauseWorkflow: fail,
    resumeWorkflow: fail,
    archiveWorkflow: fail,
    searchThreads: fail,
    threadFacets: fail,
    listThreadTags: fail,
    createThreadTag: fail,
    updateThreadTag: fail,
    deleteThreadTag: fail,
    applyThreadTags: fail,
    removeThreadTags: fail,
    listThreadSmartFilters: fail,
    createThreadSmartFilter: fail,
    updateThreadSmartFilter: fail,
    deleteThreadSmartFilter: fail,
    listArtifacts: fail,
    uploadArtifact: fail,
    readArtifactAttachment: fail,
    listSettings: fail,
    getSetting: fail,
    setSetting: fail,
    workspaceEventsUrl: () => 'https://cloud.example.test/api/events',
    sessionEventsUrl: () => 'https://cloud.example.test/api/sessions/session-1/events',
    subscribeWorkspaceEvents: () => ({ close() {} }),
    subscribeSessionEvents: () => ({ close() {} }),
  }
}

test('cloud workspace adapter maps cloud records to desktop session contracts', async () => {
  const adapter = new CloudWorkspaceAdapter({
    connection: {
      id: 'cloud:test',
      baseUrl: 'https://cloud.example.test',
      label: 'Test Cloud',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      lastSyncedAt: null,
    },
    transport: transport(),
    cache: null,
  })

  const policy = await adapter.policy()
  assert.equal(policy.localFiles, 'disabled')
  assert.deepEqual(policy.allowedAgents, ['data-analyst'])

  const sessions = await adapter.listSessions()
  assert.equal(sessions[0]?.id, 'session-1')
  assert.equal(sessions[0]?.directory, null)

  const created = await adapter.createSession()
  assert.equal(created.id, 'session-2')

  const view = await adapter.getSessionView('session-1')
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[0]?.content, 'Hello')
  assert.equal(view.revision, 7)
  assert.equal(view.toolCalls[0]?.name, 'read')
  assert.equal(view.pendingApprovals[0]?.id, 'permission-1')
  assert.equal(view.pendingQuestions[0]?.id, 'question-1')
  assert.equal(view.artifacts?.[0]?.cloudArtifactId, 'artifact-1')
  assert.equal(view.todos[0]?.content, 'Ship sync')
  assert.equal(view.sessionCost, 0.42)
  assert.equal(view.sessionTokens.cacheRead, 2)
  assert.equal(view.isGenerating, false)
  assert.equal(view.isAwaitingPermission, true)
  assert.equal(view.isAwaitingQuestion, true)

  assert.equal((await adapter.listWorkflows()).workflows[0]?.id, 'workflow-1')
  assert.equal((await adapter.getWorkflow('workflow-1'))?.id, 'workflow-1')
  assert.equal((await adapter.runWorkflow('workflow-1'))?.id, 'run-1')
  assert.equal((await adapter.pauseWorkflow('workflow-1'))?.status, 'paused')
  assert.equal((await adapter.resumeWorkflow('workflow-1'))?.status, 'active')
  assert.equal((await adapter.archiveWorkflow('workflow-1'))?.status, 'archived')

  assert.equal((await adapter.searchThreads({ tagIds: ['tag-1'] })).threads[0]?.sessionId, 'session-1')
  assert.equal((await adapter.threadFacets()).tags[0]?.value, 'tag-1')
  assert.equal((await adapter.listThreadTags())[0]?.id, 'tag-1')
  assert.equal((await adapter.createThreadTag({ name: 'New' })).name, 'New')
  assert.equal((await adapter.updateThreadTag('tag-1', { name: 'Renamed' }))?.name, 'Renamed')
  assert.equal(await adapter.applyThreadTags(['session-1'], ['tag-1']), true)
  assert.equal(await adapter.removeThreadTags(['session-1'], ['tag-1']), true)
  assert.equal(await adapter.deleteThreadTag('tag-1'), true)
  assert.equal((await adapter.listThreadSmartFilters())[0]?.id, 'filter-1')
  assert.equal((await adapter.createThreadSmartFilter({ name: 'New filter', query: {} })).name, 'New filter')
  assert.equal((await adapter.updateThreadSmartFilter('filter-1', { name: 'Updated filter', query: {} }))?.name, 'Updated filter')
  assert.equal(await adapter.deleteThreadSmartFilter('filter-1'), true)
  assert.equal((await adapter.listArtifacts('session-1'))[0]?.cloudArtifactId, 'artifact-1')
  assert.equal((await adapter.uploadArtifact({
    sessionId: 'session-1',
    filename: 'upload.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('hello').toString('base64'),
  })).cloudArtifactId, 'artifact-2')
  assert.equal((await adapter.readArtifactAttachment('session-1', 'cloud-artifact://artifact-1/result.txt')).filename, 'result.txt')
  assert.equal((await adapter.listCapabilityTools())[0]?.id, 'read')
  assert.equal((await adapter.getCapabilityTool('read'))?.name, 'Read')
  assert.equal((await adapter.listCapabilitySkills())[0]?.name, 'analysis')
  assert.equal((await adapter.getCapabilitySkillBundle('analysis'))?.name, 'analysis')
  assert.equal(await adapter.readCapabilitySkillBundleFile('analysis', 'examples/report.md'), 'report example')
  assert.equal((await adapter.listSettings())[0]?.key, 'portable-settings')
  assert.equal((await adapter.getSetting('portable-settings'))?.value.selectedProviderId, 'anthropic')
  assert.equal((await adapter.setSetting('portable-settings', { selectedProviderId: 'openai' })).value.selectedProviderId, 'openai')
})

test('cloud workspace adapter blocks local attachments in cloud prompts', async () => {
  const adapter = new CloudWorkspaceAdapter({
    connection: {
      id: 'cloud:test',
      baseUrl: 'https://cloud.example.test',
      label: 'Test Cloud',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      lastSyncedAt: null,
    },
    transport: transport(),
    cache: null,
  })

  await assert.rejects(
    () => adapter.promptSession('session-1', {
      text: 'hello',
      attachments: [{ mime: 'text/plain', url: 'file:///tmp/local.txt' }],
    }),
    /local attachments/,
  )
})

test('cloud workspace adapter falls back to read-only cached state when transport is unavailable', async () => {
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-adapter-cache-')), 'cloud-workspace-cache.json'),
    mode: 'full',
    secretStorage: {
      mode: 'plaintext',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf-8'),
      decryptString: (encrypted) => encrypted.toString('utf-8'),
    },
  })
  const connection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Test Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }
  const online = new CloudWorkspaceAdapter({
    connection,
    transport: transport(),
    cache,
  })
  await online.listSessions()
  await online.getSessionView('session-1')
  await online.listWorkflows()
  await online.listArtifacts('session-1')
  await online.listSettings()

  const offline = new CloudWorkspaceAdapter({
    connection,
    transport: failingTransport(),
    cache,
  })

  assert.equal((await offline.listSessions())[0]?.id, 'session-1')
  assert.equal((await offline.getSessionInfo('session-1'))?.title, 'Cloud session')
  assert.equal((await offline.getSessionView('session-1')).messages[0]?.content, 'Hello')
  assert.equal((await offline.listWorkflows()).workflows[0]?.id, 'workflow-1')
  assert.equal((await offline.listArtifacts('session-1'))[0]?.cloudArtifactId, 'artifact-1')
  assert.equal((await offline.listSettings())[0]?.key, 'portable-settings')
  await assert.rejects(
    () => offline.promptSession('session-1', { text: 'mutate while offline' }),
    /offline/,
  )
})

test('cloud workspace adapter isolates cached state by connection tenant user and profile', async () => {
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-adapter-cache-isolation-')), 'cloud-workspace-cache.json'),
    mode: 'full',
    secretStorage: {
      mode: 'plaintext',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf-8'),
      decryptString: (encrypted) => encrypted.toString('utf-8'),
    },
  })
  const baseConnection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Test Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }
  const tenantA = {
    ...baseConnection,
    tenantId: 'tenant-a',
    userId: 'user-a',
    profileName: 'full',
  }
  const tenantB = {
    ...baseConnection,
    tenantId: 'tenant-b',
    userId: 'user-b',
    profileName: 'full',
  }
  const online = new CloudWorkspaceAdapter({
    connection: tenantA,
    transport: transport(),
    cache,
  })

  await online.listSessions()
  await online.getSessionView('session-1')

  const offlineOtherTenant = new CloudWorkspaceAdapter({
    connection: tenantB,
    transport: failingTransport(),
    cache,
  })

  assert.notEqual(cloudWorkspaceCacheKey(tenantA), cloudWorkspaceCacheKey(tenantB))
  assert.equal(cache.listSessions(cloudWorkspaceCacheKey(tenantA))?.[0]?.id, 'session-1')
  assert.equal(cache.listSessions(cloudWorkspaceCacheKey(tenantB)), null)
  await assert.rejects(
    () => offlineOtherTenant.listSessions(),
    /offline/,
  )
})

test('cloud workspace adapter ignores cached session cursors until caller provides a hydrated stream cursor', async () => {
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-adapter-cursor-')), 'cloud-workspace-cache.json'),
    mode: 'metadata-only',
    secretStorage: {
      mode: 'plaintext',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf-8'),
      decryptString: (encrypted) => encrypted.toString('utf-8'),
    },
  })
  const connection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Test Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }
  const cacheKey = cloudWorkspaceCacheKey(connection)
  cache.setEventCursor(cacheKey, 'session:session-1', 41)
  let observedAfterSequence: number | undefined
  const adapter = new CloudWorkspaceAdapter({
    connection,
    cache,
    transport: {
      ...transport(),
      subscribeSessionEvents: (_sessionId, input) => {
        observedAfterSequence = input.afterSequence
        input.onEvent({
          eventId: 'event-42',
          sequence: 42,
          sessionId: 'session-1',
          type: 'assistant.message',
          payload: { content: 'hello' },
        })
        return { close() {} }
      },
    },
  })

  adapter.subscribeSessionEvents('session-1', {
    onEvent: () => {},
  })

  assert.equal(observedAfterSequence, undefined)
  assert.equal(cache.getEventCursor(cacheKey, 'session:session-1'), 42)
})

test('cloud workspace adapter resumes workspace event streams from cached cursors', async () => {
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-adapter-workspace-cursor-')), 'cloud-workspace-cache.json'),
    mode: 'metadata-only',
    secretStorage: {
      mode: 'plaintext',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf-8'),
      decryptString: (encrypted) => encrypted.toString('utf-8'),
    },
  })
  const connection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Test Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }
  const cacheKey = cloudWorkspaceCacheKey(connection)
  cache.setEventCursor(cacheKey, 'workspace', 100)
  let observedAfterSequence: number | undefined
  const adapter = new CloudWorkspaceAdapter({
    connection,
    cache,
    transport: {
      ...transport(),
      subscribeWorkspaceEvents: (input) => {
        observedAfterSequence = input.afterSequence
        input.onEvent({
          eventId: 'event-101',
          sequence: 101,
          sessionId: 'session-1',
          type: 'session.status',
          payload: { statusType: 'running' },
        })
        return { close() {} }
      },
    },
  })

  adapter.subscribeWorkspaceEvents({
    onEvent: () => {},
  })

  assert.equal(observedAfterSequence, 100)
  assert.equal(cache.getEventCursor(cacheKey, 'workspace'), 101)
})

test('cloud workspace adapter refreshes snapshots and resets cursor on workspace retention gap', async () => {
  const cache = new FileCloudWorkspaceCache({
    path: join(mkdtempSync(join(tmpdir(), 'open-cowork-adapter-snapshot-required-')), 'cloud-workspace-cache.json'),
    mode: 'full',
    secretStorage: {
      mode: 'plaintext',
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf-8'),
      decryptString: (encrypted) => encrypted.toString('utf-8'),
    },
  })
  const connection = {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Test Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }
  const base = transport()
  const cacheKey = cloudWorkspaceCacheKey(connection)
  cache.setEventCursor(cacheKey, 'workspace', 100)
  let observedAfterSequence: number | undefined
  let listSessionsCount = 0
  let getSessionCount = 0
  let listWorkflowsCount = 0
  let listSettingsCount = 0
  let listArtifactsCount = 0
  const delivered = new Promise<void>((resolve, reject) => {
    const adapter = new CloudWorkspaceAdapter({
      connection,
      cache,
      transport: {
        ...base,
        listSessions: async () => {
          listSessionsCount += 1
          return base.listSessions()
        },
        getSession: async (sessionId) => {
          getSessionCount += 1
          return base.getSession(sessionId)
        },
        listWorkflows: async () => {
          listWorkflowsCount += 1
          return base.listWorkflows?.() as ReturnType<NonNullable<CloudTransportAdapter['listWorkflows']>>
        },
        listSettings: async () => {
          listSettingsCount += 1
          return base.listSettings?.() as ReturnType<NonNullable<CloudTransportAdapter['listSettings']>>
        },
        listArtifacts: async (sessionId) => {
          listArtifactsCount += 1
          return base.listArtifacts?.(sessionId) as ReturnType<NonNullable<CloudTransportAdapter['listArtifacts']>>
        },
        subscribeWorkspaceEvents: (input) => {
          observedAfterSequence = input.afterSequence
          input.onEvent({
            eventId: 'snapshot-required:100',
            sequence: 100,
            type: 'snapshot.required',
            payload: {
              reason: 'event_retention_gap',
              afterSequence: 100,
            },
          })
          return { close() {} }
        },
      },
    })

    adapter.subscribeWorkspaceEvents({
      onEvent: (event) => {
        try {
          assert.equal(event.type, 'snapshot.required')
          resolve()
        } catch (error) {
          reject(error)
        }
      },
      onError: reject,
    })
  })

  await delivered

  assert.equal(observedAfterSequence, 100)
  assert.equal(listSessionsCount, 1)
  assert.equal(getSessionCount, 1)
  assert.equal(listArtifactsCount, 1)
  assert.equal(listWorkflowsCount, 1)
  assert.equal(listSettingsCount, 1)
  assert.equal(cache.getEventCursor(cacheKey, 'workspace'), 0)
  assert.equal(cache.listSessions(cacheKey)?.[0]?.id, 'session-1')
  assert.equal(cache.getSessionView(cacheKey, 'session-1')?.messages[0]?.content, 'Hello')
  assert.equal(cache.getWorkflowList(cacheKey)?.workflows[0]?.id, 'workflow-1')
  assert.equal(cache.listSettings(cacheKey)?.[0]?.key, 'portable-settings')
  assert.equal(cache.listArtifacts(cacheKey, 'session-1')?.[0]?.cloudArtifactId, 'artifact-1')
})
