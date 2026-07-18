import { createHash } from 'node:crypto'
import { buildRoadmapMemory, formatRoadmapMemory } from './roadmap-memory.js'
import { isAssistantComplete } from './workflow.js'
import {
  applyRoadmapSupervisorResult,
  listAlerts,
  listHumanGates,
  listRoadmapCompletionProposals,
  loadWorkState,
  type AlertRecord,
  type HumanGateRecord,
  type RoadmapSupervisorWakeupRecord,
  type WorkState,
  type WorkTaskCreateInput,
} from './work-store.js'
import type { PendingPermissionRequest, PendingQuestionRequest } from './opencode-requests.js'

export type SupervisorStatus = 'ok' | 'blocked' | 'needs_user' | 'completion_proposed' | 'failed'
export type SupervisorActionType = 'create_task' | 'ask_question' | 'request_permission' | 'block_roadmap' | 'propose_completion' | 'schedule_next_review' | 'summary' | 'none'

export interface SupervisorTurnRef {
  supervisorId: string
  roadmapId: string
  leaseOwner: string
  cursorEventId: number
}

export interface SupervisorAction {
  type: SupervisorActionType
  summary: string
}

export interface SupervisorCompletionRecommendation {
  recommendation: 'not_done' | 'ready_for_user_approval' | 'done'
  evidence: string[]
  risks: string[]
}

export interface SupervisorResult {
  turn?: SupervisorTurnRef
  status: SupervisorStatus
  summary: string
  actions: SupervisorAction[]
  questions: string[]
  proposedTasks: WorkTaskCreateInput[]
  completion?: SupervisorCompletionRecommendation
  nextReviewAt?: string
  raw: string
  resultHash: string
}

export interface SupervisorPromptContext {
  questions?: PendingQuestionRequest[]
  permissions?: PendingPermissionRequest[]
  gates?: HumanGateRecord[]
  alerts?: AlertRecord[]
}

export interface SupervisorApplyResult {
  applied: boolean
  result: SupervisorResult
  appliedActions: string[]
  rejectedActions: string[]
  changedObjectIds: string[]
  recommendation?: string
  nextAction?: string
}

const ACTION_TYPES = new Set<SupervisorActionType>(['create_task', 'ask_question', 'request_permission', 'block_roadmap', 'propose_completion', 'schedule_next_review', 'summary', 'none'])

