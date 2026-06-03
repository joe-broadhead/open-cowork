import type { RefObject } from 'react'
import { t } from '../../helpers/i18n'
import { Badge, Button, Icon, IconButton } from '../ui'

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
          <span
            className="chat-current-directory px-2 py-1 rounded-lg text-[10px] text-text-muted flex items-center gap-1 truncate"
            title={currentDirectory}
          >
            <Icon name="folder" size={16} className="shrink-0" />
            {currentDirectory.split('/').pop()}
          </span>
        ) : null}

        <Button
          onClick={onToggleAgentMode}
          variant={agentMode === 'plan' ? 'secondary' : 'ghost'}
          size="sm"
          rightIcon="chevron-down"
        >
          {agentMode === 'plan' ? t('chat.planMode', 'Plan') : t('chat.buildMode', 'Build')}
        </Button>
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
          size="sm"
          variant={isGenerating ? 'danger' : canSend ? 'secondary' : 'ghost'}
        />
      </div>
    </div>
  )
}
