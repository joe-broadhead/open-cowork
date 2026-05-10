import {
  createCoworkTraceEvent,
  type CrewRunDetail,
  type OutcomeEvaluation,
  type OutcomeEvaluationStatus,
} from '@open-cowork/shared'
import { createHash } from 'node:crypto'
import {
  appendCoworkTraceEvent,
  createCrewApproval,
  createCrewRunNode,
} from './crew-store.ts'

const MAX_CREW_APPROVAL_BODY_CHARS = 4 * 1024
export const MAX_CREW_REVISION_ATTEMPTS = 1

function sha256Text(value: string) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function truncateForApprovalBody(value: string) {
  if (value.length <= MAX_CREW_APPROVAL_BODY_CHARS) return value
  return `${value.slice(0, MAX_CREW_APPROVAL_BODY_CHARS - 3)}...`
}

function evaluationNeedsHumanReview(status: OutcomeEvaluationStatus, recommendation: OutcomeEvaluation['recommendation']) {
  return status === 'needs_human' || recommendation === 'escalate'
}

function evaluationNeedsRevision(status: OutcomeEvaluationStatus, recommendation: OutcomeEvaluation['recommendation']) {
  return status === 'failed' || status === 'needs_revision' || recommendation === 'revise'
}

function revisionRequestCount(detail: CrewRunDetail) {
  return detail.traceEvents.filter((event) => event.payload?.type === 'crew_run.revision_requested').length
}

function appendRemediationTrace(input: {
  detail: CrewRunDetail
  evaluation: OutcomeEvaluation
  evaluatorAgentName: string
  evaluateNodeId: string | null
  approvalId?: string | null
  revisionNodeId?: string | null
  sessionId: string | null
  summary: string | null
  sequence: number
  payload: Record<string, unknown>
}) {
  appendCoworkTraceEvent(createCoworkTraceEvent({
    id: crypto.randomUUID(),
    sequence: input.sequence,
    runId: input.detail.run.id,
    runKind: 'crew',
    source: 'cowork_eval',
    sourceEventId: null,
    correlationId: input.detail.run.id,
    causationId: input.evaluation.id,
    sessionId: input.sessionId,
    parentSessionId: null,
    actor: { kind: 'agent', id: input.evaluatorAgentName },
    nodeId: input.revisionNodeId || input.evaluateNodeId,
    artifactId: null,
    approvalId: input.approvalId || null,
    policyDecisionId: null,
    inputHash: sha256Text(JSON.stringify({
      evaluationId: input.evaluation.id,
      evidenceTraceEventIds: input.evaluation.evidenceTraceEventIds,
    })),
    outputHash: null,
    payloadRef: null,
    payloadHash: null,
    redactionState: 'none',
    tokenUsage: null,
    costUsd: null,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  }))
}

export function recordCrewEvaluationRemediation(input: {
  detail: CrewRunDetail
  evaluation: OutcomeEvaluation
  evaluatorAgentName: string
  evaluateNodeId: string | null
  sessionId: string | null
  summary: string | null
  sequence: number
}) {
  const needsHuman = evaluationNeedsHumanReview(input.evaluation.status, input.evaluation.recommendation)
  const needsRevision = evaluationNeedsRevision(input.evaluation.status, input.evaluation.recommendation)
  if (!needsHuman && !needsRevision) return

  const revisionAttempts = revisionRequestCount(input.detail)
  if (needsRevision && !needsHuman && revisionAttempts < MAX_CREW_REVISION_ATTEMPTS) {
    const lead = input.detail.version.members.find((member) => member.role === 'lead')
    const revisionAttempt = revisionAttempts + 1
    const revisionNode = createCrewRunNode({
      crewRunId: input.detail.run.id,
      kind: 'revision',
      status: 'blocked',
      agentName: lead?.agentName || null,
      parentNodeId: input.evaluateNodeId,
      title: `Revision attempt ${revisionAttempt}: address evaluator findings`,
    })
    if (!revisionNode) throw new Error('Failed to create crew revision node.')
    appendRemediationTrace({
      ...input,
      revisionNodeId: revisionNode.id,
      payload: {
        type: 'crew_run.revision_requested',
        evaluationId: input.evaluation.id,
        revisionAttempt,
        maxRevisionAttempts: MAX_CREW_REVISION_ATTEMPTS,
        status: input.evaluation.status,
        score: input.evaluation.score,
        recommendation: input.evaluation.recommendation,
        summary: input.summary,
      },
    })
    return
  }

  const reason = needsHuman
    ? 'evaluator_requested_human'
    : 'revision_budget_exhausted'
  const leadSentence = needsHuman
    ? `Evaluator ${input.evaluatorAgentName} requested human review for crew run "${input.detail.run.title}".`
    : `Crew run "${input.detail.run.title}" exhausted its revision budget after evaluator ${input.evaluatorAgentName} requested revision.`
  const approval = createCrewApproval({
    crewRunId: input.detail.run.id,
    nodeId: input.evaluateNodeId,
    title: 'Human review required for crew outcome',
    body: truncateForApprovalBody([
      leadSentence,
      `Status: ${input.evaluation.status}.`,
      `Recommendation: ${input.evaluation.recommendation}.`,
      `Score: ${Math.round(input.evaluation.score)}.`,
      `Reason: ${reason}.`,
      input.summary ? `Summary: ${input.summary}` : null,
    ].filter(Boolean).join(' ')),
  })
  if (!approval) throw new Error('Failed to create crew human review approval.')
  appendRemediationTrace({
    ...input,
    approvalId: approval.id,
    payload: {
      type: 'crew_run.human_escalation_requested',
      evaluationId: input.evaluation.id,
      approvalId: approval.id,
      reason,
      revisionAttempts,
      maxRevisionAttempts: MAX_CREW_REVISION_ATTEMPTS,
      status: input.evaluation.status,
      score: input.evaluation.score,
      recommendation: input.evaluation.recommendation,
      summary: input.summary,
    },
  })
}
