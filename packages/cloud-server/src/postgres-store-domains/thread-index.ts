import { nowIso, stableJson } from '../postgres-store-id-helpers.ts'
import {
  normalizeIdList,
  normalizeOptionalText,
  normalizeTagColor,
  normalizeText,
  normalizeThreadQuery,
} from '../postgres-store-normalizers.ts'
import { threadSmartFilterFromRow, threadTagFromRow } from '../postgres-domains/thread-index.ts'
import { sessionFromRow } from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  CreateThreadSmartFilterInput,
  CreateThreadTagInput,
  ThreadMetadataRecord,
  ThreadTagLinkInput,
  UpdateThreadSmartFilterInput,
  UpdateThreadTagInput,
} from '../control-plane-store.ts'

// Thread-index SQL domain extracted from postgres-control-plane-store.ts. Owns the
// per-tenant thread tags + tag links + smart filters (CRUD, bulk apply/remove to
// sessions) and the tagged-session metadata read. Tenant / tenant-user / session
// existence checks + the transaction runner arrive via the injected host (the session
// core stays in the store; this domain only reads cloud_sessions for metadata).
// Behaviour-preserving; covered by the pglite + real-Postgres control-plane contracts.

const THREAD_TAG_NAME_MAX_LENGTH = 48
const THREAD_SMART_FILTER_NAME_MAX_LENGTH = 64
const THREAD_FILTER_MAX_VALUES = 50
const THREAD_BULK_MAX_SESSION_IDS = 500

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresThreadIndexRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenant(tenantId: string, executor?: PgExecutor): Promise<unknown>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
  requireSession(tenantId: string, sessionId: string, executor?: PgExecutor): Promise<unknown>
}

export class PostgresThreadIndexRepository {
  private readonly options: PostgresThreadIndexRepositoryOptions

  constructor(options: PostgresThreadIndexRepositoryOptions) {
    this.options = options
  }

  async listThreadTags(tenantId: string) {
    await this.options.requireTenant(tenantId)
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_thread_tags
       WHERE tenant_id = $1
       ORDER BY lower(name), tag_id`,
      [tenantId],
    )
    return result.rows.map(threadTagFromRow)
  }

  async createThreadTag(input: CreateThreadTagInput) {
    await this.options.requireTenant(input.tenantId)
    const name = normalizeText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = normalizeTagColor(input.color)
    const createdAt = nowIso(input.createdAt)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [input.tenantId, input.tagId],
    )
    if (existing) {
      const tag = threadTagFromRow(existing)
      if (tag.name !== name || tag.color !== color) {
        throw new Error(`Tag id ${input.tagId} was reused with different content.`)
      }
      return tag
    }
    const result = await this.options.pool.query(
      `INSERT INTO cloud_thread_tags (tenant_id, tag_id, name, color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [input.tenantId, input.tagId, name, color, createdAt],
    )
    return threadTagFromRow(result.rows[0]!)
  }

  async updateThreadTag(input: UpdateThreadTagInput) {
    await this.options.requireTenant(input.tenantId)
    const name = normalizeOptionalText(input.name, THREAD_TAG_NAME_MAX_LENGTH, 'Tag name')
    const color = input.color === undefined ? undefined : normalizeTagColor(input.color)
    const result = await this.options.pool.query(
      `UPDATE cloud_thread_tags
       SET name = COALESCE($3, name),
           color = COALESCE($4, color),
           updated_at = $5
       WHERE tenant_id = $1 AND tag_id = $2
       RETURNING *`,
      [input.tenantId, input.tagId, name ?? null, color ?? null, nowIso(input.updatedAt)],
    )
    return result.rows[0] ? threadTagFromRow(result.rows[0]) : null
  }

