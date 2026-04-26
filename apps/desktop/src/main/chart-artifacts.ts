import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChartArtifactSource, ChartSaveArtifactRequest, SessionArtifact } from '@open-cowork/shared'
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

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeChartArtifactSource(value: unknown): ChartArtifactSource | null {
  const record = asObjectRecord(value)
  if (!record) return null
  if (record.format !== 'vega' && record.format !== 'vega-lite') return null
  const spec = asObjectRecord(record.spec)
  if (!spec) return null
  const title = typeof record.title === 'string' && record.title.trim()
    ? record.title.trim()
    : undefined
  return {
    format: record.format,
    spec,
    ...(title ? { title } : {}),
  }
}

export function getChartArtifactMetadataPath(filePath: string): string {
  return filePath.replace(/\.png$/i, '.json')
}

export function readChartArtifactSource(filePath: string): ChartArtifactSource | null {
  const metadataPath = getChartArtifactMetadataPath(filePath)
  if (!existsSync(metadataPath)) return null
  try {
    return normalizeChartArtifactSource(JSON.parse(readFileSync(metadataPath, 'utf-8')))
  } catch {
    return null
  }
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
  const chart = request.chart ? normalizeChartArtifactSource(request.chart) : null
  if (request.chart && !chart) {
    throw new Error('Chart artifact metadata must include a valid vega or vega-lite spec.')
  }

  const root = getChartArtifactsRoot(request.sessionId)
  mkdirSync(root, { recursive: true })

  // Keyed on the tool-call id so re-rendering the same chart (HMR,
  // duplicate events) overwrites rather than accumulating duplicates.
  const filename = `chart-${sanitizeToolCallId(request.toolCallId)}.png`
  const filePath = join(root, filename)
  writeFileSync(filePath, bytes)
  const metadataPath = getChartArtifactMetadataPath(filePath)
  if (chart) {
    writeFileSync(metadataPath, JSON.stringify(chart))
  } else {
    rmSync(metadataPath, { force: true })
  }
  log('chart', `Saved chart artifact ${filename} (${bytes.length} bytes) for session ${request.sessionId}`)

  return {
    id: `${request.taskRunId || 'session'}:${request.toolCallId}:${filename}`,
    toolId: request.toolCallId,
    toolName: request.toolName,
    filePath,
    filename,
    order: Date.now(),
    taskRunId: request.taskRunId || null,
    mime: 'image/png',
    chart,
  }
}
