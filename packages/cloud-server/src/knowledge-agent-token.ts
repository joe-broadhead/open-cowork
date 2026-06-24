import { createHmac, timingSafeEqual } from 'node:crypto'

// Stateless, HMAC-signed, per-session knowledge-agent token. A coworker (agent)
// running in a CLOUD session proposes a knowledge-wiki edit through the knowledge
// MCP; the MCP carries this token as its bearer credential to the cloud
// agent-propose route. Unlike a user/API-token principal, this token grants
// EXACTLY ONE capability on EXACTLY ONE route: propose a (pending) knowledge edit
// scoped to the token's tenant. It is NOT a CloudPrincipal — it cannot read,
// accept, decline, list, or reach any other endpoint.
//
// The token is tenant+session-bound and short-lived (signed with the cloud
// signing secret, so a tenant/session can only ever propose into its OWN
// workspace). The route derives `workspaceId = cloud:<token.tenantId>` from the
// VERIFIED token, never from the request body, so a compromised/curious agent
// cannot target another tenant. Mirrors `membership-invite-token.ts` exactly:
// `base64url(JSON(payload)).hmac`, constant-time verify, expiry + shape checks.
export type KnowledgeAgentTokenPayload = {
  tenantId: string
  sessionId: string
  /** Expiry as epoch milliseconds. */
  exp: number
}

// Per-session TTL. Long enough to outlive a single agent run/session but short
// enough that a leaked token is not a durable credential. The session is the
// real lifetime bound; this is a hard ceiling.
export const KNOWLEDGE_AGENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function sign(secret: string | Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

export function signKnowledgeAgentToken(secret: string | Buffer, payload: KnowledgeAgentTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(secret, encoded)}`
}

export function verifyKnowledgeAgentToken(
  secret: string | Buffer,
  token: string,
  nowMs: number,
): KnowledgeAgentTokenPayload | null {
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
    typeof candidate.tenantId !== 'string'
    || !candidate.tenantId.trim()
    || typeof candidate.sessionId !== 'string'
    || !candidate.sessionId.trim()
    || typeof candidate.exp !== 'number'
    || !Number.isFinite(candidate.exp)
  ) {
    return null
  }
  if (candidate.exp <= nowMs) return null
  return {
    tenantId: candidate.tenantId,
    sessionId: candidate.sessionId,
    exp: candidate.exp,
  }
}
