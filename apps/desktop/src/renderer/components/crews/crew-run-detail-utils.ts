import type {
  CoworkTraceEvent,
  CrewApproval,
  CrewArtifact,
  CrewRunDetail,
  CrewRunNode,
  OutcomeEvaluation,
  PolicyDecision,
} from '@open-cowork/shared'

export type CrewRunOperationalSummary = {
  activeAgents: number
  blockedAgents: number
  completedNodes: number
  failedNodes: number
  pendingApprovals: number
  artifactCount: number
  toolCallCount: number
  traceCount: number
  totalCostUsd: number
  tokenTotal: number
  hasTokenUsage: boolean
  qualityLabel: string
  blockerLabels: string[]
}

export type NodeOperationalDetail = {
  node: CrewRunNode
  events: CoworkTraceEvent[]
  toolCalls: CoworkTraceEvent[]
  artifacts: CrewArtifact[]
  approvals: CrewApproval[]
  evaluations: OutcomeEvaluation[]
  policyDecisions: PolicyDecision[]
}

const BLOCKING_EVAL_STATUSES = new Set(['failed', 'needs_revision', 'needs_human'])

export function tracePayloadType(event: CoworkTraceEvent) {
  return typeof event.payload?.type === 'string' && event.payload.type ? event.payload.type : event.source
}

export function traceToolName(event: CoworkTraceEvent) {
  return typeof event.payload?.toolName === 'string' && event.payload.toolName ? event.payload.toolName : 'Tool call'
}

export function summarizeCrewRun(detail: CrewRunDetail): CrewRunOperationalSummary {
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === 'requested').length
  const toolCalls = detail.traceEvents.filter((event) => tracePayloadType(event) === 'crew_run.tool_call')
  const blockedNodes = detail.nodes.filter((node) => node.status === 'blocked' || node.status === 'failed')
  const blockingEvaluations = detail.evaluations.filter((evaluation) => BLOCKING_EVAL_STATUSES.has(evaluation.status))
  const cost = detail.traceEvents.reduce((sum, event) => sum + (typeof event.costUsd === 'number' ? event.costUsd : 0), 0)
  const tokenTotal = detail.traceEvents.reduce((sum, event) => {
    if (!event.tokenUsage) return sum
    return sum
      + event.tokenUsage.input
      + event.tokenUsage.output
      + event.tokenUsage.reasoning
      + event.tokenUsage.cacheRead
      + event.tokenUsage.cacheWrite
  }, 0)
  const blockerLabels = [
    ...blockedNodes.map((node) => `${node.title} ${node.status}`),
    ...detail.approvals.filter((approval) => approval.status === 'requested').map((approval) => approval.title),
    ...blockingEvaluations.map((evaluation) => `Evaluation ${evaluation.status}`),
  ]

  return {
    activeAgents: detail.nodes.filter((node) => node.status === 'running' || node.status === 'queued').length,
    blockedAgents: blockedNodes.length + pendingApprovals + blockingEvaluations.length,
    completedNodes: detail.nodes.filter((node) => node.status === 'completed').length,
    failedNodes: detail.nodes.filter((node) => node.status === 'failed').length,
    pendingApprovals,
    artifactCount: detail.artifacts.length,
    toolCallCount: toolCalls.length,
    traceCount: detail.traceEvents.length,
    totalCostUsd: cost,
    tokenTotal,
    hasTokenUsage: detail.traceEvents.some((event) => Boolean(event.tokenUsage)),
    qualityLabel: qualityLabel(detail.evaluations),
    blockerLabels,
  }
}

export function nodeOperationalDetails(detail: CrewRunDetail): NodeOperationalDetail[] {
  return detail.nodes.map((node) => ({
    node,
    events: detail.traceEvents.filter((event) => event.nodeId === node.id),
    toolCalls: detail.traceEvents.filter((event) => event.nodeId === node.id && tracePayloadType(event) === 'crew_run.tool_call'),
    artifacts: detail.artifacts.filter((artifact) => artifact.nodeId === node.id),
    approvals: detail.approvals.filter((approval) => approval.nodeId === node.id),
    evaluations: detail.evaluations.filter((evaluation) => node.kind === 'evaluate' && evaluation.evaluatorAgentName === node.agentName),
    policyDecisions: detail.policyDecisions.filter((decision) => decision.nodeId === node.id),
  }))
}

export function nodeLabelForTrace(detail: CrewRunDetail, event: CoworkTraceEvent) {
  if (!event.nodeId) return 'Run'
  return detail.nodes.find((node) => node.id === event.nodeId)?.title || event.nodeId.slice(0, 8)
}

function qualityLabel(evaluations: OutcomeEvaluation[]) {
  if (evaluations.length === 0) return 'No eval yet'
  const latest = evaluations[evaluations.length - 1]
  if (!latest) return 'No eval yet'
  return `${latest.status.replaceAll('_', ' ')} · ${Math.round(latest.score)}`
}
