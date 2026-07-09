import { nowIso, stableJson, workspaceOperationFromType } from '../postgres-store-id-helpers.ts'
import { optionalTrimmedText } from '../postgres-store-normalizers.ts'
import { workspaceEventCursorFromRow } from '../workspace-event-cursor.ts'
import { workspaceEventFromRow } from '../postgres-domains/sessions.ts'
import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import type {
  AppendWorkspaceEventInput,
  WorkspaceEventCursorRecord,
  WorkspaceEventRecord,
} from '../control-plane-store.ts'
import type { encodeSsePgNotifyPayload } from '../sse-pg-notify.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresWorkspaceEventsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
  requireSession(tenantId: string, sessionId: string, executor: PgExecutor): Promise<QueryRow>
  emitSseNotify(payload: Parameters<typeof encodeSsePgNotifyPayload>[0]): void
}

// Workspace events are the per-user replay stream projected from session events.
// They have their own counters and SSE topic, so they live outside the core
// session command/event/lease repository.
export class PostgresWorkspaceEventsRepository {
  private readonly options: PostgresWorkspaceEventsRepositoryOptions

  constructor(options: PostgresWorkspaceEventsRepositoryOptions) {
    this.options = options
  }

  async appendWorkspaceEvent(input: AppendWorkspaceEventInput) {
    const record = await this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      if (input.sessionId) {
        const session = await this.options.requireSession(input.tenantId, input.sessionId, client)
        if (String(session.user_id) !== input.userId) {
          throw new Error(`Session ${input.sessionId} does not belong to user ${input.userId}.`)
        }
      }

      const payload = input.payload || {}
      const sessionId = input.sessionId || null
      const entityType = optionalTrimmedText(input.entityType) || (sessionId ? 'session' : 'workspace')
      const entityId = optionalTrimmedText(input.entityId) || sessionId || input.userId
      const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
      await client.query(
        `INSERT INTO cloud_workspace_event_counters (tenant_id, user_id, next_sequence)
         VALUES ($1, $2, 0)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [input.tenantId, input.userId],
      )
      const counter = await one(
        client,
        `SELECT next_sequence
         FROM cloud_workspace_event_counters
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.tenantId, input.userId],
      )
      if (input.eventId) {
        const existing = await findPostgresWorkspaceEvent(client, input.tenantId, input.userId, input.eventId)
        if (existing) {
          const projectionVersion = Number.isFinite(input.projectionVersion)
            ? Math.max(0, Math.floor(input.projectionVersion || 0))
            : existing.projectionVersion
          return replayOrRejectPostgresWorkspaceEvent(existing, input.type, payload, {
            sessionId,
            entityType,
            entityId,
            operation,
            projectionVersion,
          })
        }
      }

      const sequence = numberValue(counter.next_sequence) + 1
      const eventId = input.eventId || `${input.userId}:${sequence}`
      const projectionVersion = Number.isFinite(input.projectionVersion)
        ? Math.max(0, Math.floor(input.projectionVersion || 0))
        : sequence
      await client.query(
        `UPDATE cloud_workspace_event_counters
         SET next_sequence = $3
         WHERE tenant_id = $1 AND user_id = $2`,
        [input.tenantId, input.userId, sequence],
      )
      const createdAt = nowIso(input.createdAt)
      const inserted = await client.query(
        `INSERT INTO cloud_workspace_events (
          tenant_id, user_id, event_id, sequence, session_id,
          entity_type, entity_id, operation, projection_version,
          type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [
          input.tenantId,
          input.userId,
          eventId,
          sequence,
          sessionId,
          entityType,
          entityId,
          operation,
          projectionVersion,
          input.type,
          JSON.stringify(payload),
          createdAt,
        ],
      )
      return workspaceEventFromRow(inserted.rows[0]!)
    })
    this.options.emitSseNotify({ kind: 'workspace', tenantId: record.tenantId, userId: record.userId })
    return record
  }

  async listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    await this.options.requireTenantUser(tenantId, userId)
    return this.listWorkspaceEventsForStream(tenantId, userId, afterSequence, limit)
  }

  async listWorkspaceEventsForStream(tenantId: string, userId: string, afterSequence = 0, limit?: number) {
    const bounded = Number.isInteger(limit) && (limit as number) > 0
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND sequence > $3
       ORDER BY sequence${bounded ? ' LIMIT $4' : ''}`,
      bounded ? [tenantId, userId, afterSequence, limit] : [tenantId, userId, afterSequence],
    )
    return result.rows.map(workspaceEventFromRow)
  }

  async getWorkspaceEventCursor(tenantId: string, userId: string): Promise<WorkspaceEventCursorRecord> {
    await this.options.requireTenantUser(tenantId, userId)
    const result = await this.options.pool.query(
      `SELECT min(sequence) AS earliest_sequence, max(sequence) AS latest_sequence
       FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    )
    return workspaceEventCursorFromRow(result.rows[0])
  }
}

export async function findPostgresWorkspaceEvent(
  executor: PgExecutor,
  tenantId: string,
  userId: string,
  eventId: string,
): Promise<WorkspaceEventRecord | null> {
  const row = await maybeOne(
    executor,
    `SELECT * FROM cloud_workspace_events
     WHERE tenant_id = $1 AND user_id = $2 AND event_id = $3`,
    [tenantId, userId, eventId],
  )
  return row ? workspaceEventFromRow(row) : null
}

export function replayOrRejectPostgresWorkspaceEvent(
  existing: WorkspaceEventRecord,
  type: string,
  payload: Record<string, unknown>,
  expected: {
    sessionId: string | null
    entityType: string
    entityId: string
    operation: string
    projectionVersion: number
  },
) {
  if (
    existing.type !== type
    || stableJson(existing.payload) !== stableJson(payload)
    || existing.sessionId !== expected.sessionId
    || existing.entityType !== expected.entityType
    || existing.entityId !== expected.entityId
    || existing.operation !== expected.operation
    || existing.projectionVersion !== expected.projectionVersion
  ) {
    throw new Error(`Workspace event id ${existing.eventId} was reused with different content.`)
  }
  return existing
}

async function one<Row extends QueryRow = QueryRow>(executor: PgExecutor, text: string, values?: unknown[]) {
  const result = await executor.query<Row>(text, values)
  if (!result.rows[0]) throw new Error('Expected query to return a row.')
  return result.rows[0]
}

async function maybeOne<Row extends QueryRow = QueryRow>(executor: PgExecutor, text: string, values?: unknown[]) {
  const result = await executor.query<Row>(text, values)
  return result.rows[0] || null
}
