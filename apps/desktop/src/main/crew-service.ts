import {
  COWORK_CREW_SCHEMA_VERSION,
  COWORK_EVAL_SCHEMA_VERSION,
  type CrewDefinitionDraft,
  type CrewDetail,
  type CrewApprovalPolicy,
  type CrewLifecycleStatus,
  type CrewListPayload,
  type CrewMember,
  type CrewMemberDraft,
  type CoworkTraceEvent,
  type OutcomeEvaluation,
  type OutcomeEvaluationStatus,
  type CrewRunDetail,
  type CrewRunDraft,
  type CrewRunUrgency,
  type TraceActor,
  type TraceEventSource,
  type GovernancePrincipal,
  createCoworkTraceEvent,
} from '@open-cowork/shared'
import { createHash } from 'node:crypto'
import {
  appendCoworkTraceEvent,
  createEvalCase as createStoredEvalCase,
  createCoworkWorkItem,
  createCrewDefinition,
  createCrewRun,
  createCrewRunNode,
  createCrewVersion,
  deleteCrewDefinitionIfUnused,
  createOutcomeRubric,
  exportCoworkTraceEventsForRun,
  getCrewDefinition,
  getCoworkWorkItem,
  getCrewRun,
  getCrewRunByRootSessionId,
  getCrewVersion,
  getEvalSuite,
  getOutcomeEvaluation,
  getOutcomeRubric,
  listEvalCasesForSuite,
  listCoworkTraceEventsForRun,
  listCrewApprovalsForRun,
  listCrewArtifactsForRun,
  listCrewDefinitions,
  listCrewRunNodes,
  listCrewRuns,
  listCrewVersions,
  listOutcomeEvaluationsForRun,
  listPolicyDecisionsForRun,
  markCrewVersionCertified,
  recordOutcomeEvaluation,
  updateCrewDefinitionMetadata,
  updateCrewRunStatus,
  updateCrewRunNodeStatus,
  withCrewTransaction,
} from './crew-store.ts'
import { recordGovernanceAuditEvent } from './governance-audit-store.ts'
import {
  LOCAL_GOVERNANCE_APPROVERS,
  LOCAL_GOVERNANCE_OWNER,
  assertGovernanceIncidentControlAllowed,
  decideGovernanceIncidentControl,
} from './governance-policy.ts'
import {
  crewOutcomeEvaluationOutputFormat,
  crewOutcomeEvaluationSchemaHint,
  extractCrewOutcomeEvaluationFromAssistantText,
  extractCrewOutcomeEvaluationFromStructured,
  type CrewOutcomeEvaluationResult,
} from './crew-evaluation-contract.ts'
import { recordCrewEvaluationRemediation } from './crew-evaluation-remediation.ts'
import {
  enqueueCrewOperationalQueueItem,
  listQueuedCrewOperationalQueueItems,
  startCrewOperationalQueueItem,
  syncCrewOperationalQueueStatus,
} from './crew-operational-queue.ts'
import type { CrewRuntimeExecutionDriver } from './crew-runtime-execution.ts'

const MAX_CREW_MEMBERS = 25
const MAX_CREW_STRING_BYTES = 16 * 1024
const MAX_EVALUATION_EVIDENCE_EVENTS = 100
const MAX_EVALUATION_TRACE_PROMPT_EVENTS = 80
const FIXED_CREW_WORKFLOW = ['plan', 'delegate', 'join', 'evaluate', 'deliver'] as const
const DEFAULT_CREW_APPROVAL_POLICY: CrewApprovalPolicy = 'review-before-delivery'
const CREW_APPROVAL_POLICIES = new Set<CrewApprovalPolicy>(['review-before-delivery', 'auto-deliver-after-evaluation'])
const CREW_RUN_URGENCIES = new Set<CrewRunUrgency>(['low', 'normal', 'high', 'urgent'])
const inFlightEvaluationRunIds = new Set<string>()
const DEFAULT_CREW_OUTCOME_RUBRIC = {
  name: 'Crew outcome rubric',
  description: 'Checks whether the crew output is correct, evidence-backed, and useful enough to deliver.',
  passingScore: 80,
  criteria: [
    {
      schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
      id: 'correctness',
      label: 'Correctness',
      description: 'The answer directly satisfies the requested work item without material errors.',
      weight: 0.4,
      passingScore: 80,
    },
    {
      schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
      id: 'evidence',
      label: 'Evidence',
      description: 'Major claims are backed by traceable tool calls, artifacts, or specialist outputs.',
      weight: 0.35,
      passingScore: 80,
    },
    {
      schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
      id: 'usefulness',
      label: 'Usefulness',
      description: 'The delivered result is concise, actionable, and clear about limitations.',
      weight: 0.25,
      passingScore: 80,
    },
  ],
}

export type CrewIncidentControlOptions = {
  actor?: GovernancePrincipal | null
  reason?: string | null
}

function boundedString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CREW_STRING_BYTES) throw new Error(`${label} is too large.`)
  return trimmed
}

function boundedOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  return boundedString(value, label)
}

