import { randomBytes } from 'node:crypto'
import { sanitizeLogMessage } from '@open-cowork/shared'

type Env = Record<string, string | undefined>

export type CloudLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type CloudObservabilityAttributeValue = string | number | boolean | null | undefined

export type CloudObservabilityAttributes = Record<string, CloudObservabilityAttributeValue>

export type CloudLogRecord = {
  level: CloudLogLevel
  name: string
  message?: string
  attributes?: CloudObservabilityAttributes
  timestamp?: Date
}

export type CloudMetricRecord = {
  name: string
  value: number
  unit?: string
  attributes?: CloudObservabilityAttributes
  timestamp?: Date
}

export type CloudSpanRecord = {
  name: string
  startTime: Date
  endTime: Date
  attributes?: CloudObservabilityAttributes
  status?: 'ok' | 'error'
  statusMessage?: string | null
}

export type CloudObservabilityAdapter = {
  log(record: CloudLogRecord): void | Promise<void>
  metric(record: CloudMetricRecord): void | Promise<void>
  span(record: CloudSpanRecord): void | Promise<void>
  renderPrometheus?(): string
  flush?(): void | Promise<void>
  close?(): void | Promise<void>
}

export type ConsoleCloudObservabilityOptions = {
  serviceName?: string
  serviceVersion?: string | null
  format?: 'json' | 'pretty' | 'silent'
  sink?: (line: string) => void
  now?: () => Date
}

export type OtlpHttpCloudObservabilityOptions = {
  endpoint: string
  serviceName?: string
  serviceVersion?: string | null
  headers?: Record<string, string>
  fetch?: typeof fetch
  flushIntervalMs?: number
  maxQueueSize?: number
}

export type CloudHttpRequestObservation = {
  requestId: string
  method: string
  path: string
  statusCode: number
  durationMs: number
  role: string
  profileName: string
  timestamp?: Date
}

type CloudPrometheusMetricPoint = {
  kind: 'counter' | 'gauge'
  help: string
  value: number
  labels: Record<string, string>
}

