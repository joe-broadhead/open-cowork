import { createHash } from 'node:crypto'
import type { AuditQueryCursor } from './control-plane-account-inputs.ts'

// Opaque, STABLE keyset cursor for the audit-event query — the (createdAt,
// eventId) tuple of the last row a page returned, base64url-encoded with a hash
// of the filter scope. Mirrors session-page-cursor.ts exactly: a cursor is only
// valid for the identical filter set it was issued for, so a client cannot page
// a mutated query with a stale cursor and silently skip or repeat rows.

export class InvalidAuditQueryCursorError extends Error {
  constructor(message = 'Audit query cursor is invalid.') {
    super(message)
    this.name = 'InvalidAuditQueryCursorError'
  }
}

export type AuditQueryCursorScope = {
  orgId: string
  actorId?: string | null
  actorType?: string | null
  eventTypePrefix?: string | null
  targetType?: string | null
  targetId?: string | null
  result?: string | null
  from?: string | null
  to?: string | null
}

function normalizedScope(scope: AuditQueryCursorScope) {
  return {
    orgId: scope.orgId,
    actorId: scope.actorId || null,
    actorType: scope.actorType || null,
    eventTypePrefix: scope.eventTypePrefix || null,
    targetType: scope.targetType || null,
    targetId: scope.targetId || null,
    result: scope.result || null,
    from: scope.from || null,
    to: scope.to || null,
  }
}

function scopeHash(scope: AuditQueryCursorScope) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedScope(scope)))
    .digest('base64url')
}

export function encodeAuditQueryCursor(
  cursor: AuditQueryCursor,
  scope: AuditQueryCursorScope,
) {
  const payload = {
    v: 1,
    createdAt: cursor.createdAt,
    eventId: cursor.eventId,
    scopeHash: scopeHash(scope),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeAuditQueryCursor(
  cursor: string | null | undefined,
  scope: AuditQueryCursorScope,
): AuditQueryCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.createdAt === 'string'
      && typeof parsed.eventId === 'string'
    ) {
      if (typeof parsed.scopeHash !== 'string' || parsed.scopeHash !== scopeHash(scope)) {
        throw new InvalidAuditQueryCursorError('Audit query cursor does not match the requested filters.')
      }
      return { createdAt: parsed.createdAt, eventId: parsed.eventId }
    }
  } catch (error) {
    if (error instanceof InvalidAuditQueryCursorError) throw error
    throw new InvalidAuditQueryCursorError()
  }
  throw new InvalidAuditQueryCursorError()
}