function boundedOptionalPositiveNumber(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`)
  }
  return value
}

function normalizeCrewRunUrgency(value: CrewRunDraft['urgency']) {
  if (value === undefined || value === null) return null
  if (CREW_RUN_URGENCIES.has(value)) return value
  throw new Error('Crew run urgency is invalid.')
}

function normalizeCrewRunDueAt(value: CrewRunDraft['dueAt']) {
  const dueAt = boundedOptionalString(value, 'Crew run due date')
  if (!dueAt) return null
  if (Number.isNaN(Date.parse(dueAt))) throw new Error('Crew run due date is invalid.')
  return dueAt
}

function appendRunDetailLine(lines: string[], label: string, value: string | number | null | undefined) {
  if (value === undefined || value === null || value === '') return
  lines.push(`${label}: ${value}`)
}

function crewRunWorkItemDescription(draft: CrewRunDraft, fallback: string) {
  const description = boundedOptionalString(draft.workItemDescription, 'Crew work item description')
  const expectedDeliverable = boundedOptionalString(draft.expectedDeliverable, 'Crew expected deliverable')
  const constraints = boundedOptionalString(draft.constraints, 'Crew run constraints')
  const dueAt = normalizeCrewRunDueAt(draft.dueAt)
  const urgency = normalizeCrewRunUrgency(draft.urgency)
  const budgetCapUsd = boundedOptionalPositiveNumber(draft.budgetCapUsd, 'Crew run budget cap')
  const approvalRequirements = boundedOptionalString(draft.approvalRequirements, 'Crew approval requirements')
  const sourceContext = boundedOptionalString(draft.sourceContext, 'Crew source context')
  const lines = [description || fallback]
  appendRunDetailLine(lines, 'Expected deliverable', expectedDeliverable)
  appendRunDetailLine(lines, 'Constraints', constraints)
  appendRunDetailLine(lines, 'Due date', dueAt)
  appendRunDetailLine(lines, 'Urgency', urgency)
  appendRunDetailLine(lines, 'Run budget cap USD', budgetCapUsd)
  appendRunDetailLine(lines, 'Approval requirements', approvalRequirements)
  appendRunDetailLine(lines, 'Source context', sourceContext)
  return lines.join('\n')
}

function boundedIncidentReason(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Crew incident reason must be a string.')
  const reason = value.trim()
  if (!reason) return fallback
  if (Buffer.byteLength(reason, 'utf8') > MAX_CREW_STRING_BYTES) throw new Error('Crew incident reason is too large.')
  return reason
}

function memberIdFor(index: number, draft: CrewMemberDraft) {
  const base = `${draft.role}-${draft.agentName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base ? `${base}-${index + 1}` : `${draft.role}-${index + 1}`
}

function normalizeCrewMember(draft: CrewMemberDraft, index: number): CrewMember {
  if (draft.role !== 'lead' && draft.role !== 'specialist' && draft.role !== 'evaluator') {
    throw new Error(`Crew member ${index + 1} role is invalid.`)
  }
  const agentName = boundedString(draft.agentName, `Crew member ${index + 1} agent name`)
  const displayName = boundedOptionalString(draft.displayName, `Crew member ${index + 1} display name`) || agentName
  return {
    schemaVersion: COWORK_CREW_SCHEMA_VERSION,
    id: memberIdFor(index, { ...draft, agentName }),
    role: draft.role,
    agentName,
    displayName,
    description: boundedOptionalString(draft.description, `Crew member ${index + 1} description`) || `${displayName} crew member`,
    required: draft.required ?? true,
  }
}

function normalizeApprovalPolicy(value: CrewDefinitionDraft['approvalPolicy']): CrewApprovalPolicy {
  if (value === undefined || value === null) return DEFAULT_CREW_APPROVAL_POLICY
  if (CREW_APPROVAL_POLICIES.has(value)) return value
  throw new Error('Crew approval policy is invalid.')
}

export function validateCrewDefinitionDraft(
  draft: CrewDefinitionDraft,
  options: { knownAgentNames?: readonly string[] } = {},
) {
  boundedString(draft.name, 'Crew name')
  boundedString(draft.description, 'Crew description')
  if (!Array.isArray(draft.members)) throw new Error('Crew members must be an array.')
  if (draft.members.length > MAX_CREW_MEMBERS) throw new Error('Crew has too many members.')
  const members = draft.members.map(normalizeCrewMember)
  const knownAgents = new Set((options.knownAgentNames || []).map((name) => name.trim().toLowerCase()).filter(Boolean))
  const agentNames = new Set<string>()
  for (const member of members) {
    const normalizedAgentName = member.agentName.toLowerCase()
    if (agentNames.has(normalizedAgentName)) throw new Error(`Crew member ${member.agentName} is assigned more than once.`)
    agentNames.add(normalizedAgentName)
    if (knownAgents.size > 0 && !knownAgents.has(normalizedAgentName)) {
      throw new Error(`Crew member ${member.agentName} does not match a known agent.`)
    }
  }
  const leadCount = members.filter((member) => member.role === 'lead').length
  const specialistCount = members.filter((member) => member.role === 'specialist').length
  const evaluatorCount = members.filter((member) => member.role === 'evaluator').length
  if (leadCount < 1) throw new Error('Crew requires at least one lead agent.')
  if (specialistCount < 2) throw new Error('Crew requires at least two specialist agents.')
  if (evaluatorCount < 1) throw new Error('Crew requires at least one evaluator agent.')
  if (draft.budgetCapUsd !== undefined && draft.budgetCapUsd !== null) {
    if (typeof draft.budgetCapUsd !== 'number' || !Number.isFinite(draft.budgetCapUsd) || draft.budgetCapUsd <= 0) {
      throw new Error('Crew budget cap must be a positive number.')
    }
  }
  normalizeApprovalPolicy(draft.approvalPolicy)
  return members
}

export function createCrewFromDraft(draft: CrewDefinitionDraft): CrewDetail {
  const members = validateCrewDefinitionDraft(draft)
  return withCrewTransaction(() => {
    const definition = createCrewDefinition({
      name: boundedString(draft.name, 'Crew name'),
      description: boundedString(draft.description, 'Crew description'),
    })
    if (!definition) throw new Error('Failed to create crew.')
    const version = createCrewVersion({
      crewId: definition.id,
      members,
      workspaceProfileId: draft.workspaceProfileId || null,
      outcomeRubricId: ensureCrewOutcomeRubricId(draft.outcomeRubricId || null),
      evalSuiteId: ensureCrewEvalSuiteId(draft.evalSuiteId || null),
      budgetCapUsd: draft.budgetCapUsd ?? null,
      approvalPolicy: normalizeApprovalPolicy(draft.approvalPolicy),
      workflow: [...FIXED_CREW_WORKFLOW],
      createdBy: 'local-user',
    })
    if (!version) throw new Error('Failed to create crew version.')
    const detail = getCrewDetail(definition.id)
    if (!detail) throw new Error('Failed to load created crew.')
    return detail
  })
}

export function updateCrewFromDraft(crewId: string, draft: CrewDefinitionDraft): CrewDetail {
  const id = boundedString(crewId, 'Crew id')
  const members = validateCrewDefinitionDraft(draft)
  return withCrewTransaction(() => {
    const current = getCrewDefinition(id)
    if (!current) throw new Error(`Crew ${id} does not exist.`)
    const definition = updateCrewDefinitionMetadata(id, {
      name: boundedString(draft.name, 'Crew name'),
      description: boundedString(draft.description, 'Crew description'),
    })
    if (!definition) throw new Error('Failed to update crew definition.')
    const version = createCrewVersion({
      crewId: id,
      members,
      workspaceProfileId: draft.workspaceProfileId || null,
      outcomeRubricId: ensureCrewOutcomeRubricId(draft.outcomeRubricId || null),
      evalSuiteId: ensureCrewEvalSuiteId(draft.evalSuiteId || null),
      budgetCapUsd: draft.budgetCapUsd ?? null,
      approvalPolicy: normalizeApprovalPolicy(draft.approvalPolicy),
      workflow: [...FIXED_CREW_WORKFLOW],
      createdBy: 'local-user',
    })
    if (!version) throw new Error('Failed to create crew version.')
    const detail = getCrewDetail(id)
    if (!detail) throw new Error('Failed to load updated crew.')
    return detail
  })
}

function setCrewLifecycleStatus(
  crewId: string,
  status: CrewLifecycleStatus,
  options: CrewIncidentControlOptions = {},
): CrewDetail {
  const id = boundedString(crewId, 'Crew id')
  return withCrewTransaction(() => {
    const current = getCrewDefinition(id)
    if (!current) throw new Error(`Crew ${id} does not exist.`)
    if (current.status === 'retired' && status !== 'retired') {
      throw new Error(`Crew ${id} is retired and cannot be reactivated.`)
    }
    const action = status === 'paused' ? 'pause_crew' : 'retire_crew'
    const reason = boundedIncidentReason(options.reason, status === 'paused'
      ? 'Crew paused through governance incident control.'
      : 'Crew retired through governance incident control.')
    const subjectId = `crew:${encodeURIComponent(id)}`
    const policyDecision = decideGovernanceIncidentControl({
      actor: options.actor,
      action,
      subjectKind: 'crew',
      subjectId,
      owner: LOCAL_GOVERNANCE_OWNER,
      approvers: LOCAL_GOVERNANCE_APPROVERS,
    })
    if (policyDecision.outcome === 'denied') {
      recordGovernanceAuditEvent({
        subjectKind: 'crew',
        subjectId,
        action,
        outcome: 'failed',
        actor: policyDecision.actor,
        beforeLifecycle: current.status,
        afterLifecycle: null,
        reason: policyDecision.reason,
        metadata: {
          crewId: id,
          crewName: current.name,
          policyDecision,
        },
      })
      assertGovernanceIncidentControlAllowed(policyDecision)
    }
    const updated = updateCrewDefinitionMetadata(id, {
      name: current.name,
      description: current.description,
      status,
    })
    if (!updated) throw new Error(`Failed to update crew ${id}.`)
    const detail = getCrewDetail(id)
    if (!detail) throw new Error(`Failed to load crew ${id}.`)
    recordGovernanceAuditEvent({
      subjectKind: 'crew',
      subjectId,
      action,
      actor: policyDecision.actor,
      beforeLifecycle: current.status,
      afterLifecycle: status,
      reason,
      metadata: {
        crewId: id,
        crewName: current.name,
        policyDecision,
      },
    })
    return detail
  })
}

export function pauseCrew(crewId: string, options?: CrewIncidentControlOptions): CrewDetail {
  return setCrewLifecycleStatus(crewId, 'paused', options)
}

export function retireCrew(crewId: string, options?: CrewIncidentControlOptions): CrewDetail {
  return setCrewLifecycleStatus(crewId, 'retired', options)
}

export function deleteCrew(crewId: string): boolean {
  const id = boundedString(crewId, 'Crew id')
  return deleteCrewDefinitionIfUnused(id)
}

export function listCrewCatalog(): CrewListPayload {
  const crews = listCrewDefinitions().map((definition) => {
    const activeVersion = definition.activeVersionId ? getCrewVersion(definition.activeVersionId) : null
    const latestRun = listCrewRuns(definition.id)[0] || null
    return {
      definition,
      activeVersion,
      latestRun,
    }
  })
  return { crews }
}

export function getCrewDetail(crewId: string): CrewDetail | null {
  const definition = getCrewDefinition(crewId)
  if (!definition) return null
  const versions = listCrewVersions(crewId)
  const activeVersion = definition.activeVersionId ? versions.find((version) => version.id === definition.activeVersionId) || null : null
  return {
    definition,
    versions,
    activeVersion,
    runs: listCrewRuns(crewId),
  }
}

export function createCrewEvalCase(input: {
  suiteId: string
  name: string
  inputRef: string
  expectedOutcome: string
}) {
  return requireCreated(createStoredEvalCase({
    suiteId: boundedString(input.suiteId, 'Eval case suite id'),
    name: boundedString(input.name, 'Eval case name'),
    inputRef: boundedString(input.inputRef, 'Eval case input reference'),
    expectedOutcome: boundedString(input.expectedOutcome, 'Eval case expected outcome'),
  }), 'eval case')
}

function appendRunTrace(input: {
  runId: string
  sequence: number
  nodeId?: string | null
  source?: TraceEventSource
  sourceEventId?: string | null
  sessionId?: string | null
  parentSessionId?: string | null
  actor?: TraceActor
  actorId?: string
  inputHash?: string | null
  outputHash?: string | null
  payloadHash?: string | null
  payload: Record<string, unknown>
}) {
  appendCoworkTraceEvent(createCoworkTraceEvent({
    id: crypto.randomUUID(),
    sequence: input.sequence,
    runId: input.runId,
    runKind: 'crew',
    source: input.source || 'cowork_worker',
    sourceEventId: input.sourceEventId ?? null,
    correlationId: input.runId,
    causationId: null,
    sessionId: input.sessionId ?? null,
    parentSessionId: input.parentSessionId ?? null,
    actor: input.actor || { kind: 'crew', id: input.actorId || input.runId },
    nodeId: input.nodeId || null,
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: input.inputHash ?? null,
    outputHash: input.outputHash ?? null,
    payloadRef: null,
    payloadHash: input.payloadHash ?? null,
    redactionState: 'none',
    tokenUsage: null,
    costUsd: null,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  }))
}

function nextTraceSequence(runId: string) {
  return listCoworkTraceEventsForRun(runId).reduce((max, event) => Math.max(max, event.sequence), 0) + 1
}

function sha256Text(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Unknown error')
}

function ensureCrewOutcomeRubricId(requestedId: string | null) {
  if (requestedId) {
    if (getOutcomeRubric(requestedId)) return requestedId
    throw new Error(`Outcome rubric ${requestedId} does not exist.`)
  }
  const rubric = createOutcomeRubric(DEFAULT_CREW_OUTCOME_RUBRIC)
  if (!rubric) throw new Error('Failed to create default crew outcome rubric.')
  return rubric.id
}

function ensureCrewEvalSuiteId(requestedId: string | null) {
  if (!requestedId) return null
  const suite = getEvalSuite(requestedId)
  if (!suite) throw new Error(`Eval suite ${requestedId} does not exist.`)
  if (suite.status !== 'active') throw new Error(`Eval suite ${requestedId} is not active.`)
  if (listEvalCasesForSuite(suite.id).length === 0) throw new Error(`Eval suite ${requestedId} has no eval cases.`)
  return suite.id
}

function requireCreated<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`Failed to create ${label}.`)
  return value
}

