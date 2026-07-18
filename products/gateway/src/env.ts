/**
 * Centralized, typed access to the gateway's environment variables.
 *
 * `process.env` was previously read ad hoc across the codebase, so parsing,
 * defaulting, and validation rules for the same variable diverged file to file.
 * This module is the single place where those rules live: every accessor takes
 * an optional `env` source (defaulting to `process.env`) so it is trivially
 * testable, and every parser validates with a stable, operator-facing error
 * message that names the variable and its legal range.
 *
 * The primitive readers (`readRawEnv`, `readTrimmedEnv`, `readFirstRawEnv`,
 * `parseBooleanEnv`, `readBooleanEnv`, `readIntEnv`, `readListEnv`) deliberately
 * mirror the exact semantics the gateway relied on before this module existed:
 *
 *  - raw reads use `||`-style truthiness (empty string falls through to the
 *    default) and do NOT trim, so path-like values keep their bytes;
 *  - trimmed reads mirror `env.X?.trim()` (undefined stays undefined, a
 *    whitespace-only value collapses to '' and is treated as unset);
 *  - boolean parsing accepts 1/true/yes/on and 0/false/no/off/'' and rejects
 *    anything else, matching the daemon's historical `parseEnvBoolean`.
 *
 * Named accessors (`gatewayEnv.*`) build on those primitives so callers get a
 * typed value instead of re-deriving the variable name and rules.
 */

export type EnvSource = Record<string, string | undefined>

/** Canonical variable names, grouped by concern, so call sites never hardcode a string. */
export const ENV_KEYS = {
  configDir: 'OPENCODE_GATEWAY_CONFIG_DIR',
  stateDir: 'OPENCODE_GATEWAY_STATE_DIR',
  opencodeUrl: 'OPENCODE_GATEWAY_URL',
  httpPort: ['OPENCODE_GATEWAY_HTTP_PORT', 'GATEWAY_HTTP_PORT'] as const,
  httpHost: ['OPENCODE_GATEWAY_HTTP_HOST', 'GATEWAY_HTTP_HOST'] as const,
  allowNonLocalHttp: 'OPENCODE_GATEWAY_ALLOW_NON_LOCAL_HTTP',
  publicWebhookMode: 'OPENCODE_GATEWAY_PUBLIC_WEBHOOK_MODE',
  unsafeAllowNoAuth: 'OPENCODE_GATEWAY_UNSAFE_ALLOW_NO_AUTH',
  capabilityScopedLoopback: 'OPENCODE_GATEWAY_CAPABILITY_SCOPED_LOOPBACK',
  requireNonMcpDestructiveApproval: 'OPENCODE_GATEWAY_REQUIRE_NON_MCP_DESTRUCTIVE_APPROVAL',
  logLevel: 'GATEWAY_LOG_LEVEL',
  logFormat: 'GATEWAY_LOG_FORMAT',
  mcpTools: 'GATEWAY_MCP_TOOLS',
} as const

function source(env?: EnvSource): EnvSource {
  return env ?? (process.env as EnvSource)
}

/**
 * Raw value with no trimming. Returns `undefined` when unset. Combine with `||`
 * for a default so an empty string falls through exactly like the historical
 * `process.env.X || fallback` reads (e.g. the config/state directories).
 */
