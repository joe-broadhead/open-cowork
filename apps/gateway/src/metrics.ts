// Prometheus histogram bucket boundaries (ms) for delivery handling latency. Tuned
// for channel sends that normally complete in tens-to-hundreds of ms but can stall
// into the tens of seconds under provider rate limiting.
const GATEWAY_DELIVERY_LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000]

export type GatewayLatencyHistogram = {
  // Non-cumulative per-bucket counts; the final element is the +Inf overflow (values
  // larger than the last boundary). Rendered cumulatively as Prometheus requires.
  counts: number[]
  sum: number
  count: number
}

export type GatewayMetrics = {
  startedAt: number
  incomingMessages: number
  promptedMessages: number
  interactionsResolved: number
  deliveriesReceived: number
  deliveriesSent: number
  deliveryRetries: number
  deliveryDeadLetters: number
  webhookRequests: number
  deliveryLatency: GatewayLatencyHistogram
  streamReconnects: number
  streamEvictions: number
  sessionRenderRetries: number
  sessionRenderDeadLetters: number
  cursorPersistenceFailures: number
  cloudSubscriptionErrors: number
  droppedSessionEvents: number
  streamBackpressureDisconnects: number
  // High-water mark of deliveries queued in the bounded delivery dispatcher (audit P1-G2). A
  // sustained high value means the gateway is being pushed deliveries faster than its bounded
  // worker pool drains them — a backlog/backpressure signal for the operator.
  deliveryQueueDepthMax: number
  // Deliveries shed (not enqueued) because the local dispatcher queue hit its cap (P1-C); they
  // stay unacked and the cloud re-serves them, so this is a sustained-overload backpressure signal.
  deliverySheds: number
  // Duplicate delivery re-serves suppressed rather than re-sent to the channel: either the id is
  // still queued/in-flight in the dispatcher, or it was already sent and is re-acked instead of
  // re-dispatched. A sustained rate signals claim-TTL lapses or a cloud ack-recording problem.
  deliveryDuplicatesSuppressed: number
  errors: number
  providerMetrics: Record<string, GatewayProviderMetrics>
}

export type GatewayProviderMetricState = 'configured' | 'starting' | 'healthy' | 'unhealthy' | 'failed' | 'stopped'

export type GatewayProviderMetrics = {
  id: string
  kind: string
  state: GatewayProviderMetricState
  incomingMessages: number
  inboundDuplicates: number
  inboundFailures: number
  promptedMessages: number
  interactionsResolved: number
  deliveriesReceived: number
  deliveriesSent: number
  deliveryRetries: number
  deliveryDeadLetters: number
  webhookRequests: number
  deliveryLatency: GatewayLatencyHistogram
}

