import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeText } from '../postgres-store-normalizers.ts'
import { headlessAgentFromRow } from '../postgres-domains/channels.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  CreateHeadlessAgentInput,
  RecordAuditEventInput,
  UpdateHeadlessAgentInput,
} from '../control-plane-store.ts'

// Headless-agent SQL domain extracted from postgres-control-plane-store.ts. Owns the
// gateway agent records (create / update / get / list) over the headless_agents
// table, with audit recording + the transaction runner arriving via the injected
// host. Behaviour-preserving; covered by the pglite + real-Postgres control-plane
// contract suites (createHeadlessAgent is exercised end-to-end).

const HEADLESS_AGENT_TEXT_MAX_LENGTH = 256

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresHeadlessAgentsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

export class PostgresHeadlessAgentsRepository {
  private readonly options: PostgresHeadlessAgentsRepositoryOptions

  constructor(options: PostgresHeadlessAgentsRepositoryOptions) {
    this.options = options
  }

  async createHeadlessAgent(input: CreateHeadlessAgentInput) {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.createdAt)
      const result = await client.query(
        `INSERT INTO headless_agents (
          agent_id, org_id, tenant_id, profile_name, name, status, managed,
          created_by_account_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (agent_id) DO NOTHING
         RETURNING *`,
        [
          normalizeText(input.agentId, HEADLESS_AGENT_TEXT_MAX_LENGTH, 'Headless agent id'),
          input.orgId,
          input.tenantId,
          normalizeText(input.profileName, HEADLESS_AGENT_TEXT_MAX_LENGTH, 'Headless agent profile'),
          normalizeText(input.name, HEADLESS_AGENT_TEXT_MAX_LENGTH, 'Headless agent name'),
          input.status || 'active',
          input.managed === true,
          input.createdByAccountId || null,
          now,
        ],
      )
      const row = result.rows[0] || await this.one(
        `SELECT * FROM headless_agents WHERE agent_id = $1 AND org_id = $2`,
        [input.agentId, input.orgId],
        client,
      )
      const agent = headlessAgentFromRow(row)
      if (result.rows[0]) {
        await this.options.recordAuditEvent(client, {
          orgId: agent.orgId,
          accountId: agent.createdByAccountId,
          actorType: 'system',
          actorId: 'headless_agent.create',
          eventType: 'headless_agent.created',
          targetType: 'headless_agent',
          targetId: agent.agentId,
          metadata: { name: agent.name, profileName: agent.profileName, managed: agent.managed },
          createdAt: input.createdAt,
        })
      }
      return agent
    })
  }

  async updateHeadlessAgent(input: UpdateHeadlessAgentInput) {
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE headless_agents
         SET profile_name = CASE WHEN $3::boolean THEN $4 ELSE profile_name END,
             name = CASE WHEN $5::boolean THEN $6 ELSE name END,
             status = COALESCE($7, status),
             managed = CASE WHEN $8::boolean THEN $9 ELSE managed END,
             updated_at = $10
         WHERE org_id = $1 AND agent_id = $2
         RETURNING *`,
        [
          input.orgId,
          input.agentId,
          input.profileName !== undefined,
          input.profileName === undefined ? null : normalizeText(input.profileName, HEADLESS_AGENT_TEXT_MAX_LENGTH, 'Headless agent profile'),
          input.name !== undefined,
          input.name === undefined ? null : normalizeText(input.name, HEADLESS_AGENT_TEXT_MAX_LENGTH, 'Headless agent name'),
          input.status || null,
          input.managed !== undefined,
          input.managed ?? null,
          nowIso(input.updatedAt),
        ],
      )
      if (!result.rows[0]) return null
      const agent = headlessAgentFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'headless_agent.updated',
        targetType: 'headless_agent',
        targetId: agent.agentId,
        metadata: {
          profileName: agent.profileName,
          name: agent.name,
          status: agent.status,
          managed: agent.managed,
        },
        createdAt: input.updatedAt,
      })
      return agent
    })
  }

  async getHeadlessAgent(orgId: string, agentId: string) {
    const row = await this.maybeOne(`SELECT * FROM headless_agents WHERE org_id = $1 AND agent_id = $2`, [orgId, agentId])
    return row ? headlessAgentFromRow(row) : null
  }

  async listHeadlessAgents(orgId: string) {
    const result = await this.options.pool.query(
      `SELECT * FROM headless_agents WHERE org_id = $1 ORDER BY updated_at DESC, agent_id`,
      [orgId],
    )
    return result.rows.map(headlessAgentFromRow)
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

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