const DEFAULT_SERVICE_NAME = 'open-cowork-cloud'
const DEFAULT_OTLP_FLUSH_INTERVAL_MS = 30_000
const DEFAULT_OTLP_MAX_QUEUE_SIZE = 1_000
const SENSITIVE_FIELD = /(authorization|cookie|token|secret|password|credential|key|ref|kmsref|ciphertext|envelope)$/i
const MAX_STRING_LENGTH = 512
const SIGNED_URL_QUERY_PATTERN = /\b(https?:\/\/[^\s"'<>?]+)\?[^"'<> \t\r\n]+/gi
const LOCAL_PATH_PATTERNS = [
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,
]
const PROMETHEUS_HIGH_CARDINALITY_KEYS = new Set([
  'duration_ms',
  'error_message',
  'request_id',
  'session_id',
  'user_id',
  'account_id',
  'run_id',
  'command_id',
  'delivery_id',
  'gateway_binding_id',
])

function serviceAttributes(serviceName: string, serviceVersion: string | null | undefined) {
  return {
    'service.name': serviceName,
    ...(serviceVersion ? { 'service.version': serviceVersion } : {}),
  }
}

function normalizeString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function redactAttribute(key: string, value: CloudObservabilityAttributeValue) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (SENSITIVE_FIELD.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactCloudAttributeString(value).slice(0, MAX_STRING_LENGTH)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  return String(value).slice(0, MAX_STRING_LENGTH)
}

function redactCloudAttributeString(value: string) {
  // First pass through the single-source shared sanitizer so cloud telemetry gets the full
  // provider-key/JWT/envelope/secret-ref/email pattern set (not just the cloud-specific extras
  // below). This also covers the 500-error path that logs raw error.message via recordCloudLog.
  let redacted = sanitizeLogMessage(value).replace(SIGNED_URL_QUERY_PATTERN, '$1?[redacted]')
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|password|credential|api[_-]?key|kms[_-]?ref|ciphertext)=([^\s"'&]+)/gi, (match) => {
      const [key] = match.split('=')
      return `${key}=[redacted]`
    })
    .replace(/\b(?:enc|plain):v1:[A-Za-z0-9_-]+\b/g, '[redacted-secret]')
    .replace(/\b(?:gcp-sm|aws-sm|azure-kv):\/\/[^\s"'<>]+/gi, '[redacted-secret-ref]')
    .replace(/\bhttps:\/\/[A-Za-z0-9.-]+\.vault\.azure\.net\/secrets\/[^\s"'<>]+/gi, '[redacted-secret-ref]')
    .replace(/oc(?:c|gw|w)_[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
  // Email redaction is already done by sanitizeLogMessage above; the previous local
  // copy here was both redundant and a ReDoS (overlapping domain/TLD quantifiers).
  for (const pattern of LOCAL_PATH_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const prefix = match.match(/^(\/Users|\/home|[A-Z]:\\Users)/i)?.[0] || '[home]'
      return `${prefix}/[redacted]`
    })
  }
  return redacted
}

export function sanitizeCloudObservabilityAttributes(attributes: CloudObservabilityAttributes = {}) {
  const sanitized: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const cleanKey = key.trim().slice(0, 128)
    if (!cleanKey) continue
    const cleanValue = redactAttribute(cleanKey, value)
    if (cleanValue !== undefined) sanitized[cleanKey] = cleanValue
  }
  return sanitized
}

function sanitizeObservabilityName(value: string, fallback: string) {
  const cleaned = redactCloudAttributeString(value || fallback).slice(0, MAX_STRING_LENGTH)
  return cleaned || fallback
}

function sanitizeCloudLogRecord(record: CloudLogRecord): CloudLogRecord {
  return {
    ...record,
    name: sanitizeObservabilityName(record.name, 'cloud.log'),
    message: record.message === undefined
      ? undefined
      : redactCloudAttributeString(record.message).slice(0, MAX_STRING_LENGTH),
    attributes: sanitizeCloudObservabilityAttributes(record.attributes),
  }
}

function sanitizeCloudMetricRecord(record: CloudMetricRecord): CloudMetricRecord {
  return {
    ...record,
    name: sanitizeObservabilityName(record.name, 'cloud.metric'),
    unit: record.unit === undefined
      ? undefined
      : redactCloudAttributeString(record.unit).slice(0, 64),
    attributes: sanitizeCloudObservabilityAttributes(record.attributes),
  }
}

function sanitizeCloudSpanRecord(record: CloudSpanRecord): CloudSpanRecord {
  return {
    ...record,
    name: sanitizeObservabilityName(record.name, 'cloud.span'),
    attributes: sanitizeCloudObservabilityAttributes(record.attributes),
    statusMessage: record.statusMessage == null
      ? record.statusMessage
      : redactCloudAttributeString(record.statusMessage).slice(0, MAX_STRING_LENGTH),
  }
}

function prometheusMetricName(name: string) {
  const normalized = name.trim().replace(/[^a-zA-Z0-9_:]/g, '_').replace(/_+/g, '_')
  return /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(normalized) ? normalized : `open_cowork_cloud_${normalized}`
}

function prometheusLabelName(name: string) {
  const normalized = name.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_')
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized) ? normalized : `label_${normalized}`
}

function prometheusEscape(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function metricLabels(attributes: CloudObservabilityAttributes = {}) {
  const labels: Record<string, string> = {}
  const sanitized = sanitizeCloudObservabilityAttributes(attributes)
  for (const [key, value] of Object.entries(sanitized)) {
    const label = prometheusLabelName(key)
    if (PROMETHEUS_HIGH_CARDINALITY_KEYS.has(label)) continue
    if (value === null) continue
    labels[label] = String(value).slice(0, 128)
  }
  return labels
}

function metricKey(name: string, labels: Record<string, string>) {
  return `${name}\n${Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n')}`
}

function renderPrometheusPoint(name: string, point: CloudPrometheusMetricPoint) {
  const labelText = Object.entries(point.labels).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${prometheusEscape(value)}"`)
    .join(',')
  return `${name}${labelText ? `{${labelText}}` : ''} ${point.value}`
}

function otlpAttributes(attributes: CloudObservabilityAttributes = {}) {
  return Object.entries(sanitizeCloudObservabilityAttributes(attributes)).map(([key, value]) => {
    if (typeof value === 'number') return { key, value: { doubleValue: value } }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } }
    return { key, value: { stringValue: value === null ? '' : String(value) } }
  })
}

function timeUnixNano(date: Date) {
  return String(BigInt(date.getTime()) * 1_000_000n)
}

function traceId() {
  return randomBytes(16).toString('hex')
}

function spanId() {
  return randomBytes(8).toString('hex')
}

function normalizeEndpoint(endpoint: string, suffix: string) {
  const trimmed = endpoint.trim()
  // Strip the maximal run of trailing slashes via a manual, linear-time scan.
  // Equivalent to `.replace(/\/+$/, '')` but without the super-linear backtracking
  // that regex exhibits on adversarial inputs like "////…/x".
  let end = trimmed.length
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47 /* '/' */) end -= 1
  const base = trimmed.slice(0, end)
  if (base.endsWith(suffix)) return base
  return `${base}${suffix}`
}

export function createNoopCloudObservability(): CloudObservabilityAdapter {
  return {
    log() {},
    metric() {},
    span() {},
    flush() {},
    close() {},
  }
}

async function observeBestEffort(callback: () => void | Promise<void>) {
  try {
    await callback()
  } catch {
    // Telemetry must never become part of product correctness.
  }
}

async function observeAllBestEffort(callbacks: Array<() => void | Promise<void>>) {
  await Promise.allSettled(callbacks.map((callback) => Promise.resolve().then(callback)))
}

export async function recordCloudLog(
  observability: CloudObservabilityAdapter | null | undefined,
  record: CloudLogRecord,
) {
  if (!observability) return
  const sanitized = sanitizeCloudLogRecord(record)
  await observeBestEffort(() => observability.log(sanitized))
}

export async function recordCloudMetric(
  observability: CloudObservabilityAdapter | null | undefined,
  record: CloudMetricRecord,
) {
  if (!observability) return
  const sanitized = sanitizeCloudMetricRecord(record)
  await observeBestEffort(() => observability.metric(sanitized))
}

export function createCompositeCloudObservability(adapters: Array<CloudObservabilityAdapter | null | undefined>): CloudObservabilityAdapter {
  const active = adapters.filter((adapter): adapter is CloudObservabilityAdapter => Boolean(adapter))
  if (active.length === 0) return createNoopCloudObservability()
  return {
    async log(record) {
      const sanitized = sanitizeCloudLogRecord(record)
      await observeAllBestEffort(active.map((adapter) => () => adapter.log(sanitized)))
    },
    async metric(record) {
      const sanitized = sanitizeCloudMetricRecord(record)
      await observeAllBestEffort(active.map((adapter) => () => adapter.metric(sanitized)))
    },
    async span(record) {
      const sanitized = sanitizeCloudSpanRecord(record)
      await observeAllBestEffort(active.map((adapter) => () => adapter.span(sanitized)))
    },
    renderPrometheus() {
      return active.map((adapter) => {
        try {
          return adapter.renderPrometheus?.() || ''
        } catch {
          return ''
        }
      }).filter(Boolean).join('\n')
    },
    async flush() {
      await observeAllBestEffort(active.map((adapter) => () => adapter.flush?.()))
    },
    async close() {
      await observeAllBestEffort(active.map((adapter) => () => adapter.close?.()))
    },
  }
}

export function createConsoleCloudObservability(options: ConsoleCloudObservabilityOptions = {}): CloudObservabilityAdapter {
  const format = options.format || 'json'
  const serviceName = options.serviceName || DEFAULT_SERVICE_NAME
  const serviceVersion = options.serviceVersion || null
  const sink = options.sink || ((line: string) => process.stdout.write(`${line}\n`))
  const now = options.now || (() => new Date())

  function write(record: CloudLogRecord) {
    if (format === 'silent') return
    const timestamp = (record.timestamp || now()).toISOString()
    const attributes = sanitizeCloudObservabilityAttributes({
      ...serviceAttributes(serviceName, serviceVersion),
      ...(record.attributes || {}),
    })
    const message = redactCloudAttributeString(record.message || record.name).slice(0, MAX_STRING_LENGTH)
    if (format === 'pretty') {
      sink(`[${timestamp}] [cloud:${record.level}] ${record.name}${message ? ` ${message}` : ''}`)
      return
    }
    sink(JSON.stringify({
      ts: timestamp,
      level: record.level,
      name: record.name,
      message,
      attributes,
    }))
  }

  return {
    log(record) {
      write(record)
    },
    metric(record) {
      write({
        level: 'debug',
        name: 'cloud.metric',
        message: record.name,
        attributes: {
          ...(record.attributes || {}),
          metric: record.name,
          value: record.value,
          unit: record.unit || '',
        },
        timestamp: record.timestamp,
      })
    },
    span(record) {
      write({
        level: record.status === 'error' ? 'error' : 'debug',
        name: 'cloud.span',
        message: record.name,
        attributes: {
          ...(record.attributes || {}),
          span: record.name,
          duration_ms: Math.max(0, record.endTime.getTime() - record.startTime.getTime()),
          status: record.status || 'ok',
        },
        timestamp: record.endTime,
      })
    },
  }
}

export function createPrometheusCloudObservability(): CloudObservabilityAdapter {
  const points = new Map<string, CloudPrometheusMetricPoint>()

  return {
    log() {},
    metric(record) {
      if (!Number.isFinite(record.value)) return
      const name = prometheusMetricName(record.name)
      const labels = metricLabels(record.attributes)
      const key = metricKey(name, labels)
      const kind = name.endsWith('_total') ? 'counter' : 'gauge'
      const existing = points.get(key)
      points.set(key, {
        kind,
        help: `${name} emitted by Open Cowork Cloud.`,
        value: kind === 'counter' ? (existing?.value || 0) + record.value : record.value,
        labels,
      })
    },
    span() {},
    renderPrometheus() {
      const byName = new Map<string, CloudPrometheusMetricPoint[]>()
      for (const [key, point] of points.entries()) {
        const [name] = key.split('\n')
        if (!name) continue
        const metricPoints = byName.get(name) || []
        metricPoints.push(point)
        byName.set(name, metricPoints)
      }
      const lines: string[] = []
      for (const [name, metricPoints] of [...byName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const kind = metricPoints.some((point) => point.kind === 'counter') ? 'counter' : 'gauge'
        lines.push(`# HELP ${name} ${metricPoints[0]?.help || `${name} emitted by Open Cowork Cloud.`}`)
        lines.push(`# TYPE ${name} ${kind}`)
        for (const point of metricPoints.sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)))) {
          lines.push(renderPrometheusPoint(name, point))
        }
      }
      lines.push('')
      return lines.join('\n')
    },
  }
}

