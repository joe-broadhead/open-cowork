import { normalizeWorkflowSteps } from '@open-cowork/shared'
import { workflowFromRow, workflowWebhookSecretFromRow } from '../postgres-domains/workflows.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import { nowIso } from '../postgres-store-id-helpers.ts'
import type {
  CreateWorkflowInput,
  ListWorkflowsPageInput,
  ListWorkflowsPageRecord,
  MigrateLegacyWorkflowWebhookSecretInput,
  RotateWorkflowWebhookSecretInput,
  UpdateWorkflowStatusInput,
} from '../control-plane-store.ts'
import { decodeWorkflowPageCursor, encodeWorkflowPageCursor } from '../workflow-page-cursor.ts'

// Workflow-definition SQL domain. Owns definition reads and the atomic lifecycle
// coupling public webhook trigger metadata to encrypted or legacy secret records.
// Transaction, tenant, and tenant-user boundaries are injected by the composition root.

const WORKFLOW_LIST_LIMIT = 500

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresWorkflowDefinitionsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  requireTenant(tenantId: string, executor?: PgExecutor): Promise<unknown>
  requireTenantUser(tenantId: string, userId: string, executor?: PgExecutor): Promise<unknown>
}

export class PostgresWorkflowDefinitionsRepository {
  private readonly options: PostgresWorkflowDefinitionsRepositoryOptions

  constructor(options: PostgresWorkflowDefinitionsRepositoryOptions) {
    this.options = options
  }

