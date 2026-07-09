import { nowIso, stableJson, workspaceOperationFromType } from '../postgres-store-id-helpers.ts'
import { optionalTrimmedText, redactOperationalText } from '../postgres-store-normalizers.ts'
import { decodeSessionPageCursor, encodeSessionPageCursor } from '../control-plane-store.ts'
import { workspaceEventCursorFromRow } from '../workspace-event-cursor.ts'
import {
  commandFromRow,
  eventFromRow,
  leaseFromRow,
  projectionFromRow,
  sessionFromRow,
  sessionFromRowWithProjectSource,
  workspaceEventFromRow,
} from '../postgres-domains/sessions.ts'
import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import {
  assertPostgresCommandEnqueueQuotas,
  assertPostgresCommandQueueQuota,
  assertPostgresConcurrentSessionQuota,
  checkPostgresActiveWorkerQuota,
  listPostgresRunnableSessions,
  type PostgresQuotaDomainDeps,
} from './quotas.ts'
import { encodeSsePgNotifyPayload } from '../sse-pg-notify.ts'
import type {
  AppendProjectedSessionEventInput,
  AppendProjectedSessionEventResult,
  AppendWorkspaceEventInput,
  AuditEventRecord,
  CommandQueueQuota,
  ControlPlaneSessionStatus,
  EnqueueCommandInput,
  ListSessionsPageInput,
  RecordAuditEventInput,
  ReapExpiredSessionLeasesInput,
  ReapedSessionLeaseRecord,
  SessionEventRecord,
  WorkerLeaseRecord,
  WorkspaceEventCursorRecord,
  WorkspaceEventRecord,
} from '../control-plane-store.ts'

// Session SQL domain extracted from postgres-control-plane-store.ts. Owns the session
// core: session CRUD/listing, session + workspace event append/replay, projections,
// worker leases (claim/renew/checkpoint/release/reap) and the session command queue
// (enqueue/claim/ack/fail). Tenant/tenant-user checks, the transaction runner, the SSE
// NOTIFY emitter, the audit-event recorder and the shared quota deps arrive via the
// injected host. Behaviour-preserving; covered by the pglite + real-Postgres
// control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresSessionsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenant(tenantId: string, executor?: PgExecutor): Promise<unknown>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
  emitSseNotify(payload: Parameters<typeof encodeSsePgNotifyPayload>[0]): void
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<AuditEventRecord>
  quotaDeps: PostgresQuotaDomainDeps
}

export class PostgresSessionsRepository {
  private readonly options: PostgresSessionsRepositoryOptions

  constructor(options: PostgresSessionsRepositoryOptions) {
    this.options = options
  }

