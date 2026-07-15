import type { RefObject } from 'react'
import { t } from '../../helpers/i18n'
import { primaryAgentModeLabel } from '../../helpers/primary-agent-mode'
import type { PrimaryAgentMode } from '../../stores/session'
import { Badge, Button, Icon, IconButton } from '@open-cowork/ui'

type ChatInputToolbarProps = {
  fileInputRef: RefObject<HTMLInputElement | null>
  modelButtonRef: RefObject<HTMLButtonElement | null>
  reasoningButtonRef?: RefObject<HTMLButtonElement | null>
  modelLabel: string
  reasoningLabel?: string
  showReasoningControl?: boolean
  currentDirectory: string | null
  agentMode: PrimaryAgentMode
  activeAgentLabel?: string | null
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
  showAgentModeControl?: boolean
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
  activeAgentLabel,
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
  showAgentModeControl = true,
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
        <IconButton
          icon="paperclip"
          label={attachmentsAllowed ? t('chat.attachFile', 'Attach file') : attachmentsDisabledReason || t('chat.attachFileDisabled', 'File attachments are disabled by this workspace policy.')}
          onClick={() => {
            if (!attachmentsAllowed) return
            fileInputRef.current?.click()
          }}
          disabled={!attachmentsAllowed}
          disabledReason={!attachmentsAllowed ? attachmentsDisabledReason || t('chat.attachFileDisabled', 'File attachments are disabled by this workspace policy.') : null}
          size="sm"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label={t('chat.attachFile', 'Attach files')}
          onChange={(event) => {
            if (event.target.files) {
              void onAddFiles(event.target.files)
            }
            event.target.value = ''
          }}
        />

        <div className="min-w-0">
          <Button
          ref={modelButtonRef}
            onClick={modelControlsManaged ? undefined : onToggleModelMenu}
            disabled={modelControlsManaged}
            disabledReason={modelControlsManaged ? modelControlsReason || t('chat.modelManagedByPolicy', 'This workspace manages model selection.') : null}
            variant="ghost"
            size="sm"
            rightIcon="chevron-down"
          >
            {modelLabel}
          </Button>
        </div>

        {showReasoningControl && onToggleReasoningMenu ? (
          <Button
            ref={reasoningButtonRef}
            onClick={reasoningControlsManaged ? undefined : onToggleReasoningMenu}
            disabled={reasoningControlsManaged}
            disabledReason={reasoningControlsManaged ? modelControlsReason || t('chat.reasoningManagedByPolicy', 'This workspace manages reasoning settings.') : null}
            variant="ghost"
            size="sm"
            rightIcon="chevron-down"
            aria-label={`${t('chat.reasoningChip', 'Think')} ${reasoningLabel || t('chat.reasoningAuto', 'Auto')}`}
          >
            {t('chat.reasoningChip', 'Think')} {reasoningLabel || t('chat.reasoningAuto', 'Auto')}
          </Button>
        ) : null}

        {currentDirectory ? (
          <Badge tone="muted" className="chat-current-directory min-w-0" title={currentDirectory}>
            <Icon name="folder" size={16} className="shrink-0" />
            <span className="truncate">{currentDirectory.split('/').pop()}</span>
          </Badge>
        ) : null}

        {showAgentModeControl ? (
          <Button
            onClick={onToggleAgentMode}
            variant={activeAgentLabel || agentMode !== 'build' ? 'secondary' : 'ghost'}
            size="sm"
            rightIcon="chevron-down"
          >
            {activeAgentLabel || primaryAgentModeLabel(agentMode)}
          </Button>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        {currentSessionId && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion ? (
          <IconButton
            icon="git-fork"
            label={t('chat.forkThread', 'Fork thread')}
            onClick={() => void onFork()}
            size="sm"
          />
        ) : null}

        {isGenerating ? (
          <IconButton
            icon="square"
            label={t('chat.stopGenerating', 'Stop generating (Esc)')}
            onClick={() => void onStop()}
            size="sm"
            variant="danger"
          />
        ) : null}

        {isAwaitingPermission && !isGenerating ? (
          <Badge tone="warning" title={t('chat.awaitingApprovalTitle', 'Approve or deny the pending tool request to continue')}>
            {t('chat.awaitingApproval', 'Awaiting approval')}
          </Badge>
        ) : null}

        {isAwaitingQuestion && !isGenerating ? (
          <Badge tone="accent" title={t('chat.awaitingAnswerTitle', 'Answer the pending question to continue')}>
            {t('chat.awaitingAnswer', 'Awaiting answer')}
          </Badge>
        ) : null}

        <IconButton
          icon={isGenerating ? 'square' : 'arrow-up'}
          label={isGenerating ? t('chat.stopGenerating', 'Stop generating (Esc)') : t('chat.send', 'Send message')}
          onClick={() => void (isGenerating ? onStop() : onSubmit())}
          disabled={!canSend && !isGenerating}
          disabledReason={!canSend && !isGenerating ? sendDisabledReason || null : null}
          size="md"
          variant={isGenerating ? 'danger' : canSend ? 'primary' : 'ghost'}
        />
      </div>
    </div>
  )
}
