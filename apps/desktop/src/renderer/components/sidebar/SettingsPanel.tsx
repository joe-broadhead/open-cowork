import { useState, useEffect } from 'react'

const VERTEX_MODELS = [
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
]

const DATABRICKS_MODELS = [
  { id: 'databricks-claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'databricks-claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'databricks-claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'databricks-gpt-oss-120b', name: 'GPT OSS 120B' },
]

function getTheme(): 'dark' | 'light' {
  return (localStorage.getItem('cowork-theme') as any) || 'dark'
}

function setTheme(theme: 'dark' | 'light') {
  localStorage.setItem('cowork-theme', theme)
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
}

const inputCls = 'w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors'
const labelCls = 'text-[11px] text-text-muted font-medium'
const sectionCls = 'flex flex-col gap-3'
const cardCls = 'rounded-xl border border-border-subtle p-3.5 flex flex-col gap-3'

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<any>(null)
  const [saved, setSaved] = useState(false)
  const [theme, setThemeState] = useState<'dark' | 'light'>(getTheme())

  useEffect(() => { window.cowork.settings.get().then(setSettings) }, [])

  const handleSave = async () => {
    await window.cowork.settings.set(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (key: string, value: any) => setSettings((s: any) => ({ ...s, [key]: value }))

  if (!settings) return null

  const models = settings.provider === 'databricks' ? DATABRICKS_MODELS : VERTEX_MODELS

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-[14px] font-semibold text-text">Settings</span>
        <button onClick={onClose} className="text-[11px] text-text-muted hover:text-text-secondary cursor-pointer transition-colors">Done</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">
        {/* Appearance */}
        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Appearance</span>
          <div className={cardCls}>
            <div className="flex items-center justify-between">
              <span className={labelCls}>Theme</span>
              <div className="flex rounded-lg border border-border-subtle overflow-hidden">
                {(['dark', 'light'] as const).map(t => (
                  <button key={t} onClick={() => { setTheme(t); setThemeState(t) }}
                    className={`px-3 py-1 text-[11px] font-medium cursor-pointer transition-colors capitalize ${theme === t ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Model */}
        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Model</span>
          <div className={cardCls}>
            <div className="flex rounded-lg border border-border-subtle overflow-hidden">
              {(['vertex', 'databricks'] as const).map(p => (
                <button key={p} onClick={() => { update('provider', p); update('defaultModel', p === 'databricks' ? 'databricks-claude-opus-4-6' : 'gemini-2.5-pro') }}
                  className={`flex-1 px-3 py-1.5 text-[11px] font-medium cursor-pointer transition-colors ${settings.provider === p ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text-secondary'}`}>
                  {p === 'vertex' ? 'Vertex AI' : 'Databricks'}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {models.map(m => (
                <button key={m.id} onClick={() => update('defaultModel', m.id)}
                  className={`px-3 py-2 rounded-lg text-[12px] text-left cursor-pointer transition-all ${
                    settings.defaultModel === m.id ? 'bg-accent/10 text-accent border border-accent/20' : 'text-text-secondary hover:bg-surface-hover border border-transparent'
                  }`}>
                  {m.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Provider Config */}
        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">
            {settings.provider === 'databricks' ? 'Databricks' : 'Vertex AI'}
          </span>
          <div className={cardCls}>
            {settings.provider === 'databricks' ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Host URL</span>
                  <input type="text" value={settings.databricksHost || ''} onChange={e => update('databricksHost', e.target.value)}
                    placeholder="https://workspace.cloud.databricks.com" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Access Token</span>
                  <input type="password" value={settings.databricksToken || ''} onChange={e => update('databricksToken', e.target.value)}
                    placeholder="dapi..." className={inputCls} />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>GCP Project ID</span>
                  <input type="text" value={settings.gcpProjectId || ''} onChange={e => update('gcpProjectId', e.target.value || null)}
                    placeholder="Auto-detected" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Region</span>
                  <input type="text" value={settings.gcpRegion || ''} onChange={e => update('gcpRegion', e.target.value)}
                    placeholder="global" className={inputCls} />
                </label>
              </>
            )}
          </div>
        </div>

        {/* Developer Tools */}
        <div className={sectionCls}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Developer Tools</span>
          <div className={cardCls}>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[12px] text-text font-medium">Shell commands</div>
                <div className="text-[10px] text-text-muted">Allow the agent to run bash/terminal commands</div>
              </div>
              <button onClick={() => update('enableBash', !settings.enableBash)}
                className="w-9 h-5 rounded-full transition-colors relative shrink-0"
                style={{ background: settings.enableBash ? 'var(--color-accent)' : 'var(--color-border)' }}>
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-all"
                  style={{ left: settings.enableBash ? 18 : 3 }} />
              </button>
            </label>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <div className="text-[12px] text-text font-medium">File editing</div>
                <div className="text-[10px] text-text-muted">Allow the agent to create and edit files on disk</div>
              </div>
              <button onClick={() => update('enableFileWrite', !settings.enableFileWrite)}
                className="w-9 h-5 rounded-full transition-colors relative shrink-0"
                style={{ background: settings.enableFileWrite ? 'var(--color-accent)' : 'var(--color-border)' }}>
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-all"
                  style={{ left: settings.enableFileWrite ? 18 : 3 }} />
              </button>
            </label>
            <div className="text-[10px] text-text-muted">
              These tools are disabled by default for safety. Enable them if you need the agent to execute code or modify files.
            </div>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="px-3 py-3 border-t border-border-subtle">
        <button onClick={handleSave}
          className="w-full py-2.5 rounded-xl text-[12px] font-semibold cursor-pointer transition-all"
          style={{
            background: saved ? 'color-mix(in srgb, var(--color-green) 15%, transparent)' : 'var(--color-accent)',
            color: saved ? 'var(--color-green)' : '#fff',
          }}>
          {saved ? '✓ Saved — restart to apply' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}
