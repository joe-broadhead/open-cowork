import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'workflows',
  version: '1.0.0',
})

const BRIDGE_REQUEST_TIMEOUT_MS = 10_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

const scheduleSchema = z.object({
  type: z.enum(['one_time', 'daily', 'weekly', 'monthly']).describe('Schedule cadence.'),
  timezone: z.string().min(1).describe('IANA timezone, for example Europe/London.'),
  startAt: z.string().optional().nullable().describe('ISO timestamp for one-time runs, or optional first eligible run time.'),
  runAtHour: z.number().int().min(0).max(23).optional().nullable().describe('Local hour for recurring runs.'),
  runAtMinute: z.number().int().min(0).max(59).optional().nullable().describe('Local minute for recurring runs.'),
  dayOfWeek: z.number().int().min(0).max(6).optional().nullable().describe('Weekly run day, 0=Sunday.'),
  dayOfMonth: z.number().int().min(1).max(31).optional().nullable().describe('Monthly run day.'),
})

const triggerSchema = z.object({
  id: z.string().optional().describe('Stable trigger id; omit to let Open Cowork generate one.'),
  type: z.enum(['manual', 'schedule', 'webhook']).describe('How this workflow can start.'),
  enabled: z.boolean().optional().default(true),
  schedule: scheduleSchema.optional().nullable(),
  webhookSecret: z.string().optional().nullable().describe('Optional existing webhook secret; omit for generated secret.'),
})

const workflowDraftShape = {
  title: z.string().min(1).describe('Short human-readable workflow name.'),
  instructions: z.string().min(1).describe('Durable repeatable task instructions for the execution agent.'),
  agentName: z.string().optional().default('build').describe('OpenCode agent that should execute the workflow, usually build unless a custom agent is better.'),
  skillNames: z.array(z.string()).optional().default([]).describe('Relevant skill names the execution agent should use.'),
  toolIds: z.array(z.string()).optional().default([]).describe('Relevant Open Cowork tool ids or MCP namespaces.'),
  projectDirectory: z.string().optional().nullable().describe('Granted project directory if this workflow should run in a project context.'),
  draftSessionId: z.string().optional().nullable().describe('The planning thread id that produced this workflow.'),
  triggers: z.array(triggerSchema).min(1).describe('Manual, schedule, and/or webhook triggers.'),
}

type WorkflowDraftInput = z.infer<z.ZodObject<typeof workflowDraftShape>>

const workflowCreateShape = {
  previewToken: z.string().min(1).describe('previewToken returned by preview_workflow after the user explicitly confirms the proposal.'),
}

function bridgeUrl() {
  const value = process.env.OPEN_COWORK_WORKFLOW_TOOL_URL?.trim()
  if (!value) throw new Error('OPEN_COWORK_WORKFLOW_TOOL_URL is not configured.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('OPEN_COWORK_WORKFLOW_TOOL_URL must be a valid URL.')
  }
  if (url.protocol !== 'http:') {
    throw new Error('OPEN_COWORK_WORKFLOW_TOOL_URL must use http:// for the local bridge.')
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('OPEN_COWORK_WORKFLOW_TOOL_URL must point at the local workflow bridge.')
  }
  if (url.username || url.password) {
    throw new Error('OPEN_COWORK_WORKFLOW_TOOL_URL must not include URL credentials.')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function bridgeToken() {
  const value = process.env.OPEN_COWORK_WORKFLOW_TOOL_TOKEN?.trim()
  if (!value) throw new Error('OPEN_COWORK_WORKFLOW_TOOL_TOKEN is not configured.')
  if (value.length < 32) throw new Error('OPEN_COWORK_WORKFLOW_TOOL_TOKEN is invalid.')
  return value
}

async function postToBridge(path: '/preview' | '/create', body: WorkflowDraftInput | z.infer<z.ZodObject<typeof workflowCreateShape>>) {
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
      throw new Error('Workflow bridge request timed out.', { cause: error })
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
    parsed = { ok: false, error: text || 'Workflow bridge returned invalid JSON.' }
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Workflow bridge returned HTTP ${response.status}.`
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
  'preview_workflow',
  'Validate and preview a proposed Open Cowork workflow. Use this before asking the user to confirm saving it.',
  workflowDraftShape,
  async (draft) => textResult(await postToBridge('/preview', draft)),
)

server.tool(
  'create_workflow',
  'Save a confirmed Open Cowork workflow. Call only after the user explicitly confirms the preview, passing the previewToken returned by preview_workflow.',
  workflowCreateShape,
  async (request) => textResult(await postToBridge('/create', request)),
)

process.stderr.write('[workflows-mcp] Server started\n')
const transport = new StdioServerTransport()
await server.connect(transport)
