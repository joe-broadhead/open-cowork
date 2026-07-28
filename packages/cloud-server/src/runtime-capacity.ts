const DEFAULT_CAPACITY_RETRY_AFTER_MS = 1_000

export type CloudRuntimeCapacityReason =
  | 'queue_full'
  | 'queue_timeout'
  | 'provision_timeout'
  | 'cleanup_pending'
  | 'adapter_closing'

export class CloudRuntimeCapacityError extends Error {
  readonly code = 'cloud_runtime_capacity_exhausted'
  readonly retryable = true
  readonly retryAfterMs: number
  readonly reason: CloudRuntimeCapacityReason

  constructor(reason: CloudRuntimeCapacityReason, retryAfterMs = DEFAULT_CAPACITY_RETRY_AFTER_MS) {
    super('Cloud worker runtime capacity is temporarily exhausted.')
    this.name = 'CloudRuntimeCapacityError'
    this.reason = reason
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.floor(retryAfterMs)
      : DEFAULT_CAPACITY_RETRY_AFTER_MS
  }
}

export function isDeferrableRuntimeCapacityError(
  error: unknown,
): error is CloudRuntimeCapacityError {
  return error instanceof CloudRuntimeCapacityError
}
