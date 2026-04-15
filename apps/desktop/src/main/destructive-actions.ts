import { randomUUID } from 'crypto'
import type {
  DestructiveConfirmationGrant,
  DestructiveConfirmationRequest,
} from '@open-cowork/shared'

type PendingDestructiveConfirmation = {
  action: DestructiveConfirmationRequest['action']
  key: string
  expiresAt: number
}

const CONFIRMATION_TTL_MS = 30_000

function normalizeDirectory(directory?: string | null) {
  return directory || ''
}

function requestKey(request: DestructiveConfirmationRequest) {
  if (request.action === 'session.delete') {
    return request.sessionId
  }
  return `${request.target.scope}:${normalizeDirectory(request.target.directory)}:${request.target.name}`
}

export function createDestructiveConfirmationManager(now: () => number = Date.now) {
  const pendingByToken = new Map<string, PendingDestructiveConfirmation>()

  function pruneExpired() {
    const current = now()
    for (const [token, pending] of pendingByToken) {
      if (pending.expiresAt <= current) {
        pendingByToken.delete(token)
      }
    }
  }

  function issue(request: DestructiveConfirmationRequest): DestructiveConfirmationGrant {
    pruneExpired()
    const expiresAt = now() + CONFIRMATION_TTL_MS
    const token = randomUUID()
    pendingByToken.set(token, {
      action: request.action,
      key: requestKey(request),
      expiresAt,
    })
    return {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  function consume(request: DestructiveConfirmationRequest, token?: string | null) {
    pruneExpired()
    if (!token) return false
    const pending = pendingByToken.get(token)
    if (!pending) return false
    pendingByToken.delete(token)
    return pending.action === request.action
      && pending.key === requestKey(request)
      && pending.expiresAt > now()
  }

  return {
    issue,
    consume,
  }
}
