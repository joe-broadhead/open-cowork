import type { ArtifactKind, ArtifactStatus } from './artifacts.js'
import type { CoordinationTaskPriority, CoordinationTaskStatus } from './coordination.js'
import type { WorkspaceOptions } from './workspace.js'

export interface LaunchpadFeedRequest extends WorkspaceOptions {
  projectId?: string | null
  limit?: number | null
  inProgressLimit?: number | null
  waitingLimit?: number | null
  artifactsLimit?: number | null
}

export interface LaunchpadFeedItemBase {
  id: string
  title: string
  projectId?: string | null
  projectTitle?: string | null
  taskId?: string | null
  taskTitle?: string | null
  sessionId?: string | null
  runId?: string | null
  assigneeAgent?: string | null
  when: string
  updatedAt?: string | null
}

export interface LaunchpadInProgressItem extends LaunchpadFeedItemBase {
  kind: 'task'
  status: CoordinationTaskStatus
  priority: CoordinationTaskPriority
}

export interface LaunchpadWaitingItem extends LaunchpadFeedItemBase {
  kind: 'permission' | 'question'
  status: 'pending'
}

export interface LaunchpadFreshArtifactItem extends LaunchpadFeedItemBase {
  artifactId: string
  kind: ArtifactKind
  status: ArtifactStatus
  authorAgentId?: string | null
  createdAt?: string | null
}

export interface LaunchpadFeedPayload {
  generatedAt: string
  inProgress: LaunchpadInProgressItem[]
  waitingOnYou: LaunchpadWaitingItem[]
  freshArtifacts: LaunchpadFreshArtifactItem[]
  totals: {
    inProgress: number
    waitingOnYou: number
    freshArtifacts: number
  }
  truncated: {
    inProgress: boolean
    waitingOnYou: boolean
    freshArtifacts: boolean
  }
}
