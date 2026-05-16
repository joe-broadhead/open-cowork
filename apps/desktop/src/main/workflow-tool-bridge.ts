import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { WorkflowDraft } from '@open-cowork/shared'
import { createWorkflowFromTool, previewWorkflowFromTool } from './workflow-tool-actions.ts'
import { log } from './logger.ts'

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
    if (total > MAX_TOOL_BODY_BYTES) throw new ToolBridgeHttpError(413, 'Workflow tool payload is too large.')
    chunks.push(buffer)
  }
  let parsed: unknown = {}
  if (chunks.length > 0) {
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new ToolBridgeHttpError(400, 'Workflow tool payload must be valid JSON.')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolBridgeHttpError(400, 'Workflow tool payload must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function assertAuthorized(req: IncomingMessage) {
  const expected = token
  const auth = String(req.headers.authorization || '')
  if (!expected || auth !== `Bearer ${expected}`) throw new ToolBridgeHttpError(401, 'Unauthorized workflow tool request.')
}

async function handleToolRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  try {
    assertAuthorized(req)
    const body = await readJsonBody(req)
    if (req.url === '/preview') {
      writeJson(res, 200, previewWorkflowFromTool(body as unknown as WorkflowDraft) as unknown as Record<string, unknown>)
      return
    }
    if (req.url === '/create') {
      const result = createWorkflowFromTool(body as unknown as WorkflowDraft)
      writeJson(res, 200, result as unknown as Record<string, unknown>)
      return
    }
    writeJson(res, 404, { ok: false, error: 'Workflow tool route not found.' })
  } catch (error) {
    const status = error instanceof ToolBridgeHttpError ? error.status : 400
    const message = error instanceof ToolBridgeHttpError ? error.publicMessage : 'Workflow tool request failed.'
    if (!(error instanceof ToolBridgeHttpError)) {
      log('error', `Workflow tool request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeJson(res, status, { ok: false, error: message })
  }
}

export async function ensureWorkflowToolBridge() {
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
  if (!address || typeof address !== 'object') throw new Error('Workflow tool bridge did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
  log('workflow', `Workflow tool bridge listening on ${baseUrl}`)
}

export function getWorkflowToolBridgeEnvironment() {
  if (!baseUrl || !token) return {}
  return {
    OPEN_COWORK_WORKFLOW_TOOL_URL: baseUrl,
    OPEN_COWORK_WORKFLOW_TOOL_TOKEN: token,
  }
}

export function stopWorkflowToolBridge() {
  const current = server
  server = null
  baseUrl = null
  token = null
  if (current) current.close()
}
