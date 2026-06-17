import type { CoordinationWatch } from '@open-cowork/shared'
import type {
  CreateCloudCoordinationWatchInput,
  ListCloudCoordinationWatchesInput,
  ListMatchingCloudCoordinationWatchesInput,
  UpdateCloudCoordinationWatchInput,
} from '../control-plane-store.ts'
import {
  createCloudCoordinationWatchRecord,
  normalizeCloudCoordinationWatchLimit,
  updateCloudCoordinationWatchRecord,
} from '../coordination-watch-records.ts'
import { coordinationWatchFromRow } from '../postgres-domains/coordination-watches.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

export class PostgresCoordinationWatchesRepository {
  private readonly pool: PgExecutor

  constructor(pool: PgExecutor) {
    this.pool = pool
  }

  async create(input: CreateCloudCoordinationWatchInput): Promise<CoordinationWatch> {
    const watch = createCloudCoordinationWatchRecord(input)
    const result = await this.pool.query(
      `INSERT INTO cloud_coordination_watches (
        workspace_id, watch_id, target_kind, target_id, events, channel, recipient,
        status, delivery_surface, verbosity, cursor, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12, $13)
      RETURNING *`,
      watchParams(watch),
    )
    return coordinationWatchFromRow(result.rows[0]!)
  }

  async update(input: UpdateCloudCoordinationWatchInput): Promise<CoordinationWatch | null> {
    const existing = await this.get(input.workspaceId, input.watchId)
    if (!existing) return null
    const watch = updateCloudCoordinationWatchRecord(existing, input.patch, input.updatedAt)
    const result = await this.pool.query(
      `UPDATE cloud_coordination_watches
       SET target_kind = $3,
           target_id = $4,
           events = $5::jsonb,
           channel = $6::jsonb,
           recipient = $7::jsonb,
           status = $8,
           delivery_surface = $9,
           verbosity = $10,
           cursor = $11::jsonb,
           updated_at = $12
       WHERE workspace_id = $1 AND watch_id = $2
       RETURNING *`,
      [
        watch.workspaceId,
        watch.id,
        watch.target.kind,
        watch.target.id,
        JSON.stringify(watch.events),
        JSON.stringify(watch.channel),
        watch.recipient ? JSON.stringify(watch.recipient) : null,
        watch.status,
        watch.deliverySurface,
        watch.verbosity,
        watch.cursor === null || watch.cursor === undefined ? null : JSON.stringify(watch.cursor),
        watch.updatedAt,
      ],
    )
    return result.rows[0] ? coordinationWatchFromRow(result.rows[0]) : null
  }

  async get(workspaceId: string, watchId: string): Promise<CoordinationWatch | null> {
    const result = await this.pool.query(
      `SELECT * FROM cloud_coordination_watches WHERE workspace_id = $1 AND watch_id = $2`,
      [workspaceId, watchId],
    )
    return result.rows[0] ? coordinationWatchFromRow(result.rows[0]) : null
  }

  async list(input: ListCloudCoordinationWatchesInput): Promise<CoordinationWatch[]> {
    const limit = normalizeCloudCoordinationWatchLimit(input.limit)
    const values: unknown[] = [input.workspaceId]
    const filters = ['workspace_id = $1']
    if (input.status) {
      values.push(input.status)
      filters.push(`status = $${values.length}`)
    }
    if (input.target) {
      values.push(input.target.kind, input.target.id)
      filters.push(`target_kind = $${values.length - 1} AND target_id = $${values.length}`)
    }
    values.push(limit)
    const result = await this.pool.query(
      `SELECT *
       FROM cloud_coordination_watches
       WHERE ${filters.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${values.length}`,
      values,
    )
    return result.rows.map(coordinationWatchFromRow)
  }

  async listMatching(input: ListMatchingCloudCoordinationWatchesInput): Promise<CoordinationWatch[]> {
    if (input.targets.length === 0) return []
    const targetPairs = input.targets.map((target) => [target.kind, target.id])
    const values: unknown[] = [
      input.workspaceId,
      JSON.stringify([input.eventType]),
      JSON.stringify(targetPairs.map(([targetKind, targetId]) => ({ target_kind: targetKind, target_id: targetId }))),
    ]
    const limitSql = input.limit ? `LIMIT $${values.length + 1}` : ''
    if (input.limit) values.push(normalizeCloudCoordinationWatchLimit(input.limit, 1000, 10_000))
    const result = await this.pool.query(
      `SELECT *
       FROM cloud_coordination_watches
       WHERE workspace_id = $1
         AND status = 'active'
         AND events @> $2::jsonb
         AND (target_kind, target_id) IN (
           SELECT target_kind, target_id
           FROM jsonb_to_recordset($3::jsonb) AS targets(target_kind text, target_id text)
         )
       ORDER BY updated_at DESC
       ${limitSql}`,
      values,
    )
    return result.rows.map(coordinationWatchFromRow)
  }

  async delete(workspaceId: string, watchId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM cloud_coordination_watches WHERE workspace_id = $1 AND watch_id = $2`,
      [workspaceId, watchId],
    ) as QueryResult & { rowCount?: number }
    return Number(result.rowCount || 0) > 0
  }
}

function watchParams(watch: CoordinationWatch) {
  return [
    watch.workspaceId,
    watch.id,
    watch.target.kind,
    watch.target.id,
    JSON.stringify(watch.events),
    JSON.stringify(watch.channel),
    watch.recipient ? JSON.stringify(watch.recipient) : null,
    watch.status,
    watch.deliverySurface,
    watch.verbosity,
    watch.cursor === null || watch.cursor === undefined ? null : JSON.stringify(watch.cursor),
    watch.createdAt,
    watch.updatedAt,
  ]
}
