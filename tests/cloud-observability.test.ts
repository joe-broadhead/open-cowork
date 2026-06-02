import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCloudObservabilityFromEnv,
  createCompositeCloudObservability,
  createConsoleCloudObservability,
  createOtlpHttpCloudObservability,
  createPrometheusCloudObservability,
  recordCloudHttpRequest,
  recordCloudMetric,
  recordCloudSchedulerMetric,
  recordCloudWorkerMetric,
  sanitizeCloudObservabilityAttributes,
  type CloudObservabilityAdapter,
} from '../apps/desktop/src/main/cloud/observability.ts'

test('cloud observability sanitizes secret-bearing attributes', () => {
  assert.deepEqual(sanitizeCloudObservabilityAttributes({
    request_id: 'req-1',
    authorization: 'Bearer private-token',
    cookie: 'session=private',
    nested_secret: 'private',
    object_store_url: 'https://bucket.s3.amazonaws.com/private/file.txt?X-Amz-Signature=private',
    secret_key_ref: 'gcp-sm://projects/PROJECT/secrets/open-cowork/versions/latest',
    kmsRef: 'aws-sm://open-cowork/cloud-secret?region=us-east-1',
    ciphertext: 'enc:v1:abcdefghijklmnopqrstuvwxyz1234567890',
    local_path: '/Users/alice/acme-private',
    byok_error: 'provider failed for Bearer raw-token and user alice@example.test at /home/alice/project with azure-kv://vault/secrets/key/v1',
    count: 2,
    ok: true,
  }), {
    request_id: 'req-1',
    authorization: '[redacted]',
    cookie: '[redacted]',
    nested_secret: '[redacted]',
    object_store_url: 'https://bucket.s3.amazonaws.com/private/file.txt?[redacted]',
    secret_key_ref: '[redacted]',
    kmsRef: '[redacted]',
    ciphertext: '[redacted]',
    local_path: '/Users/[redacted]',
    byok_error: 'provider failed for Bearer [redacted] and user [redacted-email] at /home/[redacted] with [redacted-secret-ref]',
    count: 2,
    ok: true,
  })
})

test('cloud console observability writes structured JSON records', async () => {
  const lines: string[] = []
  const adapter = createConsoleCloudObservability({
    serviceName: 'open-cowork-cloud-test',
    serviceVersion: '1.2.3',
    sink: (line) => lines.push(line),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })

  await adapter.log({
    level: 'info',
    name: 'cloud.test',
    message: 'hello Bearer private-token from /Users/alice/acme',
    attributes: {
      request_id: 'req-1',
      token: 'private-token',
    },
  })

  const parsed = JSON.parse(lines[0] || '{}') as Record<string, unknown>
  assert.equal(parsed.ts, '2026-01-01T00:00:00.000Z')
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.name, 'cloud.test')
  assert.equal(parsed.message, 'hello Bearer [redacted] from /Users/[redacted]')
  assert.equal((parsed.attributes as Record<string, unknown>)['service.name'], 'open-cowork-cloud-test')
  assert.equal((parsed.attributes as Record<string, unknown>)['service.version'], '1.2.3')
  assert.equal((parsed.attributes as Record<string, unknown>).token, '[redacted]')
})

test('cloud HTTP request observation emits log, metric, and span records', async () => {
  const logs: unknown[] = []
  const metrics: unknown[] = []
  const spans: unknown[] = []
  const adapter: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span(record) { spans.push(record) },
  }

  await recordCloudHttpRequest(adapter, {
    requestId: 'req-1',
    method: 'POST',
    path: '/api/sessions',
    statusCode: 201,
    durationMs: 42,
    role: 'web',
    profileName: 'full',
    timestamp: new Date('2026-01-01T00:00:01.000Z'),
  })

  assert.equal((logs[0] as Record<string, unknown>).name, 'cloud.http.request')
  assert.equal((metrics[0] as Record<string, unknown>).name, 'cloud.http.server.duration_ms')
  assert.equal((metrics[0] as Record<string, unknown>).value, 42)
  assert.equal((spans[0] as Record<string, unknown>).name, 'cloud.http.request')
  assert.equal((spans[0] as Record<string, unknown>).status, 'ok')
})

