export type QuotaPolicyCode =
  | 'quota.concurrent_sessions_exceeded'
  | 'quota.concurrent_workflow_runs_exceeded'
  | 'quota.active_workers_exceeded'
  | 'quota.queued_commands_exceeded'
  | 'quota.queue_age_exceeded'
  | 'quota.prompts_per_hour_exceeded'
  | 'quota.workflow_runs_per_hour_exceeded'
  | 'quota.gateway_prompts_per_hour_exceeded'
  | 'quota.worker_minutes_per_hour_exceeded'
  | 'quota.gateway_deliveries_per_hour_exceeded'
  | 'quota.gateway_channel_bindings_exceeded'
  | 'quota.artifact_bytes_per_day_exceeded'
  | 'rate_limit.http_exceeded'
  | 'auth.backoff'

export class ControlPlaneQuotaExceededError extends Error {
  readonly status = 429
  readonly publicMessage: string
  readonly policyCode: QuotaPolicyCode | string
  readonly retryAfterMs: number
  readonly limit: number
  readonly used: number
  readonly resetAt: string

  constructor(input: {
    message: string
    policyCode: QuotaPolicyCode | string
    retryAfterMs: number
    limit: number
    used: number
    resetAt: string
  }) {
    super(input.message)
    this.publicMessage = input.message
    this.policyCode = input.policyCode
    this.retryAfterMs = input.retryAfterMs
    this.limit = input.limit
    this.used = input.used
    this.resetAt = input.resetAt
  }
}

/**
 * A caller-selected globally unique storage id collided with a row outside the
 * caller's authority boundary. Store adapters throw the same typed error and
 * never return the conflicting row or a backend-specific lookup failure.
 */
export class ControlPlaneIdConflictError extends Error {
  readonly resource: 'headless_agent' | 'channel_binding' | 'channel_interaction'

  constructor(resource: 'headless_agent' | 'channel_binding' | 'channel_interaction') {
    super('The requested channel resource id is unavailable.')
    this.name = 'ControlPlaneIdConflictError'
    this.resource = resource
  }
}

export function quotaExceeded(input: {
  message: string
  policyCode: QuotaPolicyCode | string
  retryAfterMs: number
  limit: number
  used: number
  resetAt: string
}): never {
  throw new ControlPlaneQuotaExceededError(input)
}

export function publicQuotaMessage(policyCode: QuotaPolicyCode | string | undefined) {
  switch (policyCode) {
    case 'quota.prompts_per_hour_exceeded':
      return 'Cloud prompt quota exceeded.'
    case 'quota.gateway_prompts_per_hour_exceeded':
      return 'Gateway prompt quota exceeded.'
    case 'quota.workflow_runs_per_hour_exceeded':
      return 'Cloud workflow run quota exceeded.'
    case 'quota.worker_minutes_per_hour_exceeded':
      return 'Cloud worker minute quota exceeded.'
    case 'quota.queued_commands_exceeded':
      return 'Cloud command queue is full.'
    case 'quota.queue_age_exceeded':
      return 'Cloud command queue is too old to accept more work.'
    default:
      return 'Cloud usage quota exceeded.'
  }
}
