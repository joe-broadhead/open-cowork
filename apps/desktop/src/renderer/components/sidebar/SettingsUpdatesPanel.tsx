import { useEffect, useSyncExternalStore } from 'react'
import type {
  UpdateInstallCapability,
  UpdateInstallEvent,
  UpdateInstallStatus,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'

const panelCardCls = 'rounded-2xl border border-border-subtle p-4 flex flex-col gap-4'

type ManualUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; current: string; latest: string; url: string }
  | { kind: 'disabled'; message: string }
  | { kind: 'error'; message: string }

type UpdateAction = 'idle' | 'checking' | 'downloading' | 'installing'

interface SettingsUpdatesState {
  action: UpdateAction
  capability: UpdateInstallCapability | null
  currentVersion: string | null
  installStatus: UpdateInstallStatus | null
  manualStatus: ManualUpdateStatus
}

const initialUpdatesState: SettingsUpdatesState = {
  action: 'idle',
  capability: null,
  currentVersion: null,
  installStatus: null,
  manualStatus: { kind: 'idle' },
}

let updatesState: SettingsUpdatesState = initialUpdatesState
let initialized = false
let installEventUnsubscribe: (() => void) | null = null
const subscribers = new Set<() => void>()

function subscribe(callback: () => void) {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

function getSnapshot() {
  return updatesState
}

function setUpdatesState(
  updater: Partial<SettingsUpdatesState> | ((current: SettingsUpdatesState) => SettingsUpdatesState),
) {
  updatesState = typeof updater === 'function'
    ? updater(updatesState)
    : { ...updatesState, ...updater }
  for (const subscriber of subscribers) subscriber()
}

function applyInstallEvent(event: UpdateInstallEvent) {
  setUpdatesState((current) => ({
    ...current,
    action: event.status === 'downloading'
      ? 'downloading'
      : event.status === 'installing'
        ? 'installing'
        : 'idle',
    currentVersion: event.currentVersion || current.currentVersion,
    installStatus: event,
  }))
}

function ensureInstallEventSubscription() {
  if (installEventUnsubscribe) return
  installEventUnsubscribe = window.coworkApi.updates.onInstallEvent(applyInstallEvent)
}

function initializeUpdatesState() {
  if (initialized) return
  initialized = true
  ensureInstallEventSubscription()
  window.coworkApi.app.metadata()
    .then((metadata) => {
      setUpdatesState((current) => ({
        ...current,
        currentVersion: current.currentVersion || metadata.version,
      }))
    })
    .catch(() => {
      // Version metadata is a display hint; explicit update checks still work.
    })
  window.coworkApi.updates.installCapability()
    .then((capability) => {
      setUpdatesState((current) => ({
        ...current,
        capability,
        currentVersion: current.currentVersion || capability.currentVersion,
      }))
    })
    .catch((error) => {
      setUpdatesState((current) => ({
        ...current,
        manualStatus: {
          kind: 'error',
          message: error instanceof Error
            ? error.message
            : t('settings.updates.capabilityFailed', 'Could not load update install capability.'),
        },
      }))
    })
}

function useSettingsUpdatesState() {
  useEffect(() => {
    initializeUpdatesState()
  }, [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function describeInstallCapability(capability: UpdateInstallCapability) {
  if (capability.supported) {
    return t('settings.updates.installSupported', 'This signed macOS build can download and install signed updates from Settings.')
  }
  switch (capability.reason) {
    case 'dev':
      return t('settings.updates.installUnsupportedDev', 'In-app installation is disabled while running from source. Use the manual release link for packaged builds.')
    case 'platform':
      return t('settings.updates.installUnsupportedPlatform', 'In-app installation is currently limited to signed macOS releases. Use the manual release link on this platform.')
    case 'unsigned':
      return t('settings.updates.installUnsupportedUnsigned', 'This build is not signed for in-app update installation, so updates stay manual.')
    case 'missing-feed':
      return t('settings.updates.installUnsupportedFeed', 'This build does not include signed update feed metadata, so updates stay manual.')
    default:
      return t('settings.updates.installUnsupportedGeneric', 'In-app installation is unavailable for this build. Use the manual release link.')
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function formatProgress(status: Extract<UpdateInstallStatus, { status: 'downloading' }>) {
  const percent = Math.round(status.progress.percent)
  return t('settings.updates.downloadProgress', 'Downloading {{percent}}% · {{transferred}} of {{total}}', {
    percent: String(percent),
    transferred: formatBytes(status.progress.transferred),
    total: status.progress.total > 0 ? formatBytes(status.progress.total) : t('settings.updates.unknownSize', 'unknown size'),
  })
}

function manualReleaseUrl(state: SettingsUpdatesState) {
  if (state.manualStatus.kind === 'available') return state.manualStatus.url
  return state.capability?.manualReleaseUrl || null
}

function latestVersion(state: SettingsUpdatesState) {
  const status = state.installStatus
  if (status && 'latestVersion' in status && status.latestVersion) return status.latestVersion
  if (state.manualStatus.kind === 'available') return state.manualStatus.latest
  if (state.manualStatus.kind === 'current') return state.manualStatus.version
  return null
}

function statusTitle(state: SettingsUpdatesState) {
  if (state.action === 'checking') return t('settings.updates.checking', 'Checking…')
  if (state.installStatus?.status === 'downloading') return t('settings.updates.downloading', 'Downloading update')
  if (state.installStatus?.status === 'downloaded') return t('settings.updates.readyToInstall', 'Update ready to install')
  if (state.installStatus?.status === 'installing') return t('settings.updates.installing', 'Restarting to install')
  if (state.installStatus?.status === 'available') return t('settings.updates.newAvailable', 'New version available: {{version}}', { version: state.installStatus.latestVersion })
  if (state.installStatus?.status === 'not-available') return t('settings.updates.noInstallableUpdate', 'No signed update is available')
  if (state.installStatus?.status === 'error') return t('settings.updates.installFailed', 'Update installation failed')
  if (state.manualStatus.kind === 'available') return t('settings.updates.newAvailable', 'New version available: {{version}}', { version: state.manualStatus.latest })
  if (state.manualStatus.kind === 'current') return t('settings.updates.upToDate', 'You’re on the latest version ({{version}})', { version: state.manualStatus.version })
  if (state.manualStatus.kind === 'disabled') return t('settings.updates.unavailable', 'Update check unavailable')
  if (state.manualStatus.kind === 'error') return t('settings.updates.failed', 'Could not check for updates')
  return t('settings.updates.readyToCheck', 'Ready to check for updates')
}

function statusDetail(state: SettingsUpdatesState) {
  const status = state.installStatus
  if (status?.status === 'downloading') {
    return t('settings.updates.downloadingHint', 'Download is in progress. You can leave Settings; progress will keep updating here.')
  }
  if (status?.status === 'downloaded') {
    return t('settings.updates.downloadedHint', 'Version {{version}} has downloaded. Restart when you are ready to install it.', { version: status.latestVersion })
  }
  if (status?.status === 'installing') {
    return t('settings.updates.installingHint', 'The app will close and finish installing version {{version}}.', { version: status.latestVersion })
  }
  if (status?.status === 'available') {
    return t('settings.updates.downloadHint', 'Version {{version}} can be downloaded now. Nothing installs until you restart from this panel.', { version: status.latestVersion })
  }
  if (status?.status === 'not-available') {
    return t('settings.updates.currentSignedHint', 'This signed build is current for the configured update feed.')
  }
  if (status?.status === 'unsupported') return describeInstallCapability({
    supported: false,
    reason: status.reason,
    currentVersion: status.currentVersion,
    manualReleaseUrl: status.manualReleaseUrl,
  })
  if (status?.status === 'error') return status.message
  if (state.manualStatus.kind === 'available') {
    return t('settings.updates.currentHint', 'You’re on {{version}}. Open release notes or download in app when supported.', { version: state.manualStatus.current })
  }
  if (state.manualStatus.kind === 'disabled') return state.manualStatus.message
  if (state.manualStatus.kind === 'error') return state.manualStatus.message
  return t('settings.updates.hint', 'Checks GitHub Releases and, on signed macOS builds, enables an explicit download and restart-to-install flow.')
}

async function refreshCapability() {
  const capability = await window.coworkApi.updates.installCapability()
  setUpdatesState((current) => ({
    ...current,
    capability,
    currentVersion: current.currentVersion || capability.currentVersion,
  }))
  return capability
}

function manualStatusFromResult(result: Awaited<ReturnType<typeof window.coworkApi.app.checkUpdates>>): ManualUpdateStatus {
  if (result.status === 'disabled') return { kind: 'disabled', message: result.message }
  if (result.status === 'error') return { kind: 'error', message: result.message }
  if (result.hasUpdate) {
    return {
      kind: 'available',
      current: result.currentVersion,
      latest: result.latestVersion,
      url: result.releaseUrl,
    }
  }
  return { kind: 'current', version: result.currentVersion }
}

async function checkForUpdates() {
  setUpdatesState({ action: 'checking', manualStatus: { kind: 'checking' } })
  let capability: UpdateInstallCapability | null = null
  try {
    capability = await refreshCapability()
  } catch (error) {
    setUpdatesState((current) => ({
      ...current,
      capability: current.capability,
      manualStatus: {
        kind: 'error',
        message: error instanceof Error
          ? error.message
          : t('settings.updates.capabilityFailed', 'Could not load update install capability.'),
      },
    }))
  }

  try {
    const result = await window.coworkApi.app.checkUpdates()
    setUpdatesState((current) => ({
      ...current,
      currentVersion: result.currentVersion,
      manualStatus: manualStatusFromResult(result),
    }))
  } catch (error) {
    setUpdatesState((current) => ({
      ...current,
      manualStatus: {
        kind: 'error',
        message: error instanceof Error ? error.message : t('settings.updates.checkFailedGeneric', 'Failed to check for updates.'),
      },
    }))
  }

  if (capability?.supported) {
    try {
      const status = await window.coworkApi.updates.checkInstallable()
      setUpdatesState((current) => ({
        ...current,
        currentVersion: status.currentVersion || current.currentVersion,
        installStatus: status,
      }))
    } catch (error) {
      setUpdatesState((current) => ({
        ...current,
        installStatus: {
          status: 'error',
          currentVersion: current.currentVersion || capability.currentVersion,
          message: error instanceof Error
            ? error.message
            : t('settings.updates.checkFailedGeneric', 'Failed to check for updates.'),
          manualReleaseUrl: capability.manualReleaseUrl,
        },
      }))
    }
  }
  setUpdatesState((current) => ({
    ...current,
    action: current.installStatus?.status === 'installing' ? 'installing' : 'idle',
  }))
}

async function downloadUpdate() {
  setUpdatesState({ action: 'downloading' })
  try {
    const status = await window.coworkApi.updates.download()
    setUpdatesState((current) => ({
      ...current,
      action: status.status === 'downloading' ? 'downloading' : 'idle',
      installStatus: status,
    }))
  } catch (error) {
    setUpdatesState((current) => ({
      ...current,
      action: 'idle',
      installStatus: {
        status: 'error',
        currentVersion: current.currentVersion || current.capability?.currentVersion || 'unknown',
        message: error instanceof Error ? error.message : t('settings.updates.downloadFailedGeneric', 'Failed to download the update.'),
        manualReleaseUrl: current.capability?.manualReleaseUrl || null,
      },
    }))
  }
}

async function restartToInstall() {
  setUpdatesState({ action: 'installing' })
  try {
    const status = await window.coworkApi.updates.quitAndInstall()
    setUpdatesState((current) => ({
      ...current,
      action: 'installing',
      installStatus: status,
    }))
  } catch (error) {
    setUpdatesState((current) => ({
      ...current,
      action: 'idle',
      installStatus: {
        status: 'error',
        currentVersion: current.currentVersion || current.capability?.currentVersion || 'unknown',
        message: error instanceof Error ? error.message : t('settings.updates.installFailedGeneric', 'Failed to restart and install the update.'),
        manualReleaseUrl: current.capability?.manualReleaseUrl || null,
      },
    }))
  }
}

function openReleaseNotes(url: string) {
  try {
    window.open(url, '_blank')
  } catch {
    // Electron routes normal _blank windows through shell.openExternal.
  }
}

export function resetSettingsUpdatesPanelStateForTests() {
  installEventUnsubscribe?.()
  installEventUnsubscribe = null
  initialized = false
  updatesState = initialUpdatesState
  subscribers.clear()
}

export function SettingsUpdatesPanel() {
  const state = useSettingsUpdatesState()
  const releaseUrl = manualReleaseUrl(state)
  const canDownload = state.capability?.supported === true
    && state.installStatus?.status === 'available'
    && state.action !== 'checking'
    && state.action !== 'downloading'
  const canRestart = state.capability?.supported === true
    && state.installStatus?.status === 'downloaded'
    && state.action !== 'checking'
    && state.action !== 'downloading'
  const progress = state.installStatus?.status === 'downloading' ? state.installStatus.progress : null
  const latest = latestVersion(state)

  return (
    <div className={panelCardCls}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] font-semibold text-text">{t('settings.updates.installTitle', 'Install updates')}</div>
        {state.currentVersion ? (
          <div className="text-[10px] text-text-muted font-mono">v{state.currentVersion}</div>
        ) : null}
      </div>
      <div className="text-[11px] text-text-muted leading-relaxed">
        {t('settings.updates.description', 'Check releases manually, then download and restart only when this signed build supports in-app installation.')}
      </div>
      {state.capability ? (
        <div className="rounded-xl border border-border-subtle bg-base px-3 py-2.5 text-[11px] leading-relaxed text-text-muted">
          {describeInstallCapability(state.capability)}
        </div>
      ) : null}

      <div className="rounded-2xl border border-border-subtle bg-base p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-text">{statusTitle(state)}</div>
            <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{statusDetail(state)}</div>
          </div>
          {latest ? (
            <div className="shrink-0 rounded-full border border-border-subtle px-2 py-1 text-[10px] font-mono text-text-muted">
              v{latest}
            </div>
          ) : null}
        </div>
        {progress ? (
          <div className="mt-3">
            <div
              role="progressbar"
              aria-label={t('settings.updates.progressLabel', 'Update download progress')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.percent)}
              className="h-2 overflow-hidden rounded-full bg-surface"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-text-muted">{formatProgress(state.installStatus as Extract<UpdateInstallStatus, { status: 'downloading' }>)}</div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={() => void checkForUpdates()}
          disabled={state.action === 'checking' || state.action === 'downloading' || state.action === 'installing'}
          className="w-full text-start rounded-2xl border border-border-subtle p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
        >
          <div className="text-[12px] font-semibold text-text">
            {state.action === 'checking' ? t('settings.updates.checking', 'Checking…') : t('settings.updates.checkForUpdates', 'Check for updates')}
          </div>
          <div className="text-[11px] text-text-muted mt-1">
            {t('settings.updates.checkButtonHint', 'Looks for a newer release and checks whether this build can install it in app.')}
          </div>
        </button>

        {canDownload ? (
          <button
            onClick={() => void downloadUpdate()}
            disabled={state.action !== 'idle'}
            className="w-full text-start rounded-2xl border border-accent/40 p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
          >
            <div className="text-[12px] font-semibold text-accent">{t('settings.updates.downloadUpdate', 'Download update')}</div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.updates.downloadButtonHint', 'Downloads the signed update now. Installation waits for your restart confirmation.')}
            </div>
          </button>
        ) : null}

        {canRestart ? (
          <button
            onClick={() => void restartToInstall()}
            disabled={state.action !== 'idle'}
            className="w-full text-start rounded-2xl border border-accent/40 p-3 transition-colors cursor-pointer hover:bg-surface-hover disabled:opacity-60 disabled:cursor-wait"
          >
            <div className="text-[12px] font-semibold text-accent">{t('settings.updates.restartToInstall', 'Restart to install')}</div>
            <div className="text-[11px] text-text-muted mt-1">
              {t('settings.updates.restartButtonHint', 'Closes Open Cowork and completes the signed update installation.')}
            </div>
          </button>
        ) : null}

        {releaseUrl ? (
          <button
            type="button"
            onClick={() => openReleaseNotes(releaseUrl)}
            className="w-full text-center rounded-2xl border border-border-subtle p-3 text-[12px] font-semibold text-text hover:bg-surface-hover cursor-pointer"
          >
            {state.manualStatus.kind === 'available'
              ? t('settings.updates.openReleaseNotes', 'Open release notes')
              : t('settings.updates.openReleases', 'Open releases')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