export function createOtlpHttpCloudObservability(options: OtlpHttpCloudObservabilityOptions): CloudObservabilityAdapter {
  const fetcher = options.fetch || globalThis.fetch
  const serviceName = options.serviceName || DEFAULT_SERVICE_NAME
  const serviceVersion = options.serviceVersion || null
  const maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize || DEFAULT_OTLP_MAX_QUEUE_SIZE))
  const flushIntervalMs = Math.max(0, Math.floor(options.flushIntervalMs ?? DEFAULT_OTLP_FLUSH_INTERVAL_MS))
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  }
  const spans: CloudSpanRecord[] = []
  const metrics: CloudMetricRecord[] = []
  let droppedSpansTotal = 0
  let droppedMetricsTotal = 0
  let flushing: Promise<void> | null = null

  function enqueue<T>(queue: T[], record: T, onDrop: () => void) {
    if (queue.length >= maxQueueSize) {
      queue.shift()
      onDrop()
    }
    queue.push(record)
  }

  async function post(path: '/v1/traces' | '/v1/metrics', body: unknown) {
    const response = await fetcher(normalizeEndpoint(options.endpoint, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`OTLP export failed with HTTP ${response.status}.`)
  }

  async function flushSpans() {
    if (spans.length === 0) return
    const pending = spans.splice(0)
    await post('/v1/traces', {
      resourceSpans: [{
        resource: {
          attributes: otlpAttributes(serviceAttributes(serviceName, serviceVersion)),
        },
        scopeSpans: [{
          scope: { name: 'open-cowork-cloud' },
          spans: pending.map((span) => ({
            traceId: traceId(),
            spanId: spanId(),
            name: span.name,
            kind: 2,
            startTimeUnixNano: timeUnixNano(span.startTime),
            endTimeUnixNano: timeUnixNano(span.endTime),
            attributes: otlpAttributes(span.attributes),
            status: {
              code: span.status === 'error' ? 2 : 1,
              ...(span.statusMessage ? { message: redactCloudAttributeString(span.statusMessage).slice(0, MAX_STRING_LENGTH) } : {}),
            },
          })),
        }],
      }],
    })
  }

  async function flushMetrics() {
    if (metrics.length === 0 && droppedSpansTotal === 0 && droppedMetricsTotal === 0) return
    const pending = metrics.splice(0)
    if (droppedSpansTotal > 0) {
      pending.push({
        name: 'open_cowork_cloud_otlp_dropped_records_total',
        value: droppedSpansTotal,
        unit: '1',
        attributes: { kind: 'span' },
      })
    }
    if (droppedMetricsTotal > 0) {
      pending.push({
        name: 'open_cowork_cloud_otlp_dropped_records_total',
        value: droppedMetricsTotal,
        unit: '1',
        attributes: { kind: 'metric' },
      })
    }
    await post('/v1/metrics', {
      resourceMetrics: [{
        resource: {
          attributes: otlpAttributes(serviceAttributes(serviceName, serviceVersion)),
        },
        scopeMetrics: [{
          scope: { name: 'open-cowork-cloud' },
          metrics: pending.map((metric) => ({
            name: metric.name,
            unit: metric.unit || '',
            sum: {
              aggregationTemporality: 2,
              isMonotonic: metric.name.endsWith('_total'),
              dataPoints: [{
                timeUnixNano: timeUnixNano(metric.timestamp || new Date()),
                asDouble: metric.value,
                attributes: otlpAttributes(metric.attributes),
              }],
            },
          })),
        }],
      }],
    })
  }

  async function flushAll() {
    if (flushing) return flushing
    flushing = (async () => {
      await Promise.allSettled([
        flushSpans(),
        flushMetrics(),
      ])
    })()
    try {
      await flushing
    } finally {
      flushing = null
    }
  }

  const flushTimer = flushIntervalMs > 0
    ? setInterval(() => {
        void flushAll()
      }, flushIntervalMs)
    : null
  flushTimer?.unref?.()

  return {
    log() {},
    metric(record) {
      if (!Number.isFinite(record.value)) return
      enqueue(metrics, record, () => {
        droppedMetricsTotal += 1
      })
    },
    span(record) {
      enqueue(spans, record, () => {
        droppedSpansTotal += 1
      })
    },
    async flush() {
      await flushAll()
    },
    async close() {
      if (flushTimer) clearInterval(flushTimer)
      await flushAll()
    },
  }
}

