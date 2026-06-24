import type { upsertTaskRunList } from '@open-cowork/shared'
import type {
  PendingApproval,
  PendingQuestion,
  TaskRun,
  ToolCall,
} from '@open-cowork/shared'

import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'

type RuntimeEventData = NonNullable<RuntimeSessionEvent['data']>
type TaskRunUpdate = Parameters<typeof upsertTaskRunList>[1]

export function normalizeToolStatus(status: unknown): ToolCall['status'] {
  return status === 'running' || status === 'complete' || status === 'error'
    ? status
    : 'running'
}

function normalizeTaskStatus(status: unknown): TaskRun['status'] {
  return status === 'queued' || status === 'running' || status === 'complete' || status === 'error'
    ? status
    : 'queued'
}

export function buildTaskRunUpdate(sessionId: string, data: RuntimeEventData, nowMs: number): TaskRunUpdate {
  return {
    id: typeof data.id === 'string' ? data.id : `${sessionId}:task:${nowMs}`,
    title: typeof data.title === 'string' ? data.title : 'Task',
    agent: data.agent,
    status: normalizeTaskStatus(data.status),
    sourceSessionId: data.sourceSessionId,
    parentSessionId: typeof data.parentSessionId === 'string' ? data.parentSessionId : null,
    startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    finishedAt: typeof data.finishedAt === 'string' ? data.finishedAt : null,
  }
}

export function buildPendingApproval(sessionId: string, data: RuntimeEventData, nowMs: number): Omit<PendingApproval, 'order'> {
  return {
    id: typeof data.id === 'string' ? data.id : `${sessionId}:approval:${nowMs}`,
    sessionId,
    taskRunId: data.taskRunId || null,
    tool: typeof data.tool === 'string' ? data.tool : 'permission',
    input: data.input || {},
    description: typeof data.description === 'string'
      ? data.description
      : typeof data.tool === 'string'
        ? data.tool
        : 'Permission requested',
  }
}

export function buildPendingQuestion(sessionId: string, data: RuntimeEventData, nowMs: number): PendingQuestion {
  return {
    id: typeof data.id === 'string' ? data.id : `${sessionId}:question:${nowMs}`,
    sessionId,
    sourceSessionId: typeof data.sourceSessionId === 'string' ? data.sourceSessionId : null,
    questions: Array.isArray(data.questions) ? data.questions as PendingQuestion['questions'] : [],
    tool: data.tool && typeof data.tool === 'object'
      ? {
          messageId: String((data.tool as Record<string, unknown>).messageId || ''),
          callId: String((data.tool as Record<string, unknown>).callId || ''),
        }
      : undefined,
  }
}
