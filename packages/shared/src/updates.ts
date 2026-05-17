export type UpdateInstallUnsupportedReason =
  | 'dev'
  | 'unsigned'
  | 'platform'
  | 'missing-feed'
  | 'source-disabled'
  | 'source-misconfigured'
  | 'auth-required'
  | 'auth-expired'
  | 'auth-forbidden'
  | 'source-unreachable'
  | 'unavailable'

export type UpdateReleaseSourceKind = 'github-releases' | 'generic-http' | 'gcs'

export type UpdateReleaseSourceAuthKind =
  | 'none'
  | 'github-token'
  | 'static-headers'
  | 'google-oauth'
  | 'signed-url-broker'

export interface UpdateReleaseSourceDescriptor {
  kind: UpdateReleaseSourceKind
  label: string
  channel: string
  requiresAuth: boolean
  authKind: UpdateReleaseSourceAuthKind
}

export interface UpdateInstallCapability {
  supported: boolean
  reason?: UpdateInstallUnsupportedReason
  currentVersion: string
  manualReleaseUrl: string | null
  releaseSource: UpdateReleaseSourceDescriptor | null
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

export type UpdateCheckResult =
  | { status: 'ok'; currentVersion: string; latestVersion: string; hasUpdate: boolean; releaseUrl: string }
  | { status: 'error'; currentVersion: string; message: string }
  | { status: 'disabled'; currentVersion: string; message: string }
