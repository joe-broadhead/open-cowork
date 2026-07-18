import type { RunStatus, WorkStatus } from './workflow.js'

export type RuntimeStateMachineId =
  | 'task.lifecycle'
  | 'dispatch.receipt'
  | 'run.lifecycle'
  | 'permission.wait'
  | 'worker.result'
  | 'delegation.progress'

export type RuntimeTransitionOwner =
  | 'scheduler'
  | 'work-store/run-lease-port'
  | 'workflow'
  | 'opencode-permission'
  | 'worker-fleet-coordinator'
  | 'delegation-progress'

export type RuntimeMutationEntryPoint =
  | 'work_state_transaction'
  | 'domain_port'
  | 'domain_transaction'
  | 'single_table_append'
  | 'external_runtime_read'

export interface RuntimeStateTransition {
  id: string
  machine: RuntimeStateMachineId
  owner: RuntimeTransitionOwner
  from: string
  event: string
  to: string
  mutationEntryPoint: RuntimeMutationEntryPoint
  retrySemantics: string
  invariantIds: string[]
}

export interface RuntimeStateInvariant {
  id: string
  severity: 'critical' | 'warning'
  owner: RuntimeTransitionOwner
  statement: string
  machineCheck: string
}

export interface RuntimeStateMachineValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  transitionCount: number
  invariantCount: number
  owners: RuntimeTransitionOwner[]
  machines: RuntimeStateMachineId[]
  releaseClaimEffect: 'runtime_quality_only_no_release_claim_expansion'
}

export const RUN_STATUSES = ['running', 'passed', 'failed', 'blocked', 'errored'] as const satisfies readonly RunStatus[]
export const ACTIVE_RUN_STATUSES = ['running'] as const
export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'blocked', 'errored'] as const

export const ACTIVE_TASK_STATUSES = ['running'] as const
export const TASK_RUN_OWNERSHIP_TERMINAL_STATUSES = ['done', 'blocked', 'cancelled', 'archived'] as const

export const RUNTIME_STATE_INVARIANTS: readonly RuntimeStateInvariant[] = [
  {
    id: 'RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK',
    severity: 'critical',
    owner: 'scheduler',
    statement: 'A task can have at most one active run or starting dispatch receipt.',
    machineCheck: 'count(active runs + unexpired starting dispatch receipts by taskId) <= 1',
  },
  {
    id: 'RT_INV_002_ACTIVE_RUN_HAS_LEASE',
    severity: 'critical',
    owner: 'work-store/run-lease-port',
    statement: 'An active run must have a lease owner and an unexpired lease or it must be recovered.',
    machineCheck: 'active runs have leaseOwner and leaseExpiresAt > now; otherwise recovery transition closes ownership',
  },
  {
    id: 'RT_INV_003_TERMINAL_RUN_RESULT_ONCE',
    severity: 'critical',
    owner: 'workflow',
    statement: 'A run can accept one terminal stage result, runtime block, cancellation, or recovery transition.',
    machineCheck: 'terminal run statuses never transition back to running for the same run id',
  },
  {
    id: 'RT_INV_004_RECOVERY_CLOSES_ACTIVE_OWNERSHIP',
    severity: 'critical',
    owner: 'work-store/run-lease-port',
    statement: 'Expired leases, missing sessions, and orphaned runs clear task.currentRunId before retry or block.',
    machineCheck: 'recovered runs are terminal and task.currentRunId is undefined',
  },
  {
    id: 'RT_INV_005_PERMISSION_WAIT_BEFORE_COMPLETION',
    severity: 'critical',
    owner: 'opencode-permission',
    statement: 'OpenCode permission waits must resolve before final run completion is accepted.',
    machineCheck: 'permission wait/resolution timestamps are <= run terminal timestamp for the same run id',
  },
  {
    id: 'RT_INV_006_COORDINATOR_ONLY_WORKER_RESULTS',
    severity: 'critical',
    owner: 'worker-fleet-coordinator',
    statement: 'Workers can return idempotent result packets, but only the coordinator mutates durable Gateway state.',
    machineCheck: 'accepted worker result packets are converted to coordinator-owned work-store mutations',
  },
  {
    id: 'RT_INV_007_TERMINAL_DELEGATION_RECEIPTS',
    severity: 'critical',
    owner: 'delegation-progress',
    statement: 'Terminal delegated progress requires durable parent-session/channel route receipts.',
    machineCheck: 'completed/failed/blocked delegation progress has required route receipts or fail-closed diagnostics',
  },
  {
    id: 'RT_INV_008_LOCAL_BETA_CLAIM_BOUNDARY',
    severity: 'warning',
    owner: 'scheduler',
    statement: 'The runtime state machine is local public-beta quality evidence only.',
    machineCheck: 'report releaseClaimEffect remains runtime_quality_only_no_release_claim_expansion',
  },
]

