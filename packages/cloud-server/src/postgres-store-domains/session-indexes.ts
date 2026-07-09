import {
  artifactIndexFromRow,
  launchpadSessionSummaryFromRow,
} from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  ListCloudArtifactIndexInput,
  ListCloudArtifactIndexResult,
  ListCloudLaunchpadSessionSummariesInput,
  ListCloudLaunchpadSessionSummariesResult,
  UpsertCloudArtifactIndexInput,
  UpsertCloudLaunchpadSessionSummaryInput,
} from '../control-plane-store.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresSessionIndexesRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
}

function hasPendingLaunchpadWork(input: Pick<UpsertCloudLaunchpadSessionSummaryInput, 'pendingApprovals' | 'pendingQuestions'>) {
  return input.pendingApprovals.length > 0 || input.pendingQuestions.length > 0
}

// Derived session read models extracted from the core sessions repository.
// These tables are maintained from projection output and are intentionally
// separate from the hot session event/command/lease path.
export class PostgresSessionIndexesRepository {
  private readonly options: PostgresSessionIndexesRepositoryOptions

  constructor(options: PostgresSessionIndexesRepositoryOptions) {
    this.options = options
  }

  async upsertCloudArtifactIndex(input: UpsertCloudArtifactIndexInput): Promise<CloudArtifactIndexRecord> {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const session = await this.maybeOne(
        `SELECT * FROM cloud_sessions
         WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
         FOR UPDATE`,
        [input.tenantId, input.userId, input.sessionId],
        client,
      )
      if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
      const result = await client.query(
        `INSERT INTO cloud_artifact_index (
          tenant_id,
          user_id,
          session_id,
          artifact_id,
          filename,
          content_type,
          size_bytes,
          object_key,
          kind,
          status,
          author_agent_id,
          project_id,
          task_id,
          status_updated_by,
          status_updated_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        ON CONFLICT (tenant_id, session_id, artifact_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          filename = EXCLUDED.filename,
          content_type = EXCLUDED.content_type,
          size_bytes = EXCLUDED.size_bytes,
          object_key = EXCLUDED.object_key,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          author_agent_id = EXCLUDED.author_agent_id,
          project_id = EXCLUDED.project_id,
          task_id = EXCLUDED.task_id,
          status_updated_by = EXCLUDED.status_updated_by,
          status_updated_at = EXCLUDED.status_updated_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *, (SELECT title FROM cloud_sessions s WHERE s.tenant_id = cloud_artifact_index.tenant_id AND s.session_id = cloud_artifact_index.session_id) AS session_title`,
        [
          input.tenantId,
          input.userId,
          input.sessionId,
          input.artifactId,
          input.filename,
          input.contentType,
          input.size,
          input.key,
          input.kind,
          input.status,
          input.authorAgentId,
          input.projectId,
          input.taskId,
          input.statusUpdatedBy,
          input.statusUpdatedAt,
          input.createdAt,
          input.updatedAt,
        ],
      )
      return artifactIndexFromRow(result.rows[0]!)
    })
  }

  async getCloudArtifactIndexRecord(input: {
    tenantId: string
    userId: string
    sessionId: string
    artifactId: string
  }): Promise<CloudArtifactIndexRecord | null> {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const row = await this.maybeOne(
      `SELECT a.*, s.title AS session_title
       FROM cloud_artifact_index a
       JOIN cloud_sessions s
         ON s.tenant_id = a.tenant_id
        AND s.session_id = a.session_id
       WHERE a.tenant_id = $1
         AND a.user_id = $2
         AND a.session_id = $3
         AND a.artifact_id = $4`,
      [input.tenantId, input.userId, input.sessionId, input.artifactId],
    )
    return row ? artifactIndexFromRow(row) : null
  }

  async listCloudArtifactIndex(input: ListCloudArtifactIndexInput): Promise<ListCloudArtifactIndexResult> {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    if (input.sessionId) {
      const session = await this.maybeOne(
        `SELECT session_id FROM cloud_sessions
         WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3`,
        [input.tenantId, input.userId, input.sessionId],
      )
      if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
    }
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)))
    const params: unknown[] = [input.tenantId, input.userId]
    const where = ['a.tenant_id = $1', 'a.user_id = $2']
    if (input.sessionId) {
      params.push(input.sessionId)
      where.push(`a.session_id = $${params.length}`)
    }
    const taskIds = [...new Set((input.taskIds || []).filter(Boolean))]
    if (input.projectId) {
      params.push(input.projectId)
      const projectParam = params.length
      if (taskIds.length > 0) {
        params.push(taskIds)
        where.push(`(a.project_id = $${projectParam} OR a.task_id = ANY($${params.length}::text[]))`)
      } else {
        where.push(`a.project_id = $${projectParam}`)
      }
    } else if (taskIds.length > 0) {
      params.push(taskIds)
      where.push(`a.task_id = ANY($${params.length}::text[])`)
    }
    if (input.taskId) {
      params.push(input.taskId)
      where.push(`a.task_id = $${params.length}`)
    }
    if (input.status) {
      params.push(input.status)
      where.push(`a.status = $${params.length}`)
    }
    if (input.kind) {
      params.push(input.kind)
      where.push(`a.kind = $${params.length}`)
    }
    params.push(limit + 1)
    const result = await this.options.pool.query(
      `SELECT a.*, s.title AS session_title
       FROM cloud_artifact_index a
       JOIN cloud_sessions s
         ON s.tenant_id = a.tenant_id
        AND s.session_id = a.session_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.updated_at DESC, a.session_id, a.artifact_id
       LIMIT $${params.length}`,
      params,
    )
    const rows = result.rows.map(artifactIndexFromRow)
    const items = rows.slice(0, limit)
    return {
      items,
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
      truncated: rows.length > limit,
    }
  }

  async upsertCloudLaunchpadSessionSummary(input: UpsertCloudLaunchpadSessionSummaryInput): Promise<CloudLaunchpadSessionSummaryRecord> {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const session = await this.maybeOne(
        `SELECT * FROM cloud_sessions
         WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3
         FOR UPDATE`,
        [input.tenantId, input.userId, input.sessionId],
        client,
      )
      if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
      if (!hasPendingLaunchpadWork(input)) {
        await client.query(
          `DELETE FROM cloud_launchpad_session_summaries
           WHERE tenant_id = $1 AND session_id = $2`,
          [input.tenantId, input.sessionId],
        )
        return launchpadSessionSummaryFromRow({
          tenant_id: input.tenantId,
          user_id: input.userId,
          session_id: input.sessionId,
          pending_approvals: input.pendingApprovals,
          pending_questions: input.pendingQuestions,
          updated_at: input.updatedAt,
          created_at: session.created_at,
          session_title: session.title,
        })
      }
      const result = await client.query(
        `INSERT INTO cloud_launchpad_session_summaries (
          tenant_id,
          user_id,
          session_id,
          pending_approvals,
          pending_questions,
          updated_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        ON CONFLICT (tenant_id, session_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          pending_approvals = EXCLUDED.pending_approvals,
          pending_questions = EXCLUDED.pending_questions,
          updated_at = EXCLUDED.updated_at
        RETURNING *, (SELECT created_at FROM cloud_sessions s WHERE s.tenant_id = cloud_launchpad_session_summaries.tenant_id AND s.session_id = cloud_launchpad_session_summaries.session_id) AS created_at,
          (SELECT title FROM cloud_sessions s WHERE s.tenant_id = cloud_launchpad_session_summaries.tenant_id AND s.session_id = cloud_launchpad_session_summaries.session_id) AS session_title`,
        [
          input.tenantId,
          input.userId,
          input.sessionId,
          JSON.stringify(input.pendingApprovals),
          JSON.stringify(input.pendingQuestions),
          input.updatedAt,
        ],
      )
      return launchpadSessionSummaryFromRow(result.rows[0]!)
    })
  }

  async listCloudLaunchpadSessionSummaries(input: ListCloudLaunchpadSessionSummariesInput): Promise<ListCloudLaunchpadSessionSummariesResult> {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)))
    const result = await this.options.pool.query(
      `SELECT l.*, s.title AS session_title, s.created_at AS created_at
       FROM cloud_launchpad_session_summaries l
       JOIN cloud_sessions s
         ON s.tenant_id = l.tenant_id
        AND s.session_id = l.session_id
       WHERE l.tenant_id = $1
         AND l.user_id = $2
       ORDER BY l.updated_at DESC, l.session_id
       LIMIT $3`,
      [input.tenantId, input.userId, limit + 1],
    )
    const rows = result.rows.map(launchpadSessionSummaryFromRow)
    const items = rows.slice(0, limit)
    return {
      items,
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
      truncated: rows.length > limit,
    }
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[], executor: PgExecutor = this.options.pool) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }
}
