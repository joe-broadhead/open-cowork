import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionView, ToolCall } from '@open-cowork/shared'
import { artifactForTool, listArtifactsForTools, listSessionArtifacts, listVisibleSessionArtifacts, sanitizeArtifactToolInput } from '../apps/desktop/src/renderer/components/chat/session-artifacts.ts'

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

test('listSessionArtifacts includes cloud projection artifacts', () => {
  const view = emptyView()
  view.artifacts = [{
    id: 'artifact-1',
    toolId: 'cloud-artifact',
    toolName: 'cloud.artifact',
    filePath: 'cloud-artifact://artifact-1/result.txt',
    filename: 'result.txt',
    order: 3,
    source: 'cloud',
    cloudArtifactId: 'artifact-1',
    mime: 'text/plain',
  }]

  assert.equal(listSessionArtifacts(view)[0]?.cloudArtifactId, 'artifact-1')
})

test('listVisibleSessionArtifacts hides project file artifacts while preserving chart and cloud artifacts', () => {
  const view = emptyView()
  view.toolCalls = [
    tool({
      id: 'write-1',
      input: { filePath: '/Users/alice/project/report.txt', content: 'hello' },
      order: 10,
    }),
  ]
  view.artifacts = [{
    id: 'cloud-1',
    toolId: 'cloud-artifact',
    toolName: 'cloud.artifact',
    filePath: 'cloud-artifact://cloud-1/result.txt',
    filename: 'result.txt',
    order: 4,
    source: 'cloud',
    cloudArtifactId: 'cloud-1',
    mime: 'text/plain',
  }, {
    id: 'project-image',
    toolId: 'write-image',
    toolName: 'write',
    filePath: '/Users/alice/project/screenshot.png',
    filename: 'screenshot.png',
    order: 8,
    source: 'local',
    mime: 'image/png',
  }]
  const chartArtifact = {
    id: 'chart-1',
    toolId: 'chart-tool',
    toolName: 'charts.line',
    filePath: '/private/chart-artifacts/chart-1.png',
    filename: 'chart-1.png',
    order: 6,
    source: 'local' as const,
    mime: 'image/png',
    chart: { format: 'vega-lite' as const, spec: {} },
  }
  const chartArtifactWithoutMetadata = {
    id: 'chart-2',
    toolId: 'chart-tool-2',
    toolName: 'charts.bar',
    filePath: '/private/chart-artifacts/chart-2.png',
    filename: 'chart-2.png',
    order: 5,
    source: 'local' as const,
    mime: 'image/png',
  }

  assert.deepEqual(
    listVisibleSessionArtifacts(view, [chartArtifact, chartArtifactWithoutMetadata], { canReadPrivateArtifacts: false }).map((artifact) => artifact.id),
    ['chart-1', 'chart-2', 'cloud-1'],
  )
  assert.deepEqual(
    listVisibleSessionArtifacts(view, [chartArtifact, chartArtifactWithoutMetadata], { canReadPrivateArtifacts: true }).map((artifact) => artifact.id),
    ['session:write-1:/Users/alice/project/report.txt', 'project-image', 'chart-1', 'chart-2', 'cloud-1'],
  )
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
