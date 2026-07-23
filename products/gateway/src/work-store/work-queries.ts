/**
 * Small work-store query helpers (JOE-992 progressive façade peel).
 * Leaf relative to work-store.ts façade.
 */
import { workStatePath } from './db.js'
import { loadWorkState } from './state-io.js'
import { calculateTaskReadiness } from './task-helpers.js'
import type { WorkDependencyRecord, WorkTaskReadiness, WorkStatus } from './types.js'

export function getWorkTaskReadiness(taskId: string, filePath = workStatePath()): WorkTaskReadiness | undefined {
  const state = loadWorkState(filePath)
  const task = state.tasks.find(row => row.id === taskId)
  return task ? calculateTaskReadiness(task, state) : undefined
}
export function listWorkDependencies(taskId?: string, filePath = workStatePath()): WorkDependencyRecord[] {
  const deps = loadWorkState(filePath).dependencies || []
  return taskId ? deps.filter(dep => dep.taskId === taskId) : deps
}

export function summarizeWorkTasks(tasks: Array<{ status: WorkStatus; priority: string }>) {
  return {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    running: tasks.filter(t => t.status === 'running').length,
    done: tasks.filter(t => t.status === 'done').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    paused: tasks.filter(t => t.status === 'paused').length,
    cancelled: tasks.filter(t => t.status === 'cancelled').length,
    archived: tasks.filter(t => t.status === 'archived').length,
    high: tasks.filter(t => t.priority === 'HIGH').length,
    medium: tasks.filter(t => t.priority === 'MEDIUM').length,
    low: tasks.filter(t => t.priority === 'LOW').length,
  }
}
