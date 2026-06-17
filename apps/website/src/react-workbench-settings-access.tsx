import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { useAppApi } from '@open-cowork/ui/app-api'
import { asRecord, errorMessage } from './react-workbench-controller.ts'

// Read-only "Models & permissions" for Cloud Web settings. The cloud
// /api/config (member-accessible) already carries the effective providers /
// default model AND the per-tool runtime permissions (bash / fileWrite / task /
// web / webSearch); the shell controller fetched and discarded it. This surfaces
// it read-only, mirroring the desktop Settings → Models/Permissions panels — the
// cloud config is server/policy-managed, so the web view is intentionally
// read-only (editing machine runtime config stays desktop-only by design).

function usePortalTarget(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const element = document.getElementById(id)
    if (element) element.replaceChildren()
    setTarget(element)
  }, [id])
  return target
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

const PERMISSION_LABEL: Record<string, string> = { allow: 'Allowed', ask: 'Ask first', deny: 'Denied' }

function permissionTone(value: unknown) {
  return value === 'deny' ? 'danger' : value === 'ask' ? 'warn' : 'info'
}

const TOOL_PERMISSIONS: ReadonlyArray<{ key: string, label: string }> = [
  { key: 'bash', label: 'Shell commands' },
  { key: 'fileWrite', label: 'File writes' },
  { key: 'task', label: 'Sub-agent tasks' },
  { key: 'web', label: 'Web access' },
]

function CloudSettingsAccessView({ config, error }: { config: Record<string, unknown> | null, error: string | null }) {
  if (error) return <p className="notice" data-kind="danger">{error}</p>
  if (!config) return <p className="empty">Loading models &amp; permissions…</p>
  const providers = asRecord(config.providers)
  const available = list<Record<string, unknown>>(providers.available)
  const permissions = asRecord(config.permissions)
  const modelCount = available.reduce((sum, provider) => sum + list(provider.models).length, 0)
  return (
    <>
      <div className="settings-row">
        <div><strong>Default model</strong><span>{text(providers.defaultModel, 'Profile default')}{text(providers.defaultProvider) ? ` · ${text(providers.defaultProvider)}` : ''}</span></div>
        <span className="pill" data-kind="info">Policy managed</span>
      </div>
      <div className="settings-row">
        <div><strong>Available providers</strong><span>{available.length ? available.map((provider) => text(provider.label, text(provider.id, 'provider'))).join(', ') : 'Profile defaults'}</span></div>
        <span className="pill">{modelCount} model{modelCount === 1 ? '' : 's'}</span>
      </div>
      {TOOL_PERMISSIONS.map(({ key, label }) => (
        <div className="settings-row" key={key}>
          <div><strong>{label}</strong><span>Coworker permission for {label.toLowerCase()}.</span></div>
          <span className="pill" data-kind={permissionTone(permissions[key])}>{PERMISSION_LABEL[String(permissions[key])] || text(permissions[key], 'Profile default')}</span>
        </div>
      ))}
      <div className="settings-row">
        <div><strong>Web search</strong><span>Coworker permission to search the web.</span></div>
        <span className="pill" data-kind={permissions.webSearch === false ? 'danger' : 'info'}>{permissions.webSearch === false ? 'Denied' : 'Allowed'}</span>
      </div>
    </>
  )
}

export function CloudSettingsAccessPortals() {
  const api = useAppApi()
  const target = usePortalTarget('cloud-settings-access')
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!target) return
    let cancelled = false
    void (async () => {
      try {
        const result = asRecord(await api.config.current())
        if (!cancelled) setConfig(result)
      } catch (configError) {
        if (!cancelled) setError(errorMessage(configError))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, api])
  if (!target) return null
  return createPortal(<CloudSettingsAccessView config={config} error={error} />, target)
}
