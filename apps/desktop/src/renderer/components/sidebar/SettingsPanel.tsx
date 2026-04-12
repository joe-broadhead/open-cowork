import { useState, useEffect } from 'react'
import type { EffectiveAppSettings, PublicAppConfig } from '@open-cowork/shared'

function getTheme(): 'dark' | 'light' {
  return (localStorage.getItem('open-cowork-theme') || localStorage.getItem('cowork-theme') as any) || 'dark'
}

function setTheme(theme: 'dark' | 'light') {
  localStorage.setItem('open-cowork-theme', theme)
  localStorage.setItem('cowork-theme', theme)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
}

const inputCls = 'w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors'
const labelCls = 'text-[11px] text-text-muted font-medium'
const sectionCls = 'flex flex-col gap-3'
const cardCls = 'rounded-xl border border-border-subtle p-3.5 flex flex-col gap-3'

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<EffectiveAppSettings | null>(null)
  const [config, setConfig] = useState<PublicAppConfig | null>(null)
  const [saved, setSaved] = useState(false)
  const [theme, setThemeState] = useState<'dark' | 'light'>(getTheme())

  useEffect(() => {
    Promise.all([window.openCowork.settings.get(), window.openCowork.app.config()]).then(([nextSettings, nextConfig]) => {
      setSettings(nextSettings)
      setConfig(nextConfig)
    }).catch((err) => console.error('Failed to load settings panel:', err))
  }, [])

  const handleSave = async () => {
    if (!settings) return
    const next = await window.openCowork.settings.set(settings)
    setSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (patch: Partial<EffectiveAppSettings>) => {
    setSettings((current) => current ? ({ ...current, ...patch }) : current)
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

  const provider = config.providers.available.find((entry) => entry.id === settings.effectiveProviderId) || null
  const models = provider?.models || []
  const providerCredentials = settings.effectiveProviderId
    ? (settings.providerCredentials[settings.effectiveProviderId] || {})
    : {}

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-[14px] font-semibold text-text">Settings</span>
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer transition-colors">Done</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">
        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Appearance</span>
          <div className={cardCls}>
            <div className="flex items-center justify-between">
              <span className={labelCls}>Theme</span>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                {(['dark', 'light'] as const).map((nextTheme) => (
                  <button
                    key={nextTheme}
                    onClick={() => { setTheme(nextTheme); setThemeState(nextTheme) }}
                    className={`px-3 py-1 text-[11px] font-medium cursor-pointer transition-colors capitalize ${theme === nextTheme ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'}`}
                  >
                    {nextTheme}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Provider</span>
          <div className={cardCls}>
            <div className="flex flex-col gap-2">
              {config.providers.available.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => update({
                    selectedProviderId: entry.id,
                    selectedModelId: entry.models[0]?.id || settings.selectedModelId,
                    effectiveProviderId: entry.id,
                    effectiveModel: entry.models[0]?.id || settings.effectiveModel,
                  })}
                  className="w-full text-left px-3 py-2 rounded-lg border transition-colors"
                  style={{
                    background: settings.effectiveProviderId === entry.id ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                    borderColor: settings.effectiveProviderId === entry.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
                  }}
                >
                  <div className="text-[12px] font-medium text-text">{entry.name}</div>
                  <div className="text-[10px] text-text-muted mt-0.5">{entry.description}</div>
                </button>
              ))}
            </div>

            {models.length > 0 && (
              <div className="flex flex-col gap-1">
                {models.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => update({ selectedModelId: model.id, effectiveModel: model.id })}
                    className={`px-3 py-2 rounded-lg text-[12px] text-left cursor-pointer transition-all ${
                      settings.effectiveModel === model.id ? 'bg-accent/10 text-accent border border-accent/20' : 'text-text-secondary hover:bg-surface-hover border border-transparent'
                    }`}
                  >
                    {model.name}
                  </button>
                ))}
              </div>
            )}

            {provider?.credentials.length ? (
              <div className="flex flex-col gap-3">
                {provider.credentials.map((credential) => (
                  <label key={credential.key} className="flex flex-col gap-1">
                    <span className={labelCls}>{credential.label}</span>
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
        </div>

        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Developer Tools</span>
          <div className={cardCls}>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[12px] text-text font-medium">Shell commands</div>
                <div className="text-[10px] text-text-muted">Allow the assistant to run terminal commands</div>
              </div>
              <button
                onClick={() => update({ enableBash: !settings.enableBash })}
                className="w-9 h-5 rounded-full transition-colors relative shrink-0"
                style={{ background: settings.enableBash ? 'var(--color-accent)' : 'var(--color-border)' }}
              >
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-all" style={{ left: settings.enableBash ? 18 : 3 }} />
              </button>
            </label>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[12px] text-text font-medium">File editing</div>
                <div className="text-[10px] text-text-muted">Allow the assistant to create and edit local files</div>
              </div>
              <button
                onClick={() => update({ enableFileWrite: !settings.enableFileWrite })}
                className="w-9 h-5 rounded-full transition-colors relative shrink-0"
                style={{ background: settings.enableFileWrite ? 'var(--color-accent)' : 'var(--color-border)' }}
              >
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-all" style={{ left: settings.enableFileWrite ? 18 : 3 }} />
              </button>
            </label>
          </div>
        </div>
      </div>

      <div className="px-3 py-3 border-t border-border-subtle">
        <button
          onClick={handleSave}
          className="w-full py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer transition-all"
          style={{
            background: saved ? 'color-mix(in srgb, var(--color-green) 15%, transparent)' : 'var(--color-accent)',
            color: saved ? 'var(--color-green)' : '#fff',
          }}
        >
          {saved ? '✓ Saved' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
