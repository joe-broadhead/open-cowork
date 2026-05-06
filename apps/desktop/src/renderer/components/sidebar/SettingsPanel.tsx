import { useMemo, useState, useEffect, useRef } from 'react'
import type {
  AutomationAutonomyPolicy,
  AutomationExecutionMode,
  EffectiveAppSettings,
  PublicAppConfig,
  SandboxCleanupResult,
  SandboxStorageStats,
} from '@open-cowork/shared'
import { getBuiltInLocales, getLocale, setLocale, t } from '../../helpers/i18n'
import {
  getAppearancePreferences,
  saveAppearancePreferences,
  type AppearancePreferences,
} from '../../helpers/theme'
import { mergeFetchedProviderCredentials, stripMaskedProviderCredentials } from '../provider/credential-merge'
import { ProviderAuthControls } from '../provider/ProviderAuthControls'
import { AppearancePreview } from './SettingsAppearancePanel'
import { StoragePanel } from './SettingsStoragePanel'

type SettingsTab = 'appearance' | 'models' | 'permissions' | 'automations' | 'storage'

const inputCls = 'w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors'
const sectionLabelCls = 'text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1'
const fieldLabelCls = 'text-[11px] text-text-muted font-medium'
const panelCardCls = 'rounded-2xl border border-border-subtle p-4 flex flex-col gap-4'

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
  onPersistSettings,
}: {
  config: PublicAppConfig
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
  updateProviderCredential: (providerId: string, key: string, value: string) => void
  onConfigRefreshed: (next: PublicAppConfig) => void
  onPersistSettings: () => Promise<boolean>
}) {
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = provider?.models || []
  const providerCredentials = settings.effectiveProviderId
    ? (settings.providerCredentials[settings.effectiveProviderId] || {})
    : {}

  const [modelQuery, setModelQuery] = useState('')
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null)
  const [signingOutGoogle, setSigningOutGoogle] = useState(false)

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

  const handleGoogleSignOut = async () => {
    setSigningOutGoogle(true)
    try {
      await window.coworkApi.auth.logout()
    } finally {
      setSigningOutGoogle(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {config.auth.enabled ? (
        <div className={panelCardCls}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[12px] font-semibold text-text">{t('settings.models.googleSignIn', 'Google sign-in')}</div>
              <div className="text-[11px] text-text-muted leading-relaxed mt-1">
                {t('settings.models.googleSignInDescription', 'Sign out to force a fresh Google consent flow when this build adds new Workspace or Gemini scopes.')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleGoogleSignOut()}
              disabled={signingOutGoogle}
              className="shrink-0 px-3 py-2 rounded-xl border border-border-subtle text-[12px] font-semibold text-text cursor-pointer transition-colors hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
            >
              {signingOutGoogle
                ? t('settings.models.signingOutGoogle', 'Signing out...')
                : t('settings.models.signOutGoogle', 'Sign out')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>{t('settings.models.provider', 'Provider')}</span>
        <div className="grid grid-cols-2 gap-3">
          {config.providers.available.map((entry) => {
            const nextModelId = entry.id === settings.effectiveProviderId
              ? settings.selectedModelId || settings.effectiveModel || entry.defaultModel || entry.models[0]?.id || ''
              : entry.defaultModel || entry.models[0]?.id || ''
            return (
              <button
                key={entry.id}
                onClick={() => update({
                  selectedProviderId: entry.id,
                  selectedModelId: nextModelId,
                  effectiveProviderId: entry.id,
                  effectiveModel: nextModelId,
                })}
                className="text-start rounded-2xl border p-3 transition-colors cursor-pointer"
                style={{
                  background: settings.effectiveProviderId === entry.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'var(--color-elevated)',
                  borderColor: settings.effectiveProviderId === entry.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                }}
              >
                <div className="text-[12px] font-semibold text-text">{entry.name}</div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                {typeof entry.connected === 'boolean' ? (
                  <div className="text-[10px] text-text-muted mt-2">
                    {entry.connected ? t('settings.models.connected', 'Signed in') : t('settings.models.notConnected', 'Not signed in')}
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      {provider ? (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>{t('settings.models.authentication', 'Authentication')}</span>
          <ProviderAuthControls
            providerId={provider.id}
            providerName={provider.name}
            connected={provider.connected}
            onBeforeAuthorize={onPersistSettings}
            onAuthUpdated={async () => {
              const nextConfig = await window.coworkApi.app.config()
              onConfigRefreshed(nextConfig)
              const refreshedProvider = nextConfig.providers.available.find((entry) => entry.id === provider.id) || null
              if (refreshedProvider?.defaultModel) {
                update({
                  selectedModelId: refreshedProvider.defaultModel,
                  effectiveModel: refreshedProvider.defaultModel,
                })
              }
            }}
          />

          {provider.credentials.length ? (
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
          ) : null}
        </div>
      ) : null}

      {provider && models.length === 0 && (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>{t('settings.models.model', 'Model')}</span>
          <input
            type="text"
            value={settings.effectiveModel || settings.selectedModelId || ''}
            onChange={(event) => update({ selectedModelId: event.target.value, effectiveModel: event.target.value })}
            placeholder={t('setup.modelIdPlaceholder', 'Model ID')}
            className={inputCls}
          />
          <span className="text-[10px] text-text-muted px-1">
            {t('setup.runtimeModelsHint', 'This provider uses OpenCode\'s live model catalog after the runtime starts.')}
          </span>
        </div>
      )}

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

    </div>
  )
}

function stripMaskedSettingsCredentials(settings: EffectiveAppSettings): EffectiveAppSettings {
  return {
    ...settings,
    providerCredentials: stripMaskedProviderCredentials(settings.providerCredentials),
    integrationCredentials: stripMaskedProviderCredentials(settings.integrationCredentials),
  }
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
          {
            key: 'runtimeToolingBridgeEnabled' as const,
            title: t('settings.permissions.toolingBridgeTitle', 'Developer config bridge'),
            description: t('settings.permissions.toolingBridgeDescription', 'Expose standard Git, SSH, package-manager, cloud, Docker, and Kubernetes config to the managed OpenCode runtime. Disable this for a stricter runtime HOME.'),
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

function AutomationSettingsPanel({
  settings,
  update,
}: {
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
}) {
  const toggles = [
    {
      key: 'automationLaunchAtLogin' as const,
      title: t('settings.automations.launchAtLoginTitle', 'Launch at login'),
      description: t('settings.automations.launchAtLoginDescription', 'Start Open Cowork automatically when you sign in so scheduled work can run without a manual app launch.'),
    },
    {
      key: 'automationRunInBackground' as const,
      title: t('settings.automations.runInBackgroundTitle', 'Run in background'),
      description: t('settings.automations.runInBackgroundDescription', 'Hide the window instead of quitting when you close it, so automations and scheduled work can keep running.'),
    },
    {
      key: 'automationDesktopNotifications' as const,
      title: t('settings.automations.notificationsTitle', 'Desktop notifications'),
      description: t('settings.automations.notificationsDescription', 'Show native notifications when an automation needs approval, asks for input, fails, or finishes a run.'),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>{t('settings.automations.header', 'Automation Preferences')}</span>
      <div className={panelCardCls}>
        {toggles.map((toggle) => {
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

      <span className={sectionLabelCls}>{t('settings.automations.defaultsHeader', 'Defaults')}</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.defaultAutonomy', 'Default autonomy')}</span>
            <select
              value={settings.defaultAutomationAutonomyPolicy}
              onChange={(event) => update({ defaultAutomationAutonomyPolicy: event.target.value as AutomationAutonomyPolicy })}
              className={inputCls}
            >
              <option value="review-first">{t('settings.automations.reviewFirst', 'Review first')}</option>
              <option value="mostly-autonomous">{t('settings.automations.mostlyAutonomous', 'Mostly autonomous')}</option>
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.defaultExecution', 'Default execution mode')}</span>
            <select
              value={settings.defaultAutomationExecutionMode}
              onChange={(event) => update({ defaultAutomationExecutionMode: event.target.value as AutomationExecutionMode })}
              className={inputCls}
            >
              <option value="planning_only">{t('settings.automations.planningOnly', 'Planning only')}</option>
              <option value="scoped_execution">{t('settings.automations.scopedExecution', 'Scoped execution')}</option>
            </select>
          </label>
        </div>
      </div>

      <span className={sectionLabelCls}>{t('settings.automations.quietHoursHeader', 'Quiet hours')}</span>
      <div className={panelCardCls}>
        <div className="text-[11px] text-text-muted">
          {t('settings.automations.quietHoursDescription', 'Desktop notifications are suppressed during this window. In-app inbox items and deliveries are still recorded.')}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.quietHoursStart', 'Start')}</span>
            <input
              type="time"
              value={settings.automationQuietHoursStart || ''}
              onChange={(event) => update({ automationQuietHoursStart: event.target.value || null })}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={fieldLabelCls}>{t('settings.automations.quietHoursEnd', 'End')}</span>
            <input
              type="time"
              value={settings.automationQuietHoursEnd || ''}
              onChange={(event) => update({ automationQuietHoursEnd: event.target.value || null })}
              className={inputCls}
            />
          </label>
        </div>
      </div>
    </div>
  )
}

function LanguagePicker() {
  const [current, setCurrent] = useState<string>(() => getLocale() || '')
  const options = getBuiltInLocales()

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value || null
    void setLocale(value)
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

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<EffectiveAppSettings | null>(null)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [appearance, setAppearance] = useState<AppearancePreferences>(getAppearancePreferences())
  const [storageStats, setStorageStats] = useState<SandboxStorageStats | null>(null)
  const [runningCleanup, setRunningCleanup] = useState<SandboxCleanupResult['mode'] | null>(null)
  const [lastCleanup, setLastCleanup] = useState<SandboxCleanupResult | null>(null)
  const dirtyProviderCredentialKeys = useRef<Record<string, Set<string>>>({})

  const markProviderCredentialDirty = (providerId: string, key: string) => {
    const keys = dirtyProviderCredentialKeys.current[providerId] || new Set<string>()
    keys.add(key)
    dirtyProviderCredentialKeys.current[providerId] = keys
  }

  useEffect(() => {
    // Fast close-reopen cycles can land these resolves into an unmounted
    // component; guard with a cancelled flag so we don't setState on a
    // disposed instance. The default settings load is masked; the Models
    // tab fetches only the active provider's real credential bag below.
    let cancelled = false
    Promise.all([window.coworkApi.settings.get(), window.coworkApi.app.config(), window.coworkApi.artifact.storageStats()])
      .then(([nextSettings, nextConfig, nextStorage]) => {
        if (cancelled) return
        setSettings(stripMaskedSettingsCredentials(nextSettings))
        setConfig(nextConfig)
        setStorageStats(nextStorage)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load settings panel:', err)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const providerId = settings?.effectiveProviderId
    if (!providerId) return
    let cancelled = false
    window.coworkApi.settings.getProviderCredentials(providerId).then((credentials) => {
      if (cancelled) return
      setSettings((current) => {
        if (!current || current.effectiveProviderId !== providerId) return current
        return {
          ...current,
          providerCredentials: {
            ...current.providerCredentials,
            [providerId]: mergeFetchedProviderCredentials(
              current.providerCredentials[providerId],
              credentials,
              dirtyProviderCredentialKeys.current[providerId],
            ),
          },
        }
      })
    }).catch((err) => {
      console.error('Failed to load provider credentials:', err)
    })
    return () => { cancelled = true }
  }, [settings?.effectiveProviderId])

  const tabs = useMemo(
    () => [
        { id: 'appearance' as const, label: t('settings.tab.appearance', 'Appearance'), description: t('settings.tab.appearanceDescription', 'Theme, color scheme, and fonts') },
        { id: 'models' as const, label: t('settings.tab.models', 'Models'), description: t('settings.tab.modelsDescription', 'Provider, model, and credentials') },
        { id: 'permissions' as const, label: t('settings.tab.permissions', 'Permissions'), description: t('settings.tab.permissionsDescription', 'Local tool access') },
        { id: 'automations' as const, label: t('settings.tab.automations', 'Automations'), description: t('settings.tab.automationsDescription', 'Schedule, notifications, and defaults') },
        { id: 'storage' as const, label: t('settings.tab.storage', 'Storage'), description: t('settings.tab.storageDescription', 'Sandbox artifacts and cleanup') },
      ],
    [],
  )

  const persistSettings = async (options: { showSaved?: boolean } = {}) => {
    if (!settings) return false
    const { showSaved = true } = options
    setSaveError(null)
    try {
      const savedSettings = await window.coworkApi.settings.set({
        selectedProviderId: settings.selectedProviderId,
        selectedModelId: settings.selectedModelId,
        providerCredentials: settings.providerCredentials,
        integrationCredentials: settings.integrationCredentials,
        enableBash: settings.enableBash,
        enableFileWrite: settings.enableFileWrite,
        runtimeToolingBridgeEnabled: settings.runtimeToolingBridgeEnabled,
        automationLaunchAtLogin: settings.automationLaunchAtLogin,
        automationRunInBackground: settings.automationRunInBackground,
        automationDesktopNotifications: settings.automationDesktopNotifications,
        automationQuietHoursStart: settings.automationQuietHoursStart,
        automationQuietHoursEnd: settings.automationQuietHoursEnd,
        defaultAutomationAutonomyPolicy: settings.defaultAutomationAutonomyPolicy,
        defaultAutomationExecutionMode: settings.defaultAutomationExecutionMode,
      })
      dirtyProviderCredentialKeys.current = {}
      let next = savedSettings
      if (savedSettings.effectiveProviderId) {
        try {
          next = {
            ...savedSettings,
            providerCredentials: {
              ...savedSettings.providerCredentials,
              [savedSettings.effectiveProviderId]: await window.coworkApi.settings.getProviderCredentials(savedSettings.effectiveProviderId),
            },
          }
        } catch (error) {
          console.error('Failed to reload provider credentials after saving settings:', error)
        }
      }
      setSettings(next)
      if (showSaved) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const handleSave = async () => {
    await persistSettings()
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
    markProviderCredentialDirty(providerId, key)
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
                onPersistSettings={() => persistSettings({ showSaved: false })}
              />
            )}
            {tab === 'permissions' && (
              <PermissionsPanel settings={settings} update={update} />
            )}
            {tab === 'automations' && (
              <AutomationSettingsPanel settings={settings} update={update} />
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
            <div className="text-[11px]">
              <div className="text-text-muted">
                {t('settings.saveHint', 'Appearance changes apply immediately. Provider and permission changes restart the runtime when needed.')}
              </div>
              {saveError ? (
                <div className="mt-1" style={{ color: 'var(--color-red)' }}>
                  {saveError}
                </div>
              ) : null}
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
