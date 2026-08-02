import { createRequire } from 'node:module'
import { cloudPostgresPoolPlan, type CloudPostgresPoolConfig } from './postgres-pool-options.ts'
import type { QueryResult, QueryRow } from './postgres-domains/shared.ts'

export type PostgresExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

export type PostgresClient = PostgresExecutor & { release: () => void }

export type PostgresPool = PostgresExecutor & {
  connect(): Promise<PostgresClient>
  end(): Promise<void>
}

const require = createRequire(import.meta.url)

export function loadPgPool(connectionString: string): PostgresPool {
  type PgPoolClient = { query(text: string): Promise<unknown> }
  type RealPgPool = PostgresPool & {
    on?(event: 'connect', handler: (client: PgPoolClient) => void): void
  }
  const pg = require('pg') as { Pool: new (options: CloudPostgresPoolConfig) => RealPgPool }
  const { config, lockTimeoutMs } = cloudPostgresPoolPlan(connectionString)
  const pool = new pg.Pool(config)
  if (lockTimeoutMs > 0 && typeof pool.on === 'function') {
    // lock_timeout is not a native pool option; set it per connection so a blocked
    // FOR UPDATE waits at most lockTimeoutMs instead of pinning a pooled connection.
    pool.on('connect', (client) => {
      void Promise.resolve(client.query(`SET lock_timeout = ${lockTimeoutMs}`)).catch(() => {})
    })
  }
  return pool
}
