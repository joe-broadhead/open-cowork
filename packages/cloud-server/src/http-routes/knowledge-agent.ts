import { normalizeKnowledgeProposalContent, sanitizeLogMessage } from '@open-cowork/shared'
import type { KnowledgeStore } from '@open-cowork/shared'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { verifyKnowledgeAgentToken } from '../knowledge-agent-token.ts'

// Cloud agent-propose route. A coworker (agent) running in a CLOUD session
// proposes a knowledge-wiki edit via the knowledge MCP, which POSTs here with a
// per-session, tenant-scoped signed token as its bearer credential.
//
// This route is the cloud counterpart of the desktop loopback bridge
// (knowledge-tool-bridge.ts), which forces the LOCAL workspace. Here the
// workspace + actor are derived SERVER-SIDE from the verified token, never from
// the agent-supplied body:
//   - the bearer token is verified against the cloud signing secret; missing /
//     malformed / tampered / expired / wrong-secret → 401.
//   - `workspaceId = cloud:<token.tenantId>` is taken from the TOKEN. Any
//     `workspaceId`/`tenantId` field in the request body is ignored.
//   - `by` is a fixed 'Coworker' label — the agent's `by` is NOT trusted.
//
// It is propose-ONLY: no accept / decline / review / read. The store's
// `assertCanPropose` still governs authorization and the proposal stays PENDING
// for a human Maintainer to review.

const KNOWLEDGE_AGENT_PROPOSAL_ACTOR = 'Coworker'

export type KnowledgeAgentProposeRouteInput = {
  req: IncomingMessage
  res: ServerResponse
  /** Cloud signing secret used to verify the per-session agent token. */
  secret: string | Buffer
  /** Resolved knowledge backend (Postgres in cloud, SQLite fallback otherwise). */
  store: KnowledgeStore
  knowledgeEnabled: boolean
  maxBodyBytes: number
  corsOrigin?: string | null
  now?: () => number
  tools: {
    readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>>
    writeJson(res: ServerResponse, status: number, body: unknown, corsOrigin?: string | null): void
    writeError(res: ServerResponse, status: number, message: string, corsOrigin?: string | null): void
    writePolicyError(res: ServerResponse, status: number, message: string, policyCode: string, corsOrigin?: string | null): void
  }
}

function agentWorkspaceId(tenantId: string) {
  // Mirror the human propose route's tenant boundary, but the tenant comes from
  // the VERIFIED token, never from the request body.
  return `cloud:${tenantId.trim() || 'default'}`
}

function readBearerToken(req: IncomingMessage) {
  const raw = req.headers.authorization
  const value = Array.isArray(raw) ? raw[0] || '' : raw || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice('bearer '.length).trim() : ''
}

function proposeErrorStatus(error: unknown) {
  if (!(error instanceof Error)) return 500
  const message = error.message
  if (/(permission|not allowed|forbidden|requires (contributor|maintainer)|not readable for this role)/i.test(message)) return 403
  if (/\bnot found\b/i.test(message)) return 404
  if (/(is required|is invalid|must be|must not|too large|too long|too many|malformed|cannot be empty|out of range|exceeds|non-empty|requires at least|belongs to a different)/i.test(message)) return 400
  return 500
}

export async function handleKnowledgeAgentProposeRoute(input: KnowledgeAgentProposeRouteInput): Promise<void> {
  const { req, res, tools, corsOrigin } = input

  if (req.method !== 'POST') {
    tools.writeError(res, 405, 'Method not allowed.', corsOrigin)
    return
  }

  // Feature-gate identically to the human knowledge route.
  if (!input.knowledgeEnabled) {
    tools.writePolicyError(res, 403, 'Knowledge is disabled for this cloud profile.', 'knowledge.disabled', corsOrigin)
    return
  }

  // Fail closed: with no signing secret configured the agent path is not
  // available, so we reject rather than verify against an empty secret (which an
  // attacker could otherwise sign their own token against). The spawn wiring
  // likewise injects no token/env when the secret is absent.
  const secretLength = typeof input.secret === 'string' ? input.secret.length : input.secret.byteLength
  if (secretLength === 0) {
    tools.writeError(res, 401, 'The knowledge agent token is invalid or expired.', corsOrigin)
    return
  }

  // Token auth: the per-session signed token is the ONLY credential for this
  // route. Missing / malformed / tampered / expired / wrong-secret → 401.
  const token = readBearerToken(req)
  if (!token) {
    tools.writeError(res, 401, 'A knowledge agent token is required.', corsOrigin)
    return
  }
  const nowMs = (input.now ?? Date.now)()
  const payload = verifyKnowledgeAgentToken(input.secret, token, nowMs)
  if (!payload) {
    tools.writeError(res, 401, 'The knowledge agent token is invalid or expired.', corsOrigin)
    return
  }

  // Derive the workspace from the TOKEN, never the body. We deliberately do not
  // read `workspaceId`/`tenantId`/`by` out of `body`; `normalizeKnowledgeProposalContent`
  // only pulls content fields (spaceId/page/summary/body/links), so any tenant
  // override in the body is silently ignored.
  const workspaceId = agentWorkspaceId(payload.tenantId)
  const body = await tools.readJsonBody(req, input.maxBodyBytes)
  try {
    const proposal = await input.store.createProposal(workspaceId, {
      ...normalizeKnowledgeProposalContent(body),
      by: KNOWLEDGE_AGENT_PROPOSAL_ACTOR,
    })
    // Match the MCP/bridge response contract: `{ ok, proposal }` with the created
    // (pending) proposal id.
    tools.writeJson(res, 201, { ok: true, proposal }, corsOrigin)
  } catch (error) {
    const status = proposeErrorStatus(error)
    const message = error instanceof Error && status < 500 ? sanitizeLogMessage(error.message) : 'Knowledge proposal failed.'
    tools.writeError(res, status, message, corsOrigin)
  }
}
