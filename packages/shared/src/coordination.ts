import type {
  WorkspaceApiSupportStatus,
  WorkspaceExecutionAuthority,
  WorkspaceProductSurface,
  WorkspaceStateOwner,
} from './workspace.js'
import type { WorkflowSchedule, WorkflowTriggerType } from './workflow.js'

export const COORDINATION_ENTITY_KINDS = [
  'project',
  'task',
  'workflow',
  'run',
  'schedule',
  'watch',
  'delegation',
  'artifact',
  'question',
  'permission',
] as const

export type CoordinationEntityKind = typeof COORDINATION_ENTITY_KINDS[number]

export const COORDINATION_CAPABILITIES = [
  'projects',
  'tasks',
  'workflows',
  'runs',
  'schedules',
  'watches',
  'delegation',
  'artifacts',
  'questions',
  'permissions',
] as const

export type CoordinationCapability = typeof COORDINATION_CAPABILITIES[number]

export const COORDINATION_PROJECT_STATUSES = [
  'active',
  'paused',
  'completed',
  'archived',
] as const

export type CoordinationProjectStatus = typeof COORDINATION_PROJECT_STATUSES[number]

export const COORDINATION_TASK_STATUSES = [
  'open',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const

export type CoordinationTaskStatus = typeof COORDINATION_TASK_STATUSES[number]

export const COORDINATION_RUN_KINDS = [
  'interactive',
  'workflow',
  'background',
  'delegation',
  'scheduled',
  'watch_trigger',
] as const

export type CoordinationRunKind = typeof COORDINATION_RUN_KINDS[number]

export const COORDINATION_RUN_STATUSES = [
  'queued',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'dead',
] as const

export type CoordinationRunStatus = typeof COORDINATION_RUN_STATUSES[number]

export const COORDINATION_SCHEDULE_STATUSES = [
  'active',
  'paused',
  'expired',
  'archived',
] as const

export type CoordinationScheduleStatus = typeof COORDINATION_SCHEDULE_STATUSES[number]

export const COORDINATION_WATCH_TARGETS = [
  'conversation',
  'project',
  'task',
  'workflow',
  'run',
  'session',
] as const

export type CoordinationWatchTarget = typeof COORDINATION_WATCH_TARGETS[number]

export const COORDINATION_WATCH_STATUSES = [
  'active',
  'paused',
  'expired',
] as const

export type CoordinationWatchStatus = typeof COORDINATION_WATCH_STATUSES[number]

export const COORDINATION_WATCH_VERBOSITIES = [
  'quiet',
  'normal',
  'verbose',
  'debug',
] as const

export type CoordinationWatchVerbosity = typeof COORDINATION_WATCH_VERBOSITIES[number]

export const COORDINATION_DELEGATION_MODES = [
  'opencode_native',
  'gateway_delegate',
  'cloud_worker',
  'paired_desktop',
] as const

export type CoordinationDelegationMode = typeof COORDINATION_DELEGATION_MODES[number]

export const COORDINATION_DELEGATION_STATUSES = [
  'requested',
  'waiting_for_child',
  'attached',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const

export type CoordinationDelegationStatus = typeof COORDINATION_DELEGATION_STATUSES[number]

export type CoordinationTarget = {
  kind: CoordinationWatchTarget
  id: string
}

export type CoordinationBase = {
  id: string
  kind: CoordinationEntityKind
  workspaceId: string
  ownerAuthority: WorkspaceExecutionAuthority
  executionAuthority: WorkspaceExecutionAuthority
  stateOwner: WorkspaceStateOwner
  createdAt: string
  updatedAt: string
}

export type CoordinationProject = CoordinationBase & {
  kind: 'project'
  title: string
  description?: string | null
  status: CoordinationProjectStatus
  sourceSessionId?: string | null
}

export type CoordinationTask = CoordinationBase & {
  kind: 'task'
  projectId: string
  parentTaskId?: string | null
  title: string
  description?: string | null
  status: CoordinationTaskStatus
  externalRef?: string | null
  assigneeAgent?: string | null
  assignedRunId?: string | null
  assignedSessionId?: string | null
}

export type CoordinationRun = CoordinationBase & {
  kind: 'run'
  runKind: CoordinationRunKind
  status: CoordinationRunStatus
  workflowId?: string | null
  taskId?: string | null
  delegationId?: string | null
  scheduleId?: string | null
  watchId?: string | null
  sessionId?: string | null
  triggerType?: WorkflowTriggerType | 'background' | 'delegation' | 'watch' | null
  startedAt?: string | null
  finishedAt?: string | null
}

export type CoordinationSchedule = CoordinationBase & {
  kind: 'schedule'
  status: CoordinationScheduleStatus
  target: CoordinationTarget
  schedule: WorkflowSchedule
  nextRunAt?: string | null
  lastRunAt?: string | null
}

export type CoordinationWatch = CoordinationBase & {
  kind: 'watch'
  status: CoordinationWatchStatus
  target: CoordinationTarget
  deliverySurface: WorkspaceProductSurface | 'gateway_channel'
  verbosity: CoordinationWatchVerbosity
  cursor?: string | number | null
}

export type CoordinationDelegation = CoordinationBase & {
  kind: 'delegation'
  mode: CoordinationDelegationMode
  status: CoordinationDelegationStatus
  parentTaskId?: string | null
  parentRunId?: string | null
  parentSessionId?: string | null
  childTaskId?: string | null
  childRunId?: string | null
  childSessionId?: string | null
  assigneeAgent?: string | null
}

export type CoordinationArtifactRef = CoordinationBase & {
  kind: 'artifact'
  title: string
  artifactId: string
  taskId?: string | null
  runId?: string | null
  sessionId?: string | null
}

export type CoordinationQuestionRef = CoordinationBase & {
  kind: 'question'
  questionId: string
  status: 'pending' | 'answered' | 'rejected' | 'expired'
  taskId?: string | null
  runId?: string | null
  sessionId?: string | null
}

export type CoordinationPermissionRef = CoordinationBase & {
  kind: 'permission'
  permissionId: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  taskId?: string | null
  runId?: string | null
  sessionId?: string | null
}

export type CoordinationEntity =
  | CoordinationProject
  | CoordinationTask
  | CoordinationRun
  | CoordinationSchedule
  | CoordinationWatch
  | CoordinationDelegation
  | CoordinationArtifactRef
  | CoordinationQuestionRef
  | CoordinationPermissionRef

export type CoordinationCapabilitySupport = Record<CoordinationCapability, WorkspaceApiSupportStatus>

export const COORDINATION_WORKSPACE_SUPPORT_APIS = {
  'coordination.projects': 'projects',
  'coordination.tasks': 'tasks',
  'coordination.runs': 'runs',
  'coordination.schedules': 'schedules',
  'coordination.watches': 'watches',
  'coordination.delegation': 'delegation',
} as const satisfies Record<string, CoordinationCapability>

export type CoordinationWorkspaceSupportApi = keyof typeof COORDINATION_WORKSPACE_SUPPORT_APIS

export const COORDINATION_AUTHORITY_SUPPORT = {
  desktop_local: {
    projects: 'deferred',
    tasks: 'deferred',
    workflows: 'supported',
    runs: 'supported',
    schedules: 'supported',
    watches: 'not_supported',
    delegation: 'supported',
    artifacts: 'supported',
    questions: 'supported',
    permissions: 'supported',
  },
  gateway_standalone: {
    projects: 'supported',
    tasks: 'supported',
    workflows: 'supported',
    runs: 'supported',
    schedules: 'supported',
    watches: 'supported',
    delegation: 'supported',
    artifacts: 'supported',
    questions: 'supported',
    permissions: 'supported',
  },
  desktop_paired: {
    projects: 'read_only',
    tasks: 'read_only',
    workflows: 'deferred',
    runs: 'read_only',
    schedules: 'deferred',
    watches: 'deferred',
    delegation: 'read_only',
    artifacts: 'read_only',
    questions: 'deferred',
    permissions: 'deferred',
  },
  cloud_worker: {
    projects: 'deferred',
    tasks: 'deferred',
    workflows: 'supported',
    runs: 'supported',
    schedules: 'supported',
    watches: 'deferred',
    delegation: 'deferred',
    artifacts: 'supported',
    questions: 'supported',
    permissions: 'supported',
  },
  cloud_channel_gateway: {
    projects: 'deferred',
    tasks: 'deferred',
    workflows: 'supported',
    runs: 'supported',
    schedules: 'read_only',
    watches: 'supported',
    delegation: 'deferred',
    artifacts: 'supported',
    questions: 'supported',
    permissions: 'supported',
  },
} as const satisfies Record<WorkspaceExecutionAuthority, CoordinationCapabilitySupport>

export function coordinationSupportForAuthority(
  authority: WorkspaceExecutionAuthority,
): CoordinationCapabilitySupport {
  return COORDINATION_AUTHORITY_SUPPORT[authority]
}

export function coordinationCapabilityStatus(
  authority: WorkspaceExecutionAuthority,
  capability: CoordinationCapability,
): WorkspaceApiSupportStatus {
  return coordinationSupportForAuthority(authority)[capability]
}

export function coordinationCapabilityFromWorkspaceApi(
  api: string,
): CoordinationCapability | null {
  return COORDINATION_WORKSPACE_SUPPORT_APIS[api as CoordinationWorkspaceSupportApi] || null
}