export function readRawEnv(name: string, env?: EnvSource): string | undefined {
  const value = source(env)[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Mirror of `env.X?.trim()`: `undefined` stays `undefined`; any present value is
 * trimmed (a whitespace-only value becomes `''`). Callers decide whether `''`
 * counts as set.
 */
export function readTrimmedEnv(name: string, env?: EnvSource): string | undefined {
  const value = source(env)[name]
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * First variable whose raw value is truthy, mirroring `env.A || env.B`. Does not
 * trim, so downstream numeric parsing sees the same bytes it always did.
 */
export function readFirstRawEnv(names: readonly string[], env?: EnvSource): string | undefined {
  const src = source(env)
  for (const name of names) {
    const value = src[name]
    if (value) return value
  }
  return undefined
}

/**
 * Parse a boolean env value. Accepts 1/true/yes/on -> true and
 * 0/false/no/off/'' -> false; anything else throws with the variable name.
 */
export function parseBooleanEnv(value: string | undefined, name: string): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  throw new Error(`${name} must be true or false`)
}

/**
 * Boolean accessor that returns `undefined` when the variable is entirely unset
 * (matching `if (env.X !== undefined)` guards) and otherwise parses it. Note an
 * empty string is "present" and parses to `false`, as the daemon has always done.
 */
export function readBooleanEnv(name: string, env?: EnvSource): boolean | undefined {
  const value = source(env)[name]
  if (value === undefined) return undefined
  return parseBooleanEnv(value, name)
}

export interface IntEnvOptions {
  min: number
  max: number
  /** Override the variable name used in the validation error message. */
  label?: string
}

/**
 * Read + validate a bounded integer. Returns `undefined` when the variable is
 * unset, empty, whitespace-only, or not plain base-10 numeric notation (so the
 * default can apply); a plain base-10 number is then range-checked, throwing a
 * message identical in shape to the config validator
 * (`<label> must be an integer between <min> and <max>`).
 *
 * `Number()` silently coerces garbage the historical `parseInt(x, 10)` never
 * accepted — `Number('   ') === 0`, `Number('0x1F') === 31`, `Number('1e3') === 1000`
 * — so those are rejected up front (→ `undefined`) rather than accepted as valid.
 */
export function readIntEnv(name: string, options: IntEnvOptions, env?: EnvSource): number | undefined {
  const raw = source(env)[name]
  if (raw === undefined || raw === '') return undefined
  const trimmed = raw.trim()
  // Only plain base-10 numeric notation is meaningful. Whitespace-only, hex
  // (0x1F), exponential (1e3), and other non-numeric garbage are rejected so the
  // default applies instead of being silently coerced by `Number()`.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return undefined
  const label = options.label ?? name
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new Error(`${label} must be an integer between ${options.min} and ${options.max}`)
  }
  return parsed
}

/**
 * Split a delimited env value (e.g. `GATEWAY_MCP_TOOLS`) into a trimmed,
 * non-empty, de-duplicated list. Returns `undefined` when unset so a default can
 * apply.
 */
export function readListEnv(name: string, env?: EnvSource, separator = ','): string[] | undefined {
  const raw = source(env)[name]
  if (raw === undefined) return undefined
  const values = raw
    .split(separator)
    .map(entry => entry.trim())
    .filter(Boolean)
  return [...new Set(values)]
}

/**
 * Typed, named accessors for the gateway's own variables. Each preserves the
 * exact semantics the corresponding call site relied on before centralization.
 */
export const gatewayEnv = {
  /** Config directory (raw, no trim); caller applies its own default via `||`. */
  configDir(env?: EnvSource): string | undefined {
    return readRawEnv(ENV_KEYS.configDir, env)
  },
  /** State directory (raw, no trim); caller applies its own default via `||`. */
  stateDir(env?: EnvSource): string | undefined {
    return readRawEnv(ENV_KEYS.stateDir, env)
  },
  /** OpenCode URL override, trimmed; whitespace-only collapses to '' (treated as unset upstream). */
  opencodeUrl(env?: EnvSource): string | undefined {
    return readTrimmedEnv(ENV_KEYS.opencodeUrl, env)
  },
  /** HTTP port override (raw first-of), left for the caller to bound-check. */
  httpPort(env?: EnvSource): string | undefined {
    return readFirstRawEnv(ENV_KEYS.httpPort, env)
  },
  /** HTTP host override, trimmed first-of; '' when unset. */
  httpHost(env?: EnvSource): string {
    return (readFirstRawEnv(ENV_KEYS.httpHost, env) ?? '').trim()
  },
  allowNonLocalHttp(env?: EnvSource): boolean | undefined {
    return readBooleanEnv(ENV_KEYS.allowNonLocalHttp, env)
  },
  publicWebhookMode(env?: EnvSource): boolean | undefined {
    return readBooleanEnv(ENV_KEYS.publicWebhookMode, env)
  },
  unsafeAllowNoAuth(env?: EnvSource): boolean | undefined {
    return readBooleanEnv(ENV_KEYS.unsafeAllowNoAuth, env)
  },
  capabilityScopedLoopback(env?: EnvSource): boolean | undefined {
    return readBooleanEnv(ENV_KEYS.capabilityScopedLoopback, env)
  },
  requireNonMcpDestructiveApproval(env?: EnvSource): boolean | undefined {
    return readBooleanEnv(ENV_KEYS.requireNonMcpDestructiveApproval, env)
  },
  /** Log level override, lower-cased and trimmed; undefined when unset. */
  logLevel(env?: EnvSource): string | undefined {
    const value = readTrimmedEnv(ENV_KEYS.logLevel, env)
    return value ? value.toLowerCase() : undefined
  },
  /** Log format override, lower-cased and trimmed; undefined when unset. */
  logFormat(env?: EnvSource): string | undefined {
    const value = readTrimmedEnv(ENV_KEYS.logFormat, env)
    return value ? value.toLowerCase() : undefined
  },
  /** MCP tool allowlist parsed from a comma-separated list. */
  mcpTools(env?: EnvSource): string[] | undefined {
    return readListEnv(ENV_KEYS.mcpTools, env)
  },
} as const
