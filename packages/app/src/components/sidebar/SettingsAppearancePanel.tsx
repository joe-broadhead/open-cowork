import { DENSITY_OPTIONS, MONO_FONT_OPTIONS, type AppearancePreferences, type ColorScheme, type Density, type MonoFont, type UiFont, UI_ACCENT_PRESETS, UI_FONT_OPTIONS, type UiAccentPresetId, type UiTheme, getUserFacingThemes, THEME_MATCHED_ACCENT } from '../../helpers/theme'
import { t } from '../../helpers/i18n'
import { Badge, Card, SegmentedControl, Select } from '@open-cowork/ui'
import { fieldLabelCls, sectionLabelCls } from './settings-panel-styles'

function colorSchemeLabel(scheme: ColorScheme) {
  if (scheme === 'dark') return t('settings.appearance.modeMercury', 'Mercury')
  if (scheme === 'light') return t('settings.appearance.modeDay', 'Day')
  return t('settings.appearance.modeSystem', 'System')
}

export function AppearancePreview({
  appearance,
  onUpdate,
}: {
  appearance: AppearancePreferences
  onUpdate: (patch: Partial<AppearancePreferences>) => void
}) {
  const themes = getUserFacingThemes()
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.theme', 'Theme')}</span>
        <div className="grid grid-cols-2 gap-2">
          {themes.map((theme) => {
            const active = appearance.uiTheme === theme.id
            return (
              <Card
                key={theme.id}
                interactive
                padding="sm"
                aria-pressed={active}
                onClick={() => onUpdate({ uiTheme: theme.id as UiTheme })}
                className="settings-choice-card"
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 overflow-hidden rounded-full border border-border-subtle">
                    {theme.swatches.slice(0, 4).map((color, index) => (
                      <span key={index} className="flex-1" style={{ background: color }} />
                    ))}
                  </span>
                  <span className="min-w-0 truncate text-xs font-semibold text-text">{theme.label}</span>
                </span>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.colorScheme', 'Color Scheme')}</span>
        <SegmentedControl
          label={t('settings.appearance.colorScheme', 'Color Scheme')}
          value={appearance.colorScheme}
          onChange={(value) => onUpdate({ colorScheme: value as ColorScheme })}
          className="settings-wide-control"
          options={(['system', 'dark', 'light'] as ColorScheme[]).map((scheme) => ({
            value: scheme,
            label: colorSchemeLabel(scheme),
          }))}
        />
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.accent', 'Accent')}</span>
        <div className="grid grid-cols-3 gap-2">
          <Card
            interactive
            padding="sm"
            aria-pressed={appearance.accent === THEME_MATCHED_ACCENT}
            onClick={() => onUpdate({ accent: THEME_MATCHED_ACCENT })}
            className="settings-choice-card"
          >
            <span className="flex items-center gap-2">
              <span
                className="h-5 w-5 shrink-0 rounded-full border border-border-subtle"
                style={{ background: 'conic-gradient(from 210deg, var(--color-accent), var(--color-info), var(--color-green), var(--color-amber), var(--color-red), var(--color-accent))' }}
              />
              <span className="min-w-0 truncate text-xs font-semibold text-text">{t('settings.appearance.accentMatchTheme', 'Match theme')}</span>
            </span>
          </Card>
          {Object.entries(UI_ACCENT_PRESETS).map(([accentId, accent]) => {
            const active = appearance.accent === accentId
            return (
              <Card
                key={accentId}
                interactive
                padding="sm"
                aria-pressed={active}
                onClick={() => onUpdate({ accent: accentId as UiAccentPresetId })}
                className="settings-choice-card"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-5 w-5 rounded-full border border-border-subtle"
                    style={{ background: `linear-gradient(150deg, ${accent.accent2}, ${accent.accent})` }}
                  />
                  <span className="min-w-0 text-xs font-semibold text-text">{accent.label}</span>
                </span>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.appearance.uiFont', 'Interface font')}</span>
          <Select
            value={appearance.uiFont}
            label={t('settings.appearance.uiFont', 'Interface font')}
            onChange={(value) => onUpdate({ uiFont: value as UiFont })}
            options={UI_FONT_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.appearance.monoFont', 'Monospace font')}</span>
          <Select
            value={appearance.monoFont}
            label={t('settings.appearance.monoFont', 'Monospace font')}
            onChange={(value) => onUpdate({ monoFont: value as MonoFont })}
            options={MONO_FONT_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.density', 'Density')}</span>
        <SegmentedControl
          label={t('settings.appearance.density', 'Density')}
          value={appearance.density}
          onChange={(value) => onUpdate({ density: value as Density })}
          className="settings-wide-control"
          options={DENSITY_OPTIONS.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
        />
      </div>

      <Card className="flex flex-col gap-3">
        <div className="text-xs font-semibold text-text">{t('settings.appearance.preview', 'Preview')}</div>
        <Card variant="flat" padding="sm" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-text">{t('settings.appearance.previewHealth', 'Workspace health')}</div>
              <div className="text-2xs text-text-muted">{t('settings.appearance.previewHealthDescription', 'Provider connected, runtime ready')}</div>
            </div>
            <Badge tone="accent" className="settings-mini-badge">
              {t('settings.appearance.previewActive', 'Active')}
            </Badge>
          </div>
          <Card variant="flat" padding="sm">
            <div className="text-xs text-text mb-1">{t('settings.appearance.previewMessage', 'Theme changes apply immediately.')}</div>
            <div className="text-2xs text-text-muted">{t('settings.appearance.previewMessageSecondary', 'Provider and permission changes still use the save button below.')}</div>
          </Card>
        </Card>
      </Card>
    </div>
  )
}
