import type { Session } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { ActionCluster } from '../ui'

type ChatThreadHeaderProps = {
  currentSession: Session | null
  currentSessionId: string
  parentSession: Session | null
  inspectorOpen: boolean
  unreverting: boolean
  onOpenParent: () => void
  onToggleInspector: () => void
  onUnrevert: () => void
}

export function ChatThreadHeader({
  currentSession,
  currentSessionId,
  parentSession,
  inspectorOpen,
  unreverting,
  onOpenParent,
  onToggleInspector,
  onUnrevert,
}: ChatThreadHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border-subtle px-4 py-2 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text truncate">
          {currentSession?.title || `Thread ${currentSessionId.slice(0, 8)}`}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {currentSession?.directory && (
            <span className="text-[11px] text-text-muted truncate">
              {currentSession.directory}
            </span>
          )}
          {currentSession?.parentSessionId && (
            <button
              type="button"
              onClick={onOpenParent}
              title={parentSession
                ? `Jump to parent: ${parentSession.title || parentSession.id}`
                : 'Jump to parent thread'}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
            >
              <span>⑂</span>
              <span>Forked from {parentSession?.title ? parentSession.title : 'thread'}</span>
            </button>
          )}
          {currentSession?.changeSummary && currentSession.changeSummary.files > 0 && (
            <span
              title={currentSession.changeSummary.synthetic
                ? `${currentSession.changeSummary.files} file${currentSession.changeSummary.files === 1 ? '' : 's'} changed (estimated from projection data)`
                : `${currentSession.changeSummary.files} file${currentSession.changeSummary.files === 1 ? '' : 's'} changed`}
              className="inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-full border border-border-subtle"
            >
              <span style={{ color: 'var(--color-green)' }}>+{currentSession.changeSummary.additions}</span>
              <span style={{ color: 'var(--color-red)' }}>−{currentSession.changeSummary.deletions}</span>
              <span className="text-text-muted">
                · {currentSession.changeSummary.files} file{currentSession.changeSummary.files === 1 ? '' : 's'}
              </span>
              {currentSession.changeSummary.synthetic && <span className="text-text-muted">est</span>}
            </span>
          )}
          {currentSession?.revertedMessageId && (
            <button
              type="button"
              disabled={unreverting}
              onClick={onUnrevert}
              title={t('chat.revertedSessionTitle', 'This session is reverted — click to restore the later messages')}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-wait"
              style={{
                color: 'var(--color-warning)',
                background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)',
              }}
            >
              {unreverting ? 'Unreverting…' : 'Reverted · click to unrevert'}
            </button>
          )}
        </div>
      </div>
      <ActionCluster
        label={t('chat.threadActions', 'Thread actions')}
        className="desktop-thread-action-cluster shrink-0"
        items={[
          {
            id: 'context',
            label: inspectorOpen ? 'Hide Context' : 'Show Context',
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
