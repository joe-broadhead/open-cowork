import { createHash } from 'node:crypto'
import type {
  ClaimChannelProviderEventInput,
  CompleteChannelProviderEventInput,
} from '../control-plane-store.ts'
import { normalizeChannelProviderId } from '../channel-provider-utils.ts'
import { channelProviderEventFromRow } from '../postgres-domains/channels.ts'
import { jsonRecord, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresChannelProviderEventsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
}

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_PROVIDER_EVENT_ERROR_MAX_LENGTH = 1024

export class PostgresChannelProviderEventsRepository {
  private readonly options: PostgresChannelProviderEventsRepositoryOptions

  constructor(options: PostgresChannelProviderEventsRepositoryOptions) {
    this.options = options
  }

  async claim(input: ClaimChannelProviderEventInput) {
    return this.options.withTransaction(async (client) => {
      const now = input.now || new Date()
      const nowIsoValue = now.toISOString()
      const ttlMs = Math.max(1, Math.min(input.ttlMs || 5 * 60_000, 60 * 60_000))
      const provider = normalizeChannelProviderId(input.provider)
      const providerInstanceId = normalizeText(input.providerInstanceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider instance id')
      const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel external workspace id')
      const providerEventId = normalizeText(input.providerEventId, CHANNEL_TEXT_MAX_LENGTH, 'Provider event id')
      const eventType = normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider event type')
      if (!['message', 'command', 'interaction'].includes(eventType)) throw new Error(`Unsupported channel provider event type ${eventType}.`)
      const eventId = normalizeText(
        input.eventId || stableId('channel_provider_event', input.orgId, provider, providerInstanceId, externalWorkspaceId || '', eventType, providerEventId),
        CHANNEL_TEXT_MAX_LENGTH,
        'Channel provider event id',
      )
      const metadata = JSON.stringify(normalizeRecord(input.metadata || {}, 'Channel provider event metadata'))
      const insert = await client.query(
        `INSERT INTO cloud_channel_provider_events (
          event_id, org_id, provider, provider_instance_id, external_workspace_id,
          provider_event_id, event_type, status, claimed_by, claim_expires_at,
          attempt_count, retryable, last_error, metadata, processed_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, 1, true, NULL, $10::jsonb, NULL, $11, $11)
        ON CONFLICT DO NOTHING
        RETURNING *`,
        [
          eventId,
          input.orgId,
          provider,
          providerInstanceId,
          externalWorkspaceId,
          providerEventId,
          eventType,
          normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant'),
          new Date(now.getTime() + ttlMs).toISOString(),
          metadata,
          nowIsoValue,
        ],
      )
      if (insert.rows[0]) {
        return { event: channelProviderEventFromRow(insert.rows[0]), claimed: true, duplicate: false }
      }

      const existing = await one(
        client,
        `SELECT *
         FROM cloud_channel_provider_events
         WHERE org_id = $1
           AND provider = $2
           AND provider_instance_id = $3
           AND COALESCE(external_workspace_id, '') = COALESCE($4::text, '')
           AND event_type = $5
           AND provider_event_id = $6
         FOR UPDATE`,
        [input.orgId, provider, providerInstanceId, externalWorkspaceId, eventType, providerEventId],
      )
      const current = channelProviderEventFromRow(existing)
      const claimExpired = current.status === 'processing'
        && current.claimExpiresAt !== null
        && new Date(current.claimExpiresAt).getTime() <= now.getTime()
      const canReclaim = current.status === 'received'
        || (current.status === 'failed' && current.retryable)
        || claimExpired
      if (!canReclaim) {
        const touched = await client.query(
          `UPDATE cloud_channel_provider_events
           SET updated_at = $2
           WHERE event_id = $1
           RETURNING *`,
          [current.eventId, nowIsoValue],
        )
        return { event: channelProviderEventFromRow(touched.rows[0]), claimed: false, duplicate: true }
      }

      const reclaimed = await client.query(
        `UPDATE cloud_channel_provider_events
         SET provider = $3,
             status = 'processing',
             claimed_by = $4,
             claim_expires_at = $5,
             attempt_count = attempt_count + 1,
             retryable = true,
             last_error = NULL,
             metadata = $6::jsonb,
             processed_at = NULL,
             updated_at = $7
         WHERE event_id = $1
           AND org_id = $2
         RETURNING *`,
        [
          current.eventId,
          input.orgId,
          provider,
          normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant'),
          new Date(now.getTime() + ttlMs).toISOString(),
          metadata,
          nowIsoValue,
        ],
      )
      return { event: channelProviderEventFromRow(reclaimed.rows[0]), claimed: true, duplicate: false }
    })
  }

  async complete(input: CompleteChannelProviderEventInput) {
    const updatedAt = nowIso(input.updatedAt)
    const result = await this.options.pool.query(
      `UPDATE cloud_channel_provider_events
       SET status = $3,
           claimed_by = NULL,
           claim_expires_at = NULL,
           retryable = CASE WHEN $3 = 'failed' THEN $4 ELSE false END,
           last_error = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END,
           processed_at = CASE WHEN $3 = 'processed' THEN $6::timestamptz ELSE processed_at END,
           updated_at = $6
       WHERE org_id = $1
         AND event_id = $2
         AND claimed_by = $7
       RETURNING *`,
      [
        input.orgId,
        input.eventId,
        input.status,
        input.status === 'failed' ? input.retryable !== false : false,
        input.status === 'failed' && input.lastError
          ? redactOperationalText(input.lastError, CHANNEL_PROVIDER_EVENT_ERROR_MAX_LENGTH, 'Provider event error')
          : null,
        updatedAt,
        normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant'),
      ],
    )
    return result.rows[0] ? channelProviderEventFromRow(result.rows[0]) : null
  }
}

async function one<Row extends QueryRow = QueryRow>(executor: PgExecutor, text: string, values?: unknown[]) {
  const result = await executor.query<Row>(text, values)
  if (!result.rows[0]) throw new Error('Expected query to return a row.')
  return result.rows[0]
}

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function redactOperationalText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const redacted = value.trim()
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9._-]{6,}|oc[wc]_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength <= 3 ? maxLength : maxLength - 3)}${maxLength <= 3 ? '' : '...'}`
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = jsonRecord(value)
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
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
