import { useState } from 'react'

const PROVIDERS = [
  {
    id: 'vertex' as const,
    name: 'Google Vertex AI',
    description: 'Uses your Google login. No extra setup needed.',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Best quality' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Fastest' },
    ],
  },
  {
    id: 'databricks' as const,
    name: 'Databricks',
    description: 'Connect to your Databricks workspace for Claude and other models.',
    models: [
      { id: 'databricks-claude-sonnet-4', name: 'Claude Sonnet 4', desc: 'Fast + capable' },
      { id: 'databricks-claude-opus-4-6', name: 'Claude Opus 4.6', desc: 'Most capable' },
      { id: 'databricks-claude-sonnet-4-6', name: 'Claude Sonnet 4.6', desc: 'Latest Sonnet' },
      { id: 'databricks-gpt-oss-120b', name: 'GPT OSS 120B', desc: 'Open source' },
    ],
  },
]

interface Props {
  email: string
  onComplete: () => void
}

export function SetupScreen({ email, onComplete }: Props) {
  const [provider, setProvider] = useState<'vertex' | 'databricks' | null>(null)
  const [model, setModel] = useState<string>('')
  const [databricksHost, setDatabricksHost] = useState('')
  const [databricksToken, setDatabricksToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProvider = PROVIDERS.find(p => p.id === provider)
  const canContinue = provider === 'vertex'
    ? !!model
    : !!model && !!databricksHost && !!databricksToken

  const handleContinue = async () => {
    if (!canContinue || !provider) return
    setSaving(true)
    setError(null)
    try {
      await window.cowork.settings.set({
        provider,
        defaultModel: model,
        ...(provider === 'databricks' ? {
          databricksHost: databricksHost.replace(/\/$/, ''),
          databricksToken,
        } : {}),
      })
      onComplete()
    } catch (err: any) {
      setError(err?.message || 'Failed to save settings')
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen w-screen" style={{ background: 'var(--color-base)' }}>
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-6">
        {/* Header */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-lg font-bold text-accent">C</span>
          </div>
          <h1 className="text-lg font-semibold text-text">Welcome, {email.split('@')[0]}</h1>
          <p className="text-[13px] text-text-muted text-center">
            Choose your AI provider to get started
          </p>
        </div>

        {/* Provider selection */}
        <div className="w-full flex flex-col gap-2">
          {PROVIDERS.map(p => (
            <button key={p.id} onClick={() => { setProvider(p.id); setModel(p.models[0].id) }}
              className="w-full text-left px-4 py-3 rounded-xl border transition-all cursor-pointer"
              style={{
                background: provider === p.id ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'var(--color-elevated)',
                borderColor: provider === p.id ? 'var(--color-accent)' : 'var(--color-border-subtle)',
              }}>
              <div className="text-[13px] font-medium" style={{ color: provider === p.id ? 'var(--color-accent)' : 'var(--color-text)' }}>
                {p.name}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">{p.description}</div>
            </button>
          ))}
        </div>

        {/* Model selection */}
        {selectedProvider && (
          <div className="w-full flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Model</span>
            <div className="flex flex-col gap-1">
              {selectedProvider.models.map(m => (
                <button key={m.id} onClick={() => setModel(m.id)}
                  className="flex items-center justify-between px-3.5 py-2.5 rounded-lg text-left cursor-pointer transition-all border"
                  style={{
                    background: model === m.id ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent',
                    borderColor: model === m.id ? 'var(--color-accent)' : 'transparent',
                  }}>
                  <span className="text-[12px]" style={{ color: model === m.id ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>{m.name}</span>
                  <span className="text-[10px] text-text-muted">{m.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Databricks credentials */}
        {provider === 'databricks' && (
          <div className="w-full flex flex-col gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1">Databricks Connection</span>
            <div className="flex flex-col gap-2.5 rounded-xl border border-border-subtle p-3.5" style={{ background: 'var(--color-elevated)' }}>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-muted font-medium">Workspace URL</span>
                <input type="text" value={databricksHost} onChange={e => setDatabricksHost(e.target.value)}
                  placeholder="https://your-workspace.cloud.databricks.com"
                  className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-text-muted font-medium">Personal Access Token</span>
                <input type="password" value={databricksToken} onChange={e => setDatabricksToken(e.target.value)}
                  placeholder="dapi..."
                  className="w-full px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors" />
              </label>
              <p className="text-[10px] text-text-muted">
                Generate a token from your Databricks workspace: Settings &rarr; Developer &rarr; Access tokens
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-[12px] text-center" style={{ color: 'var(--color-red)' }}>{error}</p>
        )}

        {/* Continue button */}
        <button onClick={handleContinue} disabled={!canContinue || saving}
          className="w-full py-2.5 rounded-xl text-[13px] font-semibold cursor-pointer transition-all"
          style={{
            background: canContinue ? 'var(--color-accent)' : 'var(--color-surface-hover)',
            color: canContinue ? '#fff' : 'var(--color-text-muted)',
            opacity: saving ? 0.6 : 1,
          }}>
          {saving ? 'Setting up...' : 'Get Started'}
        </button>
      </div>
    </div>
  )
}
