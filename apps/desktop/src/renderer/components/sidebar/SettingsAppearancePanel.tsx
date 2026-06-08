import { getThemeTokens, getUiThemeOptions, MONO_FONT_OPTIONS, type AppearancePreferences, type ColorScheme, type MonoFont, type UiFont, type UiTheme, UI_ACCENT_PRESETS, UI_FONT_OPTIONS, type UiAccentPresetId } from '../../helpers/theme'
import { t } from '../../helpers/i18n'
import { Badge, Card, SegmentedControl, Select } from '../ui'
import { fieldLabelCls, sectionLabelCls } from './settings-panel-styles'

function ThemePreviewCard({
  themeId,
  scheme,
  accent,
}: {
  themeId: UiTheme
  scheme: 'dark' | 'light'
  accent: UiAccentPresetId
}) {
  const tokens = getThemeTokens(themeId, scheme, accent)
  return (
    <div
      className="w-full h-[76px] rounded-xl overflow-hidden relative"
      style={{
        backgroundColor: tokens.base,
        backgroundImage: tokens.bgImage === 'none' ? undefined : tokens.bgImage,
        backgroundSize: '100% 100%',
        border: `1px solid ${tokens.borderSubtle}`,
      }}
    >
      <div
        className="absolute start-2.5 end-2.5 top-2.5 rounded-lg flex items-center gap-1.5 px-2 py-1.5"
        style={{
          background: tokens.elevated,
          border: `1px solid ${tokens.border}`,
          boxShadow: tokens.shadowCard,
        }}
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tokens.accent }} />
        <span className="h-[3px] rounded-full flex-1" style={{ background: tokens.textSecondary, opacity: 0.7 }} />
        <span className="h-[3px] w-3.5 rounded-full" style={{ background: tokens.textMuted, opacity: 0.6 }} />
      </div>
      <div className="absolute inset-x-2.5 bottom-2 flex items-center gap-1">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tokens.accent, boxShadow: `0 0 6px ${tokens.accent}` }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tokens.info }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tokens.green }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tokens.amber }} />
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tokens.red }} />
        <span className="ms-auto text-[9px] font-mono" style={{ color: tokens.textMuted }}>Aa</span>
      </div>
    </div>
  )
}

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
  return (
    <div className="flex flex-col gap-5">
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
        <span className={sectionLabelCls}>{t('settings.appearance.theme', 'Theme')}</span>
        <div className="grid grid-cols-2 gap-3">
          {getUiThemeOptions().map((theme) => {
            const active = appearance.uiTheme === theme.id
            const previewScheme = appearance.colorScheme === 'light' ? 'light' : 'dark'
            return (
              <Card
                interactive
                padding="sm"
                key={theme.id}
                aria-pressed={active}
                onClick={() => onUpdate({ uiTheme: theme.id })}
                className="settings-choice-card settings-theme-card"
              >
                <ThemePreviewCard themeId={theme.id} scheme={previewScheme} accent={appearance.accent} />
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <div className="text-[12px] font-semibold text-text truncate">{theme.label}</div>
                  {active ? (
                    <Badge tone="accent" className="settings-mini-badge">
                      {t('settings.appearance.themeActive', 'Active')}
                    </Badge>
                  ) : null}
                </div>
                <div className="text-[11px] text-text-muted mt-1 leading-snug line-clamp-2">{theme.description}</div>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.accent', 'Accent')}</span>
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(UI_ACCENT_PRESETS).map(([accentId, accent]) => {
            const active = appearance.accent === accentId
            return (
              <button
                key={accentId}
                type="button"
                aria-pressed={active}
                onClick={() => onUpdate({ accent: accentId as UiAccentPresetId })}
                className="settings-choice-card rounded-lg border border-border-subtle bg-elevated px-3 py-2 text-start transition-colors hover:bg-surface-hover"
                style={{
                  borderColor: active ? 'var(--color-accent)' : undefined,
                  boxShadow: active ? 'var(--ring-selected)' : undefined,
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="h-5 w-5 rounded-full border border-border-subtle"
                    style={{ background: `linear-gradient(150deg, ${accent.accent2}, ${accent.accent})` }}
                  />
                  <span className="min-w-0 text-[12px] font-semibold text-text">{accent.label}</span>
                </span>
              </button>
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

      <div className="rounded-2xl border border-border-subtle p-4 bg-base">
        <div className="text-[12px] font-semibold text-text mb-3">{t('settings.appearance.preview', 'Preview')}</div>
        <div className="rounded-xl border border-border-subtle bg-surface p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-text">{t('settings.appearance.previewHealth', 'Workspace health')}</div>
              <div className="text-[11px] text-text-muted">{t('settings.appearance.previewHealthDescription', 'Provider connected, runtime ready')}</div>
            </div>
            <Badge tone="accent" className="settings-mini-badge">
              {t('settings.appearance.previewActive', 'Active')}
            </Badge>
          </div>
          <div className="rounded-lg border border-border-subtle p-3 bg-elevated">
            <div className="text-[12px] text-text mb-1">{t('settings.appearance.previewMessage', 'Theme changes apply immediately.')}</div>
            <div className="text-[11px] text-text-muted">{t('settings.appearance.previewMessageSecondary', 'Provider and permission changes still use the save button below.')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
