export const COWORK_MEMORY_SCHEMA_VERSION = 1
export const COWORK_IMPROVEMENT_SCHEMA_VERSION = 1
export const COWORK_DREAM_RUN_SCHEMA_VERSION = 1

export type AgentMemoryScopeKind = 'machine' | 'project' | 'agent' | 'crew'
export type AgentMemoryStatus = 'proposed' | 'approved' | 'rejected' | 'archived' | 'quarantined'
export type ImprovementProposalStatus = 'proposed' | 'approved' | 'rejected' | 'archived'
export type ImprovementProposalTargetType = 'memory' | 'agent' | 'skill' | 'sop' | 'crew' | 'eval_case' | 'routing' | 'policy'
export type ImprovementEvidenceKind = 'run' | 'artifact' | 'eval' | 'trace' | 'thread' | 'session' | 'sop' | 'crew'
export type ImprovementDiffOperation = 'create' | 'update' | 'delete'
export type MemoryPrivacyClassification = 'public' | 'internal' | 'sensitive' | 'restricted'
export type DreamRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'archived'

export const APPROVABLE_IMPROVEMENT_PROPOSAL_TARGET_TYPES: readonly ImprovementProposalTargetType[] = ['memory']

export function canApproveImprovementProposalTarget(targetType: ImprovementProposalTargetType) {
  return APPROVABLE_IMPROVEMENT_PROPOSAL_TARGET_TYPES.includes(targetType)
}

export type ImprovementProposalApprovalBlockReason = 'target-type' | 'operation' | 'agent-scope' | 'skill-scope'

function proposalPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === 'string' ? value : null
}

function diffTargetsExistingId(diff: Pick<ImprovementCandidateDiff, 'targetId' | 'payload'>) {
  const targetId = typeof diff.targetId === 'string' ? diff.targetId.trim() : ''
  const payloadId = proposalPayloadString(diff.payload, 'id')?.trim() || ''
  return Boolean(targetId || payloadId)
}

export function improvementProposalApprovalBlockReason(
  proposal: Pick<ImprovementProposal, 'targetType' | 'candidateDiffs'>,
): ImprovementProposalApprovalBlockReason | null {
  if (proposal.targetType === 'agent') {
    const agentDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'agent')
    if (agentDiffs.length < 1) return 'agent-scope'
    return agentDiffs.every((diff) => (proposalPayloadString(diff.payload, 'scope') || 'machine') === 'machine')
      ? null
      : 'agent-scope'
  }
  if (proposal.targetType === 'skill') {
    const skillDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'skill')
    if (skillDiffs.length < 1) return 'skill-scope'
    return skillDiffs.every((diff) => (proposalPayloadString(diff.payload, 'scope') || 'machine') === 'machine')
      ? null
      : 'skill-scope'
  }
  if (proposal.targetType === 'crew') {
    const crewDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'crew')
    if (crewDiffs.length < 1) return 'target-type'
    if (crewDiffs.length !== 1) return 'operation'
    return crewDiffs.every((diff) => diff.operation === 'create' || diff.operation === 'update')
      ? null
      : 'operation'
  }
  if (proposal.targetType === 'sop') {
    const sopDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'sop')
    if (sopDiffs.length < 1) return 'target-type'
    if (proposal.candidateDiffs.length !== 1 || sopDiffs.length !== 1) return 'operation'
    return sopDiffs.every((diff) => diff.operation === 'create' || diff.operation === 'update')
      ? null
      : 'operation'
  }
  if (proposal.targetType === 'eval_case') {
    const evalCaseDiffs = proposal.candidateDiffs.filter((diff) => diff.targetType === 'eval_case')
    if (evalCaseDiffs.length < 1) return 'target-type'
    if (proposal.candidateDiffs.length !== 1 || evalCaseDiffs.length !== 1) return 'operation'
    const evalCaseDiff = evalCaseDiffs[0]!
    if (evalCaseDiff.operation !== 'create') return 'operation'
    return diffTargetsExistingId(evalCaseDiff) ? 'operation' : null
  }
  if (proposal.targetType === 'routing' || proposal.targetType === 'policy') {
    return 'target-type'
  }
  return canApproveImprovementProposalTarget(proposal.targetType) ? null : 'target-type'
}

