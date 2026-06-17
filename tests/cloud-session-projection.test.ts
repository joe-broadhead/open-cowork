import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimePromptPart,
} from '../apps/desktop/src/main/cloud/runtime-adapter.ts'
import { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'
import { cloudSessionViewToSessionView } from '../packages/shared/dist/cloud-session-projection.js'

class FakeRuntime implements CloudRuntimeAdapter {
  async createSession() {
    return {
      id: 'session-1',
      title: 'Projection session',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }
  }

  async promptSession(_input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    return { events: [] }
  }

  async abortSession(_input: { sessionId: string }) {}
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

test('cloud session projection persists approvals questions tools todos costs and resolution state', async () => {
  const service = new CloudSessionService(
    new InMemoryControlPlaneStore(),
    new FakeRuntime(),
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
  )
  const principal = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const created = await service.createSession(principal)
  const sessionId = created.session.sessionId

  await service.appendProductEvent(principal, sessionId, {
    type: 'tool.call',
    payload: {
      id: 'tool-1',
      name: 'read',
      input: { file: 'README.md' },
      status: 'complete',
      output: 'contents',
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      sessionId: 'opencode-runtime-session-1',
      tool: 'bash',
      input: { command: 'git status' },
      description: 'Run git status',
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'question.asked',
    payload: {
      requestId: 'question-1',
      sessionId: 'opencode-runtime-session-1',
      questions: [{
        header: 'Pick',
        question: 'Proceed?',
        options: [{ label: 'Yes', description: 'Continue' }],
      }],
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'todos.updated',
    payload: {
      todos: [{ id: 'todo-1', content: 'Ship sync', status: 'in_progress', priority: 'high' }],
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'cost.updated',
    payload: {
      cost: 0.42,
      tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 2, write: 1 } },
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'artifact.created',
    payload: {
      artifactId: 'artifact-1',
      sessionId,
      filename: 'result.txt',
      contentType: 'text/plain',
      size: 5,
      key: 'tenant/session/artifact-1/result.txt',
      createdAt: '2026-05-27T10:02:00.000Z',
      updatedAt: '2026-05-27T10:02:00.000Z',
      kind: 'document',
      status: 'draft',
      projectId: 'project-1',
      taskId: 'task-1',
    },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'artifact.updated',
    payload: {
      artifactId: 'artifact-1',
      sessionId,
      filename: 'result.txt',
      contentType: 'text/plain',
      size: 5,
      key: 'tenant/session/artifact-1/result.txt',
      createdAt: '2026-05-27T10:02:00.000Z',
      updatedAt: '2026-05-27T10:03:00.000Z',
      kind: 'document',
      status: 'in-review',
      projectId: 'project-1',
      taskId: 'task-1',
      statusUpdatedBy: 'reviewer-1',
      statusUpdatedAt: '2026-05-27T10:03:00.000Z',
    },
  })

  const pending = asRecord(asRecord((await service.getSessionView(principal, sessionId)).projection).view)
  assert.equal(asArray(pending.toolCalls).length, 1)
  assert.equal(asRecord(asArray(pending.toolCalls)[0]).name, 'read')
  assert.equal(asArray(pending.pendingApprovals).length, 1)
  const pendingApproval = asRecord(asArray(pending.pendingApprovals)[0])
  assert.equal(pendingApproval.sessionId, sessionId)
  assert.equal(pendingApproval.description, 'Run git status')
  assert.equal(asArray(pending.pendingQuestions).length, 1)
  const pendingQuestion = asRecord(asArray(pending.pendingQuestions)[0])
  assert.equal(pendingQuestion.sessionId, sessionId)
  assert.equal(pendingQuestion.id, 'question-1')
  assert.equal(asArray(pending.todos).length, 1)
  assert.equal(asRecord(asArray(pending.todos)[0]).content, 'Ship sync')
  assert.equal(asRecord(asArray(pending.artifacts)[0]).cloudArtifactId, 'artifact-1')
  assert.equal(asRecord(asArray(pending.artifacts)[0]).filePath, 'cloud-artifact://artifact-1/result.txt')
  assert.equal(asRecord(asArray(pending.artifacts)[0]).status, 'in-review')
  assert.equal(asRecord(asArray(pending.artifacts)[0]).projectId, 'project-1')
  assert.equal(asRecord(asArray(pending.artifacts)[0]).statusUpdatedBy, 'reviewer-1')
  assert.equal(pending.sessionCost, 0.42)
  assert.equal(asRecord(pending.sessionTokens).cacheRead, 2)
  assert.equal(pending.lastInputTokens, 11)
  assert.equal(pending.isGenerating, false)
  const sessionView = cloudSessionViewToSessionView(await service.getSessionView(principal, sessionId))
  assert.equal(sessionView.toolCalls.length, 1)
  assert.equal(sessionView.pendingApprovals.length, 1)
  assert.equal(sessionView.pendingQuestions.length, 1)
  assert.equal(sessionView.artifacts[0]?.cloudArtifactId, 'artifact-1')
  assert.equal(sessionView.artifacts[0]?.status, 'in-review')
  assert.equal(sessionView.sessionTokens.cacheRead, 2)

  await service.appendProductEvent(principal, sessionId, {
    type: 'permission.resolved',
    payload: { permissionId: 'permission-1', allowed: true },
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'question.resolved',
    payload: { requestId: 'question-1', answers: ['Yes'] },
  })

  const resolved = asRecord(asRecord((await service.getSessionView(principal, sessionId)).projection).view)
  assert.equal(asArray(resolved.pendingApprovals).length, 0)
  assert.equal(asArray(resolved.pendingQuestions).length, 0)
  assert.equal(asRecord(asArray(resolved.resolvedApprovals)[0]).allowed, true)
  assert.equal(asRecord(asArray(resolved.resolvedApprovals)[0]).description, 'Run git status')
  assert.equal(asRecord(asArray(resolved.resolvedQuestions)[0]).rejected, false)
  assert.deepEqual(asArray(asRecord(asArray(resolved.resolvedQuestions)[0]).answers), ['Yes'])
})

test('cloud assistant chunks keep projection running until explicit idle event', async () => {
  const store = new InMemoryControlPlaneStore()
  const service = new CloudSessionService(
    store,
    new FakeRuntime(),
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
  )
  const principal = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const created = await service.createSession(principal)
  const sessionId = created.session.sessionId

  await store.updateSessionStatus({
    tenantId: principal.tenantId,
    sessionId,
    status: 'running',
  })
  await service.appendProductEvent(principal, sessionId, {
    type: 'prompt.submitted',
    payload: {
      messageId: 'command-1:user',
      text: 'stream a long answer',
      agent: 'build',
    },
  })
  await service.appendRuntimeEvent({
    tenantId: principal.tenantId,
    sessionId,
    event: {
      type: 'assistant.message',
      payload: {
        messageId: 'assistant-1',
        content: 'partial answer',
      },
    },
  })

  const chunkView = asRecord(asRecord((await service.getSessionView(principal, sessionId)).projection).view)
  assert.equal(chunkView.status, 'running')
  assert.equal(chunkView.isGenerating, true)
  assert.equal((await store.getSessionForTenant(principal.tenantId, sessionId))?.status, 'running')

  await service.appendRuntimeEvent({
    tenantId: principal.tenantId,
    sessionId,
    event: {
      type: 'session.idle',
      payload: { sessionId },
    },
  })

  const idleView = asRecord(asRecord((await service.getSessionView(principal, sessionId)).projection).view)
  assert.equal(idleView.status, 'idle')
  assert.equal(idleView.isGenerating, false)
  assert.equal((await store.getSessionForTenant(principal.tenantId, sessionId))?.status, 'idle')
})

test('cloud session projection repair rebuilds durable view from ordered event log', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test', role: 'owner' })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'repair-session',
    opencodeSessionId: 'runtime-repair-session',
    profileName: 'full',
    title: 'Repair me',
    createdAt: new Date('2026-05-27T10:00:00.000Z'),
  })
  const service = new CloudSessionService(
    store,
    new FakeRuntime(),
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
  )
  const principal = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.test',
    authSource: 'local' as const,
  }

  store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'repair-session',
    type: 'prompt.submitted',
    payload: {
      messageId: 'repair:user',
      text: 'rebuild from events',
      agent: 'build',
    },
    createdAt: new Date('2026-05-27T10:01:00.000Z'),
  })
  store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'repair-session',
    type: 'assistant.message',
    payload: {
      messageId: 'repair:assistant',
      content: 'projection repaired',
    },
    createdAt: new Date('2026-05-27T10:02:00.000Z'),
  })
  assert.equal(await store.getSessionProjection('tenant-1', 'repair-session'), null)
  const statusBeforeRepair = await service.getSessionProjectionStatus(principal, 'repair-session')
  assert.equal(statusBeforeRepair.latestEventSequence, 2)
  assert.equal(statusBeforeRepair.projectionSequence, 0)
  assert.equal(statusBeforeRepair.lag, 2)

  const repaired = await service.repairSessionProjection(principal, 'repair-session')
  assert.equal(repaired.repaired, true)
  assert.equal(repaired.eventCount, 2)
  assert.equal(repaired.latestEventSequence, 2)
  assert.equal(repaired.projectionSequence, 2)
  assert.equal(repaired.lag, 0)

  const view = asRecord(asRecord((await service.getSessionView(principal, 'repair-session')).projection).view)
  assert.deepEqual(asArray(view.messages).map((message) => asRecord(message).content), [
    'rebuild from events',
    'projection repaired',
  ])

  const secondPass = await service.repairSessionProjection(principal, 'repair-session')
  assert.equal(secondPass.repaired, false)
  assert.equal(secondPass.projectionSequence, 2)
})