export function buildRoadmapSupervisorPrompt(wakeup: RoadmapSupervisorWakeupRecord, state: WorkState = loadWorkState(), context: SupervisorPromptContext = {}): string {
  const roadmap = state.roadmaps.find(row => row.id === wakeup.supervisor.roadmapId)
  const tasks = state.tasks.filter(task => task.roadmapId === wakeup.supervisor.roadmapId)
  const gates = (context.gates || listHumanGates({ status: 'open' })).filter(gate => gate.roadmapId === wakeup.supervisor.roadmapId)
  const alerts = context.alerts || listAlerts({ status: 'open' })
  const questions = (context.questions || []).filter(question => question.sessionID === wakeup.supervisor.sessionId)
  const permissions = (context.permissions || []).filter(permission => permission.sessionID === wakeup.supervisor.sessionId)
  const proposals = listRoadmapCompletionProposals({ roadmapId: wakeup.supervisor.roadmapId, status: 'open' })
  const memory = buildRoadmapMemory(wakeup.supervisor.roadmapId, state)
  const eventLines = wakeup.triggerEvents.slice(-12).map(event => `- #${event.id} ${event.type} ${event.subjectId || ''} ${JSON.stringify(event.payload)}`.substring(0, 500))
  const quality = roadmap?.qualitySpec
  const turn = { supervisorId: wakeup.supervisor.supervisorId, roadmapId: wakeup.supervisor.roadmapId, leaseOwner: wakeup.leaseOwner, cursorEventId: wakeup.cursorEventId }
  const wakeContract = {
    reason: wakeup.wakeReason,
    detail: wakeup.wakeReasonDetail,
    idempotencyKey: wakeup.idempotencyKey,
    windowKey: wakeup.windowKey,
    receiptId: wakeup.receiptId,
    notificationPolicyRef: wakeup.notificationPolicyRef || wakeup.supervisor.notificationPolicyRef,
  }
  return [
    `Roadmap supervisor turn for ${roadmap?.title || wakeup.supervisor.roadmapId}.`,
    `Turn: ${JSON.stringify(turn)}`,
    `Wake contract: ${JSON.stringify(wakeContract)}`,
    taskSummary(tasks),
    quality ? `Completion policy: ${quality.completionPolicy}\nAcceptance criteria: ${quality.acceptanceCriteria.join('; ') || 'none'}\nDefinition of done: ${quality.definitionOfDone.join('; ') || 'none'}\nRequired evidence: ${[...quality.evidenceRequirements, ...quality.requiredArtifacts].join('; ') || 'none'}\nResidual risks: ${quality.residualRiskNotes.join('; ') || 'none'}` : 'Completion policy: assistant_proposes_user_approves',
    gates.length ? `Open Gateway gates:\n${gates.map(gate => `- ${gate.id}: ${gate.reason}`).join('\n')}` : 'Open Gateway gates: none',
    questions.length ? `OpenCode questions for this supervisor session:\n${questions.map(question => `- ${question.id}: ${question.questions?.[0]?.question || question.questions?.[0]?.header || 'question pending'}`).join('\n')}` : 'OpenCode questions for this supervisor session: none',
    permissions.length ? `OpenCode permissions for this supervisor session:\n${permissions.map(permission => `- ${permission.id}: ${permission.permission} ${permission.patterns?.join(', ') || ''}`).join('\n')}` : 'OpenCode permissions for this supervisor session: none',
    alerts.length ? `Open alerts:\n${alerts.slice(0, 8).map(alert => `- [${alert.severity}] ${alert.summary}`).join('\n')}` : 'Open alerts: none',
    proposals.length ? `Pending completion proposals:\n${proposals.map(proposal => `- ${proposal.id}: ${proposal.recommendation}`).join('\n')}` : 'Pending completion proposals: none',
    eventLines.length ? `New workflow events:\n${eventLines.join('\n')}` : 'New workflow events: none; this is a cadence/follow-up review.',
    memory ? formatRoadmapMemory(memory) : '',
    'Safe action policy: Gateway applies only these structured actions: none, summary, create_task as proposed task, create_task direct only when supervisor.completionPolicy.allowDirectTaskCreate=true, ask_question audit, request_permission audit, block_roadmap, propose_completion, schedule_next_review.',
    'Questions and permission requests must use OpenCode-native request flows when available; Gateway audits them from the structured result but does not create a second request runtime.',
    'Repeat the exact Turn object in the final JSON. Gateway rejects stale or mismatched turns.',
    'Finish with a fenced JSON object exactly matching this contract:',
    '```json',
    '{"turn":{"supervisorId":"' + turn.supervisorId + '","roadmapId":"' + turn.roadmapId + '","leaseOwner":"' + turn.leaseOwner + '","cursorEventId":' + turn.cursorEventId + '},"status":"ok|blocked|needs_user|completion_proposed|failed","summary":"what changed","actions":[{"type":"create_task|ask_question|request_permission|block_roadmap|propose_completion|schedule_next_review|summary|none","summary":"operator-readable action"}],"questions":["question text"],"proposedTasks":[{"title":"task title","description":"task description","priority":"HIGH|MEDIUM|LOW","qualitySpec":{"objective":"...","acceptanceCriteria":[],"definitionOfDone":[],"evidenceRequirements":[],"requiredArtifacts":[]}}],"completion":{"recommendation":"not_done|ready_for_user_approval|done","evidence":["evidence refs"],"risks":["residual risks"]},"nextReviewAt":"ISO timestamp"}',
    '```',
  ].filter(Boolean).join('\n\n')
}

