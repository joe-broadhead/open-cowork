export type CloudTransportErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'payment_required'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'http'
  | 'network'
  | 'abort'
  | 'timeout'
  | 'parse'
  | 'sse'
  | 'request'

export type CloudTransportErrorOptions = {
  kind: CloudTransportErrorKind
  message: string
  status?: number
  method?: string
  url?: string
  retryAfter?: string | null
  code?: string | null
  body?: unknown
  cause?: unknown
}

export class CloudTransportError extends Error {
  readonly kind: CloudTransportErrorKind
  readonly status?: number
  readonly method?: string
  readonly url?: string
  readonly retryAfter?: string | null
  readonly code?: string | null
  readonly body?: unknown
  readonly cause?: unknown

  constructor(options: CloudTransportErrorOptions) {
    super(options.message)
    this.name = 'CloudTransportError'
    this.kind = options.kind
    this.status = options.status
    this.method = options.method
    this.url = options.url
    this.retryAfter = options.retryAfter
    this.code = options.code
    this.body = options.body
    this.cause = options.cause
  }
}

export function isCloudTransportError(value: unknown): value is CloudTransportError {
  return value instanceof CloudTransportError
    || Boolean(value && typeof value === 'object' && (value as { name?: unknown }).name === 'CloudTransportError')
}
