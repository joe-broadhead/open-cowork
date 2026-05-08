export type UpdateInstallUnsupportedReason =
  | 'dev'
  | 'unsigned'
  | 'platform'
  | 'missing-feed'
  | 'unavailable'

export interface UpdateInstallCapability {
  supported: boolean
  reason?: UpdateInstallUnsupportedReason
  currentVersion: string
  manualReleaseUrl: string | null
}

export interface UpdateInstallProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type UpdateInstallStatus =
  | {
    status: 'unsupported'
    reason: UpdateInstallUnsupportedReason
    currentVersion: string
    manualReleaseUrl: string | null
  }
  | {
    status: 'checking'
    currentVersion: string
    manualReleaseUrl: string | null
  }
  | {
    status: 'not-available' | 'available' | 'downloaded' | 'installing'
    currentVersion: string
    latestVersion: string
    manualReleaseUrl: string | null
  }
  | {
    status: 'downloading'
    currentVersion: string
    latestVersion: string
    progress: UpdateInstallProgress
    manualReleaseUrl: string | null
  }
  | {
    status: 'error'
    currentVersion: string
    latestVersion?: string
    message: string
    manualReleaseUrl: string | null
  }

export type UpdateInstallEvent = UpdateInstallStatus