export function createLatencyHistogram(): GatewayLatencyHistogram {
  return { counts: new Array(GATEWAY_DELIVERY_LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 }
}

// Record one delivery handling latency sample on both the per-provider and the
// gateway-wide histogram. The gateway-wide series keeps a label-free aggregate for
// dashboards that do not break down by provider.
export function observeGatewayDeliveryLatency(
  metrics: GatewayMetrics,
  provider: GatewayProviderMetrics,
  ms: number,
) {
  const value = Math.max(0, ms)
  observeLatencyHistogram(metrics.deliveryLatency, value)
  observeLatencyHistogram(provider.deliveryLatency, value)
}

function observeLatencyHistogram(histogram: GatewayLatencyHistogram, value: number) {
  let index = GATEWAY_DELIVERY_LATENCY_BUCKETS_MS.findIndex((boundary) => value <= boundary)
  if (index === -1) index = GATEWAY_DELIVERY_LATENCY_BUCKETS_MS.length
  histogram.counts[index] = (histogram.counts[index] ?? 0) + 1
  histogram.sum += value
  histogram.count += 1
}

export function createGatewayMetrics(now = Date.now): GatewayMetrics {
  return {
    startedAt: now(),
    incomingMessages: 0,
    promptedMessages: 0,
    interactionsResolved: 0,
    deliveriesReceived: 0,
    deliveriesSent: 0,
    deliveryRetries: 0,
    deliveryDeadLetters: 0,
    webhookRequests: 0,
    deliveryLatency: createLatencyHistogram(),
    streamReconnects: 0,
    streamEvictions: 0,
    sessionRenderRetries: 0,
    sessionRenderDeadLetters: 0,
    cursorPersistenceFailures: 0,
    cloudSubscriptionErrors: 0,
    droppedSessionEvents: 0,
    streamBackpressureDisconnects: 0,
    deliveryQueueDepthMax: 0,
    deliverySheds: 0,
    deliveryDuplicatesSuppressed: 0,
    errors: 0,
    providerMetrics: {},
  }
}

export function ensureGatewayProviderMetrics(
  metrics: GatewayMetrics,
  provider: { id: string, kind: string },
): GatewayProviderMetrics {
  const existing = metrics.providerMetrics[provider.id]
  if (existing) {
    existing.kind = provider.kind
    return existing
  }
  const record: GatewayProviderMetrics = {
    id: provider.id,
    kind: provider.kind,
    state: 'configured',
    incomingMessages: 0,
    inboundDuplicates: 0,
    inboundFailures: 0,
    promptedMessages: 0,
    interactionsResolved: 0,
    deliveriesReceived: 0,
    deliveriesSent: 0,
    deliveryRetries: 0,
    deliveryDeadLetters: 0,
    webhookRequests: 0,
    deliveryLatency: createLatencyHistogram(),
  }
  metrics.providerMetrics[provider.id] = record
  return record
}

export function setGatewayProviderState(
  metrics: GatewayMetrics,
  provider: { id: string, kind: string },
  state: GatewayProviderMetricState,
) {
  ensureGatewayProviderMetrics(metrics, provider).state = state
}

export function renderPrometheusMetrics(metrics: GatewayMetrics, providerCount: number, activeSessionStreams = 0, now = Date.now) {
  const uptimeSeconds = Math.max(0, Math.floor((now() - metrics.startedAt) / 1000))
  return [
    '# HELP open_cowork_gateway_uptime_seconds Seconds since gateway start.',
    '# TYPE open_cowork_gateway_uptime_seconds gauge',
    `open_cowork_gateway_uptime_seconds ${uptimeSeconds}`,
    '# HELP open_cowork_gateway_providers Configured active provider count.',
    '# TYPE open_cowork_gateway_providers gauge',
    `open_cowork_gateway_providers ${providerCount}`,
    '# HELP open_cowork_gateway_incoming_messages_total Incoming channel messages handled.',
    '# TYPE open_cowork_gateway_incoming_messages_total counter',
    `open_cowork_gateway_incoming_messages_total ${metrics.incomingMessages}`,
    '# HELP open_cowork_gateway_prompted_messages_total Channel messages prompted into cloud sessions.',
    '# TYPE open_cowork_gateway_prompted_messages_total counter',
    `open_cowork_gateway_prompted_messages_total ${metrics.promptedMessages}`,
    '# HELP open_cowork_gateway_interactions_resolved_total Channel approval/question interactions resolved.',
    '# TYPE open_cowork_gateway_interactions_resolved_total counter',
    `open_cowork_gateway_interactions_resolved_total ${metrics.interactionsResolved}`,
    '# HELP open_cowork_gateway_deliveries_received_total Channel deliveries received from cloud.',
    '# TYPE open_cowork_gateway_deliveries_received_total counter',
    `open_cowork_gateway_deliveries_received_total ${metrics.deliveriesReceived}`,
    '# HELP open_cowork_gateway_deliveries_sent_total Channel deliveries successfully sent.',
    '# TYPE open_cowork_gateway_deliveries_sent_total counter',
    `open_cowork_gateway_deliveries_sent_total ${metrics.deliveriesSent}`,
    '# HELP open_cowork_gateway_delivery_retries_total Channel deliveries marked for retry.',
    '# TYPE open_cowork_gateway_delivery_retries_total counter',
    `open_cowork_gateway_delivery_retries_total ${metrics.deliveryRetries}`,
    '# HELP open_cowork_gateway_delivery_dead_letters_total Channel deliveries dead-lettered by the gateway.',
    '# TYPE open_cowork_gateway_delivery_dead_letters_total counter',
    `open_cowork_gateway_delivery_dead_letters_total ${metrics.deliveryDeadLetters}`,
    '# HELP open_cowork_gateway_delivery_latency_ms Delivery handling latency in milliseconds (cloud delivery received to channel send).',
    '# TYPE open_cowork_gateway_delivery_latency_ms histogram',
    ...latencyHistogramSeries('open_cowork_gateway_delivery_latency_ms', metrics.deliveryLatency, ''),
    '# HELP open_cowork_gateway_webhook_requests_total Provider webhook requests received.',
    '# TYPE open_cowork_gateway_webhook_requests_total counter',
    `open_cowork_gateway_webhook_requests_total ${metrics.webhookRequests}`,
    '# HELP open_cowork_gateway_session_streams Active session SSE streams.',
    '# TYPE open_cowork_gateway_session_streams gauge',
    `open_cowork_gateway_session_streams ${activeSessionStreams}`,
    '# HELP open_cowork_gateway_stream_reconnects_total Session stream reconnects after SSE/render failures.',
    '# TYPE open_cowork_gateway_stream_reconnects_total counter',
    `open_cowork_gateway_stream_reconnects_total ${metrics.streamReconnects}`,
    '# HELP open_cowork_gateway_stream_evictions_total Idle/over-capacity session streams evicted to bound memory and upstream connections.',
    '# TYPE open_cowork_gateway_stream_evictions_total counter',
    `open_cowork_gateway_stream_evictions_total ${metrics.streamEvictions}`,
    '# HELP open_cowork_gateway_session_render_retries_total Session events retried after transient channel rendering failures.',
    '# TYPE open_cowork_gateway_session_render_retries_total counter',
    `open_cowork_gateway_session_render_retries_total ${metrics.sessionRenderRetries}`,
    '# HELP open_cowork_gateway_session_render_dead_letters_total Session events skipped after render retry exhaustion or permanent render failures.',
    '# TYPE open_cowork_gateway_session_render_dead_letters_total counter',
    `open_cowork_gateway_session_render_dead_letters_total ${metrics.sessionRenderDeadLetters}`,
    '# HELP open_cowork_gateway_cursor_persistence_failures_total Failed attempts to persist channel session cursors.',
    '# TYPE open_cowork_gateway_cursor_persistence_failures_total counter',
    `open_cowork_gateway_cursor_persistence_failures_total ${metrics.cursorPersistenceFailures}`,
    '# HELP open_cowork_gateway_cloud_subscription_errors_total Cloud delivery subscription errors.',
    '# TYPE open_cowork_gateway_cloud_subscription_errors_total counter',
    `open_cowork_gateway_cloud_subscription_errors_total ${metrics.cloudSubscriptionErrors}`,
    '# HELP open_cowork_gateway_errors_total Gateway errors.',
    '# TYPE open_cowork_gateway_errors_total counter',
    `open_cowork_gateway_errors_total ${metrics.errors}`,
    '# HELP open_cowork_gateway_dropped_session_events_total Session events skipped after non-retryable channel rendering failures.',
    '# TYPE open_cowork_gateway_dropped_session_events_total counter',
    `open_cowork_gateway_dropped_session_events_total ${metrics.droppedSessionEvents}`,
    '# HELP open_cowork_gateway_stream_backpressure_disconnects_total Session streams detached from the upstream after the in-flight event queue hit its depth cap; recovered by resubscribing from the persisted cursor.',
    '# TYPE open_cowork_gateway_stream_backpressure_disconnects_total counter',
    `open_cowork_gateway_stream_backpressure_disconnects_total ${metrics.streamBackpressureDisconnects}`,
    '# HELP open_cowork_gateway_delivery_queue_depth_max High-water mark of deliveries queued in the bounded delivery dispatcher.',
    '# TYPE open_cowork_gateway_delivery_queue_depth_max gauge',
    `open_cowork_gateway_delivery_queue_depth_max ${metrics.deliveryQueueDepthMax}`,
    '# HELP open_cowork_gateway_delivery_sheds_total Deliveries shed because the local dispatcher queue hit its cap (re-served by the cloud).',
    '# TYPE open_cowork_gateway_delivery_sheds_total counter',
    `open_cowork_gateway_delivery_sheds_total ${metrics.deliverySheds}`,
    '# HELP open_cowork_gateway_delivery_duplicates_suppressed_total Duplicate delivery re-serves suppressed (still queued/in-flight, or already sent and re-acked) rather than re-sent to the channel.',
    '# TYPE open_cowork_gateway_delivery_duplicates_suppressed_total counter',
    `open_cowork_gateway_delivery_duplicates_suppressed_total ${metrics.deliveryDuplicatesSuppressed}`,
    ...renderProviderMetrics(metrics),
    '',
  ].join('\n')
}

function renderProviderMetrics(metrics: GatewayMetrics) {
  const providers = Object.values(metrics.providerMetrics)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (providers.length === 0) return []
  return [
    '# HELP open_cowork_gateway_provider_state Provider lifecycle state by configured provider.',
    '# TYPE open_cowork_gateway_provider_state gauge',
    ...providers.flatMap((provider) => providerStateSeries(provider)),
    '# HELP open_cowork_gateway_provider_incoming_messages_total Incoming channel messages accepted by provider.',
    '# TYPE open_cowork_gateway_provider_incoming_messages_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_incoming_messages_total', provider, provider.incomingMessages)),
    '# HELP open_cowork_gateway_provider_inbound_duplicates_total Duplicate inbound provider events skipped by durable claims.',
    '# TYPE open_cowork_gateway_provider_inbound_duplicates_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_inbound_duplicates_total', provider, provider.inboundDuplicates)),
    '# HELP open_cowork_gateway_provider_inbound_failures_total Inbound provider messages that failed before completion.',
    '# TYPE open_cowork_gateway_provider_inbound_failures_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_inbound_failures_total', provider, provider.inboundFailures)),
    '# HELP open_cowork_gateway_provider_prompted_messages_total Channel messages prompted into cloud sessions by provider.',
    '# TYPE open_cowork_gateway_provider_prompted_messages_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_prompted_messages_total', provider, provider.promptedMessages)),
    '# HELP open_cowork_gateway_provider_interactions_resolved_total Channel approval/question interactions resolved by provider.',
    '# TYPE open_cowork_gateway_provider_interactions_resolved_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_interactions_resolved_total', provider, provider.interactionsResolved)),
    '# HELP open_cowork_gateway_provider_deliveries_received_total Cloud deliveries received by provider binding.',
    '# TYPE open_cowork_gateway_provider_deliveries_received_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_deliveries_received_total', provider, provider.deliveriesReceived)),
    '# HELP open_cowork_gateway_provider_deliveries_sent_total Channel deliveries successfully sent by provider.',
    '# TYPE open_cowork_gateway_provider_deliveries_sent_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_deliveries_sent_total', provider, provider.deliveriesSent)),
    '# HELP open_cowork_gateway_provider_delivery_retries_total Channel deliveries marked for retry by provider.',
    '# TYPE open_cowork_gateway_provider_delivery_retries_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_delivery_retries_total', provider, provider.deliveryRetries)),
    '# HELP open_cowork_gateway_provider_delivery_dead_letters_total Channel deliveries dead-lettered by provider.',
    '# TYPE open_cowork_gateway_provider_delivery_dead_letters_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_delivery_dead_letters_total', provider, provider.deliveryDeadLetters)),
    '# HELP open_cowork_gateway_provider_webhook_requests_total Webhook requests received by provider.',
    '# TYPE open_cowork_gateway_provider_webhook_requests_total counter',
    ...providers.map((provider) => providerCounterLine('open_cowork_gateway_provider_webhook_requests_total', provider, provider.webhookRequests)),
    '# HELP open_cowork_gateway_provider_delivery_latency_ms Delivery handling latency in milliseconds by provider.',
    '# TYPE open_cowork_gateway_provider_delivery_latency_ms histogram',
    ...providers.flatMap((provider) => latencyHistogramSeries(
      'open_cowork_gateway_provider_delivery_latency_ms',
      provider.deliveryLatency,
      providerLabelPairs(provider),
    )),
  ]
}