  async deleteThreadTag(tenantId: string, tagId: string) {
    await this.options.requireTenant(tenantId)
    const result = await this.options.pool.query(
      `DELETE FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [tenantId, tagId],
    ) as QueryResult & { rowCount?: number }
    return Number(result.rowCount || 0) > 0
  }

  async applyThreadTags(input: ThreadTagLinkInput) {
    await this.options.withTransaction(async (client) => {
      await this.options.requireTenant(input.tenantId, client)
      const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
      const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      for (const sessionId of sessionIds) await this.options.requireSession(input.tenantId, sessionId, client)
      for (const tagId of tagIds) await this.requireThreadTag(input.tenantId, tagId, client)
      if (sessionIds.length === 0 || tagIds.length === 0) return
      const createdAt = nowIso(input.createdAt)
      // One set-based insert over the session × tag cross product instead of a nested loop
      // that fired up to THREAD_BULK_MAX_SESSION_IDS × THREAD_FILTER_MAX_VALUES statements
      // (500 × 50 = 25,000 round-trips) per call, holding row locks the whole transaction (#910).
      await client.query(
        `INSERT INTO cloud_thread_tag_links (tenant_id, session_id, tag_id, created_at)
         SELECT $1, s.session_id, t.tag_id, $4
         FROM unnest($2::text[]) AS s(session_id)
         CROSS JOIN unnest($3::text[]) AS t(tag_id)
         ON CONFLICT (tenant_id, session_id, tag_id) DO NOTHING`,
        [input.tenantId, sessionIds, tagIds, createdAt],
      )
    })
  }

  async removeThreadTags(input: ThreadTagLinkInput) {
    await this.options.withTransaction(async (client) => {
      await this.options.requireTenant(input.tenantId, client)
      const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds', THREAD_BULK_MAX_SESSION_IDS)
      const tagIds = normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      for (const sessionId of sessionIds) await this.options.requireSession(input.tenantId, sessionId, client)
      for (const tagId of tagIds) await this.requireThreadTag(input.tenantId, tagId, client)
      if (sessionIds.length === 0 || tagIds.length === 0) return
      await client.query(
        `DELETE FROM cloud_thread_tag_links
         WHERE tenant_id = $1
           AND session_id = ANY($2::text[])
           AND tag_id = ANY($3::text[])`,
        [input.tenantId, sessionIds, tagIds],
      )
    })
  }

  async listThreadSmartFilters(tenantId: string) {
    await this.options.requireTenant(tenantId)
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_thread_smart_filters
       WHERE tenant_id = $1
       ORDER BY lower(name), filter_id
       LIMIT 1000`,
      [tenantId],
    )
    return result.rows.map(threadSmartFilterFromRow)
  }

  async createThreadSmartFilter(input: CreateThreadSmartFilterInput) {
    await this.options.requireTenant(input.tenantId)
    const name = normalizeText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = normalizeThreadQuery(input.query)
    const createdAt = nowIso(input.createdAt)
    const existing = await this.maybeOne(
      `SELECT * FROM cloud_thread_smart_filters WHERE tenant_id = $1 AND filter_id = $2`,
      [input.tenantId, input.filterId],
    )
    if (existing) {
      const filter = threadSmartFilterFromRow(existing)
      if (filter.name !== name || stableJson(filter.query) !== stableJson(query)) {
        throw new Error(`Smart filter id ${input.filterId} was reused with different content.`)
      }
      return filter
    }
    const result = await this.options.pool.query(
      `INSERT INTO cloud_thread_smart_filters (tenant_id, filter_id, name, query, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)
       RETURNING *`,
      [input.tenantId, input.filterId, name, JSON.stringify(query), createdAt],
    )
    return threadSmartFilterFromRow(result.rows[0]!)
  }

