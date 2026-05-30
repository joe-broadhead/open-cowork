import test from 'node:test'
import assert from 'node:assert/strict'

import { createGatewayMetrics, renderPrometheusMetrics } from '../dist/index.js'

test('gateway Prometheus metrics include delivery, stream, and webhook operational counters', () => {
  const metrics = createGatewayMetrics(() => new Date('2026-01-01T00:00:00.000Z').getTime())
  metrics.incomingMessages = 2
  metrics.promptedMessages = 1
  metrics.deliveriesReceived = 3
  metrics.deliveriesSent = 2
  metrics.deliveryRetries = 1
  metrics.deliveryDeadLetters = 1
  metrics.deliveryLatencyMsTotal = 123
  metrics.webhookRequests = 4
  metrics.streamReconnects = 5
  metrics.cloudSubscriptionErrors = 1
  metrics.droppedSessionEvents = 1

  const text = renderPrometheusMetrics(metrics, 2, 7, () => new Date('2026-01-01T00:01:00.000Z').getTime())

  assert.match(text, /open_cowork_gateway_uptime_seconds 60/)
  assert.match(text, /open_cowork_gateway_providers 2/)
  assert.match(text, /open_cowork_gateway_session_streams 7/)
  assert.match(text, /open_cowork_gateway_deliveries_sent_total 2/)
  assert.match(text, /open_cowork_gateway_delivery_retries_total 1/)
  assert.match(text, /open_cowork_gateway_delivery_dead_letters_total 1/)
  assert.match(text, /open_cowork_gateway_delivery_latency_ms_total 123/)
  assert.match(text, /open_cowork_gateway_webhook_requests_total 4/)
  assert.match(text, /open_cowork_gateway_stream_reconnects_total 5/)
  assert.match(text, /open_cowork_gateway_cloud_subscription_errors_total 1/)
})