function appendOperationalQueueTrace(input: {
  runId: string
  crewId: string
  queueItemId: string
  queueKeys: string[]
  effectiveAutonomy: string
  waiting: boolean
}) {
  appendRunTrace({
    runId: input.runId,
    sequence: nextTraceSequence(input.runId),
    actorId: input.crewId,
    payload: {
      type: input.waiting ? 'crew_run.operational_queue_waiting' : 'crew_run.operational_queue_started',
      queueItemId: input.queueItemId,
      queueKeys: input.queueKeys,
      effectiveAutonomy: input.effectiveAutonomy,
    },
  })
}

function buildCrewLeadPrompt(detail: CrewRunDetail) {
  const lead = detail.version.members.find((member) => member.role === 'lead')
  const specialists = detail.version.members.filter((member) => member.role === 'specialist')
  const evaluator = detail.version.members.find((member) => member.role === 'evaluator')
  const workItem = detail.run.workItemId
    ? [
        `Work item: ${detail.workItem?.title || detail.run.workItemId}`,
        detail.workItem?.description ? `Work item details: ${detail.workItem.description}` : null,
      ].filter(Boolean).join('\n')
    : 'Work item id: none'
  const specialistLines = specialists
    .map((member) => `- ${member.agentName}: ${member.displayName} — ${member.description}`)
    .join('\n')

  return [
    `You are the lead agent for the Open Cowork crew run "${detail.run.title}".`,
    '',
    'OpenCode owns execution. Use OpenCode-native task delegation and normal tool semantics; do not invent a parallel workflow engine.',
    `Crew: ${detail.crew.name}`,
    `Lead agent: ${lead?.agentName || 'unknown'}`,
    `Evaluator agent: ${evaluator?.agentName || 'none configured'}`,
    `Approval policy: ${detail.version.approvalPolicy.replaceAll('-', ' ')}`,
    workItem,
    '',
    'Workflow:',
    '1. Plan the work briefly.',
    '2. Delegate concrete branches to the specialist agents below using OpenCode-native subagent/task delegation when useful.',
    '3. Join specialist findings into a single answer.',
    '4. Ask the evaluator agent to grade the result against correctness, evidence quality, and usefulness.',
    '5. Deliver the final answer with artifacts, evidence, known limits, and the evaluator verdict.',
    '',
    'Specialists:',
    specialistLines || '- none',
    '',
    'Keep outputs inspectable. Name each specialist contribution and surface blockers or approval needs instead of hiding them.',
  ].join('\n')
}

