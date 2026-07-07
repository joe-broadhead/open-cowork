import type { AuditActorType } from '../control-plane-enums.ts'
import type {
  AuditEventRecord,
  ControlPlaneStore,
  QueryAuditEventsInput,
} from '../control-plane-store.ts'
import {
  decodeAuditQueryCursor,
  encodeAuditQueryCursor,
  InvalidAuditQueryCursorError,
  normalizeAuditQueryLimit,
  MAX_AUDIT_QUERY_LIMIT,
  type AuditQueryCursorScope,
} from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { redactAuditMetadataForExport } from '../audit-redaction.ts'
import { recordCloudMetric, type CloudObservabilityAdapter } from '../observability.ts'
import type { CloudPrincipal } from '../session-service-types.ts'

// The queryable + exportable audit surface (#899). Owns three concerns behind one
// small service so session-service stays a thin delegator:
//   1. emitDataPlaneEvent — best-effort, non-blocking audit write for data-plane
//      actions (session/command/artifact/worker), ALSO fanned to the telemetry
//      counter so operators can alert on audit volume without scraping logs.
//   2. queryAuditEvents — filterable, keyset-paginated admin read (audit:read).
//   3. exportAuditEvents — deterministic, redacted-by-default JSON/CSV export that
//      paginates internally (never buffers the whole log); the explicit unredacted
//      mode is org-admin-only and records its own audit event.

export type AuditActor = {
  actorType: AuditActorType
  actorId?: string | null
  accountId?: string | null
}

export type DataPlaneAuditInput = {
  orgId: string
  actor: AuditActor
  eventType: string
  targetType?: string | null
  targetId?: string | null
  result?: 'success' | 'failure' | 'denied'
  metadata?: Record<string, unknown>
}

export type AuditQueryFilters = {
  actorId?: string | null
  actorType?: AuditActorType | null
  eventTypePrefix?: string | null
  targetType?: string | null
  targetId?: string | null
  result?: string | null
  from?: Date | null
  to?: Date | null
  limit?: number | null
  cursor?: string | null
}

export type AuditQueryPage = {
  events: AuditEventRecord[]
  nextCursor: string | null
}

export type AuditExportFormat = 'json' | 'csv'

export type AuditExportOptions = AuditQueryFilters & {
  format?: AuditExportFormat
  unredacted?: boolean
}

export type AuditExportStream = {
  format: AuditExportFormat
  contentType: string
  filename: string
  chunks: AsyncIterable<string>
}

export type CloudAuditServiceOptions = {
  store: ControlPlaneStore
  observability: CloudObservabilityAdapter | null
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertPermission: (principal: CloudPrincipal, permission: 'audit:read') => void
  assertOrgAdmin: (principal: CloudPrincipal) => void
  principalOrgId: (principal: CloudPrincipal) => string
  auditActor: (principal: CloudPrincipal) => AuditActor
}

const AUDIT_EXPORT_PAGE_SIZE = MAX_AUDIT_QUERY_LIMIT

const CSV_COLUMNS: Array<keyof AuditEventRecord | 'result'> = [
  'eventId',
  'createdAt',
  'orgId',
  'actorType',
  'actorId',
  'accountId',
  'eventType',
  'targetType',
  'targetId',
  'result',
]

export class CloudAuditService {
  private readonly store: ControlPlaneStore
  private readonly observability: CloudObservabilityAdapter | null
  private readonly ensurePrincipal: CloudAuditServiceOptions['ensurePrincipal']
  private readonly assertPermission: CloudAuditServiceOptions['assertPermission']
  private readonly assertOrgAdmin: CloudAuditServiceOptions['assertOrgAdmin']
  private readonly principalOrgId: CloudAuditServiceOptions['principalOrgId']
  private readonly auditActor: CloudAuditServiceOptions['auditActor']

  constructor(options: CloudAuditServiceOptions) {
    this.store = options.store
    this.observability = options.observability
    this.ensurePrincipal = options.ensurePrincipal
    this.assertPermission = options.assertPermission
    this.assertOrgAdmin = options.assertOrgAdmin
    this.principalOrgId = options.principalOrgId
    this.auditActor = options.auditActor
  }

  // Best-effort, non-blocking: an audit write must never fail (or slow) the
  // data-plane action that triggered it. Errors are swallowed exactly like the
  // telemetry pipeline. Returns a promise callers may ignore (fire-and-forget).
  async emitDataPlaneEvent(input: DataPlaneAuditInput): Promise<void> {
    const metadata: Record<string, unknown> = { ...(input.metadata || {}) }
    if (input.result) metadata.result = input.result
    try {
      await this.store.recordAuditEvent({
        orgId: input.orgId,
        accountId: input.actor.accountId ?? null,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId ?? null,
        eventType: input.eventType,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata,
      })
    } catch {
      // Swallow — the audit trail is observability, not product correctness.
    }
    await recordCloudMetric(this.observability, {
      name: 'open_cowork_cloud_audit_events_total',
      value: 1,
      unit: '1',
      attributes: {
        event_type: input.eventType,
        actor_type: input.actor.actorType,
        result: input.result || 'success',
      },
    })
  }

