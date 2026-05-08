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
