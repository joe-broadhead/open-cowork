import { useState } from 'react'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import { Select } from '../ui'
import {
  fieldLabelCls,
  panelCardCls,
} from './settings-panel-styles'

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
              label: option.nativeLabel,
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
