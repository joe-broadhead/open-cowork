import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createSemanticUiActionList,
  createSemanticUiActionResult,
  createSemanticUiSnapshot,
  createSemanticUiStatus,
  type SemanticUiAppState,
  type SemanticUiActionId,
  type SemanticUiActionDefinition,
  type SemanticUiActionList,
  type SemanticUiActionResult,
  type SemanticUiSnapshot,
  type SemanticUiStatus,
} from '@open-cowork/shared'
import { getRuntimeStatus } from './runtime-status.ts'
import { log } from './logger.ts'

const MAX_BODY_BYTES = 16 * 1024

let server: Server | null = null
let baseUrl: string | null = null
let token: string | null = null
let statusProvider: (() => SemanticUiStatus | Promise<SemanticUiStatus>) | null = null
let snapshotProvider: (() => SemanticUiSnapshot | Promise<SemanticUiSnapshot>) | null = null
let actionListProvider: (() => SemanticUiActionList | Promise<SemanticUiActionList>) | null = null
let actionExecutor: ((actionId: SemanticUiActionId, input: Record<string, unknown>) => SemanticUiActionResult | Promise<SemanticUiActionResult>) | null = null
let appState: SemanticUiAppState | null = null

class SemanticUiBridgeHttpError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
}

function bridgeDisabled() {
  return process.env.OPEN_COWORK_DISABLE_SEMANTIC_UI_MCP === '1'
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
    if (total > MAX_BODY_BYTES) throw new SemanticUiBridgeHttpError(413, 'Semantic UI request payload is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SemanticUiBridgeHttpError(400, 'Semantic UI request payload must be a JSON object.')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SemanticUiBridgeHttpError) throw error
    throw new SemanticUiBridgeHttpError(400, 'Semantic UI request payload must be valid JSON.')
  }
}

function assertAuthorized(req: IncomingMessage) {
  const expected = token
  const auth = String(req.headers.authorization || '')
  const prefix = 'Bearer '
  const candidate = auth.startsWith(prefix) ? auth.slice(prefix.length) : ''
  if (!expected || !candidate) throw new SemanticUiBridgeHttpError(401, 'Unauthorized semantic UI request.')
  const expectedBytes = Buffer.from(expected)
  const candidateBytes = Buffer.from(candidate)
  if (expectedBytes.length !== candidateBytes.length || !timingSafeEqual(expectedBytes, candidateBytes)) {
    throw new SemanticUiBridgeHttpError(401, 'Unauthorized semantic UI request.')
  }
}

function defaultStatus() {
  const runtime = getRuntimeStatus()
  if (appState) {
    const stateRuntime = appState.runtime || runtime
    return createSemanticUiStatus({
      capturedAt: appState.capturedAt || new Date().toISOString(),
      authority: appState.authority,
      appReady: appState.appReady ?? stateRuntime.ready,
      route: appState.route ?? null,
      workspace: appState.workspace ?? null,
      activeSession: appState.activeSession ?? null,
      runtime: stateRuntime,
      pending: {
        approvals: appState.pending?.approvals ?? 0,
        questions: appState.pending?.questions ?? 0,
      },
    })
  }
  return createSemanticUiStatus({
    capturedAt: new Date().toISOString(),
    authority: 'desktop-local',
    appReady: runtime.ready,
    route: null,
    workspace: null,
    activeSession: null,
    runtime,
    pending: {
      approvals: 0,
      questions: 0,
    },
  })
}

async function currentStatus() {
  return statusProvider ? statusProvider() : defaultStatus()
}

async function currentSnapshot() {
  if (snapshotProvider) return snapshotProvider()
  const status = await currentStatus()
  return createSemanticUiSnapshot({
    capturedAt: status.capturedAt,
    status,
    visibleSurface: appState?.visibleSurface || 'unknown',
    items: appState?.items?.length ? appState.items : [{
      id: 'runtime-status',
      kind: 'status',
      label: status.runtime.ready ? 'Runtime ready' : 'Runtime not ready',
      state: status.runtime.phase || 'unknown',
    }],
  })
}

function defaultActions() {
  return createSemanticUiActionList({
    capturedAt: new Date().toISOString(),
    actions: [{
      id: 'diagnostics.export',
      label: 'Export diagnostics',
      description: 'Return the redacted diagnostics bundle text for local support and release evidence.',
      destructive: false,
      requiresAudit: true,
      enabled: true,
    }],
  })
}

async function currentActions() {
  return actionListProvider ? actionListProvider() : defaultActions()
}

async function executeDefaultAction(actionId: SemanticUiActionId, input: Record<string, unknown>) {
  if (Object.keys(input).length > 0) {
    return createSemanticUiActionResult({
      capturedAt: new Date().toISOString(),
      actionId,
      ok: false,
      errorCode: 'semantic-ui-action-input-unsupported',
      message: 'This action does not accept input.',
    })
  }
  const { buildDiagnosticsBundle } = await import('./diagnostics-export.ts')
  log('semantic-ui', 'Executed semantic UI action diagnostics.export')
  return createSemanticUiActionResult({
    capturedAt: new Date().toISOString(),
    actionId,
    ok: true,
    content: {
      mime: 'text/plain',
      text: buildDiagnosticsBundle(),
    },
  })
}