function summarizeTraceEventForEvaluation(detail: CrewRunDetail, event: CoworkTraceEvent) {
  const node = event.nodeId ? detail.nodes.find((item) => item.id === event.nodeId) : null
  const payloadType = typeof event.payload?.type === 'string' ? event.payload.type : 'unknown'
  const payloadSummary = {
    type: payloadType,
    agentName: typeof event.payload?.agentName === 'string' ? event.payload.agentName : undefined,
    status: typeof event.payload?.status === 'string' ? event.payload.status : undefined,
    title: typeof event.payload?.title === 'string' ? event.payload.title : undefined,
    uri: typeof event.payload?.uri === 'string' ? event.payload.uri : undefined,
    message: typeof event.payload?.message === 'string' ? event.payload.message.slice(0, 240) : undefined,
  }
  return {
    id: event.id,
    sequence: event.sequence,
    source: event.source,
    actor: event.actor,
    sessionId: event.sessionId,
    node: node ? {
      id: node.id,
      kind: node.kind,
      status: node.status,
      agentName: node.agentName,
      title: node.title,
    } : null,
    payload: Object.fromEntries(Object.entries(payloadSummary).filter(([, value]) => value !== undefined)),
  }
}

function buildCrewEvaluationPrompt(detail: CrewRunDetail) {
  const evaluator = detail.version.members.find((member) => member.role === 'evaluator')
  const rubric = detail.version.outcomeRubricId ? getOutcomeRubric(detail.version.outcomeRubricId) : null
  const evidenceEvents = detail.traceEvents
    .filter((event) => event.source !== 'cowork_eval')
    .slice(-MAX_EVALUATION_TRACE_PROMPT_EVENTS)
    .map((event) => summarizeTraceEventForEvaluation(detail, event))
  const artifactLines = detail.artifacts.map((artifact) => `- ${artifact.title} (${artifact.mime}) ${artifact.uri}`).join('\n')
  const approvalLines = detail.approvals.map((approval) => `- ${approval.title}: ${approval.status}`).join('\n')
  const rubricLines = rubric
    ? [
        `${rubric.name}: ${rubric.description}`,
        `Overall passing score: ${rubric.passingScore}`,
        ...rubric.criteria.map((criterion) => `- ${criterion.label} (${Math.round(criterion.weight * 100)}%, pass ${criterion.passingScore}): ${criterion.description}`),
      ].join('\n')
    : 'Default expectation: score correctness, evidence quality, and usefulness on a 0-100 scale.'

  return [
    `You are the evaluator agent for Open Cowork crew run "${detail.run.title}".`,
    '',
    'OpenCode owns execution. Open Cowork is asking you to evaluate the product-level outcome from trace evidence only.',
    'Do not rely on hidden reasoning from the producing agent. Use the trace event ids, artifacts, approvals, and visible outcome signals below.',
    '',
    `Evaluator agent: ${evaluator?.agentName || 'unknown'}`,
    `Crew: ${detail.crew.name}`,
    detail.workItem ? `Work item: ${detail.workItem.title}\n${detail.workItem.description}` : `Run title: ${detail.run.title}`,
    '',
    'Rubric:',
    rubricLines,
    '',
    'Artifacts:',
    artifactLines || '- none recorded',
    '',
    'Approvals:',
    approvalLines || '- none recorded',
    '',
    'Trace evidence JSON:',
    JSON.stringify(evidenceEvents, null, 2),
    '',
    'Return only the structured JSON object requested by the runtime. evidenceTraceEventIds must contain ids from the trace evidence JSON above.',
    'Use recommendation "deliver" only when the result is ready for user delivery. Use "revise" for bounded specialist/lead revision. Use "escalate" when a human needs to decide.',
    '',
    'Schema:',
    crewOutcomeEvaluationSchemaHint(),
  ].join('\n')
}

