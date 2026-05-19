import { useMemo, useState, useEffect, useRef } from 'react'
import type {
  EffectiveAppSettings,
  PublicAppConfig,
  SandboxCleanupResult,
  SandboxStorageStats,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  getAppearancePreferences,
  saveAppearancePreferences,
  type AppearancePreferences,
} from '../../helpers/theme'
import { useSessionStore } from '../../stores/session'
import { mergeFetchedProviderCredentials, stripMaskedProviderCredentials } from '../provider/credential-merge'
import { AppearancePreview } from './SettingsAppearancePanel'
import { WorkflowSettingsPanel } from './SettingsWorkflowsPanel'
import { LanguagePicker } from './SettingsLanguagePicker'
import { ModelsPanel } from './SettingsModelsPanel'
import { PermissionsPanel } from './SettingsPermissionsPanel'
import { StoragePanel } from './SettingsStoragePanel'

type SettingsTab = 'appearance' | 'models' | 'permissions' | 'workflows' | 'storage'

function describeSettingsPanelError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportSettingsPanelError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describeSettingsPanelError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'settings',
    })
  } catch {
    // Diagnostics are best-effort from a settings recovery path.
  }
}

function stripMaskedSettingsCredentials(settings: EffectiveAppSettings): EffectiveAppSettings {
  return {
    ...settings,
    providerCredentials: stripMaskedProviderCredentials(settings.providerCredentials),
    integrationCredentials: stripMaskedProviderCredentials(settings.integrationCredentials),
  }
}

export function SettingsPanel({
  onClose,
}: {
  onClose: () => void
}) {
  const [settings, setSettings] = useState<EffectiveAppSettings | null>(null)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const [appearance, setAppearance] = useState<AppearancePreferences>(getAppearancePreferences())
  const [storageStats, setStorageStats] = useState<SandboxStorageStats | null>(null)
  const [runningCleanup, setRunningCleanup] = useState<SandboxCleanupResult['mode'] | null>(null)
  const [lastCleanup, setLastCleanup] = useState<SandboxCleanupResult | null>(null)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const dirtyProviderCredentialKeys = useRef<Record<string, Set<string>>>({})
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    Promise.all([
      window.coworkApi.settings.get(),
      window.coworkApi.app.config(),
      window.coworkApi.artifact.storageStats(),
    ])
      .then(([nextSettings, nextConfig, nextStorage]) => {
        if (cancelled) return
        setSettings(stripMaskedSettingsCredentials(nextSettings))
        setConfig(nextConfig)
        setStorageStats(nextStorage)
      })
      .catch((err) => {
        if (cancelled) return
        addGlobalError(t('settings.loadFailed', 'Could not load settings. Please try again.'))
        reportSettingsPanelError(err, 'Failed to load settings panel')
      })
    return () => { cancelled = true }
  }, [addGlobalError])

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
      if (cancelled) return
      addGlobalError(t('settings.providerCredentialsLoadFailed', 'Could not load provider credentials. Please try again.'))
      reportSettingsPanelError(err, `Failed to load provider credentials for ${providerId}`)
    })
    return () => { cancelled = true }
  }, [addGlobalError, settings?.effectiveProviderId])

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current)
        savedTimerRef.current = null
      }
    }
  }, [])

  const tabs = useMemo(
    () => [
        { id: 'appearance' as const, label: t('settings.tab.appearance', 'Appearance'), description: t('settings.tab.appearanceDescription', 'Theme, color scheme, and fonts') },
        { id: 'models' as const, label: t('settings.tab.models', 'Models'), description: t('settings.tab.modelsDescription', 'Provider, model, and credentials') },
        { id: 'permissions' as const, label: t('settings.tab.permissions', 'Permissions'), description: t('settings.tab.permissionsDescription', 'Local tool access') },
        { id: 'workflows' as const, label: t('settings.tab.workflows', 'Workflows'), description: t('settings.tab.workflowsDescription', 'Run behavior and notifications') },
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
        selectedSmallModelId: settings.selectedSmallModelId ?? null,
        providerCredentials: settings.providerCredentials,
        integrationCredentials: settings.integrationCredentials,
        bashPermission: settings.bashPermission,
        fileWritePermission: settings.fileWritePermission,
        enableBash: settings.enableBash,
        enableFileWrite: settings.enableFileWrite,
        runtimeConfigSource: settings.runtimeConfigSource,
        runtimeToolingBridgeEnabled: settings.runtimeToolingBridgeEnabled,
        workflowLaunchAtLogin: settings.workflowLaunchAtLogin,
        workflowRunInBackground: settings.workflowRunInBackground,
        workflowDesktopNotifications: settings.workflowDesktopNotifications,
        workflowQuietHoursStart: settings.workflowQuietHoursStart,
        workflowQuietHoursEnd: settings.workflowQuietHoursEnd,
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
          addGlobalError(t('settings.providerCredentialsReloadFailed', 'Settings saved, but provider credentials could not be reloaded. Please reopen Settings.'))
          reportSettingsPanelError(error, `Failed to reload provider credentials after saving settings for ${savedSettings.effectiveProviderId}`)
        }
      }
      setSettings(next)
      if (showSaved) {
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => {
          setSaved(false)
          savedTimerRef.current = null
        }, 2000)
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
              <PermissionsPanel permissions={config.permissions} settings={settings} update={update} />
            )}
            {tab === 'workflows' && (
              <WorkflowSettingsPanel settings={settings} update={update} />
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
