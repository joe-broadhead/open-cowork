export type AutomationSurface = 'chat' | 'automation' | 'both'

export type AutomationKind = 'recurring' | 'managed-project'
export type AutomationStatus = 'draft' | 'enriching' | 'needs_user' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'archived'
export type AutomationRunStatus = 'queued' | 'running' | 'needs_user' | 'completed' | 'failed' | 'cancelled'
export type AutomationRunKind = 'enrichment' | 'execution' | 'heartbeat'
export type AutomationInboxItemType = 'clarification' | 'approval' | 'failure' | 'info'
export type AutomationInboxStatus = 'open' | 'resolved' | 'dismissed'
export type AutomationExecutionMode = 'planning_only' | 'scoped_execution'
export type AutomationAutonomyPolicy = 'review-first' | 'mostly-autonomous'
export type AutomationScheduleType = 'one_time' | 'daily' | 'weekly' | 'monthly'
export type AutomationDeliveryProvider = 'in_app' | 'desktop_notification'
export type AutomationDeliveryStatus = 'delivered' | 'failed'
export type AutomationFailureCode =
  | 'brief_unparseable'
  | 'project_directory_required'
  | 'auth_required'
  | 'configuration_invalid'
  | 'runtime_unavailable'
  | 'daily_run_cap_reached'
  | 'run_timeout'
  | 'provider_capacity'
  | 'network_transient'

export interface AutomationRetryPolicy {
  maxRetries: number
  baseDelayMinutes: number
  maxDelayMinutes: number
}

export interface AutomationRunPolicy {
  dailyRunCap: number
  maxRunDurationMinutes: number
}

export interface AutomationSchedule {
  type: AutomationScheduleType
  timezone: string
  runAtHour?: number | null
  runAtMinute?: number | null
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  startAt?: string | null
}

export interface ExecutionBriefWorkItem {
  id: string
  title: string
  description: string
  ownerAgent: string | null
  dependsOn: string[]
}

export interface ExecutionBrief {
  version: number
  status: 'draft' | 'needs_user' | 'ready'
  goal: string
  deliverables: string[]
  assumptions: string[]
  missingContext: string[]
  successCriteria: string[]
  recommendedAgents: string[]
  workItems: ExecutionBriefWorkItem[]
  approvalBoundary: string
  generatedAt: string
  approvedAt?: string | null
}

export interface AutomationSummary {
  id: string
  title: string
  goal: string
  kind: AutomationKind
  status: AutomationStatus
  schedule: AutomationSchedule
  heartbeatMinutes: number
  retryPolicy: AutomationRetryPolicy
  runPolicy: AutomationRunPolicy
  executionMode: AutomationExecutionMode
  autonomyPolicy: AutomationAutonomyPolicy
  projectDirectory: string | null
  preferredAgentNames: string[]
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  nextHeartbeatAt: string | null
  lastHeartbeatAt: string | null
  latestRunStatus: AutomationRunStatus | null
  latestRunId: string | null
}

export interface AutomationDeliveryRecord {
  id: string
  automationId: string
  runId: string | null
  provider: AutomationDeliveryProvider
  target: string
  status: AutomationDeliveryStatus
  title: string
  body: string
  createdAt: string
}

export interface AutomationDetail extends AutomationSummary {
  brief: ExecutionBrief | null
  latestSessionId: string | null
  deliveries: AutomationDeliveryRecord[]
}

export interface AutomationWorkItem {
  id: string
  automationId: string
  runId: string | null
  title: string
  description: string
  status: 'queued' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed'
  blockingReason: string | null
  ownerAgent: string | null
  dependsOn: string[]
  createdAt: string
  updatedAt: string
}

export interface AutomationRun {
  id: string
  automationId: string
  sessionId: string | null
  kind: AutomationRunKind
  status: AutomationRunStatus
  title: string
  summary: string | null
  error: string | null
  failureCode?: AutomationFailureCode | null
  attempt: number
  retryOfRunId: string | null
  nextRetryAt: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface AutomationInboxItem {
  id: string
  automationId: string
  runId: string | null
  sessionId: string | null
  questionId: string | null
  type: AutomationInboxItemType
  status: AutomationInboxStatus
  title: string
  body: string
  createdAt: string
  updatedAt: string
}

export interface AutomationListPayload {
  automations: AutomationSummary[]
  inbox: AutomationInboxItem[]
  workItems: AutomationWorkItem[]
  runs: AutomationRun[]
  deliveries: AutomationDeliveryRecord[]
}

export interface AutomationDraft {
  title: string
  goal: string
  kind: AutomationKind
  schedule: AutomationSchedule
  heartbeatMinutes: number
  retryPolicy: AutomationRetryPolicy
  runPolicy: AutomationRunPolicy
  executionMode: AutomationExecutionMode
  autonomyPolicy: AutomationAutonomyPolicy
  projectDirectory?: string | null
  preferredAgentNames: string[]
}