function normalizeEvaluatorEvidence(
  detail: CrewRunDetail,
  result: CrewOutcomeEvaluationResult,
) {
  const allowed = new Set(detail.traceEvents.filter((event) => event.source !== 'cowork_eval').map((event) => event.id))
  const filtered = result.evidenceTraceEventIds.filter((id) => allowed.has(id)).slice(0, MAX_EVALUATION_EVIDENCE_EVENTS)
  return {
    evidenceTraceEventIds: filtered.length > 0 ? filtered : [...allowed].slice(0, MAX_EVALUATION_EVIDENCE_EVENTS),
    discardedEvidenceTraceEventIds: result.evidenceTraceEventIds.filter((id) => !allowed.has(id)),
  }
}

export async function executeCrewRunWithOpenCode(
  runId: string,
  driver: CrewRuntimeExecutionDriver,
): Promise<CrewRunDetail> {
  const detail = getCrewRunDetail(runId)
  if (!detail) throw new Error(`Crew run ${runId} does not exist.`)
  const lead = detail.version.members.find((member) => member.role === 'lead')
  const planNode = detail.nodes.find((node) => node.kind === 'plan')
  if (!lead || !planNode) throw new Error('Crew run has no lead plan node.')

  let sequence = nextTraceSequence(runId)
  let sessionId: string | null = null
  try {
    const session = await driver.createRootSession({
      title: detail.run.title,
      agentName: lead.agentName,
    })
    sessionId = session.id
    updateCrewRunStatus(runId, 'running', { rootSessionId: sessionId })
    updateCrewRunNodeStatus(planNode.id, 'running', { sessionId })
    appendRunTrace({
      runId,
      sequence: sequence++,
      nodeId: planNode.id,
      sessionId,
      actor: { kind: 'agent', id: lead.agentName },
      payload: {
        type: 'crew_run.session_created',
        agentName: lead.agentName,
      },
    })

    const prompt = buildCrewLeadPrompt(detail)
    appendRunTrace({
      runId,
      sequence: sequence++,
      nodeId: planNode.id,
      sessionId,
      actor: { kind: 'agent', id: lead.agentName },
      inputHash: sha256Text(prompt),
      payload: {
        type: 'crew_run.prompt_submitted',
        agentName: lead.agentName,
        workflow: detail.version.workflow,
      },
    })
    await driver.prompt({
      sessionId,
      agentName: lead.agentName,
      prompt,
    })
  } catch (error) {
    const message = safeErrorMessage(error)
    updateCrewRunNodeStatus(planNode.id, 'failed', { sessionId })
    updateCrewRunStatus(runId, 'failed', { summary: `Crew execution failed: ${message}` })
    appendRunTrace({
      runId,
      sequence,
      nodeId: planNode.id,
      sessionId,
      actor: { kind: 'agent', id: lead.agentName },
      payload: {
        type: 'crew_run.execution_failed',
        message,
      },
    })
    syncCrewOperationalQueueStatus(runId, 'failed', `Crew execution failed: ${message}`)
  }

  const updated = getCrewRunDetail(runId)
  if (!updated) throw new Error(`Crew run ${runId} disappeared after execution dispatch.`)
  return updated
}

export async function dispatchRunnableCrewQueueItems(
  driver: CrewRuntimeExecutionDriver,
  limit = 5,
): Promise<CrewRunDetail[]> {
  const dispatched: CrewRunDetail[] = []
  for (const item of listQueuedCrewOperationalQueueItems()) {
    if (dispatched.length >= limit) break
    const detail = getCrewRunDetail(item.runId)
    if (!detail) {
      syncCrewOperationalQueueStatus(item.runId, 'cancelled', 'Crew run no longer exists.')
      continue
    }
    const started = startCrewOperationalQueueItem(item.runId)
    if (started?.status !== 'running') continue
    appendOperationalQueueTrace({
      runId: detail.run.id,
      crewId: detail.crew.id,
      queueItemId: started.id,
      queueKeys: started.queueKeys,
      effectiveAutonomy: started.effectiveAutonomy,
      waiting: false,
    })
    dispatched.push(await executeCrewRunWithOpenCode(item.runId, driver))
  }
  return dispatched
}

