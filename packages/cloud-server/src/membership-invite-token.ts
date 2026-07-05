import { createHmac } from 'node:crypto'
import { constantTimeEquals } from '@open-cowork/shared/node'

import type { ControlPlaneRole } from './control-plane-enums.ts'

// Stateless, HMAC-signed team-invite token. The membership row (invited → active → disabled) is
// the source of truth for state and revocation; the token is just a tamper-proof, expiring proof
// of "this org invited this account as this role", so no separate invite table/migration is
// needed. Mirrors the session-cookie signing scheme (base64url(payload).hmac) and reuses the
// cloud server's signing secret. A team deployment that has auth configured already has that
// secret; without one, invite links are unavailable and the admin shares the membership directly.
export type MembershipInvitePayload = {
  orgId: string
  accountId: string
  email: string
  role: ControlPlaneRole
  /** Expiry as epoch milliseconds. */
  exp: number
}

function sign(secret: string | Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signMembershipInviteToken(secret: string | Buffer, payload: MembershipInvitePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(secret, encoded)}`
}

export function verifyMembershipInviteToken(
  secret: string | Buffer,
  token: string,
  nowMs: number,
): MembershipInvitePayload | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature || !constantTimeEquals(signature, sign(secret, encoded))) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as Record<string, unknown>
  if (
    typeof candidate.orgId !== 'string'
    || typeof candidate.accountId !== 'string'
    || typeof candidate.email !== 'string'
    || (candidate.role !== 'owner' && candidate.role !== 'admin' && candidate.role !== 'member')
    || typeof candidate.exp !== 'number'
    || !Number.isFinite(candidate.exp)
  ) {
    return null
  }
  if (candidate.exp <= nowMs) return null
  return {
    orgId: candidate.orgId,
    accountId: candidate.accountId,
    email: candidate.email,
    role: candidate.role,
    exp: candidate.exp,
  }
}
