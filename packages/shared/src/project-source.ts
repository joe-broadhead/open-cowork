export type CloudProjectSourceKind = 'git' | 'snapshot'

export type CloudGitProjectSource = {
  kind: 'git'
  repositoryUrl: string
  ref?: string | null
  subdirectory?: string | null
  credentialRef?: string | null
}

export type CloudSnapshotProjectSource = {
  kind: 'snapshot'
  snapshotId: string
  objectKey: string
  fileCount: number
  byteCount: number
  title?: string | null
}

export type CloudProjectSource = CloudGitProjectSource | CloudSnapshotProjectSource
export type CloudProjectSourceInput = CloudProjectSource

export type CloudProjectSourceSummary = {
  kind: CloudProjectSourceKind
  repositoryUrl?: string | null
  ref?: string | null
  subdirectory?: string | null
  snapshotId?: string | null
  title?: string | null
}

export type CloudProjectSourcePolicyVerdict = {
  allowed: boolean
  reason: string | null
  policyCode?: string
}

export type CloudProjectSnapshotFile = {
  path: string
  dataBase64: string
  byteCount?: number
  mode?: number | null
}

export type CloudProjectSnapshotExcludedEntry = {
  path: string
  reason: string
}

export type CloudProjectSnapshotInventoryFile = {
  path: string
  byteCount: number
}

export type CloudProjectSnapshotInventory = {
  rootDirectory: string
  files: CloudProjectSnapshotInventoryFile[]
  excluded: CloudProjectSnapshotExcludedEntry[]
  warnings: string[]
  fileCount: number
  byteCount: number
  maxFiles: number
  maxBytes: number
}

export type CloudProjectSnapshotUploadInput = {
  title?: string | null
  files: CloudProjectSnapshotFile[]
  excluded?: CloudProjectSnapshotExcludedEntry[]
  warnings?: string[]
  fileCount?: number
  byteCount?: number
}

export type CloudProjectSnapshotUploadResult = {
  snapshotId: string
  objectKey: string
  fileCount: number
  byteCount: number
  createdAt: string
  projectSource: CloudSnapshotProjectSource
}

export type CloudSessionCreateOptions = {
  workspaceId?: string
  projectSource?: CloudProjectSourceInput | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function cloudSafeGitRepositoryUrl(value: string) {
  const stripped = value.split(/[?#]/, 1)[0]?.trim() || value.trim()
  return stripped.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]+@)/i, '$1')
}

export function normalizeCloudProjectSource(value: unknown): CloudProjectSource | null {
  const record = asRecord(value)
  if (record.kind === 'git') {
    const repositoryUrl = readString(record.repositoryUrl)
    if (!repositoryUrl) return null
    return {
      kind: 'git',
      repositoryUrl,
      ref: readString(record.ref),
      subdirectory: readString(record.subdirectory),
      credentialRef: readString(record.credentialRef),
    }
  }
  if (record.kind === 'snapshot') {
    const snapshotId = readString(record.snapshotId)
    const objectKey = readString(record.objectKey)
    if (!snapshotId || !objectKey) return null
    return {
      kind: 'snapshot',
      snapshotId,
      objectKey,
      fileCount: readNumber(record.fileCount),
      byteCount: readNumber(record.byteCount),
      title: readString(record.title),
    }
  }
  return null
}

export function summarizeCloudProjectSource(source: CloudProjectSource | null | undefined): CloudProjectSourceSummary | null {
  if (!source) return null
  if (source.kind === 'git') {
    return {
      kind: 'git',
      repositoryUrl: cloudSafeGitRepositoryUrl(source.repositoryUrl),
      ref: source.ref,
      subdirectory: source.subdirectory,
    }
  }
  return {
    kind: 'snapshot',
    snapshotId: source.snapshotId,
    title: source.title,
  }
}
