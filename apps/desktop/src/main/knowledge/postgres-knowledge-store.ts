import { randomUUID } from 'node:crypto'
import type {
  KnowledgePage,
  KnowledgePageVersion,
  KnowledgeProposal,
  KnowledgeProposalStatus,
  KnowledgeSnapshotPayload,
  KnowledgeSpace,
} from '@open-cowork/shared'
import { knowledgeRoleCanRead } from '@open-cowork/shared'
import type {
  KnowledgeCreateProposalInput,
  KnowledgeCreateSpaceInput,
  KnowledgeReviewActionInput,
  KnowledgeStore,
  KnowledgeStoreListOptions,
  KnowledgeStoreWriteOptions,
} from './knowledge-store-contract.ts'
import {
  KNOWLEDGE_MAX_TEXT_BYTES,
  KNOWLEDGE_MAX_TITLE_BYTES,
  type KnowledgeDbRow,
  assertCanPropose,
  assertCanReview,
  assertReadable,
  calculateDiffStats,
  graphFrom,
  knowledgeJsonString,
  knowledgeRevisionFor,
  knowledgeSnapshotLimit,
  knowledgeWorkspaceSeed,
  normalizeBody,
  normalizeKnowledgeSpaceInput,
  normalizeLinks,
  optionalString,
  requiredString,
  toPage,
  toProposal,
  toSpace,
  toVersion,
  workspaceIdFrom,
} from './knowledge-store.ts'

// Narrow pg-compatible pool shape (node-postgres / pglite). Mirrors the shape
// the Postgres control-plane store accepts so the same injected `pool` works.
type PgQueryRow = Record<string, unknown>
type PgQueryResult<Row extends PgQueryRow = PgQueryRow> = { rows: Row[]; rowCount?: number }
type PgExecutor = {
  query<Row extends PgQueryRow = PgQueryRow>(text: string, values?: unknown[]): Promise<PgQueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }
export type PostgresKnowledgePool = PgExecutor & {
  connect(): Promise<PgClient>
  end(): Promise<void>
}

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

/**
 * A {@link KnowledgeStore} backed by PostgreSQL for multi-replica cloud serving.
 *
 * Behavioral parity with the SQLite store is achieved by reusing the SAME pure
 * helpers — diff stats, graph derivation, validators, RBAC asserts, the seed,
 * the revision hash, and the row→domain mappers. ONLY the SQL differs.
 *
 * Tenant isolation is fail-closed and enforced in SQL: `workspace_id` is the
 * leading column of every table's PRIMARY KEY and appears as a parameterized
 * `workspace_id = $N` predicate in EVERY read and write. No input is ever
 * interpolated into a SQL string — all values flow through positional
 * parameters — so a request scoped to workspace A can never observe or mutate
 * workspace B's spaces, pages, versions, or proposals.
 */
