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
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { mergeFetchedProviderCredentials, stripMaskedProviderCredentials } from '../provider/credential-merge'
import { Badge, Button, Dialog, Input, Skeleton } from '../ui'
import { AppearancePreview } from './SettingsAppearancePanel'
import { WorkflowSettingsPanel } from './SettingsWorkflowsPanel'
import { LanguagePicker } from './SettingsLanguagePicker'
import { ModelsPanel } from './SettingsModelsPanel'
import { PermissionsPanel, RuntimeConfigPanel } from './SettingsPermissionsPanel'
import { StoragePanel } from './SettingsStoragePanel'
import { SettingsPairingPanel } from './SettingsPairingPanel'

type SettingsTab = 'appearance' | 'model' | 'advanced' | 'permissions' | 'workflows' | 'storage' | 'pairing'
type SettingsSearchEntry = {
  id: string
  tab: SettingsTab
  label: string
  keywords: string
}

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

function CloudModelsPolicyPanel({ settings }: { settings: EffectiveAppSettings }) {
  const provider = settings.effectiveProviderId || settings.selectedProviderId || 'Profile default'
  const model = settings.effectiveModel || settings.selectedModelId || 'Profile default'
  const smallModel = settings.effectiveSmallModel || settings.selectedSmallModelId || 'Profile default'
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
        <div className="text-[12px] font-semibold text-text">{t('settings.cloudModels.title', 'Cloud profile runtime')}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
          {t('settings.cloudModels.description', 'This cloud workspace resolves providers, models, credentials, and runtime config through its cloud profile. Desktop shows policy-managed metadata only and never receives raw provider keys.')}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: t('settings.cloudModels.provider', 'Provider'), value: provider },
          { label: t('settings.cloudModels.model', 'Model'), value: model },
          { label: t('settings.cloudModels.smallModel', 'Small model'), value: smallModel },
        ].map((entry) => (
          <div key={entry.label} className="rounded-2xl border border-border-subtle bg-elevated px-3 py-3">
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{entry.label}</div>
            <div className="mt-1 truncate text-[12px] font-semibold text-text" title={entry.value}>{entry.value}</div>
            <div className="mt-1 text-[10px] text-text-muted">{t('settings.cloudModels.managed', 'Policy managed')}</div>
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-border-subtle bg-surface px-4 py-4">
        <div className="text-[12px] font-semibold text-text">{t('settings.cloudModels.credentials', 'Credential status')}</div>
        <div className="mt-2 grid gap-2 text-[11px] text-text-muted">
          <div>{t('settings.cloudModels.adminManaged', 'admin_managed: configured by the organisation and hidden from clients.')}</div>
          <div>{t('settings.cloudModels.configured', 'configured: a cloud BYOK secret exists, but plaintext is never synced to desktop.')}</div>
          <div>{t('settings.cloudModels.missing', 'missing: the workspace cannot execute until an admin adds the required key.')}</div>
          <div>{t('settings.cloudModels.expired', 'expired: the cloud credential needs to be refreshed or replaced.')}</div>
        </div>
      </div>
    </div>
  )
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
  const [search, setSearch] = useState('')
  const [appearance, setAppearance] = useState<AppearancePreferences>(getAppearancePreferences())
  const [storageStats, setStorageStats] = useState<SandboxStorageStats | null>(null)
  const [runningCleanup, setRunningCleanup] = useState<SandboxCleanupResult['mode'] | null>(null)
  const [lastCleanup, setLastCleanup] = useState<SandboxCleanupResult | null>(null)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId }
  const dirtyProviderCredentialKeys = useRef<Record<string, Set<string>>>({})
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const scrollPositionsRef = useRef<Partial<Record<SettingsTab, number>>>({})
  const tabRef = useRef<SettingsTab>('appearance')
  const pendingSearchTargetRef = useRef<string | null>(null)

  const markProviderCredentialDirty = (providerId: string, key: string) => {
    const keys = dirtyProviderCredentialKeys.current[providerId] || new Set<string>()
    keys.add(key)
    dirtyProviderCredentialKeys.current[providerId] = keys
  }

  useEffect(() => {
    // Fast close-reopen cycles can land these resolves into an unmounted
    // component; guard with a cancelled flag so we don't setState on a
    // disposed instance. The default settings load is masked; the model section
    // fetches only the active provider's descriptor-aware masked bag below.
    let cancelled = false
    Promise.all([
      activeWorkspaceIsLocal ? window.coworkApi.settings.get() : window.coworkApi.settings.get(workspaceOptions),
      window.coworkApi.app.config(),
      activeWorkspaceIsLocal ? window.coworkApi.artifact.storageStats() : Promise.resolve(null),
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
  }, [activeWorkspaceIsLocal, addGlobalError, workspaceOptions?.workspaceId])

  useEffect(() => {
    if (!activeWorkspaceIsLocal) return
    const providerId = settings?.effectiveProviderId
    if (!providerId) return
    let cancelled = false
    window.coworkApi.settings.getProviderCredentials(providerId, {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }).then((credentials) => {
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
  }, [activeWorkspaceIsLocal, addGlobalError, settings?.effectiveProviderId])

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
        { id: 'model' as const, label: t('settings.tab.model', 'Model'), description: t('settings.tab.modelDescription', 'Provider, primary model, and credentials') },
        { id: 'advanced' as const, label: t('settings.tab.advanced', 'Advanced'), description: t('settings.tab.advancedDescription', 'Small model, OAuth detail, and runtime bridge') },
        ...(activeWorkspaceIsLocal ? [{ id: 'permissions' as const, label: t('settings.tab.permissions', 'Permissions'), description: t('settings.tab.permissionsDescription', 'Local tool access') }] : []),
        { id: 'workflows' as const, label: t('settings.tab.workflows', 'Automations'), description: t('settings.tab.workflowsDescription', 'Run behavior and notifications') },
        ...(activeWorkspaceIsLocal ? [{ id: 'pairing' as const, label: t('settings.tab.pairing', 'Pairing'), description: t('settings.tab.pairingDescription', 'Gateway and mobile access') }] : []),
        ...(activeWorkspaceIsLocal ? [{ id: 'storage' as const, label: t('settings.tab.storage', 'Storage'), description: t('settings.tab.storageDescription', 'Sandbox artifacts and cleanup') }] : []),
      ],
    [activeWorkspaceIsLocal],
  )

  const searchEntries = useMemo<SettingsSearchEntry[]>(
    () => [
      { id: 'settings-appearance-theme', tab: 'appearance', label: t('settings.search.theme', 'Theme and appearance'), keywords: 'theme color fonts language appearance' },
      { id: 'settings-model-provider', tab: 'model', label: t('settings.search.provider', 'Provider'), keywords: 'provider model credentials authentication api key oauth sign in' },
      { id: 'settings-model-primary', tab: 'model', label: t('settings.search.primaryModel', 'Primary model'), keywords: 'model catalog refresh context provider' },
      { id: 'settings-model-test', tab: 'model', label: t('settings.models.testConnection', 'Test connection'), keywords: 'test connection credential api key validate provider' },
      { id: 'settings-advanced-small-model', tab: 'advanced', label: t('settings.search.smallModel', 'Small model'), keywords: 'small model lightweight title sdk' },
      { id: 'settings-advanced-runtime-config', tab: 'advanced', label: t('settings.permissions.runtimeConfigSourceTitle', 'OpenCode config source'), keywords: 'runtime config bridge opencode machine app isolated developer config bridge' },
      ...(activeWorkspaceIsLocal ? [
        { id: 'settings-permissions-shell', tab: 'permissions' as const, label: t('settings.permissions.bashTitle', 'Shell commands'), keywords: 'shell terminal bash permission approve deny allow' },
        { id: 'settings-permissions-files', tab: 'permissions' as const, label: t('settings.permissions.fileWriteTitle', 'File editing'), keywords: 'files write edit permission approve deny allow' },
      ] : []),
      { id: 'settings-workflows', tab: 'workflows', label: t('settings.search.automations', 'Automation notifications'), keywords: 'workflow automation run background launch login notifications quiet hours' },
      ...(activeWorkspaceIsLocal ? [
        { id: 'settings-pairing', tab: 'pairing' as const, label: t('settings.search.pairing', 'Pairing'), keywords: 'gateway mobile pairing qr code desktop' },
        { id: 'settings-storage', tab: 'storage' as const, label: t('settings.search.storage', 'Storage cleanup'), keywords: 'storage sandbox artifacts cleanup disk' },
      ] : []),
    ],
    [activeWorkspaceIsLocal],
  )

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return []
    return searchEntries.filter((entry) => `${entry.label} ${entry.keywords}`.toLowerCase().includes(query)).slice(0, 6)
  }, [search, searchEntries])

  useEffect(() => {
    if (tabs.some((entry) => entry.id === tab)) return
    setTab('appearance')
  }, [tab, tabs])

  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const targetId = pendingSearchTargetRef.current
    if (targetId) {
      pendingSearchTargetRef.current = null
      window.requestAnimationFrame(() => {
        document.getElementById(targetId)?.scrollIntoView({ block: 'start' })
      })
      return
    }
    const nextTop = scrollPositionsRef.current[tab] || 0
    window.requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = nextTop
    })
  }, [tab])

  const selectTab = (nextTab: SettingsTab) => {
    if (contentRef.current) {
      scrollPositionsRef.current[tabRef.current] = contentRef.current.scrollTop
    }
    tabRef.current = nextTab
    setTab(nextTab)
  }

  const jumpToSearchResult = (entry: SettingsSearchEntry) => {
    pendingSearchTargetRef.current = entry.id
    if (entry.tab === tab) {
      pendingSearchTargetRef.current = null
      document.getElementById(entry.id)?.scrollIntoView({ block: 'start' })
      return
    }
    selectTab(entry.tab)
  }

  const persistSettings = async (options: { showSaved?: boolean } = {}) => {
    if (!settings) return false
    const { showSaved = true } = options
    setSaveError(null)
    try {
      const savedSettings = await window.coworkApi.settings.set(activeWorkspaceIsLocal
        ? {
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
          }
        : {
            workspaceId: workspaceSupport.workspaceId,
            selectedProviderId: settings.selectedProviderId,
            selectedModelId: settings.selectedModelId,
            selectedSmallModelId: settings.selectedSmallModelId ?? null,
            workflowDesktopNotifications: settings.workflowDesktopNotifications,
            workflowQuietHoursStart: settings.workflowQuietHoursStart,
            workflowQuietHoursEnd: settings.workflowQuietHoursEnd,
          })
      dirtyProviderCredentialKeys.current = {}
      let next = savedSettings
      if (activeWorkspaceIsLocal && savedSettings.effectiveProviderId) {
        try {
          next = {
            ...savedSettings,
            providerCredentials: {
              ...savedSettings.providerCredentials,
              [savedSettings.effectiveProviderId]: await window.coworkApi.settings.getProviderCredentials(savedSettings.effectiveProviderId, {
                workspaceId: LOCAL_WORKSPACE_ID,
                purpose: 'credential_editor',
              }),
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
      if (!activeWorkspaceIsLocal) return
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

  if (!settings || !config) {
    return (
      <Dialog title={t('settings.title', 'Settings')} size="lg" onClose={onClose}>
        <div className="settings-dialog-loading" role="status" aria-live="polite" aria-label={t('settings.loading', 'Loading settings...')}>
          <Skeleton variant="text" className="w-40" />
          <Skeleton variant="block" className="h-10 w-full" />
          <Skeleton variant="card" className="h-48 w-full" />
        </div>
      </Dialog>
    )
  }

  const activeTab = tabs.find((entry) => entry.id === tab) || tabs[0]
  const footer = (
    <div className="settings-dialog-footer">
      <div className="min-w-0 text-[11px]">
        <div className="text-text-muted">
          {t('settings.saveHint', 'Appearance changes apply immediately. Provider and permission changes restart the runtime when needed.')}
          {!activeWorkspaceIsLocal
            ? ` ${t('settings.cloudSaveHint', 'Only portable cloud preferences are saved for this workspace.')}`
            : ''}
        </div>
        {saveError ? (
          <div className="mt-1 text-red">
            {saveError}
          </div>
        ) : null}
      </div>
      <Button
        variant={saved ? 'secondary' : 'primary'}
        onClick={() => void handleSave()}
        leftIcon={saved ? 'check' : undefined}
      >
        {saved ? t('settings.saved', 'Saved') : t('settings.saveChanges', 'Save Changes')}
      </Button>
    </div>
  )

  return (
    <Dialog title={t('settings.title', 'Settings')} size="lg" onClose={onClose} footer={footer}>
      <div className="settings-dialog-shell">
        <div className="settings-dialog-intro">
          <div className="min-w-0">
            <div className="text-[12px] text-text-muted">
              {activeWorkspaceIsLocal
                ? t('settings.subtitle', 'Tune the shell, model runtime, and local permissions.')
                : t('settings.cloudSubtitle', 'Tune portable cloud workspace preferences. Runtime and credentials are policy-managed.')}
            </div>
          </div>
          <Badge tone={activeWorkspaceIsLocal ? 'accent' : 'neutral'}>
            {activeWorkspaceIsLocal ? t('settings.localWorkspace', 'Local workspace') : t('settings.cloudWorkspace', 'Cloud workspace')}
          </Badge>
        </div>

        <div className="settings-dialog-layout">
          <aside className="settings-section-rail" aria-label={t('settings.sections', 'Settings sections')}>
            <Input
              aria-label={t('settings.searchLabel', 'Search settings')}
              value={search}
              leftIcon="search"
              clearable
              onClear={() => setSearch('')}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchResults[0]) {
                  event.preventDefault()
                  jumpToSearchResult(searchResults[0])
                }
              }}
              placeholder={t('settings.searchPlaceholder', 'Search settings')}
            />
            {search.trim() ? (
              <div className="settings-search-results">
                {searchResults.length ? searchResults.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="settings-search-result"
                    onClick={() => jumpToSearchResult(entry)}
                  >
                    <span>{entry.label}</span>
                    <span>{tabs.find((candidate) => candidate.id === entry.tab)?.label}</span>
                  </button>
                )) : (
                  <div className="px-2 py-2 text-[11px] text-text-muted">{t('settings.searchNoResults', 'No settings match that search.')}</div>
                )}
              </div>
            ) : null}
            <nav className="settings-section-list">
              {tabs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => selectTab(entry.id)}
                  aria-current={tab === entry.id ? 'page' : undefined}
                  className="settings-section-button"
                >
                  <span>{entry.label}</span>
                  <span>{entry.description}</span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="settings-content-pane" aria-labelledby="settings-active-section-title">
            <div className="settings-content-heading">
              <div>
                <h3 id="settings-active-section-title" className="font-display text-role-section-title font-bold text-text">{activeTab?.label}</h3>
                <p className="mt-1 text-[12px] text-text-muted">{activeTab?.description}</p>
              </div>
            </div>
            <div ref={contentRef} className="settings-content-scroll">
              {tab === 'appearance' && (
                <div id="settings-appearance-theme" className="flex flex-col gap-5 scroll-mt-4">
                  <AppearancePreview appearance={appearance} onUpdate={updateAppearance} />
                  <LanguagePicker />
                </div>
              )}
              {tab === 'model' && (
                activeWorkspaceIsLocal ? (
                  <ModelsPanel
                    mode="model"
                    config={config}
                    settings={settings}
                    update={update}
                    updateProviderCredential={updateProviderCredential}
                    onConfigRefreshed={setConfig}
                    onPersistSettings={() => persistSettings({ showSaved: false })}
                  />
                ) : (
                  <CloudModelsPolicyPanel settings={settings} />
                )
              )}
              {tab === 'advanced' && (
                activeWorkspaceIsLocal ? (
                  <div className="flex flex-col gap-5">
                    <ModelsPanel
                      mode="advanced"
                      config={config}
                      settings={settings}
                      update={update}
                      updateProviderCredential={updateProviderCredential}
                      onConfigRefreshed={setConfig}
                      onPersistSettings={() => persistSettings({ showSaved: false })}
                    />
                    <div id="settings-advanced-runtime-config" className="scroll-mt-4">
                      <RuntimeConfigPanel settings={settings} update={update} />
                    </div>
                  </div>
                ) : (
                  <CloudModelsPolicyPanel settings={settings} />
                )
              )}
              {tab === 'permissions' && (
                <div>
                  <PermissionsPanel permissions={config.permissions} settings={settings} update={update} />
                </div>
              )}
              {tab === 'workflows' && (
                <div id="settings-workflows" className="scroll-mt-4">
                  <WorkflowSettingsPanel settings={settings} update={update} />
                </div>
              )}
              {tab === 'storage' && (
                <div id="settings-storage" className="scroll-mt-4">
                  <StoragePanel
                    stats={storageStats}
                    runningCleanup={runningCleanup}
                    lastCleanup={lastCleanup}
                    onCleanup={runCleanup}
                  />
                </div>
              )}
              {tab === 'pairing' && (
                <div id="settings-pairing" className="scroll-mt-4">
                  <SettingsPairingPanel />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </Dialog>
  )
}