export const RUNTIME_STATE_TRANSITIONS: readonly RuntimeStateTransition[] = [
  {
    id: 'task.pending_to_running',
    machine: 'task.lifecycle',
    owner: 'scheduler',
    from: 'pending',
    event: 'scheduler.dispatch.accepted',
    to: 'running',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'dispatch is fenced by task currentRunId and starting dispatch receipts',
    invariantIds: ['RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK'],
  },
  {
    id: 'task.running_to_pending_retry',
    machine: 'task.lifecycle',
    owner: 'workflow',
    from: 'running',
    event: 'stage_result.retryable',
    to: 'pending',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'retry returns to the failed stage or implementation stage according to failure class',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'task.running_to_terminal',
    machine: 'task.lifecycle',
    owner: 'workflow',
    from: 'running',
    event: 'stage_result.terminal',
    to: 'done|blocked|cancelled',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'terminal task state clears currentRunId and recomputes roadmap status',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'dispatch.none_to_starting',
    machine: 'dispatch.receipt',
    owner: 'scheduler',
    from: 'none',
    event: 'scheduler.reserve_dispatch_start',
    to: 'starting',
    mutationEntryPoint: 'domain_port',
    retrySemantics: 'duplicate starting receipts are denied while the unexpired lease exists',
    invariantIds: ['RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK'],
  },
  {
    id: 'dispatch.starting_to_started',
    machine: 'dispatch.receipt',
    owner: 'work-store/run-lease-port',
    from: 'starting',
    event: 'scheduler.session_created',
    to: 'started',
    mutationEntryPoint: 'domain_port',
    retrySemantics: 'session creation marks the reserved dispatch as started once',
    invariantIds: ['RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK'],
  },
  {
    id: 'dispatch.starting_to_failed',
    machine: 'dispatch.receipt',
    owner: 'scheduler',
    from: 'starting',
    event: 'scheduler.pre_run_failure',
    to: 'failed',
    mutationEntryPoint: 'domain_port',
    retrySemantics: 'pre-run environment/session/profile failures release the starting receipt',
    invariantIds: ['RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK'],
  },
  {
    id: 'run.none_to_running',
    machine: 'run.lifecycle',
    owner: 'work-store/run-lease-port',
    from: 'none',
    event: 'scheduler.start_run',
    to: 'running',
    mutationEntryPoint: 'domain_port',
    retrySemantics: 'start_run is denied when task ownership or readiness changed',
    invariantIds: ['RT_INV_001_SINGLE_ACTIVE_RUN_PER_TASK', 'RT_INV_002_ACTIVE_RUN_HAS_LEASE'],
  },
  {
    id: 'run.running_to_passed',
    machine: 'run.lifecycle',
    owner: 'workflow',
    from: 'running',
    event: 'stage_result.pass',
    to: 'passed',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'accepted stage result is terminal for the run id',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'run.running_to_failed',
    machine: 'run.lifecycle',
    owner: 'workflow',
    from: 'running',
    event: 'stage_result.fail_or_unknown',
    to: 'failed',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'retry policy decides whether task returns to pending or blocks',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'run.running_to_blocked',
    machine: 'run.lifecycle',
    owner: 'workflow',
    from: 'running',
    event: 'stage_result.blocked',
    to: 'blocked',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'blocked stage result blocks the task unless an operator later requeues',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'run.running_to_errored_recovery',
    machine: 'run.lifecycle',
    owner: 'work-store/run-lease-port',
    from: 'running',
    event: 'lease.expired_or_session_missing',
    to: 'errored',
    mutationEntryPoint: 'domain_port',
    retrySemantics: 'recovery clears currentRunId and either retries or blocks by retry limit',
    invariantIds: ['RT_INV_002_ACTIVE_RUN_HAS_LEASE', 'RT_INV_004_RECOVERY_CLOSES_ACTIVE_OWNERSHIP'],
  },
  {
    id: 'run.running_to_errored_runtime_block',
    machine: 'run.lifecycle',
    owner: 'scheduler',
    from: 'running',
    event: 'runtime.blocked_or_operator_cancelled',
    to: 'errored',
    mutationEntryPoint: 'work_state_transaction',
    retrySemantics: 'runtime governance and operator cancellation are terminal for the active run',
    invariantIds: ['RT_INV_003_TERMINAL_RUN_RESULT_ONCE'],
  },
  {
    id: 'permission.waiting_to_resolved',
    machine: 'permission.wait',
    owner: 'opencode-permission',
    from: 'waiting',
    event: 'operator.decision',
    to: 'resolved',
    mutationEntryPoint: 'external_runtime_read',
    retrySemantics: 'permission answer is terminal for request id before completion can be accepted',
    invariantIds: ['RT_INV_005_PERMISSION_WAIT_BEFORE_COMPLETION'],
  },
  {
    id: 'worker.result_to_coordinator_mutation',
    machine: 'worker.result',
    owner: 'worker-fleet-coordinator',
    from: 'packet_received',
    event: 'worker.result.accepted',
    to: 'coordinator_applied',
    mutationEntryPoint: 'domain_transaction',
    retrySemantics: 'worker result idempotency key is accepted once per lease/run/generation',
    invariantIds: ['RT_INV_006_COORDINATOR_ONLY_WORKER_RESULTS'],
  },
  {
    id: 'delegation.progress_to_terminal_receipt',
    machine: 'delegation.progress',
    owner: 'delegation-progress',
    from: 'active',
    event: 'delegation.progress.terminal',
    to: 'completed|failed|blocked',
    mutationEntryPoint: 'domain_transaction',
    retrySemantics: 'terminal progress is idempotent by progress key and route receipt dedupe key',
    invariantIds: ['RT_INV_007_TERMINAL_DELEGATION_RECEIPTS'],
  },
]

