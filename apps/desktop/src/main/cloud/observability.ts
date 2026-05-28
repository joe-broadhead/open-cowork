import { randomBytes } from 'node:crypto'

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

const DEFAULT_SERVICE_NAME = 'open-cowork-cloud'
const SENSITIVE_FIELD = /(authorization|cookie|token|secret|password|credential|key)$/i
const MAX_STRING_LENGTH = 512
const SIGNED_URL_QUERY_PATTERN = /\b(https?:\/\/[^\s"'<>?]+)\?[^"'<> \t\r\n]+/gi
const LOCAL_PATH_PATTERNS = [
  /\/Users\/[^\s"'`:]+/g,
  /\/home\/[^\s"'`:]+/g,
  /[A-Z]:\\Users\\[^\s"'`:]+/gi,
]

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
  let redacted = value.replace(SIGNED_URL_QUERY_PATTERN, '$1?[redacted]')
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
  const base = endpoint.trim().replace(/\/+$/, '')
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

export function createCompositeCloudObservability(adapters: Array<CloudObservabilityAdapter | null | undefined>): CloudObservabilityAdapter {
  const active = adapters.filter((adapter): adapter is CloudObservabilityAdapter => Boolean(adapter))
  if (active.length === 0) return createNoopCloudObservability()
  return {
    async log(record) {
      await Promise.all(active.map((adapter) => adapter.log(record)))
    },
    async metric(record) {
      await Promise.all(active.map((adapter) => adapter.metric(record)))
    },
    async span(record) {
      await Promise.all(active.map((adapter) => adapter.span(record)))
    },
    async flush() {
      await Promise.all(active.map((adapter) => adapter.flush?.()))
    },
    async close() {
      await Promise.all(active.map((adapter) => adapter.close?.()))
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
    if (format === 'pretty') {
      sink(`[${timestamp}] [cloud:${record.level}] ${record.name}${record.message ? ` ${record.message}` : ''}`)
      return
    }
    sink(JSON.stringify({
      ts: timestamp,
      level: record.level,
      name: record.name,
      message: record.message || record.name,
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

export function createOtlpHttpCloudObservability(options: OtlpHttpCloudObservabilityOptions): CloudObservabilityAdapter {
  const fetcher = options.fetch || globalThis.fetch
  const serviceName = options.serviceName || DEFAULT_SERVICE_NAME
  const serviceVersion = options.serviceVersion || null
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  }
  const spans: CloudSpanRecord[] = []
  const metrics: CloudMetricRecord[] = []

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
              ...(span.statusMessage ? { message: span.statusMessage } : {}),
            },
          })),
        }],
      }],
    })
  }

  async function flushMetrics() {
    if (metrics.length === 0) return
    const pending = metrics.splice(0)
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
              isMonotonic: false,
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

  return {
    log() {},
    metric(record) {
      metrics.push(record)
    },
    span(record) {
      spans.push(record)
    },
    async flush() {
      await flushSpans()
      await flushMetrics()
    },
    async close() {
      await flushSpans()
      await flushMetrics()
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
  await observability.log({
    level: input.statusCode >= 500 ? 'error' : input.statusCode >= 400 ? 'warn' : 'info',
    name: 'cloud.http.request',
    message: `${input.method} ${input.path} ${input.statusCode}`,
    attributes: {
      ...attributes,
      duration_ms: input.durationMs,
    },
    timestamp,
  })
  await observability.metric({
    name: 'cloud.http.server.duration_ms',
    value: input.durationMs,
    unit: 'ms',
    attributes,
    timestamp,
  })
  await observability.span({
    name: 'cloud.http.request',
    startTime: new Date(timestamp.getTime() - input.durationMs),
    endTime: timestamp,
    attributes: {
      ...attributes,
      duration_ms: input.durationMs,
    },
    status,
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
  } else {
    throw new Error(`Invalid cloud log format "${format}".`)
  }
  if (otlpEndpoint) {
    adapters.push(createOtlpHttpCloudObservability({
      endpoint: otlpEndpoint,
      serviceName,
      serviceVersion,
      headers: parseJsonHeaders(envValue(env, 'OPEN_COWORK_CLOUD_OTLP_HEADERS')),
    }))
  }

  return createCompositeCloudObservability(adapters)
}
