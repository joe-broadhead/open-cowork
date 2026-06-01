import { createHash } from 'node:crypto'

export class InvalidSessionPageCursorError extends Error {
  constructor(message = 'Session list cursor is invalid.') {
    super(message)
    this.name = 'InvalidSessionPageCursorError'
  }
}

export type SessionPageCursorScope = {
  tenantId: string
  userId: string
  status?: string | null
  profileName?: string | null
  query?: string | null
}

function normalizedSessionPageCursorScope(scope: SessionPageCursorScope) {
  return {
    tenantId: scope.tenantId,
    userId: scope.userId,
    status: scope.status || null,
    profileName: scope.profileName || null,
    query: scope.query?.trim().toLowerCase() || null,
  }
}

function sessionPageCursorScopeHash(scope: SessionPageCursorScope) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedSessionPageCursorScope(scope)))
    .digest('base64url')
}

export function encodeSessionPageCursor(
  session: { updatedAt: string, sessionId: string },
  scope?: SessionPageCursorScope,
) {
  const payload: Record<string, unknown> = {
    v: 1,
    updatedAt: session.updatedAt,
    sessionId: session.sessionId,
  }
  if (scope) {
    payload.scopeHash = sessionPageCursorScopeHash(scope)
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeSessionPageCursor(
  cursor: string | null | undefined,
  expectedScope?: SessionPageCursorScope,
): { updatedAt: string, sessionId: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.updatedAt === 'string'
      && typeof parsed.sessionId === 'string'
    ) {
      if (expectedScope) {
        const expectedHash = sessionPageCursorScopeHash(expectedScope)
        if (typeof parsed.scopeHash !== 'string' || parsed.scopeHash !== expectedHash) {
          throw new InvalidSessionPageCursorError('Session list cursor does not match the requested scope.')
        }
      }
      return { updatedAt: parsed.updatedAt, sessionId: parsed.sessionId }
    }
  } catch (error) {
    if (error instanceof InvalidSessionPageCursorError) throw error
    throw new InvalidSessionPageCursorError()
  }
  throw new InvalidSessionPageCursorError()
}
