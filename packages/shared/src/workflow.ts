export type WorkflowSurface = 'chat' | 'workflow' | 'both'

export type WorkflowStatus = 'active' | 'paused' | 'running' | 'failed' | 'archived'
export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowTriggerType = 'manual' | 'schedule' | 'webhook'
export type WorkflowScheduleType = 'one_time' | 'daily' | 'weekly' | 'monthly'

export interface WorkflowSchedule {
  type: WorkflowScheduleType
  timezone: string
  runAtHour?: number | null
  runAtMinute?: number | null
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  startAt?: string | null
}

export interface WorkflowTrigger {
  id: string
  type: WorkflowTriggerType
  enabled: boolean
  schedule?: WorkflowSchedule | null
  webhookSecret?: string | null
}

export interface WorkflowDraft {
  title: string
  instructions: string
  agentName: string
  skillNames?: string[]
  toolIds?: string[]
  projectDirectory?: string | null
  draftSessionId?: string | null
  triggers: WorkflowTrigger[]
}

export interface WorkflowSummary {
  id: string
  title: string
  instructions: string
  agentName: string
  skillNames: string[]
  toolIds: string[]
  status: WorkflowStatus
  projectDirectory: string | null
  draftSessionId: string | null
  triggers: WorkflowTrigger[]
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  latestRunId: string | null
  latestRunStatus: WorkflowRunStatus | null
  latestRunSessionId: string | null
  latestRunSummary: string | null
  webhookUrl: string | null
}

export interface WorkflowRun {
  id: string
  workflowId: string
  sessionId: string | null
  triggerType: WorkflowTriggerType
  triggerPayload: Record<string, unknown> | null
  status: WorkflowRunStatus
  title: string
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface WorkflowDetail extends WorkflowSummary {
  runs: WorkflowRun[]
}

export interface WorkflowListPayload {
  workflows: WorkflowSummary[]
  runs: WorkflowRun[]
}

export interface WorkflowToolPreview {
  ok: boolean
  title: string
  summary: string
  missing: string[]
  normalizedDraft?: WorkflowDraft
}

export interface WorkflowToolCreateResult {
  ok: true
  workflow: WorkflowDetail
}
