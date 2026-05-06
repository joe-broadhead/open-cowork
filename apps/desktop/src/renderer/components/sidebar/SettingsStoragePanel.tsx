import { useEffect, useState } from 'react'
import type {
  SandboxCleanupResult,
  SandboxStorageStats,
} from '@open-cowork/shared'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { confirmAppReset } from '../../helpers/destructive-actions'
import { t } from '../../helpers/i18n'

const sectionLabelCls = 'text-[10px] font-semibold uppercase tracking-widest text-text-muted px-1'
const panelCardCls = 'rounded-2xl border border-border-subtle p-4 flex flex-col gap-4'

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; current: string; latest: string; url: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'error'; message: string }

function StorageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-[13px] font-medium text-text">{value}</div>
    </div>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

export function StoragePanel({
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
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<'idle' | 'working' | 'copied' | 'error'>('idle')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [resetting, setResetting] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  // Resolve the current build's version on mount so we can surface it
  // next to the update-check button before the user clicks. Uses the
  // existing checkUpdates IPC — the endpoint returns `currentVersion`
  // regardless of the status branch, so this is a free piggyback.
  useEffect(() => {
    let cancelled = false
    window.coworkApi.app.checkUpdates()
      .then((result) => {
        if (cancelled) return
        if ('currentVersion' in result) setCurrentVersion(result.currentVersion)
      })
      .catch(() => { /* offline check is best-effort — version stays null */ })
    return () => { cancelled = true }
  }, [])

  const handleCheckForUpdates = async () => {
    setUpdateStatus({ kind: 'checking' })
    try {
      const result = await window.coworkApi.app.checkUpdates()
      if (result.status === 'disabled') {
        setUpdateStatus({ kind: 'disabled', message: result.message })
      } else if (result.status === 'error') {
        setUpdateStatus({ kind: 'error', message: result.message })
      } else if (result.hasUpdate) {
        setUpdateStatus({ kind: 'available', current: result.currentVersion, latest: result.latestVersion, url: result.releaseUrl })
      } else {
        setUpdateStatus({ kind: 'current', version: result.currentVersion })
      }
    } catch (err) {
      setUpdateStatus({ kind: 'error', message: err instanceof Error ? err.message : t('settings.updates.checkFailedGeneric', 'Failed to check for updates.') })
    }
  }

  const handleResetAppData = async () => {
    const confirmation = await confirmAppReset()
    if (!confirmation) return
    setResetting(true)
    try {
      await window.coworkApi.app.reset(confirmation.token)
      // The main process relaunches the app itself; this line usually
      // won't execute. Falling through lands in resetting=true which
      // disables the button until the relaunch lands.
    } catch (err) {
      setResetting(false)
      const message = err instanceof Error ? err.message : t('settings.updates.resetCheckLogs', 'Reset failed. Check the logs.')
      window.alert(t('settings.updates.resetFailed', 'Could not reset app data: {{message}}', { message }))
    }
  }

  const handleExportDiagnostics = async () => {
    setDiagnosticsStatus('working')
    try {
      const bundle = await window.coworkApi.app.exportDiagnostics()
      if (!bundle) {
        setDiagnosticsStatus('error')
        return
      }
      const copied = await writeTextToClipboard(bundle)
      setDiagnosticsStatus(copied ? 'copied' : 'error')
      setTimeout(() => setDiagnosticsStatus('idle'), 3_000)
    } catch (err) {
      console.error('Failed to export diagnostics:', err)
      setDiagnosticsStatus('error')
      setTimeout(() => setDiagnosticsStatus('idle'), 3_000)
    }
  }

  if (!stats) {
    return (
      <div className={panelCardCls}>
        <div className="text-[12px] text-text-muted">{t('settings.storage.loading', 'Loading sandbox storage…')}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-text">{t('settings.storage.supportDiagnostics', 'Support Diagnostics')}</div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.storage.supportDescription', "Copies a plaintext report (config, runtime inputs, recent log lines) to your clipboard. Credentials are masked / redacted so it's safe to paste into a bug report.")}
        </div>
        <button
          onClick={() => void handleExportDiagnostics()}
          disabled={diagnosticsStatus === 'working'}
          className="w-full rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait text-start"
        >
          <div className="text-[12px] font-semibold text-text">
            {diagnosticsStatus === 'working'
              ? t('settings.storage.preparing', 'Preparing…')
              : diagnosticsStatus === 'copied'
                ? t('settings.storage.copied', 'Copied to clipboard')
                : diagnosticsStatus === 'error'
                  ? t('settings.storage.copyFailed', 'Could not build diagnostics — try again')
                  : t('settings.storage.copyDiagnostics', 'Copy diagnostics to clipboard')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t('settings.storage.diagnosticsHint', 'Useful when filing an issue — include this bundle in your report.')}
          </div>
        </button>
      </div>

      <span className={sectionLabelCls}>{t('settings.storage.sandboxStorage', 'Sandbox Storage')}</span>
      <div className={panelCardCls}>
        <div className="grid grid-cols-2 gap-3">
          <StorageStat label={t('settings.storage.totalSize', 'Total Size')} value={formatBytes(stats.totalBytes)} />
          <StorageStat label={t('settings.storage.workspaces', 'Workspaces')} value={String(stats.workspaceCount)} />
          <StorageStat label={t('settings.storage.referenced', 'Referenced')} value={String(stats.referencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.unreferenced', 'Unreferenced')} value={String(stats.unreferencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.stale', 'Stale')} value={String(stats.staleWorkspaceCount)} />
          <StorageStat label={t('settings.storage.retention', 'Retention')} value={t('settings.storage.retentionDays', '{{days}} days', { days: String(stats.staleThresholdDays) })} />
        </div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.storage.sandboxNote', 'Sandbox threads write into a private Cowork workspace under {{root}}. Older unreferenced workspaces are pruned automatically, and you can run cleanup manually here.', { root: stats.root })}
        </div>
      </div>

      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-text">{t('settings.storage.cleanup', 'Cleanup')}</div>
        <div className="flex flex-col gap-3">
          <button
            onClick={() => void onCleanup('old-unreferenced')}
            className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'old-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearOld', 'Clear old sandbox artifacts')}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.storage.clearOldDescription', 'Removes unreferenced sandbox workspaces older than {{days}} days.', { days: String(stats.staleThresholdDays) })}
            </div>
          </button>

          <button
            onClick={() => void onCleanup('all-unreferenced')}
            className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover"
            disabled={runningCleanup !== null}
          >
            <div className="text-[12px] font-semibold text-text">
              {runningCleanup === 'all-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearAll', 'Clear all unused sandbox artifacts')}
            </div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.storage.clearAllDescription', 'Removes every unreferenced sandbox workspace while keeping active thread workspaces intact.')}
            </div>
          </button>
        </div>

        {lastCleanup ? (
          <div className="rounded-xl border border-border-subtle bg-base px-3 py-3 text-[11px] text-text-muted">
            {t('settings.storage.lastCleanup', 'Last cleanup removed {{count}} workspace(s) and freed {{size}}.', {
              count: String(lastCleanup.removedWorkspaces),
              size: formatBytes(lastCleanup.removedBytes),
            })}
          </div>
        ) : null}
      </div>

      <span className={sectionLabelCls}>{t('settings.updates.header', 'Updates')}</span>
      <div className={panelCardCls}>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] font-semibold text-text">{t('settings.updates.checkForUpdates', 'Check for updates')}</div>
          {currentVersion ? (
            <div className="text-[10px] text-text-muted font-mono">v{currentVersion}</div>
          ) : null}
        </div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.updates.description', "Queries the public GitHub Releases API for the latest published version. Read-only — there's no auto-download or auto-install.")}
        </div>
        <button
          onClick={() => void handleCheckForUpdates()}
          disabled={updateStatus.kind === 'checking'}
          className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
        >
          <div className="text-[12px] font-semibold text-text">
            {updateStatus.kind === 'checking' ? t('settings.updates.checking', 'Checking…')
              : updateStatus.kind === 'available' ? t('settings.updates.newAvailable', 'New version available: {{version}}', { version: updateStatus.latest })
                : updateStatus.kind === 'current' ? t('settings.updates.upToDate', 'You’re on the latest version ({{version}})', { version: updateStatus.version })
                  : updateStatus.kind === 'disabled' ? t('settings.updates.unavailable', 'Update check unavailable')
                    : updateStatus.kind === 'error' ? t('settings.updates.failed', 'Could not check for updates')
                      : t('settings.updates.checkForUpdates', 'Check for updates')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {updateStatus.kind === 'available' ? t('settings.updates.currentHint', 'You’re on {{version}}. Click below to open the release notes.', { version: updateStatus.current })
              : updateStatus.kind === 'disabled' ? updateStatus.message
                : updateStatus.kind === 'error' ? updateStatus.message
                  : t('settings.updates.hint', 'Opens the GitHub release page if a newer build is available.')}
          </div>
        </button>
        {updateStatus.kind === 'available' ? (
          <a
            href={updateStatus.url}
            onClick={(event) => {
              event.preventDefault()
              void window.coworkApi.dialog // kept in scope only for type hint
              // Use a custom protocol-less href so Electron routes via
              // shell.openExternal instead of trying to navigate the
              // renderer. The click handler is a safety net if the
              // default anchor behavior would try to replace the page.
              const targetHref = updateStatus.url
              try {
                // Electron's open-external is exposed through a menu
                // click path normally — here we fall back to
                // window.open which Electron re-routes through
                // setWindowOpenHandler → shell.openExternal.
                window.open(targetHref, '_blank')
              } catch {
                /* no-op */
              }
            }}
            className="w-full text-center rounded-2xl border border-accent/40 p-3 text-[12px] font-semibold text-accent hover:bg-surface-hover cursor-pointer"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('settings.updates.openReleaseNotes', 'Open release notes')}
          </a>
        ) : null}
      </div>

      <span className={sectionLabelCls}>{t('settings.reset.header', 'Reset')}</span>
      <div className={panelCardCls}>
        <div className="text-[12px] font-semibold text-red">{t('settings.reset.title', 'Reset all app data')}</div>
        <div className="text-[11px] text-text-muted leading-relaxed">
          {t('settings.reset.description', 'Deletes every thread, credential, custom agent, skill, and MCP from this machine. The app relaunches into the first-run flow. Useful before uninstalling or for a clean-slate downstream demo; destructive and cannot be undone.')}
        </div>
        <button
          onClick={() => void handleResetAppData()}
          disabled={resetting}
          className="w-full text-start rounded-2xl border p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
          style={{
            borderColor: 'color-mix(in srgb, var(--color-red) 40%, var(--color-border-subtle))',
            background: 'color-mix(in srgb, var(--color-red) 6%, transparent)',
          }}
        >
          <div className="text-[12px] font-semibold" style={{ color: 'var(--color-red)' }}>
            {resetting ? t('settings.reset.resetting', 'Resetting…') : t('settings.reset.button', 'Reset app data')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t('settings.reset.requiresConfirm', 'Requires explicit confirmation. The app will close and relaunch.')}
          </div>
        </button>
      </div>
    </div>
  )
}
