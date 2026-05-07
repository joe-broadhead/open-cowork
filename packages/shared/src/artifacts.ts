export interface SessionArtifactRequest {
  sessionId: string
  filePath: string
}

export interface SessionArtifactExportRequest extends SessionArtifactRequest {
  suggestedName?: string
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
  taskRunId?: string | null
  mime?: string
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
