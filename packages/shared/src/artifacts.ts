import type { WorkspaceOptions } from './workspace.js'

export const CLOUD_ARTIFACT_FILE_PATH_PREFIX = 'cloud-artifact://'

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

export interface SessionArtifactUploadRequest extends WorkspaceOptions {
  sessionId: string
  filename: string
  contentType?: string | null
  dataBase64: string
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
  chart?: ChartArtifactSource | null
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
  taskRunId?: string | null
  chart?: ChartArtifactSource | null
}
