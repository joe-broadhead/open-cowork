import { useEffect, useState } from 'react'
import type { ApprovalsQueueItem, ApprovalsQueuePermissionItem, ApprovalsQueueQuestionItem } from '@open-cowork/ui'
import type { CloudWebThreadSession, CloudWebThreadView } from './thread-workbench.ts'
import { asRecord, errorMessage, sessionTitle, setCloudStatus } from './react-workbench-controller.ts'

export const APPROVAL_QUEUE_VIEW_HYDRATION_LIMIT = 200

function currentBodyRoute() {
  return document.body.dataset.route || null
}

export function useActiveBodyRoute() {
  const [activeRoute, setActiveRoute] = useState<string | null>(() => currentBodyRoute())
  useEffect(() => {
    const update = () => setActiveRoute(currentBodyRoute())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-route'],
    })
    return () => observer.disconnect()
  }, [])
  return activeRoute
}

export function useCloudApprovalQueueHydration({
  activeRoute,
  refreshApprovalQueueViews,
  sessions,
  setError,
  setIsLoadingApprovalQueue,
}: {
  activeRoute: string | null
  refreshApprovalQueueViews: () => Promise<void>
  sessions: CloudWebThreadSession[]
  setError: (message: string) => void
  setIsLoadingApprovalQueue: (loading: boolean) => void
}) {
  useEffect(() => {
    if (activeRoute !== 'approvals') return undefined
    let closed = false
    setIsLoadingApprovalQueue(true)
    void refreshApprovalQueueViews()
      .catch((nextError) => {
        if (closed) return
        const message = errorMessage(nextError)
        setError(message)
        setCloudStatus(message, 'warn')
      })
      .finally(() => {
        if (!closed) setIsLoadingApprovalQueue(false)
      })
    return () => { closed = true }
  }, [activeRoute, refreshApprovalQueueViews, sessions, setError, setIsLoadingApprovalQueue])
}

function valueText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function valueList<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function cloudRuntimeProjection(view: CloudWebThreadView | null | undefined) {
  return asRecord(view?.projection?.view)
}

function displayOrigin(origin: string) {
  if (origin === 'gateway_channel') return 'Gateway channel'
  if (origin === 'cloud_web') return 'Cloud Web'
  if (!origin) return 'Cloud Web'
  return origin
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function requestOrigin(record: Record<string, unknown>) {
  return displayOrigin(
    valueText(record.viaLabel)
    || valueText(record.channelProvider)
    || valueText(record.channel)
    || valueText(record.provider)
    || valueText(record.deliverySurface)
    || 'cloud_web',
  )
}

export function queueActionKey(item: Pick<ApprovalsQueueItem, 'kind' | 'sessionId' | 'id'>) {
  return `${item.kind}:${item.sessionId}:${item.id}`
}

export function workspaceEventSessionId(event: { data?: unknown, raw?: unknown }) {
  const data = asRecord(event.data)
  const raw = asRecord(event.raw)
  return valueText(data.sessionId)
    || valueText(asRecord(data.session).sessionId)
    || valueText(asRecord(data.view).sessionId)
    || valueText(raw.sessionId)
    || valueText(asRecord(raw.session).sessionId)
}

function cloudQuestionPrompts(record: Record<string, unknown>): ApprovalsQueueQuestionItem['questions'] {
  return valueList<Record<string, unknown>>(record.questions)
    .map((question) => ({
      header: valueText(question.header) || undefined,
      question: valueText(question.question, 'OpenCode needs an answer before this session can continue.'),
      options: valueList<Record<string, unknown>>(question.options).map((option) => ({
        label: valueText(option.label),
        description: valueText(option.description) || undefined,
      })).filter((option) => option.label),
      multiple: Boolean(question.multiple),
      custom: question.custom !== false,
    }))
    .filter((question) => question.question)
}

function queueSessionTitle(session: CloudWebThreadSession, view: CloudWebThreadView | undefined) {
  return view ? sessionTitle(view, session.sessionId) : valueText(asRecord(session).title, `Cloud chat ${session.sessionId}`)
}

export function buildCloudApprovalQueueItems(
  sessions: CloudWebThreadSession[],
  views: Record<string, CloudWebThreadView | undefined>,
  pendingAction?: string | null,
): ApprovalsQueueItem[] {
  const items: ApprovalsQueueItem[] = []
  for (const session of sessions) {
    const view = views[session.sessionId]
    const projection = cloudRuntimeProjection(view)
    const sessionLabel = queueSessionTitle(session, view)
    for (const entry of valueList<Record<string, unknown>>(projection.pendingApprovals)) {
      const id = valueText(entry.id)
      if (!id) continue
      const item: ApprovalsQueuePermissionItem = {
        kind: 'permission',
        id,
        sessionId: session.sessionId,
        workspaceId: valueText(entry.workspaceId) || null,
        sessionTitle: sessionLabel,
        requesterName: valueText(entry.taskRunId) ? 'Specialist' : 'OpenCode',
        requesterRole: valueText(entry.taskRunId) ? 'Coworker lane' : 'Runtime permission',
        requesterTone: valueText(entry.taskRunId) ? 'builder' : 'reviewer',
        viaLabel: requestOrigin(entry),
        timeLabel: undefined,
        taskLabel: valueText(entry.taskRunId) ? `Task ${valueText(entry.taskRunId)}` : undefined,
        sortOrder: typeof entry.order === 'number' ? entry.order : 0,
        pending: pendingAction === queueActionKey({ kind: 'permission', sessionId: session.sessionId, id }),
        tool: valueText(entry.tool, 'tool'),
        description: valueText(entry.description, 'Permission requested'),
        input: asRecord(entry.input),
        canAlwaysAllow: false,
        alwaysAllowDisabledReason: 'Always allow is managed by Cloud workspace policy.',
      }
      items.push(item)
    }
    for (const entry of valueList<Record<string, unknown>>(projection.pendingQuestions)) {
      const id = valueText(entry.id)
      if (!id) continue
      const item: ApprovalsQueueQuestionItem = {
        kind: 'question',
        id,
        sessionId: session.sessionId,
        workspaceId: valueText(entry.workspaceId) || null,
        sessionTitle: sessionLabel,
        requesterName: valueText(entry.sourceSessionId) ? 'Specialist' : 'OpenCode',
        requesterRole: valueText(entry.sourceSessionId) ? 'Coworker question' : 'Runtime question',
        requesterTone: valueText(entry.sourceSessionId) ? 'operator' : 'reviewer',
        viaLabel: requestOrigin(entry),
        timeLabel: undefined,
        taskLabel: valueText(entry.sourceSessionId) ? `Chat ${valueText(entry.sourceSessionId)}` : undefined,
        sortOrder: typeof entry.order === 'number' ? entry.order : 0,
        pending: pendingAction === queueActionKey({ kind: 'question', sessionId: session.sessionId, id }),
        questions: cloudQuestionPrompts(entry),
      }
      items.push(item)
    }
  }
  return items
}

export function normalizeQuestionAnswers(answers: string[] | string[][]) {
  const groups = Array.isArray(answers[0])
    ? answers as string[][]
    : [answers as string[]]
  return groups
    .map((group) => group.map((answer) => answer.trim()).filter(Boolean))
    .filter((group) => group.length > 0)
}
