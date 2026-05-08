import electron from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  UpdateInstallCapability,
  UpdateInstallEvent,
  UpdateInstallProgress,
  UpdateInstallStatus,
  UpdateInstallUnsupportedReason,
} from '@open-cowork/shared'
import type {
  AppUpdater,
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater'
import { getBranding } from './config-loader.ts'
import { log } from './logger.ts'
import { getCurrentVersion, parseGithubRepo } from './update-check.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const updateInstallCapabilityResourceName = 'open-cowork-update-capability.json'
const updateInstallEventSubscribers = new Set<(event: UpdateInstallEvent) => void>()
const configuredUpdaters = new WeakSet<UpdateInstallRuntime>()
let availableUpdateVersion: string | null = null
let downloadedUpdateVersion: string | null = null

interface UpdateInstallCapabilityResource {
  signedInstallEligible: boolean
  feedConfigured: boolean
}

type UpdateInstallRuntime = Pick<AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
  | 'on'
> & {
  logger: AppUpdater['logger']
}

type UpdateServiceOptions = {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  signedInstallEligible?: boolean
  feedConfigured?: boolean
  currentVersion?: string
  manualReleaseUrl?: string | null
  resourcePath?: string | null
}

type UpdateActionOptions = UpdateServiceOptions & {
  updater?: UpdateInstallRuntime
}

function manualReleaseUrlFromHelpUrl(helpUrl?: string | null): string | null {
  const trimmed = helpUrl?.trim()
  if (!trimmed) return null
  const repo = parseGithubRepo(trimmed)
  if (repo) return `https://github.com/${repo.owner}/${repo.repo}/releases`
  return trimmed
}

function reasonCapability(input: {
  isPackaged: boolean
  platform: NodeJS.Platform
  signedInstallEligible: boolean
  feedConfigured: boolean
}): UpdateInstallUnsupportedReason | null {
  if (!input.isPackaged) return 'dev'
  if (input.platform !== 'darwin') return 'platform'
  if (!input.signedInstallEligible) return 'unsigned'
  if (!input.feedConfigured) return 'missing-feed'
  return null
}

function normalizeEmbeddedCapability(value: unknown): UpdateInstallCapabilityResource | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return null
  return {
    signedInstallEligible: record.signedInstallEligible === true,
    feedConfigured: record.feedConfigured === true,
  }
}

function readEmbeddedUpdateInstallCapability(resourcePath?: string | null): UpdateInstallCapabilityResource {
  const defaultResourcePath = typeof process.resourcesPath === 'string'
    ? join(process.resourcesPath, updateInstallCapabilityResourceName)
    : null
  const resolvedPath = resourcePath === undefined ? defaultResourcePath : resourcePath
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return { signedInstallEligible: false, feedConfigured: false }
  }
  try {
    const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as unknown
    return normalizeEmbeddedCapability(parsed) || { signedInstallEligible: false, feedConfigured: false }
  } catch {
    return { signedInstallEligible: false, feedConfigured: false }
  }
}

function safeMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Update installation failed.'
}

function updateInfoVersion(info?: Pick<UpdateInfo, 'version'> | null) {
  return typeof info?.version === 'string' && info.version.trim() ? info.version.trim() : null
}

function normalizeProgress(info: ProgressInfo): UpdateInstallProgress {
  return {
    percent: Math.max(0, Math.min(100, Number.isFinite(info.percent) ? info.percent : 0)),
    transferred: Math.max(0, Number.isFinite(info.transferred) ? Math.round(info.transferred) : 0),
    total: Math.max(0, Number.isFinite(info.total) ? Math.round(info.total) : 0),
    bytesPerSecond: Math.max(0, Number.isFinite(info.bytesPerSecond) ? Math.round(info.bytesPerSecond) : 0),
  }
}

function publishUpdateInstallEvent(event: UpdateInstallEvent) {
  for (const subscriber of updateInstallEventSubscribers) {
    try {
      subscriber(event)
    } catch (error) {
      log('error', `updates.install event subscriber failed: ${safeMessage(error)}`)
    }
  }
}

function unsupportedStatus(capability: UpdateInstallCapability): UpdateInstallStatus & {
  status: 'unsupported'
  reason: UpdateInstallUnsupportedReason
} {
  return {
    status: 'unsupported',
    reason: capability.reason || 'unavailable',
    currentVersion: capability.currentVersion,
    manualReleaseUrl: capability.manualReleaseUrl,
  }
}