export async function recordCloudHttpRequest(
  observability: CloudObservabilityAdapter | null | undefined,
  input: CloudHttpRequestObservation,
) {
  if (!observability) return
  const timestamp = input.timestamp || new Date()
  const status = input.statusCode >= 500 ? 'error' : 'ok'
  const attributes = {
    request_id: input.requestId,
    'http.request.method': input.method,
    'url.path': input.path,
    'http.response.status_code': input.statusCode,
    'cloud.role': input.role,
    'cloud.profile': input.profileName,
  }
  await recordCloudLog(observability, {
    level: input.statusCode >= 500 ? 'error' : input.statusCode >= 400 ? 'warn' : 'info',
    name: 'cloud.http.request',
    message: `${input.method} ${input.path} ${input.statusCode}`,
    attributes: {
      ...attributes,
      duration_ms: input.durationMs,
    },
    timestamp,
  })
  await recordCloudMetric(observability, {
    name: 'cloud.http.server.duration_ms',
    value: input.durationMs,
    unit: 'ms',
    attributes,
    timestamp,
  })
  await recordCloudMetric(observability, {
    name: 'open_cowork_cloud_http_requests_total',
    value: 1,
    unit: '1',
    attributes: {
      'http.request.method': input.method,
      'url.path': input.path,
      'http.response.status_code': input.statusCode,
      'cloud.role': input.role,
      'cloud.profile': input.profileName,
    },
    timestamp,
  })
  await recordCloudMetric(observability, {
    name: 'open_cowork_cloud_http_request_duration_ms',
    value: input.durationMs,
    unit: 'ms',
    attributes: {
      'http.request.method': input.method,
      'url.path': input.path,
      'http.response.status_code': input.statusCode,
      'cloud.role': input.role,
      'cloud.profile': input.profileName,
    },
    timestamp,
  })
  await observeBestEffort(() => observability.span(sanitizeCloudSpanRecord({
    name: 'cloud.http.request',
    startTime: new Date(timestamp.getTime() - input.durationMs),
    endTime: timestamp,
    attributes: {
      ...attributes,
      duration_ms: input.durationMs,
    },
    status,
  })))
}

