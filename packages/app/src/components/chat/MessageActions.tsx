import { useState } from 'react'
import type { Message } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { switchToSession } from '../../helpers/switchToSession'
import { t } from '../../helpers/i18n'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { Button, Dialog, IconButton, Tooltip } from '@open-cowork/ui'
import { DiffViewer } from './DiffViewer'
import { useVoiceReadAloud } from '../../hooks/useVoiceReadAloud'

// Live-placeholder messages have no server-side anchor yet; action
// controls appear only once the committed message id arrives.
function isLivePlaceholderId(id: string) {
  return id.endsWith(':user:live') || id.endsWith(':assistant:live')
}

export function MessageActions({
  message,
  placement,
}: {
  message: Message
  placement: 'left' | 'right'
}) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const addSession = useSessionStore((s) => s.addSession)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const [busy, setBusy] = useState<'copy' | 'fork' | 'revert' | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false)
  const readAloud = useVoiceReadAloud()

  if (!currentSessionId) return null
  if (isLivePlaceholderId(message.id)) return null

  async function handleCopy() {
    if (busy) return
    const text = message.content
    if (!text.trim()) return
    setBusy('copy')
    try {
      const copied = await writeTextToClipboard(text)
      if (!copied) addGlobalError(t('messageActions.copyFailed', 'Could not copy this message. Please try again.'))
    } finally {
      setBusy(null)
    }
  }

  async function handleFork() {
    if (busy || !currentSessionId) return
    setBusy('fork')
    try {
      const forked = await window.coworkApi.session.fork(currentSessionId, message.id)
      if (!forked) {
        addGlobalError(t('messageActions.branchFailed', 'Could not branch from this message. Please try again.'))
        return
      }
      addSession(forked)
      await switchToSession(forked.id)
    } finally {
      setBusy(null)
    }
  }

  function handleRevert() {
    if (busy || !currentSessionId) return
    setRevertConfirmOpen(true)
  }

  async function confirmRevert() {
    setRevertConfirmOpen(false)
    if (busy || !currentSessionId) return
    setBusy('revert')
    try {
      const ok = await window.coworkApi.session.revert(currentSessionId, message.id)
      if (!ok) addGlobalError(t('messageActions.revertFailed', 'Could not revert to this message. Please try again.'))
    } finally {
      setBusy(null)
    }
  }

  const isAssistant = message.role === 'assistant'
  const justify = placement === 'right' ? 'justify-end' : 'justify-start'
  const speakingThis = readAloud.isSpeakingMessage(message.id)
  const canReadAloud = isAssistant && readAloud.visible && message.content.trim().length > 0

  // Only offer "View diff" when the session has known file changes — mirrors
  // ChatThreadHeader's diff-entry rule so clicking it never just opens a modal
  // that reports "No file changes".
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null
  const hasChanges = Boolean(currentSession?.changeSummary && currentSession.changeSummary.files > 0)

  return (
    <>
      <div
        className={`chat-message-actions mt-1 flex ${justify} transition-opacity`}
      >
        <div className="chat-message-action-bar">
          <IconButton
            icon="copy"
            onClick={handleCopy}
            disabled={busy !== null || !message.content.trim()}
            loading={busy === 'copy'}
            label={t('messageActions.copyMessage', 'Copy message')}
            disabledReason={!message.content.trim() ? t('messageActions.noTextToCopy', 'No text to copy yet.') : null}
            size="sm"
          />
          {canReadAloud ? (
            <Tooltip
              content={speakingThis
                ? t('messageActions.stopReadAloud', 'Stop reading')
                : t('messageActions.readAloud', 'Read aloud (private voice)')}
            >
              <IconButton
                icon={speakingThis ? 'volume-x' : 'volume'}
                onClick={() => readAloud.toggleMessage(message.id, message.content)}
                disabled={busy !== null || (!readAloud.enabled && !speakingThis)}
                label={speakingThis
                  ? t('messageActions.stopReadAloud', 'Stop reading')
                  : t('messageActions.readAloud', 'Read aloud (private voice)')}
                disabledReason={!readAloud.enabled && !speakingThis ? readAloud.disabledReason : null}
                size="sm"
                variant={speakingThis ? 'primary' : 'ghost'}
                aria-pressed={speakingThis}
                data-testid="message-read-aloud"
              />
            </Tooltip>
          ) : null}
          {speakingThis && readAloud.state.queueLength > 0 ? (
            <Tooltip content={t('messageActions.skipReadAloud', 'Skip to next')}>
              <IconButton
                icon="chevron-right"
                onClick={() => void readAloud.skip()}
                disabled={busy !== null}
                label={t('messageActions.skipReadAloud', 'Skip to next')}
                size="sm"
                data-testid="message-read-aloud-skip"
              />
            </Tooltip>
          ) : null}
          <Tooltip content={t('messageActions.branchHere', 'Branch here')}>
            <IconButton
              icon="git-fork"
              onClick={handleFork}
              disabled={busy !== null}
              loading={busy === 'fork'}
              label={t('messageActions.branchHere', 'Branch here')}
              size="sm"
            />
          </Tooltip>
          <Tooltip content={t('messageActions.revertHere', 'Revert to here')}>
            <IconButton
              icon="rotate-ccw"
              onClick={handleRevert}
              disabled={busy !== null}
              loading={busy === 'revert'}
              label={t('messageActions.revertHere', 'Revert to here')}
              size="sm"
            />
          </Tooltip>
          {isAssistant && hasChanges && (
            <Tooltip content={t('messageActions.viewDiff', 'View diff')}>
              <IconButton
                icon="file-diff"
                onClick={() => setDiffOpen(true)}
                disabled={false}
                label={t('messageActions.viewDiff', 'View diff')}
                size="sm"
              />
            </Tooltip>
          )}
        </div>
      </div>
      {diffOpen && (
        <DiffViewer
          sessionId={currentSessionId}
          messageId={message.id}
          onClose={() => setDiffOpen(false)}
        />
      )}
      {revertConfirmOpen && (
        <Dialog
          title={t('messageActions.revertHere', 'Revert to here')}
          size="sm"
          onClose={() => setRevertConfirmOpen(false)}
          footer={(
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRevertConfirmOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => void confirmRevert()}>
                {t('messageActions.revertHere', 'Revert to here')}
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-text-secondary">
            {t('messageActions.revertConfirm', 'Revert the session to this message? Later turns will be hidden until you un-revert.')}
          </p>
        </Dialog>
      )}
    </>
  )
}
