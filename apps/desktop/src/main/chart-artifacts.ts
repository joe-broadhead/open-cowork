import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChartSaveArtifactRequest, SessionArtifact } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { log } from './logger.ts'

// Charts are captured client-side (vega-embed's `view.toImageURL`) and
// written here so they're decoupled from the session's working
// directory — we don't want to drop PNGs into user project folders in
// project mode. Per-session root keeps them namespaced and easy to
// clean alongside the session.
export function getChartArtifactsRoot(sessionId: string): string {
  return join(getAppDataDir(), 'chart-artifacts', sessionId)
}

const DATA_URL_PREFIX = 'data:image/png;base64,'

function sanitizeToolCallId(toolCallId: string) {
  return toolCallId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'chart'
}

export function saveChartArtifact(request: ChartSaveArtifactRequest): SessionArtifact {
  if (!request.sessionId || !request.toolCallId || !request.toolName) {
    throw new Error('Chart artifact save requires sessionId, toolCallId, and toolName.')
  }
  if (!request.dataUrl?.startsWith(DATA_URL_PREFIX)) {
    throw new Error('Chart artifact payload must be a base64-encoded PNG data URL.')
  }

  const base64 = request.dataUrl.slice(DATA_URL_PREFIX.length)
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) {
    throw new Error('Chart artifact payload was empty after decode.')
  }

  const root = getChartArtifactsRoot(request.sessionId)
  mkdirSync(root, { recursive: true })

  // Keyed on the tool-call id so re-rendering the same chart (HMR,
  // duplicate events) overwrites rather than accumulating duplicates.
  const filename = `chart-${sanitizeToolCallId(request.toolCallId)}.png`
  const filePath = join(root, filename)
  writeFileSync(filePath, bytes)
  log('chart', `Saved chart artifact ${filename} (${bytes.length} bytes) for session ${request.sessionId}`)

  return {
    id: `${request.taskRunId || 'session'}:${request.toolCallId}:${filename}`,
    toolId: request.toolCallId,
    toolName: request.toolName,
    filePath,
    filename,
    order: Date.now(),
    taskRunId: request.taskRunId || null,
  }
}
