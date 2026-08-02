import {
  generateChannelInteractionToken,
  hashChannelInteractionToken,
  verifyChannelInteractionTokenHash,
  type ChannelProviderId,
  type CreateChannelInteractionInput,
} from '../control-plane-store.ts'
import { ControlPlaneIdConflictError } from '../control-plane-errors.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import { channelInteractionFromRow } from '../postgres-domains/channels.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import { normalizeNullableText, normalizeText } from '../postgres-store-normalizers.ts'

const CHANNEL_TEXT_MAX_LENGTH = 256

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

async function assertPostgresChannelInteractionReferences(
  pool: PgExecutor,
  input: CreateChannelInteractionInput,
) {
  const relationship = await pool.query(
    `SELECT a.agent_id
     FROM headless_agents a
     JOIN cloud_orgs o
       ON o.org_id = $1
     JOIN cloud_sessions s
       ON s.tenant_id = o.tenant_id
      AND s.session_id = $3
     JOIN cloud_channel_session_bindings sb
       ON sb.org_id = $1
      AND sb.binding_id = $4
      AND sb.channel_binding_id = $5
      AND sb.agent_id = $2
      AND sb.session_id = $3
      AND sb.provider = $6
      AND sb.status = 'active'
     WHERE a.org_id = $1
       AND a.agent_id = $2`,
    [
      input.orgId,
      input.agentId,
      input.sessionId,
      input.sessionBindingId,
      input.channelBindingId,
      input.provider,
    ],
  )
  if (relationship.rows.length === 0) {
    throw new Error('Channel interaction references must belong to the same org, agent, and session binding.')
  }
}

export async function createPostgresChannelInteraction(
  pool: PgExecutor,
  input: CreateChannelInteractionInput,
) {
  const interactionId = normalizeText(input.interactionId, CHANNEL_TEXT_MAX_LENGTH, 'Channel interaction id')
  const plaintextToken = generateChannelInteractionToken({ interactionId, secret: input.tokenSecret })
  await assertPostgresChannelInteractionReferences(pool, input)
  const result = await pool.query(
    `INSERT INTO cloud_channel_interactions (
      interaction_id, org_id, agent_id, channel_binding_id, session_binding_id,
      session_id, provider, external_interaction_id,
      token_hash, kind, target_id, status, created_by_identity_id,
      expires_at, used_at, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, NULL, $14, $14)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      interactionId,
      input.orgId,
      input.agentId,
      input.channelBindingId,
      input.sessionBindingId,
      input.sessionId,
      normalizeProvider(input.provider),
      normalizeNullableText(input.externalInteractionId, CHANNEL_TEXT_MAX_LENGTH, 'External interaction id'),
      await hashChannelInteractionToken(plaintextToken),
      input.kind,
      normalizeText(input.targetId, CHANNEL_TEXT_MAX_LENGTH, 'Interaction target id'),
      null,
      input.expiresAt.toISOString(),
      (input.createdAt || new Date()).toISOString(),
    ],
  )
  if (!result.rows[0]) {
    const existing = await pool.query(
      `SELECT org_id FROM cloud_channel_interactions WHERE interaction_id = $1`,
      [interactionId],
    )
    if (existing.rows[0] && String(existing.rows[0].org_id) !== input.orgId) {
      throw new ControlPlaneIdConflictError('channel_interaction')
    }
    throw new Error(`Channel interaction ${interactionId} already exists.`)
  }
  return { interaction: channelInteractionFromRow(result.rows[0]), plaintextToken }
}

export async function findPendingPostgresChannelInteractionByToken(
  executor: PgExecutor,
  input: {
    orgId: string
    token: string
    now: string
    channelBindingIds?: readonly string[] | null
    lock?: boolean
  },
) {
  if (input.channelBindingIds?.length === 0) return null
  const candidates = await executor.query(
    `SELECT * FROM cloud_channel_interactions
     WHERE org_id = $1
       AND status = 'pending'
       AND expires_at > $3
       AND ($4::text[] IS NULL OR channel_binding_id = ANY($4::text[]))
       AND left($2, length('occi_' || interaction_id || '_')) = ('occi_' || interaction_id || '_')${input.lock ? '\n     FOR UPDATE' : ''}`,
    [input.orgId, input.token, input.now, input.channelBindingIds ? [...input.channelBindingIds] : null],
  )
  for (const row of candidates.rows) {
    if (await verifyChannelInteractionTokenHash(input.token, String(row.token_hash))) return row
  }
  return null
}

export async function findPendingPostgresChannelInteractionByExternal(
  executor: PgExecutor,
  input: {
    orgId: string
    provider: ChannelProviderId
    externalInteractionId: string
    now: string
    channelBindingIds?: readonly string[] | null
    lock?: boolean
  },
) {
  if (input.channelBindingIds?.length === 0) return null
  const candidates = await executor.query(
    `SELECT * FROM cloud_channel_interactions
     WHERE org_id = $1
       AND status = 'pending'
       AND expires_at > $4
       AND provider = $2
       AND external_interaction_id = $3
       AND ($5::text[] IS NULL OR channel_binding_id = ANY($5::text[]))
     LIMIT 2${input.lock ? '\n     FOR UPDATE' : ''}`,
    [
      input.orgId,
      input.provider,
      input.externalInteractionId,
      input.now,
      input.channelBindingIds ? [...input.channelBindingIds] : null,
    ],
  )
  return candidates.rows.length === 1 ? candidates.rows[0]! : null
}
