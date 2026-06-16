import { nowIso } from '../postgres-store-id-helpers.ts'
import { heartbeatFromRow } from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type { WorkerRole } from '../control-plane-store.ts'

// Worker-heartbeat SQL domain extracted from postgres-control-plane-store.ts. Owns the
// per-worker liveness record (upsert by worker id with deduped active session ids,
// list-all). Pure pool access, no other coupling. Behaviour-preserving; covered by the
// pglite + real-Postgres control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresWorkerHeartbeatsRepositoryOptions = {
  pool: PgExecutor
}

export class PostgresWorkerHeartbeatsRepository {
  private readonly options: PostgresWorkerHeartbeatsRepositoryOptions

  constructor(options: PostgresWorkerHeartbeatsRepositoryOptions) {
    this.options = options
  }

  async recordWorkerHeartbeat(input: {
    workerId: string
    role: WorkerRole
    activeSessionIds?: string[]
    now?: Date
  }) {
    const result = await this.options.pool.query(
      `INSERT INTO cloud_worker_heartbeats (worker_id, role, active_session_ids, last_seen_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (worker_id) DO UPDATE
       SET role = EXCLUDED.role,
           active_session_ids = EXCLUDED.active_session_ids,
           last_seen_at = EXCLUDED.last_seen_at
       RETURNING *`,
      [
        input.workerId,
        input.role,
        JSON.stringify([...new Set(input.activeSessionIds || [])]),
        nowIso(input.now),
      ],
    )
    return heartbeatFromRow(result.rows[0])
  }

  async listWorkerHeartbeats() {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_worker_heartbeats ORDER BY worker_id`,
    )
    return result.rows.map(heartbeatFromRow)
  }
}
