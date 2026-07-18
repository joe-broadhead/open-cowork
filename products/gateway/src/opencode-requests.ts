import { getConfig } from './config.js'
import { listChannelSessions } from './channel-sessions.js'
import { loadWorkState } from './work-store.js'
import { createStructuredMessage, type MessageAction, type MessageFact, type StructuredGatewayMessage } from './channels/renderer.js'
import { buildOperatorDecisionJourney, decisionFacts, openCodePermissionDecision, openCodeQuestionDecision, type OperatorDecisionJourney, type OperatorDecisionSummary } from './operator-decisions.js'
import { openCodeFetch } from './opencode-client.js'

const OPENCODE_REQUEST_TIMEOUT_MS = 1000

export interface PendingQuestionRequest {
  id: string
  sessionID: string
  questions: Array<{ question: string; header: string; options?: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }>
  tool?: unknown
}

export interface PendingPermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

export async function listPendingQuestions(): Promise<PendingQuestionRequest[]> {
  const data = await openCodeJSON('GET', '/question')
  return Array.isArray(data) ? data : []
}

export async function replyToQuestion(requestId: string, answers: string[][]): Promise<boolean> {
  return Boolean(await openCodeJSON('POST', `/question/${encodeURIComponent(requestId)}/reply`, { answers }))
}

export async function rejectQuestion(requestId: string): Promise<boolean> {
  return Boolean(await openCodeJSON('POST', `/question/${encodeURIComponent(requestId)}/reject`))
}

export async function listPendingPermissions(): Promise<PendingPermissionRequest[]> {
  const data = await openCodeJSON('GET', '/permission')
  return Array.isArray(data) ? data : []
}