export async function recordCloudWorkerMetric(
  observability: CloudObservabilityAdapter | null | undefined,
  input: {
    name: string
    value?: number
    workerId: string
    tenantId?: string | null
    sessionId?: string | null
    status?: string | null
    durationMs?: number | null
    timestamp?: Date
  },
) {
  const timestamp = input.timestamp || new Date()
  await recordCloudMetric(observability, {
    name: input.name,
    value: input.value ?? 1,
    unit: input.name.endsWith('_ms') ? 'ms' : '1',
    attributes: {
      worker_id: input.workerId,
      tenant_id: input.tenantId || undefined,
      session_id: input.sessionId || undefined,
      status: input.status || undefined,
    },
    timestamp,
  })
}

export async function recordCloudSchedulerMetric(
  observability: CloudObservabilityAdapter | null | undefined,
  input: {
    name: string
    value?: number
    schedulerId: string
    status?: string | null
    durationMs?: number | null
    timestamp?: Date
  },
) {
  const timestamp = input.timestamp || new Date()
  await recordCloudMetric(observability, {
    name: input.name,
    value: input.value ?? 1,
    unit: input.name.endsWith('_ms') ? 'ms' : '1',
    attributes: {
      scheduler_id: input.schedulerId,
      status: input.status || undefined,
    },
    timestamp,
  })
}

