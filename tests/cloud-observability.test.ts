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
  sanitizeCloudMetricAttributes,
  type CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'
import { WORKSPACE_POLICY_DENIAL_CODES } from '@open-cowork/shared'

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
    byok_error: 'provider failed for Bearer [redacted] and user [REDACTED_EMAIL] at /home/[redacted] with [REDACTED_SECRET_REF]',
    count: 2,
    ok: true,
  })
})

test('cloud metric attributes reject identifiers, content, paths, and credentials', () => {
  assert.deepEqual(sanitizeCloudMetricAttributes({
    tenant_id: 'tenant-1',
    sessionId: 'session-1',
    worker_id: 'worker-1',
    request_id: 'request-1',
    'url.path': '/api/sessions/session-1',
    prompt: 'customer prompt',
    error_message: 'private failure',
    authorization: 'Bearer private-token',
    undeclared_dimension: 'unbounded-value',
    status: 'saturated',
    reason: 'queue_full',
    'cloud.role': 'worker',
  }), {
    status: 'saturated',
    reason: 'queue_full',
    cloud_role: 'worker',
  })
  assert.deepEqual(sanitizeCloudMetricAttributes({
    status: 'status-per-customer-123',
    reason: 'reason-per-session-456',
    'http.request.method': 'X-TENANT-789',
    'http.response.status_code': 60_000,
    'cloud.profile': 'tenant-private-profile',
  }), {
    status: 'other',
    reason: 'other',
    http_request_method: 'other',
    http_response_status_code: 'other',
    cloud_profile: 'custom',
  })
  assert.deepEqual(sanitizeCloudMetricAttributes({
    'cloud.role': 'worker',
    'cloud-role': 'scheduler',
    cloud___role: 'web',
  }), {
    cloud_role: 'web',
  })
})

