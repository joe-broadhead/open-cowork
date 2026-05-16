import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { CustomAgentConfig, ScopedArtifactRef } from '@open-cowork/shared'
import {
  deleteAgentFromTool,
  getAgentFromTool,
  listAgentsFromTool,
  previewAgentFromTool,
  saveAgentFromTool,
} from './agent-tool-actions.ts'
import { log } from './logger.ts'

const MAX_TOOL_BODY_BYTES = 256 * 1024

let server: Server | null = null
let baseUrl: string | null = null
let token: string | null = null
let runtimeRefreshScheduler: (() => void) | null = null

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
    if (total > MAX_TOOL_BODY_BYTES) throw new ToolBridgeHttpError(413, 'Agent tool payload is too large.')
    chunks.push(buffer)
  }
  let parsed: unknown = {}
  if (chunks.length > 0) {
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new ToolBridgeHttpError(400, 'Agent tool payload must be valid JSON.')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolBridgeHttpError(400, 'Agent tool payload must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function assertAuthorized(req: IncomingMessage) {
  const expected = token
  const auth = String(req.headers.authorization || '')
  if (!expected || auth !== `Bearer ${expected}`) throw new ToolBridgeHttpError(401, 'Unauthorized agent tool request.')
}

function scheduleRuntimeRefresh() {
  const scheduler = runtimeRefreshScheduler || (() => {
    void import('./index.ts')
      .then(({ rebootRuntime }) => rebootRuntime())
      .catch((error) => {
        log('error', `Agent tool runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  })
  setTimeout(scheduler, 0)
}

async function handleToolRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  try {
    assertAuthorized(req)
    const body = await readJsonBody(req)
    if (req.url === '/list') {
      writeJson(res, 200, listAgentsFromTool(body as { directory?: string | null }))
      return
    }
    if (req.url === '/get') {
      writeJson(res, 200, getAgentFromTool(body as unknown as ScopedArtifactRef))
      return
    }
    if (req.url === '/preview') {
      writeJson(res, 200, await previewAgentFromTool(body as unknown as CustomAgentConfig))
      return
    }
    if (req.url === '/save') {
      const result = await saveAgentFromTool(body as unknown as CustomAgentConfig)
      writeJson(res, 200, result)
      if (result.runtimeRefreshRequired) scheduleRuntimeRefresh()
      return
    }
    if (req.url === '/delete') {
      const result = deleteAgentFromTool(body as unknown as ScopedArtifactRef)
      writeJson(res, 200, result)
      if (result.runtimeRefreshRequired) scheduleRuntimeRefresh()
      return
    }
    writeJson(res, 404, { ok: false, error: 'Agent tool route not found.' })
  } catch (error) {
    const status = error instanceof ToolBridgeHttpError ? error.status : 400
    const message = error instanceof ToolBridgeHttpError ? error.publicMessage : 'Agent tool request failed.'
    if (!(error instanceof ToolBridgeHttpError)) {
      log('error', `Agent tool request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeJson(res, status, { ok: false, error: message })
  }
}

export function configureAgentToolBridge(options: { scheduleRuntimeRefresh?: () => void } = {}) {
  runtimeRefreshScheduler = options.scheduleRuntimeRefresh || null
}

export async function ensureAgentToolBridge() {
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
  if (!address || typeof address !== 'object') throw new Error('Agent tool bridge did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
  log('agent', `Agent tool bridge listening on ${baseUrl}`)
}

export function getAgentToolBridgeEnvironment() {
  if (!baseUrl || !token) return {}
  return {
    OPEN_COWORK_AGENT_TOOL_URL: baseUrl,
    OPEN_COWORK_AGENT_TOOL_TOKEN: token,
  }
}

export function stopAgentToolBridge() {
  const current = server
  server = null
  baseUrl = null
  token = null
  runtimeRefreshScheduler = null
  if (current) current.close()
}