export async function startCrewRunWithOpenCode(
  draft: CrewRunDraft,
  driver: CrewRuntimeExecutionDriver,
  options: { workspaceProfileId?: string | null; channelId?: string | null } = {},
): Promise<CrewRunDetail> {
  const runDetail = startCrewRun(draft, { initialStatus: 'queued' })
  const queueItem = enqueueCrewOperationalQueueItem(runDetail, {
    workspaceProfileId: options.workspaceProfileId,
    channelId: options.channelId,
    budgetCapUsd: draft.budgetCapUsd ?? null,
  })
  const started = startCrewOperationalQueueItem(runDetail.run.id)
  if (started?.status !== 'running') {
    updateCrewRunStatus(runDetail.run.id, 'queued', { summary: 'Waiting for operations queue capacity.' })
    appendOperationalQueueTrace({
      runId: runDetail.run.id,
      crewId: runDetail.crew.id,
      queueItemId: queueItem.id,
      queueKeys: queueItem.queueKeys,
      effectiveAutonomy: queueItem.effectiveAutonomy,
      waiting: true,
    })
    const queued = getCrewRunDetail(runDetail.run.id)
    if (!queued) throw new Error(`Crew run ${runDetail.run.id} disappeared after queueing.`)
    return queued
  }
  appendOperationalQueueTrace({
    runId: runDetail.run.id,
    crewId: runDetail.crew.id,
    queueItemId: started.id,
    queueKeys: started.queueKeys,
    effectiveAutonomy: started.effectiveAutonomy,
    waiting: false,
  })
  const dispatched = await executeCrewRunWithOpenCode(runDetail.run.id, driver)
  if (dispatched.run.status === 'completed' || dispatched.run.status === 'failed' || dispatched.run.status === 'cancelled') {
    await dispatchRunnableCrewQueueItems(driver)
  }
  return dispatched
}

export async function evaluateCrewRunWithOpenCode(
  runId: string,
  driver: CrewRuntimeExecutionDriver,
): Promise<CrewRunDetail> {
  const detail = getCrewRunDetail(runId)
  if (!detail) throw new Error(`Crew run ${runId} does not exist.`)
  const evaluator = detail.version.members.find((member) => member.role === 'evaluator')
  const evaluateNode = detail.nodes.find((node) => node.kind === 'evaluate')
  if (!evaluator || !evaluateNode) throw new Error('Crew run has no evaluator node.')
  const evidenceEvents = detail.traceEvents.filter((event) => event.source !== 'cowork_eval')
  if (evidenceEvents.length === 0) throw new Error('Crew run has no trace evidence to evaluate.')
  if (inFlightEvaluationRunIds.has(runId)) return detail

  inFlightEvaluationRunIds.add(runId)
  try {
    let sequence = nextTraceSequence(runId)
    let sessionId: string | null = null
    updateCrewRunStatus(runId, 'evaluating')
    updateCrewRunNodeStatus(evaluateNode.id, 'running')

    try {
      const prompt = buildCrewEvaluationPrompt(detail)
      const output = await driver.evaluateOutcome({
        title: detail.run.title,
        agentName: evaluator.agentName,
        prompt,
        format: crewOutcomeEvaluationOutputFormat(),
      })
      sessionId = output.sessionId
      updateCrewRunNodeStatus(evaluateNode.id, 'running', { sessionId })
      appendRunTrace({
        runId,
        sequence: sequence++,
        nodeId: evaluateNode.id,
        source: 'cowork_eval',
        sessionId,
        actor: { kind: 'agent', id: evaluator.agentName },
        inputHash: sha256Text(prompt),
        payload: {
          type: 'crew_run.evaluation_prompt_submitted',
          evaluatorAgentName: evaluator.agentName,
          evidenceTraceEventCount: evidenceEvents.length,
        },
      })

      const parsed = extractCrewOutcomeEvaluationFromStructured(output.structured)
        || extractCrewOutcomeEvaluationFromAssistantText(output.text)
      if (!parsed) {
        throw new Error('Evaluator did not return a valid crew outcome evaluation.')
      }

      const evidence = normalizeEvaluatorEvidence(detail, parsed)
      const updated = recordCrewOutcomeEvaluation({
        runId,
        evaluatorAgentName: evaluator.agentName,
        status: parsed.status,
        score: parsed.score,
        evidenceTraceEventIds: evidence.evidenceTraceEventIds,
        recommendation: parsed.recommendation,
        summary: parsed.summary,
        sessionId,
        discardedEvidenceTraceEventIds: evidence.discardedEvidenceTraceEventIds,
      })
      if (updated.run.status === 'completed' || updated.run.status === 'failed' || updated.run.status === 'cancelled') {
        await dispatchRunnableCrewQueueItems(driver)
      }
      return updated
    } catch (error) {
      const message = safeErrorMessage(error)
      updateCrewRunNodeStatus(evaluateNode.id, 'failed', { sessionId })
      updateCrewRunStatus(runId, 'blocked', { summary: `Crew evaluation failed: ${message}` })
      syncCrewOperationalQueueStatus(runId, 'blocked', `Crew evaluation failed: ${message}`)
      appendRunTrace({
        runId,
        sequence,
        nodeId: evaluateNode.id,
        source: 'cowork_eval',
        sessionId,
        actor: { kind: 'agent', id: evaluator.agentName },
        payload: {
          type: 'crew_run.evaluation_failed',
          message,
        },
      })
    }

    const updated = getCrewRunDetail(runId)
    if (!updated) throw new Error(`Crew run ${runId} disappeared after evaluation dispatch.`)
    return updated
  } finally {
    inFlightEvaluationRunIds.delete(runId)
  }
}

export async function evaluateCrewRunForRootSessionIdle(
  rootSessionId: string,
  driver: CrewRuntimeExecutionDriver,
): Promise<CrewRunDetail | null> {
  const run = getCrewRunByRootSessionId(boundedString(rootSessionId, 'Crew root session id'))
  if (!run) return null
  const detail = getCrewRunDetail(run.id)
  if (!detail) return null
  if (detail.run.status !== 'evaluating') return detail
  if (detail.evaluations.length > 0) return detail
  const readyForEvaluation = detail.traceEvents.some((event) => event.payload?.type === 'crew_run.ready_for_evaluation')
  if (!readyForEvaluation) return detail

  return await evaluateCrewRunWithOpenCode(detail.run.id, driver)
}

