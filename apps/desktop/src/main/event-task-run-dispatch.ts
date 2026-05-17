import type { BrowserWindow } from 'electron'
import { getImmediateParentSession, type TaskRunMeta } from './event-task-state.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'

export function emitTaskRun(win: BrowserWindow, taskRun: TaskRunMeta) {
  // Thread the immediate parent session so the renderer can reconstruct
  // nested delegation without guessing from task titles.
  const parentSessionId = taskRun.childSessionId
    ? getImmediateParentSession(taskRun.childSessionId)
    : taskRun.parentSessionId
  dispatchRuntimeSessionEvent(win, {
    type: 'task_run',
    sessionId: taskRun.rootSessionId,
    data: {
      type: 'task_run',
      id: taskRun.id,
      title: taskRun.title,
      agent: taskRun.agent,
      status: taskRun.status,
      sourceSessionId: taskRun.childSessionId,
      parentSessionId,
      startedAt: taskRun.startedAt ?? null,
      finishedAt: taskRun.finishedAt ?? null,
    },
  })
}
