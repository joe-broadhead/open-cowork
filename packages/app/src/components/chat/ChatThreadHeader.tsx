import type { ConversationTaskContext } from '@open-cowork/shared'
import type { Session } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { ActionCluster, Badge, Button, Icon } from '../ui'

type ChatThreadHeaderProps = {
  currentSession: Session | null
  currentSessionId: string
  parentSession: Session | null
  inspectorOpen: boolean
  unreverting: boolean
  taskContext?: ConversationTaskContext | null
  onOpenParent: () => void
  onOpenBoard?: () => void
  onCaptureToKnowledge?: () => void
  onToggleInspector: () => void
  onUnrevert: () => void
  captureToKnowledgePending?: boolean
  captureToKnowledgeDone?: boolean
}

export function ChatThreadHeader({
  currentSession,
  currentSessionId,
  parentSession,
  inspectorOpen,
  unreverting,
  taskContext = null,
  onOpenParent,
  onOpenBoard,
  onCaptureToKnowledge,
  onToggleInspector,
  onUnrevert,
  captureToKnowledgePending = false,
  captureToKnowledgeDone = false,
}: ChatThreadHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border-subtle px-4 py-2 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div data-testid="chat-thread-title" className="font-display text-sm font-medium text-text truncate">
          {currentSession?.title || `Chat ${currentSessionId.slice(0, 8)}`}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {currentSession?.directory && (
            <span className="text-2xs text-text-muted truncate">
              {currentSession.directory}
            </span>
          )}
          {currentSession?.parentSessionId && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon="git-fork"
              onClick={onOpenParent}
              title={parentSession
                ? `Jump to parent: ${parentSession.title || parentSession.id}`
                : 'Jump to parent chat'}
            >
              Forked from {parentSession?.title ? parentSession.title : 'chat'}
            </Button>
          )}
          {taskContext && (
            <Badge
              tone="muted"
              aria-label={`Project ${taskContext.projectTitle}, task ${taskContext.taskTitle}`}
              className="min-w-0 max-w-full"
            >
              <span className="shrink-0 text-text-muted">Project</span>
              <span className="max-w-[150px] truncate text-text-secondary">{taskContext.projectTitle}</span>
              <Icon name="chevron-right" size={16} aria-hidden className="shrink-0 text-text-muted" />
              <span className="shrink-0 text-text-muted">Task</span>
              <span className="max-w-[180px] truncate text-text">{taskContext.taskTitle}</span>
            </Badge>
          )}
          {taskContext && onOpenBoard && (
            <Button variant="ghost" size="sm" onClick={onOpenBoard}>
              {t('chatThreadHeader.openBoard', 'Open board')}
            </Button>
          )}
          {currentSession?.changeSummary && currentSession.changeSummary.files > 0 && (
            <Badge
              tone="neutral"
              title={currentSession.changeSummary.synthetic
                ? `${currentSession.changeSummary.files} file${currentSession.changeSummary.files === 1 ? '' : 's'} changed (estimated from projection data)`
                : `${currentSession.changeSummary.files} file${currentSession.changeSummary.files === 1 ? '' : 's'} changed`}
            >
              <span className="text-green">+{currentSession.changeSummary.additions}</span>
              <span className="text-red">−{currentSession.changeSummary.deletions}</span>
              <span className="text-text-muted">
                · {currentSession.changeSummary.files} file{currentSession.changeSummary.files === 1 ? '' : 's'}
              </span>
              {currentSession.changeSummary.synthetic && <span className="text-text-muted">est</span>}
            </Badge>
          )}
          {currentSession?.revertedMessageId && (
            <button
              type="button"
              disabled={unreverting}
              onClick={onUnrevert}
              title={t('chat.revertedSessionTitle', 'This session is reverted — click to restore the later messages')}
              className="inline-flex rounded-full transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-wait cursor-pointer"
            >
              <Badge tone="warning">
                {unreverting ? 'Unreverting…' : 'Reverted · click to unrevert'}
              </Badge>
            </button>
          )}
        </div>
      </div>
      <ActionCluster
        label={t('chat.threadActions', 'Chat actions')}
        className="desktop-thread-action-cluster shrink-0"
        items={[
          {
            id: 'capture-knowledge',
            label: captureToKnowledgeDone ? 'Proposed — pending review' : 'Capture to knowledge',
            icon: captureToKnowledgeDone ? 'check' : 'book-open',
            disabled: captureToKnowledgePending,
            hidden: !onCaptureToKnowledge,
            title: captureToKnowledgeDone
              ? 'Proposed to the knowledge base — pending review'
              : 'Create a reviewable Knowledge proposal from this conversation',
            onAction: onCaptureToKnowledge,
          },
          {
            id: 'context',
            label: inspectorOpen ? 'Hide Review' : 'Show Review',
            icon: 'panel-left',
            pressed: inspectorOpen,
            title: inspectorOpen ? 'Hide the review pane' : 'Show the review pane',
            onAction: onToggleInspector,
          },
          {
            id: 'review',
            label: 'Review',
            icon: 'file-diff',
            hidden: !currentSession?.changeSummary || currentSession.changeSummary.files <= 0,
            pressed: inspectorOpen,
            tone: 'primary',
            title: 'Review changed files and artifacts',
            onAction: onToggleInspector,
          },
        ]}
      />
    </div>
  )
}
