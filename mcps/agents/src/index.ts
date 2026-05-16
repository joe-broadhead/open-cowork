import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'agents',
  version: '1.0.0',
})

const BRIDGE_REQUEST_TIMEOUT_MS = 10_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const agentColorSchema = z.enum(['primary', 'warning', 'accent', 'success', 'info', 'secondary'])

const agentTargetShape = {
  name: z.string().min(1).describe('Custom agent id. Lowercase hyphenated ids are expected.'),
  scope: z.enum(['machine', 'project']).optional().default('machine').describe('Where the custom agent should live.'),
  directory: z.string().optional().nullable().describe('Project directory for project-scoped agents.'),
}

const agentDraftShape = {
  ...agentTargetShape,
  description: z.string().min(1).describe('Short routing description for when to use this agent.'),
  instructions: z.string().min(1).describe('Durable instructions for the custom agent.'),
  skillNames: z.array(z.string()).optional().default([]).describe('Skill bundle names this agent should load.'),
  toolIds: z.array(z.string()).optional().default([]).describe('Open Cowork tool ids or native OpenCode tool ids this agent may use.'),
  enabled: z.boolean().optional().default(true),
  color: agentColorSchema.optional().default('accent'),
  avatar: z.string().optional().nullable(),
  deniedToolPatterns: z.array(z.string()).optional().default([]).describe('Specific tool permission patterns to deny.'),
  model: z.string().optional().nullable(),
  variant: z.string().optional().nullable(),
  temperature: z.number().min(0).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  steps: z.number().int().min(1).optional().nullable(),
  options: z.record(z.string(), z.unknown()).optional().nullable(),
}

type AgentDraftInput = z.infer<z.ZodObject<typeof agentDraftShape>>
type AgentTargetInput = z.infer<z.ZodObject<typeof agentTargetShape>>

function bridgeUrl() {
  const value = process.env.OPEN_COWORK_AGENT_TOOL_URL?.trim()
  if (!value) throw new Error('OPEN_COWORK_AGENT_TOOL_URL is not configured.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPEN_COWORK_AGENT_TOOL_URL must be a valid URL.')
  }
  if (url.protocol !== 'http:') {
    throw new Error('OPEN_COWORK_AGENT_TOOL_URL must use http:// for the local bridge.')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('OPEN_COWORK_AGENT_TOOL_URL must point at the local agent bridge.')
  }
  if (url.username || url.password) {
    throw new Error('OPEN_COWORK_AGENT_TOOL_URL must not include URL credentials.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function bridgeToken() {
  const value = process.env.OPEN_COWORK_AGENT_TOOL_TOKEN?.trim()
  if (!value) throw new Error('OPEN_COWORK_AGENT_TOOL_TOKEN is not configured.')
  if (value.length < 32) throw new Error('OPEN_COWORK_AGENT_TOOL_TOKEN is invalid.')
  return value
}

async function postToBridge(path: '/list' | '/get' | '/preview' | '/save' | '/delete', body: AgentDraftInput | AgentTargetInput | { directory?: string | null }) {
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
      throw new Error('Agent bridge request timed out.', { cause: error })
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
    parsed = { ok: false, error: text || 'Agent bridge returned invalid JSON.' }
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Agent bridge returned HTTP ${response.status}.`
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
  'list_agents',
  'List custom Open Cowork agents. Built-in agents are read-only and are not modified by this MCP.',
  {
    directory: z.string().optional().nullable().describe('Optional project directory context.'),
  },
  async (input) => textResult(await postToBridge('/list', input)),
)

server.tool(
  'get_agent',
  'Read one custom Open Cowork agent.',
  agentTargetShape,
  async (target) => textResult(await postToBridge('/get', target)),
)

server.tool(
  'preview_agent',
  'Validate and preview a proposed custom Open Cowork agent. Use this before asking the user to confirm saving it.',
  agentDraftShape,
  async (draft) => textResult(await postToBridge('/preview', draft)),
)

server.tool(
  'save_agent',
  'Create or update a custom Open Cowork agent. Call only after the user explicitly confirms the preview.',
  agentDraftShape,
  async (draft) => textResult(await postToBridge('/save', draft)),
)

server.tool(
  'delete_agent',
  'Delete a custom Open Cowork agent. Call only after the user explicitly confirms deletion.',
  agentTargetShape,
  async (target) => textResult(await postToBridge('/delete', target)),
)

process.stderr.write('[agents-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
