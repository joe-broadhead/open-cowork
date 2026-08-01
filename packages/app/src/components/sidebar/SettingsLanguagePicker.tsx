import { useEffect, useState } from 'react'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import {
  recordFeatureValueActivation,
  recordFeatureValueDiscovery,
} from '../../helpers/feature-value-telemetry'
import { BUILT_IN_TRANSLATION_COVERAGE } from '../../helpers/i18n-catalogs/coverage-status'
import { localeSupportStatus } from '../../helpers/product-support-matrix'
import { Card, Select } from '@open-cowork/ui'
import { fieldLabelCls } from './settings-panel-styles'

// Honest partial-translation signal: every built-in non-English catalog shares
// one key set, so a single generated figure (coverage-status.ts, kept in sync
// by the i18n:check gate) is accurate for all of them. English is always full
// because untranslated keys render their inline English fallbacks.
const TRANSLATED_PERCENT = Math.round(
  (BUILT_IN_TRANSLATION_COVERAGE.translatedKeys / Math.max(1, BUILT_IN_TRANSLATION_COVERAGE.totalStaticKeys)) * 100,
)
const COVERAGE_IS_PARTIAL = TRANSLATED_PERCENT < 100

function localeOptionValue(
  locale: string | undefined,
  options: ReturnType<typeof getBuiltInLocales>,
) {
  if (!locale) return ''
  const normalized = locale.toLowerCase()
  return options.find((option) => (
    normalized === option.locale.toLowerCase()
    || normalized.startsWith(`${option.locale.toLowerCase()}-`)
  ))?.locale || ''
}

export function LanguagePicker() {
  const options = getBuiltInLocales()
  const [current, setCurrent] = useState<string>(() => localeOptionValue(getLocale(), options))

  useEffect(() => {
    recordFeatureValueDiscovery('locales')
  }, [])

  const handleChange = async (value: string) => {
    const nextValue = value || null
    const applied = await setLocale(nextValue)
    setCurrent(localeOptionValue(applied && nextValue ? nextValue : getLocale(), options))
    if (nextValue && applied && localeSupportStatus(nextValue) === 'experimental') {
      recordFeatureValueActivation('locales')
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className={fieldLabelCls}>{t('settings.language.label', 'Language')}</span>
        <Select
          value={current}
          onChange={(value) => void handleChange(value)}
          label={t('settings.language.label', 'Language')}
          options={[
            { value: '', label: t('settings.language.systemDefault', 'Auto-detect (supported languages)') },
            ...options.map((option) => ({
              value: option.locale,
              label: option.support === 'experimental' && COVERAGE_IS_PARTIAL
                ? t('settings.language.partialOption', '{{label}} — experimental, {{percent}}% translated', {
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
            'English is supported. Non-English languages are explicit experiments and fall back to English for untranslated copy; automatic detection uses supported languages only.',
          )}
        </span>
      </div>
    </Card>
  )
}
