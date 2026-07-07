import { sanitizeLogMessage } from '@open-cowork/shared'
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
import { getBranding } from '../config-loader.ts'
import type { OpenCoworkConfig } from '@open-cowork/shared'
import { log } from '../logger.ts'
import { getCurrentVersion, parseGithubRepo } from './update-check.ts'
import {
  type ResolvedUpdateReleaseSource,
  type ResolveUpdateReleaseSourceOptions,
  resolveUpdateReleaseSource,
  UpdateReleaseSourceError,
} from './update-release-source.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const updateInstallCapabilityResourceName = 'open-cowork-update-capability.json'
const updateInstallEventSubscribers = new Set<(event: UpdateInstallEvent) => void>()
const configuredUpdaters = new WeakSet<UpdateInstallRuntime>()
const updaterCapabilities = new WeakMap<UpdateInstallRuntime, UpdateInstallCapability>()
let defaultInstallUpdater: UpdateInstallRuntime | null = null
let availableUpdateVersion: string | null = null
let downloadedUpdateVersion: string | null = null

interface UpdateInstallCapabilityResource {
  schemaVersion?: number
  signedInstallEligible: boolean
  feedConfigured: boolean
  releaseSourceKind?: string
  channel?: string
}

type UpdateInstallRuntime = Pick<AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
  | 'setFeedURL'
  | 'on'
> & {
  logger: AppUpdater['logger']
  requestHeaders: AppUpdater['requestHeaders']
}

type UpdateServiceOptions = {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  signedInstallEligible?: boolean
  feedConfigured?: boolean
  currentVersion?: string
  manualReleaseUrl?: string | null
  resourcePath?: string | null
  config?: OpenCoworkConfig
  getAuthState?: ResolveUpdateReleaseSourceOptions['getAuthState']
  refreshGoogleAccessToken?: ResolveUpdateReleaseSourceOptions['refreshGoogleAccessToken']
  fetchImpl?: ResolveUpdateReleaseSourceOptions['fetchImpl']
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
  // In-app installs are supported on macOS (MacUpdater) and Windows
  // (NsisUpdater). Linux keeps the verified manual-download path.
  if (input.platform !== 'darwin' && input.platform !== 'win32') return 'platform'
  if (!input.signedInstallEligible) return 'unsigned'
  if (!input.feedConfigured) return 'missing-feed'
  return null
}

function sourceErrorCapability(
  error: UpdateReleaseSourceError,
  currentVersion: string,
): UpdateInstallCapability {
  return {
    supported: false,
    reason: error.reason,
    currentVersion,
    manualReleaseUrl: error.manualReleaseUrl,
    releaseSource: error.descriptor,
  }
}

function normalizeEmbeddedCapability(value: unknown): UpdateInstallCapabilityResource | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) return null
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : undefined,
    signedInstallEligible: record.signedInstallEligible === true,
    feedConfigured: record.feedConfigured === true,
    releaseSourceKind: typeof record.releaseSourceKind === 'string' ? record.releaseSourceKind : undefined,
    channel: typeof record.channel === 'string' ? record.channel : undefined,
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
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Update installation failed.'
  return sanitizeLogMessage(message)
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

function capabilityForUpdater(updater: UpdateInstallRuntime, fallback: UpdateInstallCapability) {
  return updaterCapabilities.get(updater) || fallback
}

function configureUpdater(
  updater: UpdateInstallRuntime,
  capability: UpdateInstallCapability,
  source: ResolvedUpdateReleaseSource,
) {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.setFeedURL(source.installProvider as Parameters<UpdateInstallRuntime['setFeedURL']>[0])
  updater.requestHeaders = Object.keys(source.requestHeaders).length > 0 ? source.requestHeaders : null
  updaterCapabilities.set(updater, capability)
  updater.logger = {
    info: (message?: unknown) => log('updates', String(message ?? '')),
    warn: (message?: unknown) => log('updates', `warning: ${String(message ?? '')}`),
    error: (message?: unknown) => log('error', `updates: ${String(message ?? '')}`),
  }
  if (configuredUpdaters.has(updater)) return
  configuredUpdaters.add(updater)
  updater.on('checking-for-update', () => {
    const current = capabilityForUpdater(updater, capability)
    publishUpdateInstallEvent({
      status: 'checking',
      currentVersion: current.currentVersion,
      manualReleaseUrl: current.manualReleaseUrl,
    })
  })
  updater.on('download-progress', (info: ProgressInfo) => {
    const current = capabilityForUpdater(updater, capability)
    publishUpdateInstallEvent({
      status: 'downloading',
      currentVersion: current.currentVersion,
      latestVersion: availableUpdateVersion || downloadedUpdateVersion || current.currentVersion,
      progress: normalizeProgress(info),
      manualReleaseUrl: current.manualReleaseUrl,
    })
  })
  updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    const current = capabilityForUpdater(updater, capability)
    downloadedUpdateVersion = updateInfoVersion(event) || downloadedUpdateVersion || current.currentVersion
    publishUpdateInstallEvent(statusFromUpdateInfo('downloaded', current, event))
  })
  updater.on('update-cancelled', (info: UpdateInfo) => {
    const current = capabilityForUpdater(updater, capability)
    publishUpdateInstallEvent({
      status: 'error',
      currentVersion: current.currentVersion,
      latestVersion: updateInfoVersion(info) || undefined,
      message: 'Update download was cancelled.',
      manualReleaseUrl: current.manualReleaseUrl,
    })
  })
  updater.on('error', (error: Error) => {
    const current = capabilityForUpdater(updater, capability)
    log('error', `updates.install failed: ${safeMessage(error)}`)
    publishUpdateInstallEvent(errorStatus(current, error))
  })
}