  async createSession(input: {
    tenantId: string
    userId: string
    sessionId: string
    opencodeSessionId: string
    profileName: string
    title?: string | null
    createdAt?: Date
    quota?: {
      orgId?: string | null
      maxConcurrentSessionsPerOrg?: number | null
      policyCode?: string
    } | null
  }) {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_sessions WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      if (existing) return sessionFromRow(existing)
      await assertPostgresConcurrentSessionQuota(client, { tenantId: input.tenantId, quota: input.quota, now: input.createdAt }, this.options.quotaDeps)
      const createdAt = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO cloud_sessions (
          tenant_id, session_id, user_id, opencode_session_id, profile_name,
          status, title, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'idle', $6, $7, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.userId,
          input.opencodeSessionId,
          input.profileName,
          input.title || null,
          createdAt,
        ],
      )
      return sessionFromRow(result.rows[0]!)
    })
  }

  async getSession(tenantId: string, userId: string, sessionId: string) {
    await this.options.requireTenantUser(tenantId, userId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
      [tenantId, userId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async getOwnedSessionIds(tenantId: string, userId: string, sessionIds: string[]) {
    await this.options.requireTenantUser(tenantId, userId)
    const owned = new Set<string>()
    if (sessionIds.length === 0) return owned
    // Single set-based ownership probe instead of one round-trip per id, so bulk
    // thread-tag operations validate hundreds of sessions in one statement.
    const result = await this.options.pool.query(
      `SELECT session_id FROM cloud_sessions
       WHERE tenant_id = $1 AND user_id = $2 AND session_id = ANY($3::text[])`,
      [tenantId, userId, sessionIds],
    )
    for (const row of result.rows) owned.add(String(row.session_id))
    return owned
  }

  async getSessionForTenant(tenantId: string, sessionId: string) {
    await this.options.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async findSession(sessionId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE session_id = $1 OR opencode_session_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sessionId],
    )
    return row ? sessionFromRow(row) : null
  }

  async listSessions(tenantId: string, userId: string) {
    await this.options.requireTenantUser(tenantId, userId)
    // Defensively bound this per-user read so it can never become an unbounded
    // scan that grows with a user's lifetime session count; the result is ordered
    // most-recent-first, and UI callers that need to page beyond this use
    // listSessionsPage (keyset cursor). Mirrors the listAllSessions cap.
    const result = await this.options.pool.query(
      `SELECT s.*, p.view -> 'projectSource' AS projection_project_source
       FROM cloud_sessions s
       LEFT JOIN cloud_session_projections p
         ON p.tenant_id = s.tenant_id
        AND p.session_id = s.session_id
       WHERE s.tenant_id = $1 AND s.user_id = $2
       ORDER BY s.updated_at DESC, s.session_id
       LIMIT 1000`,
      [tenantId, userId],
    )
    return result.rows.map(sessionFromRowWithProjectSource)
  }

  async listSessionsPage(input: ListSessionsPageInput) {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)))
    const cursor = decodeSessionPageCursor(input.cursor, input)
    const params: unknown[] = [input.tenantId, input.userId]
    const where = ['s.tenant_id = $1', 's.user_id = $2']
    if (input.status) {
      params.push(input.status)
      where.push(`s.status = $${params.length}`)
    }
    if (input.profileName) {
      params.push(input.profileName)
      where.push(`s.profile_name = $${params.length}`)
    }
    const query = input.query?.trim().toLowerCase()
    if (query) {
      params.push(`%${query}%`)
      where.push(`(
        lower(COALESCE(s.title, '')) LIKE $${params.length}
        OR lower(s.session_id) LIKE $${params.length}
        OR lower(s.opencode_session_id) LIKE $${params.length}
        OR lower(s.profile_name) LIKE $${params.length}
      )`)
    }
    if (cursor) {
      params.push(cursor.updatedAt, cursor.sessionId)
      const updatedAtParam = params.length - 1
      const sessionIdParam = params.length
      where.push(`(s.updated_at < $${updatedAtParam} OR (s.updated_at = $${updatedAtParam} AND s.session_id > $${sessionIdParam}))`)
    }
    params.push(limit + 1)
    const result = await this.options.pool.query(
      `SELECT s.*, p.view -> 'projectSource' AS projection_project_source
       FROM cloud_sessions s
       LEFT JOIN cloud_session_projections p
         ON p.tenant_id = s.tenant_id
        AND p.session_id = s.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.updated_at DESC, s.session_id
       LIMIT $${params.length}`,
      params,
    )
    const rows = result.rows.map(sessionFromRowWithProjectSource)
    const items = rows.slice(0, limit)
    return {
      items,
      nextCursor: rows.length > limit && items.length > 0 ? encodeSessionPageCursor(items[items.length - 1]!, input) : null,
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
    }
  }

  async listAllSessions() {
    // Defensively bound this cross-tenant read so it can never become an unbounded
    // full-table scan; it has no production caller (diagnostics/compat only).
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_sessions ORDER BY updated_at DESC, tenant_id, session_id LIMIT 1000`,
    )
    return result.rows.map(sessionFromRow)
  }

  async listRunnableSessions(input: {
    limit?: number | null
    now?: Date
  } = {}) {
    return listPostgresRunnableSessions(this.options.pool, input)
  }

  async bindSessionRuntime(input: {
    tenantId: string
    sessionId: string
    opencodeSessionId: string
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.options.withTransaction(async (client) => {
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `UPDATE cloud_sessions
         SET opencode_session_id = $3,
             title = CASE WHEN $4::boolean THEN $5 ELSE title END,
             updated_at = $6
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.opencodeSessionId,
          input.title !== undefined,
          input.title ?? null,
          updatedAt,
        ],
      )
      if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
      return sessionFromRow(result.rows[0])
    })
  }

  async updateSessionStatus(input: {
    tenantId: string
    sessionId: string
    status: ControlPlaneSessionStatus
    title?: string | null
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.options.withTransaction(async (client) => {
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `UPDATE cloud_sessions
         SET status = $3,
             title = CASE WHEN $4::boolean THEN $5 ELSE title END,
             updated_at = $6
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [
          input.tenantId,
          input.sessionId,
          input.status,
          input.title !== undefined,
          input.title ?? null,
          updatedAt,
        ],
      )
      if (!result.rows[0]) throw new Error(`Unknown session ${input.sessionId}.`)
      return sessionFromRow(result.rows[0])
    })
  }

  async appendSessionEvent(input: {
    tenantId: string
    sessionId: string
    eventId?: string
    type: string
    payload?: Record<string, unknown>
    leaseToken?: string | null
    createdAt?: Date
  }) {
    const record = await this.options.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const payload = input.payload || {}
      if (input.eventId) {
        const existing = await this.findEvent(input.tenantId, input.sessionId, input.eventId, client)
        if (existing) return this.replayOrRejectEvent(existing, input.type, payload)
      }
      const createdAt = nowIso(input.createdAt)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_event_sequence',
        createdAt,
      )
      const eventId = input.eventId || `${input.sessionId}:${sequence}`
      const inserted = await client.query(
        `INSERT INTO cloud_session_events (
          tenant_id, session_id, event_id, sequence, type, payload, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING *`,
        [input.tenantId, input.sessionId, eventId, sequence, input.type, JSON.stringify(payload), createdAt],
      )
      return eventFromRow(inserted.rows[0]!)
    })
    this.options.emitSseNotify({ kind: 'session', tenantId: record.tenantId, sessionId: record.sessionId })
    return record
  }

  async appendProjectedSessionEvent(input: AppendProjectedSessionEventInput): Promise<AppendProjectedSessionEventResult> {
    const result = await this.options.withTransaction(async (client) => {
      const sessionRow = await this.requireSession(input.tenantId, input.sessionId, client, true)
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const session = sessionFromRow(sessionRow)
      const payload = input.payload || {}
      let sessionEventCreated = false
      let event: SessionEventRecord | null = null
      if (input.eventId) {
        const existing = await this.findEvent(input.tenantId, input.sessionId, input.eventId, client)
        if (existing) event = this.replayOrRejectEvent(existing, input.type, payload)
      }
      if (!event) {
        const createdAt = nowIso(input.createdAt)
        const sequence = await this.incrementSessionCounter(
          client,
          input.tenantId,
          input.sessionId,
          'next_event_sequence',
          createdAt,
        )
        const eventId = input.eventId || `${input.sessionId}:${sequence}`
        const inserted = await client.query(
          `INSERT INTO cloud_session_events (
            tenant_id, session_id, event_id, sequence, type, payload, created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           RETURNING *`,
          [input.tenantId, input.sessionId, eventId, sequence, input.type, JSON.stringify(payload), createdAt],
        )
        event = eventFromRow(inserted.rows[0]!)
        sessionEventCreated = true
      }

      await this.options.requireTenantUser(input.tenantId, session.userId, client)
      const workspace = input.workspace({ session, event })
      const workspacePayload = payload
      let workspaceEventCreated = false
      let workspaceEvent: WorkspaceEventRecord
      const existingWorkspaceEvent = await this.findWorkspaceEvent(input.tenantId, session.userId, workspace.eventId, client)
      if (existingWorkspaceEvent) {
        workspaceEvent = this.replayOrRejectWorkspaceEvent(existingWorkspaceEvent, input.type, workspacePayload, {
          sessionId: input.sessionId,
          entityType: workspace.entityType,
          entityId: workspace.entityId,
          operation: workspace.operation,
          projectionVersion: workspace.projectionVersion,
        })
      } else {
        await client.query(
          `INSERT INTO cloud_workspace_event_counters (tenant_id, user_id, next_sequence)
           VALUES ($1, $2, 0)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [input.tenantId, session.userId],
        )
        const counter = await this.one(
          `SELECT next_sequence
           FROM cloud_workspace_event_counters
           WHERE tenant_id = $1 AND user_id = $2
           FOR UPDATE`,
          [input.tenantId, session.userId],
          client,
        )
        const sequence = numberValue(counter.next_sequence) + 1
        await client.query(
          `UPDATE cloud_workspace_event_counters
           SET next_sequence = $3
           WHERE tenant_id = $1 AND user_id = $2`,
          [input.tenantId, session.userId, sequence],
        )
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
            session.userId,
            workspace.eventId,
            sequence,
            input.sessionId,
            workspace.entityType,
            workspace.entityId,
            workspace.operation,
            workspace.projectionVersion,
            input.type,
            JSON.stringify(workspacePayload),
            nowIso(new Date(event.createdAt)),
          ],
        )
        workspaceEvent = workspaceEventFromRow(inserted.rows[0]!)
        workspaceEventCreated = true
      }

      const currentRow = await this.maybeOne(
        `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      const currentProjection = currentRow ? projectionFromRow(currentRow) : null
      if ((currentProjection?.sequence || 0) >= event.sequence) {
        return {
          event,
          workspaceEvent,
          projection: currentProjection!,
          session,
          sessionEventCreated,
          workspaceEventCreated,
          projectionAdvanced: false,
        }
      }

      const projected = input.project({ session, event, currentProjection })
      const updatedAt = nowIso(projected.updatedAt ?? new Date(event.createdAt))
      const projectionResult = await client.query(
        `INSERT INTO cloud_session_projections (tenant_id, session_id, sequence, view, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET sequence = EXCLUDED.sequence, view = EXCLUDED.view, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.tenantId, input.sessionId, event.sequence, JSON.stringify(projected.view), updatedAt],
      )
      await client.query(
        `UPDATE cloud_sessions SET updated_at = $3 WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId, updatedAt],
      )
      return {
        event,
        workspaceEvent,
        projection: projectionFromRow(projectionResult.rows[0]!),
        session,
        sessionEventCreated,
        workspaceEventCreated,
        projectionAdvanced: true,
      }
    })
    if (result.sessionEventCreated) this.options.emitSseNotify({ kind: 'session', tenantId: result.event.tenantId, sessionId: result.event.sessionId })
    if (result.workspaceEventCreated) this.options.emitSseNotify({ kind: 'workspace', tenantId: result.workspaceEvent.tenantId, userId: result.workspaceEvent.userId })
    return result
  }

  async listSessionEvents(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    await this.requireSession(tenantId, sessionId)
    return this.listSessionEventsForStream(tenantId, sessionId, afterSequence, limit)
  }
  async listSessionEventsForStream(tenantId: string, sessionId: string, afterSequence = 0, limit?: number) {
    const bounded = Number.isInteger(limit) && (limit as number) > 0
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND sequence > $3
       ORDER BY sequence${bounded ? ' LIMIT $4' : ''}`,
      bounded ? [tenantId, sessionId, afterSequence, limit] : [tenantId, sessionId, afterSequence],
    )
    return result.rows.map(eventFromRow)
  }

  async getSessionEventStats(tenantId: string, sessionId: string) {
    await this.requireSession(tenantId, sessionId)
    const row = await this.one<{ count: string | number; latest: string | number }>(
      `SELECT count(*)::int AS count, COALESCE(max(sequence), 0)::int AS latest
       FROM cloud_session_events WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return { count: Number(row.count), latestSequence: Number(row.latest) }
  }

  async appendWorkspaceEvent(input: AppendWorkspaceEventInput) {
    const record = await this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      if (input.sessionId) {
        const session = await this.requireSession(input.tenantId, input.sessionId, client, true)
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
      const counter = await this.one(
        `SELECT next_sequence
         FROM cloud_workspace_event_counters
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [input.tenantId, input.userId],
        client,
      )
      if (input.eventId) {
        const existing = await this.findWorkspaceEvent(input.tenantId, input.userId, input.eventId, client)
        if (existing) {
          const projectionVersion = Number.isFinite(input.projectionVersion)
            ? Math.max(0, Math.floor(input.projectionVersion || 0))
            : existing.projectionVersion
          return this.replayOrRejectWorkspaceEvent(existing, input.type, payload, {
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

  async writeSessionProjection(input: {
    tenantId: string
    sessionId: string
    sequence: number
    view: Record<string, unknown>
    leaseToken?: string | null
    updatedAt?: Date
  }) {
    return this.options.withTransaction(async (client) => {
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      await this.assertLeaseTokenIfPresent(input.tenantId, input.sessionId, input.leaseToken, client)
      const lease = await this.getLease(input.tenantId, input.sessionId, client, true)
      if (lease && lease.leaseToken !== (input.leaseToken ?? null)) {
        throw new Error('Projection write used a stale worker lease.')
      }
      const currentRow = await this.maybeOne(
        `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId],
        client,
      )
      const current = currentRow ? projectionFromRow(currentRow) : null
      if (input.sequence < (current?.sequence || 0)) {
        throw new Error('Projection sequence must be monotonic.')
      }
      if (input.sequence === current?.sequence) {
        if (stableJson(current.view) !== stableJson(input.view)) {
          throw new Error('Projection sequence was reused with different content.')
        }
        return current
      }
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_session_projections (tenant_id, session_id, sequence, view, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET sequence = EXCLUDED.sequence, view = EXCLUDED.view, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [input.tenantId, input.sessionId, input.sequence, JSON.stringify(input.view), updatedAt],
      )
      await client.query(
        `UPDATE cloud_sessions SET updated_at = $3 WHERE tenant_id = $1 AND session_id = $2`,
        [input.tenantId, input.sessionId, updatedAt],
      )
      return projectionFromRow(result.rows[0]!)
    })
  }

  async getSessionProjection(tenantId: string, sessionId: string) {
    await this.requireSession(tenantId, sessionId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_projections WHERE tenant_id = $1 AND session_id = $2`,
      [tenantId, sessionId],
    )
    return row ? projectionFromRow(row) : null
  }

  async getMaxProjectionLag(): Promise<number> {
    // Bounded to the recently-active tail (served by cloud_sessions_projection_lag_idx) instead of
    // a full-table scan + join on every scheduler emission (#911). Projection lag is a live signal:
    // a session that has produced no events in the window is not actively lagging, and its backlog
    // (if any) is drained by the worker/reaper rather than surfaced by this real-time gauge.
    const result = await this.options.pool.query(
      `SELECT coalesce(max(GREATEST(0, s.next_event_sequence - 1 - coalesce(p.sequence, 0))), 0) AS lag
       FROM cloud_sessions s
       LEFT JOIN cloud_session_projections p ON p.tenant_id = s.tenant_id AND p.session_id = s.session_id
       WHERE s.next_event_sequence > 0
         AND s.updated_at > now() - interval '1 hour'`,
    )
    return numberValue(result.rows[0]?.lag)
  }

  async claimSessionLease(
    tenantId: string,
    sessionId: string,
    workerId: string,
    now = new Date(),
    ttlMs = 30_000,
    quota: {
      orgId?: string | null
      maxActiveWorkersPerOrg?: number | null
      policyCode?: string
    } | null = null,
  ) {
    return this.options.withTransaction(async (client) => {
      const session = await this.requireSession(tenantId, sessionId, client, true)
      const lease = await this.getLease(tenantId, sessionId, client, true)
      const nowMs = now.getTime()
      if (lease && lease.leaseExpiresAt > nowMs) return null
      if (!(await checkPostgresActiveWorkerQuota(client, { tenantId, quota, nowMs }, this.options.quotaDeps))) return null
      const attempt = numberValue(session.next_lease_attempt) + 1
      const leaseRecord: WorkerLeaseRecord = {
        tenantId,
        sessionId,
        leasedBy: workerId,
        leaseToken: `${tenantId}:${sessionId}:${attempt}:${workerId}`,
        leaseExpiresAt: nowMs + ttlMs,
        checkpointVersion: lease?.checkpointVersion || 0,
      }
      await client.query(
        `UPDATE cloud_sessions
         SET next_lease_attempt = $3, status = 'running', updated_at = $4
         WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId, attempt, now.toISOString()],
      )
      const result = await client.query(
        `INSERT INTO cloud_worker_leases (
          tenant_id, session_id, leased_by, lease_token, lease_expires_at_ms, checkpoint_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
         SET leased_by = EXCLUDED.leased_by,
             lease_token = EXCLUDED.lease_token,
             lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
             checkpoint_version = EXCLUDED.checkpoint_version
         RETURNING *`,
        [
          tenantId,
          sessionId,
          leaseRecord.leasedBy,
          leaseRecord.leaseToken,
          leaseRecord.leaseExpiresAt,
          leaseRecord.checkpointVersion,
        ],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async releaseSessionLease(lease: WorkerLeaseRecord, now = new Date()) {
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `DELETE FROM cloud_worker_leases
         WHERE tenant_id = $1
           AND session_id = $2
           AND lease_token = $3
         RETURNING lease_token`,
        [lease.tenantId, lease.sessionId, lease.leaseToken],
      )
      if (!result.rows[0]) return false
      await client.query(
        `UPDATE cloud_sessions
         SET status = 'idle', updated_at = $3
         WHERE tenant_id = $1
           AND session_id = $2`,
        [lease.tenantId, lease.sessionId, nowIso(now)],
      )
      return true
    })
  }

  async renewSessionLease(lease: WorkerLeaseRecord, now = new Date(), ttlMs = 30_000) {
    return this.options.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET lease_expires_at_ms = $3
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId, now.getTime() + ttlMs],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async checkpointSession(lease: WorkerLeaseRecord) {
    return this.options.withTransaction(async (client) => {
      const current = await this.assertCurrentLease(lease, client)
      if (lease.checkpointVersion !== current.checkpointVersion) {
        throw new Error('Checkpoint version is stale.')
      }
      const result = await client.query(
        `UPDATE cloud_worker_leases
         SET checkpoint_version = checkpoint_version + 1
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId],
      )
      return leaseFromRow(result.rows[0]!)
    })
  }

  async reapExpiredSessionLeases(input: ReapExpiredSessionLeasesInput = {}): Promise<ReapedSessionLeaseRecord[]> {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxCommandAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    return this.options.withTransaction(async (client) => {
      const expired = await client.query(
        `SELECT *
         FROM cloud_worker_leases
         WHERE lease_expires_at_ms <= $1
         ORDER BY lease_expires_at_ms ASC, tenant_id, session_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowMs, limit],
      )
      const reaped: ReapedSessionLeaseRecord[] = []
      for (const row of expired.rows) {
        const lease = leaseFromRow(row)
        const commands = await client.query(
          `SELECT *
           FROM cloud_session_commands
           WHERE tenant_id = $1
             AND session_id = $2
             AND status = 'running'
             AND claimed_lease_token = $3
           ORDER BY created_sequence
           FOR UPDATE`,
          [lease.tenantId, lease.sessionId, lease.leaseToken],
        )
        const retriedCommandIds: string[] = []
        const failedCommandIds: string[] = []
        for (const commandRow of commands.rows) {
          const command = commandFromRow(commandRow)
          if (command.attemptCount >= maxAttempts) {
            const summary = 'Worker lease expired after the maximum retry attempts.'
            await client.query(
              `UPDATE cloud_session_commands
               SET status = 'failed',
                   error = $2,
                   last_error_code = 'lease_expired_max_attempts',
                   last_error_summary = $2
               WHERE command_id = $1`,
              [command.commandId, summary],
            )
            failedCommandIds.push(command.commandId)
          } else {
            await client.query(
              `UPDATE cloud_session_commands
               SET status = 'pending',
                   claimed_by = NULL,
                   claimed_lease_token = NULL,
                   available_at = $2,
                   error = NULL,
                   last_error_code = 'lease_expired',
                   last_error_summary = 'Worker lease expired before command completion.'
               WHERE command_id = $1`,
              [command.commandId, nowIsoValue],
            )
            retriedCommandIds.push(command.commandId)
          }
        }
        await client.query(
          `DELETE FROM cloud_worker_leases
           WHERE tenant_id = $1 AND session_id = $2 AND lease_token = $3`,
          [lease.tenantId, lease.sessionId, lease.leaseToken],
        )
        const action: ReapedSessionLeaseRecord['action'] = failedCommandIds.length > 0 && retriedCommandIds.length === 0
          ? 'failed'
          : retriedCommandIds.length > 0
            ? 'retried'
            : 'released'
        await client.query(
          `UPDATE cloud_sessions
           SET status = $3, updated_at = $4
           WHERE tenant_id = $1 AND session_id = $2`,
          [
            lease.tenantId,
            lease.sessionId,
            action === 'failed' ? 'errored' : 'idle',
            nowIsoValue,
          ],
        )
        // lease.tenantId is unambiguously a tenant id, so resolve the org by the tenant
        // relationship only. The prior `OR org_id = $1` could match a different org whose org_id
        // coincided with this tenant id, mis-attributing the audit event (#924).
        const org = await this.maybeOne(
          `SELECT org_id FROM cloud_orgs WHERE tenant_id = $1 LIMIT 1`,
          [lease.tenantId],
          client,
        )
        if (org) {
          await this.options.recordAuditEvent(client, {
            orgId: String(org.org_id),
            actorType: 'system',
            actorId: 'managed-work-reaper',
            eventType: 'managed_work.session_lease_reaped',
            targetType: 'session',
            targetId: lease.sessionId,
            metadata: {
              action,
              leasedBy: lease.leasedBy,
              retriedCommandIds,
              failedCommandIds,
            },
            createdAt: now,
          })
        }
        reaped.push({
          tenantId: lease.tenantId,
          sessionId: lease.sessionId,
          leaseToken: lease.leaseToken,
          leasedBy: lease.leasedBy,
          action,
          retriedCommandIds,
          failedCommandIds,
          reapedAt: nowIsoValue,
        })
      }
      return reaped
    })
  }

  async assertSessionCommandQueueQuota(input: { tenantId: string, quota?: CommandQueueQuota | null, now?: Date }) {
    await this.options.withTransaction(async (client) => {
      await assertPostgresCommandQueueQuota(client, input, this.options.quotaDeps)
    })
  }

  async enqueueSessionCommand(input: EnqueueCommandInput) {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      await this.requireSession(input.tenantId, input.sessionId, client, true)
      const payload = input.payload || {}
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_session_commands WHERE command_id = $1`,
        [input.commandId],
        client,
      )
      if (existing) {
        const command = commandFromRow(existing)
        if (
          command.tenantId !== input.tenantId
          || command.userId !== input.userId
          || command.sessionId !== input.sessionId
          || command.kind !== input.kind
          || command.targetLeaseToken !== (input.targetLeaseToken ?? null)
          || stableJson(command.payload) !== stableJson(payload)
        ) {
          throw new Error(`Command id ${input.commandId} was reused with different content.`)
        }
        return command
      }
      const createdAt = nowIso(input.createdAt)
      await assertPostgresCommandEnqueueQuotas(client, {
        tenantId: input.tenantId,
        queueQuota: input.quota,
        usageQuotas: input.usageQuotas,
        now: new Date(createdAt),
      }, this.options.quotaDeps)
      const sequence = await this.incrementSessionCounter(
        client,
        input.tenantId,
        input.sessionId,
        'next_command_sequence',
      )
      const result = await client.query(
        `INSERT INTO cloud_session_commands (
          command_id, tenant_id, user_id, session_id, kind, payload,
          target_lease_token, created_sequence, created_at, status
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
         RETURNING *`,
        [
          input.commandId,
          input.tenantId,
          input.userId,
          input.sessionId,
          input.kind,
          JSON.stringify(payload),
          input.targetLeaseToken ?? null,
          sequence,
          createdAt,
        ],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async claimNextSessionCommand(lease: WorkerLeaseRecord, now = new Date()) {
    return this.options.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client, now.getTime())
      const selected = await this.maybeOne(
        `SELECT * FROM cloud_session_commands
         WHERE tenant_id = $1
           AND session_id = $2
           AND (
             (status = 'pending'
                AND (available_at IS NULL OR available_at <= $4)
                AND (target_lease_token IS NULL OR target_lease_token = $3))
             OR (status = 'running' AND claimed_lease_token <> $3 AND target_lease_token IS NULL)
           )
         ORDER BY created_sequence
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [lease.tenantId, lease.sessionId, lease.leaseToken, now.toISOString()],
        client,
      )
      if (!selected) return null
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'running',
             claimed_by = $2,
             claimed_lease_token = $3,
             attempt_count = attempt_count + 1,
             available_at = NULL,
             last_error_code = NULL,
             last_error_summary = NULL
         WHERE command_id = $1
         RETURNING *`,
        [String(selected.command_id), lease.leasedBy, lease.leaseToken],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async ackSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.options.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status === 'acked') return command
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'acked',
             acked_at = $2,
             error = NULL,
             last_error_code = NULL,
             last_error_summary = NULL
         WHERE command_id = $1
         RETURNING *`,
        [commandId, now.toISOString()],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async checkpointAndAckSessionCommand(lease: WorkerLeaseRecord, commandId: string, now = new Date()) {
    return this.options.withTransaction(async (client) => {
      const current = await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status === 'acked') {
        return {
          lease: current,
          command,
          checkpointAdvanced: false,
          commandAcked: false,
        }
      }
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      if (lease.checkpointVersion !== current.checkpointVersion) {
        throw new Error('Checkpoint version is stale.')
      }
      const leaseResult = await client.query(
        `UPDATE cloud_worker_leases
         SET checkpoint_version = checkpoint_version + 1
         WHERE tenant_id = $1 AND session_id = $2
         RETURNING *`,
        [lease.tenantId, lease.sessionId],
      )
      const commandResult = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'acked',
             acked_at = $2,
             error = NULL,
             last_error_code = NULL,
             last_error_summary = NULL
         WHERE command_id = $1
         RETURNING *`,
        [commandId, now.toISOString()],
      )
      return {
        lease: leaseFromRow(leaseResult.rows[0]!),
        command: commandFromRow(commandResult.rows[0]!),
        checkpointAdvanced: true,
        commandAcked: true,
      }
    })
  }

  async failSessionCommand(lease: WorkerLeaseRecord, commandId: string, error: string) {
    return this.options.withTransaction(async (client) => {
      await this.assertCurrentLease(lease, client)
      const command = await this.requireCommand(commandId, client, true)
      if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
        throw new Error(`Command ${commandId} is not owned by this worker.`)
      }
      const result = await client.query(
        `UPDATE cloud_session_commands
         SET status = 'failed',
             error = $2,
             last_error_code = 'execution_failed',
             last_error_summary = $3
         WHERE command_id = $1
         RETURNING *`,
        [commandId, error, redactOperationalText(error, 512, 'Command error')],
      )
      return commandFromRow(result.rows[0]!)
    })
  }

  async requireSession(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor = this.options.pool,
    forUpdate = false,
  ) {
    await this.options.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_sessions
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    if (!row) throw new Error(`Unknown session ${sessionId}.`)
    return row
  }

  async requireSessions(tenantId: string, sessionIds: string[], executor: PgExecutor = this.options.pool) {
    await this.options.requireTenant(tenantId, executor)
    if (sessionIds.length === 0) return
    // Single set-based existence probe instead of one FOR-UPDATE-less round-trip per id,
    // so bulk thread-tag writes validate every session in one statement (#910 follow-up).
    const result = await executor.query(
      `SELECT session_id FROM cloud_sessions
       WHERE tenant_id = $1 AND session_id = ANY($2::text[])`,
      [tenantId, sessionIds],
    )
    const known = new Set(result.rows.map((row) => String(row.session_id)))
    for (const sessionId of sessionIds) {
      if (!known.has(sessionId)) throw new Error(`Unknown session ${sessionId}.`)
    }
  }

  private async requireCommand(commandId: string, executor: PgExecutor, forUpdate = false) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_commands
       WHERE command_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [commandId],
      executor,
    )
    if (!row) throw new Error(`Unknown command ${commandId}.`)
    return commandFromRow(row)
  }

  private async assertCurrentLease(lease: WorkerLeaseRecord, executor: PgExecutor, nowMs = Date.now()) {
    const current = await this.getLease(lease.tenantId, lease.sessionId, executor, true)
    if (!current || current.leaseToken !== lease.leaseToken || current.leaseExpiresAt <= nowMs) {
      throw new Error('Worker lease is stale.')
    }
    return current
  }

  async assertLeaseTokenIfPresent(
    tenantId: string,
    sessionId: string,
    leaseToken: string | null | undefined,
    executor: PgExecutor,
  ) {
    if (leaseToken === undefined) return
    const current = await this.getLease(tenantId, sessionId, executor, true)
    if (!current || current.leaseToken !== leaseToken || current.leaseExpiresAt <= Date.now()) {
      throw new Error('Worker lease is stale.')
    }
  }

  private async getLease(
    tenantId: string,
    sessionId: string,
    executor: PgExecutor,
    forUpdate = false,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_worker_leases
       WHERE tenant_id = $1 AND session_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, sessionId],
      executor,
    )
    return row ? leaseFromRow(row) : null
  }

  private async findEvent(
    tenantId: string,
    sessionId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_session_events
       WHERE tenant_id = $1 AND session_id = $2 AND event_id = $3`,
      [tenantId, sessionId, eventId],
      executor,
    )
    return row ? eventFromRow(row) : null
  }

  private async findWorkspaceEvent(
    tenantId: string,
    userId: string,
    eventId: string,
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workspace_events
       WHERE tenant_id = $1 AND user_id = $2 AND event_id = $3`,
      [tenantId, userId, eventId],
      executor,
    )
    return row ? workspaceEventFromRow(row) : null
  }

  private replayOrRejectEvent(
    existing: SessionEventRecord,
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (existing.type !== type || stableJson(existing.payload) !== stableJson(payload)) {
      throw new Error(`Event id ${existing.eventId} was reused with different content.`)
    }
    return existing
  }

  private replayOrRejectWorkspaceEvent(
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

  async incrementSessionCounter(
    executor: PgExecutor,
    tenantId: string,
    sessionId: string,
    field: 'next_event_sequence' | 'next_command_sequence',
    updatedAt?: string,
  ) {
    const setUpdatedAt = updatedAt ? ', updated_at = $3' : ''
    const values = updatedAt ? [tenantId, sessionId, updatedAt] : [tenantId, sessionId]
    const result = await executor.query(
      `UPDATE cloud_sessions
       SET ${field} = ${field} + 1${setUpdatedAt}
       WHERE tenant_id = $1 AND session_id = $2
       RETURNING ${field}`,
      values,
    )
    return numberValue(result.rows[0]?.[field])
  }

  private async one<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }
}