  async createWorkflow(input: CreateWorkflowInput) {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
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
      const publicTriggers = draft.triggers.map((value) => {
        const { webhookSecret: _webhookSecret, ...trigger } = value as unknown as Record<string, unknown>
        return trigger
      })
      const created = await client.query(
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
         ON CONFLICT (tenant_id, workflow_id) DO NOTHING
         RETURNING *`,
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
          JSON.stringify(publicTriggers),
          createdAt,
          input.nextRunAt || null,
        ],
      )
      if (!created.rows[0]) {
        const existing = workflowFromRow(await this.requireWorkflow(input.tenantId, input.workflowId, client))
        if (existing.userId !== input.userId) throw new Error(`Unknown workflow ${input.workflowId}.`)
        return existing
      }
      for (const secret of input.webhookSecrets || []) {
        await client.query(
          `INSERT INTO cloud_workflow_webhook_secrets (
             tenant_id, workflow_id, trigger_id, ciphertext, envelope_version,
             status, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
           ON CONFLICT (tenant_id, workflow_id, trigger_id) DO NOTHING`,
          [
            input.tenantId,
            input.workflowId,
            secret.triggerId,
            secret.ciphertext,
            secret.envelopeVersion,
            createdAt,
          ],
        )
      }
      return workflowFromRow(created.rows[0])
    })
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
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const row = await this.maybeOne(
        `SELECT *
         FROM cloud_workflows
         WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3
         FOR UPDATE`,
        [input.tenantId, input.userId, input.workflowId],
        client,
      )
      if (!row) return null
      const rawTriggers = Array.isArray(row.triggers) ? row.triggers : []
      const webhookTriggerIds = rawTriggers.flatMap((value): string[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const trigger = value as Record<string, unknown>
        return trigger.type === 'webhook' && typeof trigger.id === 'string'
          ? [trigger.id]
          : []
      })
      if (input.status === 'active' && webhookTriggerIds.length > 0) {
        const activeSecret = await this.maybeOne(
          `SELECT 1
           FROM cloud_workflow_webhook_secrets
           WHERE tenant_id = $1
             AND workflow_id = $2
             AND trigger_id = ANY($3::text[])
             AND status = 'active'
           LIMIT 1`,
          [input.tenantId, input.workflowId, webhookTriggerIds],
          client,
        )
        if (!activeSecret) return null
      }
      const publicTriggers = input.status === 'archived'
        ? rawTriggers.map((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return value
            const { webhookSecret: _webhookSecret, ...publicTrigger } = value as Record<string, unknown>
            return publicTrigger
          })
        : rawTriggers
      const updatedAt = nowIso(input.updatedAt)
      if (input.status === 'archived') {
        await client.query(
          `UPDATE cloud_workflow_webhook_secrets
           SET status = 'revoked',
               updated_at = $3
           WHERE tenant_id = $1
             AND workflow_id = $2
             AND status = 'active'`,
          [input.tenantId, input.workflowId, updatedAt],
        )
      }
      const result = await client.query(
        `UPDATE cloud_workflows
         SET status = $4,
             next_run_at = $5,
             updated_at = $6,
             triggers = $7::jsonb
         WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3
         RETURNING *`,
        [
          input.tenantId,
          input.userId,
          input.workflowId,
          input.status,
          input.nextRunAt || null,
          updatedAt,
          JSON.stringify(publicTriggers),
        ],
      )
      return result.rows[0] ? workflowFromRow(result.rows[0]) : null
    })
  }

  async getWorkflowWebhookSecret(tenantId: string, workflowId: string, triggerId?: string) {
    const row = await this.maybeOne(
      `SELECT *
       FROM cloud_workflow_webhook_secrets
       WHERE tenant_id = $1
         AND workflow_id = $2
         ${triggerId ? 'AND trigger_id = $3' : ''}
       ORDER BY updated_at DESC, trigger_id
       LIMIT 1`,
      triggerId ? [tenantId, workflowId, triggerId] : [tenantId, workflowId],
    )
    return row ? workflowWebhookSecretFromRow(row) : null
  }

  async rotateWorkflowWebhookSecret(input: RotateWorkflowWebhookSecretInput) {
    return this.options.withTransaction(async (client) => {
      await this.options.requireTenantUser(input.tenantId, input.userId, client)
      const workflow = await this.maybeOne(
        `SELECT *
         FROM cloud_workflows
         WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3
         FOR UPDATE`,
        [input.tenantId, input.userId, input.workflowId],
        client,
      )
      if (!workflow) return null
      const publicWorkflow = workflowFromRow(workflow)
      if (!publicWorkflow.triggers.some((trigger) => trigger.id === input.triggerId && trigger.type === 'webhook')) {
        return null
      }
      const publicTriggers = (Array.isArray(workflow.triggers) ? workflow.triggers : [])
        .map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value
          const trigger = value as Record<string, unknown>
          if (trigger.id !== input.triggerId || trigger.type !== 'webhook') return trigger
          const { webhookSecret: _webhookSecret, ...publicTrigger } = trigger
          return publicTrigger
        })
      const updatedAt = nowIso(input.updatedAt)
      const result = await client.query(
        `INSERT INTO cloud_workflow_webhook_secrets (
           tenant_id, workflow_id, trigger_id, ciphertext, envelope_version,
           status, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
         ON CONFLICT (tenant_id, workflow_id, trigger_id) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext,
               envelope_version = EXCLUDED.envelope_version,
               status = 'active',
               updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          input.tenantId,
          input.workflowId,
          input.triggerId,
          input.ciphertext,
          input.envelopeVersion,
          updatedAt,
        ],
      )
      await client.query(
        `UPDATE cloud_workflows
         SET triggers = $4::jsonb,
             updated_at = $5
         WHERE tenant_id = $1 AND user_id = $2 AND workflow_id = $3`,
        [
          input.tenantId,
          input.userId,
          input.workflowId,
          JSON.stringify(publicTriggers),
          updatedAt,
        ],
      )
      return workflowWebhookSecretFromRow(result.rows[0]!)
    })
  }

  async listLegacyWorkflowWebhookSecrets(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const result = await this.options.pool.query(
      `SELECT
         workflows.tenant_id,
         workflows.workflow_id,
         trigger.value->>'id' AS trigger_id,
         trigger.value->>'webhookSecret' AS plaintext,
         workflows.updated_at
       FROM cloud_workflows workflows
       CROSS JOIN LATERAL jsonb_array_elements(workflows.triggers) AS trigger(value)
       WHERE trigger.value->>'type' = 'webhook'
         AND NULLIF(trigger.value->>'webhookSecret', '') IS NOT NULL
       ORDER BY workflows.updated_at, workflows.tenant_id, workflows.workflow_id, trigger.value->>'id'
       LIMIT $1`,
      [boundedLimit],
    )
    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      workflowId: String(row.workflow_id),
      triggerId: String(row.trigger_id),
      plaintext: String(row.plaintext),
      updatedAt: nowIso(new Date(String(row.updated_at))),
    }))
  }

  async getLegacyWorkflowWebhookSecret(tenantId: string, workflowId: string, triggerId: string) {
    const row = await this.maybeOne(
      `SELECT
         workflows.tenant_id,
         workflows.workflow_id,
         trigger.value->>'id' AS trigger_id,
         trigger.value->>'webhookSecret' AS plaintext,
         workflows.updated_at
       FROM cloud_workflows workflows
       CROSS JOIN LATERAL jsonb_array_elements(workflows.triggers) AS trigger(value)
       WHERE workflows.tenant_id = $1
         AND workflows.workflow_id = $2
         AND trigger.value->>'id' = $3
         AND trigger.value->>'type' = 'webhook'
         AND NULLIF(trigger.value->>'webhookSecret', '') IS NOT NULL
       LIMIT 1`,
      [tenantId, workflowId, triggerId],
    )
    return row
      ? {
          tenantId: String(row.tenant_id),
          workflowId: String(row.workflow_id),
          triggerId: String(row.trigger_id),
          plaintext: String(row.plaintext),
          updatedAt: nowIso(new Date(String(row.updated_at))),
        }
      : null
  }

  async migrateLegacyWorkflowWebhookSecret(input: MigrateLegacyWorkflowWebhookSecretInput) {
    return this.options.withTransaction(async (client) => {
      const row = await this.maybeOne(
        `SELECT status, triggers
         FROM cloud_workflows
         WHERE tenant_id = $1 AND workflow_id = $2
         FOR UPDATE`,
        [input.tenantId, input.workflowId],
        client,
      )
      if (!row) return false
      const triggers = Array.isArray(row.triggers) ? row.triggers : []
      let matched = false
      const publicTriggers = triggers.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const trigger = value as Record<string, unknown>
        if (
          trigger.id !== input.triggerId
          || trigger.type !== 'webhook'
          || trigger.webhookSecret !== input.expectedPlaintext
        ) return trigger
        matched = true
        const { webhookSecret: _webhookSecret, ...publicTrigger } = trigger
        return publicTrigger
      })
      if (!matched) return false
      const migratedAt = nowIso(input.migratedAt)
      const targetStatus = String(row.status) === 'archived' ? 'revoked' : 'active'
      const existingSecret = await this.maybeOne(
        `SELECT *
         FROM cloud_workflow_webhook_secrets
         WHERE tenant_id = $1 AND workflow_id = $2 AND trigger_id = $3
         FOR UPDATE`,
        [input.tenantId, input.workflowId, input.triggerId],
        client,
      )
      if (input.expectedExistingCiphertext === null) {
        if (existingSecret) return false
        await client.query(
          `INSERT INTO cloud_workflow_webhook_secrets (
             tenant_id, workflow_id, trigger_id, ciphertext, envelope_version,
             status, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            input.tenantId,
            input.workflowId,
            input.triggerId,
            input.ciphertext,
            input.envelopeVersion,
            targetStatus,
            migratedAt,
          ],
        )
      } else if (
        !existingSecret
        || String(existingSecret.ciphertext) !== input.expectedExistingCiphertext
        || Number(existingSecret.envelope_version) !== input.expectedExistingEnvelopeVersion
        || (targetStatus === 'active' && String(existingSecret.status) !== 'active')
      ) {
        return false
      } else {
        await client.query(
          `UPDATE cloud_workflow_webhook_secrets
           SET ciphertext = $4,
               envelope_version = $5,
               status = $6,
               updated_at = $7
           WHERE tenant_id = $1 AND workflow_id = $2 AND trigger_id = $3`,
          [
            input.tenantId,
            input.workflowId,
            input.triggerId,
            input.ciphertext,
            input.envelopeVersion,
            targetStatus,
            migratedAt,
          ],
        )
      }
      await client.query(
        `UPDATE cloud_workflows
         SET triggers = $3::jsonb,
             updated_at = GREATEST(updated_at, $4::timestamptz)
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [input.tenantId, input.workflowId, JSON.stringify(publicTriggers), migratedAt],
      )
      return true
    })
  }

  private async requireWorkflow(
    tenantId: string,
    workflowId: string,
    executor: PgExecutor = this.options.pool,
  ) {
    await this.options.requireTenant(tenantId, executor)
    const row = await this.maybeOne(
      'SELECT * FROM cloud_workflows WHERE tenant_id = $1 AND workflow_id = $2',
      [tenantId, workflowId],
      executor,
    )
    if (!row) throw new Error(`Unknown workflow ${workflowId}.`)
    return row
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
