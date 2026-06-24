import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Badge } from './Badge.js'
import { Button } from './Button.js'
import { EmptyState } from './EmptyState.js'
import { Textarea } from './Input.js'
import { ApprovalCard, CoworkerAvatar, type StudioAction, type StudioTone } from './StudioPrimitives.js'
import { cn } from './utils.js'

export type ApprovalsQueueOption = {
  label: string
  description?: string
}

export type ApprovalsQueueQuestionPrompt = {
  header?: string
  question: string
  options?: ApprovalsQueueOption[]
  multiple?: boolean
  custom?: boolean
}

export type ApprovalsQueueBaseItem = {
  id: string
  sessionId: string
  workspaceId?: string | null
  sessionTitle: string
  requesterName: string
  requesterRole?: string
  requesterTone?: StudioTone
  viaLabel: string
  timeLabel?: string
  taskLabel?: string
  sortOrder?: number
  pending?: boolean
}

export type ApprovalsQueuePermissionItem = ApprovalsQueueBaseItem & {
  kind: 'permission'
  tool: string
  description: string
  input?: Record<string, unknown>
  canAlwaysAllow?: boolean
  alwaysAllowDisabledReason?: string | null
}

export type ApprovalsQueueQuestionItem = ApprovalsQueueBaseItem & {
  kind: 'question'
  questions: ApprovalsQueueQuestionPrompt[]
}

export type ApprovalsQueueItem = ApprovalsQueuePermissionItem | ApprovalsQueueQuestionItem

export type ApprovalsQueueSurfaceProps = {
  items: ApprovalsQueueItem[]
  loading?: boolean
  error?: string | null
  emptyTitle?: string
  emptyBody?: string
  onOpenSession?: (item: ApprovalsQueueItem) => void
  onAllowOnce?: (item: ApprovalsQueuePermissionItem) => void
  onAlwaysAllow?: (item: ApprovalsQueuePermissionItem) => void
  onDeny?: (item: ApprovalsQueuePermissionItem) => void
  onReplyQuestion?: (item: ApprovalsQueueQuestionItem, answers: string[][]) => void
  onRejectQuestion?: (item: ApprovalsQueueQuestionItem) => void
}

function itemKey(item: ApprovalsQueueItem) {
  return `${item.kind}:${item.sessionId}:${item.id}`
}

function questionTitle(item: ApprovalsQueueQuestionItem) {
  const first = item.questions[0]
  return first?.header || first?.question || 'Question requested'
}

function questionBody(item: ApprovalsQueueQuestionItem) {
  const first = item.questions[0]
  if (!first) return 'OpenCode needs an answer before this session can continue.'
  return first.question
}

function requesterLine(item: ApprovalsQueueItem) {
  const parts = [
    item.requesterRole ? `${item.requesterName} - ${item.requesterRole}` : item.requesterName,
    item.sessionTitle,
    item.timeLabel,
  ].filter(Boolean)
  return parts.join(' - ')
}

function metaChips(item: ApprovalsQueueItem) {
  return (
    <div className="studio-approval-item__chips">
      <Badge tone={item.kind === 'permission' ? 'accent' : 'info'}>
        {item.kind === 'permission' ? 'Permission' : 'Question'}
      </Badge>
      <Badge tone="neutral">via {item.viaLabel}</Badge>
      {item.taskLabel ? <Badge tone="neutral">{item.taskLabel}</Badge> : null}
    </div>
  )
}

function isStudioAction(action: StudioAction | null): action is StudioAction {
  return Boolean(action)
}

function permissionDetails(item: ApprovalsQueuePermissionItem) {
  const input = item.input && Object.keys(item.input).length ? item.input : null
  if (!input) return null
  // Always-visible monospace command block (prototype .cmd) — not a collapsed disclosure.
  return <pre className="studio-approval-command">{JSON.stringify(input, null, 2)}</pre>
}

