import { createWorkClaimToken, nowIso, stableId } from '../postgres-store-id-helpers.ts'
import { workflowFromRow, workflowRunFromRow } from '../postgres-domains/workflows.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import { assertPostgresWorkflowRunQuota, type PostgresQuotaDomainDeps } from './quotas.ts'
import { normalizeWorkflowSteps, type WorkflowRunStatus, type WorkflowStatus } from '@open-cowork/shared'
import type {
  AttachWorkflowRunSessionInput,
  ClaimDueWorkflowRunInput,
  ClaimedWorkflowRunRecord,
  CloudWorkflowRecord,
  CloudWorkflowRunRecord,
  CompleteWorkflowRunInput,
  CreateWorkflowInput,
  CreateWorkflowRunInput,
  FailWorkflowRunInput,
  ListWorkflowRunsForWorkflowsInput,
  ListWorkflowsPageInput,
  ListWorkflowsPageRecord,
  ReapExpiredWorkflowClaimsInput,
  ReapedWorkflowClaimRecord,
  UpdateWorkflowStatusInput,
} from '../control-plane-store.ts'
import { decodeWorkflowPageCursor, encodeWorkflowPageCursor } from '../workflow-page-cursor.ts'

// Workflow SQL domain extracted from postgres-control-plane-store.ts. Owns the workflow
// drafts + runs lifecycle: create/find/list/get, status transitions, run creation (with
// the workflow-run quota gate), due-run claiming (claim tokens + leases), claim reaping,
// session attach, and completion/failure. Tenant/tenant-user checks, lease-token
// validation, the transaction runner and the shared quota deps arrive via the injected
// host (the session core stays in the store). Behaviour-preserving; covered by the
// pglite + real-Postgres control-plane contract suites.

const WORKFLOW_RUN_LIST_LIMIT = 100
const WORKFLOW_LIST_LIMIT = 500

function workflowRunSessionId(tenantId: string, workflowId: string, runId: string) {
  return stableId('workflow_session', tenantId, workflowId, runId)
}

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresWorkflowsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenant(tenantId: string, executor?: PgExecutor): Promise<unknown>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
  assertLeaseTokenIfPresent(tenantId: string, sessionId: string, leaseToken: string | null | undefined, executor: PgExecutor): Promise<void>
  quotaDeps: PostgresQuotaDomainDeps
}

export class PostgresWorkflowsRepository {
  private readonly options: PostgresWorkflowsRepositoryOptions

  constructor(options: PostgresWorkflowsRepositoryOptions) {
    this.options = options
  }

  async createWorkflow(input: CreateWorkflowInput) {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const createdAt = nowIso(input.createdAt)
    const draft = input.draft
    const skillNames = draft.skillNames || []
    const toolIds = draft.toolIds || []
    const steps = normalizeWorkflowSteps(draft.steps, {
      instructions: draft.instructions,
      agentName: draft.agentName,
      skillNames,
      toolIds,
    })
    await this.options.pool.query(
      `INSERT INTO cloud_workflows (
        tenant_id, workflow_id, user_id, title, instructions, agent_name,
        skill_names, tool_ids, steps, status, project_directory, draft_session_id,
        triggers, created_at, updated_at, next_run_at, last_run_at,
        latest_run_id, latest_run_status, latest_run_session_id, latest_run_summary
       )
       VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8::jsonb, $9::jsonb, 'active', $10, $11,
        $12::jsonb, $13, $13, $14, NULL,
        NULL, NULL, NULL, NULL
       )
       ON CONFLICT (tenant_id, workflow_id) DO NOTHING`,
      [
        input.tenantId,
        input.workflowId,
        input.userId,
        draft.title,
        draft.instructions,
        draft.agentName,
        JSON.stringify(skillNames),
        JSON.stringify(toolIds),
        JSON.stringify(steps),
        draft.projectDirectory || null,
        draft.draftSessionId || null,
        JSON.stringify(draft.triggers),
        createdAt,
        input.nextRunAt || null,
      ],
    )
    return workflowFromRow(await this.requireWorkflow(input.tenantId, input.workflowId))
  }