export function isActiveRunStatus(status: RunStatus | string | undefined): status is typeof ACTIVE_RUN_STATUSES[number] {
  return status === 'running'
}

export function isTerminalRunStatus(status: RunStatus | string | undefined): status is typeof TERMINAL_RUN_STATUSES[number] {
  return status === 'passed' || status === 'failed' || status === 'blocked' || status === 'errored'
}

export function isTaskActiveStatus(status: WorkStatus | string | undefined): status is typeof ACTIVE_TASK_STATUSES[number] {
  return status === 'running'
}

export function isTaskRunOwnershipTerminalStatus(status: WorkStatus | string | undefined): status is typeof TASK_RUN_OWNERSHIP_TERMINAL_STATUSES[number] {
  return status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
}

export function shouldAbortActiveRunForTaskStatus(status: WorkStatus | string | undefined): boolean {
  return Boolean(status && !isTaskActiveStatus(status))
}

export function validateRuntimeStateMachine(transitions: readonly RuntimeStateTransition[] = RUNTIME_STATE_TRANSITIONS): RuntimeStateMachineValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const owners = unique(transitions.map(transition => transition.owner))
  const machines = unique(transitions.map(transition => transition.machine))
  const invariantIds = new Set(RUNTIME_STATE_INVARIANTS.map(invariant => invariant.id))

  for (const transition of transitions) {
    if (!transition.id || !transition.machine || !transition.owner || !transition.event) errors.push(`transition ${transition.id || '<missing>'} is incomplete`)
    if (!transition.retrySemantics) errors.push(`transition ${transition.id} has no retry semantics`)
    if (!transition.invariantIds.length) errors.push(`transition ${transition.id} has no invariants`)
    for (const invariantId of transition.invariantIds) {
      if (!invariantIds.has(invariantId)) errors.push(`transition ${transition.id} references unknown invariant ${invariantId}`)
    }
    if (isTerminalRunStatus(transition.from) && transition.to === 'running') errors.push(`transition ${transition.id} moves terminal run state back to running`)
  }

  for (const expected of RUN_STATUSES) {
    if (!isActiveRunStatus(expected) && !isTerminalRunStatus(expected)) errors.push(`run status ${expected} is neither active nor terminal`)
  }
  for (const expected of ['scheduler', 'work-store/run-lease-port', 'workflow', 'opencode-permission', 'worker-fleet-coordinator', 'delegation-progress'] as RuntimeTransitionOwner[]) {
    if (!owners.includes(expected)) errors.push(`runtime owner missing from transition table: ${expected}`)
  }
  for (const expected of ['run.lifecycle', 'dispatch.receipt', 'permission.wait', 'worker.result', 'delegation.progress'] as RuntimeStateMachineId[]) {
    if (!machines.includes(expected)) errors.push(`runtime machine missing from transition table: ${expected}`)
  }
  if (!transitions.some(transition => transition.event === 'lease.expired_or_session_missing' && transition.to === 'errored')) errors.push('run recovery transition is missing')
  if (!transitions.some(transition => transition.event === 'operator.decision' && transition.machine === 'permission.wait')) errors.push('permission wait resolution transition is missing')
  if (!transitions.some(transition => transition.event === 'delegation.progress.terminal')) errors.push('terminal delegation progress transition is missing')
  if (!RUNTIME_STATE_INVARIANTS.some(invariant => invariant.id === 'RT_INV_008_LOCAL_BETA_CLAIM_BOUNDARY')) warnings.push('release-claim boundary invariant is missing')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    transitionCount: transitions.length,
    invariantCount: RUNTIME_STATE_INVARIANTS.length,
    owners,
    machines,
    releaseClaimEffect: 'runtime_quality_only_no_release_claim_expansion',
  }
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
