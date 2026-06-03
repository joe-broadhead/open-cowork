import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'semantic-ui',
  version: '1.0.0',
})

const BRIDGE_REQUEST_TIMEOUT_MS = 5_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function bridgeUrl() {
  const value = process.env.OPEN_COWORK_SEMANTIC_UI_URL?.trim()
  if (!value) throw new Error('OPEN_COWORK_SEMANTIC_UI_URL is not configured.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPEN_COWORK_SEMANTIC_UI_URL must be a valid URL.')
  }
  if (url.protocol !== 'http:') {
    throw new Error('OPEN_COWORK_SEMANTIC_UI_URL must use http:// for the local bridge.')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('OPEN_COWORK_SEMANTIC_UI_URL must point at the local semantic UI bridge.')
  }
  if (url.username || url.password) {
    throw new Error('OPEN_COWORK_SEMANTIC_UI_URL must not include URL credentials.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function bridgeToken() {
  const value = process.env.OPEN_COWORK_SEMANTIC_UI_TOKEN?.trim()
  if (!value) throw new Error('OPEN_COWORK_SEMANTIC_UI_TOKEN is not configured.')
  if (value.length < 32) throw new Error('OPEN_COWORK_SEMANTIC_UI_TOKEN is invalid.')
  return value
}

async function postToBridge(
  path: '/status' | '/snapshot' | '/actions/list' | '/actions/execute',
  body: Record<string, unknown> = {},
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BRIDGE_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${bridgeUrl()}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bridgeToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Semantic UI bridge request timed out.', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { ok: false, error: text || 'Semantic UI bridge returned invalid JSON.' }
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Semantic UI bridge returned HTTP ${response.status}.`
    throw new Error(error)
  }
  return parsed
}

function textResult(value: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(value),
    }],
  }
}

server.tool(
  'ui_status',
  'Read Open Cowork app readiness, route, workspace, active session, runtime health, and pending approval/question counts from product-owned state.',
  {},
  async () => textResult(await postToBridge('/status')),
)

server.tool(
  'ui_snapshot',
  'Read a high-level Open Cowork visible-state snapshot from product-owned state. This does not expose DOM selectors, screenshots, hidden secrets, or artifact bodies.',
  {},
  async () => textResult(await postToBridge('/snapshot')),
)

server.tool(
  'ui_list_actions',
  'List allowlisted semantic Open Cowork product actions available through the local bridge for the current state.',
  {},
  async () => textResult(await postToBridge('/actions/list')),
)

server.tool(
  'ui_execute_action',
  'Execute one allowlisted semantic Open Cowork product action through the local bridge. Availability is state-dependent and enforced by the bridge registry.',
  {
    actionId: z.enum([
      'diagnostics.export',
      'approval.allow',
      'approval.deny',
      'question.answer',
      'question.reject',
    ]).describe('The allowlisted semantic action id to execute.'),
    input: z.record(z.string(), z.unknown()).optional().default({}).describe('Optional action input. Approval/question actions require current-state identifiers and may require confirmation.'),
  },
  async (input) => textResult(await postToBridge('/actions/execute', input)),
)

process.stderr.write('[semantic-ui-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
