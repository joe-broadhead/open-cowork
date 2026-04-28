import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionView, ToolCall } from '@open-cowork/shared'
import { isReadableSessionArtifact, listKnownSessionArtifactPaths } from '../apps/desktop/src/main/session-artifact-access.ts'

function createTool(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: overrides.id || 'tool-1',
    name: overrides.name || 'write',
    input: overrides.input || {},
    status: overrides.status || 'complete',
    output: overrides.output,
    attachments: overrides.attachments,
    agent: overrides.agent,
    sourceSessionId: overrides.sourceSessionId,
    order: overrides.order || 1,
  }
}

function createView(): SessionView {
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
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
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
  }
}

test('listKnownSessionArtifactPaths includes surfaced write/edit outputs across session and task tools', () => {
  const view = createView()
  view.toolCalls = [
    createTool({ id: 'write-tool', name: 'write', input: { filePath: '/tmp/report.txt' } }),
    createTool({ id: 'ignored-tool', name: 'read', input: { filePath: '/tmp/ignored.txt' }, order: 2 }),
  ]
  view.taskRuns = [{
    id: 'task-1',
    title: 'Task',
    agent: null,
    status: 'complete',
    sourceSessionId: null,
    content: '',
    transcript: [],
    toolCalls: [
      createTool({ id: 'edit-tool', name: 'edit', input: { path: '/tmp/from-task.csv' } }),
    ],
    compactions: [],
    todos: [],
    error: null,
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    order: 1,
  }]

  const known = listKnownSessionArtifactPaths(view)

  assert.deepEqual(Array.from(known).sort(), ['/tmp/from-task.csv', '/tmp/report.txt'])
})

test('isReadableSessionArtifact rejects arbitrary files that were not surfaced as artifacts', () => {
  const view = createView()
  view.toolCalls = [
    createTool({ id: 'write-tool', name: 'write', input: { filePath: '/tmp/report.txt' } }),
  ]

  assert.equal(isReadableSessionArtifact(view, '/tmp/report.txt'), true)
  assert.equal(isReadableSessionArtifact(view, '/tmp/secrets.txt'), false)
})

test('isReadableSessionArtifact matches safe symlink aliases by real path', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-surfaced-artifact-'))
  try {
    const realDir = join(root, 'real')
    const aliasDir = join(root, 'alias')
    mkdirSync(realDir)
    symlinkSync(realDir, aliasDir, 'dir')
    const aliasPath = join(aliasDir, 'report.txt')
    const realPath = join(realDir, 'report.txt')
    writeFileSync(realPath, 'report')

    const view = createView()
    view.toolCalls = [
      createTool({ id: 'write-tool', name: 'write', input: { filePath: aliasPath } }),
    ]

    assert.equal(isReadableSessionArtifact(view, realPath), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
