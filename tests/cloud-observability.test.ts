import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createCloudObservabilityFromEnv,
  createConsoleCloudObservability,
  createOtlpHttpCloudObservability,
  createPrometheusCloudObservability,
  recordCloudHttpRequest,
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
    local_path: '/Users/alice/acme-private',
    byok_error: 'provider failed for Bearer raw-token and user alice@example.test at /home/alice/project',
    count: 2,
    ok: true,
  }), {
    request_id: 'req-1',
    authorization: '[redacted]',
    cookie: '[redacted]',
    nested_secret: '[redacted]',
    object_store_url: 'https://bucket.s3.amazonaws.com/private/file.txt?[redacted]',
    local_path: '/Users/[redacted]',
    byok_error: 'provider failed for Bearer [redacted] and user [redacted-email] at /home/[redacted]',
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

test('cloud observability env factory parses OTLP settings and rejects invalid log formats', () => {
  assert.doesNotThrow(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_LOG_FORMAT: 'silent',
    OPEN_COWORK_CLOUD_OTLP_ENDPOINT: 'https://otel.example.test',
    OPEN_COWORK_CLOUD_OTLP_HEADERS: '{"X-Api-Key":"test"}',
    OPEN_COWORK_CLOUD_SERVICE_NAME: 'open-cowork-cloud-test',
  }))
  assert.throws(() => createCloudObservabilityFromEnv({
    OPEN_COWORK_CLOUD_LOG_FORMAT: 'verbose',
  }), /Invalid cloud log format/)
})
