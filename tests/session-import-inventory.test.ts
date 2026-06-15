import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSessionImportInventory,
  buildSessionImportRequest,
} from '../apps/desktop/src/main/session-import.ts'
import type { SessionRecord } from '../apps/desktop/src/main/session-registry.ts'
import type { SessionView } from '../packages/shared/src/session.ts'

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'local-session-1',
    title: 'Private /Users/alice/acme thread',
    directory: '/Users/alice/acme',
    opencodeDirectory: '/Users/alice/acme',
    createdAt: '2026-05-28T10:00:00.000Z',
    updatedAt: '2026-05-28T10:01:00.000Z',
    kind: 'interactive',
    workflowId: null,
    runId: null,
    providerId: 'anthropic',
    modelId: 'anthropic/claude',
    composerAgentName: null,
    composerModelId: null,
    composerReasoningVariant: null,
    summary: null,
    parentSessionId: null,
    changeSummary: null,
    revertedMessageId: null,
    managedByCowork: true,
    ...overrides,
  }
}

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  const fakeProviderKey = ['sk', 'secretsecretsecretsecret'].join('-')
  return {
    messages: [{
      id: 'user-1',
      role: 'user',
      content: `Inspect /Users/alice/acme/.env with key ${fakeProviderKey}`,
      timestamp: '2026-05-28T10:00:00.000Z',
      order: 1,
      attachments: [{
        mime: 'text/plain',
        url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`,
        filename: '/Users/alice/acme/private.txt',
      }],
    }, {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I found a local path at /tmp/private-output.txt',
      timestamp: '2026-05-28T10:00:01.000Z',
      order: 2,
    }],
    toolCalls: [{
      id: 'tool-1',
      name: 'read',
      input: { path: '/Users/alice/acme/.env' },
      status: 'complete',
      output: 'secret',
      order: 3,
    }],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    artifacts: [{
      id: 'artifact-1',
      toolId: 'tool-1',
      toolName: 'write',
      filePath: '/Users/alice/acme/.open-cowork/artifact.txt',
      filename: 'artifact.txt',
      order: 4,
      mime: 'text/plain',
      kind: 'document',
      status: 'in-review',
      authorAgentId: 'agent-writer',
      projectId: 'project-1',
      taskId: 'task-1',
      statusUpdatedBy: 'reviewer-1',
      statusUpdatedAt: '2026-05-28T10:00:02.000Z',
    }],
    errors: [],
    todos: [{
      id: 'todo-1',
      content: 'Clean /Users/alice/acme',
      status: 'pending',
      priority: 'medium',
    }],
    executionPlan: [],
    sessionCost: 0.12,
    sessionTokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 1,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 1,
    lastEventAt: 1,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
    ...overrides,
  }
}

test('local session import inventory redacts local paths and secret-like text', async () => {
  const fakeProviderKey = ['sk', 'secretsecretsecretsecret'].join('-')
  const record = sessionRecord()
  const view = sessionView()
  const inventory = buildSessionImportInventory(record, view)

  assert.equal(inventory.counts.messages, 2)
  assert.equal(inventory.counts.artifacts, 1)
  assert.equal(inventory.counts.attachments, 1)
  assert.equal(inventory.counts.projectSource, 1)
  assert.equal(inventory.warnings.some((warning) => warning.code === 'redacted-local-data'), true)
  assert.equal(JSON.stringify(inventory).includes('/Users/alice'), false)
  assert.equal(JSON.stringify(inventory).includes(fakeProviderKey), false)

  const request = await buildSessionImportRequest(record, view, {
    includeMessages: true,
    includeAttachments: true,
    includeArtifacts: true,
  }, async () => ({
    dataBase64: Buffer.from('artifact body').toString('base64'),
    contentType: 'text/plain',
  }))

  const serialized = JSON.stringify(request)
  assert.equal(serialized.includes('/Users/alice'), false)
  assert.equal(serialized.includes('/tmp/private-output'), false)
  assert.equal(serialized.includes(fakeProviderKey), false)
  assert.match(request.messages?.[0]?.content || '', /\[local path redacted\]/)
  assert.match(request.messages?.[0]?.content || '', /\[secret redacted\]/)
  assert.equal(request.messages?.[0]?.attachments?.[0]?.filename, 'private.txt')
  assert.equal(request.artifacts?.[0]?.filename, 'artifact.txt')
  assert.equal(request.artifacts?.[0]?.dataBase64, Buffer.from('artifact body').toString('base64'))
  assert.equal(request.artifacts?.[0]?.kind, 'document')
  assert.equal(request.artifacts?.[0]?.status, 'in-review')
  assert.equal(request.artifacts?.[0]?.authorAgentId, 'agent-writer')
  assert.equal(request.artifacts?.[0]?.projectId, 'project-1')
  assert.equal(request.artifacts?.[0]?.taskId, 'task-1')
  assert.equal(request.artifacts?.[0]?.statusUpdatedBy, 'reviewer-1')
  assert.equal(request.artifacts?.[0]?.statusUpdatedAt, '2026-05-28T10:00:02.000Z')
  assert.equal(request.itemCounts.projectSource, 0)
})
