import {
  COWORK_CREW_SCHEMA_VERSION,
  type CrewDefinitionDraft,
  type CrewDetail,
  type CrewListPayload,
  type CrewMember,
  type CrewMemberDraft,
  type CrewRunDetail,
  type CrewRunDraft,
  type TraceActor,
  type TraceEventSource,
  createCoworkTraceEvent,
} from '@open-cowork/shared'
import { createHash } from 'node:crypto'
import {
  appendCoworkTraceEvent,
  createCoworkWorkItem,
  createCrewDefinition,
  createCrewRun,
  createCrewRunNode,
  createCrewVersion,
  getCrewDefinition,
  getCoworkWorkItem,
  getCrewRun,
  getCrewVersion,
  listCoworkTraceEventsForRun,
  listCrewApprovalsForRun,
  listCrewArtifactsForRun,
  listCrewDefinitions,
  listCrewRunNodes,
  listCrewRuns,
  listCrewVersions,
  listOutcomeEvaluationsForRun,
  listPolicyDecisionsForRun,
  updateCrewRunStatus,
  updateCrewRunNodeStatus,
  withCrewTransaction,
} from './crew-store.ts'
import type { CrewRuntimeExecutionDriver } from './crew-runtime-execution.ts'

const MAX_CREW_MEMBERS = 25
const MAX_CREW_STRING_BYTES = 16 * 1024
const FIXED_CREW_WORKFLOW = ['plan', 'delegate', 'join', 'evaluate', 'deliver'] as const

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

export function validateCrewDefinitionDraft(draft: CrewDefinitionDraft) {
  boundedString(draft.name, 'Crew name')
  boundedString(draft.description, 'Crew description')
  if (!Array.isArray(draft.members)) throw new Error('Crew members must be an array.')
  if (draft.members.length > MAX_CREW_MEMBERS) throw new Error('Crew has too many members.')
  const members = draft.members.map(normalizeCrewMember)
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
      outcomeRubricId: draft.outcomeRubricId || null,
      budgetCapUsd: draft.budgetCapUsd ?? null,
      workflow: [...FIXED_CREW_WORKFLOW],
      createdBy: 'local-user',
    })
    if (!version) throw new Error('Failed to create crew version.')
    const detail = getCrewDetail(definition.id)
    if (!detail) throw new Error('Failed to load created crew.')
    return detail
  })
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

function requireCreated<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`Failed to create ${label}.`)
  return value
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
  }

  const updated = getCrewRunDetail(runId)
  if (!updated) throw new Error(`Crew run ${runId} disappeared after execution dispatch.`)
  return updated
}

export async function startCrewRunWithOpenCode(
  draft: CrewRunDraft,
  driver: CrewRuntimeExecutionDriver,
): Promise<CrewRunDetail> {
  const runDetail = startCrewRun(draft)
  return executeCrewRunWithOpenCode(runDetail.run.id, driver)
}

export function startCrewRun(draft: CrewRunDraft): CrewRunDetail {
  const crewId = boundedString(draft.crewId, 'Crew id')
  const title = boundedString(draft.title, 'Crew run title')
  const detail = getCrewDetail(crewId)
  if (!detail?.activeVersion) throw new Error('Crew does not have an active version.')
  const activeVersion = detail.activeVersion
  const specialists = activeVersion.members.filter((member) => member.role === 'specialist')
  const evaluator = activeVersion.members.find((member) => member.role === 'evaluator')
  if (specialists.length < 2 || !evaluator) throw new Error('Crew active version does not satisfy the MVP branch/join shape.')

  return withCrewTransaction(() => {
    const workItemTitle = boundedOptionalString(draft.workItemTitle, 'Crew work item title')
    const workItemDescription = boundedOptionalString(draft.workItemDescription, 'Crew work item description')
    const workItem = workItemTitle || workItemDescription
      ? createCoworkWorkItem({
        title: workItemTitle || title,
        description: workItemDescription || workItemTitle || title,
        source: 'manual',
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

    const updatedRun = updateCrewRunStatus(run.id, 'planning')
    appendRunTrace({
      runId: run.id,
      sequence: sequence++,
      actorId: crewId,
      payload: {
        type: 'crew_run.created',
        crewId,
        crewVersionId: activeVersion.id,
        workflow: activeVersion.workflow,
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
