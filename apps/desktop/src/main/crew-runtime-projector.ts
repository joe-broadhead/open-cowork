import { createHash } from 'node:crypto'
import {
  createCoworkTraceEvent,
  type CrewRun,
  type CrewRunNode,
  type CrewRunNodeStatus,
  type CrewRunStatus,
  type TraceTokenUsage,
} from '@open-cowork/shared'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import {
  appendCoworkTraceEventIfNew,
  createCrewApproval,
  createCrewArtifact,
  createCrewRunNode,
  getCrewApproval,
  getCrewRunByRootSessionId,
  listCoworkTraceEventsForRun,
  listCrewRunNodes,
  listOutcomeEvaluationsForRun,
  nextCoworkTraceSequence,
  resolveCrewApproval,
  updateCrewRunNodeRuntimeState,
  updateCrewRunStatus,
} from './crew-store.ts'

const MAX_TRACE_TEXT_BYTES = 4096

type RuntimeEventData = NonNullable<RuntimeSessionEvent['data']>

function eventType(event: RuntimeSessionEvent) {
  return String(event.data?.type || event.type || '')
}

function boundedText(value: unknown, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (Buffer.byteLength(trimmed, 'utf8') <= MAX_TRACE_TEXT_BYTES) return trimmed
  return `${Buffer.from(trimmed, 'utf8').subarray(0, MAX_TRACE_TEXT_BYTES).toString('utf8')}...`
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object') return current
    if (seen.has(current)) return '[Circular]'
    seen.add(current)
    if (Array.isArray(current)) return current
    return Object.fromEntries(Object.keys(current).sort().map((key) => [key, (current as Record<string, unknown>)[key]]))
  }) || ''
}

