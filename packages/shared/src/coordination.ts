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

export const COORDINATION_TASK_COLUMNS = [
  'backlog',
  'planning',
  'doing',
  'review',
  'done',
] as const

export type CoordinationTaskColumn = typeof COORDINATION_TASK_COLUMNS[number]

export const COORDINATION_TASK_PRIORITIES = [
  'high',
  'med',
  'low',
] as const

export type CoordinationTaskPriority = typeof COORDINATION_TASK_PRIORITIES[number]

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
  'playbook',
  'project',
  'task',
  'workflow',
  'run',
  'session',
] as const

export type CoordinationWatchTarget = typeof COORDINATION_WATCH_TARGETS[number]

export const COORDINATION_WATCH_EVENTS = [
  'task.moved',
  'task.review_ready',
  'run.finished',
  'needs_input',
  'daily_summary',
] as const

export type CoordinationWatchEventType = typeof COORDINATION_WATCH_EVENTS[number]

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

export const COORDINATION_WATCH_RECIPIENT_ROLES = [
  'owner',
  'admin',
  'member',
  'approver',
  'viewer',
] as const

export type CoordinationWatchRecipientRole = typeof COORDINATION_WATCH_RECIPIENT_ROLES[number]

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

export type CoordinationWatchChannel = {
  provider: string
  agentId: string
  channelBindingId: string
  sessionBindingId?: string | null
  target: Record<string, unknown>
}

export type CoordinationWatchRecipient = {
  identityId?: string | null
  role?: CoordinationWatchRecipientRole | null
  label?: string | null
}

export type CoordinationWatchEvent = {
  eventType: CoordinationWatchEventType
  workspaceId?: string | null
  target: CoordinationTarget
  relatedTargets?: CoordinationTarget[]
  title?: string | null
  message?: string | null
  severity?: 'info' | 'success' | 'warning' | 'error' | null
  occurredAt?: string | null
  metadata?: Record<string, unknown> | null
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
  objective: string
  description?: string | null
  status: CoordinationProjectStatus
  team: string[]
  sourceSessionId?: string | null
}

export type CoordinationTask = CoordinationBase & {
  kind: 'task'
  projectId: string
  parentTaskId?: string | null
  title: string
  spec: string
  description?: string | null
  status: CoordinationTaskStatus
  column: CoordinationTaskColumn
  priority: CoordinationTaskPriority
  externalRef?: string | null
  assigneeAgent?: string | null
  assignedRunId?: string | null
  assignedSessionId?: string | null
  artifactRefs?: CoordinationArtifactLink[]
}