function readActionId(value: unknown): SemanticUiActionId {
  if (
    value === 'diagnostics.export'
    || value === 'approval.allow'
    || value === 'approval.deny'
    || value === 'question.answer'
    || value === 'question.reject'
  ) return value
  throw new SemanticUiBridgeHttpError(400, 'Semantic UI action id is not supported.')
}

async function actionDefinitionFor(actionId: SemanticUiActionId): Promise<SemanticUiActionDefinition | null> {
  const actions = await currentActions()
  return actions.actions.find((action) => action.id === actionId) || null
}

function actionRejected(actionId: SemanticUiActionId, errorCode: string, message: string) {
  return createSemanticUiActionResult({
    capturedAt: new Date().toISOString(),
    actionId,
    ok: false,
    errorCode,
    message,
  })
}

async function executeAction(body: Record<string, unknown>) {
  const actionId = readActionId(body.actionId)
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
    ? body.input as Record<string, unknown>
    : {}
  const action = await actionDefinitionFor(actionId)
  if (!action) {
    return actionRejected(actionId, 'semantic-ui-action-unavailable', 'This action is not available in the current Open Cowork state.')
  }
  if (!action.enabled) {
    return actionRejected(actionId, action.reasonCode || 'semantic-ui-action-disabled', 'This action is disabled in the current Open Cowork state.')
  }
  if (action.destructive && input.confirmDestructive !== true) {
    return actionRejected(actionId, 'semantic-ui-destructive-confirmation-required', 'This action requires explicit destructive confirmation.')
  }
  const executor = actionExecutor || executeDefaultAction
  return executor(actionId, input)
}

async function handleBridgeRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  try {
    assertAuthorized(req)
    const body = await readJsonBody(req)
    if (req.url === '/status') {
      writeJson(res, 200, { ok: true, status: await currentStatus() })
      return
    }
    if (req.url === '/snapshot') {
      writeJson(res, 200, { ok: true, snapshot: await currentSnapshot() })
      return
    }
    if (req.url === '/actions/list') {
      writeJson(res, 200, { ok: true, actions: await currentActions() })
      return
    }
    if (req.url === '/actions/execute') {
      writeJson(res, 200, { ok: true, result: await executeAction(body) })
      return
    }
    writeJson(res, 404, { ok: false, error: 'Semantic UI route not found.' })
  } catch (error) {
    const status = error instanceof SemanticUiBridgeHttpError ? error.status : 400
    const message = error instanceof SemanticUiBridgeHttpError ? error.publicMessage : 'Semantic UI request failed.'
    if (!(error instanceof SemanticUiBridgeHttpError)) {
      log('error', `Semantic UI request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeJson(res, status, { ok: false, error: message })
  }
}

export function configureSemanticUiBridge(options: {
  statusProvider?: (() => SemanticUiStatus | Promise<SemanticUiStatus>) | null
  snapshotProvider?: (() => SemanticUiSnapshot | Promise<SemanticUiSnapshot>) | null
  actionListProvider?: (() => SemanticUiActionList | Promise<SemanticUiActionList>) | null
  actionExecutor?: ((actionId: SemanticUiActionId, input: Record<string, unknown>) => SemanticUiActionResult | Promise<SemanticUiActionResult>) | null
} = {}) {
  statusProvider = options.statusProvider || null
  snapshotProvider = options.snapshotProvider || null
  actionListProvider = options.actionListProvider || null
  actionExecutor = options.actionExecutor || null
}

export function updateSemanticUiBridgeState(state: SemanticUiAppState | null) {
  appState = state
    ? {
        ...state,
        pending: state.pending ? { ...state.pending } : undefined,
        items: state.items ? state.items.map((item) => ({ ...item })) : undefined,
      }
    : null
}

export async function ensureSemanticUiBridge() {
  if (bridgeDisabled()) return
  if (server && baseUrl && token) return
  token = randomBytes(32).toString('base64url')
  const next = createServer((req, res) => {
    void handleBridgeRequest(req, res)
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
  if (!address || typeof address !== 'object') throw new Error('Semantic UI bridge did not bind to a TCP port.')
  baseUrl = `http://127.0.0.1:${address.port}`
  log('semantic-ui', `Semantic UI bridge listening on ${baseUrl}`)
}

export function getSemanticUiBridgeEnvironment() {
  if (bridgeDisabled() || !baseUrl || !token) return {}
  return {
    OPEN_COWORK_SEMANTIC_UI_URL: baseUrl,
    OPEN_COWORK_SEMANTIC_UI_TOKEN: token,
  }
}

export function stopSemanticUiBridge() {
  const current = server
  server = null
  baseUrl = null
  token = null
  statusProvider = null
  snapshotProvider = null
  actionListProvider = null
  actionExecutor = null
  appState = null
  if (current) current.close()
}
