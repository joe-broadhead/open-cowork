import { getThemeTokens, getUiThemeOptions, MONO_FONT_OPTIONS, type AppearancePreferences, type ColorScheme, type MonoFont, type UiFont, type UiTheme, UI_FONT_OPTIONS } from '../../helpers/theme'
import { t } from '../../helpers/i18n'

const inputCls = 'w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors'
const sectionLabelCls = 'text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1'
const fieldLabelCls = 'text-[11px] text-text-muted font-medium'

function ThemePreviewCard({
  themeId,
  scheme,
}: {
  themeId: UiTheme
  scheme: 'dark' | 'light'
}) {
  const tokens = getThemeTokens(themeId, scheme)
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
        <div className="rounded-2xl border border-border-subtle p-1.5 flex gap-1.5 bg-surface">
          {(['system', 'dark', 'light'] as ColorScheme[]).map((scheme) => (
            <button
              key={scheme}
              onClick={() => onUpdate({ colorScheme: scheme })}
              className={`flex-1 px-3 py-2 rounded-xl text-[12px] font-medium capitalize transition-colors cursor-pointer ${appearance.colorScheme === scheme ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {scheme}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.appearance.theme', 'Theme')}</span>
        <div className="grid grid-cols-2 gap-3">
          {getUiThemeOptions().map((theme) => {
            const active = appearance.uiTheme === theme.id
            const previewScheme = appearance.colorScheme === 'light' ? 'light' : 'dark'
            return (
              <button
                key={theme.id}
                onClick={() => onUpdate({ uiTheme: theme.id })}
                className="text-start rounded-2xl border p-3 transition-all cursor-pointer hover:scale-[1.01]"
                style={{
                  borderColor: active ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                  background: active
                    ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))'
                    : 'var(--color-elevated)',
                  boxShadow: active
                    ? '0 0 0 1px var(--color-accent), 0 6px 20px color-mix(in srgb, var(--color-accent) 14%, transparent)'
                    : 'none',
                }}
              >
                <ThemePreviewCard themeId={theme.id} scheme={previewScheme} />
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <div className="text-[12px] font-semibold text-text truncate">{theme.label}</div>
                  {active ? (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                      style={{
                        color: 'var(--color-accent)',
                        background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
                      }}
                    >
                      {t('settings.appearance.themeActive', 'Active')}
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-text-muted mt-1 leading-snug line-clamp-2">{theme.description}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.appearance.uiFont', 'Interface font')}</span>
          <select
            value={appearance.uiFont}
            onChange={(event) => onUpdate({ uiFont: event.target.value as UiFont })}
            className={inputCls}
          >
            {UI_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>{t('settings.appearance.monoFont', 'Monospace font')}</span>
          <select
            value={appearance.monoFont}
            onChange={(event) => onUpdate({ monoFont: event.target.value as MonoFont })}
            className={inputCls}
          >
            {MONO_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-2xl border border-border-subtle p-4 bg-base">
        <div className="text-[12px] font-semibold text-text mb-3">{t('settings.appearance.preview', 'Preview')}</div>
        <div className="rounded-xl border border-border-subtle bg-surface p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-text">{t('settings.appearance.previewHealth', 'Workspace health')}</div>
              <div className="text-[11px] text-text-muted">{t('settings.appearance.previewHealthDescription', 'Provider connected, runtime ready')}</div>
            </div>
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{
                color: 'var(--color-accent)',
                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
              }}
            >
              {t('settings.appearance.previewActive', 'Active')}
            </span>
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