export type CoordinationArtifactLink = {
  artifactId: string
  title?: string | null
  sessionId?: string | null
  runId?: string | null
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
  events: CoordinationWatchEventType[]
  channel: CoordinationWatchChannel
  recipient?: CoordinationWatchRecipient | null
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

export type CoordinationBoardPayload = {
  projects: CoordinationProject[]
  tasks: CoordinationTask[]
}

export type CoordinationProjectInput = {
  title: string
  objective: string
  description?: string | null
  status?: CoordinationProjectStatus
  team?: string[]
  sourceSessionId?: string | null
  workspaceId?: string | null
}

export type CoordinationProjectUpdateInput = Partial<Omit<CoordinationProjectInput, 'workspaceId'>>

export type CoordinationTaskInput = {
  projectId: string
  parentTaskId?: string | null
  title: string
  spec: string
  description?: string | null
  status?: CoordinationTaskStatus
  column?: CoordinationTaskColumn
  priority?: CoordinationTaskPriority
  externalRef?: string | null
  assigneeAgent?: string | null
  assignedRunId?: string | null
  assignedSessionId?: string | null
  artifactRefs?: CoordinationArtifactLink[]
  workspaceId?: string | null
}

export type CoordinationChiefOfStaffTaskDraft = {
  title?: string | null
  spec: string
  assigneeAgent?: string | null
  priority?: CoordinationTaskPriority
  column?: CoordinationTaskColumn
}

export type CoordinationChiefOfStaffPlanInput = {
  projectId: string
  objective?: string | null
  assigneeAgents?: string[]
  tasks?: CoordinationChiefOfStaffTaskDraft[]
  workspaceId?: string | null
}

export type CoordinationChiefOfStaffPlanResult = {
  plannerAgent: 'chief-of-staff'
  displayName: 'Cleo'
  objective: string
  project: CoordinationProject
  tasks: CoordinationTask[]
}

export type CoordinationTaskUpdateInput = Partial<Omit<CoordinationTaskInput, 'projectId' | 'workspaceId'>>

export type CoordinationTaskMoveInput = {
  column: CoordinationTaskColumn
}

export type CoordinationTaskAssignInput = {
  assigneeAgent?: string | null
}

export type CoordinationTaskWorkLinkInput = {
  assignedSessionId: string
  assignedRunId?: string | null
  assigneeAgent?: string | null
  status?: CoordinationTaskStatus
}

export type CoordinationWatchInput = {
  target: CoordinationTarget
  events: CoordinationWatchEventType[]
  channel: CoordinationWatchChannel
  recipient?: CoordinationWatchRecipient | null
  status?: CoordinationWatchStatus
  deliverySurface?: WorkspaceProductSurface | 'gateway_channel'
  verbosity?: CoordinationWatchVerbosity
  cursor?: string | number | null
  workspaceId?: string | null
}

export type CoordinationWatchUpdateInput = Partial<Omit<CoordinationWatchInput, 'workspaceId'>>

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

export function isCoordinationProjectStatus(value: unknown): value is CoordinationProjectStatus {
  return typeof value === 'string' && COORDINATION_PROJECT_STATUSES.includes(value as CoordinationProjectStatus)
}

export function isCoordinationTaskStatus(value: unknown): value is CoordinationTaskStatus {
  return typeof value === 'string' && COORDINATION_TASK_STATUSES.includes(value as CoordinationTaskStatus)
}

export function isCoordinationTaskColumn(value: unknown): value is CoordinationTaskColumn {
  return typeof value === 'string' && COORDINATION_TASK_COLUMNS.includes(value as CoordinationTaskColumn)
}

export function isCoordinationTaskPriority(value: unknown): value is CoordinationTaskPriority {
  return typeof value === 'string' && COORDINATION_TASK_PRIORITIES.includes(value as CoordinationTaskPriority)
}

export function isCoordinationWatchTarget(value: unknown): value is CoordinationWatchTarget {
  return typeof value === 'string' && COORDINATION_WATCH_TARGETS.includes(value as CoordinationWatchTarget)
}

export function isCoordinationWatchEvent(value: unknown): value is CoordinationWatchEventType {
  return typeof value === 'string' && COORDINATION_WATCH_EVENTS.includes(value as CoordinationWatchEventType)
}

export function isCoordinationWatchStatus(value: unknown): value is CoordinationWatchStatus {
  return typeof value === 'string' && COORDINATION_WATCH_STATUSES.includes(value as CoordinationWatchStatus)
}

export function isCoordinationWatchVerbosity(value: unknown): value is CoordinationWatchVerbosity {
  return typeof value === 'string' && COORDINATION_WATCH_VERBOSITIES.includes(value as CoordinationWatchVerbosity)
}

export function isCoordinationWatchRecipientRole(value: unknown): value is CoordinationWatchRecipientRole {
  return typeof value === 'string' && COORDINATION_WATCH_RECIPIENT_ROLES.includes(value as CoordinationWatchRecipientRole)
}

export function coordinationWatchRecipientCanReceive(
  role: CoordinationWatchRecipientRole | null | undefined,
  eventType: CoordinationWatchEventType,
) {
  if (!role || role === 'owner' || role === 'admin' || role === 'member') return true
  if (role === 'approver') return eventType !== 'daily_summary'
  return eventType === 'task.moved' || eventType === 'task.review_ready' || eventType === 'run.finished'
}

export function coordinationTaskColumnForStatus(
  status: CoordinationTaskStatus,
  currentColumn: CoordinationTaskColumn = 'backlog',
): CoordinationTaskColumn {
  if (status === 'running') return 'doing'
  if (status === 'completed') return 'review'
  if (status === 'open') {
    return currentColumn === 'planning' ? 'planning' : 'backlog'
  }
  return currentColumn
}

export function coordinationTaskStatusMovesColumn(status: CoordinationTaskStatus) {
  return status === 'open' || status === 'running' || status === 'completed'
}