export function recordCrewOutcomeEvaluation(input: {
  runId: string
  evaluatorAgentName?: string | null
  status: OutcomeEvaluationStatus
  score: number
  evidenceTraceEventIds?: string[]
  recommendation: OutcomeEvaluation['recommendation']
  summary?: string | null
  sessionId?: string | null
  discardedEvidenceTraceEventIds?: string[]
}): CrewRunDetail {
  const updated = withCrewTransaction(() => {
    const detail = getCrewRunDetail(input.runId)
    if (!detail) throw new Error(`Crew run ${input.runId} does not exist.`)
    const evaluator = detail.version.members.find((member) => member.role === 'evaluator')
    const evaluatorAgentName = boundedOptionalString(input.evaluatorAgentName, 'Evaluator agent name')
      || evaluator?.agentName
      || 'evaluator'
    const summary = boundedOptionalString(input.summary, 'Evaluation summary')
    const evaluateNode = detail.nodes.find((node) => node.kind === 'evaluate')
    const deliverNode = detail.nodes.find((node) => node.kind === 'deliver')
    const rubricId = detail.version.outcomeRubricId && getOutcomeRubric(detail.version.outcomeRubricId)
      ? detail.version.outcomeRubricId
      : ensureCrewOutcomeRubricId(null)
    const evidenceTraceEventIds = (input.evidenceTraceEventIds && input.evidenceTraceEventIds.length > 0
      ? input.evidenceTraceEventIds
      : detail.traceEvents.filter((event) => event.source !== 'cowork_eval').map((event) => event.id))
      .slice(0, MAX_EVALUATION_EVIDENCE_EVENTS)
    const evaluation = recordOutcomeEvaluation({
      crewRunId: detail.run.id,
      evaluatorAgentName,
      rubricId,
      status: input.status,
      score: input.score,
      evidenceTraceEventIds,
      recommendation: input.recommendation,
    })
    if (!evaluation) throw new Error('Failed to record crew outcome evaluation.')

    const passedForDelivery = input.status === 'passed' && input.recommendation === 'deliver'
    if (evaluateNode) updateCrewRunNodeStatus(evaluateNode.id, passedForDelivery ? 'completed' : input.status === 'failed' ? 'failed' : 'blocked')
    if (deliverNode && passedForDelivery) updateCrewRunNodeStatus(deliverNode.id, 'completed')
    updateCrewRunStatus(detail.run.id, passedForDelivery ? 'completed' : 'blocked', {
      summary: passedForDelivery
        ? `Evaluator ${evaluatorAgentName} passed the run with score ${Math.round(input.score)}.${summary ? ` ${summary}` : ''}`
        : `Evaluator ${evaluatorAgentName} requested ${input.recommendation} with score ${Math.round(input.score)}.${summary ? ` ${summary}` : ''}`,
    })
    let sequence = nextTraceSequence(detail.run.id)
    appendRunTrace({
      runId: detail.run.id,
      sequence: sequence++,
      nodeId: evaluateNode?.id || null,
      source: 'cowork_eval',
      sessionId: input.sessionId ?? null,
      actor: { kind: 'agent', id: evaluatorAgentName },
      inputHash: sha256Text(JSON.stringify({ rubricId, evidenceTraceEventIds })),
      outputHash: sha256Text(JSON.stringify({
        evaluationId: evaluation.id,
        status: evaluation.status,
        score: evaluation.score,
        recommendation: evaluation.recommendation,
      })),
      payload: {
        type: 'crew_run.evaluation_recorded',
        evaluationId: evaluation.id,
        rubricId,
        status: evaluation.status,
        score: evaluation.score,
        recommendation: evaluation.recommendation,
        evidenceTraceEventCount: evidenceTraceEventIds.length,
        discardedEvidenceTraceEventCount: input.discardedEvidenceTraceEventIds?.length || 0,
        summary,
      },
    })
    if (passedForDelivery && deliverNode) {
      appendRunTrace({
        runId: detail.run.id,
        sequence: sequence++,
        nodeId: deliverNode.id,
        source: 'cowork_worker',
        actor: { kind: 'crew', id: detail.crew.id },
        outputHash: sha256Text(JSON.stringify({
          evaluationId: evaluation.id,
          recommendation: evaluation.recommendation,
          status: evaluation.status,
        })),
        payload: {
          type: 'crew_run.delivered',
          evaluationId: evaluation.id,
          deliverNodeId: deliverNode.id,
          recommendation: evaluation.recommendation,
          score: evaluation.score,
        },
      })
    }
    recordCrewEvaluationRemediation({
      detail,
      evaluation,
      evaluatorAgentName,
      evaluateNodeId: evaluateNode?.id || null,
      sessionId: input.sessionId ?? null,
      summary,
      sequence,
    })

    const nextDetail = getCrewRunDetail(detail.run.id)
    if (!nextDetail) throw new Error(`Crew run ${detail.run.id} disappeared after recording evaluation.`)
    return nextDetail
  })
  syncCrewOperationalQueueStatus(updated.run.id, updated.run.status, updated.run.summary)
  return updated
}

