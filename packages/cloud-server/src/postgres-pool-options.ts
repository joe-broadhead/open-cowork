// Env-driven Postgres connection-pool configuration for the cloud control-plane store.
//
// node-postgres defaults to an unbounded-statement, 10-connection pool with no
// transaction/lock guards. Under a high-volume multi-tenant deployment a few slow or
// leaked transactions can pin all 10 connections and stall the whole control plane.
// This builder exposes the pool size + connection lifecycle + server-side timeouts as
// operator-tunable env vars, with conservative defaults that preserve current behaviour
// (statement/lock timeouts opt-in so migrations and legitimate long reads are never
// truncated) plus a safe `idle_in_transaction_session_timeout` so a leaked transaction
// can never pin row locks forever. Pure + unit-tested; the real pool is built from this
// in `loadPgPool`. (Tests inject a pool and bypass this entirely.)

export type CloudPostgresPoolConfig = {
  connectionString: string
  max: number
  connectionTimeoutMillis: number
  idleTimeoutMillis: number
  application_name: string
  statement_timeout?: number
  idle_in_transaction_session_timeout?: number
}

export type CloudPostgresPoolPlan = {
  config: CloudPostgresPoolConfig
  // lock_timeout is not a native node-postgres pool option, so it is applied per
  // connection via a `SET lock_timeout` on the pool's `connect` event. 0 = disabled.
  lockTimeoutMs: number
}

type EnvLike = Record<string, string | undefined>

const DEFAULTS = {
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  // 0 = unlimited (opt-in): a global statement_timeout would also truncate DDL
  // migrations and legitimate long reads, so operators enable it deliberately.
  statementTimeoutMs: 0,
  // 2 minutes: only ever fires for a transaction left IDLE mid-flight (a leak); healthy
  // transactions run queries back-to-back and never sit idle this long, so this is a
  // safe non-zero default that directly bounds the "stuck client pins locks" failure.
  idleInTransactionTimeoutMs: 120_000,
  lockTimeoutMs: 0,
} as const

function readNonNegativeInt(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

function readPositiveInt(env: EnvLike, key: string, fallback: number): number {
  const value = readNonNegativeInt(env, key, fallback)
  return value > 0 ? value : fallback
}

export function cloudPostgresPoolPlan(connectionString: string, env: EnvLike = process.env): CloudPostgresPoolPlan {
  const statementTimeout = readNonNegativeInt(env, 'OPEN_COWORK_CLOUD_PG_STATEMENT_TIMEOUT_MS', DEFAULTS.statementTimeoutMs)
  const idleTxTimeout = readNonNegativeInt(env, 'OPEN_COWORK_CLOUD_PG_IDLE_TX_TIMEOUT_MS', DEFAULTS.idleInTransactionTimeoutMs)
  const appName = env.OPEN_COWORK_CLOUD_PG_APP_NAME?.trim() || 'open-cowork-cloud'
  const config: CloudPostgresPoolConfig = {
    connectionString,
    max: readPositiveInt(env, 'OPEN_COWORK_CLOUD_PG_POOL_MAX', DEFAULTS.max),
    connectionTimeoutMillis: readPositiveInt(env, 'OPEN_COWORK_CLOUD_PG_CONNECTION_TIMEOUT_MS', DEFAULTS.connectionTimeoutMillis),
    idleTimeoutMillis: readPositiveInt(env, 'OPEN_COWORK_CLOUD_PG_IDLE_TIMEOUT_MS', DEFAULTS.idleTimeoutMillis),
    application_name: appName,
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    ...(idleTxTimeout > 0 ? { idle_in_transaction_session_timeout: idleTxTimeout } : {}),
  }
  return {
    config,
    lockTimeoutMs: readNonNegativeInt(env, 'OPEN_COWORK_CLOUD_PG_LOCK_TIMEOUT_MS', DEFAULTS.lockTimeoutMs),
  }
}