function statusFromUpdateInfo(
  status: Extract<UpdateInstallStatus['status'], 'available' | 'downloaded' | 'installing' | 'not-available'>,
  capability: UpdateInstallCapability,
  info?: Pick<UpdateInfo, 'version'> | null,
): UpdateInstallStatus & { latestVersion: string } {
  return {
    status,
    currentVersion: capability.currentVersion,
    latestVersion: updateInfoVersion(info) || capability.currentVersion,
    manualReleaseUrl: capability.manualReleaseUrl,
  }
}

function errorStatus(capability: UpdateInstallCapability, error: unknown): UpdateInstallStatus & {
  status: 'error'
  message: string
} {
  return {
    status: 'error',
    currentVersion: capability.currentVersion,
    message: safeMessage(error),
    manualReleaseUrl: capability.manualReleaseUrl,
  }
}

function configureUpdater(updater: UpdateInstallRuntime, capability: UpdateInstallCapability) {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = {
    info: (message?: unknown) => log('updates', String(message ?? '')),
    warn: (message?: unknown) => log('updates', `warning: ${String(message ?? '')}`),
    error: (message?: unknown) => log('error', `updates: ${String(message ?? '')}`),
  }
  if (configuredUpdaters.has(updater)) return
  configuredUpdaters.add(updater)
  updater.on('checking-for-update', () => {
    publishUpdateInstallEvent({
      status: 'checking',
      currentVersion: capability.currentVersion,
      manualReleaseUrl: capability.manualReleaseUrl,
    })
  })
  updater.on('download-progress', (info: ProgressInfo) => {
    publishUpdateInstallEvent({
      status: 'downloading',
      currentVersion: capability.currentVersion,
      latestVersion: availableUpdateVersion || downloadedUpdateVersion || capability.currentVersion,
      progress: normalizeProgress(info),
      manualReleaseUrl: capability.manualReleaseUrl,
    })
  })
  updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    downloadedUpdateVersion = updateInfoVersion(event) || downloadedUpdateVersion || capability.currentVersion
    publishUpdateInstallEvent(statusFromUpdateInfo('downloaded', capability, event))
  })
  updater.on('update-cancelled', (info: UpdateInfo) => {
    publishUpdateInstallEvent({
      status: 'error',
      currentVersion: capability.currentVersion,
      latestVersion: updateInfoVersion(info) || undefined,
      message: 'Update download was cancelled.',
      manualReleaseUrl: capability.manualReleaseUrl,
    })
  })
  updater.on('error', (error: Error) => {
    log('error', `updates.install failed: ${safeMessage(error)}`)
    publishUpdateInstallEvent(errorStatus(capability, error))
  })
}

async function getDefaultUpdater(): Promise<UpdateInstallRuntime> {
  const { autoUpdater } = await import('electron-updater')
  return autoUpdater
}

async function getGuardedUpdater(options: UpdateActionOptions = {}) {
  const capability = await getUpdateInstallCapability(options)
  if (!capability.supported) {
    const status = unsupportedStatus(capability)
    publishUpdateInstallEvent(status)
    return { capability, status, updater: null }
  }
  const updater = options.updater || await getDefaultUpdater()
  configureUpdater(updater, capability)
  return { capability, status: null, updater }
}

function assertSupportedGuard(result: Awaited<ReturnType<typeof getGuardedUpdater>>) {
  if (!result.updater) {
    const reason = result.status?.status === 'unsupported' ? result.status.reason : 'unavailable'
    throw new Error(`In-app update installation is not available for this build (${reason}).`)
  }
  return result.updater
}

export async function getUpdateInstallCapability(options?: UpdateServiceOptions): Promise<UpdateInstallCapability> {
  const embedded = readEmbeddedUpdateInstallCapability(options?.resourcePath)
  const currentVersion = options?.currentVersion ?? await getCurrentVersion()
  const manualReleaseUrl = options && 'manualReleaseUrl' in options
    ? options.manualReleaseUrl ?? null
    : manualReleaseUrlFromHelpUrl(getBranding().helpUrl)
  const reason = reasonCapability({
    isPackaged: options?.isPackaged ?? (electronApp?.isPackaged === true),
    platform: options?.platform ?? process.platform,
    signedInstallEligible: options?.signedInstallEligible ?? embedded.signedInstallEligible,
    feedConfigured: options?.feedConfigured ?? embedded.feedConfigured,
  })
  if (reason) {
    return {
      supported: false,
      reason,
      currentVersion,
      manualReleaseUrl,
    }
  }
  return {
    supported: true,
    currentVersion,
    manualReleaseUrl,
  }
}