function parseJsonHeaders(value: string | null) {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Cloud OTLP headers must be a JSON object.')
  }
  const headers: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string') headers[key] = entry
  }
  return headers
}

function envValue(env: Env, key: string) {
  return normalizeString(env[key])
}

function parseOptionalNonNegativeInteger(env: Env, key: string) {
  const value = envValue(env, key)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer.`)
  }
  return parsed
}

function parseOptionalPositiveInteger(env: Env, key: string) {
  const value = envValue(env, key)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`)
  }
  return parsed
}

export function createCloudObservabilityFromEnv(env: Env = process.env) {
  const serviceName = envValue(env, 'OPEN_COWORK_CLOUD_SERVICE_NAME') || DEFAULT_SERVICE_NAME
  const serviceVersion = envValue(env, 'OPEN_COWORK_CLOUD_SERVICE_VERSION')
  const format = envValue(env, 'OPEN_COWORK_CLOUD_LOG_FORMAT') || 'json'
  const otlpEndpoint = envValue(env, 'OPEN_COWORK_CLOUD_OTLP_ENDPOINT')
  const adapters: CloudObservabilityAdapter[] = []

  if (format === 'json' || format === 'pretty' || format === 'silent') {
    adapters.push(createConsoleCloudObservability({
      serviceName,
      serviceVersion,
      format,
    }))
    adapters.push(createPrometheusCloudObservability())
  } else {
    throw new Error(`Invalid cloud log format "${format}".`)
  }
  if (otlpEndpoint) {
    adapters.push(createOtlpHttpCloudObservability({
      endpoint: otlpEndpoint,
      serviceName,
      serviceVersion,
      headers: parseJsonHeaders(envValue(env, 'OPEN_COWORK_CLOUD_OTLP_HEADERS')),
      flushIntervalMs: parseOptionalNonNegativeInteger(env, 'OPEN_COWORK_CLOUD_OTLP_FLUSH_INTERVAL_MS'),
      maxQueueSize: parseOptionalPositiveInteger(env, 'OPEN_COWORK_CLOUD_OTLP_MAX_QUEUE_SIZE'),
    }))
  }

  return createCompositeCloudObservability(adapters)
}
