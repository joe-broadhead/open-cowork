import type { WorkspaceOptions } from './workspace.js'

export const CLOUD_ARTIFACT_FILE_PATH_PREFIX = 'cloud-artifact://'

export const ARTIFACT_STATUSES = ['draft', 'in-review', 'final'] as const
export type ArtifactStatus = typeof ARTIFACT_STATUSES[number]

export const ARTIFACT_KINDS = ['document', 'chart', 'deck', 'spreadsheet', 'draft'] as const
export type ArtifactKind = typeof ARTIFACT_KINDS[number]

const ARTIFACT_STATUS_RANK: Record<ArtifactStatus, number> = {
  draft: 0,
  'in-review': 1,
  final: 2,
}

export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === 'string' && (ARTIFACT_STATUSES as readonly string[]).includes(value)
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

export function canAdvanceArtifactStatus(current: ArtifactStatus, next: ArtifactStatus) {
  return ARTIFACT_STATUS_RANK[next] >= ARTIFACT_STATUS_RANK[current]
}

export function defaultArtifactStatusForKind(kind: ArtifactKind): ArtifactStatus {
  return kind === 'chart' ? 'final' : 'draft'
}

export function inferArtifactKind(input: {
  kind?: unknown
  filename?: string | null
  mime?: string | null
  chart?: unknown
}): ArtifactKind {
  if (isArtifactKind(input.kind)) return input.kind
  if (input.chart) return 'chart'
  const mime = input.mime?.toLowerCase() || ''
  const filename = input.filename?.toLowerCase() || ''
  if (mime.startsWith('image/') && /chart|vega/.test(filename)) return 'chart'
  if (mime.includes('presentation') || /\.(pptx?|key)$/.test(filename)) return 'deck'
  if (
    mime.includes('spreadsheet')
    || mime.includes('csv')
    || /\.(csv|tsv|xlsx?|ods)$/.test(filename)
  ) return 'spreadsheet'
  if (
    mime.includes('pdf')
    || mime.includes('markdown')
    || mime.startsWith('text/')
    || /\.(md|markdown|txt|pdf|docx?|html?)$/.test(filename)
  ) return 'document'
  return 'draft'
}

const SAFE_ARTIFACT_OPEN_EXTENSIONS = new Set([
  'gif',
  'jpeg',
  'jpg',
  'json',
  'md',
  'markdown',
  'pdf',
  'png',
  'txt',
  'webp',
  'yaml',
  'yml',
])

const SAFE_ARTIFACT_OPEN_MIMES = new Set([
  'application/json',
  'application/pdf',
  'application/yaml',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/markdown',
  'text/plain',
  'text/yaml',
])

export function isSafeArtifactOpenTarget(input: {
  filename?: string | null
  mime?: string | null
}) {
  const filename = input.filename?.toLowerCase().trim() || ''
  const extension = filename.includes('.') ? filename.split('.').pop() || '' : ''
  if (!extension || !SAFE_ARTIFACT_OPEN_EXTENSIONS.has(extension)) return false
  const mime = input.mime?.toLowerCase().split(';', 1)[0]?.trim()
  return !mime || mime === 'application/octet-stream' || SAFE_ARTIFACT_OPEN_MIMES.has(mime)
}

export function cloudArtifactFilePath(artifactId: string, filename = 'artifact') {
  const safeFilename = filename.trim() || 'artifact'
  return `${CLOUD_ARTIFACT_FILE_PATH_PREFIX}${encodeURIComponent(artifactId)}/${encodeURIComponent(safeFilename)}`
}

export function cloudArtifactIdFromFilePath(filePath: string) {
  if (!filePath.startsWith(CLOUD_ARTIFACT_FILE_PATH_PREFIX)) return null
  const remainder = filePath.slice(CLOUD_ARTIFACT_FILE_PATH_PREFIX.length)
  const [encodedId] = remainder.split('/')
  if (!encodedId) return null
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return null
  }
}

export interface SessionArtifactRequest {
  sessionId: string
  filePath: string
  workspaceId?: string
}

export interface SessionArtifactExportRequest extends SessionArtifactRequest {
  suggestedName?: string
}

export interface SessionArtifactListRequest extends WorkspaceOptions {
  sessionId: string
}

export interface ArtifactIndexRequest extends WorkspaceOptions {
  sessionId?: string | null
  projectId?: string | null
  taskId?: string | null
  taskIds?: string[] | null
  status?: ArtifactStatus | null
  kind?: ArtifactKind | null
  limit?: number | null
}

export interface SessionArtifactUploadRequest extends WorkspaceOptions {
  sessionId: string
  filename: string
  contentType?: string | null
  dataBase64: string
  kind?: ArtifactKind | null
  status?: ArtifactStatus | null
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
}

export interface ArtifactStatusUpdateRequest extends WorkspaceOptions {
  sessionId: string
  artifactId: string
  status: ArtifactStatus
  updatedBy?: string | null
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  kind?: ArtifactKind | null
}

export interface ChartArtifactSource {
  format: 'vega' | 'vega-lite'
  spec: Record<string, unknown>
  title?: string
}

export interface SessionArtifact {
  id: string
  toolId: string
  toolName: string
  filePath: string
  filename: string
  order: number
  source?: 'local' | 'cloud'
  cloudArtifactId?: string
  taskRunId?: string | null
  mime?: string
  size?: number
  createdAt?: string
  updatedAt?: string
  kind?: ArtifactKind
  status?: ArtifactStatus
  authorAgentId?: string | null
  projectId?: string | null
  taskId?: string | null
  statusUpdatedBy?: string | null
  statusUpdatedAt?: string | null
  chart?: ChartArtifactSource | null
}

export interface ArtifactIndexEntry extends SessionArtifact {
  sessionId: string
  sessionTitle?: string | null
  workspaceId?: string | null
}

export interface ArtifactIndexPayload {
  artifacts: ArtifactIndexEntry[]
  total: number
  scannedSessions?: number
  truncated?: boolean
}

export interface SessionArtifactAttachment {
  mime: string
  url: string
  filename: string
  chart?: ChartArtifactSource | null
}

// Request shape for persisting a chart PNG captured client-side. The
// main process validates the data URL, writes the bytes under a
// per-session chart-artifacts root, and returns a SessionArtifact
// the renderer can feed into the existing export/reveal IPC.
export interface ChartSaveArtifactRequest {
  sessionId: string
  toolCallId: string
  toolName: string
  dataUrl: string
  taskRunId: string | null
  chart?: ChartArtifactSource | null
}
