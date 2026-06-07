export type GatewayMetrics = {
  startedAt: number
  incomingMessages: number
  promptedMessages: number
  interactionsResolved: number
  deliveriesReceived: number
  deliveriesSent: number
  deliveryRetries: number
  deliveryDeadLetters: number
  deliveryLatencyMsTotal: number
  webhookRequests: number
  streamReconnects: number
  sessionRenderRetries: number
  sessionRenderDeadLetters: number
  cursorPersistenceFailures: number
  cloudSubscriptionErrors: number
  droppedSessionEvents: number
  errors: number
  providerMetrics: Record<string, GatewayProviderMetrics>
}

export type GatewayProviderMetricState = 'configured' | 'starting' | 'healthy' | 'unhealthy' | 'stopped'

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
    deliveryLatencyMsTotal: 0,
    webhookRequests: 0,
    streamReconnects: 0,
    sessionRenderRetries: 0,
    sessionRenderDeadLetters: 0,
    cursorPersistenceFailures: 0,
    cloudSubscriptionErrors: 0,
    droppedSessionEvents: 0,
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
    '# HELP open_cowork_gateway_delivery_latency_ms_total Total delivery handling latency in milliseconds.',
    '# TYPE open_cowork_gateway_delivery_latency_ms_total counter',
    `open_cowork_gateway_delivery_latency_ms_total ${metrics.deliveryLatencyMsTotal}`,
    '# HELP open_cowork_gateway_webhook_requests_total Provider webhook requests received.',
    '# TYPE open_cowork_gateway_webhook_requests_total counter',
    `open_cowork_gateway_webhook_requests_total ${metrics.webhookRequests}`,
    '# HELP open_cowork_gateway_session_streams Active session SSE streams.',
    '# TYPE open_cowork_gateway_session_streams gauge',
    `open_cowork_gateway_session_streams ${activeSessionStreams}`,
    '# HELP open_cowork_gateway_stream_reconnects_total Session stream reconnects after SSE/render failures.',
    '# TYPE open_cowork_gateway_stream_reconnects_total counter',
    `open_cowork_gateway_stream_reconnects_total ${metrics.streamReconnects}`,
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
  ]
}

function providerStateSeries(provider: GatewayProviderMetrics) {
  const states: GatewayProviderMetricState[] = ['configured', 'starting', 'healthy', 'unhealthy', 'stopped']
  return states.map((state) => (
    `open_cowork_gateway_provider_state${providerLabels(provider, { state })} ${provider.state === state ? 1 : 0}`
  ))
}

function providerCounterLine(name: string, provider: GatewayProviderMetrics, value: number) {
  return `${name}${providerLabels(provider)} ${value}`
}

function providerLabels(provider: GatewayProviderMetrics, extra: Record<string, string> = {}) {
  const labels = {
    provider_id: provider.id,
    provider_kind: provider.kind,
    ...extra,
  }
  return `{${Object.entries(labels)
    .map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`)
    .join(',')}}`
}

function escapePrometheusLabel(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}
