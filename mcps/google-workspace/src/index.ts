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
  // 1. Explicit env override
  if (process.env.GWS_BIN) return process.env.GWS_BIN

  // 2. Resolve from the bundled @googleworkspace/cli npm package
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('@googleworkspace/cli/package.json')
    const binPath = resolve(dirname(pkgPath), 'bin', 'gws')
    if (existsSync(binPath)) return binPath
  } catch {}

  // 3. Fall back to PATH
  return 'gws'
}

const GWS_BIN = findGwsBinary()

async function runGws(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(GWS_BIN, args, {
      timeout: 30_000,
      env: {
        ...process.env,
        // Use token from env if available, otherwise gws will use ADC
        ...(process.env.GOOGLE_WORKSPACE_CLI_TOKEN
          ? { GOOGLE_WORKSPACE_CLI_TOKEN: process.env.GOOGLE_WORKSPACE_CLI_TOKEN }
          : {}),
      },
    })
    if (stderr) console.error('[gws stderr]', stderr)
    return stdout
  } catch (err: any) {
    throw new Error(`gws command failed: ${err.message}\n${err.stderr || ''}`)
  }
}

const server = new McpServer({
  name: 'google-workspace',
  version: '0.1.0',
})

// Gmail: List messages
server.tool(
  'gmail_list',
  'List recent Gmail messages. Returns subject, from, date, and snippet for each message.',
  {
    maxResults: z.number().min(1).max(50).default(10).describe('Maximum number of messages to return'),
    query: z.string().optional().describe('Gmail search query (e.g. "from:alice subject:report")'),
  },
  async ({ maxResults, query }) => {
    const args = ['gmail', 'users.messages', 'list', '--params', JSON.stringify({
      userId: 'me',
      maxResults,
      ...(query ? { q: query } : {}),
    })]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Gmail: Get a specific message
server.tool(
  'gmail_get',
  'Get the full content of a specific Gmail message by ID.',
  {
    messageId: z.string().describe('The Gmail message ID'),
  },
  async ({ messageId }) => {
    const args = ['gmail', 'users.messages', 'get', '--params', JSON.stringify({
      userId: 'me',
      id: messageId,
    })]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Gmail: Send email
server.tool(
  'gmail_send',
  'Send an email via Gmail. Requires approval.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body text'),
    cc: z.string().optional().describe('CC email address'),
  },
  async ({ to, subject, body, cc }) => {
    const args = ['gmail', '+send', '--to', to, '--subject', subject, '--body', body]
    if (cc) args.push('--cc', cc)
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Sheets: Create spreadsheet
server.tool(
  'sheets_create',
  'Create a new Google Sheets spreadsheet.',
  {
    title: z.string().describe('Title for the new spreadsheet'),
  },
  async ({ title }) => {
    const args = ['sheets', 'spreadsheets', 'create', '--params', JSON.stringify({
      properties: { title },
    })]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Sheets: Append data
server.tool(
  'sheets_append',
  'Append rows of data to an existing Google Sheets spreadsheet.',
  {
    spreadsheetId: z.string().describe('The spreadsheet ID'),
    range: z.string().default('Sheet1').describe('The sheet/range to append to (e.g. "Sheet1")'),
    values: z.string().describe('Comma-separated values to append (e.g. "Alice,95,A")'),
  },
  async ({ spreadsheetId, range, values }) => {
    const args = ['sheets', '+append', '--spreadsheet', spreadsheetId, '--range', range, '--values', values]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Drive: List files
server.tool(
  'drive_list',
  'List files in Google Drive.',
  {
    query: z.string().optional().describe('Drive search query (e.g. "name contains \'report\'")'),
    maxResults: z.number().min(1).max(100).default(20).describe('Maximum number of files to return'),
  },
  async ({ query, maxResults }) => {
    const params: Record<string, unknown> = { pageSize: maxResults }
    if (query) params.q = query
    const args = ['drive', 'files', 'list', '--params', JSON.stringify(params)]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Calendar: List upcoming events
server.tool(
  'calendar_list',
  'List upcoming events from Google Calendar.',
  {
    maxResults: z.number().min(1).max(50).default(10).describe('Maximum number of events to return'),
    timeMin: z.string().optional().describe('Start time in ISO format (defaults to now)'),
  },
  async ({ maxResults, timeMin }) => {
    const params: Record<string, unknown> = {
      calendarId: 'primary',
      maxResults,
      orderBy: 'startTime',
      singleEvents: true,
      timeMin: timeMin || new Date().toISOString(),
    }
    const args = ['calendar', 'events', 'list', '--params', JSON.stringify(params)]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Calendar: Create event
server.tool(
  'calendar_create',
  'Create a new Google Calendar event.',
  {
    summary: z.string().describe('Event title'),
    startDateTime: z.string().describe('Start time in ISO format'),
    endDateTime: z.string().describe('End time in ISO format'),
    description: z.string().optional().describe('Event description'),
    attendees: z.string().optional().describe('Comma-separated email addresses of attendees'),
  },
  async ({ summary, startDateTime, endDateTime, description, attendees }) => {
    const body: Record<string, unknown> = {
      summary,
      start: { dateTime: startDateTime },
      end: { dateTime: endDateTime },
    }
    if (description) body.description = description
    if (attendees) {
      body.attendees = attendees.split(',').map((e) => ({ email: e.trim() }))
    }
    const args = ['calendar', 'events', 'insert', '--params', JSON.stringify({
      calendarId: 'primary',
      ...body,
    })]
    const result = await runGws(args)
    return { content: [{ type: 'text' as const, text: result }] }
  },
)

// Start the server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[google-workspace-mcp] Server started')
}

main().catch((err) => {
  console.error('[google-workspace-mcp] Fatal error:', err)
  process.exit(1)
})
