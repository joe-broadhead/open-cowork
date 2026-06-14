import type { ApprovalsQueueItem } from '@open-cowork/ui'
import type { PendingApproval, PendingQuestion, SessionInfo, SessionView } from '@open-cowork/shared'
import type { SessionViewState } from '../../stores/session'
import {
  LOCAL_WORKSPACE_ID,
  normalizeWorkspaceId,
  parseSessionWorkspaceKey,
  sessionWorkspaceKey,
} from '../../stores/session-workspace-keys'

type QueueStateInput = {
  activeWorkspaceId: string
  sessionsByWorkspace: Record<string, SessionInfo[]>
  sessionStateById: Record<string, SessionViewState>
  currentSessionId?: string | null
  currentView?: SessionView
  pendingAction?: string | null
}

export function approvalQueueActionKey(item: Pick<ApprovalsQueueItem, 'kind' | 'sessionId' | 'id'>) {
  return `${item.kind}:${item.sessionId}:${item.id}`
}

function sessionTitle(session: SessionInfo | undefined, sessionId: string) {
  return session?.title || `Chat ${sessionId}`
}

function recordLabel(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function requestOrigin(value: unknown, fallback: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const record = value as Record<string, unknown>
  return recordLabel(record.viaLabel, '')
    || recordLabel(record.channelProvider, '')
    || recordLabel(record.channel, '')
    || recordLabel(record.provider, '')
    || recordLabel(record.deliverySurface, '')
    || fallback
}

function displayOrigin(origin: string) {
  if (origin === 'gateway_channel') return 'Gateway channel'
  if (origin === 'cloud_web') return 'Cloud Web'
  if (!origin) return 'Desktop'
  return origin
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function timeLabel(order: unknown) {
  if (typeof order !== 'number' || !Number.isFinite(order)) return undefined
  if (order > 1_000_000_000_000) {
    return new Date(order).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return `#${Math.round(order)}`
}

function permissionItem(
  approval: PendingApproval,
  session: SessionInfo | undefined,
  workspaceId: string,
  pendingAction?: string | null,
): ApprovalsQueueItem {
  const isLocal = normalizeWorkspaceId(workspaceId) === LOCAL_WORKSPACE_ID
  const alwaysAllowDisabledReason = isLocal
    ? 'Persistent allow rules must be changed in Settings so the runtime can restart safely.'
    : 'Always allow is managed by workspace policy for remote or cloud approvals.'
  const item: ApprovalsQueueItem = {
    kind: 'permission',
    id: approval.id,
    sessionId: approval.sessionId,
    workspaceId,
    sessionTitle: sessionTitle(session, approval.sessionId),
    requesterName: approval.taskRunId ? 'Specialist' : 'OpenCode',
    requesterRole: approval.taskRunId ? 'Coworker lane' : 'Runtime permission',
    requesterTone: approval.taskRunId ? 'builder' : 'reviewer',
    viaLabel: displayOrigin(requestOrigin(approval, isLocal ? 'Desktop' : 'Cloud Web')),
    timeLabel: timeLabel(approval.order),
    taskLabel: approval.taskRunId ? `Task ${approval.taskRunId}` : undefined,
    sortOrder: approval.order,
    pending: pendingAction === approvalQueueActionKey({ kind: 'permission', sessionId: approval.sessionId, id: approval.id }),
    tool: approval.tool,
    description: approval.description,
    input: approval.input,
    canAlwaysAllow: false,
    alwaysAllowDisabledReason,
  }
  return item
}

function questionItem(
  question: PendingQuestion,
  session: SessionInfo | undefined,
  workspaceId: string,
  pendingAction?: string | null,
): ApprovalsQueueItem {
  const sessionId = question.sessionId
  const isLocal = normalizeWorkspaceId(workspaceId) === LOCAL_WORKSPACE_ID
  const order = typeof (question as { order?: unknown }).order === 'number'
    ? (question as { order?: number }).order
    : 0
  return {
    kind: 'question',
    id: question.id,
    sessionId,
    workspaceId,
    sessionTitle: sessionTitle(session, sessionId),
    requesterName: question.sourceSessionId ? 'Specialist' : 'OpenCode',
    requesterRole: question.sourceSessionId ? 'Coworker question' : 'Runtime question',
    requesterTone: question.sourceSessionId ? 'operator' : 'reviewer',
    viaLabel: displayOrigin(requestOrigin(question, isLocal ? 'Desktop' : 'Cloud Web')),
    timeLabel: timeLabel(order),
    sortOrder: order,
    pending: pendingAction === approvalQueueActionKey({ kind: 'question', sessionId, id: question.id }),
    questions: question.questions,
  }
}

export function buildDesktopApprovalQueueItems({
  activeWorkspaceId,
  sessionsByWorkspace,
  sessionStateById,
  currentSessionId,
  currentView,
  pendingAction,
}: QueueStateInput): ApprovalsQueueItem[] {
  const workspaceId = normalizeWorkspaceId(activeWorkspaceId)
  const sessions = sessionsByWorkspace[workspaceId] || []
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const queueStates = new Map<string, Pick<SessionViewState, 'pendingApprovals' | 'pendingQuestions'>>()

  for (const [key, state] of Object.entries(sessionStateById)) {
    const parsed = parseSessionWorkspaceKey(key)
    if (normalizeWorkspaceId(parsed.workspaceId) !== workspaceId) continue
    if (state.pendingApprovals.length || state.pendingQuestions.length) {
      queueStates.set(key, state)
    }
  }

  if (currentSessionId && currentView && (currentView.pendingApprovals.length || currentView.pendingQuestions.length)) {
    queueStates.set(sessionWorkspaceKey(workspaceId, currentSessionId), currentView)
  }

  const items: ApprovalsQueueItem[] = []
  for (const [key, state] of queueStates) {
    const parsed = parseSessionWorkspaceKey(key)
    const stateWorkspaceId = normalizeWorkspaceId(parsed.workspaceId)
    const session = sessionsById.get(parsed.sessionId)
    for (const approval of state.pendingApprovals) {
      const approvalWorkspaceId = normalizeWorkspaceId(approval.workspaceId || stateWorkspaceId)
      if (approvalWorkspaceId !== workspaceId) continue
      items.push(permissionItem({ ...approval, workspaceId: approvalWorkspaceId }, session, approvalWorkspaceId, pendingAction))
    }
    for (const question of state.pendingQuestions) {
      const questionWorkspaceId = normalizeWorkspaceId(question.workspaceId || stateWorkspaceId)
      if (questionWorkspaceId !== workspaceId) continue
      const sessionId = question.sessionId || parsed.sessionId
      items.push(questionItem({ ...question, sessionId, workspaceId: questionWorkspaceId }, sessionsById.get(sessionId) || session, questionWorkspaceId, pendingAction))
    }
  }

  return items
}
