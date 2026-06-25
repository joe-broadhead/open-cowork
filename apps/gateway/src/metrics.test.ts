import test from 'node:test'
import assert from 'node:assert/strict'

import { createGatewayMetrics, createLatencyHistogram, observeGatewayDeliveryLatency, renderPrometheusMetrics } from '../dist/index.js'

test('gateway Prometheus metrics include delivery, stream, and webhook operational counters', () => {
  const metrics = createGatewayMetrics(() => new Date('2026-01-01T00:00:00.000Z').getTime())
  metrics.incomingMessages = 2
  metrics.promptedMessages = 1
  metrics.deliveriesReceived = 3
  metrics.deliveriesSent = 2
  metrics.deliveryRetries = 1
  metrics.deliveryDeadLetters = 1
  metrics.webhookRequests = 4
  metrics.streamReconnects = 5
  metrics.sessionRenderRetries = 2
  metrics.sessionRenderDeadLetters = 1
  metrics.cursorPersistenceFailures = 1
  metrics.cloudSubscriptionErrors = 1
  metrics.droppedSessionEvents = 1
  metrics.providerMetrics.fake = {
    id: 'fake',
    kind: 'fake',
    state: 'healthy',
    incomingMessages: 2,
    inboundDuplicates: 1,
    inboundFailures: 1,
    promptedMessages: 1,
    interactionsResolved: 1,
    deliveriesReceived: 3,
    deliveriesSent: 2,
    deliveryRetries: 1,
    deliveryDeadLetters: 1,
    webhookRequests: 4,
    deliveryLatency: createLatencyHistogram(),
  }
  // One 120ms delivery — lands in the le="250" bucket on both the gateway-wide and
  // the per-provider histogram.
  observeGatewayDeliveryLatency(metrics, metrics.providerMetrics.fake, 120)

  const text = renderPrometheusMetrics(metrics, 2, 7, () => new Date('2026-01-01T00:01:00.000Z').getTime())

  assert.match(text, /open_cowork_gateway_uptime_seconds 60/)
  assert.match(text, /open_cowork_gateway_providers 2/)
  assert.match(text, /open_cowork_gateway_session_streams 7/)
  assert.match(text, /open_cowork_gateway_deliveries_sent_total 2/)
  assert.match(text, /open_cowork_gateway_delivery_retries_total 1/)
  assert.match(text, /open_cowork_gateway_delivery_dead_letters_total 1/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_bucket\{le="50"\} 0/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_bucket\{le="250"\} 1/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_bucket\{le="\+Inf"\} 1/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_sum 120/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_count 1/)
  assert.match(text, /open_cowork_gateway_provider_delivery_latency_ms_bucket\{provider_id="fake",provider_kind="fake",le="250"\} 1/)
  assert.match(text, /open_cowork_gateway_provider_delivery_latency_ms_count\{provider_id="fake",provider_kind="fake"\} 1/)
  assert.match(text, /open_cowork_gateway_webhook_requests_total 4/)
  assert.match(text, /open_cowork_gateway_stream_reconnects_total 5/)
  assert.match(text, /open_cowork_gateway_session_render_retries_total 2/)
  assert.match(text, /open_cowork_gateway_session_render_dead_letters_total 1/)
  assert.match(text, /open_cowork_gateway_cursor_persistence_failures_total 1/)
  assert.match(text, /open_cowork_gateway_cloud_subscription_errors_total 1/)
  assert.match(text, /open_cowork_gateway_provider_state\{provider_id="fake",provider_kind="fake",state="healthy"\} 1/)
  assert.match(text, /open_cowork_gateway_provider_webhook_requests_total\{provider_id="fake",provider_kind="fake"\} 4/)
  assert.match(text, /open_cowork_gateway_provider_interactions_resolved_total\{provider_id="fake",provider_kind="fake"\} 1/)
})