function QuestionControls({
  item,
  onReplyQuestion,
  onRejectQuestion,
}: {
  item: ApprovalsQueueQuestionItem
  onReplyQuestion?: ApprovalsQueueSurfaceProps['onReplyQuestion']
  onRejectQuestion?: ApprovalsQueueSurfaceProps['onRejectQuestion']
}) {
  const questionCount = item.questions.length
  const [selectedAnswers, setSelectedAnswers] = useState<string[][]>(() => Array.from({ length: questionCount }, () => []))
  const [draftAnswers, setDraftAnswers] = useState<string[]>(() => Array.from({ length: questionCount }, () => ''))
  const disabled = Boolean(item.pending)

  useEffect(() => {
    setSelectedAnswers(Array.from({ length: questionCount }, () => []))
    setDraftAnswers(Array.from({ length: questionCount }, () => ''))
  }, [item.id, questionCount])

  const answers = item.questions.map((question, index) => {
    const selected = selectedAnswers[index] || []
    const draft = question.custom !== false ? (draftAnswers[index] || '').trim() : ''
    if (!question.multiple) return draft ? [draft] : selected.slice(0, 1)
    if (!draft || selected.includes(draft)) return selected
    return [...selected, draft]
  })
  const canReply = Boolean(onReplyQuestion) && answers.length > 0 && answers.every((entry) => entry.length > 0)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canReply) return
    onReplyQuestion?.(item, answers)
    setSelectedAnswers(Array.from({ length: questionCount }, () => []))
    setDraftAnswers(Array.from({ length: questionCount }, () => ''))
  }

  const toggleOption = (promptIndex: number, optionLabel: string, multiple: boolean | undefined) => {
    if (!multiple) {
      setDraftAnswers((current) => current.map((entry, index) => index === promptIndex ? '' : entry))
    }
    setSelectedAnswers((current) => current.map((entry, index) => {
      if (index !== promptIndex) return entry
      if (!multiple) return [optionLabel]
      return entry.includes(optionLabel)
        ? entry.filter((answer) => answer !== optionLabel)
        : [...entry, optionLabel]
    }))
  }

  const updateDraft = (promptIndex: number, value: string, multiple: boolean | undefined) => {
    if (!multiple && value.trim()) {
      setSelectedAnswers((current) => current.map((entry, index) => index === promptIndex ? [] : entry))
    }
    setDraftAnswers((current) => current.map((entry, index) => index === promptIndex ? value : entry))
  }

  return (
    <form className="studio-question-controls" onSubmit={submit}>
      {item.questions.map((question, index) => (
        <div className="studio-question-block" key={`${item.id}:${index}`}>
          <div>
            {question.header ? <strong>{question.header}</strong> : null}
            <p>{question.question}</p>
          </div>
          {question.options?.length ? (
            <div className="studio-question-options">
              {question.options.map((option) => (
                <button
                  type="button"
                  className="studio-question-option"
                  key={option.label}
                  disabled={disabled}
                  aria-pressed={Boolean(selectedAnswers[index]?.includes(option.label))}
                  data-selected={selectedAnswers[index]?.includes(option.label) ? 'true' : undefined}
                  onClick={() => toggleOption(index, option.label, question.multiple)}
                >
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </button>
              ))}
            </div>
          ) : null}
          {question.custom !== false ? (
            <Textarea
              rows={2}
              value={draftAnswers[index] || ''}
              disabled={disabled}
              placeholder={question.options?.length ? 'Add custom answer' : 'Reply to this question'}
              aria-label={question.header ? `Custom answer for ${question.header}` : `Custom answer for question ${index + 1}`}
              onChange={(event) => updateDraft(index, event.currentTarget.value, question.multiple)}
            />
          ) : null}
        </div>
      ))}
      <div className="studio-question-answer">
        <div className="studio-actions">
          <Button type="submit" size="sm" variant="primary" disabled={disabled || !canReply}>
            Reply
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onRejectQuestion?.(item)}>
            Reject
          </Button>
        </div>
      </div>
    </form>
  )
}

