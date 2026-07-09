import { redactOperationalText } from '../operational-text-redaction.ts'
import {
  ControlPlaneQuotaExceededError,
  type AckChannelDeliveryInput,
  type ClaimChannelDeliveryInput,
  type ConsumeUsageQuotaInput,
  type CreateChannelDeliveryInput,
  type ListChannelDeliveriesInput,
  type QuotaConsumptionRecord,
} from '../control-plane-store.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import { channelDeliveryFromRow } from '../postgres-domains/channels.ts'
import { jsonRecord, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresChannelDeliveriesRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  consumeUsageQuota(executor: PgExecutor, input: ConsumeUsageQuotaInput): Promise<QuotaConsumptionRecord>
}

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_DELIVERY_ERROR_MAX_LENGTH = 1024

export class PostgresChannelDeliveriesRepository {
  private readonly options: PostgresChannelDeliveriesRepositoryOptions

  constructor(options: PostgresChannelDeliveriesRepositoryOptions) {
    this.options = options
  }

  async create(input: CreateChannelDeliveryInput) {
    const now = nowIso(input.createdAt)
    const provider = normalizeProvider(input.provider)
    const relationship = await maybeOne(
      this.options.pool,
      `SELECT b.binding_id
       FROM headless_agents a
       JOIN cloud_channel_bindings b
         ON b.binding_id = $3
        AND b.org_id = $1
        AND b.agent_id = a.agent_id
        AND b.provider = $5
       LEFT JOIN cloud_channel_session_bindings sb
         ON sb.binding_id = $4
       WHERE a.org_id = $1
         AND a.agent_id = $2
         AND ($4::text IS NULL OR (
           sb.org_id = $1
           AND sb.agent_id = a.agent_id
           AND sb.channel_binding_id = b.binding_id
           AND sb.provider = $5
         ))`,
      [input.orgId, input.agentId, input.channelBindingId, input.sessionBindingId || null, provider],
    )
    if (!relationship) throw new Error('Channel delivery references must belong to the same org, agent, provider, binding, and session binding.')
    const result = await this.options.pool.query(
      `INSERT INTO cloud_channel_deliveries (
        delivery_id, org_id, agent_id, channel_binding_id, session_binding_id,
        provider, target, event_type, payload, status, attempt_count,
        claimed_by, last_claimed_by, claim_expires_at, next_attempt_at, last_error, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, 0, NULL, NULL, NULL, $11, NULL, $12, $12)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING *`,
      [
        input.deliveryId,
        input.orgId,
        input.agentId,
        input.channelBindingId,
        input.sessionBindingId || null,
        provider,
        JSON.stringify(normalizeRecord(input.target, 'Channel delivery target')),
        normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery event type'),
        JSON.stringify(normalizeRecord(input.payload, 'Channel delivery payload')),
        input.status || 'pending',
        (input.nextAttemptAt || input.createdAt || new Date()).toISOString(),
        now,
      ],
    )
    const row = result.rows[0] || await one(
      this.options.pool,
      `SELECT * FROM cloud_channel_deliveries WHERE org_id = $1 AND delivery_id = $2`,
      [input.orgId, input.deliveryId],
    )
    return channelDeliveryFromRow(row)
  }