  async queryAuditEvents(principal: CloudPrincipal, filters: AuditQueryFilters = {}): Promise<AuditQueryPage> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'audit:read')
    const orgId = this.principalOrgId(principal)
    const { input } = this.resolveQuery(orgId, filters)
    const result = await this.store.queryAuditEvents(input)
    const scope = this.cursorScope(orgId, filters)
    return {
      events: result.events,
      nextCursor: result.nextCursor ? encodeAuditQueryCursor(result.nextCursor, scope) : null,
    }
  }

  async exportAuditEvents(principal: CloudPrincipal, options: AuditExportOptions = {}): Promise<AuditExportStream> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'audit:read')
    const orgId = this.principalOrgId(principal)
    const format: AuditExportFormat = options.format === 'csv' ? 'csv' : 'json'
    const unredacted = options.unredacted === true
    if (unredacted) {
      // Raw local paths are only for privileged compliance exports — org-admin only,
      // and the disclosure itself is written to the durable audit trail.
      this.assertOrgAdmin(principal)
      await this.recordUnredactedExport(principal, orgId, format, options)
    }
    const { input, scope } = this.resolveQuery(orgId, { ...options, limit: AUDIT_EXPORT_PAGE_SIZE, cursor: options.cursor })
    const chunks = format === 'csv'
      ? this.exportCsvChunks(input, scope, unredacted)
      : this.exportJsonChunks(input, scope, unredacted)
    return {
      format,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      filename: `audit-export-${orgId}.${format}`,
      chunks,
    }
  }

  private resolveQuery(orgId: string, filters: AuditQueryFilters): { input: QueryAuditEventsInput, scope: AuditQueryCursorScope } {
    const scope = this.cursorScope(orgId, filters)
    let cursor
    try {
      cursor = decodeAuditQueryCursor(filters.cursor, scope)
    } catch (error) {
      if (error instanceof InvalidAuditQueryCursorError) {
        throw new CloudServiceError(400, 'Audit query cursor is invalid.', { policyCode: 'audit.cursor.invalid' })
      }
      throw error
    }
    return {
      scope,
      input: {
        orgId,
        actorId: filters.actorId || null,
        actorType: filters.actorType || null,
        eventTypePrefix: filters.eventTypePrefix || null,
        targetType: filters.targetType || null,
        targetId: filters.targetId || null,
        result: filters.result || null,
        from: filters.from || null,
        to: filters.to || null,
        limit: normalizeAuditQueryLimit(filters.limit),
        cursor,
      },
    }
  }

  private cursorScope(orgId: string, filters: AuditQueryFilters): AuditQueryCursorScope {
    return {
      orgId,
      actorId: filters.actorId || null,
      actorType: filters.actorType || null,
      eventTypePrefix: filters.eventTypePrefix || null,
      targetType: filters.targetType || null,
      targetId: filters.targetId || null,
      result: filters.result || null,
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
    }
  }

  private async recordUnredactedExport(principal: CloudPrincipal, orgId: string, format: AuditExportFormat, options: AuditExportOptions) {
    const actor = this.auditActor(principal)
    // Durable (awaited) — the whole point is that an unredacted disclosure is itself
    // auditable, so this write is not best-effort.
    await this.store.recordAuditEvent({
      orgId,
      accountId: actor.accountId ?? null,
      actorType: actor.actorType,
      actorId: actor.actorId ?? null,
      eventType: 'audit.exported',
      targetType: 'audit_log',
      targetId: orgId,
      metadata: {
        result: 'success',
        format,
        unredacted: true,
        filters: {
          actorId: options.actorId || null,
          eventTypePrefix: options.eventTypePrefix || null,
          targetType: options.targetType || null,
          result: options.result || null,
        },
      },
    })
  }

  private redactForExport(event: AuditEventRecord, unredacted: boolean): AuditEventRecord {
    if (unredacted) return event
    return { ...event, metadata: redactAuditMetadataForExport(event.metadata) }
  }

  private async *pageEvents(input: QueryAuditEventsInput, scope: AuditQueryCursorScope): AsyncGenerator<AuditEventRecord> {
    let cursor = input.cursor || null
    // Hard page ceiling as a runaway guard; a real org will terminate on nextCursor
    // long before this. Bounds the stream so a pathological log can't spin forever.
    for (let page = 0; page < 100_000; page += 1) {
      const result = await this.store.queryAuditEvents({ ...input, cursor })
      for (const event of result.events) yield event
      if (!result.nextCursor) return
      // Round-trip through the opaque cursor so streaming shares the exact keyset
      // contract the paginated query exposes to clients.
      cursor = decodeAuditQueryCursor(encodeAuditQueryCursor(result.nextCursor, scope), scope)
    }
  }

  private async *exportJsonChunks(input: QueryAuditEventsInput, scope: AuditQueryCursorScope, unredacted: boolean): AsyncGenerator<string> {
    yield '{"events":['
    let first = true
    for await (const event of this.pageEvents(input, scope)) {
      yield `${first ? '' : ','}${JSON.stringify(this.redactForExport(event, unredacted))}`
      first = false
    }
    yield ']}'
  }

  private async *exportCsvChunks(input: QueryAuditEventsInput, scope: AuditQueryCursorScope, unredacted: boolean): AsyncGenerator<string> {
    yield `${[...CSV_COLUMNS, 'metadata'].join(',')}\n`
    for await (const raw of this.pageEvents(input, scope)) {
      const event = this.redactForExport(raw, unredacted)
      const cells = CSV_COLUMNS.map((column) => (
        column === 'result'
          ? csvCell(typeof event.metadata.result === 'string' ? event.metadata.result : '')
          : csvCell(event[column])
      ))
      cells.push(csvCell(JSON.stringify(event.metadata)))
      yield `${cells.join(',')}\n`
    }
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}