export function parseSupervisorResult(messages: any[]): SupervisorResult | null {
  let lastText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isAssistantComplete(messages[i])) continue
    const text = extractText(messages[i])
    if (!text) continue
    lastText = text
    for (const candidate of fencedJsonCandidates(text)) {
      try {
        return normalizeSupervisorResult(JSON.parse(candidate), text, candidate)
      } catch {}
    }
    break
  }
  if (!lastText) return null
  return failedSupervisorResult('Supervisor turn did not produce a valid fenced JSON result.', lastText)
}

export function applySupervisorResult(supervisorId: string, result: SupervisorResult, filePath?: string): SupervisorApplyResult | undefined {
  const applied = applyRoadmapSupervisorResult(supervisorId, {
    turn: result.turn,
    status: result.status,
    summary: result.summary,
    resultHash: result.resultHash,
    actions: result.actions,
    questions: result.questions,
    proposedTasks: result.proposedTasks,
    completion: result.completion,
    nextReviewAt: result.nextReviewAt,
    recommendation: supervisorRecommendation(result),
  }, filePath)
  if (!applied) return undefined
  return {
    applied: applied.applied,
    result,
    appliedActions: applied.appliedActions,
    rejectedActions: applied.rejectedActions,
    changedObjectIds: applied.changedObjectIds,
    recommendation: applied.recommendation || supervisorRecommendation(result),
    nextAction: supervisorNextAction(result, applied.appliedActions, applied.rejectedActions),
  }
}

function supervisorRecommendation(result: SupervisorResult): string {
  if (result.completion?.recommendation && result.completion.recommendation !== 'not_done') return result.completion.recommendation
  if (result.status === 'needs_user') return 'needs_user_decision'
  if (result.status === 'blocked') return 'resolve_blocker'
  if (result.status === 'failed') return 'inspect_failed_supervisor_turn'
  return result.actions.find(action => action.type !== 'none' && action.type !== 'summary')?.type || 'continue_supervision'
}

function supervisorNextAction(result: SupervisorResult, appliedActions: string[], rejectedActions: string[]): string {
  if (rejectedActions.length) return `Inspect rejected supervisor actions: ${rejectedActions.join(', ')}`
  if (result.status === 'needs_user') return result.questions[0] || 'Answer the supervisor question or permission request.'
  if (result.status === 'blocked') return result.summary
  if (appliedActions.includes('propose_completion')) return 'Review the roadmap completion proposal.'
  if (appliedActions.some(action => action.startsWith('create_task') || action.startsWith('propose_task'))) return 'Review the supervisor proposed follow-up tasks.'
  if (result.nextReviewAt) return `Next supervisor review scheduled for ${result.nextReviewAt}.`
  return 'Continue monitoring durable work.'
}

function normalizeSupervisorResult(parsed: any, raw: string, candidate: string): SupervisorResult {
  const errors: string[] = []
  const turn = normalizeTurn(parsed?.turn)
  if (!turn) errors.push('turn is required')
  const status = normalizeStatus(parsed?.status)
  if (!status) errors.push('status must be ok, blocked, needs_user, completion_proposed, or failed')
  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim().substring(0, 2000) : ''
  if (!summary) errors.push('summary is required')
  const actions = normalizeActions(parsed?.actions, errors)
  const proposedTasks = normalizeProposedTasks(parsed?.proposedTasks, errors)
  const nextReviewAt = normalizeIso(parsed?.nextReviewAt)
  if (parsed?.nextReviewAt !== undefined && !nextReviewAt) errors.push('nextReviewAt must be an ISO timestamp')
  if (errors.length || !turn || !status) return failedSupervisorResult(`Invalid supervisor JSON result: ${errors.join('; ')}`, raw)
  return {
    turn,
    status,
    summary,
    actions,
    questions: stringList(parsed.questions, 20),
    proposedTasks,
    completion: normalizeCompletion(parsed.completion),
    nextReviewAt,
    raw: raw.substring(0, 4000),
    resultHash: hash(candidate),
  }
}

