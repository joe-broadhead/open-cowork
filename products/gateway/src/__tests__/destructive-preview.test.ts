import { describe, expect, it } from 'vitest'
import { previewBulkTaskUpdate, previewRoadmapDelete, previewTaskDelete } from '../destructive-preview.js'
import type { WorkState } from '../work-store.js'

function fixtureState(): WorkState {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    roadmaps: [
      { id: 'rm_1', title: 'Initiative one' },
      { id: 'rm_2', title: 'Initiative two' },
    ] as any,
    supervisors: [
      { supervisorId: 'sup_1', roadmapId: 'rm_1' },
      { supervisorId: 'sup_2', roadmapId: 'rm_2' },
    ] as any,
    projectBindings: [{ id: 'pb_1', roadmapId: 'rm_1' }] as any,
    completionProposals: [{ id: 'cp_1', roadmapId: 'rm_1' }] as any,
    tasks: [
      { id: 'task_a', roadmapId: 'rm_1', title: 'A', status: 'pending' },
      { id: 'task_b', roadmapId: 'rm_1', title: 'B', status: 'running' },
      { id: 'task_c', roadmapId: 'rm_2', title: 'C', status: 'pending' },
    ] as any,
    runs: [
      { id: 'run_1', taskId: 'task_a', sessionId: 'ses_a', status: 'completed' },
      { id: 'run_2', taskId: 'task_b', sessionId: 'ses_b', status: 'running' },
      { id: 'run_3', taskId: 'task_c', sessionId: 'ses_c', status: 'running' },
    ] as any,
    dependencies: [
      { taskId: 'task_b', dependsOnTaskId: 'task_a', type: 'hard', createdAt: '' },
    ] as any,
  }
}

describe('destructive-preview blast radius', () => {
  it('previews a task delete without mutating state', () => {
    const state = fixtureState()
    const before = JSON.stringify(state)
    const preview = previewTaskDelete('task_a', state)

    expect(preview).toMatchObject({
      operation: 'task_delete',
      dryRun: true,
      mutates: false,
      found: true,
      taskId: 'task_a',
      roadmapId: 'rm_1',
      runsDeleted: 1,
      runIds: ['run_1'],
      dependentTaskIds: ['task_b'],
      dependencyEdgesRemoved: 1,
    })
    // State object is untouched.
    expect(JSON.stringify(state)).toBe(before)
  })

  it('reports found=false for a missing task', () => {
    const preview = previewTaskDelete('task_missing', fixtureState())
    expect(preview.found).toBe(false)
    expect(preview.runsDeleted).toBe(0)
    expect(preview.summary).toContain('not found')
  })

  it('surfaces active run sessions that would be aborted', () => {
    const preview = previewTaskDelete('task_b', fixtureState())
    expect(preview.activeRunSessionIds).toEqual(['ses_b'])
  })

  it('previews a roadmap delete with full child fan-out', () => {
    const state = fixtureState()
    const before = JSON.stringify(state)
    const preview = previewRoadmapDelete('rm_1', state)

    expect(preview).toMatchObject({
      operation: 'roadmap_delete',
      dryRun: true,
      mutates: false,
      found: true,
      roadmapId: 'rm_1',
      tasksDeleted: 2,
      runsDeleted: 2,
      supervisorsRemoved: 1,
      completionProposalsRemoved: 1,
      projectBindingsRemoved: 1,
    })
    expect(preview.taskIds.sort()).toEqual(['task_a', 'task_b'])
    expect(preview.activeRunSessionIds).toEqual(['ses_b'])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('reports found=false for a missing roadmap', () => {
    const preview = previewRoadmapDelete('rm_missing', fixtureState())
    expect(preview.found).toBe(false)
    expect(preview.tasksDeleted).toBe(0)
  })

  it('previews a bulk update, separating matched from missing task ids', () => {
    const preview = previewBulkTaskUpdate([
      { taskId: 'task_a', status: 'done' },
      { taskId: 'task_missing', status: 'done' },
    ], fixtureState())

    expect(preview).toMatchObject({ operation: 'task_bulk_update', dryRun: true, mutates: false, requested: 2, matched: 1, missing: 1 })
    expect(preview.missingTaskIds).toEqual(['task_missing'])
    expect(preview.changes).toEqual([{ taskId: 'task_a', currentStatus: 'pending', requestedStatus: 'done' }])
  })
})
