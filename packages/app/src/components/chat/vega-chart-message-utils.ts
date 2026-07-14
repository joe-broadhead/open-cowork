import { isOpaqueMessageOrigin } from '../../chart-frame-message-origin.ts'

const MIN_CHART_FRAME_HEIGHT = 180
const MAX_CHART_FRAME_HEIGHT = 2_000
const MAX_CHART_FRAME_MESSAGE_CHARS = 4 * 1024
const MAX_CHART_CAPTURE_DATA_URL_CHARS = 8 * 1024 * 1024 + 128
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

export type ChartFrameMessage =
  | { type: 'chart-frame-ready' }
  | { type: 'chart-ready'; requestId: number; height: number }
  | { type: 'chart-error'; requestId: number; message: string }
  | { type: 'chart-capture'; requestId: number; dataUrl: string }
  | { type: 'chart-capture-error'; requestId: number; message: string }

function requestId(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 ? value : null
}

function boundedMessage(value: unknown) {
  if (typeof value !== 'string') return null
  return value.slice(0, MAX_CHART_FRAME_MESSAGE_CHARS)
}

export function normalizeChartFrameMessage(value: unknown): ChartFrameMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type === 'chart-frame-ready') return { type: 'chart-frame-ready' }
  const normalizedRequestId = requestId(record.requestId)
  if (normalizedRequestId === null) return null

  if (record.type === 'chart-ready') {
    if (typeof record.height !== 'number' || !Number.isFinite(record.height)) return null
    return {
      type: 'chart-ready',
      requestId: normalizedRequestId,
      height: Math.min(MAX_CHART_FRAME_HEIGHT, Math.max(MIN_CHART_FRAME_HEIGHT, record.height)),
    }
  }
  if (record.type === 'chart-error' || record.type === 'chart-capture-error') {
    const message = boundedMessage(record.message)
    if (message === null) return null
    return { type: record.type, requestId: normalizedRequestId, message }
  }
  if (record.type === 'chart-capture') {
    if (
      typeof record.dataUrl !== 'string'
      || !record.dataUrl.startsWith(PNG_DATA_URL_PREFIX)
      || record.dataUrl.length > MAX_CHART_CAPTURE_DATA_URL_CHARS
    ) return null
    return { type: 'chart-capture', requestId: normalizedRequestId, dataUrl: record.dataUrl }
  }
  return null
}

function originMatches(eventOrigin: string, expectedOrigin: string) {
  if (eventOrigin === expectedOrigin) return true
  return isOpaqueMessageOrigin(eventOrigin) && isOpaqueMessageOrigin(expectedOrigin)
}

export function shouldHandleChartFrameMessage(options: {
  frameWindow: Window | null
  eventSource: MessageEventSource | null
  eventOrigin: string
  expectedOrigin: string
}) {
  return Boolean(
    options.frameWindow
    && options.eventSource === options.frameWindow
    && originMatches(options.eventOrigin, options.expectedOrigin),
  )
}
