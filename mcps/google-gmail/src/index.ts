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
  name: 'google-gmail',
  version: '1.0.0',
})

// ─── SEND ───

server.tool(
  'send',
  'Send a new email message.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text'),
    cc: z.string().optional().describe('CC email address(es), comma-separated'),
    bcc: z.string().optional().describe('BCC email address(es), comma-separated'),
  },
  async ({ to, subject, body, cc, bcc }) => {
    const args = ['gmail', '+send', '--to', to, '--subject', subject, '--body', body]
    if (cc) args.push('--cc', cc)
    if (bcc) args.push('--bcc', bcc)
    const result = await gws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REPLY ───

server.tool(
  'reply',
  'Reply to a specific email message.',
  {
    messageId: z.string().describe('The message ID to reply to'),
    body: z.string().describe('Reply body text'),
  },
  async ({ messageId, body }) => {
    const result = await gws(['gmail', '+reply', '--message-id', messageId, '--body', body])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── REPLY ALL ───

server.tool(
  'reply_all',
  'Reply-all to a specific email message.',
  {
    messageId: z.string().describe('The message ID to reply to'),
    body: z.string().describe('Reply body text'),
  },
  async ({ messageId, body }) => {
    const result = await gws(['gmail', '+reply-all', '--message-id', messageId, '--body', body])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── FORWARD ───

server.tool(
  'forward',
  'Forward an email message to another recipient.',
  {
    messageId: z.string().describe('The message ID to forward'),
    to: z.string().describe('Recipient email address to forward to'),
  },
  async ({ messageId, to }) => {
    const result = await gws(['gmail', '+forward', '--message-id', messageId, '--to', to])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── READ ───

server.tool(
  'read',
  'Read the full body of an email message.',
  {
    messageId: z.string().describe('The message ID to read'),
  },
  async ({ messageId }) => {
    const result = await gws(['gmail', '+read', '--message-id', messageId])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── TRIAGE ───

server.tool(
  'triage',
  'Get an unread inbox summary for quick triage.',
  {},
  async () => {
    const result = await gws(['gmail', '+triage'])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST MESSAGES ───

server.tool(
  'list_messages',
  'List messages in the mailbox. Returns message IDs and thread IDs.',
  {
    maxResults: z.number().default(10).describe('Maximum number of messages to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    labelIds: z.array(z.string()).optional().describe('Filter by label IDs (e.g. ["INBOX", "UNREAD"])'),
    q: z.string().optional().describe('Gmail search query (e.g. "from:alice subject:meeting")'),
  },
  async ({ maxResults, pageToken, labelIds, q }) => {
    const params: Record<string, unknown> = { userId: 'me', maxResults }
    if (pageToken) params.pageToken = pageToken
    if (labelIds) params.labelIds = labelIds
    if (q) params.q = q
    const result = await gws(['gmail', 'users.messages', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SEARCH ───

server.tool(
  'search',
  'Search for email messages using Gmail search syntax.',
  {
    query: z.string().describe('Gmail search query (e.g. "from:alice", "subject:invoice", "has:attachment", "newer_than:7d")'),
    maxResults: z.number().default(10).describe('Maximum number of results'),
  },
  async ({ query, maxResults }) => {
    const result = await gws([
      'gmail', 'users.messages', 'list',
      '--params', JSON.stringify({ userId: 'me', q: query, maxResults }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET MESSAGE ───

server.tool(
  'get_message',
  'Get the full details of a specific email message including headers, body, and attachments info.',
  {
    id: z.string().describe('The message ID'),
    format: z.enum(['minimal', 'full', 'raw', 'metadata']).default('full').describe('Response format'),
  },
  async ({ id, format }) => {
    const result = await gws([
      'gmail', 'users.messages', 'get',
      '--params', JSON.stringify({ userId: 'me', id, format }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST LABELS ───

server.tool(
  'list_labels',
  'List all labels in the user\'s mailbox.',
  {},
  async () => {
    const result = await gws(['gmail', 'users.labels', 'list', '--params', JSON.stringify({ userId: 'me' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST THREADS ───

server.tool(
  'list_threads',
  'List email threads in the mailbox.',
  {
    maxResults: z.number().default(10).describe('Maximum number of threads to return'),
    pageToken: z.string().optional().describe('Page token from a previous request'),
    q: z.string().optional().describe('Gmail search query'),
    labelIds: z.array(z.string()).optional().describe('Filter by label IDs'),
  },
  async ({ maxResults, pageToken, q, labelIds }) => {
    const params: Record<string, unknown> = { userId: 'me', maxResults }
    if (pageToken) params.pageToken = pageToken
    if (q) params.q = q
    if (labelIds) params.labelIds = labelIds
    const result = await gws(['gmail', 'users.threads', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET PROFILE ───

server.tool(
  'get_profile',
  'Get the authenticated user\'s Gmail profile (email address, messages total, threads total, history ID).',
  {},
  async () => {
    const result = await gws(['gmail', 'users', 'getProfile', '--params', JSON.stringify({ userId: 'me' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

const DISCOVERY_URL = 'https://gmail.googleapis.com/$discovery/rest?version=v1'
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
  'Look up the Gmail API schema from the live Discovery Service. Browse available resources and data types.',
  {
    resource: z.string().optional().describe('Resource/schema name to look up (e.g. "Message", "Label", "Thread", "Draft"). Leave empty to list all available schemas.'),
  },
  async ({ resource }) => {
    try {
      const discovery = await getDiscovery()
      const schemas = discovery.schemas || {}

      if (!resource) {
        const types = Object.entries(schemas).map(([name, val]: [string, any]) => {
          return `- **${name}**: ${val.description || ''}`
        })
        return { content: [{ type: 'text' as const, text: `# Available Gmail API schemas (${types.length})\n\n${types.join('\n')}` }] }
      }

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
  console.error('[google-gmail-mcp] Server started')
}
main().catch((err) => { console.error('[google-gmail-mcp] Fatal:', err); process.exit(1) })