class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly pool: PostgresKnowledgePool
  private readonly ownsPool: boolean

  constructor(pool: PostgresKnowledgePool, ownsPool: boolean) {
    this.pool = pool
    this.ownsPool = ownsPool
  }

  async close() {
    if (this.ownsPool) await this.pool.end()
  }

  private async withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // Seed the canonical Company OS space + Operating model page on first touch
  // for a workspace. Uses ON CONFLICT DO NOTHING so a concurrent seed (another
  // replica racing the same first request) is harmless and idempotent.
  private async ensureWorkspaceSeed(executor: PgExecutor, workspaceId: string) {
    const count = await executor.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM cloud_knowledge_spaces WHERE workspace_id = $1',
      [workspaceId],
    )
    if (Number(count.rows[0]?.count || 0) > 0) return

    const seed = knowledgeWorkspaceSeed(workspaceId)
    const { at, spaceId, pageId, versionId, space, page } = seed
    const linksJson = knowledgeJsonString(page.links, 'Knowledge links')
    const bodyJson = knowledgeJsonString(page.body, 'Knowledge body')

    await executor.query(
      `INSERT INTO cloud_knowledge_spaces (workspace_id, id, name, icon, hue, visibility, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, spaceId, space.name, space.icon, space.hue, space.visibility, space.role, at],
    )
    await executor.query(
      `INSERT INTO cloud_knowledge_pages (workspace_id, id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $6)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, pageId, spaceId, page.title, page.updatedBy, at, page.version, page.revision, linksJson, bodyJson],
    )
    await executor.query(
      `INSERT INTO cloud_knowledge_page_versions (workspace_id, id, page_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, versionId, pageId, spaceId, page.title, page.updatedBy, at, page.version, page.revision, linksJson, bodyJson],
    )
  }

  private async getSpace(executor: PgExecutor, workspaceId: string, spaceId: string): Promise<KnowledgeSpace | null> {
    const result = await executor.query<KnowledgeDbRow>(
      'SELECT * FROM cloud_knowledge_spaces WHERE workspace_id = $1 AND id = $2',
      [workspaceId, spaceId],
    )
    return result.rows[0] ? toSpace(result.rows[0]) : null
  }

  private async getPage(executor: PgExecutor, workspaceId: string, pageId: string): Promise<KnowledgePage | null> {
    const result = await executor.query<KnowledgeDbRow>(
      'SELECT * FROM cloud_knowledge_pages WHERE workspace_id = $1 AND id = $2',
      [workspaceId, pageId],
    )
    return result.rows[0] ? toPage(result.rows[0]) : null
  }

  private async getPageByTitle(executor: PgExecutor, workspaceId: string, spaceId: string, title: string): Promise<KnowledgePage | null> {
    const result = await executor.query<KnowledgeDbRow>(
      `SELECT * FROM cloud_knowledge_pages
       WHERE workspace_id = $1 AND space_id = $2 AND lower(title) = lower($3)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [workspaceId, spaceId, title],
    )
    return result.rows[0] ? toPage(result.rows[0]) : null
  }

  private async getProposal(executor: PgExecutor, workspaceId: string, proposalId: string): Promise<KnowledgeProposal | null> {
    const result = await executor.query<KnowledgeDbRow>(
      'SELECT * FROM cloud_knowledge_proposals WHERE workspace_id = $1 AND id = $2',
      [workspaceId, proposalId],
    )
    return result.rows[0] ? toProposal(result.rows[0]) : null
  }

  async listSnapshot(workspaceIdInput: string, options: KnowledgeStoreListOptions = {}): Promise<KnowledgeSnapshotPayload> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      const limit = knowledgeSnapshotLimit(options.limit)
      const spaceId = options.spaceId || null
      const spaceRows = (spaceId
        ? await client.query<KnowledgeDbRow>(
          'SELECT * FROM cloud_knowledge_spaces WHERE workspace_id = $1 AND id = $2 ORDER BY name LIMIT $3',
          [workspaceId, spaceId, limit + 1],
        )
        : await client.query<KnowledgeDbRow>(
          'SELECT * FROM cloud_knowledge_spaces WHERE workspace_id = $1 ORDER BY name LIMIT $2',
          [workspaceId, limit + 1],
        )).rows
      const spaces = spaceRows.map(toSpace).filter((space) => knowledgeRoleCanRead(space.role))
      const boundedSpaces = spaces.slice(0, limit)
      const spaceIds = new Set(boundedSpaces.map((space) => space.id))
      const pageRows = (spaceId
        ? await client.query<KnowledgeDbRow>(
          'SELECT * FROM cloud_knowledge_pages WHERE workspace_id = $1 AND space_id = $2 ORDER BY updated_at DESC, title LIMIT $3',
          [workspaceId, spaceId, limit + 1],
        )
        : await client.query<KnowledgeDbRow>(
          'SELECT * FROM cloud_knowledge_pages WHERE workspace_id = $1 ORDER BY updated_at DESC, title LIMIT $2',
          [workspaceId, limit + 1],
        )).rows
      const pages = pageRows.slice(0, limit).map(toPage).filter((page) => spaceIds.has(page.spaceId) && (!spaceId || page.spaceId === spaceId))
      for (const space of boundedSpaces) assertReadable(space)
      const proposalRows = (spaceId
        ? await client.query<KnowledgeDbRow>(
          `SELECT * FROM cloud_knowledge_proposals
           WHERE workspace_id = $1 AND space_id = $2 AND status = 'pending'
           ORDER BY created_at DESC
           LIMIT $3`,
          [workspaceId, spaceId, limit + 1],
        )
        : await client.query<KnowledgeDbRow>(
          `SELECT * FROM cloud_knowledge_proposals
           WHERE workspace_id = $1 AND status = 'pending'
           ORDER BY created_at DESC
           LIMIT $2`,
          [workspaceId, limit + 1],
        )).rows
      const proposals = proposalRows.slice(0, limit).map(toProposal).filter((proposal) => spaceIds.has(proposal.spaceId))
      const truncated = spaceRows.length > limit || pageRows.length > limit || proposalRows.length > limit
      return {
        spaces: boundedSpaces,
        pages,
        proposals,
        graph: graphFrom(boundedSpaces, pages),
        limit,
        truncated,
      }
    })
  }

  async listPageHistory(workspaceIdInput: string, pageIdInput: string, options: KnowledgeStoreListOptions = {}): Promise<KnowledgePageVersion[]> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    const limit = knowledgeSnapshotLimit(options.limit)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      const page = await this.getPage(client, workspaceId, requiredString(pageIdInput, 'Knowledge page id', 512))
      if (!page) return []
      const space = await this.getSpace(client, workspaceId, page.spaceId)
      if (!space) return []
      assertReadable(space)
      const result = await client.query<KnowledgeDbRow>(
        `SELECT * FROM cloud_knowledge_page_versions
         WHERE workspace_id = $1 AND page_id = $2
         ORDER BY version DESC
         LIMIT $3`,
        [workspaceId, page.id, limit],
      )
      return result.rows.map(toVersion)
    })
  }

  async createSpace(workspaceIdInput: string, input: KnowledgeCreateSpaceInput, options: KnowledgeStoreWriteOptions = {}): Promise<KnowledgeSpace> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      const space = normalizeKnowledgeSpaceInput(input, options)
      const existing = await client.query<KnowledgeDbRow>(
        'SELECT id FROM cloud_knowledge_spaces WHERE workspace_id = $1 AND id = $2',
        [workspaceId, space.id],
      )
      if (existing.rows[0]) throw new Error('Knowledge space already exists.')
      const at = nowIso(options.now)
      await client.query(
        `INSERT INTO cloud_knowledge_spaces (workspace_id, id, name, icon, hue, visibility, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [workspaceId, space.id, space.name, space.icon, space.hue, space.visibility, space.role, at],
      )
      const created = await this.getSpace(client, workspaceId, space.id)
      if (!created) throw new Error('Knowledge space was not created.')
      return created
    })
  }

  async getSpaceDetail(workspaceIdInput: string, spaceId: string): Promise<KnowledgeSpace | null> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      return this.getSpace(client, workspaceId, spaceId)
    })
  }

  async createProposal(workspaceIdInput: string, input: KnowledgeCreateProposalInput, options: KnowledgeStoreWriteOptions = {}): Promise<KnowledgeProposal> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      const spaceId = requiredString(input.spaceId, 'Knowledge space id', 512)
      const space = await this.getSpace(client, workspaceId, spaceId)
      if (!space) throw new Error('Knowledge space was not found.')
      assertCanPropose(space)
      const pageTitle = requiredString(input.pageTitle, 'Knowledge page title', KNOWLEDGE_MAX_TITLE_BYTES)
      const page = input.pageId
        ? await this.getPage(client, workspaceId, input.pageId)
        : await this.getPageByTitle(client, workspaceId, spaceId, pageTitle)
      if (input.pageId && !page) throw new Error('Knowledge page was not found.')
      if (page && page.spaceId !== spaceId) throw new Error('Knowledge page belongs to a different space.')
      const body = normalizeBody(input.body)
      const links = normalizeLinks(input.links)
      const diff = calculateDiffStats(page, body)
      const at = nowIso(options.now)
      const id = options.id || `proposal:${randomUUID()}`
      await client.query(
        `INSERT INTO cloud_knowledge_proposals (workspace_id, id, space_id, page_id, page_title, by_name, created_at, summary, add_count, del_count, status, reviewed_at, reviewed_by, links_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NULL, NULL, $11, $12)`,
        [
          workspaceId,
          id,
          spaceId,
          page?.id || null,
          pageTitle,
          optionalString(input.by, 'Knowledge proposal author', KNOWLEDGE_MAX_TITLE_BYTES) || 'you',
          at,
          requiredString(input.summary, 'Knowledge proposal summary', KNOWLEDGE_MAX_TEXT_BYTES),
          diff.add,
          diff.del,
          knowledgeJsonString(links, 'Knowledge proposal links'),
          knowledgeJsonString(body, 'Knowledge proposal body'),
        ],
      )
      const proposal = await this.getProposal(client, workspaceId, id)
      if (!proposal) throw new Error('Knowledge proposal was not created.')
      return proposal
    })
  }

  private async updateProposalStatus(
    client: PgExecutor,
    workspaceId: string,
    proposal: KnowledgeProposal,
    status: KnowledgeProposalStatus,
    input: KnowledgeReviewActionInput | undefined,
    at: string,
  ): Promise<KnowledgeProposal> {
    await client.query(
      `UPDATE cloud_knowledge_proposals
       SET status = $1, reviewed_at = $2, reviewed_by = $3
       WHERE workspace_id = $4 AND id = $5`,
      [
        status,
        at,
        optionalString(input?.reviewedBy, 'Knowledge reviewer', KNOWLEDGE_MAX_TITLE_BYTES) || 'you',
        workspaceId,
        proposal.id,
      ],
    )
    const updated = await this.getProposal(client, workspaceId, proposal.id)
    if (!updated) throw new Error('Knowledge proposal was not found after review.')
    return updated
  }

  async acceptProposal(
    workspaceIdInput: string,
    proposalIdInput: string,
    input: KnowledgeReviewActionInput = {},
    options: KnowledgeStoreWriteOptions = {},
  ): Promise<{ proposal: KnowledgeProposal; page: KnowledgePageVersion }> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      const proposal = await this.getProposal(client, workspaceId, requiredString(proposalIdInput, 'Knowledge proposal id', 512))
      if (!proposal) throw new Error('Knowledge proposal was not found.')
      if (proposal.status !== 'pending') throw new Error('Knowledge proposal is not pending.')
      const space = await this.getSpace(client, workspaceId, proposal.spaceId)
      if (!space) throw new Error('Knowledge space was not found.')
      assertCanReview(space)
      const existing = proposal.pageId
        ? await this.getPage(client, workspaceId, proposal.pageId)
        : await this.getPageByTitle(client, workspaceId, proposal.spaceId, proposal.pageTitle)
      const at = nowIso(options.now)
      const pageId = existing?.id || `page:${randomUUID()}`
      const version = (existing?.version || 0) + 1
      const revision = knowledgeRevisionFor({ pageId, version, body: proposal.body, links: proposal.links })
      const linksJson = knowledgeJsonString(proposal.links, 'Knowledge links')
      const bodyJson = knowledgeJsonString(proposal.body, 'Knowledge body')
      if (existing) {
        await client.query(
          `UPDATE cloud_knowledge_pages
           SET title = $1, updated_by = $2, updated_at = $3, version = $4, revision = $5, links_json = $6, body_json = $7
           WHERE workspace_id = $8 AND id = $9`,
          [proposal.pageTitle, proposal.by, at, version, revision, linksJson, bodyJson, workspaceId, pageId],
        )
      } else {
        await client.query(
          `INSERT INTO cloud_knowledge_pages (workspace_id, id, space_id, title, updated_by, updated_at, version, revision, links_json, body_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $6)`,
          [workspaceId, pageId, proposal.spaceId, proposal.pageTitle, proposal.by, at, version, revision, linksJson, bodyJson],
        )
      }
      const versionId = `version:${pageId}:${version}`
      await client.query(
        `INSERT INTO cloud_knowledge_page_versions (workspace_id, id, page_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [workspaceId, versionId, pageId, proposal.spaceId, proposal.pageTitle, proposal.by, at, version, revision, proposal.id, linksJson, bodyJson],
      )
      const reviewed = await this.updateProposalStatus(client, workspaceId, proposal, 'accepted', input, at)
      const created = await client.query<KnowledgeDbRow>(
        'SELECT * FROM cloud_knowledge_page_versions WHERE workspace_id = $1 AND id = $2',
        [workspaceId, versionId],
      )
      if (!created.rows[0]) throw new Error('Knowledge page version was not created.')
      return { proposal: reviewed, page: toVersion(created.rows[0]) }
    })
  }

  async declineProposal(
    workspaceIdInput: string,
    proposalIdInput: string,
    input: KnowledgeReviewActionInput = {},
    options: KnowledgeStoreWriteOptions = {},
  ): Promise<KnowledgeProposal> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      const proposal = await this.getProposal(client, workspaceId, requiredString(proposalIdInput, 'Knowledge proposal id', 512))
      if (!proposal) throw new Error('Knowledge proposal was not found.')
      if (proposal.status !== 'pending') throw new Error('Knowledge proposal is not pending.')
      const space = await this.getSpace(client, workspaceId, proposal.spaceId)
      if (!space) throw new Error('Knowledge space was not found.')
      assertCanReview(space)
      return this.updateProposalStatus(client, workspaceId, proposal, 'declined', input, nowIso(options.now))
    })
  }

  async restoreVersion(
    workspaceIdInput: string,
    pageIdInput: string,
    versionIdInput: string,
    input: KnowledgeReviewActionInput = {},
    options: KnowledgeStoreWriteOptions = {},
  ): Promise<{ page: KnowledgePageVersion }> {
    const workspaceId = workspaceIdFrom(workspaceIdInput)
    return this.withTransaction(async (client) => {
      await this.ensureWorkspaceSeed(client, workspaceId)
      const page = await this.getPage(client, workspaceId, requiredString(pageIdInput, 'Knowledge page id', 512))
      if (!page) throw new Error('Knowledge page was not found.')
      const space = await this.getSpace(client, workspaceId, page.spaceId)
      if (!space) throw new Error('Knowledge space was not found.')
      // Restoring publishes a new authoritative page version, so it carries the
      // same Maintainer-only authority as accepting a proposal.
      assertCanReview(space)
      const targetId = requiredString(versionIdInput, 'Knowledge version id', 512)
      const targetResult = await client.query<KnowledgeDbRow>(
        'SELECT * FROM cloud_knowledge_page_versions WHERE workspace_id = $1 AND page_id = $2 AND id = $3',
        [workspaceId, page.id, targetId],
      )
      if (!targetResult.rows[0]) throw new Error('Knowledge page version was not found.')
      const target = toVersion(targetResult.rows[0])
      if (target.version === page.version) {
        throw new Error('Knowledge page version is already the current version.')
      }
      // Restore is non-destructive: it appends a fresh version whose content is a
      // copy of the chosen historical version, preserving the full audit trail.
      const at = nowIso(options.now)
      const version = page.version + 1
      const restoredBy = optionalString(input.reviewedBy, 'Knowledge reviewer', KNOWLEDGE_MAX_TITLE_BYTES) || 'you'
      const revision = knowledgeRevisionFor({ pageId: page.id, version, body: target.body, links: target.links })
      const linksJson = knowledgeJsonString(target.links, 'Knowledge links')
      const bodyJson = knowledgeJsonString(target.body, 'Knowledge body')
      await client.query(
        `UPDATE cloud_knowledge_pages
         SET title = $1, updated_by = $2, updated_at = $3, version = $4, revision = $5, links_json = $6, body_json = $7
         WHERE workspace_id = $8 AND id = $9`,
        [target.title, restoredBy, at, version, revision, linksJson, bodyJson, workspaceId, page.id],
      )
      const newVersionId = `version:${page.id}:${version}`
      await client.query(
        `INSERT INTO cloud_knowledge_page_versions (workspace_id, id, page_id, space_id, title, updated_by, updated_at, version, revision, proposal_id, links_json, body_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11)`,
        [workspaceId, newVersionId, page.id, page.spaceId, target.title, restoredBy, at, version, revision, linksJson, bodyJson],
      )
      const created = await client.query<KnowledgeDbRow>(
        'SELECT * FROM cloud_knowledge_page_versions WHERE workspace_id = $1 AND id = $2',
        [workspaceId, newVersionId],
      )
      if (!created.rows[0]) throw new Error('Knowledge page version was not created.')
      return { page: toVersion(created.rows[0]) }
    })
  }
}

/**
 * Construct a Postgres-backed {@link KnowledgeStore}. The caller injects a
 * pg-compatible `pool` (node-postgres in production, pglite in tests). The
 * `cloud_knowledge_*` tables must already exist — run the
 * `016_cloud_knowledge` migration (registered in CLOUD_CONTROL_PLANE_MIGRATIONS)
 * before first use. Set `ownsPool: true` to have `close()` end the pool.
 */
export function createPostgresKnowledgeStore(
  pool: PostgresKnowledgePool,
  options: { ownsPool?: boolean } = {},
): KnowledgeStore {
  return new PostgresKnowledgeStore(pool, options.ownsPool === true)
}