test('cloud observability record helpers isolate telemetry sink failures', async () => {
  const adapter: CloudObservabilityAdapter = {
    log() { throw new Error('log sink unavailable') },
    metric() { throw new Error('metric sink unavailable') },
    span() { throw new Error('span sink unavailable') },
  }

  await assert.doesNotReject(() => recordCloudHttpRequest(adapter, {
    requestId: 'req-1',
    method: 'POST',
    path: '/api/sessions',
    statusCode: 201,
    durationMs: 42,
    role: 'web',
    profileName: 'full',
  }))
  await assert.doesNotReject(() => recordCloudMetric(adapter, {
    name: 'cloud.test.metric',
    value: 1,
  }))
  await assert.doesNotReject(() => recordCloudWorkerMetric(adapter, {
    name: 'open_cowork_cloud_worker_commands_processed_total',
    workerId: 'worker-1',
    status: 'ok',
  }))
  await assert.doesNotReject(() => recordCloudSchedulerMetric(adapter, {
    name: 'open_cowork_cloud_scheduler_claims_total',
    schedulerId: 'scheduler-1',
    status: 'ok',
  }))
})

test('cloud composite observability keeps healthy adapters active when one fails', async () => {
  const metrics: unknown[] = []
  const failing: CloudObservabilityAdapter = {
    log() { throw new Error('log failed') },
    metric() { throw new Error('metric failed') },
    span() { throw new Error('span failed') },
    flush() { throw new Error('flush failed') },
    close() { throw new Error('close failed') },
  }
  const healthy: CloudObservabilityAdapter = {
    log() {},
    metric(record) { metrics.push(record) },
    span() {},
    flush() {},
    close() {},
  }
  const composite = createCompositeCloudObservability([failing, healthy])

  await assert.doesNotReject(() => composite.metric({ name: 'cloud.test', value: 1 }))
  await assert.doesNotReject(() => composite.flush?.() ?? Promise.resolve())
  await assert.doesNotReject(() => composite.close?.() ?? Promise.resolve())
  assert.equal((metrics[0] as Record<string, unknown>).name, 'cloud.test')
})

test('cloud Prometheus observability renders low-cardinality product metrics', async () => {
  const adapter = createPrometheusCloudObservability()
  await adapter.metric({
    name: 'open_cowork_cloud_http_requests_total',
    value: 1,
    attributes: {
      request_id: 'request-1',
      session_id: 'session-1',
      'http.request.method': 'GET',
      'url.path': '/api/workspace',
      token: 'secret-token',
    },
  })
  await adapter.metric({
    name: 'open_cowork_cloud_http_requests_total',
    value: 1,
    attributes: {
      request_id: 'request-2',
      session_id: 'session-2',
      'http.request.method': 'GET',
      'url.path': '/api/workspace',
      token: 'secret-token',
    },
  })
  const text = adapter.renderPrometheus?.() || ''
  assert.match(text, /# TYPE open_cowork_cloud_http_requests_total counter/)
  assert.match(text, /open_cowork_cloud_http_requests_total\{http_request_method="GET",token="\[redacted\]",url_path="\/api\/workspace"\} 2/)
  assert.equal(text.includes('request-1'), false)
  assert.equal(text.includes('session-1'), false)
  assert.equal(text.includes('secret-token'), false)
})

test('cloud OTLP observability exports trace and metric payloads with headers', async () => {
  const requests: Array<{ url: string, init?: { method?: string, headers?: Record<string, string>, body?: string } }> = []
  const adapter = createOtlpHttpCloudObservability({
    endpoint: 'https://otel.example.test',
    serviceName: 'open-cowork-cloud-test',
    headers: { Authorization: 'Bearer otlp-token' },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init as typeof requests[number]['init'] })
      return new Response('{}', { status: 200 })
    },
  })

  await adapter.span({
    name: 'cloud.http.request',
    startTime: new Date('2026-01-01T00:00:00.000Z'),
    endTime: new Date('2026-01-01T00:00:00.042Z'),
    attributes: {
      request_id: 'req-1',
      authorization: 'private',
    },
    status: 'ok',
  })
  await adapter.metric({
    name: 'cloud.http.server.duration_ms',
    value: 42,
    unit: 'ms',
    attributes: { request_id: 'req-1' },
    timestamp: new Date('2026-01-01T00:00:00.042Z'),
  })
  await adapter.flush?.()

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.url, 'https://otel.example.test/v1/traces')
  assert.equal(requests[0]?.init?.method, 'POST')
  assert.equal(requests[0]?.init?.headers?.Authorization, 'Bearer otlp-token')
  const traceBody = JSON.parse(requests[0]?.init?.body || '{}') as Record<string, unknown>
  const span = (((traceBody.resourceSpans as unknown[])[0] as Record<string, unknown>)
    .scopeSpans as unknown[])[0] as Record<string, unknown>
  const exportedSpan = (span.spans as unknown[])[0] as Record<string, unknown>
  const attributes = exportedSpan.attributes as Array<{ key: string, value: Record<string, unknown> }>
  assert.equal(attributes.find((entry) => entry.key === 'authorization')?.value.stringValue, '[redacted]')

  assert.equal(requests[1]?.url, 'https://otel.example.test/v1/metrics')
  const metricBody = JSON.parse(requests[1]?.init?.body || '{}') as Record<string, unknown>
  const metric = ((((metricBody.resourceMetrics as unknown[])[0] as Record<string, unknown>)
    .scopeMetrics as unknown[])[0] as Record<string, unknown>).metrics as unknown[]
  assert.equal((metric[0] as Record<string, unknown>).name, 'cloud.http.server.duration_ms')
})