  async findWorkflow(workflowId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE workflow_id = $1
       ORDER BY updated_at DESC, tenant_id
       LIMIT 1`,
      [workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async listWorkflows(tenantId: string, userId: string) {
    return (await this.listWorkflowsPage({ tenantId, userId, limit: WORKFLOW_LIST_LIMIT })).items
  }

  async listWorkflowsPage(input: ListWorkflowsPageInput): Promise<ListWorkflowsPageRecord> {
    const { tenantId, userId } = input
    await this.options.requireTenantUser(tenantId, userId)
    const limit = Math.max(1, Math.min(WORKFLOW_LIST_LIMIT, Math.floor(input.limit ?? 100)))
    const cursor = decodeWorkflowPageCursor(input.cursor, input)
    const params: unknown[] = [tenantId, userId]
    const where = ['tenant_id = $1', 'user_id = $2']
    if (cursor) {
      params.push(cursor.updatedAt, cursor.workflowId)
      const updatedAtParam = params.length - 1
      const workflowIdParam = params.length
      where.push(`(updated_at < $${updatedAtParam} OR (updated_at = $${updatedAtParam} AND workflow_id > $${workflowIdParam}))`)
    }
    params.push(limit + 1)
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_workflows
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, workflow_id
       LIMIT $${params.length}`,
      params,
    )
    const rows = result.rows.map(workflowFromRow)
    const items = rows.slice(0, limit)
    return {
      items,
      nextCursor: rows.length > limit && items.length > 0 ? encodeWorkflowPageCursor(items[items.length - 1]!, input) : null,
      totalEstimate: rows.length > limit ? limit + 1 : rows.length,
    }
  }

  async getWorkflow(tenantId: string, userId: string, workflowId: string) {
    await this.options.requireTenantUser(tenantId, userId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3`,
      [tenantId, userId, workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async getWorkflowForTenant(tenantId: string, workflowId: string) {
    await this.options.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows WHERE tenant_id = $1 AND workflow_id = $2`,
      [tenantId, workflowId],
    )
    return row ? workflowFromRow(row) : null
  }

  async updateWorkflowStatus(input: UpdateWorkflowStatusInput) {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const result = await this.options.pool.query(
      `UPDATE cloud_workflows
       SET status = $4,
           next_run_at = $5,
           updated_at = $6
       WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3
       RETURNING *`,
      [
        input.tenantId,
        input.userId,
        input.workflowId,
        input.status,
        input.nextRunAt || null,
        nowIso(input.updatedAt),
      ],
    )
    return result.rows[0] ? workflowFromRow(result.rows[0]) : null
  }

  async listWorkflowRuns(tenantId: string, workflowId: string, limit = 25) {
    await this.requireWorkflow(tenantId, workflowId)
    const boundedLimit = Math.min(Math.max(1, limit), WORKFLOW_RUN_LIST_LIMIT)
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_workflow_runs
       WHERE tenant_id = $1 AND workflow_id = $2
       ORDER BY created_at DESC, run_id
       LIMIT $3`,
      [tenantId, workflowId, boundedLimit],
    )
    return result.rows.map(workflowRunFromRow)
  }

  async listWorkflowRunsForWorkflows(input: ListWorkflowRunsForWorkflowsInput) {
    await this.options.requireTenantUser(input.tenantId, input.userId)
    const workflowIds = Array.from(new Set(input.workflowIds.filter(Boolean)))
      .slice(0, WORKFLOW_LIST_LIMIT)
    if (workflowIds.length === 0) return []
    const limitPerWorkflow = Math.max(1, Math.min(WORKFLOW_RUN_LIST_LIMIT, Math.floor(input.limitPerWorkflow ?? 25)))
    const limit = Math.max(1, Math.min(WORKFLOW_RUN_LIST_LIMIT, Math.floor(input.limit ?? WORKFLOW_RUN_LIST_LIMIT)))
    const result = await this.options.pool.query(
      `WITH requested AS (
         SELECT DISTINCT unnest($3::text[]) AS workflow_id
       )
       SELECT runs.*
       FROM requested
       CROSS JOIN LATERAL (
         SELECT candidate.*
         FROM cloud_workflow_runs candidate
         JOIN cloud_workflows workflows
           ON workflows.tenant_id = candidate.tenant_id
          AND workflows.workflow_id = candidate.workflow_id
         WHERE candidate.tenant_id = $1
           AND candidate.workflow_id = requested.workflow_id
           AND workflows.user_id = $2
         ORDER BY candidate.created_at DESC, candidate.run_id
         LIMIT $4
       ) runs
       ORDER BY created_at DESC, run_id
       LIMIT $5`,
      [input.tenantId, input.userId, workflowIds, limitPerWorkflow, limit],
    )
    return result.rows.map(workflowRunFromRow)
  }

  async createWorkflowRun(input: CreateWorkflowRunInput) {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const workflow = workflowFromRow(await this.requireWorkflow(input.tenantId, input.workflowId, client, true))
      if (workflow.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
      const existing = await this.maybeOne(
        `SELECT * FROM cloud_workflow_runs WHERE tenant_id = $1 AND run_id = $2`,
        [input.tenantId, input.runId],
        client,
      )
      if (existing) return workflowRunFromRow(existing)
      this.assertWorkflowRunnable(workflow)
      const createdAt = nowIso(input.createdAt)
      await assertPostgresWorkflowRunQuota(client, {
        tenantId: input.tenantId,
        quota: input.quota,
        now: new Date(createdAt),
      }, this.options.quotaDeps)
      const claimedBy = input.claimedBy?.trim() || null
      const claimToken = claimedBy ? createWorkClaimToken(input.tenantId, input.runId, claimedBy) : null
      const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
      const claimExpiresAt = claimToken ? new Date(new Date(createdAt).getTime() + leaseTtlMs).toISOString() : null
      const plannedSessionId = input.sessionId?.trim() || workflowRunSessionId(input.tenantId, input.workflowId, input.runId)
      const result = await client.query(
        `INSERT INTO cloud_workflow_runs (
          tenant_id, run_id, workflow_id, user_id, session_id, trigger_type,
          trigger_payload, status, title, summary, error, created_at, started_at, finished_at,
          claimed_by, claim_token, claim_expires_at, attempt_count, idempotency_key,
          checkpoint_version, last_error_code, last_error_summary
         )
         VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, 'queued', $8, NULL, NULL, $9, NULL, NULL,
          $10, $11, $12, $13, NULL, 0, NULL, NULL
         )
         RETURNING *`,
        [
          input.tenantId,
          input.runId,
          input.workflowId,
          input.userId,
          plannedSessionId,
          input.triggerType,
          input.triggerPayload ? JSON.stringify(input.triggerPayload) : null,
          `Run ${workflow.title}`,
          createdAt,
          claimedBy,
          claimToken,
          claimExpiresAt,
          claimToken ? 1 : 0,
        ],
      )
      await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'queued',
             latest_run_session_id = $4,
             updated_at = $5
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [input.tenantId, input.workflowId, input.runId, plannedSessionId, createdAt],
      )
      return workflowRunFromRow(result.rows[0]!)
    })
  }

  async claimDueWorkflowRun(input: ClaimDueWorkflowRunInput): Promise<ClaimedWorkflowRunRecord | null> {
    return this.options.withTransaction(async (client) => {
      const now = input.now || new Date()
      const claimedAt = now.toISOString()
      const claimedBy = input.claimedBy?.trim() || 'scheduler'
      const leaseTtlMs = Math.max(1, Math.floor(input.leaseTtlMs ?? 30_000))
      const claimExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString()
      const retryRow = await this.maybeOne(
        `SELECT runs.*, workflows.tenant_id AS workflow_tenant_id
         FROM cloud_workflow_runs runs
         JOIN cloud_workflows workflows
           ON workflows.tenant_id = runs.tenant_id
          AND workflows.workflow_id = runs.workflow_id
         WHERE runs.claim_token IS NULL
           AND (
             (
               runs.status = 'queued'
               AND (
                 runs.session_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                   FROM cloud_session_commands commands
                   WHERE commands.tenant_id = runs.tenant_id
                     AND commands.session_id = runs.session_id
                 )
               )
             )
             OR (
               runs.status = 'running'
               AND runs.session_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM cloud_session_commands commands
                 WHERE commands.tenant_id = runs.tenant_id
                   AND commands.session_id = runs.session_id
               )
             )
           )
           AND workflows.status = 'running'
         ORDER BY runs.created_at ASC, runs.run_id
         FOR UPDATE OF runs, workflows SKIP LOCKED
         LIMIT 1`,
        [],
        client,
      )
      if (retryRow) {
        const runId = String(retryRow.run_id)
        const tenantId = String(retryRow.tenant_id)
        const workflowId = String(retryRow.workflow_id)
        const retryStatus = String(retryRow.status)
        const retrySessionId = retryRow.session_id ? String(retryRow.session_id) : null
        const claimToken = createWorkClaimToken(tenantId, runId, claimedBy)
        const updatedRun = await client.query(
          `UPDATE cloud_workflow_runs
           SET claimed_by = $4,
               claim_token = $5,
               claim_expires_at = $6,
               attempt_count = attempt_count + 1,
               last_error_code = NULL,
               last_error_summary = NULL
           WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
           RETURNING *`,
          [tenantId, workflowId, runId, claimedBy, claimToken, claimExpiresAt],
        )
        const updatedWorkflow = await client.query(
          `UPDATE cloud_workflows
           SET status = 'running',
               latest_run_id = $3,
               latest_run_status = $4,
               latest_run_session_id = $5,
               updated_at = $6
           WHERE tenant_id = $1 AND workflow_id = $2
           RETURNING *`,
          [tenantId, workflowId, runId, retryStatus, retrySessionId, claimedAt],
        )
        return {
          workflow: workflowFromRow(updatedWorkflow.rows[0]!),
          run: workflowRunFromRow(updatedRun.rows[0]!),
        }
      }
      const row = await this.maybeOne(
        `SELECT * FROM cloud_workflows
         WHERE status = 'active'
           AND next_run_at IS NOT NULL
           AND next_run_at <= $1
         ORDER BY next_run_at ASC, tenant_id, workflow_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [claimedAt],
        client,
      )
      if (!row) return null
      const workflow = workflowFromRow(row)
      await assertPostgresWorkflowRunQuota(client, {
        tenantId: workflow.tenantId,
        quota: input.quota,
        now,
      }, this.options.quotaDeps)
      const claimToken = createWorkClaimToken(workflow.tenantId, input.runId, claimedBy)
      const plannedSessionId = input.sessionId?.trim() || workflowRunSessionId(workflow.tenantId, workflow.id, input.runId)
      const result = await client.query(
        `INSERT INTO cloud_workflow_runs (
          tenant_id, run_id, workflow_id, user_id, session_id, trigger_type,
          trigger_payload, status, title, summary, error, created_at, started_at, finished_at,
          claimed_by, claim_token, claim_expires_at, attempt_count, idempotency_key,
          checkpoint_version, last_error_code, last_error_summary
         )
         VALUES (
          $1, $2, $3, $4, $5, 'schedule',
          $6::jsonb, 'queued', $7, NULL, NULL, $8, NULL, NULL,
          $9, $10, $11, 1, $12, 0, NULL, NULL
         )
         RETURNING *`,
        [
          workflow.tenantId,
          input.runId,
          workflow.id,
          workflow.userId,
          plannedSessionId,
          JSON.stringify({ source: 'schedule', scheduledFor: workflow.nextRunAt }),
          `Run ${workflow.title}`,
          claimedAt,
          claimedBy,
          claimToken,
          claimExpiresAt,
          `schedule:${workflow.id}:${workflow.nextRunAt}`,
        ],
      )
      const updatedWorkflow = await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'queued',
             latest_run_session_id = $4,
             updated_at = $5
         WHERE tenant_id = $1 AND workflow_id = $2
         RETURNING *`,
        [workflow.tenantId, workflow.id, input.runId, plannedSessionId, claimedAt],
      )
      return {
        workflow: workflowFromRow(updatedWorkflow.rows[0]!),
        run: workflowRunFromRow(result.rows[0]!),
      }
    })
  }

  async reapExpiredWorkflowClaims(input: ReapExpiredWorkflowClaimsInput = {}): Promise<ReapedWorkflowClaimRecord[]> {
    const now = input.now || new Date()
    const nowIsoValue = now.toISOString()
    const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? 3))
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
    return this.options.withTransaction(async (client) => {
      const expired = await client.query(
        `SELECT *
         FROM cloud_workflow_runs
         WHERE claim_token IS NOT NULL
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at <= $1
           AND (
             (
               status = 'queued'
               AND (
                 session_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                   FROM cloud_session_commands commands
                   WHERE commands.tenant_id = cloud_workflow_runs.tenant_id
                     AND commands.session_id = cloud_workflow_runs.session_id
                 )
               )
             )
             OR (
               status = 'running'
               AND session_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM cloud_session_commands commands
                 WHERE commands.tenant_id = cloud_workflow_runs.tenant_id
                   AND commands.session_id = cloud_workflow_runs.session_id
               )
             )
           )
         ORDER BY claim_expires_at ASC, tenant_id, workflow_id, run_id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowIsoValue, limit],
      )
      const reaped: ReapedWorkflowClaimRecord[] = []
      for (const row of expired.rows) {
        const run = workflowRunFromRow(row)
        await this.requireWorkflow(run.tenantId, run.workflowId, client, true)
        const claimToken = run.claimToken
        if (!claimToken) continue
        const claimedBy = run.claimedBy || 'unknown'
        const action: ReapedWorkflowClaimRecord['action'] = run.attemptCount >= maxAttempts ? 'failed' : 'retried'
        if (action === 'failed') {
          const summary = 'Workflow run claim expired after the maximum retry attempts.'
          await client.query(
            `UPDATE cloud_workflow_runs
             SET status = 'failed',
                 summary = $4,
                 error = $4,
                 finished_at = $5,
                 claimed_by = NULL,
                 claim_token = NULL,
                 claim_expires_at = NULL,
                 last_error_code = 'claim_expired_max_attempts',
                 last_error_summary = $4
             WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3`,
            [run.tenantId, run.workflowId, run.id, summary, nowIsoValue],
          )
          await client.query(
            `UPDATE cloud_workflows
             SET status = 'failed',
                 latest_run_id = $3,
                 latest_run_status = 'failed',
                 latest_run_summary = $4,
                 next_run_at = NULL,
                 updated_at = $5
             WHERE tenant_id = $1 AND workflow_id = $2`,
            [run.tenantId, run.workflowId, run.id, summary, nowIsoValue],
          )
        } else {
          await client.query(
            `UPDATE cloud_workflow_runs
             SET claimed_by = NULL,
                 claim_token = NULL,
                 claim_expires_at = NULL,
                 last_error_code = 'claim_expired',
                 last_error_summary = $4
             WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3`,
            [
              run.tenantId,
              run.workflowId,
              run.id,
              run.status === 'running'
                ? 'Workflow run claim expired before command enqueue.'
                : 'Workflow run claim expired before session attachment.',
            ],
          )
          await client.query(
            `UPDATE cloud_workflows
             SET status = 'running',
                 latest_run_id = $3,
                 latest_run_status = $4,
                 latest_run_session_id = $5,
                 updated_at = $6
             WHERE tenant_id = $1 AND workflow_id = $2`,
            [run.tenantId, run.workflowId, run.id, run.status, run.sessionId, nowIsoValue],
          )
        }
        reaped.push({
          tenantId: run.tenantId,
          workflowId: run.workflowId,
          runId: run.id,
          claimToken,
          claimedBy,
          action,
          reapedAt: nowIsoValue,
        })
      }
      return reaped
    })
  }

  async attachWorkflowRunSession(input: AttachWorkflowRunSessionInput) {
    return this.options.withTransaction(async (client) => {
      await this.requireWorkflow(input.tenantId, input.workflowId, client, true)
      const runRow = await this.maybeOne(
        `SELECT * FROM cloud_workflow_runs
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         FOR UPDATE`,
        [input.tenantId, input.workflowId, input.runId],
        client,
      )
      if (!runRow) return null
      const current = workflowRunFromRow(runRow)
      if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
        throw new Error('Workflow run is not attachable.')
      }
      if (current.status !== 'queued' && !(current.status === 'running' && current.sessionId === input.sessionId)) {
        throw new Error('Workflow run is not attachable.')
      }
      if (current.sessionId && current.sessionId !== input.sessionId) throw new Error('Workflow run is already attached to another session.')
      if (current.claimToken) {
        if (current.claimToken !== (input.claimToken ?? null)) throw new Error('Workflow run claim is stale.')
        if (current.claimExpiresAt && Date.parse(current.claimExpiresAt) <= Date.now()) {
          throw new Error('Workflow run claim is stale.')
        }
      } else if (input.claimToken) {
        throw new Error('Workflow run claim is stale.')
      }
      const startedAt = nowIso(input.startedAt)
      const result = await client.query(
        `UPDATE cloud_workflow_runs
         SET session_id = $4,
             status = 'running',
             started_at = COALESCE(started_at, $5),
             claimed_by = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         RETURNING *`,
        [input.tenantId, input.workflowId, input.runId, input.sessionId, startedAt],
      )
      if (!result.rows[0]) return null
      await client.query(
        `UPDATE cloud_workflows
         SET status = 'running',
             latest_run_id = $3,
             latest_run_status = 'running',
             latest_run_session_id = $4,
             updated_at = $5
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [input.tenantId, input.workflowId, input.runId, input.sessionId, startedAt],
      )
      return workflowRunFromRow(result.rows[0])
    })
  }

  async completeWorkflowRun(input: CompleteWorkflowRunInput, executor?: PgExecutor) {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'completed',
      summary: input.summary,
      error: null,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    }, executor)
  }

  async failWorkflowRun(input: FailWorkflowRunInput, executor?: PgExecutor) {
    return this.finishWorkflowRun({
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      runId: input.runId,
      status: 'failed',
      summary: input.error,
      error: input.error,
      nextStatus: input.nextStatus,
      nextRunAt: input.nextRunAt,
      leaseToken: input.leaseToken,
      finishedAt: input.finishedAt,
    }, executor)
  }

  async getWorkflowRun(tenantId: string, runId: string) {
    await this.options.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflow_runs WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    )
    return row ? workflowRunFromRow(row) : null
  }

  async getWorkflowRunBySession(tenantId: string, sessionId: string) {
    await this.options.requireTenant(tenantId)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflow_runs
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, sessionId],
    )
    return row ? workflowRunFromRow(row) : null
  }


  private async requireWorkflow(
    tenantId: string,
    workflowId: string,
    executor: PgExecutor = this.options.pool,
    forUpdate = false,
  ) {
    await this.options.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      `SELECT * FROM cloud_workflows
       WHERE tenant_id = $1 AND workflow_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, workflowId],
      executor,
    )
    if (!row) throw new Error(`Unknown workflow ${workflowId}.`)
    return row
  }

  private assertWorkflowRunnable(workflow: CloudWorkflowRecord) {
    if (workflow.status === 'archived') throw new Error('Archived workflows cannot run.')
    if (workflow.status === 'paused') throw new Error('Paused workflows cannot run.')
    if (workflow.status === 'running') throw new Error('Workflow is already running.')
  }

  private async finishWorkflowRun(input: {
    tenantId: string
    workflowId: string
    runId: string
    status: Extract<WorkflowRunStatus, 'completed' | 'failed'>
    summary: string | null
    error: string | null
    nextStatus: WorkflowStatus
    nextRunAt: string | null
    leaseToken?: string | null
    finishedAt?: Date
  }, executor?: PgExecutor): Promise<CloudWorkflowRunRecord | null> {
    const finish = async (client: PgExecutor) => {
      await this.requireWorkflow(input.tenantId, input.workflowId, client, true)
      const runRow = await this.maybeOne(
        `SELECT * FROM cloud_workflow_runs
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         FOR UPDATE`,
        [input.tenantId, input.workflowId, input.runId],
        client,
      )
      if (!runRow) return null
      const current = workflowRunFromRow(runRow)
      if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
        return current
      }
      if (input.leaseToken !== undefined) {
        if (!current.sessionId) throw new Error('Workflow run has no execution session to fence.')
        await this.options.assertLeaseTokenIfPresent(input.tenantId, current.sessionId, input.leaseToken, client)
      }
      const finishedAt = nowIso(input.finishedAt)
      const result = await client.query(
        `UPDATE cloud_workflow_runs
         SET status = $4,
             summary = $5,
             error = $6,
             finished_at = $7
         WHERE tenant_id = $1 AND workflow_id = $2 AND run_id = $3
         RETURNING *`,
        [
          input.tenantId,
          input.workflowId,
          input.runId,
          input.status,
          input.summary,
          input.error,
          finishedAt,
        ],
      )
      await client.query(
        `UPDATE cloud_workflows
         SET status = $4,
             latest_run_id = $3,
             latest_run_status = $5,
             latest_run_summary = $6,
             last_run_at = CASE WHEN $5 = 'completed' THEN $7 ELSE last_run_at END,
             next_run_at = $8,
             updated_at = $7
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [
          input.tenantId,
          input.workflowId,
          input.runId,
          input.nextStatus,
          input.status,
          input.summary,
          finishedAt,
          input.nextRunAt,
        ],
      )
      return workflowRunFromRow(result.rows[0]!)
    }
    return executor ? finish(executor) : this.options.withTransaction(finish)
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
