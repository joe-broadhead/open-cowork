import { useMemo, useState, useEffect } from 'react'
import type { EffectiveAppSettings, PublicAppConfig, SandboxCleanupResult, SandboxStorageStats } from '@open-cowork/shared'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import {
  getAppearancePreferences,
  getThemeTokens,
  getUiThemeOptions,
  MONO_FONT_OPTIONS,
  saveAppearancePreferences,
  type AppearancePreferences,
  type ColorScheme,
  type MonoFont,
  type UiFont,
  type UiTheme,
  UI_FONT_OPTIONS,
} from '../../helpers/theme'

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

function StorageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-[13px] font-medium text-text">{value}</div>
    </div>
  )
}

type SettingsTab = 'appearance' | 'models' | 'permissions' | 'storage'

const inputCls = 'w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors'
const sectionLabelCls = 'text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1'
const fieldLabelCls = 'text-[11px] text-text-muted font-medium'
const panelCardCls = 'rounded-2xl border border-border-subtle p-4 flex flex-col gap-4'

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function AppearancePreview({
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

// Above this many models we flip to the searchable list view so the picker
// stays usable when a dynamic catalog (e.g. OpenRouter ~300 models) is
// overlaid on top of the hardcoded featured set. Below, the grid is fine.
const MODEL_LIST_THRESHOLD = 20

function formatContextLength(tokens?: number): string | null {
  if (!tokens || !Number.isFinite(tokens)) return null
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`
  return `${tokens} ctx`
}

function ModelsPanel({
  config,
  settings,
  update,
  updateProviderCredential,
  onConfigRefreshed,
}: {
  config: PublicAppConfig
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
  updateProviderCredential: (providerId: string, key: string, value: string) => void
  onConfigRefreshed: (next: PublicAppConfig) => void
}) {
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = provider?.models || []
  const providerCredentials = settings.effectiveProviderId
    ? (settings.providerCredentials[settings.effectiveProviderId] || {})
    : {}

  const [modelQuery, setModelQuery] = useState('')
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null)

  // Clear the search field when the user switches providers — leftover
  // queries from a different catalog are confusing.
  useEffect(() => { setModelQuery('') }, [settings.effectiveProviderId])

  const useListView = models.length > MODEL_LIST_THRESHOLD
  const hasFeatured = models.some((model) => model.featured)
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    if (!query) return models
    return models.filter((model) => {
      const haystack = `${model.id} ${model.name} ${model.description || ''}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [models, modelQuery])

  const handleRefreshCatalog = async () => {
    if (!provider) return
    setRefreshingProviderId(provider.id)
    try {
      await window.coworkApi.app.refreshProviderCatalog(provider.id)
      const next = await window.coworkApi.app.config()
      onConfigRefreshed(next)
    } finally {
      setRefreshingProviderId(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.models.provider', 'Provider')}</span>
        <div className="grid grid-cols-2 gap-3">
          {config.providers.available.map((entry) => (
            <button
              key={entry.id}
              onClick={() => update({
                selectedProviderId: entry.id,
                selectedModelId: entry.models[0]?.id || settings.selectedModelId,
                effectiveProviderId: entry.id,
                effectiveModel: entry.models[0]?.id || settings.effectiveModel,
              })}
              className="text-start rounded-2xl border p-3 transition-colors cursor-pointer"
              style={{
                background: settings.effectiveProviderId === entry.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'var(--color-elevated)',
                borderColor: settings.effectiveProviderId === entry.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
              }}
            >
              <div className="text-[12px] font-semibold text-text">{entry.name}</div>
              <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
            </button>
          ))}
        </div>
      </div>

      {models.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className={sectionLabelCls}>
              {t('settings.models.model', 'Model')}
              <span className="ms-2 text-text-muted font-normal">
                {filteredModels.length === models.length
                  ? `${models.length}`
                  : `${filteredModels.length} / ${models.length}`}
              </span>
            </span>
            <button
              type="button"
              onClick={handleRefreshCatalog}
              disabled={refreshingProviderId === provider?.id}
              className="text-[11px] px-2 py-1 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              title={t('settings.models.refreshTitle', 'Refresh the dynamic model catalog')}
            >
              {refreshingProviderId === provider?.id ? t('settings.models.refreshing', 'Refreshing…') : t('settings.models.refresh', 'Refresh')}
            </button>
          </div>
          {useListView && (
            <input
              type="text"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder={t('settings.models.search', 'Search {{count}} models…', { count: String(models.length) })}
              className={inputCls}
            />
          )}
          {useListView ? (
            <div className="rounded-2xl border border-border-subtle overflow-hidden max-h-[420px] overflow-y-auto">
              {filteredModels.length === 0 ? (
                <div className="px-3 py-6 text-[12px] text-text-muted text-center">{t('settings.models.noMatches', 'No models match this search.')}</div>
              ) : (
                filteredModels.map((model, index) => {
                  const isActive = settings.effectiveModel === model.id
                  const showFeaturedBoundary =
                    hasFeatured && index > 0 && filteredModels[index - 1].featured && !model.featured
                  return (
                    <div key={model.id}>
                      {showFeaturedBoundary && (
                        <div className="px-3 py-1 text-[10px] uppercase tracking-[0.08em] text-text-muted bg-surface-hover">
                          {t('settings.models.allModels', 'All models')}
                        </div>
                      )}
                      <button
                        onClick={() => update({ selectedModelId: model.id, effectiveModel: model.id })}
                        className="w-full text-start px-3 py-2 border-b border-border-subtle last:border-b-0 cursor-pointer transition-colors"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                        }}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12px] font-medium text-text truncate">{model.name}</span>
                          {model.featured && (
                            <span
                              className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                              style={{
                                color: 'var(--color-accent)',
                                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                              }}
                            >
                              {t('settings.models.featured', 'Featured')}
                            </span>
                          )}
                          {formatContextLength(model.contextLength) && (
                            <span className="shrink-0 text-[10px] text-text-muted">
                              {formatContextLength(model.contextLength)}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-muted font-mono truncate">{model.id}</div>
                        {model.description && (
                          <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{model.description}</div>
                        )}
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredModels.map((model) => (
                <button
                  key={model.id}
                  onClick={() => update({ selectedModelId: model.id, effectiveModel: model.id })}
                  className="rounded-2xl border px-3 py-3 text-start transition-colors cursor-pointer"
                  style={{
                    background: settings.effectiveModel === model.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'var(--color-elevated)',
                    borderColor: settings.effectiveModel === model.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                  }}
                >
                  <div className="text-[12px] font-semibold text-text">{model.name}</div>
                  {model.description ? <div className="text-[11px] text-text-muted mt-1">{model.description}</div> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {provider?.credentials.length ? (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>{t('settings.models.credentialsHeader', 'Credentials')}</span>
          <div className={panelCardCls}>
            {provider.credentials.map((credential) => (
              <label key={credential.key} className="flex flex-col gap-1.5">
                <span className={fieldLabelCls}>{credential.label}</span>
                <input
                  type={credential.secret ? 'password' : 'text'}
                  value={providerCredentials[credential.key] || ''}
                  onChange={(event) => updateProviderCredential(provider.id, credential.key, event.target.value)}
                  placeholder={credential.placeholder}
                  className={inputCls}
                />
                <span className="text-[10px] text-text-muted">{credential.description}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PermissionsPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.permissions.header', 'Developer Tools')}</span>
      <div className={panelCardCls}>
        {[
          {
            key: 'enableBash' as const,
            title: t('settings.permissions.bashTitle', 'Shell commands'),
            description: t('settings.permissions.bashDescription', 'Allow agents to run terminal commands inside the active workspace.'),
          },
          {
            key: 'enableFileWrite' as const,
            title: t('settings.permissions.fileWriteTitle', 'File editing'),
            description: t('settings.permissions.fileWriteDescription', 'Allow agents to create and modify files in the local workspace.'),
          },
        ].map((toggle) => {
          const enabled = settings[toggle.key]
          return (
            <div key={toggle.key} className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[12px] font-semibold text-text">{toggle.title}</div>
                <div className="text-[11px] text-text-muted mt-1">{toggle.description}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={toggle.title}
                onClick={() => update({ [toggle.key]: !enabled } as Partial<EffectiveAppSettings>)}
                className="w-10 h-5 rounded-full transition-colors relative shrink-0 cursor-pointer"
                style={{ background: enabled ? 'var(--color-accent)' : 'var(--color-border)' }}
              >
                <div
                  className="w-3.5 h-3.5 rounded-full absolute top-[3px] transition-all border border-border-subtle"
                  style={{
                    left: enabled ? 20 : 3,
                    background: 'color-mix(in srgb, var(--color-elevated) 92%, var(--color-base) 8%)',
                  }}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; current: string; latest: string; url: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'error'; message: string }

function LanguagePicker() {
  const [current, setCurrent] = useState<string>(() => getLocale() || '')
  const options = getBuiltInLocales()

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value || null
    setLocale(value)
    setCurrent(value || getLocale() || '')
    // Previously we called window.location.reload() here to refresh
    // every surface, but that collapsed the Settings panel before the
    // user could click Save on unrelated changes (provider, model,
    // permissions). Instead, `setLocale` fans out via `subscribeLocale`
    // → App.tsx bumps a `localeVersion` key on the root element →
    // React remounts the tree with the new catalog + Intl formatters
    // already in place. Zustand session state lives outside React so
    // no threads, scroll position, or draft settings are lost.
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

function StoragePanel({
  stats,
  runningCleanup,
  lastCleanup,
  onCleanup,
}: {
  stats: SandboxStorageStats | null
  runningCleanup: SandboxCleanupResult['mode'] | null
  lastCleanup: SandboxCleanupResult | null
  onCleanup: (mode: SandboxCleanupResult['mode']) => Promise<void>
}) {
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<'idle' | 'working' | 'copied' | 'error'>('idle')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [resetting, setResetting] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  // Resolve the current build's version on mount so we can surface it
  // next to the update-check button before the user clicks. Uses the
  // existing checkUpdates IPC — the endpoint returns `currentVersion`
  // regardless of the status branch, so this is a free piggyback.
  useEffect(() => {
    let cancelled = false
    window.coworkApi.app.checkUpdates()
      .then((result) => {
        if (cancelled) return
        if ('currentVersion' in result) setCurrentVersion(result.currentVersion)
      })
      .catch(() => { /* offline check is best-effort — version stays null */ })
    return () => { cancelled = true }
  }, [])

  const handleCheckForUpdates = async () => {
    setUpdateStatus({ kind: 'checking' })
    try {
      const result = await window.coworkApi.app.checkUpdates()
      if (result.status === 'disabled') {
        setUpdateStatus({ kind: 'disabled', message: result.message })
      } else if (result.status === 'error') {
        setUpdateStatus({ kind: 'error', message: result.message })
      } else if (result.hasUpdate) {
        setUpdateStatus({ kind: 'available', current: result.currentVersion, latest: result.latestVersion, url: result.releaseUrl })
      } else {
        setUpdateStatus({ kind: 'current', version: result.currentVersion })
      }
    } catch (err) {
      setUpdateStatus({ kind: 'error', message: err instanceof Error ? err.message : t('settings.updates.checkFailedGeneric', 'Failed to check for updates.') })
    }
  }

  const handleResetAppData = async () => {
    const { confirmAppReset } = await import('../../helpers/destructive-actions')
    const confirmation = await confirmAppReset()
    if (!confirmation) return
    setResetting(true)
    try {
      await window.coworkApi.app.reset(confirmation.token)
      // The main process relaunches the app itself; this line usually
      // won't execute. Falling through lands in resetting=true which
      // disables the button until the relaunch lands.
    } catch (err) {
      setResetting(false)
      const message = err instanceof Error ? err.message : t('settings.updates.resetCheckLogs', 'Reset failed. Check the logs.')
      window.alert(t('settings.updates.resetFailed', 'Could not reset app data: {{message}}', { message }))
    }
  }

  const handleExportDiagnostics = async () => {
    setDiagnosticsStatus('working')
    try {
      const bundle = await window.coworkApi.app.exportDiagnostics()
      if (!bundle) {
        setDiagnosticsStatus('error')
        return
      }
      await navigator.clipboard.writeText(bundle)
      setDiagnosticsStatus('copied')
      setTimeout(() => setDiagnosticsStatus('idle'), 3_000)
    } catch (err) {
      console.error('Failed to export diagnostics:', err)
      setDiagnosticsStatus('error')
      setTimeout(() => setDiagnosticsStatus('idle'), 3_000)
    }
  }

  if (!stats) {
    return (
      <div className={panelCardCls}>
        <div className="text-[12px] text-text-muted">{t('settings.storage.loading', 'Loading sandbox storage…')}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-text">{t('settings.storage.supportDiagnostics', 'Support Diagnostics')}</div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.storage.supportDescription', "Copies a plaintext report (config, runtime inputs, recent log lines) to your clipboard. Credentials are masked / redacted so it's safe to paste into a bug report.")}
        </div>
        <button
          onClick={() => void handleExportDiagnostics()}
          disabled={diagnosticsStatus === 'working'}
          className="w-full rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait text-start"
        >
          <div className="text-[12px] font-semibold text-text">
            {diagnosticsStatus === 'working'
              ? t('settings.storage.preparing', 'Preparing…')
              : diagnosticsStatus === 'copied'
                ? t('settings.storage.copied', 'Copied to clipboard')
                : diagnosticsStatus === 'error'
                  ? t('settings.storage.copyFailed', 'Could not build diagnostics — try again')
                  : t('settings.storage.copyDiagnostics', 'Copy diagnostics to clipboard')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t('settings.storage.diagnosticsHint', 'Useful when filing an issue — include this bundle in your report.')}
          </div>
        </button>
      </div>

      <span className={sectionLabelCls}>{t('settings.storage.sandboxStorage', 'Sandbox Storage')}</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-3">
          <StorageStat label={t('settings.storage.totalSize', 'Total Size')} value={formatBytes(stats.totalBytes)} />
          <StorageStat label={t('settings.storage.workspaces', 'Workspaces')} value={String(stats.workspaceCount)} />
          <StorageStat label={t('settings.storage.referenced', 'Referenced')} value={String(stats.referencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.unreferenced', 'Unreferenced')} value={String(stats.unreferencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.stale', 'Stale')} value={String(stats.staleWorkspaceCount)} />
          <StorageStat label={t('settings.storage.retention', 'Retention')} value={t('settings.storage.retentionDays', '{{days}} days', { days: String(stats.staleThresholdDays) })} />
        </div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.storage.sandboxNote', 'Sandbox threads write into a private Cowork workspace under {{root}}. Older unreferenced workspaces are pruned automatically, and you can run cleanup manually here.', { root: stats.root })}
        </div>
      </div>

      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-text">{t('settings.storage.cleanup', 'Cleanup')}</div>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => void onCleanup('old-unreferenced')}
            className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'old-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearOld', 'Clear old sandbox artifacts')}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.storage.clearOldDescription', 'Removes unreferenced sandbox workspaces older than {{days}} days.', { days: String(stats.staleThresholdDays) })}
            </div>
          </button>

          <button
            onClick={() => void onCleanup('all-unreferenced')}
            className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'all-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearAll', 'Clear all unused sandbox artifacts')}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.storage.clearAllDescription', 'Removes every unreferenced sandbox workspace while keeping active thread workspaces intact.')}
            </div>
          </button>
        </div>

        {lastCleanup ? (
          <div className="rounded-xl border border-border-subtle bg-base px-3 py-3 text-[11px] text-text-muted">
            {t('settings.storage.lastCleanup', 'Last cleanup removed {{count}} workspace(s) and freed {{size}}.', {
              count: String(lastCleanup.removedWorkspaces),
              size: formatBytes(lastCleanup.removedBytes),
            })}
          </div>
        ) : null}
      </div>

      <span className={sectionLabelCls}>{t('settings.updates.header', 'Updates')}</span>
      <div className={panelCardCls}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] font-semibold text-text">{t('settings.updates.checkForUpdates', 'Check for updates')}</div>
          {currentVersion ? (
            <div className="text-[10px] text-text-muted font-mono">v{currentVersion}</div>
          ) : null}
        </div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.updates.description', "Queries the public GitHub Releases API for the latest published version. Read-only — there's no auto-download or auto-install.")}
        </div>
        <button
          onClick={() => void handleCheckForUpdates()}
          disabled={updateStatus.kind === 'checking'}
          className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
        >
          <div className="text-[12px] font-semibold text-text">
            {updateStatus.kind === 'checking' ? t('settings.updates.checking', 'Checking…')
              : updateStatus.kind === 'available' ? t('settings.updates.newAvailable', 'New version available: {{version}}', { version: updateStatus.latest })
                : updateStatus.kind === 'current' ? t('settings.updates.upToDate', 'You\u2019re on the latest version ({{version}})', { version: updateStatus.version })
                  : updateStatus.kind === 'disabled' ? t('settings.updates.unavailable', 'Update check unavailable')
                    : updateStatus.kind === 'error' ? t('settings.updates.failed', 'Could not check for updates')
                      : t('settings.updates.checkForUpdates', 'Check for updates')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {updateStatus.kind === 'available' ? t('settings.updates.currentHint', 'You\u2019re on {{version}}. Click below to open the release notes.', { version: updateStatus.current })
              : updateStatus.kind === 'disabled' ? updateStatus.message
                : updateStatus.kind === 'error' ? updateStatus.message
                  : t('settings.updates.hint', 'Opens the GitHub release page if a newer build is available.')}
          </div>
        </button>
        {updateStatus.kind === 'available' ? (
          <a
            href={updateStatus.url}
            onClick={(event) => {
              event.preventDefault()
              void window.coworkApi.dialog // kept in scope only for type hint
              // Use a custom protocol-less href so Electron routes via
              // shell.openExternal instead of trying to navigate the
              // renderer. The click handler is a safety net if the
              // default anchor behavior would try to replace the page.
              const targetHref = updateStatus.url
              try {
                // Electron's open-external is exposed through a menu
                // click path normally — here we fall back to
                // window.open which Electron re-routes through
                // setWindowOpenHandler → shell.openExternal.
                window.open(targetHref, '_blank')
              } catch {
                /* no-op */
              }
            }}
            className="w-full text-center rounded-2xl border border-accent/40 p-3 text-[12px] font-semibold text-accent hover:bg-surface-hover cursor-pointer"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('settings.updates.openReleaseNotes', 'Open release notes')}
          </a>
        ) : null}
      </div>

      <span className={sectionLabelCls}>{t('settings.reset.header', 'Reset')}</span>
      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-red">{t('settings.reset.title', 'Reset all app data')}</div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.reset.description', 'Deletes every thread, credential, custom agent, skill, and MCP from this machine. The app relaunches into the first-run flow. Useful before uninstalling or for a clean-slate downstream demo; destructive and cannot be undone.')}
        </div>
        <button
          onClick={() => void handleResetAppData()}
          disabled={resetting}
          className="w-full text-start rounded-2xl border p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-red) 40%, var(--color-border-subtle))',
            background: 'color-mix(in srgb, var(--color-red) 6%, transparent)',
          }}
        >
          <div className="text-[12px] font-semibold" style={{ color: 'var(--color-red)' }}>
            {resetting ? t('settings.reset.resetting', 'Resetting\u2026') : t('settings.reset.button', 'Reset app data')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t('settings.reset.requiresConfirm', 'Requires explicit confirmation. The app will close and relaunch.')}
          </div>
        </button>
      </div>
    </div>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<EffectiveAppSettings | null>(null)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [appearance, setAppearance] = useState<AppearancePreferences>(getAppearancePreferences())
  const [storageStats, setStorageStats] = useState<SandboxStorageStats | null>(null)
  const [runningCleanup, setRunningCleanup] = useState<SandboxCleanupResult['mode'] | null>(null)
  const [lastCleanup, setLastCleanup] = useState<SandboxCleanupResult | null>(null)

  useEffect(() => {
    // Fast close-reopen cycles can land these resolves into an unmounted
    // component; guard with a cancelled flag so we don't setState on a
    // disposed instance. Uses getWithCredentials because the Models tab
    // edits the API-key form — a masked load would overwrite real keys
    // with the sentinel on save.
    let cancelled = false
    Promise.all([window.coworkApi.settings.getWithCredentials(), window.coworkApi.app.config(), window.coworkApi.artifact.storageStats()])
      .then(([nextSettings, nextConfig, nextStorage]) => {
        if (cancelled) return
        setSettings(nextSettings)
        setConfig(nextConfig)
        setStorageStats(nextStorage)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load settings panel:', err)
      })
    return () => { cancelled = true }
  }, [])

  const tabs = useMemo(
    () => [
        { id: 'appearance' as const, label: t('settings.tab.appearance', 'Appearance'), description: t('settings.tab.appearanceDescription', 'Theme, color scheme, and fonts') },
        { id: 'models' as const, label: t('settings.tab.models', 'Models'), description: t('settings.tab.modelsDescription', 'Provider, model, and credentials') },
        { id: 'permissions' as const, label: t('settings.tab.permissions', 'Permissions'), description: t('settings.tab.permissionsDescription', 'Local tool access') },
        { id: 'storage' as const, label: t('settings.tab.storage', 'Storage'), description: t('settings.tab.storageDescription', 'Sandbox artifacts and cleanup') },
      ],
    [],
  )

  const handleSave = async () => {
    if (!settings) return
    const next = await window.coworkApi.settings.set({
      selectedProviderId: settings.selectedProviderId,
      selectedModelId: settings.selectedModelId,
      providerCredentials: settings.providerCredentials,
      integrationCredentials: settings.integrationCredentials,
      enableBash: settings.enableBash,
      enableFileWrite: settings.enableFileWrite,
    })
    setSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (patch: Partial<EffectiveAppSettings>) => {
    setSettings((current) => current ? ({ ...current, ...patch }) : current)
  }

  const updateAppearance = (patch: Partial<AppearancePreferences>) => {
    const next = saveAppearancePreferences(patch)
    setAppearance(next)
  }

  const runCleanup = async (mode: SandboxCleanupResult['mode']) => {
    try {
      setRunningCleanup(mode)
      const result = await window.coworkApi.artifact.cleanup(mode)
      setLastCleanup(result)
      setStorageStats(await window.coworkApi.artifact.storageStats())
    } finally {
      setRunningCleanup(null)
    }
  }

  const updateProviderCredential = (providerId: string, key: string, value: string) => {
    setSettings((current) => {
      if (!current) return current
      return {
        ...current,
        providerCredentials: {
          ...current.providerCredentials,
          [providerId]: {
            ...(current.providerCredentials[providerId] || {}),
            [key]: value,
          },
        },
      }
    })
  }

  if (!settings || !config) return null

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <div>
          <div className="text-[14px] font-semibold text-text">{t('settings.title', 'Settings')}</div>
          <div className="text-[11px] text-text-muted mt-0.5">{t('settings.subtitle', 'Tune the shell, model runtime, and local permissions.')}</div>
        </div>
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer transition-colors">{t('settings.done', 'Done')}</button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[190px] shrink-0 border-e border-border-subtle px-3 py-4 flex flex-col gap-2">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className="text-start rounded-2xl px-3 py-3 transition-colors cursor-pointer"
              style={{
                background: tab === entry.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                border: `1px solid ${tab === entry.id ? 'var(--color-accent)' : 'transparent'}`,
              }}
            >
              <div className="text-[12px] font-semibold text-text">{entry.label}</div>
              <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {tab === 'appearance' && (
              <div className="flex flex-col gap-5">
                <AppearancePreview appearance={appearance} onUpdate={updateAppearance} />
                <LanguagePicker />
              </div>
            )}
            {tab === 'models' && (
              <ModelsPanel
                config={config}
                settings={settings}
                update={update}
                updateProviderCredential={updateProviderCredential}
                onConfigRefreshed={setConfig}
              />
            )}
            {tab === 'permissions' && (
              <PermissionsPanel settings={settings} update={update} />
            )}
            {tab === 'storage' && (
              <StoragePanel
                stats={storageStats}
                runningCleanup={runningCleanup}
                lastCleanup={lastCleanup}
                onCleanup={runCleanup}
              />
            )}
          </div>

          <div className="px-5 py-4 border-t border-border-subtle flex items-center justify-between gap-4">
            <div className="text-[11px] text-text-muted">
              {t('settings.saveHint', 'Appearance changes apply immediately. Provider and permission changes restart the runtime when needed.')}
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-all"
              style={{
                background: saved ? 'color-mix(in srgb, var(--color-green) 15%, transparent)' : 'var(--color-accent)',
                color: saved ? 'var(--color-green)' : 'var(--color-accent-foreground)',
              }}
            >
              {saved ? t('settings.saved', '✓ Saved') : t('settings.saveChanges', 'Save Changes')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
