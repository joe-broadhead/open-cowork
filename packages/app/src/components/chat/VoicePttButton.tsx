import { IconButton } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import type { VoicePttController } from '../../hooks/useVoicePtt'

/**
 * Click-to-toggle PTT control (JOE-1105).
 * Hold-to-talk can layer later; primary mode is keyboard/a11y-friendly toggle.
 */
export function VoicePttButton({
  voice,
  size = 'sm',
}: {
  voice: VoicePttController
  size?: 'sm' | 'md'
}) {
  if (!voice.visible) return null

  const listening = voice.phase === 'listening'
  const transcribing = voice.phase === 'transcribing'
  const label = listening
    ? t('chat.voice.stopListening', 'Stop listening')
    : transcribing
      ? t('chat.voice.transcribing', 'Transcribing…')
      : t('chat.voice.startListening', 'Dictate with private voice')

  return (
    <span className="inline-flex items-center gap-1.5">
      {voice.statusLabel ? (
        <span
          className="text-xs text-[var(--text-muted)] tabular-nums"
          aria-live="polite"
          role="status"
        >
          {voice.statusLabel}
        </span>
      ) : null}
      <IconButton
        icon="mic"
        label={label}
        onClick={() => void voice.toggle()}
        disabled={!voice.enabled && !listening}
        disabledReason={!voice.enabled && !listening ? voice.disabledReason : null}
        size={size}
        variant={listening ? 'primary' : voice.phase === 'error' ? 'danger' : 'ghost'}
        loading={transcribing}
        aria-pressed={listening}
        data-testid="voice-ptt-button"
      />
    </span>
  )
}