export async function replyToPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<boolean> {
  return Boolean(await openCodeJSON('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { reply, ...(message ? { message } : {}) }))
}

export async function rejectPermission(requestId: string, message?: string): Promise<boolean> {
  return replyToPermission(requestId, 'reject', message)
}

export function formatQuestionRequest(row: PendingQuestionRequest): string {
  const decision = openCodeQuestionDecision(row)
  const journey = requestDecisionJourney(decision, row.sessionID)
  const lines = [`Question required`, `Question: ${row.id}`, `Session: ${row.sessionID}`]
  lines.push(`Decision owner: OpenCode`)
  lines.push(`Decision state: ${decision.state}`)
  lines.push(`Wait owner: OpenCode`)
  lines.push(`Action route: ${openCodeActionRoute(row.sessionID)}`)
  row.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${cleanRequestText(question.header, 120)}: ${cleanRequestText(question.question, 800)}`)
    for (const option of question.options || []) lines.push(`   - ${cleanRequestText(option.label, 160)}${option.description ? `: ${cleanRequestText(option.description, 400)}` : ''}`)
  })
  lines.push(`Surface sync: ${formatDecisionSurfaceStatus(journey)}`)
  lines.push(`Receipt owner: ${formatDecisionReceipts(journey)}`)
  lines.push(`Typed fallback: /answer ${row.id} <label> OR /reject-question ${row.id}`)
  lines.push(`Web/TUI recovery: ${surfaceNextAction(journey, 'Web/TUI')}`)
  lines.push(`Next action: ${decision.safeNextAction}`)
  return lines.join('\n')
}

export function formatPermissionRequest(row: PendingPermissionRequest): string {
  const decision = openCodePermissionDecision(row)
  const journey = requestDecisionJourney(decision, row.sessionID)
  return [
    'Permission required',
    `Permission: ${row.id}`,
    `Session: ${row.sessionID}`,
    `Decision owner: OpenCode`,
    `Decision state: ${decision.state}`,
    `Wait owner: OpenCode`,
    `Action route: ${openCodeActionRoute(row.sessionID)}`,
    `Request: ${cleanRequestText(row.permission, 200)}`,
    row.patterns?.length ? `Scope: ${formatRequestScope(row.patterns)}` : '',
    `Risk: ${permissionRisk(row)}`,
    `Surface sync: ${formatDecisionSurfaceStatus(journey)}`,
    `Receipt owner: ${formatDecisionReceipts(journey)}`,
    `Typed fallback: /approve ${row.id} once | /approve ${row.id} always | /deny ${row.id}`,
    `Web/TUI recovery: ${surfaceNextAction(journey, 'Web/TUI')}`,
    `Next action: ${decision.safeNextAction}`,
  ].filter(Boolean).join('\n')
}

export function questionRequestMessage(row: PendingQuestionRequest): StructuredGatewayMessage {
  const decision = openCodeQuestionDecision(row)
  const journey = requestDecisionJourney(decision, row.sessionID)
  const primary = row.questions[0]
  const facts: MessageFact[] = [
    { label: 'Question', value: row.id },
    { label: 'Session', value: row.sessionID },
    { label: 'Scope', value: `${row.questions.length} question${row.questions.length === 1 ? '' : 's'}` },
    { label: 'Wait owner', value: 'OpenCode' },
    { label: 'Action route', value: openCodeActionRoute(row.sessionID) },
    ...decisionFacts(decision),
    ...decisionSurfaceFacts(journey),
  ]
  const lines = row.questions.map((question, index) => {
    const options = (question.options || []).map(option => `- ${cleanRequestText(option.label, 120)}${option.description ? `: ${cleanRequestText(option.description, 240)}` : ''}`)
    return [`${index + 1}. ${cleanRequestText(question.header, 120)}: ${cleanRequestText(question.question, 800)}`, ...options].join('\n')
  })
  return createStructuredMessage({
    kind: 'opencode_question',
    title: 'Question required',
    status: 'pending',
    severity: 'warning',
    summary: primary ? cleanRequestText(primary.question, 800) : 'OpenCode needs an answer before this Session can continue.',
    blocks: [
      { type: 'heading', text: 'Question required', level: 2 },
      { type: 'text', text: 'OpenCode needs an answer before this Session can continue.' },
      { type: 'facts', facts },
      { type: 'details', title: 'Question details', body: lines.join('\n\n') },
      { type: 'details', title: 'Surface recovery', body: formatDecisionSurfaceDetails(journey) },
      { type: 'details', title: 'Receipt ownership', body: formatDecisionReceipts(journey) },
    ],
    actions: messageActionsForDecision(decision),
    fallback: { plainText: formatQuestionRequest(row) },
  })
}

export function permissionRequestMessage(row: PendingPermissionRequest): StructuredGatewayMessage {
  const decision = openCodePermissionDecision(row)
  const journey = requestDecisionJourney(decision, row.sessionID)
  const scope = formatRequestScope(row.patterns)
  return createStructuredMessage({
    kind: 'opencode_permission',
    title: 'Permission required',
    status: 'pending',
    severity: 'warning',
    summary: `OpenCode Session ${row.sessionID} is asking for ${cleanRequestText(row.permission, 200)} permission.`,
    blocks: [
      { type: 'heading', text: 'Permission required', level: 2 },
      { type: 'text', text: 'OpenCode needs an explicit operator decision before this Session can continue.' },
      {
        type: 'facts',
        facts: [
          { label: 'Permission', value: row.id },
          { label: 'Session', value: row.sessionID },
          { label: 'Wait owner', value: 'OpenCode' },
          { label: 'Action route', value: openCodeActionRoute(row.sessionID) },
          { label: 'Request', value: cleanRequestText(row.permission, 200) },
          { label: 'Scope', value: scope || 'Not specified' },
          { label: 'Risk', value: permissionRisk(row) },
          ...decisionFacts(decision),
          ...decisionSurfaceFacts(journey),
        ],
      },
      { type: 'details', title: 'Surface recovery', body: formatDecisionSurfaceDetails(journey) },
      { type: 'details', title: 'Receipt ownership', body: formatDecisionReceipts(journey) },
    ],
    actions: messageActionsForDecision(decision),
    fallback: { plainText: formatPermissionRequest(row) },
  })
}

export function channelTargetsForOpenCodeSession(sessionId: string) {
  const direct = listChannelSessions({ sessionId })
  const state = loadWorkState()
  const run = state.runs.find(row => row.sessionId === sessionId)
  const task = run ? state.tasks.find(row => row.id === run.taskId) : undefined
  const related = task ? listChannelSessions().filter(link => link.taskId === task.id || link.roadmapId === task.roadmapId) : []
  const seen = new Set<string>()
  return [...direct, ...related].filter(link => {
    const key = `${link.provider}:${link.chatId}:${link.threadId || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function openCodeJSON(method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    const res = await openCodeFetch(getConfig().opencodeUrl, path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }, { timeoutMs: OPENCODE_REQUEST_TIMEOUT_MS })
    const text = await res.text()
    let data: unknown = undefined
    try { data = text ? JSON.parse(text) : undefined } catch { data = text }
    if (!res.ok) throw new Error(`OpenCode ${method} ${path} failed: HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    return data
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(`OpenCode ${method} ${path} timed out after ${OPENCODE_REQUEST_TIMEOUT_MS}ms`)
    throw err
  }
}

function messageActionsForDecision(decision: OperatorDecisionSummary): MessageAction[] {
  return decision.actions.filter(action => action.enabled && action.command).map(action => ({
    label: action.label,
    command: action.command!,
    ...(action.style ? { style: action.style } : {}),
  }))
}

function requestDecisionJourney(decision: OperatorDecisionSummary, sessionId: string | undefined): OperatorDecisionJourney {
  const trustedChannelCount = sessionId ? channelTargetsForOpenCodeSession(sessionId).length : 0
  return buildOperatorDecisionJourney(decision, { trustedChannelCount })
}

function decisionSurfaceFacts(journey: OperatorDecisionJourney): MessageFact[] {
  return [
    { label: 'Surface sync', value: formatDecisionSurfaceStatus(journey) },
    ...journey.surfaceStates.map(row => ({ label: row.label, value: `${row.status}; state=${row.decisionState}` })),
  ]
}

function formatDecisionSurfaceStatus(journey: OperatorDecisionJourney): string {
  return journey.surfaceStates.map(row => `${row.label}=${row.status}`).join(', ')
}

function formatDecisionSurfaceDetails(journey: OperatorDecisionJourney): string {
  return journey.surfaceStates.map(row => `${row.label}: ${row.status}; state=${row.decisionState}; next=${row.safeNextAction}`).join('\n')
}

function formatDecisionReceipts(journey: OperatorDecisionJourney): string {
  return journey.receipts.map(row => `${row.kind}=${row.status}`).join(', ')
}

function surfaceNextAction(journey: OperatorDecisionJourney, label: string): string {
  return journey.surfaceStates.find(row => row.label === label)?.safeNextAction || journey.safeNextAction
}

function permissionRisk(row: PendingPermissionRequest): string {
  const permission = String(row.permission || '').toLowerCase()
  if (permission.includes('bash') || permission.includes('shell')) return 'Runs shell commands in the Session environment.'
  if (permission.includes('edit') || permission.includes('write')) return 'Can modify files in the Session workspace.'
  return 'Review the Session context before approving.'
}

function openCodeActionRoute(sessionId: string | undefined): string {
  const session = sessionId ? ` Session ${sessionId}` : ' the owning Session'
  return `OpenCode Web/TUI or a trusted channel bound to${session}; Gateway forwards replies only.`
}

function formatRequestScope(patterns: string[]): string {
  const cleaned = (patterns || []).map(pattern => cleanRequestText(pattern, 160)).filter(Boolean)
  if (cleaned.length <= 4) return cleaned.join(', ')
  return `${cleaned.slice(0, 4).join(', ')}, +${cleaned.length - 4} more`
}

function cleanRequestText(value: unknown, maxLength: number): string {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ch => ch === '\n' ? '\n' : ' ').trim()
  if (!maxLength || text.length <= maxLength) return text
  return `${text.substring(0, Math.max(0, maxLength - 14)).trimEnd()}... truncated`
}
