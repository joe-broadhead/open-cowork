import electron from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateInstallCapability, UpdateInstallUnsupportedReason } from '@open-cowork/shared'
import { getBranding } from './config-loader.ts'
import { getCurrentVersion, parseGithubRepo } from './update-check.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const updateInstallCapabilityResourceName = 'open-cowork-update-capability.json'

interface UpdateInstallCapabilityResource {
  signedInstallEligible: boolean
  feedConfigured: boolean
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

export async function getUpdateInstallCapability(options?: {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  signedInstallEligible?: boolean
  feedConfigured?: boolean
  currentVersion?: string
  manualReleaseUrl?: string | null
  resourcePath?: string | null
}): Promise<UpdateInstallCapability> {
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
