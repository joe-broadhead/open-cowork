import { createElement, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import {
  CLOUD_WEB_THREAD_PAGE_SIZE,
  cloudWebThreadProjectLabel,
  cloudWebThreadProjection,
  cloudWebThreadStatus,
  filterCloudWebThreads,
  type CloudWebThreadFilters,
  type CloudWebThreadSession,
  type CloudWebThreadView,
} from './thread-workbench.ts'
import {
  cloudWebErrorCategory,
  cloudWebRuntimeCounts,
  cloudWebRuntimeOrder,
  cloudWebSafeArtifactMetadata,
} from './runtime-workbench.ts'

const h = createElement

type PolishRowStyle = CSSProperties & {
  '--polish-row-index'?: string
}

function polishRowStyle(index: number): PolishRowStyle | undefined {
  return index < 20 ? { '--polish-row-index': String(index) } : undefined
}

function text(value: unknown, fallback = '') {
  return String(value ?? fallback)
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function runtimeProjection(view: CloudWebThreadView | null | undefined) {
  return record(view?.projection?.view)
}

function statusPillKind(status: unknown) {
  const value = String(status || '').toLowerCase()
  if (value === 'running' || value === 'open' || value === 'ready' || value === 'approved') return 'ok'
  if (value === 'approval' || value === 'question' || value === 'pending' || value === 'retrying') return 'warn'
  if (value === 'errored' || value === 'error' || value === 'denied' || value === 'rejected') return 'warn'
  return ''
}

function byteLabel(value: unknown) {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? value : 0
  if (bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
}

function artifactId(artifact: Record<string, unknown>) {
  return text(artifact.artifactId || artifact.id || artifact.filePath || '')
}

function roleLabel(role: unknown) {
  const value = String(role || 'assistant').toLowerCase()
  if (value === 'user') return 'You'
  if (value === 'system') return 'System'
  if (value === 'error') return 'Error'
  return 'Assistant'
}

function messageContent(message: Record<string, unknown>) {
  if (typeof message.content === 'string') return message.content
  return list<Record<string, unknown>>(message.segments).map((segment) => text(segment.content)).join('')
}

function detailsNode(summary: string, value: unknown, key?: string) {
  return h('details', { className: 'runtime-detail', key },
    h('summary', null, summary),
    h('pre', null, JSON.stringify(value ?? {}, null, 2)))
}

function runtimeErrorNode(error: Record<string, unknown>, index: number) {
  const message = text(error.message || error.error || error.reason, 'Runtime error')
  return h('div', { className: 'notice runtime-error', 'data-kind': 'error', key: text(error.id, `error-${index}`) },
    h('span', { className: 'pill', 'data-kind': 'warn' }, cloudWebErrorCategory(message)),
    h('span', null, message))
}

function todoListNode(todos: Record<string, unknown>[]) {
  if (!todos.length) return null
  return h('section', { className: 'activity-block', key: 'todos' },
    h('h4', null, 'Todos'),
    todos.map((todo, index) => h('div', { className: 'activity-row', key: text(todo.id, `todo-${index}`) },
      h('span', { className: 'pill' }, text(todo.status, 'todo')),
      h('span', null, [text(todo.content || todo.title, 'Todo'), todo.priority ? `(${text(todo.priority)})` : null].filter(Boolean).join(' ')))))
}

function toolTraceNode(tool: Record<string, unknown>, key: string) {
  return h('details', { className: 'runtime-detail tool-trace', key },
    h('summary', null,
      h('span', { className: 'pill', 'data-kind': statusPillKind(tool.status) }, text(tool.status, 'tool')),
      h('span', null, text(tool.name || tool.id, 'Tool call'))),
    detailsNode('Input', tool.input || {}),
    tool.output !== undefined ? detailsNode('Output', tool.output) : null,
    list(tool.attachments).length ? detailsNode('Attachments', tool.attachments) : null)
}

function taskRunNode(task: Record<string, unknown>, index: number) {
  return h('details', { className: 'runtime-detail task-run', key: text(task.id, `task-${index}`) },
    h('summary', null,
      h('span', { className: 'pill', 'data-kind': statusPillKind(task.status) }, text(task.status, 'task')),
      h('span', null, text(task.title || task.agent || task.id, 'Task run'))),
    task.content ? h('p', null, text(task.content)) : null,
    task.agent ? h('span', { className: 'pill' }, `agent ${text(task.agent)}`) : null,
    task.error ? h('p', { className: 'notice' }, text(task.error)) : null,
    ...list<Record<string, unknown>>(task.toolCalls).map((tool, toolIndex) => toolTraceNode(tool, text(tool.id, `task-tool-${index}-${toolIndex}`))),
    list(task.todos).length ? detailsNode('Task todos', task.todos) : null)
}

export type CloudThreadListProps = {
  sessions: CloudWebThreadSession[]
  views: Record<string, CloudWebThreadView | undefined>
  filters?: CloudWebThreadFilters
  selectedSessionId?: string | null
  limit?: number
  embedded?: boolean
  onSelect?: (sessionId: string) => void
}

function threadRows({ sessions, views, filters, selectedSessionId, limit = CLOUD_WEB_THREAD_PAGE_SIZE, onSelect }: CloudThreadListProps) {
  const rows = filterCloudWebThreads(sessions, views, filters, limit)
  return rows.length
    ? rows.map((session, index) => {
      const projection = cloudWebThreadProjection(views[session.sessionId])
      const status = cloudWebThreadStatus(session, projection)
      return h('div', {
        className: 'table-row react-thread-row ui-polish-list-row',
        role: 'row',
        key: session.sessionId,
        'data-selected': selectedSessionId === session.sessionId ? 'true' : 'false',
        'data-polish-stagger': index < 20 ? 'true' : undefined,
        style: polishRowStyle(index),
      },
      h('span', { role: 'cell' },
        h('button', {
          type: 'button',
          className: 'row-link',
          'aria-pressed': selectedSessionId === session.sessionId ? 'true' : 'false',
          onClick: () => onSelect?.(session.sessionId),
        }, session.title || session.sessionId),
        h('small', null, `${session.profileName || projection?.profileName || 'default'} - ${cloudWebThreadProjectLabel(projection)}`)),
      h('span', { role: 'cell' }, h('span', { className: 'pill', 'data-kind': statusPillKind(status) }, status)))
    })
    : [h('div', { className: 'table-row empty-row', role: 'row', key: 'empty' },
      h('span', { role: 'cell' }, 'No chats loaded.'),
      h('span', { role: 'cell' }, '-'))]
}

export function CloudThreadList(props: CloudThreadListProps) {
  const rows = threadRows(props)
  if (props.embedded) return h('div', { className: 'react-thread-list' }, rows)
  return h('div', { className: 'table-shell react-thread-list', role: 'table', 'aria-label': 'Cloud chats' },
    h('div', { className: 'table-row table-head', role: 'row' },
      h('span', { role: 'columnheader' }, 'Chat'),
      h('span', { role: 'columnheader' }, 'Status')),
    rows)
}

export function CloudSidebarThreadList({ sessions, views, filters, selectedSessionId, onSelect, limit = 50 }: CloudThreadListProps) {
  const rows = filterCloudWebThreads(sessions, views, filters, limit)
  return h('div', { className: 'react-sidebar-thread-list' },
    rows.length
      ? rows.map((session, index) => {
        const projection = cloudWebThreadProjection(views[session.sessionId])
        const status = cloudWebThreadStatus(session, projection)
        return h('button', {
          className: 'sidebar-thread-row ui-polish-list-row',
          type: 'button',
          key: session.sessionId,
          onClick: () => onSelect?.(session.sessionId),
          'data-selected': selectedSessionId === session.sessionId ? 'true' : 'false',
          'data-polish-stagger': index < 20 ? 'true' : undefined,
          style: polishRowStyle(index),
        },
        h('span', { className: 'sidebar-thread-main' },
          h('strong', null, session.title || session.sessionId),
          h('small', null, `${status} - ${session.profileName || projection?.profileName || 'default'}`)),
        h('span', { className: 'pill', 'data-kind': statusPillKind(status) }, status))
      })
      : h('p', { className: 'empty' }, 'No chats loaded.'))
}

export function CloudRuntimeStatus({ view }: { view: CloudWebThreadView | null | undefined }) {
  const projection = runtimeProjection(view)
  const counts = cloudWebRuntimeCounts(projection)
  const tokens = record(projection.sessionTokens)
  return h('div', { className: 'runtime-card react-runtime-status', 'aria-label': 'Runtime status' },
    h('div', { className: 'runtime-card-header' },
      h('strong', null, text(projection.status, 'idle')),
      h('span', { className: 'pill', 'data-kind': projection.isGenerating ? 'warn' : 'ok' }, projection.isGenerating ? 'streaming' : 'ready')),
    h('div', { className: 'runtime-grid' },
      h('span', null, `Messages ${counts.message}`),
      h('span', null, `Tools ${counts.toolCall}`),
      h('span', null, `Tasks ${counts.taskRun}`),
      h('span', null, `Artifacts ${counts.artifact}`),
      h('span', null, `Cost $${Number(projection.sessionCost || 0).toFixed(4)}`),
      h('span', null, `Input ${text(tokens.input, '0')}`),
      h('span', null, `Output ${text(tokens.output, '0')}`)))
}

export type CloudRuntimeActionProps = {
  pendingAction?: string | null
  onRespondPermission?: (permissionId: string, allowed: boolean) => void
  onReplyQuestion?: (requestId: string, answers: string[]) => void
  onRejectQuestion?: (requestId: string) => void
  onViewArtifact?: (artifactId: string) => void
  onDownloadArtifact?: (artifactId: string) => void
  onInspectArtifact?: (artifactId: string) => void
}

export function CloudChatTimeline({ view, onViewArtifact, onDownloadArtifact, onInspectArtifact, pendingAction }: { view: CloudWebThreadView | null | undefined } & CloudRuntimeActionProps) {
  const projection = runtimeProjection(view)
  const messages = list<Record<string, unknown>>(projection.messages)
  const latestUserOrder = messages.reduce((max, message, index) => {
    if (text(message.role, 'assistant').toLowerCase() !== 'user') return max
    return Math.max(max, cloudWebRuntimeOrder(message, index))
  }, -Infinity)
  const latestAssistantOrder = messages.reduce((max, message, index) => {
    if (text(message.role, 'assistant').toLowerCase() !== 'assistant') return max
    return Math.max(max, cloudWebRuntimeOrder(message, index))
  }, -Infinity)
  const entries: Array<{ kind: string; order: number; node: ReactNode }> = [
    ...messages.map((message, index) => {
      const order = cloudWebRuntimeOrder(message, index)
      const role = text(message.role, 'assistant')
      const streaming = Boolean(projection.isGenerating)
        && role.toLowerCase() === 'assistant'
        && order === latestAssistantOrder
        && order > latestUserOrder
      return {
        kind: 'message',
        order,
        node: h('article', { className: 'message-bubble', 'data-role': role, 'data-streaming': streaming ? 'true' : undefined, key: text(message.id, `message-${index}`) },
        h('div', { className: 'message-heading' }, roleLabel(message.role)),
        h('p', null, messageContent(message) || '(empty message)'),
        list(message.attachments).length ? detailsNode('Attachments', message.attachments) : null),
      }
    }),
    ...list<Record<string, unknown>>(projection.toolCalls).map((tool, index) => ({
      kind: 'tool',
      order: cloudWebRuntimeOrder(tool, 1_000 + index),
      node: toolTraceNode(tool, text(tool.id, `tool-${index}`)),
    })),
    ...list<Record<string, unknown>>(projection.taskRuns).map((task, index) => ({
      kind: 'task',
      order: cloudWebRuntimeOrder(task, 2_000 + index),
      node: taskRunNode(task, index),
    })),
    ...list<Record<string, unknown>>(projection.artifacts).map((artifact, index) => ({
      kind: 'artifact',
      order: cloudWebRuntimeOrder(artifact, 3_000 + index),
      node: artifactCardNode(artifact, index, { onViewArtifact, onDownloadArtifact, onInspectArtifact, pendingAction }),
    })),
    ...list<Record<string, unknown>>(projection.errors).map((error, index) => ({
      kind: 'error',
      order: cloudWebRuntimeOrder(error, 4_000 + index),
      node: runtimeErrorNode(error, index),
    })),
  ].sort((left, right) => left.order - right.order)
  const todos = todoListNode(list<Record<string, unknown>>(projection.todos))

  return h('div', { className: 'timeline react-chat-timeline', 'aria-live': 'polite' },
    entries.length || todos
      ? [...entries.map((entry) => entry.node), todos]
      : h('p', { className: 'empty' }, view ? 'No messages yet.' : 'Start a conversation from the composer.'))
}

function approvalCard(approval: Record<string, unknown>, props: CloudRuntimeActionProps, index: number) {
  const id = text(approval.id, `approval-${index}`)
  const pending = props.pendingAction === `approval:${id}`
  return h('article', { className: 'runtime-card', 'data-kind': 'approval', key: id },
    h('div', { className: 'runtime-card-header' },
      h('span', { className: 'pill', 'data-kind': 'warn' }, 'Approval'),
      h('strong', null, text(approval.description || approval.tool, 'Permission requested'))),
    h('small', null, [approval.tool, approval.taskRunId ? `task ${text(approval.taskRunId)}` : null].filter(Boolean).join(' - ')),
    detailsNode('Permission input', approval.input || {}),
    h('div', { className: 'row-actions' },
      h('button', { className: 'primary', type: 'button', disabled: pending, onClick: () => props.onRespondPermission?.(id, true) }, 'Allow'),
      h('button', { className: 'danger', type: 'button', disabled: pending, onClick: () => props.onRespondPermission?.(id, false) }, 'Deny')))
}

function questionPromptText(question: Record<string, unknown>) {
  const prompts = list<Record<string, unknown>>(question.questions)
  return text(prompts[0]?.question || question.prompt || question.description || question.id, 'Question requested')
}

function questionCard(question: Record<string, unknown>, props: CloudRuntimeActionProps, index: number) {
  const id = text(question.id || question.requestId, `question-${index}`)
  const pending = props.pendingAction === `question:${id}`
  const prompts = list<Record<string, unknown>>(question.questions)
  const sendAnswer = (form: HTMLFormElement | null) => {
    const answer = String(new FormData(form || undefined).get('answer') || '').trim()
    if (answer) props.onReplyQuestion?.(id, [answer])
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    sendAnswer(event.currentTarget)
  }
  return h('form', { className: 'runtime-card', 'data-kind': 'question', key: id, onSubmit: submit },
    h('div', { className: 'runtime-card-header' },
      h('span', { className: 'pill', 'data-kind': 'warn' }, 'Question'),
      h('strong', null, questionPromptText(question))),
    prompts.map((prompt, promptIndex) => h('div', { className: 'question-block', key: text(prompt.id, `prompt-${promptIndex}`) },
      prompt.header ? h('strong', null, text(prompt.header)) : null,
      h('p', null, text(prompt.question || prompt.description)),
      list<Record<string, unknown>>(prompt.options).length
        ? h('div', { className: 'choice-row' },
          list<Record<string, unknown>>(prompt.options).map((option, optionIndex) => {
            const label = text(option.label || option.description, 'Select')
            return h('button', {
              className: 'secondary',
              type: 'button',
              key: `${label}-${optionIndex}`,
              disabled: pending,
              onClick: () => props.onReplyQuestion?.(id, [label]),
            }, label)
          }))
        : null)),
    h('textarea', { name: 'answer', rows: 3, placeholder: 'Answer', disabled: pending, 'data-question-answer': 'true' }),
    h('div', { className: 'row-actions' },
      h('button', { className: 'primary', type: 'button', disabled: pending, onClick: (event) => sendAnswer((event.currentTarget as HTMLButtonElement).form) }, 'Send answer'),
      h('button', { className: 'danger', type: 'button', disabled: pending, onClick: () => props.onRejectQuestion?.(id) }, 'Reject')))
}

function resolvedWaitsNode(projection: Record<string, unknown>) {
  const resolved = [
    ...list<Record<string, unknown>>(projection.resolvedApprovals).map((item) => ({ kind: 'approval', item, order: cloudWebRuntimeOrder(item, 0) })),
    ...list<Record<string, unknown>>(projection.resolvedQuestions).map((item) => ({ kind: 'question', item, order: cloudWebRuntimeOrder(item, 0) })),
  ].sort((left, right) => left.order - right.order)
  if (!resolved.length) return null
  return h('section', { className: 'activity-block react-resolved-waits' },
    h('h4', null, 'Resolved waits'),
    resolved.slice(-12).map(({ kind, item }, index) => {
      const allowed = item.allowed !== false
      const rejected = Boolean(item.rejected)
      const label = kind === 'approval' ? (allowed ? 'approved' : 'denied') : (rejected ? 'question rejected' : 'answered')
      const body = kind === 'approval'
        ? text(item.description || item.tool || item.id)
        : `${questionPromptText(item)}${list(item.answers).length ? `: ${list(item.answers).join(', ')}` : ''}`
      return h('div', { className: 'activity-row', key: text(item.id, `${kind}-${index}`) },
        h('span', { className: 'pill', 'data-kind': allowed && !rejected ? 'ok' : 'warn' }, label),
        h('span', null, body))
    }))
}

export function CloudApprovalsAndQuestions({ view, ...props }: { view: CloudWebThreadView | null | undefined } & CloudRuntimeActionProps) {
  const projection = runtimeProjection(view)
  const pending = [
    ...list<Record<string, unknown>>(projection.pendingApprovals).map((entry) => ({ type: 'approval', entry })),
    ...list<Record<string, unknown>>(projection.pendingQuestions).map((entry) => ({ type: 'question', entry })),
  ]
  const resolved = resolvedWaitsNode(projection)
  return h('div', { className: 'list react-approvals-questions', 'aria-label': 'Approvals and questions' },
    pending.length
      ? [
        ...pending.map(({ type, entry }, index) => type === 'approval'
          ? approvalCard(entry, props, index)
          : questionCard(entry, props, index)),
        resolved,
      ]
      : [h('p', { className: 'empty', key: 'empty' }, 'No approvals or questions pending.'), resolved])
}

function artifactCardNode(artifact: Record<string, unknown>, index: number, props: CloudRuntimeActionProps) {
  const id = artifactId(artifact)
  const pending = Boolean(id && props.pendingAction === `artifact:${id}`)
  const metadata = cloudWebSafeArtifactMetadata(artifact)
  return h('article', { className: 'artifact-card runtime-card', key: id || `artifact-${index}` },
    h('div', { className: 'runtime-card-header' },
      h('span', { className: 'pill', 'data-kind': 'ok' }, 'Artifact'),
      h('strong', null, text(artifact.filename || artifact.name, 'artifact'))),
    h('small', null, [
      artifact.mime || artifact.contentType || 'unknown type',
      byteLabel(artifact.size),
      artifact.taskRunId ? `task ${text(artifact.taskRunId)}` : null,
      artifact.toolName || artifact.toolId || null,
    ].filter(Boolean).join(' - ')),
    h('pre', null, JSON.stringify(metadata, null, 2)),
    h('div', { className: 'row-actions' },
      h('button', { className: 'secondary', type: 'button', disabled: !id || pending, onClick: () => props.onViewArtifact?.(id) }, 'View'),
      h('button', { className: 'primary', type: 'button', disabled: !id || pending, onClick: () => props.onDownloadArtifact?.(id) }, 'Download'),
      h('button', { className: 'secondary', type: 'button', disabled: !id, onClick: () => props.onInspectArtifact?.(id) }, 'Inspect')))
}

export function CloudArtifactCards({ view, ...props }: { view: CloudWebThreadView | null | undefined } & CloudRuntimeActionProps) {
  const artifacts = list<Record<string, unknown>>(runtimeProjection(view).artifacts).slice(0, 100)
  return h('div', { className: 'list react-artifact-cards', 'aria-label': 'Artifacts' },
    artifacts.length
      ? artifacts.map((artifact, index) => artifactCardNode(artifact, index, props))
      : h('p', { className: 'empty' }, 'No artifacts loaded.'))
}