test('cloud OTLP observability bounds queues and exports drop counters', async () => {
  const requests: Array<{ url: string, init?: { body?: string } }> = []
  const adapter = createOtlpHttpCloudObservability({
    endpoint: 'https://otel.example.test',
    flushIntervalMs: 0,
    maxQueueSize: 1,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init as typeof requests[number]['init'] })
      return new Response('{}', { status: 200 })
    },
  })

  await adapter.metric({ name: 'cloud.first_metric', value: 1 })
  await adapter.metric({ name: 'cloud.second_metric', value: 2 })
  await adapter.span({
    name: 'cloud.first_span',
    startTime: new Date('2026-01-01T00:00:00.000Z'),
    endTime: new Date('2026-01-01T00:00:00.001Z'),
  })
  await adapter.span({
    name: 'cloud.second_span',
    startTime: new Date('2026-01-01T00:00:00.002Z'),
    endTime: new Date('2026-01-01T00:00:00.003Z'),
  })
  await adapter.flush?.()

  function exportedMetricsFrom(request: { init?: { body?: string } }) {
    const metricBody = JSON.parse(request.init?.body || '{}') as Record<string, unknown>
    return ((((metricBody.resourceMetrics as unknown[])[0] as Record<string, unknown>)
      .scopeMetrics as unknown[])[0] as Record<string, unknown>).metrics as Array<Record<string, unknown>>
  }

  const traceBody = JSON.parse(requests.find((request) => request.url.endsWith('/v1/traces'))?.init?.body || '{}') as Record<string, unknown>
  const exportedSpans = ((((traceBody.resourceSpans as unknown[])[0] as Record<string, unknown>)
    .scopeSpans as unknown[])[0] as Record<string, unknown>).spans as Array<Record<string, unknown>>
  assert.deepEqual(exportedSpans.map((span) => span.name), ['cloud.second_span'])

  const metricRequests = requests.filter((request) => request.url.endsWith('/v1/metrics'))
  const exportedMetrics = exportedMetricsFrom(metricRequests[0] || {})
  assert.deepEqual(exportedMetrics.map((metric) => metric.name), [
    'cloud.second_metric',
    'open_cowork_cloud_otlp_dropped_records_total',
    'open_cowork_cloud_otlp_dropped_records_total',
  ])
  assert.equal((exportedMetrics[0]?.sum as Record<string, unknown>).isMonotonic, false)

  const droppedMetrics = exportedMetrics.filter((metric) => metric.name === 'open_cowork_cloud_otlp_dropped_records_total')
  const droppedMetricCounter = droppedMetrics.find((metric) => {
    const dataPoint = (((metric.sum as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
    const attributes = dataPoint.attributes as Array<{ key: string, value: Record<string, unknown> }>
    return attributes.some((entry) => entry.key === 'kind' && entry.value.stringValue === 'metric')
  })
  assert.equal((droppedMetricCounter?.sum as Record<string, unknown>).isMonotonic, true)
  assert.equal((((droppedMetricCounter?.sum as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0] || {}).asDouble, 1)

  await adapter.metric({ name: 'cloud.third_metric', value: 3 })
  await adapter.metric({ name: 'cloud.fourth_metric', value: 4 })
  await adapter.flush?.()

  const secondExportedMetrics = exportedMetricsFrom(requests.filter((request) => request.url.endsWith('/v1/metrics'))[1] || {})
  const secondDroppedMetricCounter = secondExportedMetrics.find((metric) => {
    const dataPoint = (((metric.sum as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
    const attributes = dataPoint.attributes as Array<{ key: string, value: Record<string, unknown> }>
    return metric.name === 'open_cowork_cloud_otlp_dropped_records_total'
      && attributes.some((entry) => entry.key === 'kind' && entry.value.stringValue === 'metric')
  })
  assert.equal((((secondDroppedMetricCounter?.sum as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0] || {}).asDouble, 2)
})

test('cloud OTLP observability treats failed exports as best-effort loss', async () => {
  const requests: Array<{ url: string, init?: { body?: string } }> = []
  let failNextExport = true
  const adapter = createOtlpHttpCloudObservability({
    endpoint: 'https://otel.example.test',
    flushIntervalMs: 0,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init as typeof requests[number]['init'] })
      if (failNextExport) {
        failNextExport = false
        return new Response('{}', { status: 503 })
      }
      return new Response('{}', { status: 200 })
    },
  })

  await adapter.metric({ name: 'cloud.lost_metric', value: 1 })
  await assert.doesNotReject(() => adapter.flush?.() ?? Promise.resolve())
  assert.equal(requests.length, 1)

  await adapter.flush?.()
  assert.equal(requests.length, 1)

  await adapter.metric({ name: 'cloud.next_metric', value: 2 })
  await adapter.flush?.()
  assert.equal(requests.length, 2)
  const metricBody = JSON.parse(requests[1]?.init?.body || '{}') as Record<string, unknown>
  const exportedMetrics = ((((metricBody.resourceMetrics as unknown[])[0] as Record<string, unknown>)
    .scopeMetrics as unknown[])[0] as Record<string, unknown>).metrics as Array<Record<string, unknown>>
  assert.deepEqual(exportedMetrics.map((metric) => metric.name), ['cloud.next_metric'])
})

test('cloud OTLP observability periodically flushes queued records', async () => {
  const requests: string[] = []
  const adapter = createOtlpHttpCloudObservability({
    endpoint: 'https://otel.example.test',
    flushIntervalMs: 10,
    fetch: async (url) => {
      requests.push(String(url))
      return new Response('{}', { status: 200 })
    },
  })

  await adapter.metric({ name: 'cloud.periodic_metric', value: 1 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await adapter.close?.()

  assert.equal(requests.some((url) => url.endsWith('/v1/metrics')), true)
})

test('cloud observability env factory parses OTLP settings and rejects invalid log formats', () => {
  assert.doesNotThrow(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_LOG_FORMAT: 'silent',
    OPEN_COWORK_CLOUD_OTLP_ENDPOINT: 'https://otel.example.test',
    OPEN_COWORK_CLOUD_OTLP_HEADERS: '{"X-Api-Key":"test"}',
    OPEN_COWORK_CLOUD_OTLP_FLUSH_INTERVAL_MS: '1000',
    OPEN_COWORK_CLOUD_OTLP_MAX_QUEUE_SIZE: '250',
    OPEN_COWORK_CLOUD_SERVICE_NAME: 'open-cowork-cloud-test',
  }))
  assert.throws(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_LOG_FORMAT: 'verbose',
  }), /Invalid cloud log format/)
  assert.throws(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_OTLP_ENDPOINT: 'https://otel.example.test',
    OPEN_COWORK_CLOUD_OTLP_FLUSH_INTERVAL_MS: '-1',
  }), /OPEN_COWORK_CLOUD_OTLP_FLUSH_INTERVAL_MS/)
  assert.throws(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_OTLP_ENDPOINT: 'https://otel.example.test',
    OPEN_COWORK_CLOUD_OTLP_MAX_QUEUE_SIZE: '0',
  }), /OPEN_COWORK_CLOUD_OTLP_MAX_QUEUE_SIZE/)
})
