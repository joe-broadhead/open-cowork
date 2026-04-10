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
      timeout: 60_000, maxBuffer: 50 * 1024 * 1024,
      env: process.env,
    })
    if (stderr) console.error('[gws]', stderr)
    return stdout
  } catch (err: any) {
    throw new Error(`gws failed: Command failed: ${GWS} ${args.join(' ')}\n${err.stderr || err.message}`)
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

// ─── TRIAGE ───

server.tool(
  'triage',
  'Get an unread inbox summary for quick triage. Shows sender, subject, and date for recent unread messages.',
  {},
  async () => {
    const result = await gws(['gmail', '+triage'])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST MESSAGES ───

server.tool(
  'list_messages',
  'List messages in the mailbox. Returns message IDs and snippets.',
  {
    maxResults: z.number().default(10).describe('Maximum number of messages to return'),
    q: z.string().optional().describe('Gmail search query (e.g. "from:alice subject:meeting")'),
    labelIds: z.array(z.string()).optional().describe('Filter by label IDs (e.g. ["INBOX", "UNREAD"])'),
  },
  async ({ maxResults, q, labelIds }) => {
    const params: Record<string, unknown> = { userId: 'me', maxResults }
    if (q) params.q = q
    if (labelIds) params.labelIds = labelIds
    const result = await gws(['gmail', 'users', 'messages', 'list', '--params', JSON.stringify(params)])
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
      'gmail', 'users', 'messages', 'list',
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
      'gmail', 'users', 'messages', 'get',
      '--params', JSON.stringify({ userId: 'me', id, format }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── READ (convenience wrapper around get_message) ───

server.tool(
  'read',
  'Read the full body of an email message. Returns decoded text content.',
  {
    messageId: z.string().describe('The message ID to read'),
  },
  async ({ messageId }) => {
    const result = await gws([
      'gmail', 'users', 'messages', 'get',
      '--params', JSON.stringify({ userId: 'me', id: messageId, format: 'full' }),
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
    const result = await gws(['gmail', 'users', 'labels', 'list', '--params', JSON.stringify({ userId: 'me' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST THREADS ───

server.tool(
  'list_threads',
  'List email threads in the mailbox.',
  {
    maxResults: z.number().default(10).describe('Maximum number of threads to return'),
    q: z.string().optional().describe('Gmail search query'),
    labelIds: z.array(z.string()).optional().describe('Filter by label IDs'),
  },
  async ({ maxResults, q, labelIds }) => {
    const params: Record<string, unknown> = { userId: 'me', maxResults }
    if (q) params.q = q
    if (labelIds) params.labelIds = labelIds
    const result = await gws(['gmail', 'users', 'threads', 'list', '--params', JSON.stringify(params)])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── MODIFY MESSAGE (add/remove labels) ───

server.tool(
  'modify',
  'Modify labels on a message (e.g. mark as read, archive, star).',
  {
    id: z.string().describe('The message ID'),
    addLabelIds: z.array(z.string()).optional().describe('Labels to add (e.g. ["STARRED"])'),
    removeLabelIds: z.array(z.string()).optional().describe('Labels to remove (e.g. ["UNREAD"])'),
  },
  async ({ id, addLabelIds, removeLabelIds }) => {
    const body: Record<string, unknown> = {}
    if (addLabelIds) body.addLabelIds = addLabelIds
    if (removeLabelIds) body.removeLabelIds = removeLabelIds
    const result = await gws([
      'gmail', 'users', 'messages', 'modify',
      '--params', JSON.stringify({ userId: 'me', id }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── TRASH / UNTRASH ───

server.tool(
  'trash',
  'Move a message to trash.',
  { id: z.string().describe('The message ID') },
  async ({ id }) => {
    const result = await gws(['gmail', 'users', 'messages', 'trash', '--params', JSON.stringify({ userId: 'me', id })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET PROFILE ───

server.tool(
  'get_profile',
  'Get the authenticated user\'s Gmail profile (email address, messages total, threads total).',
  {},
  async () => {
    const result = await gws(['gmail', 'users', 'getProfile', '--params', JSON.stringify({ userId: 'me' })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── UNTRASH ───

server.tool(
  'untrash',
  'Restore a message from trash.',
  { id: z.string().describe('The message ID') },
  async ({ id }) => {
    const result = await gws(['gmail', 'users', 'messages', 'untrash', '--params', JSON.stringify({ userId: 'me', id })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DRAFTS ───

server.tool(
  'list_drafts',
  'List email drafts.',
  { maxResults: z.number().default(10).describe('Maximum number of drafts') },
  async ({ maxResults }) => {
    const result = await gws(['gmail', 'users', 'drafts', 'list', '--params', JSON.stringify({ userId: 'me', maxResults })])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE DRAFT ───

server.tool(
  'create_draft',
  'Create a new email draft.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text'),
  },
  async ({ to, subject, body }) => {
    const message = `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
    const raw = Buffer.from(message).toString('base64url')
    const result = await gws([
      'gmail', 'users', 'drafts', 'create',
      '--params', JSON.stringify({ userId: 'me' }),
      '--json', JSON.stringify({ message: { raw } }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET DRAFT ───

server.tool(
  'get_draft',
  'Get the content of a specific draft.',
  {
    id: z.string().describe('The draft ID'),
  },
  async ({ id }) => {
    const result = await gws([
      'gmail', 'users', 'drafts', 'get',
      '--params', JSON.stringify({ userId: 'me', id, format: 'full' }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SEND DRAFT ───

server.tool(
  'send_draft',
  'Send an existing draft.',
  {
    id: z.string().describe('The draft ID to send'),
  },
  async ({ id }) => {
    const result = await gws([
      'gmail', 'users', 'drafts', 'send',
      '--params', JSON.stringify({ userId: 'me' }),
      '--json', JSON.stringify({ id }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE DRAFT ───

server.tool(
  'delete_draft',
  'Delete a draft permanently.',
  {
    id: z.string().describe('The draft ID to delete'),
  },
  async ({ id }) => {
    const result = await gws([
      'gmail', 'users', 'drafts', 'delete',
      '--params', JSON.stringify({ userId: 'me', id }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET THREAD ───

server.tool(
  'get_thread',
  'Get a full email thread with all messages.',
  {
    id: z.string().describe('The thread ID'),
    format: z.enum(['minimal', 'full', 'metadata']).default('full').describe('Response format'),
  },
  async ({ id, format }) => {
    const result = await gws([
      'gmail', 'users', 'threads', 'get',
      '--params', JSON.stringify({ userId: 'me', id, format }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── TRASH THREAD ───

server.tool(
  'trash_thread',
  'Move an entire thread to trash.',
  {
    id: z.string().describe('The thread ID'),
  },
  async ({ id }) => {
    const result = await gws([
      'gmail', 'users', 'threads', 'trash',
      '--params', JSON.stringify({ userId: 'me', id }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE LABEL ───

server.tool(
  'create_label',
  'Create a custom Gmail label.',
  {
    name: z.string().describe('The label name'),
  },
  async ({ name }) => {
    const result = await gws([
      'gmail', 'users', 'labels', 'create',
      '--params', JSON.stringify({ userId: 'me' }),
      '--json', JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── DELETE LABEL ───

server.tool(
  'delete_label',
  'Delete a Gmail label.',
  {
    id: z.string().describe('The label ID to delete'),
  },
  async ({ id }) => {
    const result = await gws([
      'gmail', 'users', 'labels', 'delete',
      '--params', JSON.stringify({ userId: 'me', id }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── GET VACATION ───

server.tool(
  'get_vacation',
  'Get vacation responder settings.',
  {},
  async () => {
    const result = await gws([
      'gmail', 'users', 'settings', 'getVacation',
      '--params', JSON.stringify({ userId: 'me' }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SET VACATION ───

server.tool(
  'set_vacation',
  'Enable or disable vacation auto-responder.',
  {
    enableAutoReply: z.boolean().describe('Whether to enable the auto-reply'),
    responseSubject: z.string().optional().describe('Subject for the auto-reply'),
    responseBodyHtml: z.string().optional().describe('HTML body for the auto-reply'),
  },
  async ({ enableAutoReply, responseSubject, responseBodyHtml }) => {
    const body: Record<string, unknown> = { enableAutoReply }
    if (responseSubject) body.responseSubject = responseSubject
    if (responseBodyHtml) body.responseBodyHtml = responseBodyHtml
    const result = await gws([
      'gmail', 'users', 'settings', 'updateVacation',
      '--params', JSON.stringify({ userId: 'me' }),
      '--json', JSON.stringify(body),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── LIST FILTERS ───

server.tool(
  'list_filters',
  'List all email filters.',
  {},
  async () => {
    const result = await gws([
      'gmail', 'users', 'settings', 'filters', 'list',
      '--params', JSON.stringify({ userId: 'me' }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── CREATE FILTER ───

server.tool(
  'create_filter',
  'Create an email filter rule.',
  {
    criteria: z.object({
      from: z.string().optional().describe('Sender match'),
      to: z.string().optional().describe('Recipient match'),
      subject: z.string().optional().describe('Subject match'),
      query: z.string().optional().describe('Gmail search query match'),
      negatedQuery: z.string().optional().describe('Negated Gmail search query'),
      hasAttachment: z.boolean().optional().describe('Has attachment filter'),
      size: z.number().optional().describe('Message size in bytes'),
      sizeComparison: z.enum(['smaller', 'larger']).optional().describe('Size comparison operator'),
    }).describe('Filter matching criteria'),
    action: z.object({
      addLabelIds: z.array(z.string()).optional().describe('Label IDs to add'),
      removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove'),
      forward: z.string().optional().describe('Email address to forward to'),
    }).describe('Action to perform on matching messages'),
  },
  async ({ criteria, action }) => {
    const result = await gws([
      'gmail', 'users', 'settings', 'filters', 'create',
      '--params', JSON.stringify({ userId: 'me' }),
      '--json', JSON.stringify({ criteria, action }),
    ])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// ─── SCHEMA ───

server.tool(
  'schema',
  'Fetch the Gmail API schema from Google Discovery Service. Use to discover available endpoints and parameters.',
  {
    resource: z.string().optional().describe('Filter by resource name (e.g. "users.messages", "users.labels")'),
  },
  async ({ resource }) => {
    const res = await fetch('https://gmail.googleapis.com/$discovery/rest?version=v1')
    const schema = await res.json() as any
    if (resource) {
      const methods = schema.resources?.[resource]?.methods || {}
      return { content: [{ type: 'text' as const, text: JSON.stringify(methods, null, 2) }] }
    }
    const resources = Object.keys(schema.resources || {})
    return { content: [{ type: 'text' as const, text: `Available resources: ${resources.join(', ')}\n\nUse schema with a resource name to see methods.` }] }
  },
)

// ─── CUSTOM API CALL ───

server.tool(
  'run_api_call',
  'Run a custom gws gmail API call. Use schema tool first to discover endpoints.',
  {
    args: z.array(z.string()).describe('gws command arguments after "gmail", e.g. ["users", "messages", "list", "--params", "{}"]'),
  },
  async ({ args }) => {
    const result = await gws(['gmail', ...args])
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

console.error('[google-gmail-mcp] Server started')
const transport = new StdioServerTransport()
server.connect(transport)
