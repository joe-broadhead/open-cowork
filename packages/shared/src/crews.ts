export const COWORK_CREW_SCHEMA_VERSION = 1
export const COWORK_TRACE_EVENT_SCHEMA_VERSION = 1
export const COWORK_EVAL_SCHEMA_VERSION = 1

export type CoworkRunKind = 'crew' | 'sop' | 'automation'

export type CrewMemberRole = 'lead' | 'specialist' | 'evaluator'
export type CrewLifecycleStatus = 'draft' | 'review' | 'approved' | 'active' | 'paused' | 'retired'
export type CrewRunStatus = 'queued' | 'planning' | 'running' | 'blocked' | 'evaluating' | 'delivering' | 'completed' | 'failed' | 'cancelled'
export type CrewRunNodeKind = 'plan' | 'delegate' | 'join' | 'evaluate' | 'deliver' | 'approval' | 'system'
export type CrewRunNodeStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'skipped'
export type TraceRedactionState = 'none' | 'redacted' | 'restricted'
export type TraceEventSource = 'opencode_event' | 'cowork_policy' | 'cowork_eval' | 'cowork_ui' | 'cowork_worker'
export type TraceActorKind = 'user' | 'agent' | 'crew' | 'sop' | 'system' | 'opencode'
export type PolicyDecisionStatus = 'allowed' | 'denied' | 'approval_required'
export type CrewApprovalStatus = 'requested' | 'approved' | 'denied' | 'cancelled'
export type OutcomeEvaluationStatus = 'passed' | 'failed' | 'needs_revision' | 'needs_human'

export interface SchemaVersionedRecord {
  schemaVersion: number
}

export interface CrewMember extends SchemaVersionedRecord {
  id: string
  role: CrewMemberRole
  agentName: string
  displayName: string
  description: string
  required: boolean
}

export interface CrewMemberDraft {
  role: CrewMemberRole
  agentName: string
  displayName?: string
  description?: string
  required?: boolean
}

export interface CrewDefinitionDraft {
  name: string
  description: string
  members: CrewMemberDraft[]
  workspaceProfileId?: string | null
  outcomeRubricId?: string | null
  budgetCapUsd?: number | null
}

export interface OutcomeRubricCriterion extends SchemaVersionedRecord {
  id: string
  label: string
  description: string
  weight: number
  passingScore: number
}

export interface OutcomeRubric extends SchemaVersionedRecord {
  id: string
  name: string
  description: string
  criteria: OutcomeRubricCriterion[]
  passingScore: number
  createdAt: string
  updatedAt: string
}

