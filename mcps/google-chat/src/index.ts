import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)

function findGwsBinary(): string {
  if (process.env.GWS_BIN) return process.env.GWS_BIN
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('@googleworkspace/cli/package.json')
    const binPath = resolve(dirname(pkgPath), 'bin', 'gws')
    if (existsSync(binPath)) return binPath
  } catch {}
  return 'gws'
}

const GWS = findGwsBinary()

async function gws(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(GWS, args, {
      timeout: 60_000,
      env: process.env,
    })
    if (stderr) console.error('[gws]', stderr)
    return stdout
  } catch (err: any) {
    throw new Error(`gws failed: ${err.message}\n${err.stderr || ''}`)
  }
}

const server = new McpServer({
  name: 'google-chat',
  version: '1.0.0',
})

// ─── LIST SPACES ───

server.tool(
  'list_spaces',
  'List Google Chat spaces the authenticated user is a member of.',
  {
    pageSize: z.number().optional().describe('Maximum number of spaces to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    filter: z.string().optional().describe('Filter string (e.g. "spaceType = SPACE")'),
  },
  async ({ pageSize, pageToken, filter }) => {
    const params: Record<string, unknown> = {}
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (filter) params.filter = filter
    const args = ['chat', 'spaces', 'list']
    if (Object.keys(params).length) args.push('--params', JSON.stringify(params))
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET SPACE ───

server.tool(
  'get_space',
  'Get details about a specific Google Chat space.',
  {
    name: z.string().describe('Resource name of the space (e.g. "spaces/AAAA")'),
  },
  async ({ name }) => {
    const result = await gws(['chat', 'spaces', 'get', '--params', JSON.stringify({ name })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE SPACE ───

server.tool(
  'create_space',
  'Create or set up a new Google Chat space.',
  {
    displayName: z.string().describe('Display name for the space'),
    spaceType: z.enum(['SPACE', 'GROUP_CHAT']).default('SPACE').describe('Type of space to create'),
    memberships: z.array(z.object({
      member: z.object({
        name: z.string().describe('Resource name of the member (e.g. "users/USER_ID")'),
        type: z.enum(['HUMAN', 'BOT']).default('HUMAN'),
      }),
    })).optional().describe('Initial memberships to add'),
  },
  async ({ displayName, spaceType, memberships }) => {
    const body: Record<string, unknown> = {
      space: { displayName, spaceType },
    }
    if (memberships) body.memberships = memberships
    const result = await gws(['chat', 'spaces', 'setup', '--json', JSON.stringify(body)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE MESSAGE ───

server.tool(
  'create_message',
  'Send a message to a Google Chat space.',
  {
    parent: z.string().describe('Space resource name (e.g. "spaces/AAAA")'),
    text: z.string().describe('Plain text message body'),
    threadKey: z.string().optional().describe('Thread key to reply in a thread'),
  },
  async ({ parent, text, threadKey }) => {
    const params: Record<string, unknown> = { parent }
    if (threadKey) params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
    const body: Record<string, unknown> = { text }
    if (threadKey) body.thread = { threadKey }
    const result = await gws([
      'chat', 'spaces.messages', 'create',
      '--params', JSON.stringify(params),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST MESSAGES ───

server.tool(
  'list_messages',
  'List messages in a Google Chat space.',
  {
    parent: z.string().describe('Space resource name (e.g. "spaces/AAAA")'),
    pageSize: z.number().optional().describe('Maximum number of messages to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    filter: z.string().optional().describe('Filter string (e.g. \'createTime > "2023-01-01T00:00:00Z"\')'),
    orderBy: z.string().optional().describe('Order by field (e.g. "createTime desc")'),
  },
  async ({ parent, pageSize, pageToken, filter, orderBy }) => {
    const params: Record<string, unknown> = { parent }
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (filter) params.filter = filter
    if (orderBy) params.orderBy = orderBy
    const result = await gws(['chat', 'spaces.messages', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET MESSAGE ───

server.tool(
  'get_message',
  'Get a specific message from a Google Chat space.',
  {
    name: z.string().describe('Message resource name (e.g. "spaces/AAAA/messages/BBBB")'),
  },
  async ({ name }) => {
    const result = await gws(['chat', 'spaces.messages', 'get', '--params', JSON.stringify({ name })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UPDATE MESSAGE ───

server.tool(
  'update_message',
  'Update a message in a Google Chat space.',
  {
    name: z.string().describe('Message resource name (e.g. "spaces/AAAA/messages/BBBB")'),
    text: z.string().optional().describe('New text for the message'),
    updateMask: z.string().optional().describe('Comma-separated fields to update (e.g. "text"). Defaults to "text".'),
  },
  async ({ name, text, updateMask }) => {
    const body: Record<string, unknown> = {}
    if (text !== undefined) body.text = text
    if (Object.keys(body).length === 0) throw new Error('At least one field to update is required (e.g. text)')
    const params: Record<string, unknown> = { name, updateMask: updateMask || 'text' }
    const result = await gws([
      'chat', 'spaces.messages', 'update',
      '--params', JSON.stringify(params),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE MESSAGE ───

server.tool(
  'delete_message',
  'Delete a message from a Google Chat space.',
  {
    name: z.string().describe('Message resource name (e.g. "spaces/AAAA/messages/BBBB")'),
  },
  async ({ name }) => {
    const result = await gws(['chat', 'spaces.messages', 'delete', '--params', JSON.stringify({ name })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST MEMBERS ───

server.tool(
  'list_members',
  'List members of a Google Chat space.',
  {
    parent: z.string().describe('Space resource name (e.g. "spaces/AAAA")'),
    pageSize: z.number().optional().describe('Maximum number of members to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    filter: z.string().optional().describe('Filter string (e.g. \'role = "ROLE_MEMBER"\')'),
  },
  async ({ parent, pageSize, pageToken, filter }) => {
    const params: Record<string, unknown> = { parent }
    if (pageSize !== undefined) params.pageSize = pageSize
    if (pageToken) params.pageToken = pageToken
    if (filter) params.filter = filter
    const result = await gws(['chat', 'spaces.members', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://chat.googleapis.com/$discovery/rest?version=v1'
let cachedDiscovery: any = null

async function getDiscovery(): Promise<any> {
  if (cachedDiscovery) return cachedDiscovery
  const res = await fetch(DISCOVERY_URL)
  if (!res.ok) throw new Error(`Discovery Service returned ${res.status}: ${res.statusText}`)
  cachedDiscovery = await res.json()
  return cachedDiscovery
}

function resolveRef(schemas: any, ref: string, depth = 0): any {
  if (depth > 5) return { type: 'object', description: `(see ${ref})` }
  const schema = schemas[ref]
  if (!schema) return { type: 'unknown' }
  const result: any = { description: schema.description }
  if (schema.properties) {
    result.properties = {}
    for (const [key, val] of Object.entries(schema.properties) as any) {
      if (val.$ref) {
        result.properties[key] = resolveRef(schemas, val.$ref, depth + 1)
      } else if (val.items?.$ref) {
        result.properties[key] = { type: 'array', description: val.description, items: resolveRef(schemas, val.items.$ref, depth + 1) }
      } else {
        result.properties[key] = { type: val.type || val.enum?.join('|') || 'any', description: val.description }
        if (val.enum) result.properties[key].enum = val.enum
      }
    }
  }
  if (schema.enum) result.enum = schema.enum
  return result
}

server.tool(
  'schema',
  'Look up the Google Chat API schema from the live Discovery Service. Browse available resources and their methods.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Space", "Message", "Membership"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Chat API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

      // Try exact match first, then case-insensitive
      let schema = schemas[resource]
      if (!schema) {
        const key = Object.keys(schemas).find(k => k.toLowerCase() === resource.toLowerCase())
        if (key) schema = schemas[key]
      }

      if (!schema) {
        const matches = Object.keys(schemas).filter(k => k.toLowerCase().includes(resource.toLowerCase()))
        if (matches.length) {
          return { content: [{ type: 'text' as const, text: `"${resource}" not found. Did you mean:\n${matches.map(m => `- ${m}`).join('\n')}` }] }
        }
        return { content: [{ type: 'text' as const, text: `"${resource}" not found. Call schema() to list all types.` }] }
      }

      const resolved = resolveRef(schemas, resource)
      return { content: [{ type: 'text' as const, text: `# ${resource}\n\n${resolved.description || ''}\n\n## Structure\n\n\`\`\`json\n${JSON.stringify(resolved.properties || {}, null, 2)}\n\`\`\`` }] }
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Failed to fetch schema: ${err.message}` }] }
    }
  },
)

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-chat-mcp] Server started')
}
main().catch((err) => { console.error('[google-chat-mcp] Fatal:', err); process.exit(1) })