test('cloud metric attributes preserve every closed workspace policy denial code', () => {
  for (const denialCode of WORKSPACE_POLICY_DENIAL_CODES) {
    assert.deepEqual(sanitizeCloudMetricAttributes({
      workspace_policy_reason: denialCode,
    }), {
      workspace_policy_reason: denialCode,
    })
  }
  assert.deepEqual(sanitizeCloudMetricAttributes({
    workspace_policy_reason: 'tenant-controlled-reason',
  }), {
    workspace_policy_reason: 'other',
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
  await adapter.metric({
    name: 'open_cowork_cloud_runtime_capacity_in_use',
    value: 1,
    attributes: {
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      worker_id: 'worker-1',
      'url.path': '/private/session-1',
      prompt: 'private prompt',
      token: 'private-token',
      status: 'saturated',
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
  const metric = JSON.parse(lines[1] || '{}') as Record<string, unknown>
  assert.deepEqual(metric.attributes, {
    'service.name': 'open-cowork-cloud-test',
    'service.version': '1.2.3',
    status: 'saturated',
    metric: 'open_cowork_cloud_runtime_capacity_in_use',
    value: 1,
    unit: '',
  })
  assert.equal(JSON.stringify(metric).includes('tenant-1'), false)
  assert.equal(JSON.stringify(metric).includes('session-1'), false)
  assert.equal(JSON.stringify(metric).includes('private prompt'), false)
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
  assert.deepEqual((metrics[0] as Record<string, unknown>).attributes, {
    http_request_method: 'POST',
    http_response_status_code: 201,
    cloud_role: 'web',
    cloud_profile: 'full',
  })
  assert.equal((spans[0] as Record<string, unknown>).name, 'cloud.http.request')
  assert.equal((spans[0] as Record<string, unknown>).status, 'ok')
})

test('cloud observability helpers sanitize records before custom adapters receive them', async () => {
  const logs: unknown[] = []
  const metrics: unknown[] = []
  const spans: unknown[] = []
  const adapter: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span(record) { spans.push(record) },
  }
  const signedUrl = 'https://bucket.example.test/object.txt?X-Amz-Signature=secret'
  const workerCredential = `ocw_mwcred_${'a'.repeat(16)}_${'b'.repeat(32)}`

  await recordCloudHttpRequest(adapter, {
    requestId: workerCredential,
    method: 'POST',
    path: `/api/sessions?download=${encodeURIComponent(signedUrl)}`,
    statusCode: 500,
    durationMs: 42,
    role: 'web',
    profileName: 'full',
    timestamp: new Date('2026-01-01T00:00:01.000Z'),
  })
  await recordCloudMetric(adapter, {
    name: `cloud.metric.${workerCredential}`,
    value: 1,
    attributes: {
      token: workerCredential,
      object_store_url: signedUrl,
      local_path: '/Users/alice/acme-private',
      error_message: `failed Bearer ${workerCredential}`,
    },
  })
  await recordCloudWorkerMetric(adapter, {
    name: `open_cowork_cloud_worker_${workerCredential}_total`,
    status: `failed ${workerCredential}`,
  })
  await recordCloudSchedulerMetric(adapter, {
    name: `open_cowork_cloud_scheduler_${workerCredential}_total`,
    status: `failed ${workerCredential}`,
  })

  const text = JSON.stringify({ logs, metrics, spans })
  assert.equal(text.includes(workerCredential), false)
  assert.equal(text.includes('X-Amz-Signature=secret'), false)
  assert.equal(text.includes('/Users/alice'), false)
  assert.match(text, /\[redacted\]|\[REDACTED_TOKEN\]/)
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
    status: 'ok',
  }))
  await assert.doesNotReject(() => recordCloudSchedulerMetric(adapter, {
    name: 'open_cowork_cloud_scheduler_claims_total',
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
      tenant_id: 'tenant-1',
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
      tenant_id: 'tenant-2',
      session_id: 'session-2',
      'http.request.method': 'GET',
      'url.path': '/api/workspace',
      token: 'secret-token',
    },
  })
  await adapter.metric({
    name: 'cloud_explicit_gauge_total',
    value: 2,
    kind: 'gauge',
  })
  await adapter.metric({
    name: 'cloud_explicit_gauge_total',
    value: 3,
    kind: 'gauge',
  })
  const text = adapter.renderPrometheus?.() || ''
  assert.match(text, /# TYPE open_cowork_cloud_http_requests_total counter/)
  assert.match(text, /open_cowork_cloud_http_requests_total\{http_request_method="GET"\} 2/)
  assert.equal(text.includes('request-1'), false)
  assert.equal(text.includes('tenant-1'), false)
  assert.equal(text.includes('session-1'), false)
  assert.equal(text.includes('secret-token'), false)
  assert.match(text, /# TYPE cloud_explicit_gauge_total gauge/)
  assert.match(text, /cloud_explicit_gauge_total 3/)
})

test('cloud Prometheus preserves absolute cumulative CPU counters', async () => {
  const adapter = createPrometheusCloudObservability()
  await adapter.metric({
    name: 'open_cowork_cloud_worker_cpu_user_seconds_total',
    value: 0.25,
    kind: 'counter',
    unit: 's',
    aggregationTemporality: 'cumulative',
  })
  await adapter.metric({
    name: 'open_cowork_cloud_worker_cpu_user_seconds_total',
    value: 0.75,
    kind: 'counter',
    unit: 's',
    aggregationTemporality: 'cumulative',
  })
  assert.match(
    adapter.renderPrometheus?.() || '',
    /open_cowork_cloud_worker_cpu_user_seconds_total 0\.75/,
  )
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
    attributes: {
      request_id: 'req-1',
      tenant_id: 'tenant-1',
      session_id: 'session-1',
      'url.path': '/api/sessions/session-1',
      prompt: 'private prompt',
      token: 'private-token',
      status: 'saturated',
    },
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
  const metricPoint = ((((metric[0] as Record<string, unknown>).gauge as Record<string, unknown>)
    .dataPoints as Array<Record<string, unknown>>)[0] || {})
  const metricAttributeKeys = (
    metricPoint.attributes as Array<{ key: string }>
  ).map((entry) => entry.key)
  assert.deepEqual(metricAttributeKeys, ['status'])
  assert.equal(JSON.stringify(metricBody).includes('tenant-1'), false)
  assert.equal(JSON.stringify(metricBody).includes('session-1'), false)
  assert.equal(JSON.stringify(metricBody).includes('private prompt'), false)
})

test('cloud OTLP keeps cumulative counter start time stable across interleaved series', async () => {
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

  await adapter.metric({
    name: 'open_cowork_cloud_worker_cpu_user_seconds_total',
    value: 0.25,
    kind: 'counter',
    unit: 's',
    aggregationTemporality: 'cumulative',
  })
  await adapter.flush?.()
  await adapter.metric({
    name: 'open_cowork_cloud_worker_cpu_system_seconds_total',
    value: 0.5,
    kind: 'counter',
    unit: 's',
    aggregationTemporality: 'cumulative',
  })
  await adapter.flush?.()
  await adapter.metric({
    name: 'open_cowork_cloud_worker_cpu_user_seconds_total',
    value: 0.75,
    kind: 'counter',
    unit: 's',
    aggregationTemporality: 'cumulative',
  })
  await adapter.flush?.()

  const metricRequests = requests.filter((request) => request.url.endsWith('/v1/metrics'))
  assert.equal(metricRequests.length, 3)
  const exportedSums = metricRequests.map((request) => {
    const body = JSON.parse(request.init?.body || '{}') as Record<string, unknown>
    const metrics = ((((body.resourceMetrics as unknown[])[0] as Record<string, unknown>)
      .scopeMetrics as unknown[])[0] as Record<string, unknown>).metrics as Array<Record<string, unknown>>
    return metrics[0]?.sum as Record<string, unknown>
  })
  assert.deepEqual(exportedSums.map((sum) => sum.aggregationTemporality), [2, 2, 2])
  const dataPoints = exportedSums.map((sum) => (
    ((sum.dataPoints as Array<Record<string, unknown>>)[0] || {})
  ))
  assert.deepEqual(dataPoints.map((point) => point.asDouble), [0.25, 0.5, 0.75])
  assert.equal(typeof dataPoints[0]?.startTimeUnixNano, 'string')
  assert.equal(dataPoints[2]?.startTimeUnixNano, dataPoints[0]?.startTimeUnixNano)
})

test('cloud OTLP exports runtime state as gauges and totals as sums', async () => {
  const requests: Array<{ url: string, init?: { body?: string } }> = []
  const adapter = createOtlpHttpCloudObservability({
    endpoint: 'https://otel.example.test',
    flushIntervalMs: 0,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init as typeof requests[number]['init'] })
      return new Response('{}', { status: 200 })
    },
  })

  await adapter.metric({
    name: 'open_cowork_cloud_runtime_capacity_in_use',
    value: 2,
    kind: 'gauge',
    unit: '1',
  })
  await adapter.metric({
    name: 'open_cowork_cloud_worker_command_duration_ms',
    value: 125,
    kind: 'gauge',
    unit: 'ms',
  })
  await adapter.metric({
    name: 'open_cowork_cloud_runtime_admission_rejections_total',
    value: 1,
    kind: 'counter',
    unit: '1',
  })
  await adapter.metric({
    name: 'cloud_explicit_gauge_total',
    value: 3,
    kind: 'gauge',
  })
  await adapter.flush?.()

  const request = requests.find((entry) => entry.url.endsWith('/v1/metrics'))
  const body = JSON.parse(request?.init?.body || '{}') as Record<string, unknown>
  const metrics = ((((body.resourceMetrics as unknown[])[0] as Record<string, unknown>)
    .scopeMetrics as unknown[])[0] as Record<string, unknown>).metrics as Array<Record<string, unknown>>
  const capacity = metrics.find((metric) => metric.name === 'open_cowork_cloud_runtime_capacity_in_use')
  const duration = metrics.find((metric) => metric.name === 'open_cowork_cloud_worker_command_duration_ms')
  const rejections = metrics.find((metric) => metric.name === 'open_cowork_cloud_runtime_admission_rejections_total')
  const explicitGauge = metrics.find((metric) => metric.name === 'cloud_explicit_gauge_total')

  assert.equal(capacity?.sum, undefined)
  assert.equal(
    (((capacity?.gauge as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
      ?.asDouble,
    2,
  )
  assert.equal(duration?.sum, undefined)
  assert.equal(
    (((duration?.gauge as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
      ?.asDouble,
    125,
  )
  assert.equal(rejections?.gauge, undefined)
  assert.equal((rejections?.sum as Record<string, unknown>).isMonotonic, true)
  assert.equal(explicitGauge?.sum, undefined)
  assert.equal(
    (((explicitGauge?.gauge as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
      ?.asDouble,
    3,
  )
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
  assert.equal(exportedMetrics[0]?.sum, undefined)
  assert.equal(
    ((((exportedMetrics[0]?.gauge as Record<string, unknown>)
      .dataPoints as Array<Record<string, unknown>>)[0]) || {}).asDouble,
    2,
  )

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
    if (metric.name !== 'open_cowork_cloud_otlp_dropped_records_total') return false
    const dataPoint = (((metric.sum as Record<string, unknown>).dataPoints as Array<Record<string, unknown>>)[0])
    const attributes = dataPoint.attributes as Array<{ key: string, value: Record<string, unknown> }>
    return attributes.some((entry) => entry.key === 'kind' && entry.value.stringValue === 'metric')
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
