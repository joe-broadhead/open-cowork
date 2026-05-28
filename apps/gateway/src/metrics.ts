export type GatewayMetrics = {
  startedAt: number
  incomingMessages: number
  promptedMessages: number
  interactionsResolved: number
  deliveriesReceived: number
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
    droppedSessionEvents: 0,
    errors: 0,
  }
}

export function renderPrometheusMetrics(metrics: GatewayMetrics, providerCount: number, now = Date.now) {
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
    '# HELP open_cowork_gateway_errors_total Gateway errors.',
    '# TYPE open_cowork_gateway_errors_total counter',
    `open_cowork_gateway_errors_total ${metrics.errors}`,
    '# HELP open_cowork_gateway_dropped_session_events_total Session events skipped after non-retryable channel rendering failures.',
    '# TYPE open_cowork_gateway_dropped_session_events_total counter',
    `open_cowork_gateway_dropped_session_events_total ${metrics.droppedSessionEvents}`,
    '',
  ].join('\n')
}
