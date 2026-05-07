import { useState } from 'react'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import {
  fieldLabelCls,
  inputCls,
  panelCardCls,
} from './settings-panel-styles'

export function LanguagePicker() {
  const [current, setCurrent] = useState<string>(() => getLocale() || '')
  const options = getBuiltInLocales()

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value || null
    void setLocale(value)
    setCurrent(value || getLocale() || '')
  }

  return (
    <div className={panelCardCls}>
      <div className="flex flex-col gap-1">
        <span className={fieldLabelCls}>{t('settings.language.label', 'Language')}</span>
        <select
          value={current}
          onChange={handleChange}
          className={inputCls}
          aria-label={t('settings.language.label', 'Language')}
        >
          <option value="">{t('settings.language.systemDefault', 'Auto-detect (system)')}</option>
          {options.map((option) => (
            <option key={option.locale} value={option.locale}>
              {option.nativeLabel}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-text-muted leading-relaxed mt-1">
          {t(
            'settings.language.description',
            'Choose the interface language. The selection is remembered on this device. Partially-translated languages fall back to English for unlisted strings.',
          )}
        </span>
      </div>
    </div>
  )
}
