import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createBridge } from '../../shared/bridge.js'
import { textResult } from '../../shared/mcp-bootstrap.js'

const server = new McpServer({ name: 'agents', version: '1.0.0' })

const agentColorSchema = z.enum(['primary', 'warning', 'accent', 'success', 'info', 'secondary'])
const permissionActionSchema = z.enum(['allow', 'ask', 'deny'])
const permissionOverrideSchema = z.object({
  key: z.enum(['web', 'edit', 'bash', 'task', 'external_directory', 'mcp']),
  action: permissionActionSchema,
  rules: z.array(z.object({
    pattern: z.string().min(1),
    action: permissionActionSchema,
  })).optional(),
})

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
  mode: z.enum(['primary', 'subagent']).optional().describe('Whether this agent can lead conversations or only act as a delegated specialist. Omit to preserve an existing agent mode when updating.'),
  enabled: z.boolean().optional().default(true),
  color: agentColorSchema.optional().default('accent'),
  avatar: z.string().optional().nullable(),
  deniedToolPatterns: z.array(z.string()).optional().default([]).describe('Specific tool permission patterns to deny.'),
  permissionOverrides: z.array(permissionOverrideSchema).optional().describe('Collapsed runtime permission guardrails. Omit to preserve existing guardrails when updating; pass an empty array only to clear them.'),
  model: z.string().optional().nullable(),
  variant: z.string().optional().nullable(),
  temperature: z.number().min(0).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  steps: z.number().int().min(1).optional().nullable(),
  options: z.record(z.string(), z.unknown()).optional().nullable(),
}

type AgentDraftInput = z.infer<z.ZodObject<typeof agentDraftShape>>
type AgentTargetInput = z.infer<z.ZodObject<typeof agentTargetShape>>

const bridge = createBridge<'/list' | '/get' | '/preview' | '/save' | '/delete'>({
  urlEnvVar: 'OPEN_COWORK_AGENT_TOOL_URL',
  tokenEnvVar: 'OPEN_COWORK_AGENT_TOOL_TOKEN',
  bridgeName: 'agent bridge',
  bridgeLabel: 'Agent bridge',
})

async function postToBridge(path: '/list' | '/get' | '/preview' | '/save' | '/delete', body: AgentDraftInput | AgentTargetInput | { directory?: string | null }) {
  return bridge.postToBridge(path, body)
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
