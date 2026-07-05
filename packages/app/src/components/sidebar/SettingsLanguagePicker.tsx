import { useState } from 'react'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import { BUILT_IN_TRANSLATION_COVERAGE } from '../../helpers/i18n-catalogs/coverage-status'
import { Select } from '../ui'
import {
  fieldLabelCls,
  panelCardCls,
} from './settings-panel-styles'

// Honest partial-translation signal: every built-in non-English catalog shares
// one key set, so a single generated figure (coverage-status.ts, kept in sync
// by the i18n:check gate) is accurate for all of them. English is always full
// because untranslated keys render their inline English fallbacks.
const TRANSLATED_PERCENT = Math.round(
  (BUILT_IN_TRANSLATION_COVERAGE.translatedKeys / Math.max(1, BUILT_IN_TRANSLATION_COVERAGE.totalStaticKeys)) * 100,
)
const COVERAGE_IS_PARTIAL = TRANSLATED_PERCENT < 100

export function LanguagePicker() {
  const [current, setCurrent] = useState<string>(() => getLocale() || '')
  const options = getBuiltInLocales()

  const handleChange = (value: string) => {
    const nextValue = value || null
    void setLocale(nextValue)
    setCurrent(nextValue || getLocale() || '')
  }

  return (
    <div className={panelCardCls}>
      <div className="flex flex-col gap-1">
        <span className={fieldLabelCls}>{t('settings.language.label', 'Language')}</span>
        <Select
          value={current}
          onChange={handleChange}
          label={t('settings.language.label', 'Language')}
          options={[
            { value: '', label: t('settings.language.systemDefault', 'Auto-detect (system)') },
            ...options.map((option) => ({
              value: option.locale,
              label: option.locale !== 'en' && COVERAGE_IS_PARTIAL
                ? t('settings.language.partialOption', '{{label}} — {{percent}}% translated', {
                    label: option.nativeLabel,
                    percent: String(TRANSLATED_PERCENT),
                  })
                : option.nativeLabel,
            })),
          ]}
        />
        <span className="text-2xs text-text-muted leading-relaxed mt-1">
          {t(
            'settings.language.description',
            'Choose the interface language. The selection is remembered on this device. Partially-translated languages fall back to English for unlisted strings.',
          )}
        </span>
      </div>
    </div>
  )
}