export function canApproveImprovementProposal(proposal: Pick<ImprovementProposal, 'targetType' | 'candidateDiffs'>) {
  return improvementProposalApprovalBlockReason(proposal) === null
}

export interface ImprovementSchemaVersionedRecord {
  schemaVersion: number
}

export interface ImprovementEvidenceRef extends ImprovementSchemaVersionedRecord {
  kind: ImprovementEvidenceKind
  id: string
  label: string
  uri: string | null
  hash: string | null
}

export interface ImprovementCandidateDiff extends ImprovementSchemaVersionedRecord {
  targetType: ImprovementProposalTargetType
  targetId: string | null
  operation: ImprovementDiffOperation
  summary: string
  beforeHash: string | null
  afterHash: string | null
  payload: Record<string, unknown>
}

export interface AgentMemoryEntry extends ImprovementSchemaVersionedRecord {
  id: string
  scopeKind: AgentMemoryScopeKind
  scopeId: string | null
  status: AgentMemoryStatus
  title: string
  body: string
  summary: string
  tags: string[]
  privacy: MemoryPrivacyClassification
  provenance: ImprovementEvidenceRef[]
  sourceProposalId: string | null
  contentHash: string
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
}

export interface AgentMemoryDraft {
  scopeKind: AgentMemoryScopeKind
  scopeId?: string | null
  title: string
  body: string
  summary?: string | null
  tags?: string[]
  privacy?: MemoryPrivacyClassification
  provenance: ImprovementEvidenceRef[]
  sourceProposalId?: string | null
}

export interface ImprovementProposal extends ImprovementSchemaVersionedRecord {
  id: string
  targetType: ImprovementProposalTargetType
  targetId: string | null
  status: ImprovementProposalStatus
  title: string
  summary: string
  evidence: ImprovementEvidenceRef[]
  candidateDiffs: ImprovementCandidateDiff[]
  createdAt: string
  updatedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
}

export interface ImprovementProposalDraft {
  targetType: ImprovementProposalTargetType
  targetId?: string | null
  title: string
  summary: string
  evidence: ImprovementEvidenceRef[]
  candidateDiffs: ImprovementCandidateDiff[]
}

export interface DreamRun extends ImprovementSchemaVersionedRecord {
  id: string
  status: DreamRunStatus
  title: string
  modelId: string | null
  instructionsHash: string
  sourceMemoryEntryIds: string[]
  sourceTraceEventIds: string[]
  candidateProposalIds: string[]
  tokenUsage: {
    input: number
    output: number
    reasoning: number
  } | null
  costUsd: number | null
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string
  finishedAt: string | null
}

export interface DreamRunDraft {
  title: string
  modelId?: string | null
  instructions: string
  sourceMemoryEntryIds?: string[]
  sourceTraceEventIds?: string[]
}

export interface MemoryInjectionDiagnostics {
  consideredCount: number
  returnedCount: number
  limit: number
  excludedRestrictedCount: number
  scopeKeys: string[]
}

export interface MemoryInjectionPlan {
  entries: AgentMemoryEntry[]
  diagnostics: MemoryInjectionDiagnostics
}

export interface ImprovementStatusCounts {
  proposed: number
  approved: number
  rejected: number
  archived: number
}

export interface ImprovementMemoryStatusCounts extends ImprovementStatusCounts {
  quarantined: number
}

export interface DreamRunStatusCounts {
  running: number
  completed: number
  failed: number
  cancelled: number
  archived: number
}

export interface ImprovementPolicyDiagnostics {
  proposalsEnabled: boolean
  disabledAgentCount: number
  disabledProjectCount: number
  disabledCrewCount: number
}

export interface ImprovementDiagnosticsSummary {
  memory: ImprovementMemoryStatusCounts & {
    approvedRestrictedCount: number
    injection: MemoryInjectionDiagnostics
  }
  proposals: ImprovementStatusCounts
  dreamRuns: DreamRunStatusCounts
  policy: ImprovementPolicyDiagnostics
}

export interface ImprovementReviewQueue {
  memory: AgentMemoryEntry[]
  proposals: ImprovementProposal[]
  dreamRuns: DreamRun[]
}
