import { IconButton } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import type { VoicePttController } from '../../hooks/useVoicePtt'
import type { VoiceConversationController } from '../../hooks/useVoiceConversation'

type VoiceChrome = {
  visible: boolean
  enabled: boolean
  disabledReason: string | null
  statusLabel: string | null
  isActive: boolean
  toggle: () => Promise<void>
  /** Dictation or conversation chrome phase. */
  chromePhase: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'
}

/**
 * Click-to-toggle PTT control (JOE-1105 / JOE-1107).
 * Supports dictation inject (useVoicePtt) or conversation turns (useVoiceConversation).
 */
export function VoicePttButton({
  voice,
  conversation = null,
  size = 'sm',
}: {
  voice: VoicePttController
  /** When conversation mode is on, drive the mic from the conversation controller. */
  conversation?: VoiceConversationController | null
  size?: 'sm' | 'md'
}) {
  const usingConversation = Boolean(conversation?.visible && conversation.conversationMode)
  const chrome: VoiceChrome | null = usingConversation && conversation
    ? {
        visible: conversation.visible,
        enabled: conversation.enabled,
        disabledReason: conversation.disabledReason,
        statusLabel: conversation.statusLabel,
        isActive: conversation.isActive,
        toggle: conversation.toggle,
        chromePhase: conversation.chromePhase,
      }
    : voice.visible
      ? {
          visible: voice.visible,
          enabled: voice.enabled,
          disabledReason: voice.disabledReason,
          statusLabel: voice.statusLabel,
          isActive: voice.isActive,
          toggle: voice.toggle,
          chromePhase: voice.phase === 'listening'
            ? 'listening'
            : voice.phase === 'transcribing'
              ? 'transcribing'
              : voice.phase === 'error'
                ? 'error'
                : 'idle',
        }
      : null

  if (!chrome?.visible) return null

  const listening = chrome.chromePhase === 'listening'
  const busy = chrome.chromePhase === 'transcribing' || chrome.chromePhase === 'thinking'
  const speaking = chrome.chromePhase === 'speaking'
  const label = listening
    ? (usingConversation
      ? t('chat.voice.stopConversationListen', 'Stop and send')
      : t('chat.voice.stopListening', 'Stop listening'))
    : busy
      ? (chrome.chromePhase === 'thinking'
        ? t('chat.voice.thinking', 'Thinking…')
        : t('chat.voice.transcribing', 'Transcribing…'))
      : speaking
        ? t('chat.voice.speakingTapToInterrupt', 'Speaking — tap to interrupt')
        : usingConversation
          ? t('chat.voice.startConversation', 'Talk to agent (private voice)')
          : t('chat.voice.startListening', 'Dictate with private voice')

  const continuousOn = Boolean(conversation?.continuousVad)
  const privacyListening = Boolean(conversation?.privacyListening)
  const showPrivacyDot = usingConversation && continuousOn && (listening || privacyListening)

  return (
    <span className="inline-flex items-center gap-1.5">
      {conversation?.visible ? (
        <IconButton
          icon="radio"
          label={conversation.conversationMode
            ? t('chat.voice.conversationModeOn', 'Voice conversation on — replies are spoken')
            : t('chat.voice.conversationModeOff', 'Voice conversation off — dictation only')}
          onClick={() => conversation.setConversationMode(!conversation.conversationMode)}
          size={size}
          variant={conversation.conversationMode ? 'secondary' : 'ghost'}
          aria-pressed={conversation.conversationMode}
          data-testid="voice-conversation-mode"
        />
      ) : null}
      {conversation?.visible && conversation.conversationMode ? (
        <IconButton
          icon="activity"
          label={continuousOn
            ? t('chat.voice.continuousVadOn', 'Continuous listen on — mic re-arms after replies (energy VAD)')
            : t('chat.voice.continuousVadOff', 'Continuous listen off — push-to-talk turns only')}
          onClick={() => conversation.setContinuousVad(!conversation.continuousVad)}
          size={size}
          variant={continuousOn ? 'secondary' : 'ghost'}
          aria-pressed={continuousOn}
          data-testid="voice-continuous-vad"
        />
      ) : null}
      {showPrivacyDot ? (
        <span
          className="inline-flex items-center gap-1 text-xs text-text-muted"
          title={t('chat.voice.privacyListeningHint', 'Microphone is armed for private voice (local only)')}
          data-testid="voice-privacy-listening"
          aria-live="polite"
        >
          <span
            className="inline-block size-1.5 rounded-full bg-red"
            aria-hidden
          />
          <span className="sr-only">
            {t('chat.voice.privacyListening', 'Mic listening')}
          </span>
        </span>
      ) : null}
      {chrome.statusLabel ? (
        <span
          className="text-xs text-text-muted tabular-nums"
          aria-live="polite"
          role="status"
          data-testid="voice-status-label"
        >
          {chrome.statusLabel}
        </span>
      ) : null}
      <IconButton
        icon={speaking ? 'volume' : listening && continuousOn ? 'activity' : 'mic'}
        label={label}
        onClick={() => void chrome.toggle()}
        disabled={!chrome.enabled && !listening && !speaking}
        disabledReason={!chrome.enabled && !listening && !speaking ? chrome.disabledReason : null}
        size={size}
        variant={listening || speaking ? 'primary' : chrome.chromePhase === 'error' ? 'danger' : 'ghost'}
        loading={busy}
        aria-pressed={listening || speaking}
        data-testid="voice-ptt-button"
      />
    </span>
  )
}
