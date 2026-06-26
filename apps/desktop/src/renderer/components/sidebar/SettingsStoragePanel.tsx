import { useEffect, useRef, useState } from 'react'
import type {
  SandboxCleanupResult,
  SandboxStorageStats,
} from '@open-cowork/shared'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { confirmAppReset } from '../../helpers/destructive-actions'
import { t } from '../../helpers/i18n'
import { useSessionStore } from '../../stores/session'
import { Card, toast } from '../ui'
import { SettingsUpdatesPanel } from './SettingsUpdatesPanel'
import { sectionLabelCls } from './settings-panel-styles'

function StorageStat({ label, value }: { label: string; value: string }) {
  return (
    <Card variant="flat" padding="sm">
      <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-sm font-medium text-text">{value}</div>
    </Card>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function describeStorageError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportStorageError(error: unknown, scope: string) {
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${scope}: ${describeStorageError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'settings-storage',
    })
  } catch {
    // Diagnostics are best-effort from a storage recovery path.
  }
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
  const [resetting, setResetting] = useState(false)
  const diagnosticsResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)

  useEffect(() => () => {
    if (diagnosticsResetTimerRef.current) clearTimeout(diagnosticsResetTimerRef.current)
  }, [])

  const scheduleDiagnosticsIdle = () => {
    if (diagnosticsResetTimerRef.current) clearTimeout(diagnosticsResetTimerRef.current)
    diagnosticsResetTimerRef.current = setTimeout(() => {
      diagnosticsResetTimerRef.current = null
      setDiagnosticsStatus('idle')
    }, 3_000)
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
      toast({ tone: 'error', message: t('settings.updates.resetFailed', 'Could not reset app data: {{message}}', { message }) })
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
      scheduleDiagnosticsIdle()
    } catch (err) {
      addGlobalError(t('settings.storage.exportDiagnosticsFailed', 'Could not export diagnostics. Please try again.'))
      reportStorageError(err, 'Failed to export diagnostics')
      setDiagnosticsStatus('error')
      scheduleDiagnosticsIdle()
    }
  }

  if (!stats) {
    return (
      <Card className="flex flex-col gap-4">
        <div className="text-xs text-text-muted">{t('settings.storage.loading', 'Loading sandbox storage…')}</div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-4">
        <div className="text-xs font-semibold text-text">{t('settings.storage.supportDiagnostics', 'Support Diagnostics')}</div>
        <div className="text-2xs text-text-muted leading-relaxed">
          {t('settings.storage.supportDescription', "Copies a plaintext report (config, runtime inputs, recent log lines) to your clipboard. Credentials are masked / redacted so it's safe to paste into a bug report.")}
        </div>
        <Card
          interactive
          onClick={() => void handleExportDiagnostics()}
          disabled={diagnosticsStatus === 'working'}
          className="settings-action-card"
        >
          <div className="text-xs font-semibold text-text">
            {diagnosticsStatus === 'working'
              ? t('settings.storage.preparing', 'Preparing…')
              : diagnosticsStatus === 'copied'
                ? t('settings.storage.copied', 'Copied to clipboard')
                : diagnosticsStatus === 'error'
                  ? t('settings.storage.copyFailed', 'Could not build diagnostics — try again')
                  : t('settings.storage.copyDiagnostics', 'Copy diagnostics to clipboard')}
          </div>
          <div className="text-2xs text-text-muted mt-1">
            {t('settings.storage.diagnosticsHint', 'Useful when filing an issue — include this bundle in your report.')}
          </div>
        </Card>
      </Card>

      <span className={sectionLabelCls}>{t('settings.storage.sandboxStorage', 'Sandbox Storage')}</span>
      <Card className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <StorageStat label={t('settings.storage.totalSize', 'Total Size')} value={formatBytes(stats.totalBytes)} />
          <StorageStat label={t('settings.storage.workspaces', 'Workspaces')} value={String(stats.workspaceCount)} />
          <StorageStat label={t('settings.storage.referenced', 'Referenced')} value={String(stats.referencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.unreferenced', 'Unreferenced')} value={String(stats.unreferencedWorkspaceCount)} />
          <StorageStat label={t('settings.storage.stale', 'Stale')} value={String(stats.staleWorkspaceCount)} />
          <StorageStat label={t('settings.storage.retention', 'Retention')} value={t('settings.storage.retentionDays', '{{days}} days', { days: String(stats.staleThresholdDays) })} />
        </div>
        <div className="text-2xs text-text-muted leading-relaxed">
          {t('settings.storage.sandboxNote', 'Sandbox threads write into a private Cowork workspace under {{root}}. Older unreferenced workspaces are pruned automatically, and you can run cleanup manually here.', { root: stats.root })}
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="text-xs font-semibold text-text">{t('settings.storage.cleanup', 'Cleanup')}</div>
        <div className="flex flex-col gap-3">
          <Card
            interactive
            onClick={() => void onCleanup('old-unreferenced')}
            disabled={runningCleanup !== null}
            className="settings-action-card"
          >
            <div className="text-xs font-semibold text-text">
              {runningCleanup === 'old-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearOld', 'Clear old sandbox artifacts')}
            </div>
            <div className="text-2xs text-text-muted mt-1">
              {t('settings.storage.clearOldDescription', 'Removes unreferenced sandbox workspaces older than {{days}} days.', { days: String(stats.staleThresholdDays) })}
            </div>
          </Card>

          <Card
            interactive
            onClick={() => void onCleanup('all-unreferenced')}
            disabled={runningCleanup !== null}
            className="settings-action-card"
          >
            <div className="text-xs font-semibold text-text">
              {runningCleanup === 'all-unreferenced' ? t('settings.storage.cleaning', 'Cleaning…') : t('settings.storage.clearAll', 'Clear all unused sandbox artifacts')}
            </div>
            <div className="text-2xs text-text-muted mt-1">
              {t('settings.storage.clearAllDescription', 'Removes every unreferenced sandbox workspace while keeping active thread workspaces intact.')}
            </div>
          </Card>
        </div>

        {lastCleanup ? (
          <Card variant="flat" padding="sm" className="text-2xs text-text-muted">
            {t('settings.storage.lastCleanup', 'Last cleanup removed {{count}} workspace(s) and freed {{size}}.', {
              count: String(lastCleanup.removedWorkspaces),
              size: formatBytes(lastCleanup.removedBytes),
            })}
          </Card>
        ) : null}
      </Card>

      <span className={sectionLabelCls}>{t('settings.updates.header', 'Updates')}</span>
      <SettingsUpdatesPanel />

      <span className={sectionLabelCls}>{t('settings.reset.header', 'Reset')}</span>
      <Card className="flex flex-col gap-4">
        <div className="text-xs font-semibold text-red">{t('settings.reset.title', 'Reset all app data')}</div>
        <div className="text-2xs text-text-muted leading-relaxed">
          {t('settings.reset.description', 'Deletes every thread, credential, custom agent, skill, and MCP from this machine. The app relaunches into the first-run flow. Useful before uninstalling or for a clean-slate downstream demo; destructive and cannot be undone.')}
        </div>
        <Card
          interactive
          onClick={() => void handleResetAppData()}
          disabled={resetting}
          className="settings-action-card settings-danger-card"
        >
          <div className="text-xs font-semibold text-red">
            {resetting ? t('settings.reset.resetting', 'Resetting…') : t('settings.reset.button', 'Reset app data')}
          </div>
          <div className="text-2xs text-text-muted mt-1">
            {t('settings.reset.requiresConfirm', 'Requires explicit confirmation. The app will close and relaunch.')}
          </div>
        </Card>
      </Card>
    </div>
  )
}
