import { useState, useEffect } from 'react'

const VERTEX_MODELS = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
]

const DATABRICKS_MODELS = [
  { id: 'databricks-claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'databricks-claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'databricks-gpt-oss-120b', name: 'GPT OSS 120B' },
]

function getTheme(): 'dark' | 'light' {
  return (localStorage.getItem('cowork-theme') as any) || 'dark'
}

function setTheme(theme: 'dark' | 'light') {
  localStorage.setItem('cowork-theme', theme)
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<any>(null)
  const [theme, setThemeState] = useState<'dark' | 'light'>(getTheme())
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.cowork.settings.get().then(setSettings)
  }, [])

  const handleSave = async () => {
    await window.cowork.settings.set(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (key: string, value: any) => {
    setSettings((s: any) => ({ ...s, [key]: value }))
  }

  if (!settings) return null

  const models = settings.provider === 'databricks' ? DATABRICKS_MODELS : VERTEX_MODELS

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1">
      {/* Theme */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Theme</span>
        <div className="flex rounded-lg border border-border-subtle overflow-hidden">
          <button onClick={() => { setTheme('dark'); setThemeState('dark') }}
            className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer transition-colors ${theme === 'dark' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}>
            Dark
          </button>
          <button onClick={() => { setTheme('light'); setThemeState('light') }}
            className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer transition-colors ${theme === 'light' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}>
            Light
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-text">Settings</span>
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer">Done</button>
      </div>

      {/* Provider */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Provider</span>
        <div className="flex rounded-lg border border-border-subtle overflow-hidden">
          <button
            onClick={() => {
              update('provider', 'vertex')
              update('defaultModel', 'gemini-2.5-pro')
            }}
            className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer transition-colors ${
              settings.provider === 'vertex' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Vertex AI
          </button>
          <button
            onClick={() => {
              update('provider', 'databricks')
              update('defaultModel', 'databricks-claude-opus-4-6')
            }}
            className={`flex-1 px-3 py-2 text-[12px] font-medium cursor-pointer transition-colors ${
              settings.provider === 'databricks' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            Databricks
          </button>
        </div>
      </div>

      {/* Model */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Model</span>
        <div className="flex flex-col gap-1">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => update('defaultModel', m.id)}
              className={`px-3 py-2 rounded-lg text-[12px] text-left cursor-pointer transition-colors ${
                settings.defaultModel === m.id
                  ? 'bg-surface-active text-text border border-border'
                  : 'text-text-secondary hover:bg-surface-hover border border-transparent'
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>

      {/* Databricks config */}
      {settings.provider === 'databricks' && (
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Databricks</span>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Host URL</span>
            <input
              type="text"
              value={settings.databricksHost || ''}
              onChange={(e) => update('databricksHost', e.target.value)}
              placeholder="https://your-workspace.cloud.databricks.com"
              className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Access Token</span>
            <input
              type="password"
              value={settings.databricksToken || ''}
              onChange={(e) => update('databricksToken', e.target.value)}
              placeholder="dapi..."
              className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </label>
        </div>
      )}

      {/* Vertex config */}
      {settings.provider === 'vertex' && (
        <div className="flex flex-col gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Vertex AI</span>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">GCP Project ID</span>
            <input
              type="text"
              value={settings.gcpProjectId || ''}
              onChange={(e) => update('gcpProjectId', e.target.value || null)}
              placeholder="Auto-detected from gcloud"
              className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-muted">Region</span>
            <input
              type="text"
              value={settings.gcpRegion || ''}
              onChange={(e) => update('gcpRegion', e.target.value)}
              placeholder="global"
              className="px-3 py-2 rounded-lg text-[12px] bg-elevated border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </label>
        </div>
      )}

      {/* Save */}
      <button
        onClick={handleSave}
        className="px-3 py-2.5 rounded-lg text-[12px] font-medium cursor-pointer transition-colors"
        style={{
          background: saved ? 'color-mix(in srgb, var(--color-green) 15%, transparent)' : 'var(--color-surface-hover)',
          color: saved ? 'var(--color-green)' : 'var(--color-text)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        {saved ? 'Saved — restart app to apply' : 'Save'}
      </button>
    </div>
  )
}
