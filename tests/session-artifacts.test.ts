import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionView, ToolCall } from '@open-cowork/shared'
import { artifactForTool, listArtifactsForTools, listSessionArtifacts, sanitizeArtifactToolInput } from '../apps/desktop/src/renderer/components/chat/session-artifacts.ts'

function tool(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'write',
    input: {},
    status: 'complete',
    order: 1,
    ...overrides,
  }
}

function emptyView(): SessionView {
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

test('listSessionArtifacts extracts downloadable files from write tools', () => {
  const view = emptyView()
  view.toolCalls = [
    tool({
      id: 'write-1',
      input: { filePath: '/tmp/report.txt', content: 'hello' },
      order: 10,
    }),
  ]

  assert.deepEqual(listSessionArtifacts(view), [
    {
      id: 'session:write-1:/tmp/report.txt',
      toolId: 'write-1',
      toolName: 'write',
      filePath: '/tmp/report.txt',
      filename: 'report.txt',
      order: 10,
      taskRunId: null,
    },
  ])
})

test('sanitizeArtifactToolInput hides sandbox file paths behind artifact urls', () => {
  const artifact = artifactForTool(tool({
    id: 'write-2',
    input: { filePath: '/tmp/output.csv', content: 'a,b,c' },
  }))

  assert.ok(artifact)
  assert.deepEqual(
    sanitizeArtifactToolInput(
      { filePath: '/tmp/output.csv', content: 'a,b,c' },
      artifact,
    ),
    { filePath: 'artifact://output.csv', content: 'a,b,c' },
  )
})

test('listArtifactsForTools keeps the latest artifact per file path', () => {
  const artifacts = listArtifactsForTools([
    tool({
      id: 'write-old',
      input: { filePath: '/tmp/output.csv', content: 'old' },
      order: 2,
    }),
    tool({
      id: 'write-new',
      input: { filePath: '/tmp/output.csv', content: 'new' },
      order: 9,
    }),
    tool({
      id: 'write-other',
      input: { filePath: '/tmp/summary.txt', content: 'report' },
      order: 4,
    }),
  ])

  assert.deepEqual(artifacts, [
    {
      id: 'session:write-new:/tmp/output.csv',
      toolId: 'write-new',
      toolName: 'write',
      filePath: '/tmp/output.csv',
      filename: 'output.csv',
      order: 9,
      taskRunId: null,
    },
    {
      id: 'session:write-other:/tmp/summary.txt',
      toolId: 'write-other',
      toolName: 'write',
      filePath: '/tmp/summary.txt',
      filename: 'summary.txt',
      order: 4,
      taskRunId: null,
    },
  ])
})
