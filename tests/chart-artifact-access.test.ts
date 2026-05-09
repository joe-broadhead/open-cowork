import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChartSaveArtifactRequest, SessionView, TaskRun, ToolCall } from '@open-cowork/shared'
import { isKnownChartArtifactToolCall } from '../apps/desktop/src/main/chart-artifact-access.ts'

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: overrides.id || 'tool-1',
    name: overrides.name || 'charts_bar_chart',
    input: overrides.input || {},
    status: overrides.status || 'complete',
    output: overrides.output,
    attachments: overrides.attachments,
    agent: overrides.agent || null,
    sourceSessionId: overrides.sourceSessionId || null,
    order: overrides.order || 1,
  }
}

function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: overrides.id || 'task-1',
    title: overrides.title || 'Task',
    agent: overrides.agent || null,
    status: overrides.status || 'complete',
    sourceSessionId: overrides.sourceSessionId || null,
    parentSessionId: overrides.parentSessionId || null,
    content: overrides.content || '',
    transcript: overrides.transcript || [],
    toolCalls: overrides.toolCalls || [],
    compactions: overrides.compactions || [],
    todos: overrides.todos || [],
    error: overrides.error || null,
    sessionCost: overrides.sessionCost || 0,
    sessionTokens: overrides.sessionTokens || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    order: overrides.order || 1,
  }
}

function view(overrides: Partial<SessionView> = {}): SessionView {
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
    ...overrides,
  }
}

function request(overrides: Partial<ChartSaveArtifactRequest> = {}): ChartSaveArtifactRequest {
  return {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    toolName: 'charts_bar_chart',
    dataUrl: 'data:image/png;base64,AAAA',
    ...overrides,
  }
}

test('chart artifact saves are authorized for matching root-session tool calls', () => {
  assert.equal(
    isKnownChartArtifactToolCall(view({ toolCalls: [tool()] }), request()),
    true,
  )
})

test('chart artifact saves accept dotted chart MCP tool names', () => {
  assert.equal(
    isKnownChartArtifactToolCall(
      view({ toolCalls: [tool({ name: 'charts.create_bar' })] }),
      request({ toolName: 'charts.create_bar' }),
    ),
    true,
  )
})

test('chart artifact saves reject mismatched tool names for the same tool id', () => {
  assert.equal(
    isKnownChartArtifactToolCall(view({ toolCalls: [tool({ name: 'write' })] }), request()),
    false,
  )
})

test('chart artifact saves reject non-chart tool calls even when the renderer echoes the tool name', () => {
  assert.equal(
    isKnownChartArtifactToolCall(
      view({ toolCalls: [tool({ name: 'write' })] }),
      request({ toolName: 'write' }),
    ),
    false,
  )
})

test('chart artifact saves accept task tools when legacy renderer requests omit taskRunId', () => {
  assert.equal(
    isKnownChartArtifactToolCall(
      view({ taskRuns: [taskRun({ toolCalls: [tool({ id: 'task-tool' })] })] }),
      request({ toolCallId: 'task-tool' }),
    ),
    true,
  )
})

test('chart artifact saves require the matching task run when taskRunId is present', () => {
  const sessionView = view({
    taskRuns: [
      taskRun({ id: 'task-1', toolCalls: [tool({ id: 'task-tool' })] }),
      taskRun({ id: 'task-2', toolCalls: [tool({ id: 'other-tool' })] }),
    ],
  })

  assert.equal(
    isKnownChartArtifactToolCall(sessionView, request({
      toolCallId: 'task-tool',
      taskRunId: 'task-1',
    })),
    true,
  )
  assert.equal(
    isKnownChartArtifactToolCall(sessionView, request({
      toolCallId: 'task-tool',
      taskRunId: 'task-2',
    })),
    false,
  )
})
