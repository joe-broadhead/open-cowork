import type { SessionTokens } from './session.js'

export const COWORK_WORK_LEDGER_SCHEMA_VERSION = 1

export type WorkLedgerSourceKind =
  | 'thread'
  | 'automation'
  | 'automation_run'
  | 'crew'
  | 'crew_run'
  | 'delegated_task'
  | 'approval'
  | 'question'
  | 'delivery'
  | 'channel_event'
  | 'governance_incident'

export type WorkLedgerStatus =
  | 'active'
  | 'approval_required'
  | 'approved'
  | 'archived'
  | 'automation'
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'delivered'
  | 'delivering'
  | 'denied'
  | 'dispatching'
  | 'dispatched'
  | 'dismissed'
  | 'draft'
  | 'drafted'
  | 'enriching'
  | 'error'
  | 'evaluating'
  | 'failed'
  | 'idle'
  | 'needs_user'
  | 'paused'
  | 'planning'
  | 'queued'
  | 'ready'
  | 'received'
  | 'retired'
  | 'reverted'
  | 'review'
  | 'running'
  | 'sending'
  | 'succeeded'
  | 'unknown'

export type WorkLedgerReviewState =
  | 'none'
  | 'needs_review'
  | 'approval_requested'
  | 'approved'
  | 'denied'
  | 'resolved'
  | 'failed'

export type WorkLedgerSort = 'updated_desc' | 'created_desc' | 'title_asc'

export interface WorkLedgerSourceRef {
  kind: WorkLedgerSourceKind
  id: string
  sessionId?: string | null
  automationId?: string | null
  automationRunId?: string | null
  crewId?: string | null
  crewRunId?: string | null
  crewNodeId?: string | null
  approvalId?: string | null
  questionId?: string | null
  deliveryId?: string | null
  channelId?: string | null
  channelEventId?: string | null
  governanceAuditEventId?: string | null
  artifactId?: string | null
}

export interface WorkLedgerDrilldownRoute {
  surface: 'thread' | 'automations' | 'crews' | 'channels' | 'operations'
  sessionId?: string | null
  automationId?: string | null
  automationRunId?: string | null
  crewId?: string | null
  crewRunId?: string | null
  channelId?: string | null
  governanceAuditEventId?: string | null
}

export interface WorkLedgerUsageSummary {
  cost: number
  tokens: SessionTokens
}

export interface WorkLedgerEntry {
  schemaVersion: number
  id: string
  sourceKind: WorkLedgerSourceKind
  sourceId: string
  title: string
  summary: string | null
  status: WorkLedgerStatus
  sourceLabel: string
  owner: string | null
  agents: string[]
  capabilities: string[]
  usage: WorkLedgerUsageSummary
  riskLabels: string[]
  governanceLabels: string[]
  reviewState: WorkLedgerReviewState
  needsUserAttention: boolean
  sourceRef: WorkLedgerSourceRef
  route: WorkLedgerDrilldownRoute
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  indexedAt: string
}

export type WorkLedgerUpsertInput = Omit<WorkLedgerEntry, 'schemaVersion' | 'indexedAt'> & {
  schemaVersion?: number
  indexedAt?: string
}

export interface WorkLedgerSearchQuery {
  text?: string
  cursor?: string | null
  limit?: number
  dateRange?: { from?: string; to?: string }
  sourceKinds?: WorkLedgerSourceKind[]
  statuses?: WorkLedgerStatus[]
  owners?: string[]
  agents?: string[]
  capabilities?: string[]
  riskLabels?: string[]
  governanceLabels?: string[]
  reviewStates?: WorkLedgerReviewState[]
  needsUserAttention?: boolean | null
  sort?: WorkLedgerSort
}

export interface WorkLedgerSearchResult {
  entries: WorkLedgerEntry[]
  nextCursor: string | null
  totalEstimate: number
}

export interface WorkLedgerFacetBucket {
  value: string
  label: string
  count: number
}

export interface WorkLedgerFacetSummary {
  sourceKinds: WorkLedgerFacetBucket[]
  statuses: WorkLedgerFacetBucket[]
  owners: WorkLedgerFacetBucket[]
  agents: WorkLedgerFacetBucket[]
  capabilities: WorkLedgerFacetBucket[]
  riskLabels: WorkLedgerFacetBucket[]
  governanceLabels: WorkLedgerFacetBucket[]
  reviewStates: WorkLedgerFacetBucket[]
}

export const WORK_LEDGER_SEARCH_DEFAULT_LIMIT = 50
export const WORK_LEDGER_SEARCH_MAX_LIMIT = 100
export const WORK_LEDGER_FILTER_MAX_VALUES = 50
export const WORK_LEDGER_QUERY_MAX_LENGTH = 256
