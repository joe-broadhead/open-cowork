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
  cloudSubscriptionErrors: number
  droppedSessionEvents: number
  errors: number
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
    cloudSubscriptionErrors: 0,
    droppedSessionEvents: 0,
    errors: 0,
  }
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
    '# HELP open_cowork_gateway_cloud_subscription_errors_total Cloud delivery subscription errors.',
    '# TYPE open_cowork_gateway_cloud_subscription_errors_total counter',
    `open_cowork_gateway_cloud_subscription_errors_total ${metrics.cloudSubscriptionErrors}`,
    '# HELP open_cowork_gateway_errors_total Gateway errors.',
    '# TYPE open_cowork_gateway_errors_total counter',
    `open_cowork_gateway_errors_total ${metrics.errors}`,
    '# HELP open_cowork_gateway_dropped_session_events_total Session events skipped after non-retryable channel rendering failures.',
    '# TYPE open_cowork_gateway_dropped_session_events_total counter',
    `open_cowork_gateway_dropped_session_events_total ${metrics.droppedSessionEvents}`,
    '',
  ].join('\n')
}