export interface CrewDefinition extends SchemaVersionedRecord {
  id: string
  name: string
  description: string
  status: CrewLifecycleStatus
  activeVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface CrewVersion extends SchemaVersionedRecord {
  id: string
  crewId: string
  version: number
  members: CrewMember[]
  workspaceProfileId: string | null
  outcomeRubricId: string | null
  budgetCapUsd: number | null
  workflow: CrewRunNodeKind[]
  createdAt: string
  createdBy: string | null
}

export interface CoworkWorkItem extends SchemaVersionedRecord {
  id: string
  title: string
  description: string
  source: 'manual' | 'automation' | 'sop' | 'channel'
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface CrewRun extends SchemaVersionedRecord {
  id: string
  crewId: string
  crewVersionId: string
  workItemId: string | null
  status: CrewRunStatus
  title: string
  summary: string | null
  rootSessionId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface CrewRunNode extends SchemaVersionedRecord {
  id: string
  crewRunId: string
  sequence: number
  kind: CrewRunNodeKind
  status: CrewRunNodeStatus
  agentName: string | null
  sessionId: string | null
  parentNodeId: string | null
  title: string
  startedAt: string | null
  finishedAt: string | null
}

export interface CrewArtifact extends SchemaVersionedRecord {
  id: string
  crewRunId: string
  nodeId: string | null
  title: string
  mime: string
  uri: string
  hash: string | null
  createdAt: string
}

export interface CrewApproval extends SchemaVersionedRecord {
  id: string
  crewRunId: string
  nodeId: string | null
  status: CrewApprovalStatus
  title: string
  body: string
  requestedAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

export interface PolicyDecision extends SchemaVersionedRecord {
  id: string
  runId: string
  runKind: CoworkRunKind
  nodeId: string | null
  status: PolicyDecisionStatus
  reason: string
  capabilityId: string | null
  createdAt: string
}

export interface EvalCase extends SchemaVersionedRecord {
  id: string
  suiteId: string
  name: string
  inputRef: string
  expectedOutcome: string
  createdAt: string
  updatedAt: string
}

export interface EvalSuite extends SchemaVersionedRecord {
  id: string
  name: string
  description: string
  status: 'draft' | 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface OutcomeEvaluation extends SchemaVersionedRecord {
  id: string
  crewRunId: string
  evaluatorAgentName: string
  rubricId: string
  status: OutcomeEvaluationStatus
  score: number
  evidenceTraceEventIds: string[]
  recommendation: 'deliver' | 'revise' | 'escalate'
  createdAt: string
}

export interface CrewListItem {
  definition: CrewDefinition
  activeVersion: CrewVersion | null
  latestRun: CrewRun | null
}

export interface CrewListPayload {
  crews: CrewListItem[]
}

export interface CrewDetail {
  definition: CrewDefinition
  versions: CrewVersion[]
  activeVersion: CrewVersion | null
  runs: CrewRun[]
}

export interface CrewRunDetail {
  run: CrewRun
  crew: CrewDefinition
  version: CrewVersion
  workItem: CoworkWorkItem | null
  nodes: CrewRunNode[]
  artifacts: CrewArtifact[]
  approvals: CrewApproval[]
  policyDecisions: PolicyDecision[]
  evaluations: OutcomeEvaluation[]
  traceEvents: CoworkTraceEvent[]
}

export interface CrewRunDraft {
  crewId: string
  title: string
  workItemTitle?: string | null
  workItemDescription?: string | null
}

export interface TraceActor {
  kind: TraceActorKind
  id: string
}

export interface TraceTokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface CoworkTraceEvent extends SchemaVersionedRecord {
  id: string
  sequence: number
  runId: string
  runKind: CoworkRunKind
  source: TraceEventSource
  sourceEventId: string | null
  correlationId: string | null
  causationId: string | null
  sessionId: string | null
  parentSessionId: string | null
  actor: TraceActor
  nodeId: string | null
  artifactId: string | null
  approvalId: string | null
  policyDecisionId: string | null
  inputHash: string | null
  outputHash: string | null
  payloadRef: string | null
  payloadHash: string | null
  redactionState: TraceRedactionState
  tokenUsage: TraceTokenUsage | null
  costUsd: number | null
  payload: Record<string, unknown> | null
  createdAt: string
}

export type CoworkTraceEventInput = Omit<CoworkTraceEvent, 'schemaVersion'>

export function createCoworkTraceEvent(input: CoworkTraceEventInput): CoworkTraceEvent {
  return {
    schemaVersion: COWORK_TRACE_EVENT_SCHEMA_VERSION,
    ...input,
  }
}

export function sortCoworkTraceEvents(events: CoworkTraceEvent[]): CoworkTraceEvent[] {
  return events.slice().sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    const timeCompare = left.createdAt.localeCompare(right.createdAt)
    if (timeCompare !== 0) return timeCompare
    return left.id.localeCompare(right.id)
  })
}

export function toExportableCoworkTraceEvent(event: CoworkTraceEvent): CoworkTraceEvent {
  if (event.redactionState === 'none') {
    return {
      ...event,
      tokenUsage: event.tokenUsage ? { ...event.tokenUsage } : null,
      payload: event.payload ? { ...event.payload } : null,
      actor: { ...event.actor },
    }
  }

  return {
    ...event,
    tokenUsage: event.tokenUsage ? { ...event.tokenUsage } : null,
    payload: null,
    actor: { ...event.actor },
  }
}

export function serializeCoworkTraceEvent(event: CoworkTraceEvent): string {
  const exportable = toExportableCoworkTraceEvent(event)
  return JSON.stringify({
    schemaVersion: exportable.schemaVersion,
    id: exportable.id,
    sequence: exportable.sequence,
    runId: exportable.runId,
    runKind: exportable.runKind,
    source: exportable.source,
    sourceEventId: exportable.sourceEventId,
    correlationId: exportable.correlationId,
    causationId: exportable.causationId,
    sessionId: exportable.sessionId,
    parentSessionId: exportable.parentSessionId,
    actor: exportable.actor,
    nodeId: exportable.nodeId,
    artifactId: exportable.artifactId,
    approvalId: exportable.approvalId,
    policyDecisionId: exportable.policyDecisionId,
    inputHash: exportable.inputHash,
    outputHash: exportable.outputHash,
    payloadRef: exportable.payloadRef,
    payloadHash: exportable.payloadHash,
    redactionState: exportable.redactionState,
    tokenUsage: exportable.tokenUsage,
    costUsd: exportable.costUsd,
    payload: exportable.payload,
    createdAt: exportable.createdAt,
  })
}