function sha256(value: unknown) {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function traceId(parts: Array<string | null | undefined>) {
  return `crew-trace-${createHash('sha256').update(parts.filter(Boolean).join(':')).digest('hex').slice(0, 32)}`
}

function scopedId(prefix: string, runId: string, sourceId: string) {
  return `${prefix}-${createHash('sha256').update(`${runId}:${sourceId}`).digest('hex').slice(0, 32)}`
}

function readTaskRunTraceNodeId(runId: string, taskRunId: string | null | undefined) {
  if (!taskRunId) return null
  for (const trace of listCoworkTraceEventsForRun(runId)) {
    if (trace.payload?.type !== 'crew_run.task_run') continue
    if (trace.payload.taskRunId !== taskRunId) continue
    if (trace.nodeId) return trace.nodeId
  }
  return null
}

function runtimeTaskRunId(data: RuntimeEventData) {
  if (data.type === 'task_run' && typeof data.id === 'string' && data.id) return data.id
  if (typeof data.taskRunId === 'string' && data.taskRunId) return data.taskRunId
  if (typeof data.id === 'string' && data.id) return data.id
  return null
}

function runtimeStatusToNodeStatus(status: unknown): CrewRunNodeStatus {
  switch (status) {
    case 'complete':
    case 'completed':
    case 'success':
      return 'completed'
    case 'error':
    case 'failed':
      return 'failed'
    case 'blocked':
    case 'waiting':
      return 'blocked'
    case 'queued':
      return 'queued'
    default:
      return 'running'
  }
}

function findPlanNode(nodes: CrewRunNode[]) {
  return nodes.find((node) => node.kind === 'plan') || null
}

function nextRunStatusFromNodes(runId: string, fallback: CrewRunStatus): CrewRunStatus {
  const nodes = listCrewRunNodes(runId)
  return nodes.some((node) => node.status === 'failed' || node.status === 'blocked') ? 'blocked' : fallback
}

function findRunNodeForTask(run: CrewRun, data: RuntimeEventData): CrewRunNode | null {
  const nodes = listCrewRunNodes(run.id)
  const taskRunId = runtimeTaskRunId(data)
  const tracedNodeId = readTaskRunTraceNodeId(run.id, taskRunId)
  if (tracedNodeId) {
    const node = nodes.find((candidate) => candidate.id === tracedNodeId)
    if (node) return node
  }

  const sourceSessionId = typeof data.sourceSessionId === 'string' && data.sourceSessionId ? data.sourceSessionId : null
  if (sourceSessionId) {
    const bySession = nodes.find((candidate) => candidate.sessionId === sourceSessionId)
    if (bySession) return bySession
  }

  const agentName = typeof data.agent === 'string' && data.agent ? data.agent : null
  if (agentName) {
    const byAgent = nodes.find((candidate) =>
      candidate.agentName === agentName
      && (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'blocked')
      && (!sourceSessionId || !candidate.sessionId),
    )
    if (byAgent) return byAgent
  }

  const plan = findPlanNode(nodes)
  const title = boundedText(data.title, agentName ? `Delegate to ${agentName}` : 'Delegated OpenCode task')
  return createCrewRunNode({
    crewRunId: run.id,
    kind: 'delegate',
    title,
    agentName,
    sessionId: sourceSessionId,
    parentNodeId: plan?.id || null,
    status: runtimeStatusToNodeStatus(data.status),
  })
}

function traceBase(input: {
  run: CrewRun
  id: string
  payloadType: string
  sourceEventId: string | null
  sessionId?: string | null
  parentSessionId?: string | null
  actorId?: string | null
  nodeId?: string | null
  approvalId?: string | null
  artifactId?: string | null
  inputHash?: string | null
  outputHash?: string | null
  payloadHash?: string | null
  payload: Record<string, unknown>
  tokenUsage?: TraceTokenUsage | null
  costUsd?: number | null
}) {
  appendCoworkTraceEventIfNew(createCoworkTraceEvent({
    id: input.id,
    sequence: nextCoworkTraceSequence(input.run.id),
    runId: input.run.id,
    runKind: 'crew',
    source: 'opencode_event',
    sourceEventId: input.sourceEventId,
    correlationId: input.run.id,
    causationId: null,
    sessionId: input.sessionId ?? input.run.rootSessionId,
    parentSessionId: input.parentSessionId ?? null,
    actor: { kind: input.actorId ? 'agent' : 'opencode', id: input.actorId || 'opencode' },
    nodeId: input.nodeId || null,
    artifactId: input.artifactId || null,
    approvalId: input.approvalId || null,
    policyDecisionId: null,
    inputHash: input.inputHash ?? null,
    outputHash: input.outputHash ?? null,
    payloadRef: null,
    payloadHash: input.payloadHash ?? null,
    redactionState: 'none',
    tokenUsage: input.tokenUsage ?? null,
    costUsd: input.costUsd ?? null,
    payload: {
      type: input.payloadType,
      ...input.payload,
    },
    createdAt: new Date().toISOString(),
  }))
}

function projectTaskRun(run: CrewRun, data: RuntimeEventData) {
  const taskRunId = typeof data.id === 'string' && data.id ? data.id : null
  if (!taskRunId) return
  const node = findRunNodeForTask(run, data)
  if (!node) return

  const status = runtimeStatusToNodeStatus(data.status)
  const sourceSessionId = typeof data.sourceSessionId === 'string' && data.sourceSessionId ? data.sourceSessionId : null
  const agentName = typeof data.agent === 'string' && data.agent ? data.agent : node.agentName
  const title = boundedText(data.title, node.title)
  updateCrewRunNodeRuntimeState(node.id, {
    status,
    title,
    agentName,
    sessionId: sourceSessionId,
  })
  updateCrewRunStatus(run.id, nextRunStatusFromNodes(run.id, 'running'))

  traceBase({
    run,
    id: traceId([run.id, 'task_run', taskRunId, String(data.status || 'running')]),
    payloadType: 'crew_run.task_run',
    sourceEventId: taskRunId,
    sessionId: sourceSessionId || run.rootSessionId,
    parentSessionId: typeof data.parentSessionId === 'string' ? data.parentSessionId : run.rootSessionId,
    actorId: agentName,
    nodeId: node.id,
    payload: {
      taskRunId,
      title,
      agentName,
      status: String(data.status || 'running'),
      sourceSessionId,
    },
  })
}

function projectToolCall(run: CrewRun, data: RuntimeEventData) {
  const toolCallId = typeof data.id === 'string' && data.id ? data.id : null
  if (!toolCallId) return
  const node = findRunNodeForTask(run, data)
  const sourceSessionId = typeof data.sourceSessionId === 'string' && data.sourceSessionId ? data.sourceSessionId : null
  const agentName = typeof data.agent === 'string' && data.agent ? data.agent : node?.agentName || null
  const toolName = boundedText(data.name, 'tool')
  const attachments = Array.isArray(data.attachments) ? data.attachments : []

  traceBase({
    run,
    id: traceId([run.id, 'tool_call', toolCallId, String(data.status || 'unknown')]),
    payloadType: 'crew_run.tool_call',
    sourceEventId: toolCallId,
    sessionId: sourceSessionId || run.rootSessionId,
    actorId: agentName,
    nodeId: node?.id || null,
    inputHash: data.input ? sha256(data.input) : null,
    outputHash: data.output !== undefined ? sha256(data.output) : null,
    payload: {
      toolCallId,
      toolName,
      status: String(data.status || 'unknown'),
      taskRunId: typeof data.taskRunId === 'string' ? data.taskRunId : null,
      sourceSessionId,
      attachmentCount: attachments.length,
    },
  })

  attachments.forEach((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') return
    const record = attachment as unknown as Record<string, unknown>
    const uri = typeof record.url === 'string' ? record.url : ''
    const mime = typeof record.mime === 'string' ? record.mime : 'application/octet-stream'
    if (!uri) return
    const title = boundedText(record.filename, `${toolName} artifact ${index + 1}`)
    const artifact = createCrewArtifact({
      id: scopedId('crew-artifact', run.id, `${toolCallId}:${index}:${uri}`),
      crewRunId: run.id,
      nodeId: node?.id || null,
      title,
      mime,
      uri,
      hash: sha256({ uri, mime, title }),
    })
    if (!artifact) return
    traceBase({
      run,
      id: traceId([run.id, 'artifact', artifact.id]),
      payloadType: 'crew_run.artifact_recorded',
      sourceEventId: `${toolCallId}:artifact:${index}`,
      sessionId: sourceSessionId || run.rootSessionId,
      actorId: agentName,
      nodeId: node?.id || null,
      artifactId: artifact.id,
      payloadHash: artifact.hash,
      payload: {
        artifactId: artifact.id,
        title: artifact.title,
        mime: artifact.mime,
        sourceToolCallId: toolCallId,
      },
    })
  })
}

function projectApproval(run: CrewRun, data: RuntimeEventData) {
  const approvalSourceId = typeof data.id === 'string' && data.id ? data.id : null
  if (!approvalSourceId) return
  const node = findRunNodeForTask(run, data)
  const approvalId = scopedId('crew-approval', run.id, approvalSourceId)
  const title = boundedText(data.tool, 'Approval required')
  const body = boundedText(data.description, title)
  const approval = createCrewApproval({
    id: approvalId,
    crewRunId: run.id,
    nodeId: node?.id || null,
    title,
    body,
  })
  if (node) updateCrewRunNodeRuntimeState(node.id, { status: 'blocked' })
  updateCrewRunStatus(run.id, 'blocked')
  traceBase({
    run,
    id: traceId([run.id, 'approval', approvalSourceId]),
    payloadType: 'crew_run.approval_requested',
    sourceEventId: approvalSourceId,
    sessionId: typeof data.sourceSessionId === 'string' ? data.sourceSessionId : run.rootSessionId,
    actorId: node?.agentName || null,
    nodeId: node?.id || null,
    approvalId: approval?.id || approvalId,
    inputHash: data.input ? sha256(data.input) : null,
    payload: {
      approvalId,
      title,
      sourceApprovalId: approvalSourceId,
      taskRunId: typeof data.taskRunId === 'string' ? data.taskRunId : null,
    },
  })
}

function projectApprovalResolved(run: CrewRun, data: RuntimeEventData) {
  const approvalSourceId = typeof data.id === 'string' && data.id ? data.id : null
  if (!approvalSourceId) return
  const approvalId = scopedId('crew-approval', run.id, approvalSourceId)
  const approval = getCrewApproval(approvalId)
  if (approval?.status === 'requested') {
    resolveCrewApproval(approvalId, data.status === 'denied' ? 'denied' : 'approved', 'opencode')
  }
  if (approval?.nodeId) {
    updateCrewRunNodeRuntimeState(approval.nodeId, { status: data.status === 'denied' ? 'failed' : 'running' })
  }
  updateCrewRunStatus(run.id, nextRunStatusFromNodes(run.id, 'running'))
  traceBase({
    run,
    id: traceId([run.id, 'approval_resolved', approvalSourceId]),
    payloadType: 'crew_run.approval_resolved',
    sourceEventId: approvalSourceId,
    approvalId,
    payload: {
      approvalId,
      status: data.status === 'denied' ? 'denied' : 'approved',
      sourceApprovalId: approvalSourceId,
    },
  })
}

function projectQuestion(run: CrewRun, data: RuntimeEventData, resolved: boolean) {
  const questionId = typeof data.id === 'string' && data.id ? data.id : null
  if (!questionId) return
  updateCrewRunStatus(run.id, resolved ? 'running' : 'blocked')
  traceBase({
    run,
    id: traceId([run.id, resolved ? 'question_resolved' : 'question_asked', questionId]),
    payloadType: resolved ? 'crew_run.question_resolved' : 'crew_run.question_asked',
    sourceEventId: questionId,
    payload: {
      questionId,
      questionCount: Array.isArray(data.questions) ? data.questions.length : null,
    },
  })
}

function projectCost(run: CrewRun, data: RuntimeEventData) {
  const eventId = typeof data.id === 'string' && data.id ? data.id : traceId([run.id, 'cost', String(data.cost || 0)])
  const tokens = data.tokens || {}
  traceBase({
    run,
    id: traceId([run.id, 'cost', eventId]),
    payloadType: 'crew_run.cost',
    sourceEventId: eventId,
    sessionId: typeof data.sourceSessionId === 'string' ? data.sourceSessionId : run.rootSessionId,
    actorId: typeof data.agent === 'string' ? data.agent : null,
    tokenUsage: {
      input: Number(tokens.input || 0),
      output: Number(tokens.output || 0),
      reasoning: Number(tokens.reasoning || 0),
      cacheRead: Number(tokens.cache?.read || 0),
      cacheWrite: Number(tokens.cache?.write || 0),
    },
    costUsd: typeof data.cost === 'number' && Number.isFinite(data.cost) ? data.cost : null,
    payload: {
      taskRunId: typeof data.taskRunId === 'string' ? data.taskRunId : null,
      sourceSessionId: typeof data.sourceSessionId === 'string' ? data.sourceSessionId : null,
    },
  })
}

function projectDone(run: CrewRun, data: RuntimeEventData) {
  const nodes = listCrewRunNodes(run.id)
  const evaluations = listOutcomeEvaluationsForRun(run.id)
  const evaluateNode = nodes.find((node) => node.kind === 'evaluate')
  const deliverNode = nodes.find((node) => node.kind === 'deliver')
  const latestEvaluation = evaluations.at(-1) || null
  const passedForDelivery = latestEvaluation?.status === 'passed' && latestEvaluation.recommendation === 'deliver'

  if (evaluateNode && !latestEvaluation) {
    for (const node of nodes) {
      if (node.status === 'failed' || node.status === 'completed' || node.status === 'skipped') continue
      if (node.id === evaluateNode.id) {
        updateCrewRunNodeRuntimeState(node.id, { status: 'running' })
        continue
      }
      if (deliverNode && node.id === deliverNode.id) continue
      const unobservedAgentNode = node.kind === 'delegate' && node.status === 'queued' && !node.sessionId
      updateCrewRunNodeRuntimeState(node.id, { status: unobservedAgentNode ? 'skipped' : 'completed' })
    }
    updateCrewRunStatus(run.id, 'evaluating')
    traceBase({
      run,
      id: traceId([run.id, 'ready-for-evaluation', run.rootSessionId || run.id]),
      payloadType: 'crew_run.ready_for_evaluation',
      sourceEventId: typeof data.id === 'string' ? data.id : null,
      nodeId: evaluateNode.id,
      actorId: evaluateNode.agentName || null,
      payload: {
        rootSessionId: run.rootSessionId,
        synthetic: Boolean(data.synthetic),
      },
    })
    return
  }
  if (latestEvaluation && !passedForDelivery) return

  for (const node of nodes) {
    if (node.status === 'failed' || node.status === 'completed' || node.status === 'skipped') continue
    const unobservedAgentNode = (node.kind === 'delegate' || node.kind === 'evaluate') && node.status === 'queued' && !node.sessionId
    updateCrewRunNodeRuntimeState(node.id, { status: unobservedAgentNode ? 'skipped' : 'completed' })
  }
  updateCrewRunStatus(run.id, 'completed')
  traceBase({
    run,
    id: traceId([run.id, 'done', run.rootSessionId || run.id]),
    payloadType: 'crew_run.completed',
    sourceEventId: typeof data.id === 'string' ? data.id : null,
    payload: {
      rootSessionId: run.rootSessionId,
      synthetic: Boolean(data.synthetic),
    },
  })
}

function projectError(run: CrewRun, data: RuntimeEventData) {
  const node = findRunNodeForTask(run, data)
  if (node) updateCrewRunNodeRuntimeState(node.id, { status: 'failed' })
  const message = boundedText(data.message, 'OpenCode session failed')
  const sourceSessionId = typeof data.sourceSessionId === 'string' && data.sourceSessionId ? data.sourceSessionId : null
  const branchError = Boolean(data.taskRunId) || Boolean(sourceSessionId && sourceSessionId !== run.rootSessionId)
  updateCrewRunStatus(run.id, branchError ? 'blocked' : 'failed', { summary: message })
  traceBase({
    run,
    id: traceId([run.id, 'error', typeof data.taskRunId === 'string' ? data.taskRunId : run.rootSessionId || run.id]),
    payloadType: branchError ? 'crew_run.branch_failed' : 'crew_run.failed',
    sourceEventId: typeof data.taskRunId === 'string' ? data.taskRunId : null,
    sessionId: sourceSessionId || run.rootSessionId,
    actorId: node?.agentName || null,
    nodeId: node?.id || null,
    payload: {
      message,
      taskRunId: typeof data.taskRunId === 'string' ? data.taskRunId : null,
    },
  })
}

export function projectCrewRuntimeEvent(event: RuntimeSessionEvent) {
  if (!event.sessionId || !event.data) return
  const run = getCrewRunByRootSessionId(event.sessionId)
  if (!run) return

  switch (eventType(event)) {
    case 'task_run':
      projectTaskRun(run, event.data)
      return
    case 'tool_call':
      projectToolCall(run, event.data)
      return
    case 'approval':
      projectApproval(run, event.data)
      return
    case 'approval_resolved':
      projectApprovalResolved(run, event.data)
      return
    case 'question_asked':
      projectQuestion(run, event.data, false)
      return
    case 'question_resolved':
      projectQuestion(run, event.data, true)
      return
    case 'cost':
      projectCost(run, event.data)
      return
    case 'done':
      projectDone(run, event.data)
      return
    case 'error':
      projectError(run, event.data)
      return
    default:
      return
  }
}
