import { describe, expect, it } from 'vitest'
import {
  isActiveRunStatus,
  isTaskActiveStatus,
  isTaskRunOwnershipTerminalStatus,
  isTerminalRunStatus,
  RUNTIME_STATE_TRANSITIONS,
  shouldAbortActiveRunForTaskStatus,
  validateRuntimeStateMachine,
} from '../runtime-state-machine.js'

describe('runtime state machine', () => {
  it('validates the M41 scheduler/worker runtime transition contract', () => {
    const validation = validateRuntimeStateMachine()

    expect(validation).toMatchObject({
      ok: true,
      errors: [],
      transitionCount: RUNTIME_STATE_TRANSITIONS.length,
      releaseClaimEffect: 'runtime_quality_only_no_release_claim_expansion',
    })
    expect(validation.owners).toEqual(expect.arrayContaining([
      'scheduler',
      'work-store/run-lease-port',
      'workflow',
      'opencode-permission',
      'worker-fleet-coordinator',
      'delegation-progress',
    ]))
    expect(validation.machines).toEqual(expect.arrayContaining([
      'task.lifecycle',
      'dispatch.receipt',
      'run.lifecycle',
      'permission.wait',
      'worker.result',
      'delegation.progress',
    ]))
  })

  it('names active and terminal run/task ownership statuses for live code', () => {
    expect(isActiveRunStatus('running')).toBe(true)
    expect(isActiveRunStatus('passed')).toBe(false)
    expect(isTerminalRunStatus('passed')).toBe(true)
    expect(isTerminalRunStatus('errored')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)

    expect(isTaskActiveStatus('running')).toBe(true)
    expect(isTaskRunOwnershipTerminalStatus('done')).toBe(true)
    expect(isTaskRunOwnershipTerminalStatus('blocked')).toBe(true)
    expect(isTaskRunOwnershipTerminalStatus('paused')).toBe(false)

    expect(shouldAbortActiveRunForTaskStatus('cancelled')).toBe(true)
    expect(shouldAbortActiveRunForTaskStatus('blocked')).toBe(true)
    expect(shouldAbortActiveRunForTaskStatus('running')).toBe(false)
    expect(shouldAbortActiveRunForTaskStatus(undefined)).toBe(false)
  })

  it('fails validation when critical runtime owners or recovery transitions disappear', () => {
    const withoutRecovery = RUNTIME_STATE_TRANSITIONS.filter(transition => transition.id !== 'run.running_to_errored_recovery')
    const withoutWorkerOwner = RUNTIME_STATE_TRANSITIONS.filter(transition => transition.owner !== 'worker-fleet-coordinator')

    expect(validateRuntimeStateMachine(withoutRecovery)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['run recovery transition is missing']),
    })
    expect(validateRuntimeStateMachine(withoutWorkerOwner).errors).toEqual(expect.arrayContaining([
      'runtime owner missing from transition table: worker-fleet-coordinator',
      'runtime machine missing from transition table: worker.result',
    ]))
  })
})
