import { validateVoicePttShortcut, VOICE_PTT_SHORTCUT } from '@open-cowork/shared'
import { Button, Input } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { VoiceAssetsPanel } from './SettingsVoiceAssetsPanel'

export function describeVoiceShortcutError(value: unknown) {
  const validation = validateVoicePttShortcut(value)
  if (validation.ok) return null
  if (validation.reason === 'conflict') {
    return t(
      'settings.privacy.voicePttShortcutConflict',
      'This shortcut conflicts with {{feature}}. Choose a different combination.',
      { feature: validation.conflict },
    )
  }
  return t(
    'settings.privacy.voicePttShortcutFormat',
    'Include a modifier and a supported key, for example {{shortcut}}.',
    { shortcut: VOICE_PTT_SHORTCUT },
  )
}

export function SettingsVoiceShortcut({
  value,
  onChange,
}: {
  value?: string | null
  onChange: (value: string) => void
}) {
  const shortcut = value ?? VOICE_PTT_SHORTCUT
  const error = describeVoiceShortcutError(shortcut)

  return (
    <div id="settings-privacy-voice" className="rounded-2xl border border-border-subtle p-4 flex flex-col gap-3 scroll-mt-4">
      <div className="text-xs font-semibold text-text">{t('settings.privacy.voiceTitle', 'Private voice (Desktop)')}</div>
      <div className="text-xs leading-relaxed text-text-muted">
        {t(
          'settings.privacy.voiceDescription',
          'Push-to-talk toggle works while Open Cowork is focused. It does not inject text into other apps (that is a separate system Accessibility product). Avoid shortcuts already used by the app.',
        )}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text">{t('settings.privacy.voicePttShortcut', 'Push-to-talk shortcut')}</span>
        <Input
          value={shortcut}
          onChange={(event) => onChange(event.target.value)}
          placeholder={VOICE_PTT_SHORTCUT}
          aria-label={t('settings.privacy.voicePttShortcut', 'Push-to-talk shortcut')}
          error={error}
        />
        <span className="text-2xs leading-relaxed text-text-muted">
          {t(
            'settings.privacy.voicePttShortcutHint',
            'Electron accelerator form, e.g. {{shortcut}}. The shortcut works while Open Cowork is focused and updates the Edit menu when saved.',
            { shortcut: VOICE_PTT_SHORTCUT },
          )}
        </span>
      </label>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange(VOICE_PTT_SHORTCUT)}
          disabled={shortcut === VOICE_PTT_SHORTCUT}
        >
          {t('settings.privacy.voicePttShortcutReset', 'Restore default shortcut')}
        </Button>
      </div>
      <VoiceAssetsPanel />
    </div>
  )
}