function PermissionCard({
  item,
  onOpenSession,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
}: {
  item: ApprovalsQueuePermissionItem
  onOpenSession?: ApprovalsQueueSurfaceProps['onOpenSession']
  onAllowOnce?: ApprovalsQueueSurfaceProps['onAllowOnce']
  onAlwaysAllow?: ApprovalsQueueSurfaceProps['onAlwaysAllow']
  onDeny?: ApprovalsQueueSurfaceProps['onDeny']
}) {
  const actionItems: Array<StudioAction | null> = [
    onOpenSession ? {
      id: 'open',
      children: 'Open chat',
      variant: 'ghost' as const,
      rightIcon: 'external-link' as const,
      disabled: item.pending,
      onClick: () => onOpenSession(item),
    } : null,
    onDeny ? {
      id: 'deny',
      children: 'Deny',
      variant: 'danger' as const,
      disabled: item.pending,
      onClick: () => onDeny(item),
    } : null,
    onAlwaysAllow ? {
      id: 'always',
      children: 'Always allow',
      variant: 'secondary' as const,
      disabled: item.pending || !item.canAlwaysAllow,
      disabledReason: item.alwaysAllowDisabledReason || undefined,
      onClick: () => onAlwaysAllow(item),
    } : null,
    onAllowOnce ? {
      id: 'allow',
      children: 'Allow once',
      variant: 'primary' as const,
      disabled: item.pending,
      onClick: () => onAllowOnce(item),
    } : null,
  ]
  const actions = actionItems.filter(isStudioAction)

  return (
    <ApprovalCard
      className="studio-approval-item"
      data-kind="permission"
      title={item.description || item.tool || 'Permission requested'}
      requester={requesterLine(item)}
      body={item.tool ? `Tool: ${item.tool}` : undefined}
      actions={actions}
    >
      <div className="studio-approval-item__identity">
        <CoworkerAvatar name={item.requesterName} tone={item.requesterTone || 'reviewer'} size="sm" />
        <div>
          <strong>{item.requesterName}</strong>
          <span>{item.requesterRole || 'Runtime approval'}</span>
        </div>
      </div>
      {metaChips(item)}
      {permissionDetails(item)}
    </ApprovalCard>
  )
}

function QuestionCard({
  item,
  onOpenSession,
  onReplyQuestion,
  onRejectQuestion,
}: {
  item: ApprovalsQueueQuestionItem
  onOpenSession?: ApprovalsQueueSurfaceProps['onOpenSession']
  onReplyQuestion?: ApprovalsQueueSurfaceProps['onReplyQuestion']
  onRejectQuestion?: ApprovalsQueueSurfaceProps['onRejectQuestion']
}) {
  return (
    <ApprovalCard
      className="studio-approval-item"
      data-kind="question"
      title={questionTitle(item)}
      requester={requesterLine(item)}
      body={questionBody(item)}
      actions={onOpenSession ? [{
        id: 'open',
        children: 'Open chat',
        variant: 'ghost' as const,
        rightIcon: 'external-link' as const,
        disabled: item.pending,
        onClick: () => onOpenSession(item),
      }] : undefined}
    >
      <div className="studio-approval-item__identity">
        <CoworkerAvatar name={item.requesterName} tone={item.requesterTone || 'operator'} size="sm" />
        <div>
          <strong>{item.requesterName}</strong>
          <span>{item.requesterRole || 'Question'}</span>
        </div>
      </div>
      {metaChips(item)}
      <QuestionControls item={item} onReplyQuestion={onReplyQuestion} onRejectQuestion={onRejectQuestion} />
    </ApprovalCard>
  )
}

export function ApprovalsQueueSurface({
  items,
  loading = false,
  error = null,
  emptyTitle = 'No approvals waiting',
  emptyBody = 'OpenCode permission requests and questions appear here when a chat needs your input.',
  onOpenSession,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  onReplyQuestion,
  onRejectQuestion,
}: ApprovalsQueueSurfaceProps) {
  const sortedItems = useMemo(() => [...items].sort((left, right) => (right.sortOrder || 0) - (left.sortOrder || 0)), [items])

  return (
    <section className={cn('studio-approvals-surface', loading && 'studio-approvals-surface--loading')} aria-label="Approvals queue">
      {error ? <p className="notice" data-kind="error">{error}</p> : null}
      {sortedItems.length ? (
        <div className="studio-approvals-list">
          {sortedItems.map((item) => item.kind === 'permission'
            ? (
              <PermissionCard
                key={itemKey(item)}
                item={item}
                onOpenSession={onOpenSession}
                onAllowOnce={onAllowOnce}
                onAlwaysAllow={onAlwaysAllow}
                onDeny={onDeny}
              />
            )
            : (
              <QuestionCard
                key={itemKey(item)}
                item={item}
                onOpenSession={onOpenSession}
                onReplyQuestion={onReplyQuestion}
                onRejectQuestion={onRejectQuestion}
              />
            ))}
        </div>
      ) : (
        <EmptyState icon="badge-check" title={emptyTitle} body={emptyBody} />
      )}
    </section>
  )
}