export function subscribeUpdateInstallEvents(subscriber: (event: UpdateInstallEvent) => void) {
  updateInstallEventSubscribers.add(subscriber)
  return () => {
    updateInstallEventSubscribers.delete(subscriber)
  }
}

export async function checkInstallableUpdate(options?: UpdateActionOptions): Promise<UpdateInstallStatus> {
  const guard = await getGuardedUpdater(options)
  if (guard.status) return guard.status
  const updater = assertSupportedGuard(guard)
  try {
    const result = await updater.checkForUpdates()
    if (!result) {
      const status: UpdateInstallStatus = {
        status: 'error',
        currentVersion: guard.capability.currentVersion,
        message: 'Update provider is unavailable for this build.',
        manualReleaseUrl: guard.capability.manualReleaseUrl,
      }
      publishUpdateInstallEvent(status)
      return status
    }
    const status = result.isUpdateAvailable
      ? statusFromUpdateInfo('available', guard.capability, result.updateInfo)
      : statusFromUpdateInfo('not-available', guard.capability, result.updateInfo)
    availableUpdateVersion = status.status === 'available' ? status.latestVersion : null
    publishUpdateInstallEvent(status)
    return status
  } catch (error) {
    log('error', `updates.check-installable failed: ${safeMessage(error)}`)
    const status = errorStatus(guard.capability, error)
    publishUpdateInstallEvent(status)
    return status
  }
}

export async function downloadInstallableUpdate(options?: UpdateActionOptions): Promise<UpdateInstallStatus> {
  const guard = await getGuardedUpdater(options)
  const updater = assertSupportedGuard(guard)
  let result: UpdateCheckResult | null
  try {
    result = await updater.checkForUpdates()
  } catch (error) {
    log('error', `updates.download check failed: ${safeMessage(error)}`)
    const status = errorStatus(guard.capability, error)
    publishUpdateInstallEvent(status)
    throw new Error(status.message, { cause: error })
  }
  if (!result) {
    const status: UpdateInstallStatus = {
      status: 'error',
      currentVersion: guard.capability.currentVersion,
      message: 'Update provider is unavailable for this build.',
      manualReleaseUrl: guard.capability.manualReleaseUrl,
    }
    publishUpdateInstallEvent(status)
    throw new Error(status.message)
  }
  if (!result.isUpdateAvailable) {
    const status = statusFromUpdateInfo('not-available', guard.capability, result.updateInfo)
    publishUpdateInstallEvent(status)
    return status
  }

  const available = statusFromUpdateInfo('available', guard.capability, result.updateInfo)
  availableUpdateVersion = available.latestVersion
  publishUpdateInstallEvent(available)
  try {
    const expectedDownloadedVersion = updateInfoVersion(result.updateInfo) || guard.capability.currentVersion
    await updater.downloadUpdate()
    if (downloadedUpdateVersion !== expectedDownloadedVersion) {
      downloadedUpdateVersion = expectedDownloadedVersion
      const status = statusFromUpdateInfo('downloaded', guard.capability, result.updateInfo)
      publishUpdateInstallEvent(status)
      return status
    }
    const status = statusFromUpdateInfo('downloaded', guard.capability, result.updateInfo)
    return status
  } catch (error) {
    log('error', `updates.download failed: ${safeMessage(error)}`)
    const status = errorStatus(guard.capability, error)
    publishUpdateInstallEvent(status)
    throw new Error(status.message, { cause: error })
  }
}

export async function quitAndInstallUpdate(options?: UpdateActionOptions): Promise<UpdateInstallStatus> {
  const guard = await getGuardedUpdater(options)
  const updater = assertSupportedGuard(guard)
  if (!downloadedUpdateVersion) {
    publishUpdateInstallEvent({
      status: 'error',
      currentVersion: guard.capability.currentVersion,
      message: 'No downloaded update is ready to install.',
      manualReleaseUrl: guard.capability.manualReleaseUrl,
    })
    throw new Error('No downloaded update is ready to install.')
  }
  const status: UpdateInstallStatus = {
    status: 'installing',
    currentVersion: guard.capability.currentVersion,
    latestVersion: downloadedUpdateVersion,
    manualReleaseUrl: guard.capability.manualReleaseUrl,
  }
  publishUpdateInstallEvent(status)
  updater.quitAndInstall(false, true)
  return status
}

export function resetUpdateInstallServiceForTests() {
  availableUpdateVersion = null
  downloadedUpdateVersion = null
  updateInstallEventSubscribers.clear()
}
