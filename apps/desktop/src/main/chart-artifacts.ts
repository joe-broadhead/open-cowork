import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { ChartArtifactSource, ChartSaveArtifactRequest, SessionArtifact } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { log } from './logger.ts'

// Charts are captured client-side (vega-embed's `view.toImageURL`) and
// written here so they're decoupled from the session's working
// directory — we don't want to drop PNGs into user project folders in
// project mode. Per-session root keeps them namespaced and easy to
// clean alongside the session.
export function getChartArtifactsRoot(sessionId: string): string {
  const base = resolve(getAppDataDir(), 'chart-artifacts')
  const safeSessionId = sanitizePathSegment(sessionId, 'sessionId', 160)
  const root = resolve(base, safeSessionId)
  if (root !== base && !root.startsWith(`${base}${sep}`)) {
    throw new Error('Chart artifact session root escaped the artifact directory.')
  }
  return root
}

const DATA_URL_PREFIX = 'data:image/png;base64,'
const MAX_CHART_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_CHART_ARTIFACT_METADATA_BYTES = 1024 * 1024

function stringByteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function sanitizePathSegment(value: unknown, label: string, maxBytes: number) {
  if (typeof value !== 'string') {
    throw new Error(`Chart artifact ${label} must be a string.`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Chart artifact ${label} is required.`)
  }
  if (stringByteLength(trimmed) > maxBytes) {
    throw new Error(`Chart artifact ${label} is too large.`)
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, maxBytes)
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`Chart artifact ${label} could not be normalized safely.`)
  }
  return safe
}

function decodeBoundedPngDataUrl(dataUrl: unknown) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(DATA_URL_PREFIX)) {
    throw new Error('Chart artifact payload must be a base64-encoded PNG data URL.')
  }
  const base64 = dataUrl.slice(DATA_URL_PREFIX.length).trim()
  if (!base64) {
    throw new Error('Chart artifact payload was empty after decode.')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('Chart artifact payload must be valid base64.')
  }
  const estimatedBytes = Math.floor((base64.length * 3) / 4)
  if (estimatedBytes > MAX_CHART_ARTIFACT_BYTES + 2) {
    throw new Error('Chart artifact payload is too large.')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) {
    throw new Error('Chart artifact payload was empty after decode.')
  }
  if (bytes.length > MAX_CHART_ARTIFACT_BYTES) {
    throw new Error('Chart artifact payload is too large.')
  }
  return bytes
}

function sanitizeToolCallId(toolCallId: string) {
  return sanitizePathSegment(toolCallId, 'toolCallId', 64)
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

  const bytes = decodeBoundedPngDataUrl(request.dataUrl)
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
    const metadata = JSON.stringify(chart)
    if (stringByteLength(metadata) > MAX_CHART_ARTIFACT_METADATA_BYTES) {
      rmSync(filePath, { force: true })
      throw new Error('Chart artifact metadata is too large.')
    }
    writeFileSync(metadataPath, metadata)
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