export function startCrewRun(
  draft: CrewRunDraft,
  options: { initialStatus?: 'queued' | 'planning' } = {},
): CrewRunDetail {
  const crewId = boundedString(draft.crewId, 'Crew id')
  const title = boundedString(draft.title, 'Crew run title')
  const detail = getCrewDetail(crewId)
  if (!detail?.activeVersion) throw new Error('Crew does not have an active version.')
  if (detail.definition.status === 'paused') throw new Error('Crew is paused and cannot start new runs.')
  if (detail.definition.status === 'retired') throw new Error('Crew is retired and cannot start new runs.')
  const activeVersion = detail.activeVersion
  if (activeVersion.certificationStatus === 'required') {
    throw new Error('Crew active version requires eval certification before it can run.')
  }
  const specialists = activeVersion.members.filter((member) => member.role === 'specialist')
  const evaluator = activeVersion.members.find((member) => member.role === 'evaluator')
  if (specialists.length < 2 || !evaluator) throw new Error('Crew active version needs at least two specialists and one evaluator before it can run.')
  const runBudgetCapUsd = boundedOptionalPositiveNumber(draft.budgetCapUsd, 'Crew run budget cap')

  return withCrewTransaction(() => {
    const workItemTitle = boundedOptionalString(draft.workItemTitle, 'Crew work item title')
    const hasWorkItem = Boolean(
      workItemTitle
      || draft.workItemDescription
      || draft.expectedDeliverable
      || draft.constraints
      || draft.dueAt
      || draft.urgency
      || runBudgetCapUsd !== null
      || draft.approvalRequirements
      || draft.sourceContext
    )
    const workItemDescription = hasWorkItem ? crewRunWorkItemDescription(draft, workItemTitle || title) : null
    const workItem = hasWorkItem
      ? createCoworkWorkItem({
        title: workItemTitle || title,
        description: workItemDescription || workItemTitle || title,
        source: draft.workItemSource || 'manual',
        status: 'running',
      })
      : null
    const run = requireCreated(createCrewRun({
      crewId,
      crewVersionId: activeVersion.id,
      title,
      workItemId: workItem?.id || null,
    }), 'crew run')

    let sequence = 1
    const plan = requireCreated(createCrewRunNode({
      crewRunId: run.id,
      kind: 'plan',
      title: 'Plan work',
      agentName: activeVersion.members.find((member) => member.role === 'lead')?.agentName || null,
    }), 'crew plan node')
    const delegates = specialists.map((member) => requireCreated(createCrewRunNode({
      crewRunId: run.id,
      kind: 'delegate',
      title: `Delegate to ${member.displayName}`,
      agentName: member.agentName,
      parentNodeId: plan.id,
    }), `crew delegate node for ${member.displayName}`))
    const join = requireCreated(createCrewRunNode({
      crewRunId: run.id,
      kind: 'join',
      title: 'Join specialist outputs',
      parentNodeId: plan.id,
    }), 'crew join node')
    const evaluate = requireCreated(createCrewRunNode({
      crewRunId: run.id,
      kind: 'evaluate',
      title: 'Evaluate outcome',
      agentName: evaluator.agentName,
      parentNodeId: join.id,
    }), 'crew evaluate node')
    const deliver = requireCreated(createCrewRunNode({
      crewRunId: run.id,
      kind: 'deliver',
      title: 'Deliver approved result',
      parentNodeId: evaluate.id,
    }), 'crew deliver node')

    const initialStatus = options.initialStatus || 'planning'
    const updatedRun = initialStatus === 'planning' ? updateCrewRunStatus(run.id, 'planning') : run
    appendRunTrace({
      runId: run.id,
      sequence: sequence++,
      actorId: crewId,
      payload: {
        type: 'crew_run.created',
        crewId,
        crewVersionId: activeVersion.id,
        workflow: activeVersion.workflow,
        approvalPolicy: activeVersion.approvalPolicy,
        urgency: normalizeCrewRunUrgency(draft.urgency),
        dueAt: normalizeCrewRunDueAt(draft.dueAt),
      },
    })
    for (const node of [plan, ...delegates, join, evaluate, deliver]) {
      appendRunTrace({
        runId: run.id,
        sequence: sequence++,
        nodeId: node.id,
        actorId: crewId,
        payload: {
          type: 'crew_run_node.queued',
          kind: node.kind,
          agentName: node.agentName,
        },
      })
    }

    const runDetail = getCrewRunDetail(updatedRun?.id || run.id)
    if (!runDetail) throw new Error('Failed to load created crew run.')
    return runDetail
  })
}

export function certifyCrewVersion(input: {
  crewVersionId: string
  evalSuiteId?: string | null
  evidenceEvaluationIds: string[]
}): CrewDetail {
  const crewVersionId = boundedString(input.crewVersionId, 'Crew version id')
  const version = getCrewVersion(crewVersionId)
  if (!version) throw new Error(`Crew version ${crewVersionId} does not exist.`)
  const evalSuiteId = boundedOptionalString(input.evalSuiteId, 'Eval suite id') || version.evalSuiteId
  if (!evalSuiteId) throw new Error('Crew version has no eval suite to certify.')
  if (version.evalSuiteId && evalSuiteId !== version.evalSuiteId) {
    throw new Error(`Crew version ${crewVersionId} is attached to eval suite ${version.evalSuiteId}.`)
  }
  const suite = getEvalSuite(evalSuiteId)
  if (!suite) throw new Error(`Eval suite ${evalSuiteId} does not exist.`)
  if (suite.status !== 'active') throw new Error(`Eval suite ${evalSuiteId} is not active.`)
  const cases = listEvalCasesForSuite(suite.id)
  if (cases.length === 0) throw new Error(`Eval suite ${evalSuiteId} has no eval cases.`)
  if (!Array.isArray(input.evidenceEvaluationIds) || input.evidenceEvaluationIds.length === 0) {
    throw new Error('Crew certification requires at least one passed outcome evaluation.')
  }

  for (const evaluationId of input.evidenceEvaluationIds) {
    const id = boundedString(evaluationId, 'Evidence evaluation id')
    const evaluation = getOutcomeEvaluation(id)
    if (!evaluation) throw new Error(`Outcome evaluation ${id} does not exist.`)
    if (evaluation.status !== 'passed' || evaluation.recommendation !== 'deliver') {
      throw new Error(`Outcome evaluation ${id} did not pass with delivery recommendation.`)
    }
    const run = getCrewRun(evaluation.crewRunId)
    if (!run || run.crewVersionId !== version.id) {
      throw new Error(`Outcome evaluation ${id} does not belong to crew version ${version.id}.`)
    }
  }

  const certified = markCrewVersionCertified(version.id)
  if (!certified) throw new Error(`Failed to certify crew version ${version.id}.`)
  const detail = getCrewDetail(version.crewId)
  if (!detail) throw new Error(`Failed to load certified crew ${version.crewId}.`)
  return detail
}

export function getCrewRunDetail(runId: string): CrewRunDetail | null {
  const run = getCrewRun(runId)
  if (!run) return null
  const crew = getCrewDefinition(run.crewId)
  const version = getCrewVersion(run.crewVersionId)
  if (!crew || !version) return null
  return {
    run,
    crew,
    version,
    workItem: run.workItemId ? getCoworkWorkItem(run.workItemId) : null,
    nodes: listCrewRunNodes(run.id),
    artifacts: listCrewArtifactsForRun(run.id),
    approvals: listCrewApprovalsForRun(run.id),
    policyDecisions: listPolicyDecisionsForRun('crew', run.id),
    evaluations: listOutcomeEvaluationsForRun(run.id),
    traceEvents: listCoworkTraceEventsForRun(run.id),
  }
}

export function exportCrewRunTraceNdjson(runId: string): string {
  const id = boundedString(runId, 'Crew run id')
  if (!getCrewRun(id)) throw new Error(`Crew run ${id} does not exist.`)
  return exportCoworkTraceEventsForRun(id)
}
