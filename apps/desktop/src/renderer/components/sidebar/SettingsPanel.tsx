import { useMemo, useState, useEffect } from 'react'
import type { EffectiveAppSettings, PublicAppConfig, SandboxCleanupResult, SandboxStorageStats } from '@open-cowork/shared'
import {
  getAppearancePreferences,
  getThemeTokens,
  MONO_FONT_OPTIONS,
  saveAppearancePreferences,
  type AppearancePreferences,
  type ColorScheme,
  type MonoFont,
  type UiFont,
  type UiTheme,
  UI_FONT_OPTIONS,
  UI_THEME_OPTIONS,
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
        className="absolute left-2.5 right-2.5 top-2.5 rounded-lg flex items-center gap-1.5 px-2 py-1.5"
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
        <span className="ml-auto text-[9px] font-mono" style={{ color: tokens.textMuted }}>Aa</span>
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
        <span className={sectionLabelCls}>Color Scheme</span>
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
        <span className={sectionLabelCls}>Theme</span>
        <div className="grid grid-cols-2 gap-3">
          {UI_THEME_OPTIONS.map((theme) => {
            const active = appearance.uiTheme === theme.id
            const previewScheme = appearance.colorScheme === 'light' ? 'light' : 'dark'
            return (
              <button
                key={theme.id}
                onClick={() => onUpdate({ uiTheme: theme.id })}
                className="text-left rounded-2xl border p-3 transition-all cursor-pointer hover:scale-[1.01]"
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
                      Active
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
          <span className={fieldLabelCls}>Interface font</span>
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
          <span className={fieldLabelCls}>Monospace font</span>
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
        <div className="text-[12px] font-semibold text-text mb-3">Preview</div>
        <div className="rounded-xl border border-border-subtle bg-surface p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-text">Workspace health</div>
              <div className="text-[11px] text-text-muted">Provider connected, runtime ready</div>
            </div>
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{
                color: 'var(--color-accent)',
                background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
              }}
            >
              Active
            </span>
          </div>
          <div className="rounded-lg border border-border-subtle p-3 bg-elevated">
            <div className="text-[12px] text-text mb-1">Theme changes apply immediately.</div>
            <div className="text-[11px] text-text-muted">Provider and permission changes still use the save button below.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelsPanel({
  config,
  settings,
  update,
  updateProviderCredential,
}: {
  config: PublicAppConfig
  settings: EffectiveAppSettings
  update: (patch: Partial<EffectiveAppSettings>) => void
  updateProviderCredential: (providerId: string, key: string, value: string) => void
}) {
  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = provider?.models || []
  const providerCredentials = settings.effectiveProviderId
    ? (settings.providerCredentials[settings.effectiveProviderId] || {})
    : {}

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <span className={sectionLabelCls}>Provider</span>
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
              className="text-left rounded-2xl border p-3 transition-colors cursor-pointer"
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
          <span className={sectionLabelCls}>Model</span>
          <div className="grid grid-cols-2 gap-3">
            {models.map((model) => (
              <button
                key={model.id}
                onClick={() => update({ selectedModelId: model.id, effectiveModel: model.id })}
                className="rounded-2xl border px-3 py-3 text-left transition-colors cursor-pointer"
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
        </div>
      )}

      {provider?.credentials.length ? (
        <div className="flex flex-col gap-3">
          <span className={sectionLabelCls}>Credentials</span>
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
      <span className={sectionLabelCls}>Developer Tools</span>
      <div className={panelCardCls}>
        {[
          {
            key: 'enableBash' as const,
            title: 'Shell commands',
            description: 'Allow agents to run terminal commands inside the active workspace.',
          },
          {
            key: 'enableFileWrite' as const,
            title: 'File editing',
            description: 'Allow agents to create and modify files in the local workspace.',
          },
        ].map((toggle) => {
          const enabled = settings[toggle.key]
          return (
            <label key={toggle.key} className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-[12px] font-semibold text-text">{toggle.title}</div>
                <div className="text-[11px] text-text-muted mt-1">{toggle.description}</div>
              </div>
              <button
                onClick={() => update({ [toggle.key]: !enabled } as Partial<EffectiveAppSettings>)}
                className="w-10 h-5 rounded-full transition-colors relative shrink-0"
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
            </label>
          )
        })}
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
  if (!stats) {
    return (
      <div className={panelCardCls}>
        <div className="text-[12px] text-text-muted">Loading sandbox storage…</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <span className={sectionLabelCls}>Sandbox Storage</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-3">
          <StorageStat label="Total Size" value={formatBytes(stats.totalBytes)} />
          <StorageStat label="Workspaces" value={String(stats.workspaceCount)} />
          <StorageStat label="Referenced" value={String(stats.referencedWorkspaceCount)} />
          <StorageStat label="Unreferenced" value={String(stats.unreferencedWorkspaceCount)} />
          <StorageStat label="Stale" value={String(stats.staleWorkspaceCount)} />
          <StorageStat label="Retention" value={`${stats.staleThresholdDays} days`} />
        </div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          Sandbox threads write into a private Cowork workspace under <span className="font-mono text-text-secondary">{stats.root}</span>.
          Older unreferenced workspaces are pruned automatically, and you can run cleanup manually here.
        </div>
      </div>

      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-text">Cleanup</div>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => void onCleanup('old-unreferenced')}
            className="w-full text-left rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'old-unreferenced' ? 'Cleaning…' : 'Clear old sandbox artifacts'}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              Removes unreferenced sandbox workspaces older than {stats.staleThresholdDays} days.
            </div>
          </button>

          <button
            onClick={() => void onCleanup('all-unreferenced')}
            className="w-full text-left rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'all-unreferenced' ? 'Cleaning…' : 'Clear all unused sandbox artifacts'}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              Removes every unreferenced sandbox workspace while keeping active thread workspaces intact.
            </div>
          </button>
        </div>

        {lastCleanup ? (
          <div className="rounded-xl border border-border-subtle bg-base px-3 py-3 text-[11px] text-text-muted">
            Last cleanup removed {lastCleanup.removedWorkspaces} workspace{lastCleanup.removedWorkspaces === 1 ? '' : 's'} and freed {formatBytes(lastCleanup.removedBytes)}.
          </div>
        ) : null}
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
    Promise.all([window.openCowork.settings.get(), window.openCowork.app.config(), window.openCowork.artifact.storageStats()])
      .then(([nextSettings, nextConfig, nextStorage]) => {
        setSettings(nextSettings)
        setConfig(nextConfig)
        setStorageStats(nextStorage)
      })
      .catch((err) => console.error('Failed to load settings panel:', err))
  }, [])

  const tabs = useMemo(
    () => [
        { id: 'appearance' as const, label: 'Appearance', description: 'Theme, color scheme, and fonts' },
        { id: 'models' as const, label: 'Models', description: 'Provider, model, and credentials' },
        { id: 'permissions' as const, label: 'Permissions', description: 'Local tool access' },
        { id: 'storage' as const, label: 'Storage', description: 'Sandbox artifacts and cleanup' },
      ],
    [],
  )

  const handleSave = async () => {
    if (!settings) return
    const next = await window.openCowork.settings.set({
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
      const result = await window.openCowork.artifact.cleanup(mode)
      setLastCleanup(result)
      setStorageStats(await window.openCowork.artifact.storageStats())
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
          <div className="text-[14px] font-semibold text-text">Settings</div>
          <div className="text-[11px] text-text-muted mt-0.5">Tune the shell, model runtime, and local permissions.</div>
        </div>
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer transition-colors">Done</button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[190px] shrink-0 border-r border-border-subtle px-3 py-4 flex flex-col gap-2">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className="text-left rounded-2xl px-3 py-3 transition-colors cursor-pointer"
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
              <AppearancePreview appearance={appearance} onUpdate={updateAppearance} />
            )}
            {tab === 'models' && (
              <ModelsPanel
                config={config}
                settings={settings}
                update={update}
                updateProviderCredential={updateProviderCredential}
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
              Appearance changes apply immediately. Provider and permission changes restart the runtime when needed.
            </div>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-xl text-[12px] font-semibold cursor-pointer transition-all"
              style={{
                background: saved ? 'color-mix(in srgb, var(--color-green) 15%, transparent)' : 'var(--color-accent)',
                color: saved ? 'var(--color-green)' : 'var(--color-accent-foreground)',
              }}
            >
              {saved ? '✓ Saved' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