  async updateThreadSmartFilter(input: UpdateThreadSmartFilterInput) {
    await this.options.requireTenant(input.tenantId)
    const name = normalizeOptionalText(input.name, THREAD_SMART_FILTER_NAME_MAX_LENGTH, 'Smart filter name')
    const query = input.query === undefined ? undefined : normalizeThreadQuery(input.query)
    const result = await this.options.pool.query(
      `UPDATE cloud_thread_smart_filters
       SET name = COALESCE($3, name),
           query = COALESCE($4::jsonb, query),
           updated_at = $5
       WHERE tenant_id = $1 AND filter_id = $2
       RETURNING *`,
      [
        input.tenantId,
        input.filterId,
        name ?? null,
        query === undefined ? null : JSON.stringify(query),
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? threadSmartFilterFromRow(result.rows[0]) : null
  }

  async deleteThreadSmartFilter(tenantId: string, filterId: string) {
    await this.options.requireTenant(tenantId)
    const result = await this.options.pool.query(
      `DELETE FROM cloud_thread_smart_filters WHERE tenant_id = $1 AND filter_id = $2`,
      [tenantId, filterId],
    ) as QueryResult & { rowCount?: number }
    return Number(result.rowCount || 0) > 0
  }

  async listThreadMetadata(input: {
    tenantId: string
    userId: string
    tagIds?: string[]
    limit?: number
  }): Promise<ThreadMetadataRecord[]> {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const tagIds = input.tagIds
      ? normalizeIdList(input.tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
      : []
    const limit = Number.isInteger(input.limit) && input.limit && input.limit > 0
      ? Math.min(input.limit, THREAD_BULK_MAX_SESSION_IDS)
      : THREAD_BULK_MAX_SESSION_IDS
    const result = tagIds.length > 0
      ? await this.options.pool.query(
        `SELECT * FROM cloud_sessions s
         WHERE s.tenant_id = $1
           AND s.user_id = $2
           AND EXISTS (
             SELECT 1 FROM cloud_thread_tag_links link
             WHERE link.tenant_id = s.tenant_id
               AND link.session_id = s.session_id
               AND link.tag_id = ANY($3::text[])
           )
         ORDER BY s.updated_at DESC, s.session_id
         LIMIT $4`,
        [input.tenantId, input.userId, tagIds, limit],
      )
      : await this.options.pool.query(
        `SELECT * FROM cloud_sessions
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY updated_at DESC, session_id
         LIMIT $3`,
        [input.tenantId, input.userId, limit],
      )
    const sessions = result.rows.map(sessionFromRow)
    // Batch the tag lookup for the whole page in one query (was an N+1: one query per
    // returned session, up to THREAD_BULK_MAX_SESSION_IDS queries per call).
    const tagsBySession = await this.listThreadTagsForSessions(input.tenantId, sessions.map((session) => session.sessionId))
    return sessions.map((session) => ({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.sessionId,
      title: session.title,
      profileName: session.profileName,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      tags: tagsBySession.get(session.sessionId) || [],
    }))
  }

  private async requireThreadTag(
    tenantId: string,
    tagId: string,
    executor: PgExecutor = this.options.pool,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_thread_tags WHERE tenant_id = $1 AND tag_id = $2`,
      [tenantId, tagId],
      executor,
    )
    if (!row) throw new Error(`Unknown thread tag ${tagId}.`)
    return threadTagFromRow(row)
  }

  private async listThreadTagsForSessions(
    tenantId: string,
    sessionIds: string[],
  ): Promise<Map<string, ReturnType<typeof threadTagFromRow>[]>> {
    const bySession = new Map<string, ReturnType<typeof threadTagFromRow>[]>()
    if (sessionIds.length === 0) return bySession
    const result = await this.options.pool.query(
      `SELECT link.session_id AS link_session_id, tag.*
       FROM cloud_thread_tags tag
       JOIN cloud_thread_tag_links link
         ON link.tenant_id = tag.tenant_id
        AND link.tag_id = tag.tag_id
       WHERE link.tenant_id = $1 AND link.session_id = ANY($2::text[])
       ORDER BY lower(tag.name), tag.tag_id`,
      [tenantId, sessionIds],
    )
    for (const row of result.rows) {
      const sessionId = String(row.link_session_id)
      const list = bySession.get(sessionId) || []
      list.push(threadTagFromRow(row))
      bySession.set(sessionId, list)
    }
    return bySession
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
