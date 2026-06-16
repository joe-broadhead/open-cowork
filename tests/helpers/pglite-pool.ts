import { PGlite } from '@electric-sql/pglite'

// In-process Postgres adapter for the control-plane contract/concurrency tests.
//
// pglite is real PostgreSQL 16 compiled to WASM (not an emulator), so the
// PostgresControlPlaneStore runs its *actual* SQL against it — the same DDL,
// the same queries, the same transaction semantics — without needing a Docker
// daemon or a running Postgres. The store accepts an injected `pool` matching
// this narrow shape, so this adapter lets the previously-skipped Postgres
// contract suite execute everywhere. Test-only: pglite never ships in the app.
//
// Two adaptations are required because pglite is a single embedded backend:
//   1. CONCURRENTLY — `CREATE/DROP INDEX CONCURRENTLY` is a no-op concept on a
//      single connection and pglite rejects it, so it is rewritten to a plain
//      index statement. Index *identity* and *effect* are unchanged.
//   2. A transaction mutex — `withTransaction` runs BEGIN…COMMIT over a checked
//      out client; the mutex stops pool-level queries from interleaving into an
//      open transaction (real Postgres isolates these across connections).

type QueryRow = Record<string, unknown>
type QueryResult<Row extends QueryRow = QueryRow> = { rows: Row[], rowCount?: number }

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }
export type PglitePool = PgExecutor & { connect(): Promise<PgClient>; end(): Promise<void> }

function rewriteSql(text: string): string {
  // Single connection ⇒ CONCURRENTLY is meaningless and unsupported by pglite.
  // The resulting index has the same name and definition as in production.
  return text.replace(/\bINDEX\s+CONCURRENTLY\b/gi, 'INDEX')
}

export function createPglitePool(): PglitePool {
  const db = new PGlite()

  // Promise-chain mutex: connect() takes the lock until the client is released,
  // so a transaction's statements never interleave with pool-level queries.
  let mutex: Promise<void> = Promise.resolve()

  async function runQuery<Row extends QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
    const result = await db.query<Row>(rewriteSql(text), values as unknown[] | undefined)
    // node-postgres exposes `rowCount` (affected rows for DML, returned rows for SELECT);
    // pglite calls it `affectedRows` and only sets it for DML. Mirror node-pg so the
    // store's `result.rowCount` checks (e.g. DELETE → boolean) behave identically.
    const rowCount = typeof result.affectedRows === 'number' ? result.affectedRows : result.rows.length
    return { rows: result.rows, rowCount }
  }

  async function query<Row extends QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
    await mutex
    return runQuery<Row>(text, values)
  }

  async function connect(): Promise<PgClient> {
    let release!: () => void
    const previous = mutex
    mutex = new Promise<void>((resolve) => { release = resolve })
    await previous
    let released = false
    return {
      query: runQuery,
      release: () => {
        if (released) return
        released = true
        release()
      },
    }
  }

  async function end(): Promise<void> {
    await mutex
    await db.close()
  }

  return { query, connect, end }
}
