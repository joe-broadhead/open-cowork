/**
 * Canonical gateway error hierarchy.
 *
 * Defines ONE base, `GatewayError`, with a stable machine `code`, a `category`
 * (`transient` | `permanent` | `fatal`), and an optional `cause`. Prefer
 * throwing a `GatewayError` (or a subclass) from new code so failures carry
 * retry semantics.
 */

export type ErrorCategory = 'transient' | 'permanent' | 'fatal'

export interface GatewayErrorOptions {
  /** Stable machine-readable code (e.g. `config_invalid`). */
  code: string
  /** Retry semantics for the failure. */
  category: ErrorCategory
  /** Underlying cause; preserved for debugging and audit chaining. */
  cause?: unknown
}

/**
 * Canonical base error. Prefer throwing a `GatewayError` (or a subclass) from
 * new code so failures carry retry semantics.
 */
export class GatewayError extends Error {
  readonly code: string
  readonly category: ErrorCategory
  override readonly cause?: unknown

  constructor(message: string, options: GatewayErrorOptions) {
    super(message)
    this.name = new.target.name
    this.code = options.code
    this.category = options.category
    this.cause = options.cause
  }
}

/** Operator-facing configuration failure (invalid config file, bad update). */
export class ConfigError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'config_invalid', category: 'permanent', cause })
  }
}