  async list(input: ListChannelDeliveriesInput) {
    if (input.channelBindingIds?.length === 0) return []
    const conditions = ['org_id = $1']
    const values: unknown[] = [input.orgId]
    if (input.deliveryId) {
      values.push(input.deliveryId)
      conditions.push(`delivery_id = $${values.length}`)
    }
    if (input.status) {
      values.push(input.status)
      conditions.push(`status = $${values.length}`)
    }
    if (input.channelBindingId) {
      values.push(input.channelBindingId)
      conditions.push(`channel_binding_id = $${values.length}`)
    }
    if (input.channelBindingIds) {
      values.push([...input.channelBindingIds])
      conditions.push(`channel_binding_id = ANY($${values.length}::text[])`)
    }
    if (input.lastClaimedBy) {
      values.push(input.lastClaimedBy)
      conditions.push(`last_claimed_by = $${values.length}`)
    }
    values.push(Math.max(1, Math.min(200, input.limit || 50)))
    const limitIndex = values.length
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_channel_deliveries
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $${limitIndex}`,
      values,
    )
    return result.rows.map(channelDeliveryFromRow)
  }

  async claimNext(input: ClaimChannelDeliveryInput) {
    if (input.channelBindingIds?.length === 0) return null
    return this.options.withTransaction(async (client) => {
      const now = input.now || new Date()
      const selected = await maybeOne(
        client,
        `SELECT * FROM cloud_channel_deliveries
         WHERE org_id = $1
           AND ($3::text[] IS NULL OR channel_binding_id = ANY($3::text[]))
           AND (
             (status = 'pending' AND next_attempt_at <= $2)
             OR (status = 'failed' AND next_attempt_at <= $2)
             OR (status = 'claimed' AND claim_expires_at <= $2)
           )
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [input.orgId, now.toISOString(), input.channelBindingIds?.length ? [...input.channelBindingIds] : null],
      )
      if (!selected) return null
      if (input.quota) {
        const quota = await this.options.consumeUsageQuota(client, {
          ...input.quota,
          orgId: input.orgId,
          now,
        })
        if (!quota.allowed) {
          throw new ControlPlaneQuotaExceededError({
            message: 'Gateway delivery quota exceeded.',
            policyCode: quota.policyCode || 'quota.gateway_deliveries_per_hour_exceeded',
            retryAfterMs: quota.retryAfterMs,
            limit: quota.limit,
            used: quota.used,
            resetAt: quota.resetAt,
          })
        }
      }
      const result = await client.query(
        `UPDATE cloud_channel_deliveries
         SET status = 'claimed',
             claimed_by = $2,
             last_claimed_by = COALESCE($5::text, $2),
             claim_expires_at = $3,
             attempt_count = attempt_count + 1,
             updated_at = $4
         WHERE delivery_id = $1
         RETURNING *`,
        [
          String(selected.delivery_id),
          normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery claimant'),
          new Date(now.getTime() + (input.ttlMs || 30_000)).toISOString(),
          now.toISOString(),
          input.lastClaimedBy ? normalizeText(input.lastClaimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery owner') : null,
        ],
      )
      return channelDeliveryFromRow(result.rows[0]!)
    })
  }

  async ack(input: AckChannelDeliveryInput) {
    if (input.channelBindingIds?.length === 0) return null
    const result = await this.options.pool.query(
      `UPDATE cloud_channel_deliveries
       SET status = $3,
           claimed_by = NULL,
           last_claimed_by = COALESCE($8, last_claimed_by),
           claim_expires_at = NULL,
           last_error = $4,
           next_attempt_at = $5,
           updated_at = $6
       WHERE org_id = $1
         AND delivery_id = $2
         AND ($9::text[] IS NULL OR channel_binding_id = ANY($9::text[]))
         AND ($7::text IS NULL OR claimed_by = $7)
         AND (
           $8::text IS NULL
           OR last_claimed_by = $8
         )
       RETURNING *`,
      [
        input.orgId,
        input.deliveryId,
        input.status,
        input.lastError ? redactOperationalText(input.lastError, CHANNEL_DELIVERY_ERROR_MAX_LENGTH, 'Delivery error') : null,
        (input.nextAttemptAt || input.updatedAt || new Date()).toISOString(),
        nowIso(input.updatedAt),
        input.claimedBy || null,
        input.lastClaimedBy || null,
        input.channelBindingIds?.length ? [...input.channelBindingIds] : null,
      ],
    )
    return result.rows[0] ? channelDeliveryFromRow(result.rows[0]) : null
  }

  // Retention: delete up to `limit` terminal (delivered / dead-lettered) deliveries
  // older than the cutoff, oldest-first, and return how many were removed. Bounded
  // by ctid-keyed subselect so a single sweep batch never locks the whole table.
  async pruneTerminal(input: { olderThan: Date; limit: number }): Promise<number> {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const result = await this.options.pool.query(
      `DELETE FROM cloud_channel_deliveries
       WHERE ctid IN (
         SELECT ctid FROM cloud_channel_deliveries
         WHERE status IN ('sent', 'dead')
           AND updated_at < $1
         ORDER BY updated_at
         LIMIT $2
       )
       RETURNING delivery_id`,
      [input.olderThan.toISOString(), limit],
    )
    return result.rows.length
  }
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

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}


function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = jsonRecord(value)
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
