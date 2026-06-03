import type { RefObject } from 'react'
import { t } from '../../helpers/i18n'
import { Icon } from '../ui'

type ChatInputToolbarProps = {
  fileInputRef: RefObject<HTMLInputElement | null>
  modelButtonRef: RefObject<HTMLButtonElement | null>
  reasoningButtonRef?: RefObject<HTMLButtonElement | null>
  modelLabel: string
  reasoningLabel?: string
  showReasoningControl?: boolean
  currentDirectory: string | null
  agentMode: 'build' | 'plan'
  currentSessionId: string | null
  isGenerating: boolean
  isAwaitingPermission: boolean
  isAwaitingQuestion: boolean
  canSend: boolean
  sendDisabledReason?: string | null
  attachmentsAllowed?: boolean
  attachmentsDisabledReason?: string | null
  modelControlsManaged?: boolean
  modelControlsReason?: string | null
  reasoningControlsManaged?: boolean
  onAddFiles: (files: FileList | File[]) => Promise<void> | void
  onToggleModelMenu: () => void
  onToggleReasoningMenu?: () => void
  onToggleAgentMode: () => void
  onFork: () => Promise<void> | void
  onStop: () => Promise<void> | void
  onSubmit: () => Promise<void> | void
}

export function ChatInputToolbar({
  fileInputRef,
  modelButtonRef,
  reasoningButtonRef,
  modelLabel,
  reasoningLabel,
  showReasoningControl = false,
  currentDirectory,
  agentMode,
  currentSessionId,
  isGenerating,
  isAwaitingPermission,
  isAwaitingQuestion,
  canSend,
  sendDisabledReason,
  attachmentsAllowed = true,
  attachmentsDisabledReason,
  modelControlsManaged = false,
  modelControlsReason,
  reasoningControlsManaged = false,
  onAddFiles,
  onToggleModelMenu,
  onToggleReasoningMenu,
  onToggleAgentMode,
  onFork,
  onStop,
  onSubmit,
}: ChatInputToolbarProps) {
  return (
    <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
      <div className="flex items-center gap-1">
        <button
          aria-label={attachmentsAllowed ? t('chat.attachFile', 'Attach file') : attachmentsDisabledReason || t('chat.attachFileDisabled', 'File attachments are disabled by this workspace policy.')}
          onClick={() => {
            if (!attachmentsAllowed) return
            fileInputRef.current?.click()
          }}
          disabled={!attachmentsAllowed}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Icon name="paperclip" size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              void onAddFiles(event.target.files)
            }
            event.target.value = ''
          }}
        />

        <div>
          <button
          ref={modelButtonRef}
            onClick={modelControlsManaged ? undefined : onToggleModelMenu}
            disabled={modelControlsManaged}
            title={modelControlsManaged ? modelControlsReason || t('chat.modelManagedByPolicy', 'This workspace manages model selection.') : undefined}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {modelLabel}
            <Icon name="chevron-down" size={16} />
          </button>
        </div>

        {showReasoningControl && onToggleReasoningMenu ? (
          <button
            ref={reasoningButtonRef}
            onClick={reasoningControlsManaged ? undefined : onToggleReasoningMenu}
            disabled={reasoningControlsManaged}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
            title={reasoningControlsManaged ? modelControlsReason || t('chat.reasoningManagedByPolicy', 'This workspace manages reasoning settings.') : t('chat.reasoningDescription', 'Reasoning mode for models that expose OpenCode variants')}
          >
            {t('chat.reasoningChip', 'Think')} {reasoningLabel || t('chat.reasoningAuto', 'Auto')}
            <Icon name="chevron-down" size={16} />
          </button>
        ) : null}

        {currentDirectory ? (
          <span
            className="px-2 py-1 rounded-lg text-[10px] text-text-muted flex items-center gap-1 truncate"
            style={{ maxWidth: 160 }}
            title={currentDirectory}
          >
            <Icon name="folder" size={16} className="shrink-0" />
            {currentDirectory.split('/').pop()}
          </span>
        ) : null}

        <button
          onClick={onToggleAgentMode}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 ${
            agentMode === 'plan'
              ? 'bg-amber/15 text-amber'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
          }`}
          title={agentMode === 'plan' ? t('chat.planModeDescription', 'Plan mode: read-only analysis and audits') : t('chat.buildModeDescription', 'Build mode: full-access work and delegation')}
        >
          {agentMode === 'plan' ? t('chat.planMode', 'Plan') : t('chat.buildMode', 'Build')}
          <Icon name="chevron-down" size={16} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {currentSessionId && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion ? (
          <button
            aria-label={t('chat.forkThread', 'Fork thread')}
            onClick={() => void onFork()}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
            title={t('chat.forkThread', 'Fork thread')}
          >
            <Icon name="git-fork" size={16} />
          </button>
        ) : null}

        {isGenerating ? (
          <button
            aria-label={t('chat.stopGenerating', 'Stop generating (Esc)')}
            onClick={() => void onStop()}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-red hover:bg-red/10 transition-colors cursor-pointer"
            title={t('chat.stopGenerating', 'Stop generating (Esc)')}
          >
            <Icon name="square" size={16} />
          </button>
        ) : null}

        {isAwaitingPermission && !isGenerating ? (
          <div
            className="px-2 py-1 rounded-lg text-[10px] font-medium"
            style={{
              color: 'var(--color-amber)',
              background: 'color-mix(in srgb, var(--color-amber) 14%, transparent)',
            }}
            title={t('chat.awaitingApprovalTitle', 'Approve or deny the pending tool request to continue')}
          >
            {t('chat.awaitingApproval', 'Awaiting approval')}
          </div>
        ) : null}

        {isAwaitingQuestion && !isGenerating ? (
          <div
            className="px-2 py-1 rounded-lg text-[10px] font-medium"
            style={{
              color: 'var(--color-accent)',
              background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
            }}
            title={t('chat.awaitingAnswerTitle', 'Answer the pending question to continue')}
          >
            {t('chat.awaitingAnswer', 'Awaiting answer')}
          </div>
        ) : null}

        <button
          aria-label={isGenerating ? t('chat.stopGenerating', 'Stop generating (Esc)') : t('chat.send', 'Send message')}
          onClick={() => void (isGenerating ? onStop() : onSubmit())}
          disabled={!canSend && !isGenerating}
          title={!canSend && !isGenerating ? sendDisabledReason || undefined : undefined}
          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
            isGenerating
              ? 'bg-transparent text-text-muted hover:text-red'
              : canSend
                ? 'bg-text text-base'
                : 'bg-transparent text-text-muted opacity-40'
          }`}
        >
          {isGenerating ? (
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          ) : (
            <Icon name="arrow-up" size={16} />
          )}
        </button>
      </div>
    </div>
  )
}
