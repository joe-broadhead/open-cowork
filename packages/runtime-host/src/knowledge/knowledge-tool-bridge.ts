import { normalizeKnowledgeProposalContent } from '@open-cowork/shared'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { KnowledgeProposalInput } from '@open-cowork/shared'
import { createKnowledgeProposal } from './knowledge-service.js'
import { LOCAL_WORKSPACE_ID } from '@open-cowork/shared/node'
import { log } from '@open-cowork/shared/node'

// Loopback bridge that lets an in-session coworker (agent) propose a knowledge
// wiki edit via the knowledge MCP. This mirrors the workflow tool bridge
// VERBATIM: a 127.0.0.1 server, a 32-byte bearer token, a constant-time auth
// check, and a body-size cap. The bridge FORCES the local workspace and runs
// the same `normalizeKnowledgeProposalContent` validator the IPC/HTTP paths
// use — the agent is never trusted for the workspace/tenant.
//
// Desktop/local ONLY. The cloud runtime does not route agent proposals through
// this bridge: cloud needs session-scoped token plumbing (so a proposal is
// attributed to the right tenant/user/session) that does not exist yet.

const MAX_TOOL_BODY_BYTES = 256 * 1024

let server: Server | null = null
let baseUrl: string | null = null
let token: string | null = null

class ToolBridgeHttpError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_TOOL_BODY_BYTES) throw new ToolBridgeHttpError(413, 'Knowledge tool payload is too large.')
    chunks.push(buffer)
  }
  let parsed: unknown = {}
  if (chunks.length > 0) {
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new ToolBridgeHttpError(400, 'Knowledge tool payload must be valid JSON.')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolBridgeHttpError(400, 'Knowledge tool payload must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function assertAuthorized(req: IncomingMessage) {
  const expected = token
  const auth = String(req.headers.authorization || '')
  const prefix = 'Bearer '
  const candidate = auth.startsWith(prefix) ? auth.slice(prefix.length) : ''
  if (!expected || !candidate) throw new ToolBridgeHttpError(401, 'Unauthorized knowledge tool request.')
  const expectedBytes = Buffer.from(expected)
  const candidateBytes = Buffer.from(candidate)
  if (expectedBytes.length !== candidateBytes.length || !timingSafeEqual(expectedBytes, candidateBytes)) {
    throw new ToolBridgeHttpError(401, 'Unauthorized knowledge tool request.')
  }
}

// Build the proposal input from the posted body. The workspace is ALWAYS forced
// to the local workspace (never read from the agent-supplied body), and the
// content is run through the shared `normalizeKnowledgeProposalContent`
// validator — identical to the desktop IPC handler — so the agent path cannot
// bypass validation or target another tenant. `by` defaults to a coworker
// label. The store's `assertCanPropose` still governs authorization and the
// proposal stays PENDING for human review.
function buildProposalInput(body: Record<string, unknown>): KnowledgeProposalInput {
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'Coworker'
  return {
    workspaceId: LOCAL_WORKSPACE_ID,
    by,
    ...normalizeKnowledgeProposalContent(body),
  }
}

async function handleToolRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  try {
    assertAuthorized(req)
    const body = await readJsonBody(req)
    if (req.url === '/propose') {
      const proposal = createKnowledgeProposal(buildProposalInput(body))
      writeJson(res, 200, { ok: true, proposal } as unknown as Record<string, unknown>)
      return
    }
    writeJson(res, 404, { ok: false, error: 'Knowledge tool route not found.' })
  } catch (error) {
    const status = error instanceof ToolBridgeHttpError ? error.status : 400
    const message = error instanceof ToolBridgeHttpError
      ? error.publicMessage
      : error instanceof Error
        ? error.message
        : 'Knowledge tool request failed.'
    if (!(error instanceof ToolBridgeHttpError)) {
      log('error', `Knowledge tool request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeJson(res, status, { ok: false, error: message })
  }
}

export async function ensureKnowledgeToolBridge() {
  if (server && baseUrl && token) return
  token = randomBytes(32).toString('base64url')
  const next = createServer((req, res) => {
    void handleToolRequest(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(0, '127.0.0.1', () => {
      next.off('error', reject)
      resolve()
    })
  })
  server = next
  const address = next.address()
  if (!address || typeof address !== 'object') throw new Error('Knowledge tool bridge did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
  log('knowledge', `Knowledge tool bridge listening on ${baseUrl}`)
}

export function getKnowledgeToolBridgeEnvironment() {
  if (!baseUrl || !token) return {}
  return {
    OPEN_COWORK_KNOWLEDGE_TOOL_URL: baseUrl,
    OPEN_COWORK_KNOWLEDGE_TOOL_TOKEN: token,
  }
}

export function stopKnowledgeToolBridge() {
  const current = server
  server = null
  baseUrl = null
  token = null
  if (current) current.close()
}