// Render a histogram as cumulative `_bucket{le="…"}` series plus `_sum`/`_count`.
// innerLabels is the comma-joined label set without braces ('' for the unlabelled
// gateway-wide series), to which the bucket `le` label is appended.
function latencyHistogramSeries(name: string, histogram: GatewayLatencyHistogram, innerLabels: string) {
  const bucketSeries = (le: string, value: number) => {
    const labels = innerLabels ? `${innerLabels},le="${le}"` : `le="${le}"`
    return `${name}_bucket{${labels}} ${value}`
  }
  const lines: string[] = []
  let cumulative = 0
  for (let i = 0; i < GATEWAY_DELIVERY_LATENCY_BUCKETS_MS.length; i += 1) {
    cumulative += histogram.counts[i] ?? 0
    lines.push(bucketSeries(String(GATEWAY_DELIVERY_LATENCY_BUCKETS_MS[i]), cumulative))
  }
  cumulative += histogram.counts[GATEWAY_DELIVERY_LATENCY_BUCKETS_MS.length] ?? 0
  lines.push(bucketSeries('+Inf', cumulative))
  const suffix = innerLabels ? `{${innerLabels}}` : ''
  lines.push(`${name}_sum${suffix} ${histogram.sum}`)
  lines.push(`${name}_count${suffix} ${histogram.count}`)
  return lines
}

function providerStateSeries(provider: GatewayProviderMetrics) {
  const states: GatewayProviderMetricState[] = ['configured', 'starting', 'healthy', 'unhealthy', 'failed', 'stopped']
  return states.map((state) => (
    `open_cowork_gateway_provider_state${providerLabels(provider, { state })} ${provider.state === state ? 1 : 0}`
  ))
}

function providerCounterLine(name: string, provider: GatewayProviderMetrics, value: number) {
  return `${name}${providerLabels(provider)} ${value}`
}

function providerLabels(provider: GatewayProviderMetrics, extra: Record<string, string> = {}) {
  return `{${providerLabelPairs(provider, extra)}}`
}

function providerLabelPairs(provider: GatewayProviderMetrics, extra: Record<string, string> = {}) {
  const labels = {
    provider_id: provider.id,
    provider_kind: provider.kind,
    ...extra,
  }
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`)
    .join(',')
}

function escapePrometheusLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}