function normalizeTurn(value: any): SupervisorTurnRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cursorEventId = Number(value.cursorEventId)
  if (typeof value.supervisorId !== 'string' || typeof value.roadmapId !== 'string' || typeof value.leaseOwner !== 'string' || !Number.isInteger(cursorEventId) || cursorEventId < 0) return undefined
  return { supervisorId: value.supervisorId, roadmapId: value.roadmapId, leaseOwner: value.leaseOwner, cursorEventId }
}

function normalizeActions(actions: unknown, errors: string[]): SupervisorAction[] {
  if (actions === undefined) return []
  if (!Array.isArray(actions)) {
    errors.push('actions must be an array')
    return []
  }
  const result: SupervisorAction[] = []
  for (const action of actions.slice(0, 20)) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      errors.push('each action must be an object')
      continue
    }
    if (!ACTION_TYPES.has((action as any).type)) {
      errors.push(`unsupported action type: ${String((action as any).type)}`)
      continue
    }
    result.push({ type: (action as any).type, summary: typeof (action as any).summary === 'string' ? (action as any).summary.substring(0, 1000) : '' })
  }
  return result
}

function normalizeProposedTasks(tasks: unknown, errors: string[]): WorkTaskCreateInput[] {
  if (tasks === undefined) return []
  if (!Array.isArray(tasks)) {
    errors.push('proposedTasks must be an array')
    return []
  }
  return tasks.slice(0, 20).filter((task: any, index: number) => {
    if (typeof task?.title === 'string' && task.title.trim()) return true
    errors.push(`proposedTasks[${index}].title is required`)
    return false
  }).map((task: any) => ({
    title: task.title.trim(),
    description: typeof task.description === 'string' && task.description.trim() ? task.description : task.title,
    priority: task.priority === 'HIGH' || task.priority === 'MEDIUM' || task.priority === 'LOW' ? task.priority : 'MEDIUM',
    agent: typeof task.agent === 'string' ? task.agent : undefined,
    pipeline: Array.isArray(task.pipeline) ? task.pipeline.filter((stage: any) => typeof stage === 'string') : undefined,
    note: typeof task.note === 'string' ? task.note : undefined,
    qualitySpec: task.qualitySpec,
  }))
}

function normalizeCompletion(value: any): SupervisorCompletionRecommendation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const recommendation = value.recommendation === 'done' || value.recommendation === 'ready_for_user_approval' || value.recommendation === 'not_done' ? value.recommendation : 'not_done'
  return { recommendation, evidence: stringList(value.evidence, 50), risks: stringList(value.risks || value.unresolvedRisks, 50) }
}

function failedSupervisorResult(summary: string, raw: string): SupervisorResult {
  return { status: 'failed', summary, actions: [], questions: [], proposedTasks: [], raw: raw.substring(0, 4000), resultHash: hash(raw) }
}

function normalizeStatus(value: unknown): SupervisorStatus | undefined {
  return value === 'ok' || value === 'blocked' || value === 'needs_user' || value === 'completion_proposed' || value === 'failed' ? value : undefined
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function stringList(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return []
  return values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().substring(0, 1000)).slice(0, limit)
}

function taskSummary(tasks: Array<{ status: string; priority: string }>): string {
  return `Task counts: ${tasks.filter(task => task.status === 'done').length} done, ${tasks.filter(task => task.status === 'pending').length} pending, ${tasks.filter(task => task.status === 'running').length} running, ${tasks.filter(task => task.status === 'blocked').length} blocked, ${tasks.length} total.`
}

function extractText(message: any): string {
  return (Array.isArray(message?.parts) ? message.parts : []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n').trim()
}

function fencedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fence = /```json\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fence)) candidates.push(match[1]!.trim())
  return candidates
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
