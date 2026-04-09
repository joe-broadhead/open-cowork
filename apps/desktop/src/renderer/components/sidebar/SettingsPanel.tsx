import { useState, useEffect } from 'react'
import type { AppSettings } from '@cowork/shared'

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [projectId, setProjectId] = useState('')
  const [region, setRegion] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.cowork.settings.get().then((s) => {
      setSettings(s)
      setProjectId(s.gcpProjectId || '')
      setRegion(s.gcpRegion || '')
    })
  }, [])

  const handleSave = async () => {
    const updated = await window.cowork.settings.set({
      gcpProjectId: projectId || null,
      gcpRegion: region || 'us-central1',
    })
    setSettings(updated)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (!settings) return null

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Settings
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded transition-colors cursor-pointer"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          x
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            GCP Project ID
          </span>
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="Auto-detected from gcloud"
            className="glass-subtle px-3 py-2 text-sm outline-none"
            style={{
              color: 'var(--text-primary)',
              background: 'var(--bg-glass)',
              border: '1px solid var(--border-glass)',
              borderRadius: 8,
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            GCP Region
          </span>
          <input
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="us-central1"
            className="glass-subtle px-3 py-2 text-sm outline-none"
            style={{
              color: 'var(--text-primary)',
              background: 'var(--bg-glass)',
              border: '1px solid var(--border-glass)',
              borderRadius: 8,
            }}
          />
        </label>

        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Model: {settings.vertexModel}
        </div>

        <button
          onClick={handleSave}
          className="glass-subtle px-3 py-2 text-sm font-medium transition-colors cursor-pointer"
          style={{
            color: saved ? 'var(--accent-green)' : 'var(--text-primary)',
            textAlign: 'center',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-glass-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-surface)')}
        >
          {saved ? 'Saved' : 'Save & Restart Runtime'}
        </button>

        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Leave blank to auto-detect from gcloud CLI. Changes take effect on next app restart.
        </div>
      </div>
    </div>
  )
}
