import electron from 'electron'
import type { UpdateInstallCapability, UpdateInstallUnsupportedReason } from '@open-cowork/shared'
import { getBranding } from './config-loader.ts'
import { getCurrentVersion, parseGithubRepo } from './update-check.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

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

export async function getUpdateInstallCapability(options?: {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  signedInstallEligible?: boolean
  feedConfigured?: boolean
  currentVersion?: string
  manualReleaseUrl?: string | null
}): Promise<UpdateInstallCapability> {
  const currentVersion = options?.currentVersion ?? await getCurrentVersion()
  const manualReleaseUrl = options && 'manualReleaseUrl' in options
    ? options.manualReleaseUrl ?? null
    : manualReleaseUrlFromHelpUrl(getBranding().helpUrl)
  const reason = reasonCapability({
    isPackaged: options?.isPackaged ?? (electronApp?.isPackaged === true),
    platform: options?.platform ?? process.platform,
    signedInstallEligible: options?.signedInstallEligible ?? false,
    feedConfigured: options?.feedConfigured ?? false,
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