async function getDefaultUpdater(): Promise<UpdateInstallRuntime> {
  if (defaultInstallUpdater) return defaultInstallUpdater
  const { MacUpdater, autoUpdater } = await import('electron-updater')
  const updater = process.platform === 'darwin'
    ? new MacUpdater()
    : autoUpdater
  defaultInstallUpdater = updater
  return updater
}

async function getGuardedUpdater(options: UpdateActionOptions = {}) {
  const context = await getUpdateInstallContext(options)
  const { capability, source } = context
  if (!capability.supported) {
    const status = unsupportedStatus(capability)
    publishUpdateInstallEvent(status)
    return { capability, status, updater: null }
  }
  if (!source) {
    const unavailable: UpdateInstallCapability = {
      ...capability,
      supported: false,
      reason: 'unavailable',
    }
    const status = unsupportedStatus(unavailable)
    publishUpdateInstallEvent(status)
    return { capability: unavailable, status, updater: null }
  }
  const updater = options.updater || await getDefaultUpdater()
  configureUpdater(updater, capability, source)
  return { capability, status: null, updater }
}

function assertSupportedGuard(result: Awaited<ReturnType<typeof getGuardedUpdater>>) {
  if (!result.updater) {
    const reason = result.status?.status === 'unsupported' ? result.status.reason : 'unavailable'
    throw new Error(`In-app update installation is not available for this build (${reason}).`)
  }
  return result.updater
}

async function getUpdateInstallContext(options: UpdateServiceOptions = {}): Promise<{
  capability: UpdateInstallCapability
  source: ResolvedUpdateReleaseSource | null
}> {
  const embedded = readEmbeddedUpdateInstallCapability(options?.resourcePath)
  const currentVersion = options?.currentVersion ?? await getCurrentVersion()
  let source: ResolvedUpdateReleaseSource | null = null
  let sourceError: UpdateReleaseSourceError | null = null
  try {
    source = await resolveUpdateReleaseSource({
      config: options.config,
      currentVersion,
      fetchImpl: options.fetchImpl,
      getAuthState: options.getAuthState,
      isPackaged: options?.isPackaged ?? (electronApp?.isPackaged === true),
      refreshGoogleAccessToken: options.refreshGoogleAccessToken,
    })
  } catch (error) {
    if (error instanceof UpdateReleaseSourceError) {
      sourceError = error
    } else {
      sourceError = new UpdateReleaseSourceError(
        'source-misconfigured',
        error instanceof Error ? error.message : 'The update release source could not be resolved.',
      )
    }
  }
  const manualReleaseUrl = options && 'manualReleaseUrl' in options
    ? options.manualReleaseUrl ?? null
    : source?.manualReleaseUrl ?? sourceError?.manualReleaseUrl ?? manualReleaseUrlFromHelpUrl(getBranding().helpUrl)
  const reason = reasonCapability({
    isPackaged: options?.isPackaged ?? (electronApp?.isPackaged === true),
    platform: options?.platform ?? process.platform,
    signedInstallEligible: options?.signedInstallEligible ?? embedded.signedInstallEligible,
    feedConfigured: options?.feedConfigured ?? embedded.feedConfigured,
  })
  if (sourceError) {
    if (reason && !['source-disabled', 'source-misconfigured'].includes(sourceError.reason)) {
      return {
        capability: {
          supported: false,
          reason,
          currentVersion,
          manualReleaseUrl,
          releaseSource: sourceError.descriptor,
        },
        source: null,
      }
    }
    return {
      capability: {
        ...sourceErrorCapability(sourceError, currentVersion),
        manualReleaseUrl,
      },
      source: null,
    }
  }
  if (reason) {
    return {
      capability: {
        supported: false,
        reason,
        currentVersion,
        manualReleaseUrl,
        releaseSource: source?.descriptor || null,
      },
      source: null,
    }
  }
  return {
    capability: {
      supported: true,
      currentVersion,
      manualReleaseUrl,
      releaseSource: source?.descriptor || null,
    },
    source,
  }
}

export async function getUpdateInstallCapability(options?: UpdateServiceOptions): Promise<UpdateInstallCapability> {
  return (await getUpdateInstallContext(options)).capability
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
